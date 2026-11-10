// The input a server-authoritative room receives (PROTOCOL.md §17.3, `AuthorityInput`): one per fixed
// step, staged by the game and sent by GenexAuthoritySession.Frame(). Engine-agnostic: no UnityEngine.
using Genex.Multiplayer.Authority.Wire;

namespace Genex.Multiplayer.Authority
{
    /// <summary>
    /// One step of a player's input. Every number is a double, as everywhere in this package; the server
    /// sanitizes what it receives (<see cref="Sanitized"/> is the same rule), so out-of-range values are
    /// clamped or zeroed, never trusted:
    /// <list type="bullet">
    /// <item><c>MoveX</c>, <c>MoveY</c>, <c>MoveZ</c>: [-1, 1] (non-finite → 0), float32;</item>
    /// <item><c>Yaw</c>, <c>Pitch</c>: radians, wrapped to [-π, π) as float32 (non-finite or past 1e9 → 0);</item>
    /// <item><c>Buttons</c>: an integer bitmask in [0, 2^24), else 0.</item>
    /// </list>
    /// </summary>
    public sealed class GenexInput
    {
        public double MoveX;
        public double MoveY;
        public double MoveZ;
        public double Yaw;
        public double Pitch;
        public double Buttons;

        /// <summary>An input holding these values exactly as given (nothing sanitized yet).</summary>
        public static GenexInput FromRaw(double moveX, double moveY, double moveZ, double yaw, double pitch, double buttons) =>
            new GenexInput { MoveX = moveX, MoveY = moveY, MoveZ = moveZ, Yaw = yaw, Pitch = pitch, Buttons = buttons };

        /// <summary>The input as the server sanitizes it before a module or a preset sees it (wire.ts <c>sanitizeInput</c>).</summary>
        public GenexInput Sanitized()
        {
            var clean = new GenexInput();
            SanitizeInto(MoveX, MoveY, MoveZ, Yaw, Pitch, Buttons, clean);
            return clean;
        }

        /// <summary>Copy every field from <paramref name="other"/>.</summary>
        public void CopyFrom(GenexInput other)
        {
            MoveX = other.MoveX;
            MoveY = other.MoveY;
            MoveZ = other.MoveZ;
            Yaw = other.Yaw;
            Pitch = other.Pitch;
            Buttons = other.Buttons;
        }

        /// <summary>Clear every field to 0 (no movement, no buttons).</summary>
        public void Clear() => CopyFrom(Zero);

        /// <summary>wire.ts <c>sanitizeInput</c> into <paramref name="into"/> (no allocation: the prediction step runs it per replayed input).</summary>
        internal static void SanitizeInto(double moveX, double moveY, double moveZ, double yaw, double pitch, double buttons, GenexInput into)
        {
            into.MoveX = GenexPresets.Axis(moveX);
            into.MoveY = GenexPresets.Axis(moveY);
            into.MoveZ = GenexPresets.Axis(moveZ);
            into.Yaw = GenexPresets.WrappedAngle(yaw) ?? 0;
            into.Pitch = GenexPresets.WrappedAngle(pitch) ?? 0;
            into.Buttons = GenexPresets.Mask(buttons);
        }

        /// <summary>The wire input as sanitized (what the server's step and the reconciler's replay see).</summary>
        internal static void SanitizeInto(AuthorityInput wire, GenexInput into) =>
            SanitizeInto(wire.moveX, wire.moveY, wire.moveZ, wire.yaw, wire.pitch, wire.buttons, into);

        /// <summary>Stage this input, sanitized, on the wire instance the input handle sends.</summary>
        internal void WriteSanitized(AuthorityInput wire)
        {
            wire.moveX = GenexPresets.Axis(MoveX);
            wire.moveY = GenexPresets.Axis(MoveY);
            wire.moveZ = GenexPresets.Axis(MoveZ);
            wire.yaw = GenexPresets.WrappedAngle(Yaw) ?? 0;
            wire.pitch = GenexPresets.WrappedAngle(Pitch) ?? 0;
            wire.buttons = GenexPresets.Mask(Buttons);
        }

        private static readonly GenexInput Zero = new GenexInput();
    }
}
