"""The build toolset Epic's MCP server lists as genex_build.tools.GenexBuildTools."""

import json

import unreal

import toolset_registry

from genex_build import (
    args,
    audit,
    character,
    imports,
    material,
    models,
    motion,
    retarget,
    routes,
    scripts,
    shots,
    sockets,
    terrain,
)
from genex_loop.errors import Refused, short_message


def _answer(step, *args) -> str:
    """The step's answer as JSON; a refusal or an editor error becomes {error, ...}, never an exception."""
    try:
        with toolset_registry.tool_raising_exceptions():
            return json.dumps(step(*args), default=str)
    except Refused as refusal:
        return json.dumps({'error': refusal.message, **refusal.fields}, default=str)
    except Exception as error:  # noqa: BLE001 - Epic's and Geometry Script's calls raise RuntimeError and others
        return json.dumps({'error': short_message(error)})


@unreal.uclass()
class GenexBuildTools(unreal.ToolsetDefinition):
    """Builds the game in the open editor. run_script runs one of the game's build scripts
    (unreal/build/<file>.py) with the full unreal module and the gx library (scopes that make a
    script idempotent, kit pieces, instancing, world-aligned materials, atmosphere presets, lights,
    hero cameras), in one undo step: keep every system's geometry and materials in such a script and
    run it again after each change. capture_shot, capture_play and motion_strip are the eyes: clean
    frames of the game (never the editor), each answered as an image with its tone numbers.
    Imports bring the game's own model, character, animation and sound files in; retarget plays
    one skeleton's clips on another; motion_character moves a character with the Game Animation
    Sample's Motion Matching; character_check measures and pictures a character standing and
    walking; attach_to_socket puts a mesh in a hand; audit counts what the level is made of. Compound arguments are JSON text. Every tool answers JSON; a refusal is
    {error} and changes nothing. Stop play first, except for capture_play and motion_strip.

    Writing your own Python against the editor: a function with out-params answers a tuple
    (its result and each out-param), so pick the value you want by its type, not its position.
    """

    @toolset_registry.tool_call
    @staticmethod
    def set_route(points: str = '', seed: int = 0, closed: bool = True, length_m: float = 200.0) -> str:
        """Sets the route the player drives: a spline tagged GenexRoute (and genex:route), with the
        level's PlayerStart moved onto its first point facing its second. Calling it again moves
        the same route. The play checks and the drive follow it, and track_terrain builds along it.

        Args:
            points: JSON [[x, y, z], ...] in cm, 2 to 1024 points; empty for a route from the seed.
            seed: Shapes a route made from it: a rounded loop when closed, a swaying road when not.
            closed: Whether the route loops back to its first point.
            length_m: A seed route's length in metres, 20 to 3000.

        Returns:
            JSON {route, points, lengthM, closed, playerStart: {location, yaw}}, or {error}.
        """
        return _answer(routes.set_route, points, seed, closed, length_m)

    @toolset_registry.tool_call
    @staticmethod
    def track_terrain(seed: int, length_m: float, width_m: float, whoops: int, jumps: int) -> str:
        """Builds the ground along the route: the track a shallow groove in flat ground, whoops in
        rows, tabletop jumps (2.5 m, each after a 25 m run-up, on the straightest parts) and
        berms on the outside of the turns; a static mesh with complex-as-simple collision on an
        actor tagged genex:terrain. Without a route it lays a straight one of length_m first.
        Calling it again replaces the terrain's mesh. Takes about 10 s.

        Args:
            seed: Places the whoops and jumps.
            length_m: The straight route's length when the level has none (20 to 3000).
            width_m: The track's width in metres, 4 to 60.
            whoops: How many whoops, 0 to 40, in rows of up to 6.
            jumps: How many tabletop jumps, 0 to 6.

        Returns:
            JSON {mesh, actor, vertices, lengthM, widthM, ms}, or {error} (also when the features
            don't fit the route: it names the lengths).
        """
        return _answer(terrain.track_terrain, seed, length_m, width_m, whoops, jumps)

    @toolset_registry.tool_call
    @staticmethod
    def dirt_material(name: str, palette: str = '') -> str:
        """Makes the material /Game/Genex/Materials/M_<name>: world-space noise blending a dark and
        a light dirt colour, rough. Making one of the same name again rebuilds it. Takes about 8 s.

        Args:
            name: A letter, then up to 63 letters, digits or _ (Dirt makes M_Dirt).
            palette: JSON {"dark": [r, g, b], "light": [r, g, b]} (0 to 1); empty for grey-brown packed dirt.

        Returns:
            JSON {material, ms}, or {error}.
        """
        return _answer(material.dirt_material, name, palette)

    @toolset_registry.tool_call
    @staticmethod
    def run_script(file: str, args_json: str) -> str:
        """Runs a build script of the game: unreal/build/<file> (a .py of at most 256 KB) with
        `unreal`, `gx` (read genex_build.gx's notes: scopes, spawn_mesh, instances, kit_module,
        world_material, atmosphere, local_fog, light, shot_camera, attach_to_socket, imports,
        audit) and `args`, in one undo step, for at most 240 s. The script runs in a scope named
        after it, so running it again first removes what it made last time. Its own modules in
        unreal/build/ import fresh each run. An MCP timeout does not stop a running script. A run
        that changed a level with navigation bounds rebuilds its nav mesh (navigation: rebuilt). A
        material Unreal fails to compile while it runs fails the run (Unreal would draw it with its
        default material): materials names each one and why.

        Args:
            file: The script, relative to unreal/build/: kit.py or zones/shaft.py.
            args_json: A JSON object the script reads as `args`, or empty.

        Returns:
            JSON {ok, ms, script, output, result?, scopes: {scope: {removed, made}}, navigation?, actors,
            otherMaterials?}; when it failed also {error, where: "file.py:line", line} or {error, materials:
            [{material, instanceOf?, platform, reasons}]} for materials it changed that Unreal failed to compile
            (otherMaterials: ones it didn't change that failed meanwhile). What it changed before failing stays.
        """
        return _answer(scripts.run_script, file, args_json)

    @toolset_registry.tool_call
    @staticmethod
    def shot_cameras() -> str:
        """The level's hero cameras (CameraActors labelled GX_Shot_<name>, made with
        gx.shot_camera), by label. Changes nothing.

        Returns:
            JSON {cameras: [label]}, sorted.
        """
        return _answer(shots.shot_cameras)

    @toolset_registry.tool_call
    @staticmethod
    def capture_shot(camera: str, width: int, height: int, delay_s: float) -> str:
        """A still from a hero camera (a CameraActor labelled GX_Shot_<name>, made with
        gx.shot_camera) in the editor world, no play session needed: the frame a player would see
        from there, without the editor around it. delay_s lets Lumen and the fog settle first
        (2 to 4 s for a judged frame). The image and its tone numbers come back with the answer.

        Args:
            camera: The camera's name (Hero for GX_Shot_Hero) or label; empty for the first hero camera.
            width: Width in pixels, 320 to 3840 (0 with height 0 for 1280x720).
            height: Height in pixels, 240 to 2160.
            delay_s: Seconds to let the frame settle, 0 to 15.

        Returns:
            JSON {queued, file, camera, width, height, delayS}, or {error} (no such camera: it names
            the hero cameras; during play: use capture_play).
        """
        return _answer(shots.capture_shot, camera, width, height, delay_s)

    @toolset_registry.tool_call
    @staticmethod
    def capture_play(name: str, width: int, height: int) -> str:
        """A shot of the 3D frame the player sees during a play session (StartPIE first), without the
        editor around it and without on-screen UI (the HUD and screen-space bars are not in it). The
        image, its tone numbers and the frame rate come back with the answer.

        Args:
            name: The shot's name: 1 to 64 letters, digits, _ or - (never a path).
            width: Width in pixels, 320 to 3840 (0 with height 0 for 1280x720).
            height: Height in pixels, 240 to 2160.

        Returns:
            JSON {queued, file, gameSeconds, fps, pawn, pawnYaw, view, viewYawPitch}, or {error}.
        """
        return _answer(shots.capture_play, name, width, height)

    @toolset_registry.tool_call
    @staticmethod
    def motion_strip(frames: int, interval_s: float) -> str:
        """Frames of the 3D view the player sees during a play session (no on-screen UI),
        interval_s GAME seconds apart, each with where the pawn and the view were when it was taken. Start the motion first
        (hold an input with genex_play's hold), then call this. The frames come back as one
        contact sheet with each frame's pose, how much it differs from the one before, and tone.

        Args:
            frames: How many frames, 2 to 12.
            interval_s: Game seconds between frames, 0.1 to 5.

        Returns:
            JSON {strip, files, poses, width, height, intervalS, waitS}, or {error}.
        """
        return _answer(shots.motion_strip, frames, interval_s)

    @toolset_registry.tool_call
    @staticmethod
    def import_model(file: str, dest: str, name: str, collision: str, nanite: bool) -> str:
        """Imports a model file of the game's assets as ONE static mesh (its pieces combined), into
        its own folder <dest>/<name>/, never opening the Content Browser. Importing the same file into
        the same folder again answers the first import (reused: true); another file there is refused:
        use a new name.

        Args:
            file: The model (.glb .gltf .fbx .obj, at most 100 MB) in the game folder's assets/ or
                public/assets/, relative to the game folder (assets/blender/<job>/model.glb).
            dest: The /Game/ folder for the model's folder, such as /Game/Models.
            name: The model's folder name: a letter, then up to 63 letters, digits or _.
            collision: box (simple boxes: props), convex (hulls: odd shapes), complex (its own
                triangles: walkable ramps and terrain), or none.
            nanite: True for heavy meshes (thousands of triangles and up).

        Returns:
            JSON {asset, folder, sourceTriangles (the file's own count), naniteTriangles,
            fallbackTriangles, boundsCm, collision, nanite, meshes, ms}; asset is the real path
            Unreal gave it (use it as is, dashes and all).
        """
        return _answer(imports.import_model, file, dest, name, collision, nanite)

    @toolset_registry.tool_call
    @staticmethod
    def import_character(file: str, dest: str, name: str) -> str:
        """Imports a rigged character (a skinned .glb, .gltf or .fbx of the game's assets): its
        skeletal mesh, skeleton, physics asset and any clips in the file, into <dest>/<name>/.
        Refused during a play session (an import then makes only part of the asset). A .glb whose
        skeleton hangs under a scaled root (a centimetre Armature at 0.01) is imported from a copy
        with that scale baked in (skeletonScale); one it can't bake comes back with scaleWarning.
        Run character_check before the character goes into the game.

        Args:
            file: The model file, relative to the game folder (assets/agents/<id>/hero.glb).
            dest: The /Game/ folder for its folder, such as /Game/Characters.
            name: Its folder name: a letter, then up to 63 letters, digits or _.

        Returns:
            JSON {mesh, skeleton, physicsAsset, boundsCm, animations: [{path, seconds}], folder,
            skeletonScale?: {baked, file}, scaleWarning?, reused?, ms}.
        """
        return _answer(imports.import_character, file, dest, name)

    @toolset_registry.tool_call
    @staticmethod
    def import_animation(file: str, skeleton: str, dest: str, name: str) -> str:
        """Imports the clips of a .glb, .gltf or .fbx of the game's assets onto an existing skeleton.

        Args:
            file: The file, relative to the game folder.
            skeleton: The Skeleton asset's /Game/ path (import_character answers it).
            dest: The /Game/ folder for its folder.
            name: Its folder name: a letter, then up to 63 letters, digits or _.

        Returns:
            JSON {animations: [{path, seconds}], skeleton, folder, ms}.
        """
        return _answer(imports.import_animation, file, skeleton, dest, name)

    @toolset_registry.tool_call
    @staticmethod
    def import_sound(file: str, dest: str, name: str) -> str:
        """Imports a .wav, .mp3, .ogg or .flac of the game's assets as a sound wave.

        Args:
            file: The sound file, relative to the game folder (assets/sfx/hit.mp3).
            dest: The /Game/ folder for its folder, such as /Game/Sounds.
            name: Its folder name: a letter, then up to 63 letters, digits or _.

        Returns:
            JSON {asset, seconds, folder, ms}.
        """
        return _answer(imports.import_sound, file, dest, name)

    @toolset_registry.tool_call
    @staticmethod
    def retarget(source_mesh: str, target_mesh: str, animations: str, dest: str) -> str:
        """Copies clips made for one skeletal mesh onto another (the template mannequin's onto an
        imported character): IK Rigs by Unreal's auto-characterisation with full-body IK and the
        whole spine, a retargeter with the default ops (arms and legs copied bone for bone, IK on
        the legs only), chains mapped by name, the retarget pose aligned and its arms turned to the
        source's, then a batch retarget into dest. Retarget only the clips this character plays,
        never a whole library.

        Args:
            source_mesh: The SkeletalMesh the clips were made for (/Game/...).
            target_mesh: The SkeletalMesh to play them.
            animations: JSON list of 1 to 64 AnimSequence or AnimMontage paths.
            dest: The /Game/ folder for the new clips.

        Returns:
            JSON {animations, retargeter, fbik: {source, target}, spineFrom, oneToOne, ikOff,
            armFixDeg: {bone: [before, after]}, fingersAligned, limbErrorDeg (the first new clip's
            limbs against its source clip's), warnings, ms}, or {error} (a skeleton Unreal can't
            characterise is named).
        """
        return _answer(lambda: retarget.retarget(source_mesh, target_mesh, args.json_list(animations, 'animations'), dest))

    @toolset_registry.tool_call
    @staticmethod
    def motion_character(mesh: str, name: str) -> str:
        """Gives an imported character the Game Animation Sample's Motion Matching, the sample's own
        way: the sample's character runs it on a hidden mannequin and the character's mesh copies
        that pose live. Makes the retargeter from the mannequin (as retarget sets one up), its
        entry in the sample's ABP_GenericRetarget, and BP_<name>, a child of the sample's
        SandboxCharacter_CMC showing the character. No clip is copied. Needs the sample's content in
        the project (the Unreal plugin's add-motion-matching); refused during play.

        Args:
            mesh: The character's SkeletalMesh (/Game/...), from import_character; a rig with finger
                bones gets moving fingers.
            name: Its Blueprint's name: a letter, then up to 47 letters, digits or _.

        Returns:
            JSON {blueprint, retargeter, tag, fbik, spineFrom, oneToOne, ikOff, armFixDeg,
            fingersAligned, next, ms}, or {error}.
        """
        return _answer(motion.motion_character, mesh, name)

    @toolset_registry.tool_call
    @staticmethod
    def character_check(mesh: str, idle: str, walk: str, driver: str, pictures: bool) -> str:
        """Checks a rigged character standing and walking, before it goes into the game: samples
        its idle and walk clips (no play session) and answers passed, the reasons it failed and
        the numbers: each upper arm's angle out from the body, each hand's distance from its
        thigh, the skeleton's width against the character's height, how far the feet float or
        sink, the most any mesh edge stretches against the bind pose (a strip of cloth weighted to
        the wrong bone), finger bones and whether they move, and, with a driver, each limb's
        angle from the driver's at the same frame. With pictures, a copy of it is shot from the
        front, side and back in idle and from the side through the walk, as one sheet.

        Args:
            mesh: The SkeletalMesh's /Game/ path, or a level actor's label.
            idle: Its idle AnimSequence, or empty to check its reference pose.
            walk: Its walk AnimSequence, or empty.
            driver: JSON {"mesh": path, "idle": path, "walk": path} of the skeleton a runtime
                retarget copies (the hidden mannequin), or empty.
            pictures: Whether to take the picture sheet (about 20 s more).

        Returns:
            JSON {passed, reasons, warnings, notes, heightCm, clips: {idle, walk}, stretch, fingers,
            limbErrorDeg?, thresholds, bones, pictures?: {record, files}, ms}, or {error}.
        """
        return _answer(character.character_check, mesh, idle, walk, driver, pictures)

    @toolset_registry.tool_call
    @staticmethod
    def attach_to_socket(target: str, mesh: str, socket: str, offset: str) -> str:
        """Puts a static mesh in a skeletal mesh's socket or bone (a sword in hand_r or HandGrip_R).
        On a Blueprint (a /Game/ path) every spawned character carries it: the component
        Gx<mesh> under its skeletal mesh, attached by its construction script; the Blueprint is
        compiled and saved. On a level actor (its label) the mesh's actor is attached there.

        Args:
            target: The Blueprint's /Game/ path, or a level actor's label.
            mesh: The StaticMesh's /Game/ path.
            socket: The socket or bone name.
            offset: JSON {"location": [x, y, z], "rotation": [pitch, yaw, roll], "scale": [x, y, z]}
                relative to the socket, each optional; empty for none.

        Returns:
            JSON {blueprint, component, parent, socket, compiled, saved} or {actor, held, socket}.
        """
        return _answer(lambda: sockets.attach_to_socket(target, mesh, socket, args.json_object(offset, 'offset')))

    @toolset_registry.tool_call
    @staticmethod
    def audit(camera: str) -> str:
        """Counts what the level is made of: actors, mesh components, instances, an estimate of the
        triangles drawn, the heaviest meshes, and primitives (/Engine/BasicShapes, blockout only);
        with a camera, the primitives in its view.

        Args:
            camera: A hero camera's name or label, or empty.

        Returns:
            JSON {actors, meshComponents, instances, triangles, primitives, heaviest,
            primitiveActors, camera?, primitivesInView?}.
        """
        return _answer(audit.audit, camera)

    @toolset_registry.tool_call
    @staticmethod
    def attach_mesh(blueprint: str, mesh: str, parent: str = '', offset: str = '') -> str:
        """Puts a static mesh on a Blueprint as the component Genex_<mesh name>, under a component
        (the first-person camera, for a bike's front), then compiles and saves the Blueprint.
        Attaching the same mesh again reuses its component and sets its offset.

        Args:
            blueprint: The Blueprint asset's /Game/ path.
            mesh: The StaticMesh asset's /Game/ path.
            parent: The component to attach under; empty for the root.
            offset: JSON {"location": [x, y, z] cm, "rotation": [pitch, yaw, roll], "scale": [x, y, z]},
                each optional; empty for none.

        Returns:
            JSON {component, parent, compiled, saved}, or {error}.
        """
        return _answer(models.attach_mesh, blueprint, mesh, parent, offset)
