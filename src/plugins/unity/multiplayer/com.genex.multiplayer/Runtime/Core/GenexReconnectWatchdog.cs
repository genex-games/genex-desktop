// Runs the Colyseus C# SDK's in-place reconnect attempts when the SDK cannot (a WebGL player).
//
// The SDK 0.18.8 schedules each attempt with `await Task.Delay(delay)` (Room.RetryReconnection). In a WebGL
// player that wait never resumes (no thread-pool timers; the SDK's own comments say so for its request
// timeouts), so after a drop the room never reconnects: measured, "Will retry in 0.3 seconds..." and nothing
// for 20 s. The watchdog runs the attempt the SDK scheduled once it is StallMs past due, on the same §8 ladder
// (the room's Reconnection settings), with the SDK's own call (Connection.Reconnect with the room's token).
//
// The SDK already counted that attempt (RetryReconnection increments RetryCount before its wait), so the
// watchdog runs it as it is, once, and never counts it again: a socket that then fails closes through the
// SDK's drop handling, whose RetryReconnection counts and schedules the next attempt (or, after MaxRetries,
// ends the room with 4003 itself), and the watchdog runs that one too. Counting it here as well spent two
// retries per attempt: four real attempts instead of nine. Only an attempt that throws before it opens a
// socket (no close follows) is counted here, as the SDK's own catch would. Never on an open socket.
//
// Both sessions (GenexSession, GenexAuthoritySession) own one: they call Reset() on every drop and Tick()
// from their timers while the SDK is reconnecting. Main thread only, as the sessions. No UnityEngine here.
using System;
using System.Threading.Tasks;
using Colyseus;
using Colyseus.Schema;

namespace Genex.Multiplayer
{
    internal sealed class GenexReconnectWatchdog<T> where T : Schema
    {
        /// <summary>
        /// How far past its scheduled start an SDK attempt may be before the watchdog runs it. Paid on each of the
        /// §8 ladder's nine attempts, so it must keep the last one (23.75 s of backoff) inside the 30 s seat
        /// grace: 9 × 250 ms leaves ~4 s for the handshakes.
        /// </summary>
        internal const double StallMs = 250;

        private readonly Room<T> room;
        private readonly Action giveUp;
        private int watchedRetry = -1;
        private double watchedSince;
        private int kickedRetry = -1;

        /// <param name="giveUp">Ends the session with 4003 when an attempt that threw was the ladder's last.</param>
        internal GenexReconnectWatchdog(Room<T> room, Action giveUp)
        {
            this.room = room;
            this.giveUp = giveUp;
        }

        /// <summary>Attempts this watchdog ran because the SDK's never did.</summary>
        internal int Kicks { get; private set; }

        /// <summary>
        /// On every drop: the SDK schedules a new attempt now (a new drop restarts its count at 1), so time it from
        /// here, and an attempt number run in an earlier drop is not this one.
        /// </summary>
        internal void Reset()
        {
            watchedRetry = -1;
            kickedRetry = -1;
        }

        /// <summary>Run the SDK's scheduled attempt once it is overdue. Call while the session waits for the SDK to reconnect.</summary>
        internal void Tick(double now)
        {
            var r = room.Reconnection;
            if (!r.IsReconnecting || room.Connection == null || room.Connection.IsOpen) return;
            if (r.RetryCount != watchedRetry)
            {
                watchedRetry = r.RetryCount;
                watchedSince = now;
                return;
            }
            if (kickedRetry == r.RetryCount) return;
            var delay = Math.Min(r.MaxDelay, Math.Max(r.MinDelay, r.Backoff(r.RetryCount, r.Delay)));
            if (now < watchedSince + delay + (GenexSession.TestReconnectStallMs ?? StallMs)) return;
            kickedRetry = r.RetryCount;
            Kicks++;
            _ = Attempt(r.RetryCount, room.ReconnectionToken.Token);
        }

        private async Task Attempt(int retry, string token)
        {
            try
            {
                await room.Connection.Reconnect(token);
            }
            catch (Exception e)
            {
                ColyseusContext.Logger.Log($"[genex] reconnect attempt failed: {e.Message}");
                AttemptThrew(retry);
            }
        }

        /// <summary>The SDK's catch after a failed attempt: count the next one, or give up once the ladder is spent.</summary>
        private void AttemptThrew(int retry)
        {
            var r = room.Reconnection;
            if (!r.IsReconnecting || r.RetryCount != retry) return; // a close already moved the ladder on
            if (r.RetryCount < r.MaxRetries)
            {
                r.RetryCount++;
                return;
            }
            r.IsReconnecting = false;
            r.Enabled = false;
            giveUp();
        }
    }
}
