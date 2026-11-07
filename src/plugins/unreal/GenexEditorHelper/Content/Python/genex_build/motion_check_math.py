"""The arithmetic of motion_check (genex_build.motion_check), free of the engine: from a character's
visible body read every frame of a play, how far its planted feet slide while it travels, the frames
its pose jumps (a pop), the frames it turns in one snap, the montages that stopped well before their
end or started over, and the frames it was hidden or a ragdoll.

A frame is a dict: t (game seconds), root (x, y, z), yaw (the body's facing, degrees), feet
{side: (x, y, z) world cm}, bones {name: (x, y, z) from the root, world cm}, montages {mesh: (name,
position s, length s, blend-out s) or None}, and the flags hidden, ragdoll and falling.

The numbers were set on a sword duel whose fighters slid: a run whose stance foot rode along with
the body (its speed over the body's about 1.2) against the same run stepping (about 0.04).
"""

import math
import statistics

# The body travels when it moves at least this fast along the ground (cm/s).
MOVING_CM_S = 50.0
# A foot within this of its ground height under the body (cm) stands on the ground; its ground height
# is the height it is at or below in FLOOR_SHARE of the frames (one low frame, a step down, moves it not).
GROUND_CM = 6.0
FLOOR_SHARE = 0.1
# Feet slide when, over the frames the body travels, the slowest foot on the ground moves at least
# this share of the body's speed (median): a stepping foot stands still while the body passes over it.
SLIDE_MAX = 0.25
# A frame whose grounded foot moves at least this share of the body's speed is a sliding frame.
SLIDING_FRAME = 0.5
# A bone pops when it moves at least POP_MIN_CM in one frame, at least POP_RATIO times its usual
# speed around that frame (the median over POP_WINDOW frames either side, never under POP_FLOOR_CM_S).
POP_MIN_CM = 12.0
POP_RATIO = 4.0
POP_WINDOW = 5
POP_FLOOR_CM_S = 30.0
# Pops this few frames apart are one pop (a pose that jumps away and back is one flash).
POP_JOIN_FRAMES = 2
# The body snaps round when it turns at least SNAP_DEG in one frame, at least SNAP_DEG_S fast.
SNAP_DEG = 45.0
SNAP_DEG_S = 900.0
# A montage stopped short when it ended before this share of its length with more than CUT_REST_S
# left, its blend-out counted as played: a montage stops being the active one once it blends out.
CUT_SHARE = 0.8
CUT_REST_S = 0.3
# A montage shorter than this (s) is too short to call cut.
MIN_MONTAGE_S = 0.2
# A montage whose position goes back by more than RESTART_BACK_S to within RESTART_START_S of its
# start began again; one that goes back to a later point plays a section again (a loop, a hold).
RESTART_BACK_S = 0.05
RESTART_START_S = 0.1
# The fewest frames a check reports on, and the most it lists of each kind.
MIN_FRAMES = 10
MAX_LISTED = 12

SLIDING = 'sliding'
POSE_POP = 'pose-pop'
SNAP_TURN = 'snap-turn'
CUT_MONTAGE = 'cut-montage'
RESTARTED_MONTAGE = 'restarted-montage'
HIDDEN = 'hidden'
PROBLEMS = (SLIDING, POSE_POP, SNAP_TURN, CUT_MONTAGE, RESTARTED_MONTAGE, HIDDEN)

MESSAGE = {
    SLIDING: ('the feet slide: while the body travels, its planted foot moves at {ratio:.0%} of the body\'s speed '
              '(at most {most:.0%} is stepping)'),
    POSE_POP: 'the pose jumps in one frame {count} times (first at {t:.2f} s: {bones})',
    SNAP_TURN: 'the body snaps round {count} times (first at {t:.2f} s: {deg:.0f} degrees in one frame)',
    CUT_MONTAGE: 'a montage stops early {count} times (first {montage} at {t:.2f} s, after {played:.2f} of {length:.2f} s)',
    RESTARTED_MONTAGE: 'a montage starts over before its end {count} times (first {montage} at {t:.2f} s)',
    HIDDEN: 'the body is hidden in {count} frames (first at {t:.2f} s)',
    'few': 'Only {count} frames were read; a check needs at least {least}. Check a longer stretch.',
}


def _wrap(degrees: float) -> float:
    """An angle in (-180, 180]."""
    return (degrees + 180.0) % 360.0 - 180.0


def _speed_xy(a: tuple, b: tuple, dt: float) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1]) / dt


def _steps(frames: list) -> list:
    """(before, after, dt) for each pair of frames in time order with time between them."""
    return [(a, b, b['t'] - a['t']) for a, b in zip(frames, frames[1:]) if b['t'] > a['t']]


def _counted(frame: dict) -> bool:
    """Whether a frame shows the body as animation poses it: not hidden, not a ragdoll."""
    return not frame.get('hidden') and not frame.get('ragdoll')


def _foot_floor(frames: list) -> dict:
    """Each foot's ground height under the body over the check (cm): where it stands on the ground."""
    heights: dict = {}
    for frame in frames:
        for side, foot in frame.get('feet', {}).items():
            heights.setdefault(side, []).append(foot[2] - frame['root'][2])
    return {side: sorted(low)[int(len(low) * FLOOR_SHARE)] for side, low in heights.items()}


def slide(frames: list) -> dict:
    """How much the planted feet slide while the body travels: over the frames it moves (not
    falling, hidden or a ragdoll), the slowest foot on the ground's speed as a share of the body's.
    {ratio (median, None when it never travelled), slidingShare, movingFrames, sliding}."""
    floor = _foot_floor([f for f in frames if _counted(f) and not f.get('falling')])
    ratios = []
    for a, b, dt in _steps(frames):
        if not (_counted(a) and _counted(b)) or a.get('falling') or b.get('falling'):
            continue
        body = _speed_xy(a['root'], b['root'], dt)
        if body < MOVING_CM_S:
            continue
        grounded = [side for side, foot in b.get('feet', {}).items()
                    if side in a.get('feet', {}) and foot[2] - b['root'][2] <= floor.get(side, math.inf) + GROUND_CM]
        if grounded:
            ratios.append(min(_speed_xy(a['feet'][side], b['feet'][side], dt) for side in grounded) / body)
    if not ratios:
        return {'ratio': None, 'slidingShare': None, 'movingFrames': 0, 'sliding': False}
    ratio = statistics.median(ratios)
    share = sum(1 for r in ratios if r >= SLIDING_FRAME) / len(ratios)
    return {'ratio': round(ratio, 2), 'slidingShare': round(share, 2), 'movingFrames': len(ratios),
            'sliding': ratio > SLIDE_MAX}


def _bone_speeds(frames: list, bone: str) -> list:
    """(time, cm moved, cm/s) of one bone in the body's frame, for each step both frames count."""
    out = []
    for a, b, dt in _steps(frames):
        if _counted(a) and _counted(b) and bone in a.get('bones', {}) and bone in b.get('bones', {}):
            moved = math.dist(a['bones'][bone], b['bones'][bone])
            out.append((b['t'], moved, moved / dt))
    return out


def _bone_pops(speeds: list) -> list:
    """(time, cm) of each step a bone moved far more than around it."""
    pops = []
    for i, (t, moved, speed) in enumerate(speeds):
        around = [s for _t, _m, s in speeds[max(0, i - POP_WINDOW):i + POP_WINDOW + 1]]
        usual = max(statistics.median(around), POP_FLOOR_CM_S)
        if moved >= POP_MIN_CM and speed >= POP_RATIO * usual:
            pops.append((t, moved))
    return pops


def pops(frames: list) -> list:
    """The frames the pose jumped, joined: [{t, bones, cm}], first first."""
    index = {frame['t']: i for i, frame in enumerate(frames)}
    found: dict = {}
    for bone in sorted({name for frame in frames for name in frame.get('bones', {})}):
        for t, moved in _bone_pops(_bone_speeds(frames, bone)):
            entry = found.setdefault(t, {'t': round(t, 3), 'bones': [], 'cm': 0.0})
            entry['bones'].append(bone)
            entry['cm'] = round(max(entry['cm'], moved), 1)
    joined: list = []
    for t in sorted(found):
        last = joined[-1] if joined else None
        if last is not None and index[t] - index[last['_t']] <= POP_JOIN_FRAMES:
            last['bones'] = sorted(set(last['bones']) | set(found[t]['bones']))
            last['cm'] = max(last['cm'], found[t]['cm'])
            last['_t'] = t
            continue
        joined.append({**found[t], '_t': t})
    return [{k: v for k, v in entry.items() if k != '_t'} for entry in joined]


def snap_turns(frames: list) -> list:
    """The frames the body turned in one snap: [{t, deg}]."""
    snaps = []
    for a, b, dt in _steps(frames):
        if not (_counted(a) and _counted(b)):
            continue
        turned = abs(_wrap(b['yaw'] - a['yaw']))
        if turned >= SNAP_DEG and turned / dt >= SNAP_DEG_S:
            snaps.append({'t': round(b['t'], 3), 'deg': round(turned, 1)})
    return snaps


def _goes_on(current: dict, name, position) -> bool:
    """Whether a frame goes on with the montage `current` played: the same montage, onward or back to a
    later section, not back at its start."""
    if name != current['montage']:
        return False
    back = position < current['played'] - RESTART_BACK_S
    return not back or position > RESTART_START_S


def _playthroughs(frames: list, mesh: str) -> list:
    """Each stretch one montage played on a mesh: {montage, at, played, length, blendOut, end, then}; end
    is stopped, again (the same montage began anew) or running."""
    runs: list = []
    current = None
    for frame in frames:
        playing = frame.get('montages', {}).get(mesh)
        name, position = (playing[0], playing[1]) if playing else (None, None)
        if current is not None and _goes_on(current, name, position):
            current['played'] = max(current['played'], position)
            continue
        if current is not None:
            current.update(end='again' if name == current['montage'] else 'stopped', then=name)
            runs.append(current)
        current = None if name is None else {
            'montage': name, 'mesh': mesh, 'at': frame['t'], 'played': position, 'length': playing[2],
            'blendOut': playing[3] if len(playing) > 3 else 0.0, 'end': 'running', 'then': None}
    if current is not None:
        runs.append(current)
    return runs


def _short(run: dict) -> bool:
    """Whether a montage ended well before its end, its blend-out counted as played."""
    length = run['length']
    reached = run['played'] + run['blendOut']
    return length >= MIN_MONTAGE_S and reached < CUT_SHARE * length and length - reached > CUT_REST_S


# What a stretch's end means once its length is weighed: (ended short, ended near its end).
_ENDS = {'stopped': ('cut', 'finished'), 'again': ('restarted', 'finished')}


def montages(frames: list) -> list:
    """Every montage that played, in order: [{montage, mesh, at, playedS, lengthS, end, then}]; end is
    finished, cut (stopped well before its end), restarted (began again before its end) or running."""
    meshes = sorted({mesh for frame in frames for mesh in frame.get('montages', {})})
    runs = sorted((run for mesh in meshes for run in _playthroughs(frames, mesh)), key=lambda run: run['at'])
    listed = []
    for run in runs:
        end = run['end']
        if end in _ENDS:
            end = _ENDS[end][0] if _short(run) else _ENDS[end][1]
        listed.append({'montage': run['montage'], 'mesh': run['mesh'], 'at': round(run['at'], 3),
                       'playedS': round(run['played'], 2), 'lengthS': round(run['length'], 2), 'end': end,
                       'then': run['then']})
    return listed


def flagged(frames: list, flag: str) -> dict:
    """{frames, firstAt} of the frames with a flag set (hidden, ragdoll)."""
    marked = [frame['t'] for frame in frames if frame.get(flag)]
    return {'frames': len(marked), 'firstAt': round(marked[0], 3) if marked else None}


def _problems(sliding: dict, popped: list, snaps: list, played: list, hidden: dict) -> list:
    """The problems found, each {code, detail}."""
    found = []
    if sliding['sliding']:
        found.append((SLIDING, MESSAGE[SLIDING].format(ratio=sliding['ratio'], most=SLIDE_MAX)))
    if popped:
        first = popped[0]
        found.append((POSE_POP, MESSAGE[POSE_POP].format(count=len(popped), t=first['t'], bones=', '.join(first['bones']))))
    if snaps:
        found.append((SNAP_TURN, MESSAGE[SNAP_TURN].format(count=len(snaps), t=snaps[0]['t'], deg=snaps[0]['deg'])))
    cut = [run for run in played if run['end'] == 'cut']
    if cut:
        first = cut[0]
        found.append((CUT_MONTAGE, MESSAGE[CUT_MONTAGE].format(count=len(cut), montage=first['montage'], t=first['at'],
                                                               played=first['playedS'], length=first['lengthS'])))
    again = [run for run in played if run['end'] == 'restarted']
    if again:
        found.append((RESTARTED_MONTAGE, MESSAGE[RESTARTED_MONTAGE].format(count=len(again), montage=again[0]['montage'],
                                                                           t=again[0]['at'])))
    if hidden['frames']:
        found.append((HIDDEN, MESSAGE[HIDDEN].format(count=hidden['frames'], t=hidden['firstAt'])))
    return [{'code': code, 'detail': detail} for code, detail in found]


def report(frames: list) -> dict:
    """The check's numbers and problems; {error} with too few frames."""
    if len(frames) < MIN_FRAMES:
        return {'error': MESSAGE['few'].format(count=len(frames), least=MIN_FRAMES), 'frames': len(frames)}
    seconds = frames[-1]['t'] - frames[0]['t']
    travel = sum(math.hypot(b['root'][0] - a['root'][0], b['root'][1] - a['root'][1]) for a, b, _dt in _steps(frames))
    sliding, popped, snaps, played = slide(frames), pops(frames), snap_turns(frames), montages(frames)
    hidden, ragdoll = flagged(frames, 'hidden'), flagged(frames, 'ragdoll')
    problems = _problems(sliding, popped, snaps, played, hidden)
    return {'seconds': round(seconds, 2), 'frames': len(frames),
            'fps': round((len(frames) - 1) / seconds, 1) if seconds > 0 else None,
            'travelM': round(travel / 100.0, 2),
            'slide': sliding, 'pops': popped[:MAX_LISTED], 'snapTurns': snaps[:MAX_LISTED],
            'montages': played[:MAX_LISTED * 2], 'hidden': hidden, 'ragdoll': ragdoll,
            'problems': problems, 'verdict': 'problems' if problems else 'clean'}
