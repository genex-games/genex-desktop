// How a client sizes a reconcile of its own entity (PROTOCOL.md §17.3 *Correction telemetry*): a port of
// packages/multiplayer/src/authority/correction.ts, held to packages/netcode-bench/conformance/authority/correction.json
// (Tests~/GenexSmoke, mode `correction`). Telemetry: no client decides anything by these.
using System;

namespace Genex.Multiplayer.Authority
{
    public static class GenexCorrection
    {
        /// <summary>A move of the own entity past this many metres counts as a visible correction.</summary>
        public const double VisibleMetres = 0.05;

        private const double TwoPi = 2 * Math.PI;

        /// <summary>The sizes of a reconcile from <paramref name="before"/> to <paramref name="after"/>, both in the order of
        /// <paramref name="fields"/>: <paramref name="place"/> the length of the move of x y z, room units;
        /// <paramref name="state"/> the largest change of any other counted field, each in its own unit (a heading by the short
        /// arc across ±π). A yaw rate, the movement bits, the speed cap and the fuel count for nothing: they show as what they
        /// lead to.</summary>
        public static void Sizes(string[] fields, double[] before, double[] after, out double place, out double state)
        {
            var squares = 0.0;
            state = 0.0;
            for (var i = 0; i < fields.Length; i++)
            {
                var field = fields[i];
                if (field == "mstate" || field == "cap" || field == "spin" || field == "fuel") continue;
                var delta = after[i] - before[i];
                if (field == "x" || field == "y" || field == "z") squares += delta * delta;
                else state = Math.Max(state, Math.Abs(field == "yaw" ? delta - TwoPi * Math.Floor((delta + Math.PI) / TwoPi) : delta));
            }
            place = Math.Sqrt(squares);
        }

        /// <summary>Whether a move of <paramref name="place"/> room units is a visible correction in a room of
        /// <paramref name="unitsPerMetre"/>.</summary>
        public static bool IsVisible(double place, double unitsPerMetre) => place > VisibleMetres * unitsPerMetre;
    }
}
