// Public value types of the Genex layer. Engine-agnostic: no UnityEngine here.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer
{
    /// <summary>One seated player (PROTOCOL.md §4 PlayerState), as this client sees it.</summary>
    public sealed class GenexPlayer
    {
        /// <summary>Session id. Changes on every reload: key anything durable by <see cref="Uid"/>.</summary>
        public string Id { get; internal set; }
        public string Name { get; internal set; } = "";
        /// <summary>Stable per-game player id (§3.3). Opaque, never parse it.</summary>
        public string Uid { get; internal set; } = "";
        /// <summary>Verified VRM avatar URL, or "".</summary>
        public string AvatarUrl { get; internal set; } = "";
        /// <summary>Team index, or -1 (§9.4).</summary>
        public int Team { get; internal set; } = -1;
        /// <summary>False while the seat is held only by reconnection grace.</summary>
        public bool Connected { get; internal set; } = true;
        public bool IsMe { get; internal set; }
        /// <summary>True when this player publishes the typed pose (§6.6); its pose keys are merged into State.</summary>
        public bool Posed { get; internal set; }
        public double Epoch { get; internal set; }
        /// <summary>
        /// RENDER ONLY. Remote players: interpolated on the sender's clock and slightly delayed (§10).
        /// Yourself: your last local publish. Updated by <see cref="GenexSession.Tick"/>; a remote player's
        /// dictionary is rewritten IN PLACE every frame, so copy it to keep one frame's values.
        /// </summary>
        public Dictionary<string, object> State { get; internal set; } = new Dictionary<string, object>();
        /// <summary>The latest raw snapshot (never smoothed or delayed): use it for gameplay reads.</summary>
        public Dictionary<string, object> StateRaw { get; internal set; } = new Dictionary<string, object>();
    }

    /// <summary>A shared object (§7), as this client sees it.</summary>
    public sealed class GenexObject
    {
        public string Id { get; internal set; }
        /// <summary>Owner session id, or null when unowned. Optimistic while a claim with Optimistic=true is pending.</summary>
        public string Owner { get; internal set; }
        /// <summary>Ownership sequence: +1 on every owner change.</summary>
        public double Seq { get; internal set; }
        /// <summary>Deliberate-discontinuity epoch (hard reset).</summary>
        public double Epoch { get; internal set; }
        public bool IsMine { get; internal set; }
        /// <summary>
        /// RENDER ONLY: interpolated when someone else owns it (rewritten in place every frame, copy it to keep
        /// it); your last publish when it is yours.
        /// </summary>
        public Dictionary<string, object> State { get; internal set; } = new Dictionary<string, object>();
        /// <summary>The latest raw published state.</summary>
        public Dictionary<string, object> StateRaw { get; internal set; } = new Dictionary<string, object>();
    }

    /// <summary>The answer to a claim / release / destroy (§7.2), or a client-side settlement.</summary>
    public sealed class ObjectControlResult
    {
        public string RequestId;
        /// <summary>"claim", "release" or "remove".</summary>
        public string Operation;
        public string Id;
        public bool Accepted;
        public string Owner;
        public double Sequence;
        /// <summary>A relay reason (accepted, already-owner, held, rate-limited, not-owner, capacity, invalid, missing,
        /// host-authority, not-host) or a client one (timeout, aborted, disconnected).</summary>
        public string Reason;
        public double? RetryAfterMs;

        public override string ToString() =>
            $"{Operation} {Id}: {(Accepted ? "accepted" : "rejected")} ({Reason}) owner={Owner ?? "-"} seq={Sequence}";
    }

    public sealed class ControlOptions
    {
        /// <summary>Host-authority claim (host only; displaces a held owner). Claim only.</summary>
        public bool HostAuthority;
        /// <summary>Render yourself as owner before the result arrives; reverted on rejection.</summary>
        public bool Optimistic;
        /// <summary>Maximum wait, including a reconnect resend. Default 5000 ms, capped at 60 s.</summary>
        public double TimeoutMs = GenexProtocol.DefaultControlTimeoutMs;
    }

    /// <summary>One chat line as the relay stamped it (§12).</summary>
    public sealed class ChatMessage
    {
        public double Id;
        public string From;
        public string Name;
        public string Text;
        /// <summary>Relay epoch ms.</summary>
        public double At;
    }

    /// <summary>A refused join (matchmaking error code, §3.4).</summary>
    public sealed class GenexJoinException : Exception
    {
        public int Code { get; }
        /// <summary>False when this is not a server's answer: the request failed and no body named a code. That is a
        /// gateway's own error page, or a response the browser would not let the page read, which a WebGL player reports
        /// as a 500 "Unknown Error" whatever the server sent. Such a failure is a path that is down, whatever its status.</summary>
        public bool Answered { get; }
        public GenexJoinException(int code, string message, Exception inner = null, bool answered = true) : base(message, inner) { Code = code; Answered = answered; }
        /// <summary>426: the relay does not speak this protocol. Do not retry; the game needs an update.</summary>
        public bool ProtocolUnsupported => Code == GenexProtocol.JoinError.ProtocolUnsupported;
        /// <summary>401: get a fresh token; if it repeats, the player must sign in again.</summary>
        public bool AuthRequired => Code == GenexProtocol.JoinError.AuthRequired;
        /// <summary>402 (authority rooms): the game's owner is not entitled to them. Final; never retried.</summary>
        public bool NotEntitled => Code == GenexProtocol.Authority.JoinError.NotEntitled;
        /// <summary>424 (authority rooms): the game has no room module on this channel. Final until it is republished.</summary>
        public bool ModuleUnavailable => Code == GenexProtocol.Authority.JoinError.ModuleUnavailable;
        /// <summary>429 (authority rooms): the owner's quota refused a new room. You MAY try again later.</summary>
        public bool RoomQuota => Code == GenexProtocol.Authority.JoinError.RoomQuota;
        /// <summary>503 (authority rooms): no server could take the room; already retried per the session's backoff.</summary>
        public bool CapacityRefused => Code == GenexProtocol.Authority.JoinError.Capacity;
    }
}
