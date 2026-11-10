// A predicting room's repeated inputs, as this client reconciles them (PROTOCOL.md §17.11 *Input pacing*), a port of
// packages/multiplayer/src/authority/input-repeat.ts's client half: the input your entity in the state was stepped
// through, the upstream throttle that asks for one more input of lead after a starve, and the clock other seats are drawn
// on. Held to packages/netcode-bench/conformance/authority/input-repeat.json by GenexSmoke `input-repeat`. Its tunables
// are AuthoritySchema.cs's generated InputRepeatTuning, never retyped here. All of it is the room's setting
// (`config.inputs.repeat`, input-config.ts): in a room whose setting is off the room repeats nothing, and this client reads
// the plain ack and never throttles.
//
// The reconciler's shadow input handle (GenexShadowInput): Colyseus.Predict's reconciler reads its input handle's
// LastProcessed itself, which only the room sets (InputHandle's constructor and AckInput are internal, LastProcessed's
// setter private). The session gives its reconciler a second handle of its own, made through the SDK's constructor by
// reflection, mirrors every input onto it and acknowledges it up to the stepped-through input (held back while its replay
// ring no longer holds every input after it: §17.11 *The reconciler's ack*); nothing is ever sent on it.
// Both members are also called by the SDK's own Room (Room.Input, the patch handler), so IL2CPP keeps them; link.xml beside
// this file names them too, and SelfCheck fails loudly at startup when reflection cannot find them.
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Threading.Tasks;
using Colyseus;
using Colyseus.Schema;
using Genex.Multiplayer.Authority.Tuning;
using Genex.Multiplayer.Authority.Wire;

namespace Genex.Multiplayer.Authority
{
    /// <summary>A client's upstream throttle: the starve runs it has answered (none before the first reading), the lead (ms)
    /// still owed, the part of the next extra input already paid (<see cref="AccMs"/>), and the lead added so far
    /// (<see cref="AheadMs"/>: the input clock runs this far ahead of real time).</summary>
    public sealed class GenexInputThrottle
    {
        public double? SeenRuns;
        public double OwedMs;
        public double AccMs;
        public double AheadMs;
    }

    /// <summary>A room's input repeat setting (§17.11 *Input pacing*, <c>config.inputs.repeat</c>): <see cref="On"/>, a
    /// starved seat's held input is repeated and its client reconciles at <c>ack + inRep</c> and throttles;
    /// <see cref="Off"/>, the seat holds on a starved tick and its client reads the plain ack and never throttles.</summary>
    public enum GenexInputRepeatSetting
    {
        On,
        Off,
    }

    /// <summary>The client half of §17.11 *Input pacing* (input-repeat.ts).</summary>
    public static class GenexInputRepeat
    {
        /// <summary>The setting as the state's <c>preset</c> text (JSON) publishes it in its <c>inputs</c> key: off only when
        /// the text says so outright, on for anything else (absent: a room without the setting or an older host; a hostile
        /// value: the room's own fields are the truth, and a room that is off writes none).</summary>
        public static GenexInputRepeatSetting SettingOf(string presetText)
        {
            if (string.IsNullOrEmpty(presetText) || !GenexJson.TryParse(presetText, out var spec)) return GenexInputRepeatSetting.On;
            var off = spec is IDictionary<string, object> o && o.TryGetValue("inputs", out var inputs)
                && inputs is IDictionary<string, object> i && i.TryGetValue("repeat", out var repeat)
                && repeat is string r && string.Equals(r, "off", StringComparison.Ordinal);
            return off ? GenexInputRepeatSetting.Off : GenexInputRepeatSetting.On;
        }

        /// <summary>The input your entity in the state was stepped through: <paramref name="ack"/> plus the state's
        /// <c>inRep</c> when that is a non-negative integer (anything else reads 0), never past <paramref name="sent"/> and
        /// never below the ack. With the setting <paramref name="repeat"/> off, <c>inRep</c> is never read: the ack.</summary>
        public static int SteppedThrough(int ack, double inRep, int sent, GenexInputRepeatSetting repeat)
        {
            if (repeat == GenexInputRepeatSetting.Off) return ack;
            var valid = !double.IsNaN(inRep) && !double.IsInfinity(inRep) && inRep > 0 && Math.Floor(inRep) == inRep;
            // Compared as doubles, so a huge inRep stops at what was sent without overflowing.
            var through = valid ? Math.Min(ack + inRep, sent) : ack;
            return Math.Max(ack, (int)through);
        }

        /// <summary>The input the state holds your entity stepped through (input-repeat.ts stateThrough): <paramref name="ack"/>
        /// plus a valid <c>inRep</c> (a positive integer, else none), not clamped to what you sent (a hitch steps it past the
        /// inputs you sent); a huge <c>inRep</c> saturates at int.MaxValue. With the setting <paramref name="repeat"/> off: the
        /// ack. What <see cref="GenexReconcilerAckHold.Ack"/> is handed.</summary>
        public static int StateThrough(int ack, double inRep, GenexInputRepeatSetting repeat)
        {
            if (repeat == GenexInputRepeatSetting.Off) return ack;
            var valid = !double.IsNaN(inRep) && !double.IsInfinity(inRep) && inRep > 0 && Math.Floor(inRep) == inRep;
            if (!valid) return ack;
            // Summed as doubles, so a huge inRep saturates without overflowing.
            return (int)Math.Min((double)ack + inRep, int.MaxValue);
        }

        /// <summary>The input your reconciler compares the state with your prediction at, given the one it compared at last
        /// (<paramref name="held"/>; input-repeat.ts reconcileThrough), §17.11 *The reconciler's ack*, its hitch clause alone:
        /// <paramref name="ack"/> plus a valid <c>inRep</c> once you have sent that input. Past what you sent (a hitch drained
        /// your seat's buffer and the room repeated for inputs you have not sent yet) no prediction of yours is at the state's
        /// input, so the reconcile waits at <paramref name="held"/>, never past <paramref name="sent"/>. With the setting
        /// <paramref name="repeat"/> off: the ack. A reconciler is told <see cref="GenexReconcilerAckHold.Ack"/>, which applies
        /// this clause and then the ring's.</summary>
        public static int ReconcileThrough(int held, int ack, double inRep, int sent, GenexInputRepeatSetting repeat)
        {
            if (repeat == GenexInputRepeatSetting.Off) return ack;
            return WaitPastSent(held, StateThrough(ack, inRep, repeat), sent);
        }

        /// <summary>The hitch clause: <paramref name="through"/> once it is sent, else <paramref name="held"/>, never past
        /// <paramref name="sent"/>.</summary>
        internal static int WaitPastSent(int held, int through, int sent) => through <= sent ? through : Math.Min(held, sent);

        /// <summary>A keyframe's <c>inStarve</c> and <c>inBuf</c> for your seat (NaN = absent): a new starve run with at most
        /// the tuned low buffer owes one step of lead, at most one step owed at a time; the first reading only takes the
        /// count. With the setting <paramref name="repeat"/> off no reading is taken: nothing is ever owed.</summary>
        public static void ThrottleState(GenexInputThrottle t, double inStarve, double inBuf, double stepMs, GenexInputRepeatSetting repeat)
        {
            if (repeat == GenexInputRepeatSetting.Off || double.IsNaN(inStarve) || double.IsInfinity(inStarve)) return;
            var fresh = t.SeenRuns.HasValue && inStarve > t.SeenRuns.Value;
            t.SeenRuns = inStarve;
            if (!fresh || !(stepMs > 0)) return;
            var buffered = double.IsNaN(inBuf) || double.IsInfinity(inBuf) ? 0 : inBuf;
            if (buffered <= InputRepeatTuning.ThrottleLowInputs) t.OwedMs = Math.Max(t.OwedMs, stepMs);
        }

        /// <summary>A frame <paramref name="dtMs"/> long: the extra inputs it sends (0 or more), the owed lead paid the tuned
        /// dilation of real time at a time, each input sent once half of its step has been paid.</summary>
        public static int ThrottleSteps(GenexInputThrottle t, double dtMs, double stepMs)
        {
            if (!(stepMs > 0) || !(dtMs > 0) || t.OwedMs <= 0) return 0;
            var add = Math.Min(t.OwedMs, dtMs * InputRepeatTuning.ThrottleDilation);
            t.OwedMs -= add;
            t.AccMs += add;
            t.AheadMs += add;
            // Sent halfway through the dilation: the extra input is never more than half a step off the throttled clock.
            var steps = Math.Floor(t.AccMs / stepMs + 0.5);
            t.AccMs -= steps * stepMs;
            return (int)steps;
        }

        /// <summary>The input clock other seats are drawn on: <c>raw</c> the input <paramref name="stepped"/> plus
        /// <paramref name="drawn"/> inputs past it plus the tuned share of the throttle's part-paid extra input, <c>at</c> the
        /// frame's instant plus that share of its lead.</summary>
        public static (double Raw, double At) SeatLeadClock(double stepped, double drawn, GenexInputThrottle t, double stepMs, double frameNow)
        {
            var part = stepMs > 0 ? t.AccMs / stepMs : 0;
            return (stepped + drawn + InputRepeatTuning.ThrottleSeatLead * part, frameNow + InputRepeatTuning.ThrottleSeatLead * t.AheadMs);
        }
    }

    /// <summary>The ack your reconciler was last told (<see cref="Shown"/>) and the inputs sent when it began holding one back
    /// (<see cref="HeldFrom"/>; null: not holding), §17.11 *The reconciler's ack* (input-repeat.ts <c>reconcilerAck</c>).</summary>
    public sealed class GenexReconcilerAckHold
    {
        public int Shown;
        public int? HeldFrom;

        /// <summary>The ack your reconciler is told, from the input the state holds your entity stepped through
        /// (<paramref name="through"/>, <see cref="GenexInputRepeat.StateThrough"/>: never clamped to <paramref name="sent"/>).
        /// The hitch clause first: past <paramref name="sent"/> it is the ack told last, never past it
        /// (<see cref="GenexInputRepeat.ReconcileThrough"/>). Then the ring's: that ack <c>stepped</c>, unless it advanced
        /// while input <c>stepped + 1</c> is in neither the replay ring (<paramref name="ring"/> inputs back from
        /// <paramref name="sent"/>) nor another copy the reconciler reads (<paramref name="kept"/>). Then it stays the ack
        /// last told, for at most a ring's length of sends from the first held ack; the hold is armed again only by an ack
        /// within the ring or one that moved back (a reset). A hitch neither arms nor ends a hold.</summary>
        public int Ack(int through, int sent, int ring, bool kept)
        {
            var stepped = GenexInputRepeat.WaitPastSent(Shown, through, sent);
            if (stepped <= Shown)
            {
                if (stepped < Shown) HeldFrom = null;
                Shown = stepped;
                return stepped;
            }
            var whole = stepped == sent || sent - (stepped + 1) < ring || kept;
            if (whole)
            {
                HeldFrom = null;
                Shown = stepped;
                return stepped;
            }
            HeldFrom ??= sent;
            if (sent - HeldFrom.Value < ring) return Shown;
            Shown = stepped;
            return stepped;
        }
    }

    /// <summary>The reconciler's own input handle (see the file's header): a local copy of the room's handle, acknowledged
    /// up to the ack its <see cref="GenexReconcilerAckHold"/> tells (GenexInputRepeat.StateThrough's input through both
    /// clauses of §17.11 *The reconciler's ack*).</summary>
    public sealed class GenexShadowInput
    {
        private const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic;
        private static readonly System.Type[] CtorSignature =
        {
            typeof(Schema), typeof(InputEncoder), typeof(bool), typeof(bool), typeof(double?), typeof(Func<object, bool>),
            typeof(int?), typeof(int?), typeof(int?), typeof(Func<Connection>), typeof(Func<RoomClock>),
        };
        private static readonly ConstructorInfo Ctor = typeof(InputHandle).GetConstructor(Internal, null, CtorSignature, null);
        private static readonly MethodInfo AckInputMethod = typeof(InputHandle).GetMethod("AckInput", Internal, null, new[] { typeof(int) }, null);

        /// <summary>Why reflection cannot make a shadow handle in this build ("" when it can): the SDK's internal
        /// InputHandle constructor or AckInput was renamed or stripped.</summary>
        public static string Missing()
        {
            if (Ctor == null) return "Colyseus.InputHandle's internal constructor (Schema, InputEncoder, bool, bool, double?, Func<object,bool>, int?, int?, int?, Func<Connection>, Func<RoomClock>)";
            if (AckInputMethod == null) return "Colyseus.InputHandle.AckInput(int)";
            return "";
        }

        /// <summary>Throws when reflection cannot make a shadow handle: called once at startup, so a stripped or changed SDK
        /// fails loudly instead of predicting at the plain ack.</summary>
        public static void SelfCheck()
        {
            var missing = Missing();
            if (missing.Length > 0)
                throw new InvalidOperationException("genex: input repeat (§17.11) needs " + missing + "; keep it with link.xml (sdks/unity/Runtime/link.xml) or pin Colyseus 0.18.8");
        }

        private readonly InputHandle real;
        private readonly AuthorityInput data = new AuthorityInput();
        private readonly object[] ackArgs = new object[1];
        private readonly GenexReconcilerAckHold hold = new GenexReconcilerAckHold();
        private int epoch;

        /// <summary>The handle the reconciler reads.</summary>
        public readonly InputHandle Handle;

        /// <summary>A shadow of <paramref name="room"/>'s handle <paramref name="real"/>: the same rates, a connection that is
        /// always open and sends nothing, no lag-comp stamps (the real handle carries them).</summary>
        public GenexShadowInput(InputHandle real, Func<RoomClock> clock)
        {
            SelfCheck();
            this.real = real;
            var connection = new Connection("genex-shadow://input", new Dictionary<string, string>()) { IsOpen = true, Transmit = _ => Task.CompletedTask };
            var encoder = new InputEncoder(data);
            Handle = (InputHandle)Ctor.Invoke(new object[] { data, encoder, false, false, null, null, real.TickRate, real.PatchRate, real.SubSteps, (Func<Connection>)(() => connection), clock });
            epoch = real.Epoch;
            Mirror(real.LastProcessed);
        }

        /// <summary>Follows the real handle: reset with it (a reconnect's new socket counts from 1 again), every input it sent
        /// copied and sent on, then acknowledged up to what its hold tells from <paramref name="through"/>, the input the state
        /// holds your entity stepped through (which never falls between resets).</summary>
        public void Mirror(int through)
        {
            if (real.Epoch != epoch)
            {
                Handle.Reset();
                epoch = real.Epoch;
            }
            while (Handle.SentCount < real.SentCount)
            {
                // An input already acknowledged is out of the real ring: none replays it, any copy counts it.
                var from = real.At(Handle.SentCount + 1) as AuthorityInput ?? real.Data as AuthorityInput;
                if (from != null)
                {
                    data.moveX = from.moveX;
                    data.moveY = from.moveY;
                    data.moveZ = from.moveZ;
                    data.yaw = from.yaw;
                    data.pitch = from.pitch;
                    data.buttons = from.buttons;
                }
                if (Handle.Send() <= 0) break;
            }
            // The reconciler replays only from this handle's ring: no other copy is read.
            var told = hold.Ack(through, Handle.SentCount, Handle.ReplayBufferSize, false);
            if (told <= Handle.LastProcessed) return;
            ackArgs[0] = told;
            AckInputMethod.Invoke(Handle, ackArgs);
        }
    }
}
