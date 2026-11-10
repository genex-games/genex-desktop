// Unity-only glue: drives GenexSession.Tick() / GenexMatchmaker.Tick() and, for server-authoritative
// rooms, GenexAuthoritySession.Frame() (the Colyseus Predict tick: due inputs, prediction, interpolation)
// from the player loop, before the game's own scripts, and on WebGL also TickTimers() from a browser
// setInterval (Runtime/WebGL/GenexTimer.jslib), because a hidden tab stops Unity's requestAnimationFrame
// loop while the socket stays open (§6.3, §16.2). That timer never sends an authority input: a hidden
// tab simply stops playing.
// The engine-agnostic core never touches UnityEngine; this file is the one place that does.
// NOT compiled by Tests~/GenexSmoke (it needs the Unity engine), so it is unverified outside Unity;
// the TickTimers() path it calls is covered there.
#if UNITY_5_3_OR_NEWER
using System;
using System.Collections.Generic;
using Genex.Multiplayer.Authority;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace Genex.Multiplayer.Unity
{
    /// <summary>
    /// A hidden, scene-persistent MonoBehaviour that ticks every registered session and matchmaker once per
    /// frame on the main thread (the thread the Colyseus SDK posts socket events to). Created on first use.
    /// </summary>
    [AddComponentMenu("")]
    // Before the game's scripts, so their Update reads this frame's prediction and interpolation.
    [DefaultExecutionOrder(-1000)]
    public sealed class GenexPump : MonoBehaviour
    {
        private static GenexPump instance;
        private readonly List<GenexSession> sessions = new List<GenexSession>();
        private readonly List<GenexMatchmaker> matchmakers = new List<GenexMatchmaker>();
        private readonly List<(GenexAuthoritySession session, bool autoFrame)> authority = new List<(GenexAuthoritySession, bool)>();

        /// <summary>
        /// Keep ticking while the window is unfocused (desktop/mobile players). Host simulation and the §16
        /// heartbeat run from this pump, and a paused host freezes the whole room until failover.
        /// Set false before the first Register call to keep Unity's default.
        /// </summary>
        public static bool RunInBackground = true;

        /// <summary>WebGL: the wall-clock pump's period in ms (the browser throttles it to ~1 Hz in a hidden tab).</summary>
        public const int TimerIntervalMs = 50;

#if UNITY_WEBGL && !UNITY_EDITOR
        private delegate void TimerCallback();

        [DllImport("__Internal")] private static extern void GenexTimer_Start(int intervalMs, TimerCallback callback);
        [DllImport("__Internal")] private static extern void GenexTimer_Stop();

        [AOT.MonoPInvokeCallback(typeof(TimerCallback))]
        private static void OnTimer()
        {
            if (instance != null) instance.PumpTimers();
        }
#endif

        private static GenexPump Ensure()
        {
            if (instance != null) return instance;
            var go = new GameObject("[Genex Multiplayer]") { hideFlags = HideFlags.HideInHierarchy };
            DontDestroyOnLoad(go);
            instance = go.AddComponent<GenexPump>();
            if (RunInBackground) Application.runInBackground = true;
#if UNITY_WEBGL && !UNITY_EDITOR
            GenexTimer_Start(TimerIntervalMs, OnTimer);
#endif
            return instance;
        }

        /// <summary>Tick this session every frame until it closes.</summary>
        public static GenexSession Register(GenexSession session)
        {
            var pump = Ensure();
            if (!pump.sessions.Contains(session)) pump.sessions.Add(session);
            return session;
        }

        /// <summary>Tick this matchmaker (and its match session) every frame until it is cancelled.</summary>
        public static GenexMatchmaker Register(GenexMatchmaker matchmaker)
        {
            var pump = Ensure();
            if (!pump.matchmakers.Contains(matchmaker)) pump.matchmakers.Add(matchmaker);
            return matchmaker;
        }

        /// <summary>
        /// Drive this server-authoritative session until it closes: <see cref="GenexAuthoritySession.Frame()"/> once per
        /// frame, before your scripts' Update (stage <c>session.Input</c> there; it is sent on the next frame's due
        /// steps). With <paramref name="autoFrame"/> false the pump runs only its timers and you call Frame() yourself,
        /// for example after staging input in the same Update.
        /// </summary>
        public static GenexAuthoritySession Register(GenexAuthoritySession session, bool autoFrame = true)
        {
            var pump = Ensure();
            pump.authority.RemoveAll(entry => entry.session == session);
            pump.authority.Add((session, autoFrame));
            return session;
        }

        public static void Unregister(GenexAuthoritySession session) => instance?.authority.RemoveAll(entry => entry.session == session);

        public static void Unregister(GenexSession session) => instance?.sessions.Remove(session);
        public static void Unregister(GenexMatchmaker matchmaker) => instance?.matchmakers.Remove(matchmaker);

        private void Update()
        {
            for (var i = sessions.Count - 1; i >= 0; i--)
            {
                if (i >= sessions.Count) continue; // a callback unregistered something
                var s = sessions[i];
                if (s.IsClosed) { sessions.RemoveAt(i); continue; }
                s.Tick();
            }
            for (var i = matchmakers.Count - 1; i >= 0; i--)
            {
                if (i >= matchmakers.Count) continue;
                var m = matchmakers[i];
                if (m.Status == "cancelled") { matchmakers.RemoveAt(i); continue; }
                m.Tick();
            }
            for (var i = authority.Count - 1; i >= 0; i--)
            {
                if (i >= authority.Count) continue;
                var (a, autoFrame) = authority[i];
                if (a.IsClosed) { authority.RemoveAt(i); continue; }
                if (autoFrame) a.Frame();
                else a.TickTimers();
            }
        }

        // Only the time-driven work. Exceptions stay here: one must never escape into the browser's timer.
        private void PumpTimers()
        {
            for (var i = sessions.Count - 1; i >= 0; i--)
            {
                if (i >= sessions.Count) continue; // a callback unregistered something
                var s = sessions[i];
                if (s.IsClosed) continue;
                try { s.TickTimers(); }
                catch (Exception e) { Debug.LogException(e); }
            }
            for (var i = matchmakers.Count - 1; i >= 0; i--)
            {
                if (i >= matchmakers.Count) continue;
                var m = matchmakers[i];
                if (m.Status == "cancelled") continue;
                try { m.TickTimers(); }
                catch (Exception e) { Debug.LogException(e); }
            }
            for (var i = authority.Count - 1; i >= 0; i--)
            {
                if (i >= authority.Count) continue;
                var a = authority[i].session;
                if (a.IsClosed) continue;
                try { a.TickTimers(); }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        private void OnDestroy()
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            if (instance == this) GenexTimer_Stop();
#endif
            if (instance == this) instance = null;
        }

        private void OnApplicationQuit()
        {
            foreach (var s in sessions) _ = s.Leave();
            foreach (var m in matchmakers) m.Cancel();
            foreach (var (a, _) in authority) _ = a.Leave();
        }
    }
}
#endif
