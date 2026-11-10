// Reads the open scenes' colliders into WorldSceneExport.cs's rows. It decides nothing about the file: disabled colliders,
// triggers and bad transforms are all read as they are and judged there, where GenexSmoke holds the rules with no licence.
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Genex.Multiplayer.WorldExport
{
    /// <summary>How the walk reads layers. Left alone, Unity's own settings decide: the layer collision matrix for hulls, the
    /// default raycast layers for bullets.</summary>
    public sealed class WorldWalkOptions
    {
        /// <summary>The layer your character is on: a collider stops a hull when the matrix lets the two collide.</summary>
        public int CharacterLayer;
        /// <summary>The layers a bullet's trace hits.</summary>
        public int ShotMask = Physics.DefaultRaycastLayers;
        /// <summary>Per layer, what it stops, over whatever the settings say: the `Clip:move` of the batch's -genexLayerChannels.</summary>
        public readonly Dictionary<int, (bool Move, bool Shot)> LayerChannels = new Dictionary<int, (bool, bool)>();
    }

    /// <summary>What the walk read, and what it could not take as a collider.</summary>
    public sealed class WorldWalkResult
    {
        public readonly List<WorldCollider> Colliders = new List<WorldCollider>();
        public readonly List<WorldSpawnPoint> Spawns = new List<WorldSpawnPoint>();
        public readonly List<WorldWarning> Warnings = new List<WorldWarning>();
        /// <summary>Which object each actor id stands for. Our own count: Unity's instance id changed its API between versions.</summary>
        internal readonly Dictionary<Transform, long> ObjectIds = new Dictionary<Transform, long>();

        internal long IdOf(Transform t)
        {
            if (!ObjectIds.TryGetValue(t, out var id))
            {
                id = ObjectIds.Count + 1;
                ObjectIds[t] = id;
            }
            return id;
        }
    }

    /// <summary>The walk over a scene's game objects.</summary>
    public static class GenexWorldSceneWalk
    {
        private const string RespawnTag = "Respawn";
        private const string UntaggedTag = "Untagged";
        private const string PropTag = "prop";

        /// <summary>Every game object's colliders and spawns in these scenes, inactive ones too, in hierarchy order.</summary>
        public static WorldWalkResult Read(IEnumerable<Scene> scenes, WorldWalkOptions options)
        {
            var result = new WorldWalkResult();
            foreach (var scene in scenes)
            {
                foreach (var root in scene.GetRootGameObjects()) ReadRoot(root, options, result);
            }
            return result;
        }

        private static void ReadRoot(GameObject root, WorldWalkOptions options, WorldWalkResult result)
        {
            foreach (var collider in root.GetComponentsInChildren<Collider>(true)) ReadCollider(collider, options, result);
            foreach (var terrain in root.GetComponentsInChildren<Terrain>(true))
            {
                if (terrain.GetComponent<TerrainCollider>() == null)
                {
                    result.Warnings.Add(new WorldWarning(WorldWarningCode.NotRead, PathOf(terrain.transform), "this Terrain has no TerrainCollider, so nothing stands on it"));
                }
            }
            foreach (var other in root.GetComponentsInChildren<Collider2D>(true))
            {
                result.Warnings.Add(new WorldWarning(WorldWarningCode.NotRead, PathOf(other.transform), "2D colliders are not read: a room's world is 3D"));
            }
            foreach (var t in root.GetComponentsInChildren<Transform>(true)) ReadSpawn(t, result);
        }

        private static void ReadSpawn(Transform t, WorldWalkResult result)
        {
            var mark = t.GetComponent<GenexWorldSpawn>();
            if (mark == null && !t.CompareTag(RespawnTag)) return;
            if (!t.gameObject.activeInHierarchy) return;
            result.Spawns.Add(new WorldSpawnPoint { Name = PathOf(t), Tags = mark != null && mark.Tags != null ? mark.Tags : new string[0], At = V3(t.position) });
        }

        private static void ReadCollider(Collider c, WorldWalkOptions options, WorldWalkResult result)
        {
            var row = Common(c, options, result);
            switch (c)
            {
                case BoxCollider box:
                    row.Kind = WorldColliderKind.Box;
                    ReadPose(row, c.transform);
                    row.Center = V3(box.center);
                    row.Size = V3(box.size);
                    break;
                case SphereCollider sphere:
                    row.Kind = WorldColliderKind.Sphere;
                    ReadPose(row, c.transform);
                    row.Center = V3(sphere.center);
                    row.Radius = sphere.radius;
                    break;
                case CapsuleCollider capsule:
                    ReadCapsule(row, capsule.center, capsule.radius, capsule.height, capsule.direction);
                    ReadPose(row, c.transform);
                    break;
                case CharacterController controller:
                    ReadCapsule(row, controller.center, controller.radius, controller.height, 1);
                    ReadPose(row, c.transform);
                    break;
                case MeshCollider mesh:
                    ReadMesh(row, mesh);
                    ReadPose(row, c.transform);
                    break;
                case TerrainCollider terrain:
                    ReadTerrain(row, terrain, options, result);
                    if (row.Heights.Length == 0) return;
                    break;
                default:
                    result.Warnings.Add(new WorldWarning(WorldWarningCode.NotRead, row.Actor, "a " + c.GetType().Name + " is not a shape the exporter knows: left out"));
                    return;
            }
            result.Colliders.Add(row);
        }

        private static WorldCollider Common(Collider c, WorldWalkOptions options, WorldWalkResult result)
        {
            var go = c.gameObject;
            var mark = c.GetComponentInParent<GenexWorldActor>(true);
            var layer = go.layer;
            var (move, shot) = Channels(c, layer, options);
            var body = c.GetComponentInParent<Rigidbody>(true);
            var articulated = c.GetComponentInParent<ArticulationBody>(true);
            var grouped = body != null ? body.transform : articulated != null ? articulated.transform : c.transform;
            var row = new WorldCollider
            {
                Actor = PathOf(grouped),
                Object = result.IdOf(grouped),
                Enabled = c.enabled,
                Active = go.activeInHierarchy,
                Trigger = c.isTrigger,
                MovingBecause = MovingBecause(c, mark, body, articulated),
                MayMoveBecause = MayMoveBecause(c),
                Prop = (mark != null && mark.Prop) || string.Equals(go.tag, PropTag, System.StringComparison.OrdinalIgnoreCase),
                Tags = TagsOf(go, mark),
                Move = move && (mark == null || !mark.LeaveOut),
                Shot = shot && (mark == null || !mark.LeaveOut),
            };
            return row;
        }

        private static string[] TagsOf(GameObject go, GenexWorldActor mark)
        {
            var tags = new List<string>();
            if (go.tag != UntaggedTag && go.tag != RespawnTag && !string.Equals(go.tag, PropTag, System.StringComparison.OrdinalIgnoreCase)) tags.Add(go.tag);
            if (mark != null && mark.Tags != null) tags.AddRange(mark.Tags);
            return tags.ToArray();
        }

        private static (bool Move, bool Shot) Channels(Collider c, int layer, WorldWalkOptions options)
        {
            if (options.LayerChannels.TryGetValue(layer, out var named)) return named;
            var move = !Physics.GetIgnoreLayerCollision(options.CharacterLayer, layer);
            var shot = (options.ShotMask & (1 << layer)) != 0;
#if UNITY_2022_2_OR_NEWER
            var character = 1 << options.CharacterLayer;
            if ((c.excludeLayers.value & character) != 0) move = false;
            if ((c.includeLayers.value & character) != 0) move = true;
#endif
            return (move, shot);
        }

        private static string MovingBecause(Collider c, GenexWorldActor mark, Rigidbody body, ArticulationBody articulated)
        {
            if (mark != null && mark.Movable) return "marked Movable on " + PathOf(mark.transform);
            if (c is CharacterController) return "CharacterController";
            if (body != null) return "Rigidbody on " + PathOf(body.transform);
            if (articulated != null) return "ArticulationBody on " + PathOf(articulated.transform);
            for (var t = c.transform; t != null; t = t.parent)
            {
                var animator = t.GetComponent<Animator>();
                if (animator != null && animator.runtimeAnimatorController != null) return "Animator on " + PathOf(t);
                var animation = t.GetComponent<Animation>();
                if (animation != null && animation.clip != null) return "Animation on " + PathOf(t);
                if (t.GetComponent("PlayableDirector") != null) return "PlayableDirector on " + PathOf(t);
            }
            return null;
        }

        /// <summary>A script on an object nobody marked Static may move it; only the creator can say.</summary>
        private static string MayMoveBecause(Collider c)
        {
            if (GameObjectUtility.GetStaticEditorFlags(c.gameObject) != 0) return null;
            return ScriptOn(c.transform) ?? (c.transform.parent != null ? ScriptOn(c.transform.parent) : null);
        }

        private static string ScriptOn(Transform t)
        {
            foreach (var script in t.GetComponents<MonoBehaviour>())
            {
                if (script == null || script is GenexWorldActor || script is GenexWorldSpawn) continue;
                return "the script " + script.GetType().Name + " on " + t.name;
            }
            return null;
        }

        private static void ReadPose(WorldCollider row, Transform t)
        {
            row.Position = V3(t.position);
            var q = t.rotation;
            row.Rotation = new WorldQ(q.x, q.y, q.z, q.w);
            row.Scale = V3(t.lossyScale);
            row.Matrix = Rows(t.localToWorldMatrix);
        }

        private static void ReadCapsule(WorldCollider row, Vector3 center, float radius, float height, int direction)
        {
            row.Kind = WorldColliderKind.Capsule;
            row.Center = V3(center);
            row.Radius = radius;
            row.Height = height;
            row.Direction = direction;
        }

        private static void ReadMesh(WorldCollider row, MeshCollider c)
        {
            row.Kind = WorldColliderKind.Mesh;
            row.Convex = c.convex;
            var mesh = c.sharedMesh;
            if (mesh == null) return;
            row.MeshName = mesh.name;
            row.Readable = mesh.isReadable || CanReadInEditor(mesh);
            if (!row.Readable) return;
            var vertices = mesh.vertices;
            row.Vertices = new float[vertices.Length * 3];
            for (var i = 0; i < vertices.Length; i++)
            {
                row.Vertices[3 * i] = vertices[i].x;
                row.Vertices[3 * i + 1] = vertices[i].y;
                row.Vertices[3 * i + 2] = vertices[i].z;
            }
            row.Indices = mesh.triangles;
        }

        /// <summary>An imported model whose Read/Write is off still answers in the editor, as Unity's own cooking reads it there.
        /// One that gave up its data (a run-time mesh with <c>UploadMeshData(true)</c>) does not.</summary>
        private static bool CanReadInEditor(Mesh mesh)
        {
            var vertices = mesh.vertexCount > 0 ? mesh.vertices : new Vector3[0];
            return vertices.Length > 0 && vertices.Length == mesh.vertexCount && AssetDatabase.Contains(mesh);
        }

        private static void ReadTerrain(WorldCollider row, TerrainCollider c, WorldWalkOptions options, WorldWalkResult result)
        {
            row.Kind = WorldColliderKind.Terrain;
            row.Position = V3(c.transform.position);
            var data = c.terrainData;
            if (data == null)
            {
                result.Warnings.Add(new WorldWarning(WorldWarningCode.NotRead, row.Actor, "its TerrainCollider has no Terrain Data, so nothing stands on it"));
                return;
            }
            var resolution = data.heightmapResolution;
            var size = data.size;
            row.Cols = resolution;
            row.Rows = resolution;
            row.CellX = size.x / (resolution - 1);
            row.CellZ = size.z / (resolution - 1);
            var heights = data.GetHeights(0, 0, resolution, resolution);
            row.Heights = new float[resolution * resolution];
            for (var z = 0; z < resolution; z++)
            {
                for (var x = 0; x < resolution; x++) row.Heights[z * resolution + x] = heights[z, x] * size.y;
            }
            row.HoleCells = HoleCells(data, resolution - 1);
            if (c.enabled && c.gameObject.activeInHierarchy && TreesCollide(c)) ReadTrees(c, data, options, result);
        }

        /// <summary>The inspector's Enable Tree Colliders, which no script API reads on every version this package supports.</summary>
        private static bool TreesCollide(TerrainCollider c)
        {
            var property = new SerializedObject(c).FindProperty("m_EnableTreeColliders");
            return property == null || property.boolValue;
        }

        private static bool[] HoleCells(TerrainData data, int cells)
        {
            var solid = data.GetHoles(0, 0, cells, cells);
            bool[] holes = null;
            for (var z = 0; z < cells; z++)
            {
                for (var x = 0; x < cells; x++)
                {
                    if (solid[z, x]) continue;
                    holes = holes ?? new bool[cells * cells];
                    holes[z * cells + x] = true;
                }
            }
            return holes;
        }

        /// <summary>A terrain's tree colliders stop a character as any collider does, and no game object holds them.</summary>
        private static void ReadTrees(TerrainCollider c, TerrainData data, WorldWalkOptions options, WorldWalkResult result)
        {
            var origin = c.transform.position;
            var size = data.size;
            var prototypes = data.treePrototypes;
            var instances = data.treeInstances;
            var parent = PathOf(c.transform);
            for (var i = 0; i < instances.Length; i++)
            {
                var tree = instances[i];
                var prefab = prototypes[tree.prototypeIndex].prefab;
                if (prefab == null) continue;
                var at = origin + Vector3.Scale(tree.position, size);
                var turn = Quaternion.AngleAxis(tree.rotation * Mathf.Rad2Deg, Vector3.up);
                var place = Matrix4x4.TRS(at, turn, new Vector3(tree.widthScale, tree.heightScale, tree.widthScale));
                foreach (var collider in prefab.GetComponentsInChildren<Collider>(true))
                {
                    var relative = prefab.transform.worldToLocalMatrix * collider.transform.localToWorldMatrix;
                    var row = TreeRow(collider, place * relative, parent + "/" + prefab.name + " " + i, options);
                    if (row != null) result.Colliders.Add(row);
                }
            }
        }

        private static WorldCollider TreeRow(Collider c, Matrix4x4 m, string name, WorldWalkOptions options)
        {
            var (move, shot) = Channels(c, c.gameObject.layer, options);
            var row = new WorldCollider { Actor = name, Move = move, Shot = shot, Enabled = c.enabled, Trigger = c.isTrigger };
            switch (c)
            {
                case BoxCollider box:
                    row.Kind = WorldColliderKind.Box;
                    row.Center = V3(box.center);
                    row.Size = V3(box.size);
                    break;
                case SphereCollider sphere:
                    row.Kind = WorldColliderKind.Sphere;
                    row.Center = V3(sphere.center);
                    row.Radius = sphere.radius;
                    break;
                case CapsuleCollider capsule:
                    ReadCapsule(row, capsule.center, capsule.radius, capsule.height, capsule.direction);
                    break;
                default:
                    return null;
            }
            var q = m.rotation;
            row.Position = V3(m.GetColumn(3));
            row.Rotation = new WorldQ(q.x, q.y, q.z, q.w);
            row.Scale = V3(m.lossyScale);
            return row;
        }

        private static double[] Rows(Matrix4x4 m)
        {
            var rows = new double[16];
            for (var i = 0; i < 16; i++) rows[i] = m[i / 4, i % 4];
            return rows;
        }

        private static WorldV3 V3(Vector3 v) => new WorldV3(v.x, v.y, v.z);

        /// <summary>The hierarchy path: what a creator finds a thing by, and the name in every refusal.</summary>
        public static string PathOf(Transform t)
        {
            var path = t.name;
            for (var p = t.parent; p != null; p = p.parent) path = p.name + "/" + path;
            return path;
        }
    }
}
