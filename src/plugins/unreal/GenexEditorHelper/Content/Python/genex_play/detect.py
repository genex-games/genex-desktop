"""Bug detectors on the running play session. From the first player_state read until the play ends,
every editor frame they look at the player's pawn and the frame time, and keep what looked wrong:
a position that is not a number, a pawn that vanished (dead, destroyed, fallen out of the world), a
fall that never lands, a frame that froze, a jump across the level in one frame; and on the characters
near the player, what looks wrong (genex_play.looks): sliding, a T-pose, floating, sinking. Each kind is
counted and told on its 1st, 10th, 100th and 1000th time, so a fault that repeats every frame is
told without flooding. player_state hands over what was told since the computer last took them; any
other read only peeks, so the plugin's own polling (a walk's, a settle's) loses nothing.

The codes are the wire spellings of the app's EnginePlayFindingCode (src/shared/engine-play.ts).
Every check reads only the pawn and the clocks, so a frame costs a few engine calls.
"""

import math

from genex_loop import capture
from genex_play import looks, play

NAN = 'nan'
PLAYER_GONE = 'player-gone'
LONG_FALL = 'long-fall'
HITCH = 'hitch'
TELEPORT = 'teleport'
CODES = (NAN, PLAYER_GONE, LONG_FALL, HITCH, TELEPORT) + looks.CODES

# The game seconds after detection starts in which a frozen frame is the level loading, not a hitch.
GRACE_S = 3.0
# One frame this long, in wall seconds, is a hitch.
HITCH_S = 0.75
# Falling faster than this (cm/s, down) for LONG_FALL_S game seconds is a fall that never lands.
FALL_CM_S = 300.0
LONG_FALL_S = 8.0
# A pawn that moves this far (cm) in one frame jumped across the level.
TELEPORT_CM = 2000.0
CM_PER_M = 100.0
# The times a kind of finding is told.
TOLD_AT = (1, 10, 100, 1000)
# Within a stretch (a pilot's run), the first finding of each kind gets a frame of the play view, up to this many.
MAX_FRAMES = 12
# The log a stretch reads its findings from keeps this many.
LOG_KEPT = 500

_state: dict = {}


def _fresh(game_now: float, wall_now: float) -> dict:
    return {'running': True, 'since': game_now, 'wall': wall_now, 'pawn': None, 'at': None, 'had_pawn': False,
            'fall_since': None, 'fall_told': False, 'counts': {}, 'told': [], 'log': [], 'framed': set()}


def ensure() -> None:
    """Starts watching the running play session, unless already watching; nothing without one."""
    if _state.get('running'):
        return
    try:
        game_now = play.game_seconds()
    except RuntimeError:  # no play session: nothing to watch
        return
    _state.clear()
    _state.update(_fresh(game_now, play.real_clock()))
    looks.reset()
    play.watch(_step, _stop)


def peek() -> list[dict]:
    """The findings told since the last take, oldest first, left in place."""
    return list(_state.get('told', []))


def take() -> list[dict]:
    """The findings told since the last take, oldest first; none until the next is told."""
    told = peek()
    if told:
        _state['told'] = []
    return told


def mark() -> int:
    """Starts a stretch (a pilot's run) and answers where the log stands: since(mark) is its findings. The first
    finding of each kind in it is logged (with a frame) even when the play told that kind already."""
    _state['framed'] = set()
    _state['stretch_seen'] = set()
    return len(_state.get('log', []))


def since(index: int) -> list[dict]:
    """The findings told since a mark, oldest first (each with its frame's capture name when it has one)."""
    return list(_state.get('log', [])[max(0, index):])


def _frame(code: str, game_now: float) -> str | None:
    """A frame of the play view for a stretch's first finding of a kind: its capture name, else None."""
    framed = _state.setdefault('framed', set())
    if code in framed or len(framed) >= MAX_FRAMES:
        return None
    framed.add(code)
    name = f'finding-{code}-{int(game_now * 1000)}'
    try:
        capture.capture_play(name, 0, 0)
    except Exception:  # noqa: BLE001 - a finding is told with or without its frame
        return None
    return name


def _stop() -> None:
    _state['running'] = False


def _note(code: str, detail: str, game_now: float) -> None:
    counts = _state['counts']
    counts[code] = counts.get(code, 0) + 1
    told = counts[code] in TOLD_AT
    seen = _state.setdefault('stretch_seen', set())
    first_in_stretch = code not in seen
    seen.add(code)
    if not (told or first_in_stretch):
        return
    finding = {'code': code, 'detail': detail, 'gameSeconds': round(game_now, 2), 'count': counts[code]}
    frame = _frame(code, game_now)
    if frame is not None:
        finding['frame'] = frame
    if told:
        _state['told'].append(finding)
    log = _state.setdefault('log', [])
    if len(log) < LOG_KEPT:
        log.append(finding)


def _pawn():
    try:
        return play.player_pawn()
    except RuntimeError:  # the player controls no pawn right now
        return None


def _check_hitch(game_now: float, wall_now: float) -> None:
    """`wall_now` is the real clock as the frame began, the one shots are noted on: the caps' clock stands still
    under a strip's hold."""
    gap = wall_now - _state['wall']
    loading = game_now - _state['since'] < GRACE_S
    if gap > HITCH_S and not loading and not play._stalled(_state['wall'], wall_now):
        _note(HITCH, f'a frame took {gap:.1f} s: the game or the editor stalled', game_now)


def _check_fall(pawn, game_now: float) -> None:
    falling = float(pawn.get_velocity().z) < -FALL_CM_S
    if not falling:
        _state['fall_since'], _state['fall_told'] = None, False
        return
    if _state['fall_since'] is None:
        _state['fall_since'] = game_now
    lasted = game_now - _state['fall_since']
    if lasted >= LONG_FALL_S and not _state['fall_told']:
        _state['fall_told'] = True
        _note(LONG_FALL, f'the player has been falling for {lasted:.0f} s without landing', game_now)


def _check_jump(pawn, at: tuple, game_now: float) -> None:
    last = _state['at']
    if last is None or pawn != _state['pawn']:
        return
    moved = math.dist(at, last)
    if moved > TELEPORT_CM:
        _note(TELEPORT, f'the player moved {moved / CM_PER_M:.0f} m in one frame', game_now)


def _step(game_now: float, _wall_now: float) -> bool:
    """One frame's checks; answers whether to keep watching (until the play ends)."""
    if not _state.get('running'):
        return False
    real_now = play.frame_clock()
    _check_hitch(game_now, real_now)
    _state['wall'] = real_now
    pawn = _pawn()
    if pawn is None:
        if _state['had_pawn']:
            _note(PLAYER_GONE, "the player's pawn is gone: dead, destroyed or fallen out of the world", game_now)
        _state.update(had_pawn=False, pawn=None, at=None, fall_since=None, fall_told=False)
        return True
    location = pawn.get_actor_location()
    at = (float(location.x), float(location.y), float(location.z))
    if not all(math.isfinite(v) for v in at):
        _note(NAN, f"the player's position is not a number: {at}", game_now)
        _state.update(had_pawn=True, pawn=pawn, at=None)
        return True
    _check_jump(pawn, at, game_now)
    _check_fall(pawn, game_now)
    looks.check(pawn, game_now, _note)
    _state.update(had_pawn=True, pawn=pawn, at=at)
    return True
