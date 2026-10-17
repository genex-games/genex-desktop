"""Drives the local player of the running play session.

Input goes through Enhanced Input's own forced-input console commands
(Input.+action / Input.+key), which resolve the player's subsystem from its
player controller. Python can't reach that subsystem reliably: the Blueprint
getters are hidden from scripts, and ended play sessions leave stale
subsystems that still report the current world.

Every hold counts the play session's GAME seconds (GameplayStatics.get_time_seconds of the play
world), not the wall clock: a cold or loaded editor runs at a few frames a second, and a hold
timed by the wall clock gave the game about a second of input. A hold still ends after a
wall-clock cap (WALL_FACTOR x its seconds + WALL_GRACE_S) when the game clock stalls. One slate
post-tick callback runs while anything is held or watched: it lets go of what is due and steps
the watches (motion's settle and drive), and it measures the editor's frame rate.
"""

import collections
import json
import math
import time
from typing import NamedTuple

import unreal

KMH_PER_CM_PER_S = 0.036
MIN_HOLD_SECONDS = 0.05
# The mouse's own keys: its movement (2D, in pixels) and its wheel (notches, up positive).
MOUSE_MOVE = 'Mouse2D'
MOUSE_WHEEL = 'MouseWheelAxis'
# A mouse movement lasts one frame of the game; its wall-clock cap is a wait of almost no game time.
ONE_FRAME_S = 1e-6
# A game-time wait of s seconds ends after WALL_FACTOR * s + WALL_GRACE_S wall seconds at most.
WALL_FACTOR = 4.0
WALL_GRACE_S = 10.0
# The frame rate is the editor frames of the last FPS_WINDOW_S wall seconds, while the tick ran
# within FPS_STALE_S; otherwise the play world's last frame.
FPS_WINDOW_S = 2.0
FPS_STALE_S = 5.0
FPS_FRAMES = 1200


class Held(NamedTuple):
    """A forced input: the command that lets go, and when (game seconds, wall seconds)."""
    release: str
    until_game: float
    until_wall: float


class Input(NamedTuple):
    """An input action (`action` set) or a key the player's input can be forced on, by its label."""
    label: str
    action: object


_held: dict[str, Held] = {}
# Each watch is (step, stop): step(game_now, wall_now) is called every frame and answers whether
# to keep watching; stop() ends it early (release_all, or the play session ending).
_watches: list[tuple] = []
_frames: collections.deque = collections.deque(maxlen=FPS_FRAMES)
_shots: collections.deque = collections.deque(maxlen=FPS_FRAMES)
_tick_handle = None


def wall_clock() -> float:
    """The wall clock, in seconds (tests move it)."""
    return time.monotonic()


def wall_cap(seconds: float) -> float:
    """The wall-clock seconds a game-time wait of `seconds` may take at most."""
    return WALL_FACTOR * seconds + WALL_GRACE_S


def game_world() -> unreal.World:
    """The running play session's world, or RuntimeError."""
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_game_world()
    if world is None:
        raise RuntimeError('No play session is running. Start one with StartPIE first.')
    return world


def game_seconds() -> float:
    """The play session's game clock: it stops while the game is paused or frozen."""
    return float(unreal.GameplayStatics.get_time_seconds(game_world()))


def _player_controller() -> unreal.PlayerController:
    controller = unreal.GameplayStatics.get_player_controller(game_world(), 0)
    if controller is None:
        raise RuntimeError('The play session has no local player yet.')
    return controller


def player_pawn() -> unreal.Pawn:
    """The pawn the local player controls, or RuntimeError."""
    pawn = _player_controller().get_controlled_pawn()
    if pawn is None:
        raise RuntimeError('The player controls no pawn.')
    return pawn


def _run(command: str) -> None:
    unreal.SystemLibrary.execute_console_command(game_world(), command, _player_controller())


def _assets(class_name: str) -> list[unreal.AssetData]:
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    return registry.get_assets_by_class(unreal.TopLevelAssetPath('/Script/EnhancedInput', class_name))


def _find_action(name: str) -> unreal.InputAction | None:
    wanted = name.lower()
    for data in _assets('InputAction'):
        asset_name = str(data.asset_name).lower()
        if wanted in (asset_name, str(data.package_name).lower()) or asset_name == f'ia_{wanted}':
            return data.get_asset()
    return None


def _is_key(name: str) -> bool:
    key = unreal.Key()
    key.set_editor_property('key_name', name)
    return unreal.InputLibrary.key_is_valid(key)


def _action_value(action: unreal.InputAction, x: float, y: float) -> str:
    kind = action.get_editor_property('value_type')
    if kind == unreal.InputActionValueType.BOOLEAN:
        return 'true' if x else 'false'
    if kind == unreal.InputActionValueType.AXIS1D:
        return f'{x:g}'
    if kind == unreal.InputActionValueType.AXIS2D:
        return f'X={x:g} Y={y:g}'
    return f'X={x:g} Y={y:g} Z=0'


def resolve(name: str) -> Input:
    """The input action (IA_Throttle or Throttle) or key (W) called `name`, or RuntimeError."""
    action = _find_action(name)
    if action is not None:
        return Input(action.get_name(), action)
    if _is_key(name):
        return Input(name, None)
    raise RuntimeError(f'{name} is neither an input action nor a key. Call list_actions to see them.')


def optional_action(name: str) -> Input | None:
    """The input action called `name` (IA_Brake or Brake), or None when the game has none."""
    action = _find_action(name)
    return Input(action.get_name(), action) if action is not None else None


def _release_command(held: Input) -> str:
    return f'Input.-action {held.label}' if held.action is not None else f'Input.-key {held.label}'


def press(held: Input, x: float, y: float, seconds: float) -> None:
    """Forces the input on with a value for `seconds` of game time; pressing it again replaces its value and time."""
    if held.action is not None:
        _run(f'Input.+action {held.label} {_action_value(held.action, x, y)}')
    else:
        _run(f'Input.+key {held.label} {x:g}')
    _held[held.label] = Held(_release_command(held), game_seconds() + seconds, wall_clock() + wall_cap(seconds))
    _ensure_ticking()


def release(label: str) -> None:
    """Lets go of one forced input, if it is held."""
    held = _held.pop(label, None)
    if held is None:
        return
    try:
        _run(held.release)
    except RuntimeError:  # the play session already ended and took its input with it
        pass


def watch(step, stop) -> None:
    """Calls step(game_now, wall_now) every frame while it answers True; stop() ends it early."""
    _watches.append((step, stop))
    _ensure_ticking()


def _ensure_ticking() -> None:
    global _tick_handle
    if _tick_handle is None:
        _tick_handle = unreal.register_slate_post_tick_callback(_tick)


def _stop_ticking() -> None:
    global _tick_handle
    if _tick_handle is not None:
        unreal.unregister_slate_post_tick_callback(_tick_handle)
        _tick_handle = None


def _stop_watches() -> None:
    stopping = list(_watches)
    _watches.clear()
    for _step, stop in stopping:
        stop()


def _tick(_delta: float) -> None:
    wall = wall_clock()
    _frames.append(wall)
    try:
        now = game_seconds()
    except RuntimeError:  # the play session ended: its input went with it
        _held.clear()
        _stop_watches()
        _stop_ticking()
        return
    for label in [label for label, held in _held.items() if held.until_game <= now or held.until_wall <= wall]:
        release(label)
    _watches[:] = [(step, stop) for step, stop in list(_watches) if step(now, wall)]
    if not _held and not _watches:
        _stop_ticking()


def note_shot() -> None:
    """A high-resolution shot was asked for now: the frames it stalls stay out of the frame rate."""
    _shots.append(wall_clock())


def _stalled(start: float, end: float) -> bool:
    """Whether a shot was asked for in the frame gap from start to end: the frame that renders it freezes the
    editor for about a second, which is the shot's cost, not the game's."""
    return any(start <= shot < end for shot in _shots)


def fps() -> float | None:
    """The editor's frames per wall second lately, leaving out the frames shots stalled, else the play world's
    last frame; None when unknown."""
    wall = wall_clock()
    recent = [t for t in _frames if wall - t <= FPS_WINDOW_S]
    gaps = [end - start for start, end in zip(recent, recent[1:]) if not _stalled(start, end)]
    fresh = bool(gaps) and wall - recent[-1] <= FPS_STALE_S and sum(gaps) > 0
    if fresh:
        return round(len(gaps) / sum(gaps), 1)
    delta = float(unreal.GameplayStatics.get_world_delta_seconds(game_world()))
    return round(1.0 / delta, 1) if delta > 0 and math.isfinite(delta) else None


def held() -> list[str]:
    """The labels of the inputs held now."""
    return list(_held)


def list_actions() -> str:
    actions: dict[str, dict] = {}
    for data in _assets('InputMappingContext'):
        context = data.get_asset()
        mappings = context.get_editor_property('default_key_mappings').get_editor_property('mappings')
        for mapping in mappings:
            action = mapping.get_editor_property('action')
            if action is None:
                continue
            entry = actions.setdefault(action.get_name(), {
                'action': action.get_name(),
                'valueType': action.get_editor_property('value_type').name,
                'keys': [], 'contexts': []})
            key = str(mapping.get_editor_property('key').get_editor_property('key_name'))
            if key != 'None' and key not in entry['keys']:
                entry['keys'].append(key)
            if context.get_name() not in entry['contexts']:
                entry['contexts'].append(context.get_name())
    return json.dumps(sorted(actions.values(), key=lambda a: a['action']))


def hold(name: str, x: float, y: float, seconds: float) -> str:
    """Holds an input action or key for `seconds` of game time (see the module notes)."""
    held_seconds = max(seconds, MIN_HOLD_SECONDS)
    held_input = resolve(name)
    press(held_input, x, y, held_seconds)
    return json.dumps({'held': held_input.label, 'seconds': held_seconds})


def _try_run(command: str) -> None:
    """Runs a console command in the play session, when there still is one."""
    try:
        _run(command)
    except RuntimeError:  # the play session already ended and took its input with it
        pass


def _one_frame(key: str, value: str, still: str) -> None:
    """Forces `key` to `value` for one frame of the game, as one frame of a mouse is. Unreal lets go
    of a forced analog key by injecting its opposite (the mouse moved straight back), so the key is
    forced to `still` for the next frame and let go after that, when its opposite is nothing."""
    _run(f'Input.+key {key} {value}')
    stage = {'frames': 0, 'last': game_seconds(), 'until_wall': wall_clock() + wall_cap(ONE_FRAME_S)}

    def let_go() -> None:
        _try_run(f'Input.-key {key}')

    def step(game_now: float, wall_now: float) -> bool:
        if wall_now >= stage['until_wall']:
            let_go()
            return False
        if game_now <= stage['last']:
            return True
        stage['last'] = game_now
        stage['frames'] += 1
        if stage['frames'] == 1:
            _try_run(f'Input.+key {key} {still}')
            return True
        let_go()
        return False

    watch(step, let_go)


def move_mouse(dx: float, dy: float, wheel: float) -> dict:
    """Moves the player's mouse by (dx, dy) pixels, down on screen being +dy, and turns its wheel by
    `wheel` notches, up being +, for one frame of the game: what a mouse does in that frame."""
    game_world()
    if dx or dy:
        # Unreal's mouse Y grows upward, a screen's downward.
        _one_frame(MOUSE_MOVE, f'X={dx:g} Y={-dy:g}', 'X=0 Y=0')
    if wheel:
        _one_frame(MOUSE_WHEEL, f'{wheel:g}', '0')
    return {'moved': [dx, dy], 'wheel': wheel}


def set_paused(paused: bool) -> dict:
    """Pauses or resumes the play session's game, as its own pause does; what it is now."""
    world = game_world()
    unreal.GameplayStatics.set_game_paused(world, bool(paused))
    return {'paused': bool(unreal.GameplayStatics.is_game_paused(world))}


def release_all() -> int:
    """Lets go of every held input and ends every watch; how many inputs were held."""
    _stop_watches()
    labels = list(_held)
    for label in labels:
        release(label)
    return len(labels)


def pawn_state() -> dict:
    """The player's pawn, its speed, what is held, and the play session's clock and frame rate."""
    pawn = player_pawn()
    location = pawn.get_actor_location()
    rotation = pawn.get_actor_rotation()
    return {
        'pawn': pawn.get_name(),
        'location': [round(location.x), round(location.y), round(location.z)],
        'rotation': [round(rotation.pitch, 1), round(rotation.yaw, 1), round(rotation.roll, 1)],
        'speedKmh': round(pawn.get_velocity().length() * KMH_PER_CM_PER_S, 1),
        'held': list(_held),
        'gameSeconds': round(game_seconds(), 2),
        'fps': fps()}
