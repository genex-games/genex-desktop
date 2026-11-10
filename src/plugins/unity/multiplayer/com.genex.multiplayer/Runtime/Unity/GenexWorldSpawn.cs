// Where a player starts, for the world exporter (Editor/GenexWorldSceneWalk.cs): a fit floods what a hull can reach from here.
// The built-in Respawn tag counts too. It does nothing at run time.
using UnityEngine;

namespace Genex.Multiplayer
{
    /// <summary>A player's feet start at this object's position. A level with none cannot be fitted.</summary>
    [AddComponentMenu("Genex/World Spawn")]
    public sealed class GenexWorldSpawn : MonoBehaviour
    {
        /// <summary>Carried into the scene for your game, a team's name for one.</summary>
        public string[] Tags;
    }
}
