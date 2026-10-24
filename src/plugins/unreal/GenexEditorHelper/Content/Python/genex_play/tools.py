"""The play toolset Epic's MCP server lists as genex_play.tools.GenexPlayTools."""

import json

import unreal

import toolset_registry

from genex_loop.errors import short_message
from genex_play import motion, play, route


def _answer(step, *args) -> str:
    """The step's answer as JSON; a failure becomes {error}, never an exception."""
    try:
        return json.dumps(step(*args))
    except Exception as error:  # noqa: BLE001 - no play session, no pawn, an engine call this version names differently
        return json.dumps({'error': short_message(error)})


@unreal.uclass()
class GenexPlayTools(unreal.ToolsetDefinition):
    """Plays the game like a player during a play session (PIE): holds input actions or keys
    for a time, lets the pawn settle, drives it along the game's route, and reads where the
    player's pawn is. Every time here is the play session's game time: a slow editor plays the
    same amount of game, only more slowly (a wait still ends after 4x its seconds plus 10 s of
    wall clock when the game stalls)."""

    @toolset_registry.tool_call
    @staticmethod
    def list_actions() -> str:
        """Lists the game's input actions with their value type and keys.

        Returns:
            JSON list of {action, valueType, keys, contexts}.
        """
        return play.list_actions()

    @toolset_registry.tool_call
    @staticmethod
    def hold(name: str, x: float = 1.0, y: float = 0.0, seconds: float = 1.0) -> str:
        """Holds an input action or a key as if the player pressed it, then lets go.

        Returns at once; the game keeps receiving the input for `seconds` of game time, so
        capture frames or read player_state meanwhile. Holding the same input again replaces
        its value and time.

        Args:
            name: Input action (IA_Throttle or Throttle) or key (W, SpaceBar, Gamepad_LeftX).
            x: Value on the first axis: 1 presses a button, -1..1 for an axis.
            y: Value on the second axis, for 2D actions only.
            seconds: How long to hold it, in game seconds; a tap is about 0.1.

        Returns:
            JSON {held, seconds}.
        """
        return play.hold(name, x, y, seconds)

    @toolset_registry.tool_call
    @staticmethod
    def mouse(dx: float = 0.0, dy: float = 0.0, wheel: float = 0.0) -> str:
        """Moves the player's mouse and turns its wheel for one frame of the game, as a mouse does:
        the game's own look mapping turns the view by what moved.

        Args:
            dx: Pixels of mouse motion to the right (negative: left).
            dy: Pixels of mouse motion down the screen (negative: up).
            wheel: Notches of the wheel, up positive.

        Returns:
            JSON {moved: [dx, dy], wheel}, or {error} without a play session.
        """
        return _answer(play.move_mouse, dx, dy, wheel)

    @toolset_registry.tool_call
    @staticmethod
    def pause(paused: bool = True) -> str:
        """Pauses or resumes the running play session's game, as its own pause does.

        Args:
            paused: True stands the game still; False lets it run.

        Returns:
            JSON {paused}, or {error} without a play session.
        """
        return _answer(play.set_paused, paused)

    @toolset_registry.tool_call
    @staticmethod
    def release_all() -> int:
        """Lets go of every held input action and key, and ends a settle or a drive.

        Returns:
            How many inputs were held.
        """
        return play.release_all()

    @toolset_registry.tool_call
    @staticmethod
    def project_file() -> str:
        """Names the project this editor has open, so Genex sends a project's calls only to its own editor.

        Returns:
            The full path of the open project's .uproject file.
        """
        return unreal.Paths.convert_relative_path_to_full(unreal.Paths.get_project_file_path())

    @toolset_registry.tool_call
    @staticmethod
    def player_state() -> str:
        """Reads the player's pawn in the running play session, the game clock and the latest settle and drive.

        Returns:
            JSON {pawn, location, rotation, speedKmh, held, gameSeconds, fps, routeProgressM,
            settle: {state: watching|settled|unsettled, gameSeconds, speedCmS} or null,
            drive: {state: driving|done, gameSeconds, progressM, route} or null}, or {error}.
            fps is the editor's frames per second lately; routeProgressM is how far the latest
            drive got along the route (m), null without a route.
        """
        return _answer(motion.player_state)

    @toolset_registry.tool_call
    @staticmethod
    def settle(seconds: float = 8.0) -> str:
        """Watches the player's pawn come to rest: settled once it moves under 20 cm/s with its
        height steady for one game second, unsettled if it still moves after `seconds`.

        Returns at once; read player_state's settle until it is no longer watching.

        Args:
            seconds: The most game seconds to wait, up to 8.

        Returns:
            JSON {watching, seconds}, or {error} without a play session.
        """
        return _answer(motion.settle, seconds)

    @toolset_registry.tool_call
    @staticmethod
    def drive_route(seconds: float = 20.0, throttle: str = 'Throttle', steer: str = 'Steering') -> str:
        """Drives the player's pawn along the game's route (the spline tagged GenexRoute):
        holds the throttle and steers each frame toward the route 15 m ahead. Without a route
        it only holds the throttle.

        Returns at once; capture frames meanwhile, and read player_state's drive until it is done.

        Args:
            seconds: Game seconds to drive, up to 30.
            throttle: The throttle's input action (as hold names it).
            steer: The steering's input action: -1 full left to 1 full right.

        Returns:
            JSON {driving, seconds, route}, or {error} (no play session, an input the game lacks).
        """
        return _answer(motion.drive_route, seconds, throttle, steer)

    @toolset_registry.tool_call
    @staticmethod
    def probe_route() -> str:
        """Measures the player's pawn against the game's route: how far its facing is off the
        route's direction, how far it is from the route and how far along.

        Returns:
            JSON {route, facingDeg (0 to 180), offRouteCm, progressM (from the route's first
            point), lengthM}; nulls and route false when the game has no route; {error} without
            a play session.
        """
        return _answer(route.probe_route)
