"""The loop toolset Epic's MCP server lists as genex_loop.tools.GenexLoopTools."""

import json

import unreal

import toolset_registry

from genex_loop import activity, assets, capture, cpp, parts, probes, project, reference, session
from genex_loop.errors import Refused


def _answer(step, *args) -> str:
    """The step's result as JSON; a refusal becomes {error, ...}.

    Epic's own tools (BlueprintTools and the like) report a failure as a script error that
    fails the whole call, even when the caller handles it; raising mode makes them raise
    instead, so a part's Blueprint error becomes a message in this tool's answer.
    """
    try:
        with toolset_registry.tool_raising_exceptions():
            return json.dumps(step(*args), default=str)
    except Refused as refusal:
        return json.dumps(refusal.as_result(), default=str)


@unreal.uclass()
class GenexLoopTools(unreal.ToolsetDefinition):
    """Genex's editor queue: applies a part (part.json, Blueprint text, apply.py) and rolls it
    back, hot-reloads the game's C++ module, captures the play view, probes the pawns and the
    player's view for the judge, imports assets, reads the game's state and the owner's activity,
    and exports the node reference, the Python names and the project's own Blueprints its checks
    and builders use."""

    @toolset_registry.tool_call
    @staticmethod
    def apply_part(script: str, part: str) -> str:
        """Builds a part's declared Blueprints, then runs its apply.py, in one undo step; then saves.

        The part folder is <game>/unreal/parts/<part>/: part.json declares Blueprints (base,
        components, variables, functions), <Blueprint>.dsl holds each one's Blueprint text, and
        apply.py adds the rest with `unreal`, `part` and `genex` (see genex_loop.part_api). If a
        Blueprint doesn't compile, apply.py doesn't run.

        Args:
            script: Absolute path of the part's apply.py, in a folder named `part` inside `parts`.
            part: The part's name: a letter, then up to 63 letters, digits or _.

        Returns:
            JSON {ok, ms, output, blueprints: [{name, compiled, messages}], assets, actors}, or
            {ok: false, error, traceback?, output, blueprints}.
        """
        return _answer(parts.apply_part, script, part)

    @toolset_registry.tool_call
    @staticmethod
    def rollback_part(part: str) -> str:
        """Destroys the part's tagged actors, saves the level and deletes /Game/Parts/<part>.

        Then restore the project's files with git and call reload_level.

        Args:
            part: The part's name.

        Returns:
            JSON {removed, deletedFolder, ms}.
        """
        return _answer(parts.rollback_part, part)

    @toolset_registry.tool_call
    @staticmethod
    def reload_level() -> str:
        """Loads the current level again from its files, after they were restored.

        Returns:
            JSON {level, reloaded, actors, ms}.
        """
        return _answer(parts.reload_level)

    @toolset_registry.tool_call
    @staticmethod
    def save_all() -> str:
        """Saves every unsaved level and asset without asking (Genex calls it before it quits Unreal
        to add the game's C++ module). Refused during a play session.

        Returns:
            JSON {saved, dirty, ms}: dirty names the packages still unsaved.
        """
        return _answer(parts.save_all)

    @toolset_registry.tool_call
    @staticmethod
    def part_trace(part: str) -> str:
        """Reads what of a part is in the editor.

        Args:
            part: The part's name.

        Returns:
            JSON {part, actors, assets, folderExists, dirty}.
        """
        return _answer(parts.part_trace, part)

    @toolset_registry.tool_call
    @staticmethod
    def recompile_module(module: str, classes: list[str]) -> str:
        """Hot-reloads the game's C++ module: Unreal compiles it with UBT and loads it again while the
        editor stays open (Module Recompile; 10 to 20 s, it blocks), then the classes are checked.

        Copy the part's sources into <project>/Source/<module>/ first. Mac only; refused during a
        play session. A failed compile is an answer (ok false with the compiler's errors), never
        an error.

        Args:
            module: The project's C++ module, as in Source/<module>/<module>.Build.cs.
            classes: The part's classes that must load afterwards, as /Script/<module>.<class>
                names them: without the A or U prefix; at most 32, may be empty.

        Returns:
            JSON {ok, compiled, ms, missing, log}: ok when a new library of the module was built
            (compiled) and every class loads; missing lists the classes that don't load; log
            holds up to 20 error and hot reload lines the editor logged during the call.
        """
        return _answer(cpp.recompile_module, module, classes)

    @toolset_registry.tool_call
    @staticmethod
    def capture_play(name: str, width: int = 1280, height: int = 720) -> str:
        """Queues a shot of the running play session's game view, without the editor around it.

        The PNG appears in <project>/Saved/Genex/captures/<name>.png a frame or two later; wait
        for the file.

        Args:
            name: The shot's name: 1 to 64 letters, digits, _ or - (never a path).
            width: Width in pixels, 320 to 3840 (0 for 1280).
            height: Height in pixels, 240 to 2160 (0 for 720).

        Returns:
            JSON {queued, file}.
        """
        return _answer(capture.capture_play, name, width, height)

    @toolset_registry.tool_call
    @staticmethod
    def stop_play() -> str:
        """Lets go of every held input and asks the play session to end; poll play_state for the end.

        Returns:
            JSON {stopping, released}.
        """
        return _answer(session.stop_play)

    @toolset_registry.tool_call
    @staticmethod
    def play_state() -> str:
        """Says whether a play session runs.

        Returns:
            JSON {pie, world}.
        """
        return _answer(session.play_state)

    @toolset_registry.tool_call
    @staticmethod
    def game_state(part: str = '') -> str:
        """Reads the parts' actors and the player, from the play session while one runs.

        Args:
            part: One part's name, or empty for every part's actors.

        Returns:
            JSON {pie, player, actors: [{label, class, location, rotation, hidden}], more}.
        """
        return _answer(session.game_state, part)

    @toolset_registry.tool_call
    @staticmethod
    def probe_characters(part: str = '') -> str:
        """Measures the play session's pawns: the ground under each, how far its bottom and a
        character's feet are from it, its facing against where it moves, a vehicle's wheels.

        Read only (property reads and line traces); needs a running play session.

        Args:
            part: One part's name, for only its pawns (tagged GenexPart:<part>); empty for every pawn.

        Returns:
            JSON {pawns: [{label, class, kind, player, parts, location, speedCmS, verticalCmS,
            facingYaw, moveYaw, facingOffDeg, ground, aboveGround, groundZ, gapCm, feetGapCm,
            meshHidden, falling, wheels}], more}; gaps in cm, positive above the ground.
        """
        return _answer(probes.probe_characters, part)

    @toolset_registry.tool_call
    @staticmethod
    def probe_view() -> str:
        """Measures the player's view: the player's own meshes (the view target's and what is
        attached to it) against the camera's near clip plane, and the post-process that applies
        (volumes and the camera), with extreme values flagged.

        Read only; needs a running play session.

        Returns:
            JSON {camera: {location, rotation, fov, nearClipCm, nearClipFrom, viewTarget, component},
            meshes: [{actor, component, kind, firstPerson, inView, nearestCm, inside, clipping}],
            moreMeshes, postProcess: {sources, defaults, extreme: [{source, name, setting, value, fine}]}}.
        """
        return _answer(probes.probe_view)

    @toolset_registry.tool_call
    @staticmethod
    def import_asset(file: str, dest: str, name: str, kind: str, skeleton: str = '', replace: bool = True) -> str:
        """Imports a model, animation, sound or texture file into the project.

        Args:
            file: Absolute path of the file: .glb .gltf .fbx .obj for meshes, .glb .gltf .fbx
                for animations, .wav for sounds, .png .jpg .jpeg .tga for textures.
            dest: The /Game/ folder to import into, such as /Game/Parts/Lantern/Meshes.
            name: The asset's name: a letter, then up to 63 letters, digits or _.
            kind: static_mesh, skeletal_mesh, animation, sound or texture.
            skeleton: For an animation, the existing Skeleton asset it plays on.
            replace: Replace an existing asset of that name in place.

        Returns:
            JSON {ms, count, assets: [{path, class, triangles?, boundsCm?, size?, seconds?}]},
            or for an animation {pending, dest}: poll list_assets(dest) until it lands.
        """
        return _answer(assets.import_asset, file, dest, name, kind, skeleton, replace)

    @toolset_registry.tool_call
    @staticmethod
    def list_assets(path: str) -> str:
        """Lists the assets under a /Game/ folder with their class.

        Args:
            path: The /Game/ folder.

        Returns:
            JSON {path, assets: [{path, class}], more}.
        """
        return _answer(assets.list_assets, path)

    @toolset_registry.tool_call
    @staticmethod
    def editor_activity() -> str:
        """Reads what the owner can change at the editor, cheaply, to tell when they're working.

        Returns:
            JSON {camera: [x, y, z, pitch, yaw], selection, dirty, pie}.
        """
        return _answer(activity.editor_activity)

    @toolset_registry.tool_call
    @staticmethod
    def export_reference(file: str, pins: str = '') -> str:
        """Writes the Blueprint node reference Genex checks Blueprint text against.

        Every node type id for 10 base classes x (event graph, function graph), and the pins of
        the nodes asked for (about 0.1 s each). Leaves nothing in Content.

        Args:
            file: Absolute path of the JSON file, inside <project>/Saved/Genex/.
            pins: Optional JSON {"Actor/EventGraph": ["type id", ...]}: the nodes whose pins to read.

        Returns:
            JSON {file, engine, common, contexts, pins, failed, ms}.
        """
        return _answer(reference.export_reference, file, pins)

    @toolset_registry.tool_call
    @staticmethod
    def export_python_names(file: str) -> str:
        """Writes the unreal module's names (classes with their members) for Genex's Python check.

        Args:
            file: Absolute path of the JSON file, inside <project>/Saved/Genex/.

        Returns:
            JSON {file, names, classes, ms}.
        """
        return _answer(reference.export_python_names, file)

    @toolset_registry.tool_call
    @staticmethod
    def export_project(file: str) -> str:
        """Writes what the game's template is made of, for builders who never open the editor.

        The level, the game mode (the level's GameMode Override, else the project's default) and
        the pawn it spawns, the project's own Blueprints under /Game (not /Game/Parts) with their
        native parent, components and member variables, and the input actions.

        Args:
            file: Absolute path of the JSON file, inside <project>/Saved/Genex/.

        Returns:
            JSON {file, blueprints, more, inputActions, ms}. The file holds {map, gameMode: {path,
            parent, defaultPawn} or null, blueprints: [{name, path, parent, components: [{name,
            class}], variables: [{name, type}]}] (at most 200, by path), more, inputActions}.
        """
        return _answer(project.export_project, file)
