"""The build tools' eyes: clean frames of the game, never of the editor around it.

capture_shot    a still from a named CameraActor (a hero camera, GX_Shot_<name>) in the editor
                world, no play session needed, after a delay that lets Lumen and the volumetric
                fog settle; the level viewport is piloted through the camera for the shot only.
capture_play    the player's view during a play session.
motion_strip    N frames of the player's view during a play session, `interval_s` GAME seconds
                apart, each with the pawn's and the view's position the moment it is asked for: the
                game is held all but still until it is on disk.
                A short interval (down to 0.03 s, about every frame at 30 fps) shows one move
                frame by frame: a step, a swing, a turn; the judge reads its frames with their times.

Python tools answer at once and the shot lands a frame or more later, so each answers the files it
queued and the bridge waits for them. Every high-resolution shot freezes the play session's game
clock while it renders (about a second at 1280x720 here), and Unreal's automation screenshot writes
its file twice about a second apart. A strip that asks for frames by the wall clock therefore keeps
landing in the same frozen moment: consecutive frames come out identical while the pawn is said to
move. So play frames go through the player's own console (HighResShot, one write, the play
session's viewport wherever it is shown), are scheduled by the game clock, and one frame is only
asked for once the last one is on disk. Meanwhile the game is held all but still (its global time
dilation at FREEZE_DILATION): a shot is drawn a frame or more after it is asked for, and the frame
after a shot's stall moved the game up to 0.4 s on (Unreal's longest frame), so on a sword duel a
0.05 s burst came out 0.02 to 0.42 s apart and a picture showed the fighter 2 m past its pose; it
stays held SETTLE_FRAMES world frame after the one the file is seen on disk in, past the long frame
that can follow. A time dilation the game sets meanwhile (a hit's slow motion) is kept, and the
game-time waits' wall caps (holds, walks, a motion check) pause while it is held. While a shot
settles the editor's "Use Less CPU when in Background" is lifted, and given back afterwards, so a
Genex window in front doesn't starve Lumen.
"""

import json
import os
import sys
import time

import unreal

from genex_build import place
from genex_loop import capture, editor, paths
from genex_loop.errors import Refused
from genex_play import play

CAPTURES = 'captures'
WIDTH_RANGE = (320, 3840)
HEIGHT_RANGE = (240, 2160)
DEFAULT_SIZE = (1280, 720)
STRIP_SIZE = (960, 540)
DELAY_RANGE_S = (0.0, 15.0)
FRAMES_RANGE = (2, 24)
INTERVAL_RANGE_S = (0.03, 5.0)
# The most game seconds a strip spans (frames x interval): the bridge waits a fixed while for it.
MAX_SPAN_S = 60.0
STRIP_PREFIX = 'strip-'
# The time dilation that holds the game all but still while a strip frame is drawn and written:
# Unreal's least by default (WorldSettings.MinGlobalTimeDilation).
FREEZE_DILATION = 0.0001
# The game stays held for this many world frames after the one its frame is seen on disk in: the frame
# that follows a shot's write can be long, and let go at once the game jumped 0.3 to 0.4 s on in it.
SETTLE_FRAMES = 1
# How long one strip frame may take to land on disk before the strip gives up on it.
FRAME_WAIT_S = 15.0
# How long after its delay a still may take before the throttle is given back anyway.
SHOT_WAIT_S = 30.0
PERFORMANCE_SETTINGS = '/Script/UnrealEd.EditorPerformanceSettings'
THROTTLE = 'bThrottleCPUWhenNotForeground'
# On a Mac, UE 5.8 rendering a ray-traced level at full speed behind another app hangs the GPU: there
# the throttle is lifted only while this is 0, as the bridge's own lift (editor-throttle.ts).
RAY_TRACING = 'r.RayTracing'
MAC = 'darwin'

MESSAGE = {
    'size': 'width and height must be whole numbers: width {w[0]} to {w[1]}, height {h[0]} to {h[1]}.',
    'delay': f'delay_s must be from {DELAY_RANGE_S[0]:g} to {DELAY_RANGE_S[1]:g} seconds.',
    'camera': ('There is no camera {camera} in the level. Make hero cameras with gx.shot_camera(name, location, '
               'rotation, fov) in a build script; the level has: {cameras}.'),
    'no_cameras': 'There are no hero cameras yet: make them with gx.shot_camera(name, location, rotation, fov).',
    'playing': 'A play session is running; capture_shot shows the editor world. Use capture_play, or stop play first.',
    'not_playing': 'No play session is running; start one (StartPIE) first.',
    'frames': f'frames must be a whole number from {FRAMES_RANGE[0]} to {FRAMES_RANGE[1]}.',
    'interval': f'interval_s must be from {INTERVAL_RANGE_S[0]:g} to {INTERVAL_RANGE_S[1]:g} game seconds.',
    'span': f'frames x interval_s must be at most {MAX_SPAN_S:g} game seconds: take fewer frames, or closer together.',
    'busy': 'A motion strip is still being taken; wait for it to finish.',
}


def _whole(value: object, bounds: tuple) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and bounds[0] <= value <= bounds[1]


def check_size(width: object, height: object) -> tuple:
    """(width, height) in range, or Refused; 0 for both means the default size."""
    if width == 0 and height == 0:
        return DEFAULT_SIZE
    if not _whole(width, WIDTH_RANGE) or not _whole(height, HEIGHT_RANGE):
        raise Refused(MESSAGE['size'].format(w=WIDTH_RANGE, h=HEIGHT_RANGE), width=width, height=height)
    return width, height


def check_delay(delay_s: object) -> float:
    """A settle delay in range, or Refused."""
    ok = isinstance(delay_s, (int, float)) and not isinstance(delay_s, bool)
    if not ok or not DELAY_RANGE_S[0] <= delay_s <= DELAY_RANGE_S[1]:
        raise Refused(MESSAGE['delay'], delay_s=delay_s)
    return float(delay_s)


def check_strip(frames: object, interval_s: object) -> tuple:
    """(frames, interval) in range, or Refused."""
    if not _whole(frames, FRAMES_RANGE):
        raise Refused(MESSAGE['frames'], frames=frames)
    ok = isinstance(interval_s, (int, float)) and not isinstance(interval_s, bool)
    if not ok or not INTERVAL_RANGE_S[0] <= interval_s <= INTERVAL_RANGE_S[1]:
        raise Refused(MESSAGE['interval'], interval_s=interval_s)
    if frames * interval_s > MAX_SPAN_S:
        raise Refused(MESSAGE['span'], frames=frames, interval_s=interval_s)
    return frames, float(interval_s)


def captures_folder() -> str:
    """<project>/Saved/Genex/captures, made when missing."""
    folder = os.path.join(editor.project_dir(), *paths.GENEX_FOLDER, CAPTURES)
    os.makedirs(folder, exist_ok=True)
    return folder


def capture_file(name: str) -> str:
    """Where the capture `name` goes, with any earlier file of that name removed."""
    file = os.path.join(captures_folder(), f'{paths.check_capture_name(name)}.png')
    if os.path.lexists(file):
        os.remove(file)
    return file


# --- the editor's own ticks, for waits outside a play session ---------------------------------------------

_waits: list = []
_wait_handle = None


def _tick(_delta: float) -> None:
    global _wait_handle
    keep = []
    for done, then, deadline in list(_waits):
        try:
            finished = time.monotonic() >= deadline or done()
        except Exception:  # noqa: BLE001 - a wait must never break the editor's tick
            finished = True
        if not finished:
            keep.append((done, then, deadline))
            continue
        try:
            then()
        except Exception:  # noqa: BLE001
            pass
    _waits[:] = keep
    if not _waits and _wait_handle is not None:
        unreal.unregister_slate_post_tick_callback(_wait_handle)
        _wait_handle = None


def after(done, then, timeout_s: float) -> None:
    """Calls then() once done() is true or `timeout_s` passed, checking every editor frame."""
    global _wait_handle
    _waits.append((done, then, time.monotonic() + timeout_s))
    if _wait_handle is None:
        _wait_handle = unreal.register_slate_post_tick_callback(_tick)


def _settings():
    return unreal.get_default_object(unreal.load_class(None, PERFORMANCE_SETTINGS))


# The holds on the throttle (a still, a strip and a motion check can run at once) and whether it was
# on before the first: the last one given back turns it back on, never a strip that ends mid-check.
_throttle = {'holds': 0, 'owed': False}


def _may_lift() -> bool:
    """Whether the throttle may be lifted here: anywhere but a Mac whose editor runs ray tracing."""
    if sys.platform != MAC:
        return True
    try:
        return int(unreal.SystemLibrary.get_console_variable_int_value(RAY_TRACING)) == 0
    except Exception:  # noqa: BLE001 - a switch that can't be read is treated as on
        return False


def lift_throttle() -> bool:
    """Turns "Use Less CPU when in Background" off while anything holds it (never on a Mac that ray
    traces); True, a hold to give back."""
    if _throttle['holds'] == 0:
        settings = _settings()
        _throttle['owed'] = _may_lift() and bool(settings.get_editor_property(THROTTLE))
        if _throttle['owed']:
            settings.set_editor_property(THROTTLE, False)
    _throttle['holds'] += 1
    return True


def give_back_throttle(held: bool) -> None:
    """Gives back a hold lift_throttle took; the last one turns the throttle back on when it was on."""
    if not held or _throttle['holds'] == 0:
        return
    _throttle['holds'] -= 1
    if _throttle['holds'] == 0 and _throttle['owed']:
        _throttle['owed'] = False
        _settings().set_editor_property(THROTTLE, True)


# --- capture_shot -----------------------------------------------------------------------------------------

def _camera(name: str):
    if name == '':
        cameras = place.shot_cameras()
        if not cameras:
            raise Refused(MESSAGE['no_cameras'])
        return cameras[0]
    found = place.find_camera(name)
    if found is None:
        labels = ', '.join(a.get_actor_label() for a in place.shot_cameras()) or 'none'
        raise Refused(MESSAGE['camera'].format(camera=name, cameras=labels), camera=name)
    return found


def shot_cameras() -> dict:
    """The level's hero cameras by label, sorted; reads only (Genex's save points capture each)."""
    return {'cameras': [actor.get_actor_label() for actor in place.shot_cameras()]}


def capture_shot(camera: str, width: int, height: int, delay_s: float) -> dict:
    """Queues a still from a level camera (see the module notes); {queued, file, camera, delayS}."""
    size = check_size(width, height)
    delay = check_delay(delay_s)
    if editor.play_world() is not None:
        raise Refused(MESSAGE['playing'])
    actor = _camera(camera)
    label = actor.get_actor_label()
    file = capture_file(f'shot-{label}')
    owed = lift_throttle()
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).editor_set_viewport_realtime(True)
    task = unreal.AutomationLibrary.take_high_res_screenshot(size[0], size[1], file, actor, False, False,
                                                             unreal.ComparisonTolerance.LOW, '', delay, True)
    after(lambda: task is None or task.is_task_done(), lambda: give_back_throttle(owed), delay + SHOT_WAIT_S)
    return {'queued': True, 'file': file, 'camera': label, 'width': size[0], 'height': size[1], 'delayS': delay}


# --- the play view ----------------------------------------------------------------------------------------

def _rounded(vector) -> list:
    return [round(vector.x), round(vector.y), round(vector.z)]


def pose() -> dict:
    """Where the player's pawn and the player's view are now, and the game clock and frame rate."""
    world = play.game_world()
    pawn = play.player_pawn()
    camera = unreal.GameplayStatics.get_player_camera_manager(world, 0)
    view = camera.get_camera_rotation()
    return {'gameSeconds': round(play.game_seconds(), 3), 'fps': play.fps(),
            'pawn': _rounded(pawn.get_actor_location()), 'pawnYaw': round(pawn.get_actor_rotation().yaw, 1),
            'view': _rounded(camera.get_camera_location()), 'viewYawPitch': [round(view.yaw, 1), round(view.pitch, 1)]}


def capture_play(name: str, width: int, height: int) -> dict:
    """Queues a shot of the player's view during play; {queued, file, ...pose}."""
    size = check_size(width, height)
    if editor.play_world() is None:
        raise Refused(MESSAGE['not_playing'])
    file = capture_file(name)
    taken = pose()
    capture.console_shot(file, size[0], size[1])
    return {'queued': True, 'file': file, 'width': size[0], 'height': size[1], **taken}


def _same(a: float, b: float) -> bool:
    return abs(a - b) <= FREEZE_DILATION / 2


def _hold_still() -> tuple | None:
    """Holds the play's game all but still; (the time dilation it had, the one it holds at), or None when
    it couldn't be set. The held one is read back: a game whose least time dilation is raised holds there."""
    try:
        world = play.game_world()
        before = float(unreal.GameplayStatics.get_global_time_dilation(world))
        unreal.GameplayStatics.set_global_time_dilation(world, FREEZE_DILATION)
        held = float(unreal.GameplayStatics.get_global_time_dilation(world))
        if held >= before or _same(held, before):  # it can't be slowed any further
            unreal.GameplayStatics.set_global_time_dilation(world, before)
            return None
    except Exception:  # noqa: BLE001 - a play without the setting runs on, its frames timed as they come
        return None
    play.hold_still(True)
    return before, held


def _let_go(hold: tuple | None) -> None:
    """Gives the game the time dilation it had, unless the game set one of its own meanwhile."""
    if hold is None:
        return
    before, held = hold
    play.hold_still(False)
    try:
        world = play.game_world()
        if _same(float(unreal.GameplayStatics.get_global_time_dilation(world)), held):
            unreal.GameplayStatics.set_global_time_dilation(world, before)
    except Exception:  # noqa: BLE001 - the play ended, and its world with it
        pass


class _Strip:
    """A motion strip being taken: its frames' files, the poses recorded so far and the next frame's due time."""

    def __init__(self, stem: str, frames: int, interval: float, start: float) -> None:
        folder = captures_folder()
        self.files = [os.path.join(folder, f'{stem}-{i}.png') for i in range(frames)]
        self.poses_file = os.path.join(folder, f'{stem}.json')
        self.interval, self.due = interval, start
        self.poses: list = []
        # (file, wall time asked) of the frame being taken, and (the time dilation the game had before it,
        # the one it is held at).
        self.waiting: tuple | None = None
        self.hold: tuple | None = None
        # Frames the game stays held after the one the last frame was seen landing in.
        self.settle = 0
        self.owed = False
        self.done = False

    def finish(self, why: str = '') -> bool:
        _let_go(self.hold)
        self.hold = None
        if self.done:
            return False
        self.done = True
        record = {'frames': self.poses, 'files': self.files[:len(self.poses)], 'intervalS': self.interval}
        if why:
            record['error'] = why
        with open(self.poses_file, 'w', encoding='utf-8') as handle:
            json.dump(record, handle)
        give_back_throttle(self.owed)
        return False

    def step(self, game_now: float, _wall_now: float) -> bool:
        if self.done:
            return False
        if self.waiting is not None:
            file, asked = self.waiting
            landed = os.path.exists(file) and os.path.getsize(file) > 0
            # The real wall clock: the caps' one stands still while the game is held.
            if not landed and time.monotonic() - asked > FRAME_WAIT_S:
                return self.finish(f'frame {len(self.poses) - 1} never landed')
            if not landed:
                return True
            self.waiting = None
            self.settle = SETTLE_FRAMES
        if self.settle:
            self.settle -= 1
            return True
        _let_go(self.hold)
        self.hold = None
        if len(self.poses) == len(self.files):
            return self.finish()
        if game_now < self.due:
            return True
        index = len(self.poses)
        self.poses.append(pose())
        capture.console_shot(self.files[index], *STRIP_SIZE)
        self.hold = _hold_still()
        self.waiting = (self.files[index], time.monotonic())
        self.due = game_now + self.interval
        return True


_strip: list = []


def _clear_old_strips(folder: str) -> None:
    for entry in os.listdir(folder):
        path = os.path.join(folder, entry)
        if entry.startswith(STRIP_PREFIX) and paths.is_regular_file(path):
            os.remove(path)


def motion_strip(frames: int, interval_s: float) -> dict:
    """Starts a strip of the player's view (see the module notes); {strip, files, poses, waitS}."""
    count, interval = check_strip(frames, interval_s)
    if editor.play_world() is None:
        raise Refused(MESSAGE['not_playing'])
    if _strip and not _strip[0].done:
        raise Refused(MESSAGE['busy'])
    _clear_old_strips(captures_folder())
    stem = f'{STRIP_PREFIX}{int(time.time() * 1000)}'
    strip = _Strip(stem, count, interval, play.game_seconds())
    strip.owed = lift_throttle()
    _strip[:] = [strip]
    play.watch(strip.step, lambda: strip.finish('the play session ended'))
    wait = play.wall_cap(count * interval) + count * FRAME_WAIT_S / 3
    return {'strip': stem, 'files': strip.files, 'poses': strip.poses_file, 'width': STRIP_SIZE[0],
            'height': STRIP_SIZE[1], 'intervalS': interval, 'waitS': round(wait)}
