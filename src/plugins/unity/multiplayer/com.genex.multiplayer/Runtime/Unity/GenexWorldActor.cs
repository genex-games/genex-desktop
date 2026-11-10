// What a creator tells the world exporter (Editor/GenexWorldSceneWalk.cs) that it cannot read from the scene. It does nothing at
// run time. It applies to this object's colliders and to those of its children.
using UnityEngine;

namespace Genex.Multiplayer
{
    /// <summary>Marks an object for the world exporter: it moves, it is a prop, or it stays out of the server's world.</summary>
    [AddComponentMenu("Genex/World Actor")]
    public sealed class GenexWorldActor : MonoBehaviour
    {
        /// <summary>Moves or disappears at run time and nothing in the scene says so (a script does it). Named, never baked.</summary>
        public bool Movable;
        /// <summary>May be cut when a world's budget runs out, before anything that costs a player reach.</summary>
        public bool Prop;
        /// <summary>Not part of the server's world at all.</summary>
        public bool LeaveOut;
        /// <summary>Carried into the scene for your game; the fit ignores them.</summary>
        public string[] Tags;
    }
}
