"""motion_check: measures how one character moves during a play session, every frame, on the body the
player sees, so an animation fix is told by numbers rather than by stills. A Motion Matching
character (motion_character) poses a hidden driver mesh that another mesh copies: the copy is the
one measured, and the driver's montages are read too, since that is where they play.

It records, for `seconds` of game time from the call: where the character is and which way its body
faces (by its shoulders, since a Motion Matching capsule may turn ahead of the body it carries), its
feet in the world, its pelvis, head, hands and feet from where it stands, the montage each of its
skeletal meshes plays, how far in and its blend-out, and whether the body is hidden, a ragdoll or
falling. Background CPU throttling is lifted meanwhile, so a check behind another app is not read at
a few frames a second. When
the time is up (or the play ends) it writes its report to <project>/Saved/Genex/captures/<check>.json
(motion_check_math reads the frames): planted feet sliding while the body travels, pose pops, snap
turns, montages stopped early, started over or stuck at their start, hidden and ragdoll frames, and frames too far
apart to read. Start the move first (a
pilot, hold, walk_to), then call this; several characters can be checked at once.
"""

import difflib
import json
import math
import os
import time

import unreal

from genex_build import motion_check_math, shots
from genex_loop import editor
from genex_loop.errors import Refused, short_message
from genex_play import looks, play

SECONDS_RANGE = (0.5, 20.0)
CHECK_PREFIX = 'check-'
# A check keeps at most this many frames (20 game seconds at 120 fps).
MAX_FRAMES = 2400
# A frame less than this many game seconds after the last is not read: the game is held all but still
# (a motion strip's frame being written), and its frames would fill the check with one moment.
MIN_STEP_S = 0.001
# The wall seconds the bridge's wait for a check's report allows for motion strips holding the game
# meanwhile, which the check's own wall-clock cap doesn't count (24 frames at about a second each).
STRIP_HOLD_S = 30.0
# How many actor labels a refusal names when nothing matches.
CLOSEST_NAMES = 6
# The bones read in the body's own frame for pops, by these words in their names (feet and hands come
# from genex_play.looks.parts); these words rule a bone out.
CORE_BONES = (('pelvis', ('pelvis', 'hips')), ('head', ('head',)))
NOT_CORE = ('end', 'top', 'twist', 'ik', 'neck')
# The shoulders give no facing when the line between them lies along the ground less than this share
# of its length (a body on its side, a roll): that frame's facing is unknown, not a turn.
LEVEL_SHOULDERS = 0.5

MESSAGE = {
    'not_playing': 'No play session is running; start one (StartPIE) first.',
    'seconds': f'seconds must be from {SECONDS_RANGE[0]:g} to {SECONDS_RANGE[1]:g} game seconds.',
    'no_actor': 'No actor is called {target}. Closest names: {closest}.',
    'no_body': ('{target} has no shown skeletal mesh with feet to measure (its meshes: {meshes}). Check the '
                'character the player sees, not a hidden driver.'),
    'ended': 'the play session ended',
    'gone': 'the character could no longer be read: {why}',
    'wall': 'the game ran too slowly to cover the time asked within its wall-clock cap',
    'full': f'it reached its most frames ({MAX_FRAMES}) before the time asked',
}


def check_seconds(seconds: object) -> float:
    """Game seconds in range, or Refused."""
    ok = isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and math.isfinite(seconds)
    if not ok or not SECONDS_RANGE[0] <= seconds <= SECONDS_RANGE[1]:
        raise Refused(MESSAGE['seconds'], seconds=seconds)
    return float(seconds)


def _xyz(vector) -> tuple:
    return (float(vector.x), float(vector.y), float(vector.z))


def _label(actor) -> str:
    try:
        return str(actor.get_actor_label())
    except Exception:  # noqa: BLE001 - a runtime actor has no editor label
        return str(actor.get_name())


def _actor(target: str):
    """The player's pawn for '', else the actor whose label or name is target (or holds it), the closest to the player."""
    pawn = play.player_pawn()
    wanted = target.strip().lower()
    if not wanted:
        return pawn
    actors = list(unreal.GameplayStatics.get_all_actors_of_class(play.game_world(), unreal.Actor))
    named = [(actor, _label(actor), str(actor.get_name())) for actor in actors]
    exact = [actor for actor, label, name in named if wanted in (label.lower(), name.lower())]
    loose = exact or [actor for actor, label, name in named if wanted in label.lower() or wanted in name.lower()]
    if not loose:
        labels = sorted({label for _actor, label, _name in named})
        closest = difflib.get_close_matches(target, labels, n=CLOSEST_NAMES, cutoff=0.0)
        raise Refused(MESSAGE['no_actor'].format(target=target, closest=', '.join(closest) or 'none'), target=target)
    at = _xyz(pawn.get_actor_location())
    return min(loose, key=lambda actor: math.dist(_xyz(actor.get_actor_location()), at))


def _core_bones(mesh) -> dict:
    """{pelvis, head: bone name} of the mesh, those it has."""
    names = [str(name) for name in mesh.get_all_socket_names()]
    found = {}
    for part, words in CORE_BONES:
        for name in names:
            low = name.lower().rsplit(':', 1)[-1]
            if any(w in low for w in words) and not any(w in low for w in NOT_CORE):
                found[part] = name
                break
    return found


def _bones(mesh) -> dict:
    """{label: bone name} of every bone a pop is looked for on: pelvis, head, hands and feet."""
    parts = looks.parts(mesh)
    bones = dict(_core_bones(mesh))
    bones.update({f'hand_{side}': bone for side, bone in parts['hands'].items()})
    bones.update({f'foot_{side}': bone for side, bone in parts['feet'].items()})
    return bones


def _rate(anim, montage) -> float:
    """How fast a montage plays against the game's clock: the instance's rate times the asset's own."""
    rate = 1.0
    try:
        rate = abs(float(anim.montage_get_play_rate(montage)))
    except Exception:  # noqa: BLE001 - its rate unread: the montage's own pace
        pass
    try:
        rate *= abs(float(montage.get_editor_property('rate_scale')))
    except Exception:  # noqa: BLE001 - an asset without a rate scale plays at 1
        pass
    return rate


def _blend_out(montage, rate: float) -> float:
    """How far before its end (montage seconds) a montage stops being the active one: its blend-out
    trigger time when it sets one (0 or more), else its blend-out time, at the rate it plays; 0 when
    the montage names neither."""
    try:
        lead = float(montage.get_editor_property('blend_out_trigger_time'))
    except Exception:  # noqa: BLE001 - no trigger time: the blend-out's own
        lead = -1.0
    if lead < 0:
        try:
            lead = float(montage.get_editor_property('blend_out').get_editor_property('blend_time'))
        except Exception:  # noqa: BLE001 - a montage without the blend: no allowance
            lead = 0.0
    return max(0.0, lead * rate)


def _montage(anim) -> tuple | None:
    """(name, position s, length s, blend-out s, rate) of the montage an animation instance plays, or None."""
    montage = anim.get_current_active_montage() if anim is not None else None
    if montage is None:
        return None
    rate = _rate(anim, montage)
    return (str(montage.get_name()), float(anim.montage_get_position(montage)), float(montage.get_play_length()),
            _blend_out(montage, rate), rate)


def _hidden(actor, mesh) -> bool:
    """Whether the body is not drawn this frame: the mesh hidden, or the whole actor."""
    if not looks.shown(mesh):
        return True
    try:
        return bool(actor.get_editor_property('hidden'))
    except Exception:  # noqa: BLE001 - an actor class that names its hidden flag otherwise
        return False


def _falling(actor) -> bool:
    movement = actor.get_component_by_class(unreal.CharacterMovementComponent)
    return movement is not None and bool(movement.is_falling())


def _facing(mesh, shoulders: dict) -> float | None:
    """The body's facing (degrees): square to its shoulders as the pose has them, else the mesh's yaw;
    None while the shoulders stand nearly upright (a body on its side)."""
    if 'l' not in shoulders or 'r' not in shoulders:
        return float(mesh.get_world_rotation().yaw)
    left, right = (_xyz(mesh.get_socket_location(shoulders[side])) for side in ('l', 'r'))
    across = (left[0] - right[0], left[1] - right[1])
    if math.hypot(*across) <= LEVEL_SHOULDERS * math.dist(left, right):
        return None
    return math.degrees(math.atan2(across[0], -across[1]))


class _Check:
    """A check being recorded: its character and body, the frames so far, when it ends and its record file."""

    def __init__(self, stem: str, actor, mesh, seconds: float) -> None:
        self.stem, self.actor, self.mesh, self.seconds = stem, actor, mesh, seconds
        self.record = os.path.join(shots.captures_folder(), f'{stem}.json')
        self.label, self.bones = _label(actor), _bones(mesh)
        self.feet, self.shoulders = looks.parts(mesh)['feet'], looks.parts(mesh)['shoulders']
        self.held = False
        self.meshes = list(actor.get_components_by_class(unreal.SkeletalMeshComponent))
        self.frames: list = []
        start = play.game_seconds()
        self.ends, self.wall_ends = start + seconds, play.wall_clock() + play.wall_cap(seconds)
        self.done = False

    def facts(self) -> dict:
        """Who is measured: the character, the body read and the meshes left out (hidden drivers)."""
        others = [m.get_name() for m in self.meshes if m is not self.mesh]
        return {'check': self.stem, 'target': self.label, 'mesh': self.mesh.get_name(), 'otherMeshes': others,
                'bones': sorted(self.bones), 'askedSeconds': self.seconds}

    def frame(self, game_now: float) -> dict:
        """What the character's body is doing in this frame."""
        at = _xyz(self.actor.get_actor_location())
        # Bones from where the character stands, in the world's axes: a pop is a jump of the pose
        # itself, never a capsule that turned ahead of the body.
        return {
            't': game_now, 'root': at, 'yaw': _facing(self.mesh, self.shoulders),
            'feet': {side: _xyz(self.mesh.get_socket_location(bone)) for side, bone in self.feet.items()},
            'bones': {label: tuple(p - r for p, r in zip(_xyz(self.mesh.get_socket_location(bone)), at))
                      for label, bone in self.bones.items()},
            'montages': {m.get_name(): _montage(m.get_anim_instance()) for m in self.meshes},
            'hidden': _hidden(self.actor, self.mesh), 'ragdoll': bool(self.mesh.is_simulating_physics()),
            'falling': _falling(self.actor),
        }

    def step(self, game_now: float, wall_now: float) -> bool:
        if self.done:
            return False
        if game_now >= self.ends:
            return self.finish()
        if wall_now >= self.wall_ends:
            return self.finish(MESSAGE['wall'])
        if len(self.frames) >= MAX_FRAMES:
            return self.finish(MESSAGE['full'])
        if self.frames and game_now - self.frames[-1]['t'] < MIN_STEP_S:
            return True  # the game clock stood (all but) still: a pause, a shot rendering or being written
        try:
            self.frames.append(self.frame(game_now))
        except Exception as error:  # noqa: BLE001 - the character was destroyed or its mesh went
            return self.finish(MESSAGE['gone'].format(why=short_message(error)))
        return True

    def finish(self, why: str = '') -> bool:
        if self.done:
            return False
        self.done = True
        shots.give_back_throttle(self.held)
        record = {**self.facts(), **motion_check_math.report(self.frames)}
        if why:
            record['stopped'] = why
        with open(self.record, 'w', encoding='utf-8') as handle:
            json.dump(record, handle)
        return False


# One entry per check started in this editor run: two checks started in the same millisecond get their own files.
_started: list = []


def motion_check(target: str, seconds: float) -> dict:
    """Starts measuring a character's motion (see the module notes); {check, record, target, mesh, ..., waitS}."""
    span = check_seconds(seconds)
    if editor.play_world() is None:
        raise Refused(MESSAGE['not_playing'])
    actor = _actor(target)
    mesh = looks.visible_body(actor)
    if mesh is None:
        meshes = ', '.join(m.get_name() for m in actor.get_components_by_class(unreal.SkeletalMeshComponent)) or 'none'
        raise Refused(MESSAGE['no_body'].format(target=_label(actor), meshes=meshes), target=target)
    _started.append(None)
    check = _Check(f'{CHECK_PREFIX}{int(time.time() * 1000)}-{len(_started)}', actor, mesh, span)
    if os.path.lexists(check.record):
        os.remove(check.record)
    check.held = shots.lift_throttle()
    play.watch(check.step, lambda: check.finish(MESSAGE['ended']))
    return {**check.facts(), 'record': check.record, 'waitS': round(play.wall_cap(span) + STRIP_HOLD_S)}
