// Per-job LPAC: a unique SID, registry read only, exact file grants and a kill-on-close job object.
// Written for Genex. Uses the Windows APIs supplied by the OS, without an installed compiler.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace GenexNative {
    public sealed class Outcome {
        public int code;
        public int? pid;
        public string reason;
    }

    public static class ContainerJob {
        const uint TokenAttribute = 0x00020009;
        const uint HandleAttribute = 0x00020002;
        const uint JobAttribute = 0x0002000D;
        const uint PackagePolicyAttribute = 0x0002000F;
        const uint CreateFlags = 0x00080000 | 0x00000400 | 0x00000004 | 0x08000000;
        const uint LabelInformation = 0x00000010;
        const uint WaitTimeout = 258;
        const uint JobKillOnClose = 0x00002000;
        const uint StdHandles = 0x00000100;
        const uint GenericAll = 0x10000000;
        const uint StillActive = 259;

        [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities {
            public IntPtr Sid;
            public IntPtr Capabilities;
            public int CapabilityCount;
            public int Reserved;
        }
        [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes {
            public IntPtr Sid;
            public uint Attributes;
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
            public int Size;
            public string Reserved, Desktop, Title;
            public int X, Y, XSize, YSize, XChars, YChars, Fill;
            public uint Flags;
            public short Show, ReservedSize;
            public IntPtr ReservedBytes, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
            public StartupInfo Info;
            public IntPtr Attributes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
            public IntPtr Process, Thread;
            public int Pid, ThreadId;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct JobBasicLimits {
            public long PerProcessTime, PerJobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct JobLimits {
            public JobBasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }

        [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr capabilities, uint count, out IntPtr sid);
        [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
        [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
        [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo info);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref JobLimits limits, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out uint value, uint size, out uint returned);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string path, int kind, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string path, int kind, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetFileSecurity(string path, uint info, byte[] descriptor, uint length, out uint needed);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetFileSecurity(string path, uint info, byte[] descriptor);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out FileTag info, uint size);
        [StructLayout(LayoutKind.Sequential)] struct FileTag { public uint Attributes, Tag; }
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr descriptor, uint revision, uint info, out IntPtr text, out uint length);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
        [DllImport("kernelbase.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount, out IntPtr capabilities, out uint capabilityCount);

        sealed class ReadCapabilities : IDisposable {
            public IntPtr Values;
            public int Count;
            readonly List<IntPtr> allocated = new List<IntPtr>();
            public ReadCapabilities() {
                IntPtr groups, capabilities;
                uint groupCount, capabilityCount;
                Check(DeriveCapabilitySidsFromName("registryRead", out groups, out groupCount, out capabilities, out capabilityCount), "Derive registry read capability");
                try {
                    for (int i = 0; i < groupCount; i++) LocalFree(Marshal.ReadIntPtr(groups, i * IntPtr.Size));
                    Count = checked((int)capabilityCount);
                    int size = Marshal.SizeOf(typeof(SidAndAttributes));
                    Values = Marshal.AllocHGlobal(size * Count);
                    for (int i = 0; i < Count; i++) {
                        var sid = Marshal.ReadIntPtr(capabilities, i * IntPtr.Size);
                        allocated.Add(sid);
                        Marshal.StructureToPtr(new SidAndAttributes { Sid = sid, Attributes = 4 }, IntPtr.Add(Values, size * i), false);
                    }
                } finally { LocalFree(groups); LocalFree(capabilities); }
            }
            public void Dispose() {
                foreach (IntPtr sid in allocated) LocalFree(sid);
                if (Values != IntPtr.Zero) Marshal.FreeHGlobal(Values);
            }
        }

        sealed class Grant {
            public string Path;
            public FileSystemAccessRule Rule;
            public string Label;
            public bool HasLabel;
            public bool Tree;
            public ControlFlags? OriginalFlags;
        }

        // Shared grant roots serialize preparation, execution and restoration. A second
        // broker must not record the first broker's temporary protection as its baseline.
        sealed class PathLocks : IDisposable {
            readonly List<Mutex> held = new List<Mutex>();
            public bool Acquire(string[] paths, string control, int parentPid) {
                var roots = new SortedSet<string>(StringComparer.Ordinal);
                foreach (string path in paths) if (Directory.Exists(path) || File.Exists(path)) roots.Add(System.IO.Path.GetFullPath(path).TrimEnd('\\').ToUpperInvariant());
                string user = WindowsIdentity.GetCurrent().User.Value;
                foreach (string root in roots) {
                    string name;
                    using (var hash = SHA256.Create()) name = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(user + "|" + root))).Replace("-", "");
                    var mutex = new Mutex(false, "Global\\GenexNativeAcl-" + name);
                    bool acquired = false;
                    try {
                        while (!acquired) {
                            if (parentPid != 0 && StopRequested(control, parentPid)) return false;
                            try { acquired = mutex.WaitOne(100); }
                            catch (AbandonedMutexException) { acquired = true; }
                            if (!acquired) File.WriteAllText(System.IO.Path.Combine(control, "grants.waiting"), "waiting");
                        }
                        held.Add(mutex);
                    } finally { if (!acquired) mutex.Dispose(); }
                }
                return true;
            }
            public void Dispose() {
                for (int i = held.Count - 1; i >= 0; i--) { held[i].ReleaseMutex(); held[i].Dispose(); }
                held.Clear();
            }
        }

        // The trusted host owns this journal outside the child's grants. A flushed record precedes
        // each ACL mutation, so another broker can undo a killed broker without guessing old labels.
        static void Journal(string control, Grant grant, bool deny) {
            string entry = Convert.ToBase64String(Encoding.UTF8.GetBytes(grant.Path)) + "|" +
                (grant.OriginalFlags.HasValue ? "flags" : grant.Rule == null ? "label" : (grant.Tree ? "tree-" : "") + (deny ? "deny" : grant.HasLabel ? "write" : "read")) + "|" +
                Convert.ToBase64String(Encoding.UTF8.GetBytes(grant.OriginalFlags.HasValue ? ((int)grant.OriginalFlags.Value).ToString() : grant.Label ?? "")) + "\n";
            using (var stream = new FileStream(System.IO.Path.Combine(control, "grants.log"), FileMode.Append, FileAccess.Write, FileShare.Read)) {
                byte[] bytes = Encoding.UTF8.GetBytes(entry);
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
        }

        static void Check(bool success, string operation) {
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        static void CheckCode(uint code, string operation) {
            if (code != 0) throw new Win32Exception((int)code, operation);
        }
        static string Quote(string value) {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
                result.Append(c);
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            return result.Append('"').ToString();
        }
        static IntPtr EnvironmentBlock(Hashtable values) {
            var keys = new List<string>();
            foreach (string key in values.Keys) keys.Add(key);
            keys.Sort(StringComparer.OrdinalIgnoreCase);
            var block = new StringBuilder();
            foreach (string key in keys) block.Append(key).Append('=').Append(values[key]).Append('\0');
            block.Append('\0');
            return Marshal.StringToHGlobalUni(block.ToString());
        }
        static string GetLabel(string path) {
            IntPtr owner, group, dacl, sacl, descriptor;
            CheckCode(GetNamedSecurityInfo(path, 1, LabelInformation, out owner, out group, out dacl, out sacl, out descriptor), "Read integrity label");
            IntPtr text = IntPtr.Zero;
            try {
                uint length;
                Check(ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, LabelInformation, out text, out length), "Read label SDDL");
                return Marshal.PtrToStringUni(text);
            } finally {
                if (text != IntPtr.Zero) LocalFree(text);
                LocalFree(descriptor);
            }
        }
        static void SetLabel(string path, string text) {
            IntPtr descriptor = IntPtr.Zero, sacl = IntPtr.Zero;
            try {
                if (!String.IsNullOrEmpty(text) && text != "S:") {
                    uint size;
                    Check(ConvertStringSecurityDescriptorToSecurityDescriptor(text, 1, out descriptor, out size), "Parse integrity label");
                    bool present, defaulted;
                    Check(GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted), "Get integrity label");
                }
                CheckCode(SetNamedSecurityInfo(path, 1, LabelInformation, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl), "Set integrity label");
            } finally {
                if (descriptor != IntPtr.Zero) LocalFree(descriptor);
            }
        }
        static void SetObjectLabel(string path, string text) {
            IntPtr descriptor = IntPtr.Zero;
            try {
                uint size;
                Check(ConvertStringSecurityDescriptorToSecurityDescriptor(String.IsNullOrEmpty(text) ? "S:" : text, 1, out descriptor, out size), "Parse object integrity label");
                byte[] bytes = new byte[size];
                Marshal.Copy(descriptor, bytes, 0, bytes.Length);
                using (var pin = CreateFile(path, 0x00080080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                    Check(!pin.IsInvalid, "Open native label handle");
                    FileTag tag;
                    Check(GetFileInformationByHandleEx(pin, 9, out tag, 8), "Inspect native label handle");
                    if ((tag.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new IOException("Native label path became a reparse point");
                    Check(SetFileSecurity(path, LabelInformation, bytes), "Set native object integrity label");
                }
            } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        }
        static FileSystemSecurity ReadAcl(string path) {
            return Directory.Exists(path) ? (FileSystemSecurity)new DirectoryInfo(path).GetAccessControl() : new FileInfo(path).GetAccessControl();
        }
        static void WriteAcl(string path, FileSystemSecurity acl) {
            if (Directory.Exists(path)) new DirectoryInfo(path).SetAccessControl((DirectorySecurity)acl);
            else new FileInfo(path).SetAccessControl((FileSecurity)acl);
        }
        // Preserve the original ACE order and control bits, including canonical legacy DACLs.
        static RawSecurityDescriptor ReadRawAcl(string path) {
            uint needed;
            GetFileSecurity(path, 7, null, 0, out needed);
            if (needed == 0) Check(false, "Size native path DACL");
            byte[] bytes = new byte[checked((int)needed)];
            Check(GetFileSecurity(path, 7, bytes, needed, out needed), "Read native path DACL");
            return new RawSecurityDescriptor(bytes, 0);
        }
        static RawAcl RawDacl(RawSecurityDescriptor descriptor) {
            if (descriptor.DiscretionaryAcl == null) throw new IOException("Native sandbox cannot edit a null DACL");
            return descriptor.DiscretionaryAcl;
        }
        static void WriteRawDacl(string path, RawSecurityDescriptor descriptor, RawAcl acl) {
            descriptor.DiscretionaryAcl = acl;
            byte[] bytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(bytes, 0);
            // Pin the binding and reject reparse points. The legacy writer preserves the
            // physical ACE flags; named/NT inheritance helpers can materialize old entries.
            using (var pin = CreateFile(path, 0x00040080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                Check(!pin.IsInvalid, "Open native DACL handle");
                FileTag tag;
                Check(GetFileInformationByHandleEx(pin, 9, out tag, 8), "Inspect native DACL handle");
                if ((tag.Attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new IOException("Native DACL path became a reparse point");
                Check(SetFileSecurity(path, 4, bytes), "Set native path DACL");
            }
        }
        static CommonAce RuleAce(FileSystemAccessRule rule) {
            var flags = AceFlags.None;
            if ((rule.InheritanceFlags & InheritanceFlags.ContainerInherit) != 0) flags |= AceFlags.ContainerInherit;
            if ((rule.InheritanceFlags & InheritanceFlags.ObjectInherit) != 0) flags |= AceFlags.ObjectInherit;
            return new CommonAce(flags, rule.AccessControlType == AccessControlType.Deny ? AceQualifier.AccessDenied : AceQualifier.AccessAllowed,
                (int)rule.FileSystemRights, (SecurityIdentifier)rule.IdentityReference, false, null);
        }
        static IEnumerable<string> TreePaths(string path, bool leavesFirst = false) {
            // Pin each binding and its ancestors without delete sharing. OPEN_REPARSE_POINT
            // inspects the object itself; a child cannot redirect cleanup to a foreign tree.
            using (var pin = CreateFile(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                Check(!pin.IsInvalid, "Pin native ACL path");
                FileTag info;
                Check(GetFileInformationByHandleEx(pin, 9, out info, 8), "Inspect native ACL path");
                if ((info.Attributes & (uint)FileAttributes.ReparsePoint) != 0) yield break;
                if (!leavesFirst) yield return path;
                if ((info.Attributes & (uint)FileAttributes.Directory) != 0) {
                    foreach (string child in Directory.EnumerateFileSystemEntries(path)) {
                        foreach (string entry in TreePaths(child, leavesFirst)) yield return entry;
                    }
                }
                if (leavesFirst) yield return path;
            }
        }
        static FileSystemAccessRule PathRule(string path, FileSystemAccessRule rule) {
            return new FileSystemAccessRule(rule.IdentityReference, rule.FileSystemRights,
                Directory.Exists(path) ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                PropagationFlags.None, rule.AccessControlType);
        }
        static void AddRule(string path, FileSystemAccessRule rule) {
            // Named writers normalize old ACEs and propagate that change. Stamp existing
            // objects separately; new children inherit the temporary grant from their parent.
            foreach (string entry in TreePaths(path)) {
                var original = ReadRawAcl(entry);
                var raw = RawDacl(original);
                // A new allow must never precede an existing deny. A job-specific deny wins.
                raw.InsertAce(rule.AccessControlType == AccessControlType.Deny ? 0 : raw.Count, RuleAce(PathRule(entry, rule)));
                WriteRawDacl(entry, original, raw);
            }
        }
        static void RemoveRules(string path, SecurityIdentifier sid, FileSystemAccessRule exact, bool tree) {
            var acl = ReadAcl(path);
            if (!tree && acl.AreAccessRulesCanonical) {
                if (exact != null) acl.RemoveAccessRuleSpecific(exact);
                else foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, false, typeof(SecurityIdentifier))) {
                    if (sid.Equals(rule.IdentityReference)) acl.RemoveAccessRuleSpecific(rule);
                }
                WriteAcl(path, acl);
                return;
            }
            var original = ReadRawAcl(path);
            var raw = RawDacl(original);
            var expected = exact == null ? null : RuleAce(exact);
            bool changed = false;
            for (int i = raw.Count - 1; i >= 0; i--) {
                var ace = raw[i] as CommonAce;
                if (ace == null || !sid.Equals(ace.SecurityIdentifier)) continue;
                if (!tree && (ace.AceFlags & AceFlags.Inherited) != 0) continue;
                if (expected != null && (ace.AccessMask != expected.AccessMask || ace.AceFlags != expected.AceFlags || ace.AceQualifier != expected.AceQualifier)) continue;
                raw.RemoveAce(i);
                changed = true;
            }
            if (changed) WriteRawDacl(path, original, raw);
        }
        static void GrantPath(string path, SecurityIdentifier sid, bool write, bool deny, List<Grant> grants, string control) {
            if (!Directory.Exists(path) && !File.Exists(path)) {
                if (deny) return;
                throw new FileNotFoundException("Native sandbox path is missing", path);
            }
            var inherit = Directory.Exists(path) ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
            var rights = deny ? FileSystemRights.ReadAndExecute : write ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute;
            var rule = new FileSystemAccessRule(sid, rights, inherit, PropagationFlags.None, deny ? AccessControlType.Deny : AccessControlType.Allow);
            // Named ACL writers convert even canonical legacy DACLs to automatic inheritance.
            // Use the pinned per-object path for every tree so cleanup preserves old control bits.
            var grant = new Grant { Path = path, Rule = rule, Tree = true };
            foreach (string entry in TreePaths(path, true)) {
                var descriptor = ReadRawAcl(entry);
                var flags = new Grant { Path = entry, OriginalFlags = descriptor.ControlFlags };
                Journal(control, flags, false);
                grants.Add(flags);
                descriptor.SetFlags(descriptor.ControlFlags | ControlFlags.DiscretionaryAclProtected);
                WriteRawDacl(entry, descriptor, RawDacl(descriptor));
            }
            Journal(control, grant, deny);
            // A tree can fail halfway through; retain its cleanup before stamping.
            grants.Add(grant);
            try { AddRule(path, rule); }
            catch (UnauthorizedAccessException) {
                // An installed runtime may already permit restricted packages. Otherwise launch
                // fails closed; a host that cannot edit its ACL cannot grant new access here.
                if (!write && !deny) return;
                throw;
            }
            if (write) {
                foreach (string entry in TreePaths(path)) {
                    var label = new Grant { Path = entry, HasLabel = true, Label = GetLabel(entry) };
                    Journal(control, label, false);
                    grants.Add(label);
                    SetObjectLabel(entry, "S:(ML;OICI;NW;;;LW)");
                }
            }
        }
        static void Revoke(List<Grant> grants) {
            Exception error = null;
            for (int i = grants.Count - 1; i >= 0; i--) {
                try {
                    var grant = grants[i];
                    if (!Directory.Exists(grant.Path) && !File.Exists(grant.Path)) continue;
                    if (grant.OriginalFlags.HasValue) {
                        var descriptor = ReadRawAcl(grant.Path);
                        descriptor.SetFlags(grant.OriginalFlags.Value);
                        WriteRawDacl(grant.Path, descriptor, RawDacl(descriptor));
                        continue;
                    }
                    if (grant.Rule == null) {
                        SetObjectLabel(grant.Path, grant.Label);
                        continue;
                    }
                    if (grant.HasLabel) SetLabel(grant.Path, grant.Label);
                    if (grant.Tree) foreach (string entry in TreePaths(grant.Path)) {
                        RemoveRules(entry, (SecurityIdentifier)grant.Rule.IdentityReference, null, true);
                    }
                    else RemoveRules(grant.Path, (SecurityIdentifier)grant.Rule.IdentityReference, grant.Rule, false);
                } catch (Exception e) { if (error == null) error = e; }
            }
            if (error != null) throw new IOException("Native sandbox access could not be revoked", error);
        }
        static bool ParentAlive(int pid) {
            try { return !Process.GetProcessById(pid).HasExited; }
            catch (ArgumentException) { return false; }
        }

        /// <summary>Undo only the SID and labels recorded by this owned native job.</summary>
        public static void Recover(string profile, string control, string[] roots) {
            IntPtr sid = IntPtr.Zero;
            using (var locks = new PathLocks()) try {
                locks.Acquire(roots, control, 0);
                int result = DeriveAppContainerSidFromAppContainerName(profile, out sid);
                if (result != 0) Marshal.ThrowExceptionForHR(result);
                var identity = new SecurityIdentifier(sid);
                string journal = System.IO.Path.Combine(control, "grants.log");
                if (File.Exists(journal)) {
                    string content = File.ReadAllText(journal, Encoding.UTF8);
                    string[] entries = content.Split('\n');
                    // An interrupted append cannot have mutated the ACL yet; ignore its partial tail.
                    for (int i = entries.Length - 2; i >= 0; i--) {
                        string[] parts = entries[i].Split('|');
                        if (parts.Length != 3) throw new IOException("Invalid native access recovery record");
                        string path = Encoding.UTF8.GetString(Convert.FromBase64String(parts[0]));
                        if (!Directory.Exists(path) && !File.Exists(path)) continue;
                        if (parts[1] == "flags") {
                            var descriptor = ReadRawAcl(path);
                            descriptor.SetFlags((ControlFlags)Int32.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(parts[2]))));
                            WriteRawDacl(path, descriptor, RawDacl(descriptor));
                            continue;
                        }
                        if (parts[1] == "label") {
                            SetObjectLabel(path, Encoding.UTF8.GetString(Convert.FromBase64String(parts[2])));
                            continue;
                        }
                        bool tree = parts[1].StartsWith("tree-", StringComparison.Ordinal);
                        if (parts[1] == "write" || parts[1] == "tree-write") SetLabel(path, Encoding.UTF8.GetString(Convert.FromBase64String(parts[2])));
                        if (tree) foreach (string entry in TreePaths(path)) RemoveRules(entry, identity, null, true);
                        else RemoveRules(path, identity, null, false);
                    }
                }
                result = DeleteAppContainerProfile(profile);
                // A broker can have completed profile deletion before it lost its completion marker.
                if (result != 0 && result != unchecked((int)0x80070002)) Marshal.ThrowExceptionForHR(result);
                File.WriteAllText(System.IO.Path.Combine(control, "cleanup.ok"), "recovered");
            } finally { if (sid != IntPtr.Zero) FreeSid(sid); }
        }

        static bool StopRequested(string control, int parentPid) {
            return File.Exists(System.IO.Path.Combine(control, "stop")) || !ParentAlive(parentPid);
        }

        public static Outcome Run(string profile, string binary, string[] args, string cwd, string[] reads, string[] writes, string[] denied, Hashtable env, string control, int parentPid) {
            IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, capabilities = IntPtr.Zero;
            IntPtr handles = IntPtr.Zero, environment = IntPtr.Zero, job = IntPtr.Zero, packagePolicy = IntPtr.Zero, jobList = IntPtr.Zero;
            bool initialized = false, created = false, started = false;
            ProcessInfo child = new ProcessInfo();
            var inherited = new List<IntPtr>();
            var grants = new List<Grant>();
            var locks = new PathLocks();
            ReadCapabilities allowedCapabilities = null;
            try {
                // The host can stop an unready compiler before any grants exist.
                // Once this marker exists, recovery must handle a partially prepared job.
                File.WriteAllText(System.IO.Path.Combine(control, "broker.ready"), "ready");
                if (StopRequested(control, parentPid)) return new Outcome { code = 1, pid = null, reason = "cancelled" };
                var roots = new List<string>(); roots.AddRange(reads); roots.AddRange(writes); roots.AddRange(denied);
                if (!locks.Acquire(roots.ToArray(), control, parentPid)) return new Outcome { code = 1, pid = null, reason = "cancelled" };
                int result = CreateAppContainerProfile(profile, "Genex native job", "Temporary isolated native asset job", IntPtr.Zero, 0, out sid);
                if (result != 0) Marshal.ThrowExceptionForHR(result);
                created = true;
                var identity = new SecurityIdentifier(sid);
                foreach (string read in reads) GrantPath(read, identity, false, false, grants, control);
                foreach (string write in writes) GrantPath(write, identity, true, false, grants, control);
                foreach (string deny in denied) GrantPath(deny, identity, false, true, grants, control);
                allowedCapabilities = new ReadCapabilities();
                var caps = new SecurityCapabilities { Sid = sid, Capabilities = allowedCapabilities.Values, CapabilityCount = allowedCapabilities.Count };
                capabilities = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
                Marshal.StructureToPtr(caps, capabilities, false);
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 4, 0, ref size);
                attributes = Marshal.AllocHGlobal(size);
                Check(InitializeProcThreadAttributeList(attributes, 4, 0, ref size), "Initialize AppContainer attributes");
                initialized = true;
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(TokenAttribute), capabilities, new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero), "Set AppContainer capabilities");
                packagePolicy = Marshal.AllocHGlobal(4);
                Marshal.WriteInt32(packagePolicy, 1);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(PackagePolicyAttribute), packagePolicy, new IntPtr(4), IntPtr.Zero, IntPtr.Zero), "Restrict package-wide access");
                foreach (int kind in new int[] { -10, -11, -12 }) {
                    IntPtr copy;
                    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out copy, 0, true, 2), "Duplicate standard handle");
                    inherited.Add(copy);
                }
                handles = Marshal.AllocHGlobal(IntPtr.Size * inherited.Count);
                Marshal.Copy(inherited.ToArray(), 0, handles, inherited.Count);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(HandleAttribute), handles, new IntPtr(IntPtr.Size * inherited.Count), IntPtr.Zero, IntPtr.Zero), "Whitelist standard handles");
                var startup = new StartupInfoEx();
                startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Info.Flags = StdHandles;
                startup.Info.Input = inherited[0]; startup.Info.Output = inherited[1]; startup.Info.Error = inherited[2];
                startup.Attributes = attributes;
                var command = new StringBuilder(Quote(binary));
                foreach (string arg in args) command.Append(' ').Append(Quote(arg));
                environment = EnvironmentBlock(env);
                job = CreateJobObject(IntPtr.Zero, null);
                Check(job != IntPtr.Zero, "Create native job object");
                var limits = new JobLimits(); limits.Basic.Flags = JobKillOnClose;
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(JobLimits))), "Set kill-on-close");
                // Windows assigns the job during process creation, closing the broker-death gap
                // between creating a suspended child and adding it to the job afterwards.
                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(JobAttribute), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Assign native job at creation");
                if (StopRequested(control, parentPid)) return new Outcome { code = 1, pid = null, reason = "cancelled" };
                if (!CreateProcess(binary, command, IntPtr.Zero, IntPtr.Zero, true, CreateFlags, environment, cwd, ref startup, out child)) {
                    int error = Marshal.GetLastWin32Error();
                    var message = error == 5
                        ? "The selected runtime cannot be opened inside the Windows sandbox. Install the pinned private runtime from the plugin setup and retry."
                        : "Start AppContainer native runtime";
                    throw new Win32Exception(error, message);
                }
                started = true;
                IntPtr token;
                Check(OpenProcessToken(child.Process, 8, out token), "Inspect native AppContainer token");
                try {
                    uint isContainer, returned;
                    Check(GetTokenInformation(token, 29, out isContainer, 4, out returned), "Verify native AppContainer token");
                    if (isContainer != 1) throw new IOException("Windows did not create an AppContainer token");
                } finally { CloseHandle(token); }
                if (StopRequested(control, parentPid)) return new Outcome { code = 1, pid = child.Pid, reason = "cancelled" };
                Check(ResumeThread(child.Thread) != UInt32.MaxValue, "Resume native runtime");
                var reason = "exit";
                while (WaitForSingleObject(child.Process, 100) == WaitTimeout) {
                    if (StopRequested(control, parentPid)) {
                        reason = "cancelled";
                        Check(TerminateJobObject(job, 1), "Stop native process tree");
                        Check(WaitForSingleObject(child.Process, 5000) == 0, "Wait for stopped native runtime");
                        break;
                    }
                }
                uint exitCode;
                Check(GetExitCodeProcess(child.Process, out exitCode), "Read native runtime exit code");
                if (exitCode == StillActive) throw new IOException("Native runtime did not stop");
                Check(TerminateJobObject(job, exitCode), "Stop remaining native descendants");
                return new Outcome { code = unchecked((int)exitCode), pid = child.Pid, reason = reason };
            } finally {
                if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); }
                if (started) { TerminateProcess(child.Process, 1); CloseHandle(child.Thread); CloseHandle(child.Process); }
                foreach (IntPtr handle in inherited) CloseHandle(handle);
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
                if (initialized) DeleteProcThreadAttributeList(attributes);
                if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (capabilities != IntPtr.Zero) Marshal.FreeHGlobal(capabilities);
                if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
                if (packagePolicy != IntPtr.Zero) Marshal.FreeHGlobal(packagePolicy);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (allowedCapabilities != null) allowedCapabilities.Dispose();
                try { Revoke(grants); }
                finally {
                    try {
                        if (sid != IntPtr.Zero) FreeSid(sid);
                        if (created) {
                            int cleanup = DeleteAppContainerProfile(profile);
                            if (cleanup != 0) Marshal.ThrowExceptionForHR(cleanup);
                        }
                    } finally { locks.Dispose(); }
                }
                File.WriteAllText(System.IO.Path.Combine(control, "cleanup.ok"), "complete");
            }
        }
    }
}
