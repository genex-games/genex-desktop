// Choosing an authority room (PROTOCOL.md §17.2 *Choosing a room*; TypeScript `authority/room-key.ts`): the shapes of a
// match key and a room code, what each way into a room sends, where a join by code goes after a refusal, and which
// world a key picks. Pure; Tests~/GenexSmoke/RoomKeyCheck.cs holds room-key.json exactly, as every SDK does. The checks
// are plain character loops: a regex `$` passes a trailing newline here.
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The ways into an authority room, by the Colyseus call that makes them.</summary>
    public enum GenexJoinMethod { JoinOrCreate, Create, JoinById }

    /// <summary>Why a client refuses a target before anything reaches the network.</summary>
    public enum GenexTargetRefusal { None, BadMatchKey, BadCode, Conflict }

    /// <summary>The Colyseus call a target makes, and the options it adds to the join's own.</summary>
    public sealed class GenexJoinPlan
    {
        public GenexTargetRefusal Refused;
        public GenexJoinMethod Method;
        public string RoomId;
        /// <summary>Sent as <c>matchKey</c> when not null.</summary>
        public string MatchKey;
        /// <summary>Sent as <c>private: true</c>.</summary>
        public bool PrivateRoom;
    }

    /// <summary>The rules of §17.2 *Choosing a room*.</summary>
    public static class GenexRoomKey
    {
        /// <summary>A match key's longest length.</summary>
        public const int MaxMatchKeyChars = 32;
        /// <summary>A room code's longest length.</summary>
        public const int MaxCodeChars = 32;
        /// <summary>The most named worlds one module's <c>worlds</c> map may hold.</summary>
        public const int MaxWorlds = 16;
        /// <summary>Colyseus's MATCHMAKE_INVALID_ROOM_ID: no room with this id here, or it is full or closing.</summary>
        public const int RoomNotFound = 522;

        private static bool LowerOrDigit(char c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

        /// <summary>Whether <paramref name="key"/> is a match key: 1 to 32 characters of a-z 0-9 . _ : -, a letter or digit first.</summary>
        public static bool ValidMatchKey(string key)
        {
            if (string.IsNullOrEmpty(key) || key.Length > MaxMatchKeyChars) return false;
            for (var i = 0; i < key.Length; i++)
            {
                var c = key[i];
                if (LowerOrDigit(c)) continue;
                if (i == 0 || (c != '.' && c != '_' && c != ':' && c != '-')) return false;
            }
            return true;
        }

        /// <summary>Whether <paramref name="code"/> is a room code: 1 to 32 characters of A-Z a-z 0-9 _ -. A code goes into a url.</summary>
        public static bool ValidRoomCode(string code)
        {
            if (string.IsNullOrEmpty(code) || code.Length > MaxCodeChars) return false;
            foreach (var c in code)
                if (!LowerOrDigit(c) && !(c >= 'A' && c <= 'Z') && c != '_' && c != '-') return false;
            return true;
        }

        /// <summary>What a target sends. Nothing asked sends nothing new. A code names one room, whose key is its own.
        /// <paramref name="code"/> null is no code; <paramref name="matchKey"/> null or empty is no key.</summary>
        public static GenexJoinPlan Plan(string matchKey, bool createPrivate, string code)
        {
            var hasKey = !string.IsNullOrEmpty(matchKey);
            if (code != null)
            {
                if (createPrivate || hasKey) return new GenexJoinPlan { Refused = GenexTargetRefusal.Conflict };
                if (!ValidRoomCode(code)) return new GenexJoinPlan { Refused = GenexTargetRefusal.BadCode };
                return new GenexJoinPlan { Method = GenexJoinMethod.JoinById, RoomId = code };
            }
            if (hasKey && !ValidMatchKey(matchKey)) return new GenexJoinPlan { Refused = GenexTargetRefusal.BadMatchKey };
            return new GenexJoinPlan
            {
                Method = createPrivate ? GenexJoinMethod.Create : GenexJoinMethod.JoinOrCreate,
                MatchKey = hasKey ? matchKey : null,
                PrivateRoom = createPrivate,
            };
        }

        /// <summary>The region a join by code tries after refusal <paramref name="error"/>, or null when the refusal is
        /// final: only another region can hold a room this one refused as elsewhere.</summary>
        public static int? NextCodeRegion(int error, int region, int regions)
        {
            var elsewhere = error == GenexProtocol.Authority.JoinError.WrongRegion || error == RoomNotFound;
            return elsewhere && region + 1 < regions ? region + 1 : (int?)null;
        }

        /// <summary>The world a room with match key <paramref name="key"/> runs, as the sandbox picks it: the
        /// <paramref name="worlds"/> entry the key names, else <paramref name="world"/>. Call it with the module's own map
        /// and hand the result to SetWorld, so the hash is the room's.</summary>
        public static T SelectMatchWorld<T>(IReadOnlyDictionary<string, T> worlds, T world, string key) =>
            worlds != null && key != null && worlds.TryGetValue(key, out var named) ? named : world;
    }
}
