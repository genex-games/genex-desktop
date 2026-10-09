using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace Genex.Unity
{
    [InitializeOnLoad]
    internal static class EditorBridge
    {
        const int MaxRequestBytes = 1024 * 1024;
        const int MaxResponseBytes = 4 * 1024 * 1024;
        const int MaxPending = 32;
        const int RequestTimeoutMs = 45000;
        static readonly ConcurrentQueue<Work> Queue = new ConcurrentQueue<Work>();
        static readonly ConcurrentDictionary<TcpClient, byte> Clients = new ConcurrentDictionary<TcpClient, byte>();
        static readonly CancellationTokenSource Lifetime = new CancellationTokenSource();
        static TcpListener listener;
        static string token;
        static string projectId;
        static string discovery;
        static int pending;
        static bool quitting;
        static volatile string statusSnapshot;
        static double nextStatusRefresh;

        sealed class Work
        {
            public JObject Request;
            public readonly ManualResetEventSlim Completed = new ManualResetEventSlim();
            public JObject Response;
            public volatile bool Abandoned;
        }

        static EditorBridge()
        {
            EditorApplication.delayCall += Start;
            EditorApplication.update += Pump;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += () => { quitting = true; Stop(); };
        }

        static void Start()
        {
            if (quitting || listener != null) return;
            try
            {
                projectId = ProjectFiles.ProjectId;
                token = SessionState.GetString("Genex.Bridge.Token", "");
                if (string.IsNullOrEmpty(token))
                {
                    var bytes = new byte[32];
                    using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
                    token = string.Concat(Array.ConvertAll(bytes, b => b.ToString("x2")));
                    SessionState.SetString("Genex.Bridge.Token", token);
                }
                var folder = Path.Combine(ProjectFiles.Root, "Library", "Genex");
                ProjectFiles.AssertNoLinks(folder);
                Directory.CreateDirectory(folder);
                Protect(folder, true);
                discovery = Path.Combine(folder, "bridge.json");
                ProjectFiles.AssertNoLinks(discovery);
                RefreshStatusSnapshot();
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start(16);
                var endpoint = new JObject {
                    ["protocol"] = 1, ["host"] = "127.0.0.1", ["port"] = ((IPEndPoint)listener.LocalEndpoint).Port,
                    ["token"] = token, ["projectRoot"] = ProjectFiles.Root, ["projectId"] = projectId,
                    ["pid"] = Process.GetCurrentProcess().Id, ["unityVersion"] = Application.unityVersion
                };
                var staging = discovery + ".tmp-" + Guid.NewGuid().ToString("N");
                File.WriteAllText(staging, endpoint.ToString(Formatting.None), new UTF8Encoding(false));
                Protect(staging, false);
                if (File.Exists(discovery)) File.Replace(staging, discovery, null); else File.Move(staging, discovery);
                var thread = new Thread(Accept) { IsBackground = true, Name = "Genex Unity Bridge" };
                thread.Start();
            }
            catch (Exception e)
            {
                Stop();
                UnityEngine.Debug.LogError("Genex Unity bridge could not start: " + e.Message);
            }
        }

        [DllImport("libc", SetLastError = true)] static extern int chmod(string path, int mode);
        static void Protect(string path, bool directory)
        {
            if (Application.platform != RuntimePlatform.WindowsEditor)
            {
                if (chmod(path, directory ? 448 : 384) != 0) throw new IOException("Could not protect bridge discovery");
                return;
            }
            var user = WindowsIdentity.GetCurrent().User;
            if (directory)
            {
                var acl = new DirectorySecurity();
                acl.SetAccessRuleProtection(true, false);
                acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                new DirectoryInfo(path).SetAccessControl(acl);
            }
            else
            {
                var acl = new FileSecurity();
                acl.SetAccessRuleProtection(true, false);
                acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
                new FileInfo(path).SetAccessControl(acl);
            }
        }

        static void Accept()
        {
            while (!Lifetime.IsCancellationRequested)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    if (Clients.Count >= MaxPending) { client.Close(); continue; }
                    Clients.TryAdd(client, 0);
                    ThreadPool.QueueUserWorkItem(_ => Serve(client));
                }
                catch (SocketException) { if (Lifetime.IsCancellationRequested) return; }
                catch (ObjectDisposedException) { return; }
            }
        }

        static void Serve(TcpClient client)
        {
            JObject request = null;
            try
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 10000;
                client.NoDelay = true;
                using (var stream = client.GetStream())
                {
                    request = ReadRequest(stream);
                    var id = Args.Text(request, "id", max: 128);
                    var supplied = Args.Text(request, "token", max: 256);
                    if (!EqualToken(supplied)) throw new BridgeException("unauthorized", "Invalid bridge token");
                    Args.Text(request, "method", max: 128);
                    if (request["params"] != null && !(request["params"] is JObject))
                        throw new BridgeException("invalid_request", "params must be an object");
                    // Snapshots contain JSON only. BuildPlayer blocks the Editor thread, so polling
                    // its already-recorded job must not enqueue another Unity API call behind it.
                    JToken snapshot = null;
                    var method = request.Value<string>("method");
                    if (method == "editor.status" && statusSnapshot != null)
                    {
                        var state = JObject.Parse(statusSnapshot);
                        var jobs = EditorJobs.Summaries();
                        state["jobs"] = jobs;
                        state["isBuilding"] = state.Value<bool>("isBuilding") || jobs.Any(job => job.Value<string>("kind") == "build" && job.Value<string>("state") == "running");
                        snapshot = state;
                    }
                    else if (method == "job.status") EditorJobs.Snapshot((JObject)request["params"] ?? new JObject(), out snapshot);
                    if (snapshot != null)
                    {
                        Send(stream, new JObject { ["id"] = id, ["projectId"] = projectId, ["ok"] = true, ["result"] = snapshot });
                        return;
                    }
                    if (Interlocked.Increment(ref pending) > MaxPending)
                    {
                        Interlocked.Decrement(ref pending);
                        throw new BridgeException("busy", "Editor request queue is full");
                    }
                    var work = new Work { Request = request };
                    Queue.Enqueue(work);
                    if (!work.Completed.Wait(RequestTimeoutMs))
                    {
                        work.Abandoned = true;
                        throw new BridgeException("completion_unknown", "The Editor response timed out. An operation that already started may complete; inspect its effects before retrying. Mutations are never replayed automatically");
                    }
                    Send(stream, work.Response);
                }
            }
            catch (Exception e)
            {
                try { Send(client.GetStream(), Error(request?.Value<string>("id"), e)); } catch { }
            }
            finally { Clients.TryRemove(client, out _); client.Close(); }
        }

        static JObject ReadRequest(NetworkStream stream)
        {
            using (var bytes = new MemoryStream())
            {
                while (bytes.Length <= MaxRequestBytes)
                {
                    var b = stream.ReadByte();
                    if (b < 0) throw new BridgeException("invalid_request", "Request ended before newline");
                    if (b == '\n')
                    {
                        var text = new UTF8Encoding(false, true).GetString(bytes.ToArray());
                        using (var reader = new JsonTextReader(new StringReader(text)) { MaxDepth = 32, DateParseHandling = DateParseHandling.None })
                        {
                            var request = JObject.Load(reader, new JsonLoadSettings { DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error });
                            if (reader.Read()) throw new BridgeException("invalid_request", "Unexpected trailing JSON");
                            return request;
                        }
                    }
                    bytes.WriteByte((byte)b);
                }
            }
            throw new BridgeException("limit_exceeded", "Request exceeds 1 MiB");
        }

        static bool EqualToken(string supplied)
        {
            if (supplied.Length != token.Length) return false;
            var difference = 0;
            for (var i = 0; i < supplied.Length; i++) difference |= supplied[i] ^ token[i];
            return difference == 0;
        }

        static void Send(NetworkStream stream, JObject response)
        {
            var bytes = Encoding.UTF8.GetBytes(response.ToString(Formatting.None) + "\n");
            if (bytes.Length > MaxResponseBytes)
                bytes = Encoding.UTF8.GetBytes(Error(response.Value<string>("id"), new BridgeException("limit_exceeded", "Response exceeds 4 MiB; request a smaller page")).ToString(Formatting.None) + "\n");
            stream.Write(bytes, 0, bytes.Length);
        }

        static JObject Error(string id, Exception error)
        {
            var coded = error as BridgeException;
            return new JObject { ["id"] = id, ["projectId"] = projectId, ["ok"] = false,
                ["error"] = new JObject { ["code"] = coded?.Code ?? "editor_error", ["message"] = coded?.Message ?? error.Message } };
        }

        static void Pump()
        {
            if (EditorApplication.timeSinceStartup >= nextStatusRefresh) RefreshStatusSnapshot();
            for (var count = 0; count < 8 && Queue.TryDequeue(out var work); count++)
            {
                Interlocked.Decrement(ref pending);
                if (work.Abandoned) { work.Completed.Set(); continue; }
                try
                {
                    var method = work.Request.Value<string>("method");
                    if ((EditorApplication.isCompiling || EditorApplication.isUpdating) &&
                        method != "editor.status" && method != "editor.console" && method != "job.status")
                        throw new BridgeException("busy", "Unity is compiling or importing; read status and wait");
                    work.Response = new JObject { ["id"] = work.Request["id"], ["projectId"] = projectId, ["ok"] = true,
                        ["result"] = Operations.Dispatch(method, (JObject)work.Request["params"] ?? new JObject()) };
                }
                catch (Exception e) { work.Response = Error(work.Request.Value<string>("id"), e); }
                work.Completed.Set();
            }
        }

        static void RefreshStatusSnapshot()
        {
            // Unity fields are read only on the Editor thread. Clients can inspect this recorded
            // state and immutable job summaries even while synchronous BuildPlayer blocks it.
            var state = (JObject)Operations.Dispatch("editor.status", new JObject());
            state["observedAt"] = DateTime.UtcNow.ToString("O");
            state["snapshot"] = true;
            statusSnapshot = state.ToString(Formatting.None);
            nextStatusRefresh = EditorApplication.timeSinceStartup + 0.25;
        }

        static void Stop()
        {
            Lifetime.Cancel();
            listener?.Stop();
            foreach (var client in Clients.Keys) client.Close();
            while (Queue.TryDequeue(out var work)) { work.Response = Error(work.Request.Value<string>("id"), new BridgeException("reloading", "Editor bridge is reloading")); work.Completed.Set(); }
            try { if (discovery != null && File.Exists(discovery)) File.Delete(discovery); } catch (IOException) { }
        }
    }
}
