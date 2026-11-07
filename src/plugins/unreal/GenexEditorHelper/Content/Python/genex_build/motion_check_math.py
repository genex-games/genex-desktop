"""The arithmetic of motion_check (genex_build.motion_check), free of the engine: from a character's
visible body read every frame of a play, how far its planted feet slide while it travels, the frames
its pose jumps (a pop), the frames it turns in one snap, the montages that stopped well before their
end, started over or stayed at their start, and the frames it was hidden or a ragdoll. Frames too far
apart to read slides and pops from are a problem of their own, never a clean check.

A frame is a dict: t (game seconds), root (x, y, z), yaw (the body's facing, degrees; None when
its pose shows none), feet
{side: (x, y, z) world cm}, bones {name: (x, y, z) from the root, world cm}, montages {mesh: (name,
position s, length s, blend-out s, rate) or None}, and the flags hidden, ragdoll and falling.

The numbers were set on a sword duel whose fighters slid: a run whose stance foot rode along with
the body (its speed over the body's about 1.2) against the same run stepping (about 0.04). In Unreal
5.8 on that duel the slide ratio read 0.14 to 0.23 for the fixed run and 0.18 to 0.24 for its
lunging slash, against 1.0 with the bug back and 0.49 with a run montage played again every frame.
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
# this share of the body's speed (median): a stepping foot stands still while the body passes over it,
# and a lunge's front foot glides a little.
SLIDE_MAX = 0.30
# A frame whose grounded foot moves at least this share of the body's speed is a sliding frame.
SLIDING_FRAME = 0.5
# Steps longer than this (s) are not read for sliding: a stride's stance changes inside one, so a
# stepping foot reads as moving (the long frame a shot's stall leaves).
SLIDE_STEP_S = 0.15
# A bone jumps when it moves at least POP_MIN_CM in one frame, at least POP_RATIO times its usual
# speed around that frame (the median over POP_WINDOW frames either side, never under POP_FLOOR_CM_S).
# The pose pops when a jump comes straight back (a jump within POP_FLASH_S after it undoes at least
# POP_BACK_SHARE of it: a flash, however many frames it is on screen) or at least POP_BONES of the six
# bones read jump in the same frame (the pose snaps): one limb going fast on its way, a sword's swing,
# is motion. Frames more than POP_STEP_S apart are not read for pops: that far apart a fast move and a
# jump look alike. One or two bones that snap and stay (an upper-body montage with no blend-in) are
# not told apart from a swing.
POP_MIN_CM = 12.0
POP_RATIO = 4.0
POP_WINDOW = 5
POP_FLOOR_CM_S = 30.0
POP_BACK_SHARE = 0.5
POP_FLASH_S = 0.1
POP_BONES = 3
POP_STEP_S = 0.1
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
# start, plus what it plays at its own rate in the frame's time, began again; one that goes back to
# a later point plays a section again (a loop, a hold).
RESTART_BACK_S = 0.05
RESTART_START_S = 0.1
# A montage that began near its start (within RESTART_START_S, plus a frame's play) and, active for
# STUCK_S or longer, moved on less than STUCK_SHARE of what its rate plays in that time is stuck:
# something plays it again every frame, or it is paused (its rate 0, counted as 1).
STUCK_S = 0.5
STUCK_SHARE = 0.2
# A montage that played through at least LOOP_CYCLES times in a row (again within LOOP_GAP_S of its
# last stretch, with nothing between) loops: one stopped mid-way after that is a run let go, not a cut.
# Two plays in a row are an attack pressed again, whose second swing can still be cut; a third press
# cut short reads as a loop let go.
LOOP_CYCLES = 2
LOOP_GAP_S = 0.3
# A check most of whose steps are longer than POP_STEP_S (under about 10 fps) reads too few of them for
# pops, and under about 7 fps for slides: it says so, never clean.
SLOW_SHARE = 0.5
# The fewest frames a check reports on, and the most it lists of each kind.
MIN_FRAMES = 10
MAX_LISTED = 12

SLIDING = 'sliding'
POSE_POP = 'pose-pop'
SNAP_TURN = 'snap-turn'
CUT_MONTAGE = 'cut-montage'
RESTARTED_MONTAGE = 'restarted-montage'
STUCK_MONTAGE = 'stuck-montage'
HIDDEN = 'hidden'
SLOW_FRAMES = 'slow-frames'
PROBLEMS = (SLIDING, POSE_POP, SNAP_TURN, CUT_MONTAGE, RESTARTED_MONTAGE, STUCK_MONTAGE, HIDDEN, SLOW_FRAMES)

MESSAGE = {
    SLIDING: ('the feet slide: while the body travels, its planted foot moves at {ratio:.0%} of the body\'s speed '
              '(at most {most:.0%} is stepping)'),
    POSE_POP: 'the pose jumps in one frame {count} times (first at {t:.2f} s: {bones})',
    SNAP_TURN: 'the body snaps round {count} times (first at {t:.2f} s: {deg:.0f} degrees in one frame)',
    CUT_MONTAGE: 'a montage stops early {count} times (first {montage} at {t:.2f} s, after {played:.2f} of {length:.2f} s)',
    RESTARTED_MONTAGE: 'a montage starts over before its end {count} times (first {montage} at {t:.2f} s)',
    STUCK_MONTAGE: ('a montage stays at its start for {held:.1f} s (first {montage} at {t:.2f} s): something plays '
                    'it again every frame, or it is paused'),
    HIDDEN: 'the body is hidden in {count} frames (first at {t:.2f} s)',
    SLOW_FRAMES: ('the frames came too far apart to read: {share:.0%} of them more than {pop:.2f} s apart, where pops '
                  'are read up to {pop:.2f} s and slides up to {slide:.2f} s; check again while the editor runs faster'),
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
        if not (_counted(a) and _counted(b)) or a.get('falling') or b.get('falling') or dt > SLIDE_STEP_S:
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


def _bone_steps(frames: list, bone: str) -> list:
    """(time, (x, y, z) moved in cm, cm/s, s) of one bone in the body's frame, for each step both frames count."""
    out = []
    for a, b, dt in _steps(frames):
        if _counted(a) and _counted(b) and bone in a.get('bones', {}) and bone in b.get('bones', {}):
            move = tuple(q - p for p, q in zip(a['bones'][bone], b['bones'][bone]))
            out.append((b['t'], move, math.hypot(*move) / dt, dt))
    return out


def _undone(move: tuple, after: tuple) -> float:
    """The share of `move` the next step `after` takes back."""
    length = math.hypot(*move)
    return -sum(m * n for m, n in zip(move, after)) / (length * length) if length else 0.0


def _bone_jumps(steps: list) -> list:
    """(time, cm, back) of each step a bone moved far more than around it; back when a jump within
    POP_FLASH_S after it undid it."""
    jumps = []
    for i, (t, move, speed, dt) in enumerate(steps):
        around = [s for _t, _m, s, _dt in steps[max(0, i - POP_WINDOW):i + POP_WINDOW + 1]]
        usual = max(statistics.median(around), POP_FLOOR_CM_S)
        moved = math.hypot(*move)
        if dt <= POP_STEP_S and moved >= POP_MIN_CM and speed >= POP_RATIO * usual:
            jumps.append((t, move, moved))
    return [(t, moved, any(0 < later - t <= POP_FLASH_S and _undone(move, back) >= POP_BACK_SHARE
                           for later, back, _cm in jumps))
            for t, move, moved in jumps]


def pops(frames: list) -> list:
    """The frames the pose popped, joined: [{t, bones, cm}], first first."""
    index = {frame['t']: i for i, frame in enumerate(frames)}
    jumped: dict = {}
    for bone in sorted({name for frame in frames for name in frame.get('bones', {})}):
        for t, moved, back in _bone_jumps(_bone_steps(frames, bone)):
            jumped.setdefault(t, []).append((bone, moved, back))
    found = {t: {'t': round(t, 3), 'bones': [bone for bone, _cm, _back in bones],
                 'cm': round(max(cm for _bone, cm, _back in bones), 1)}
             for t, bones in jumped.items() if len(bones) >= POP_BONES or any(back for _b, _cm, back in bones)}
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
        if not (_counted(a) and _counted(b)) or a.get('yaw') is None or b.get('yaw') is None:
            continue
        turned = abs(_wrap(b['yaw'] - a['yaw']))
        if turned >= SNAP_DEG and turned / dt >= SNAP_DEG_S:
            snaps.append({'t': round(b['t'], 3), 'deg': round(turned, 1)})
    return snaps


def _goes_on(current: dict, playing, dt: float) -> bool:
    """Whether a frame `dt` after the last goes on with the montage `current` played: the same montage,
    onward or back to a later section, not back at its start."""
    if not playing or playing[0] != current['montage']:
        return False
    position = playing[1]
    rate = playing[4] if len(playing) > 4 else 1.0
    back = position < current['played'] - RESTART_BACK_S
    return not back or position > RESTART_START_S + rate * dt


def _short(run: dict) -> bool:
    """Whether a montage ended well before its end, its blend-out counted as played."""
    length = run['length']
    reached = run['played'] + run['blendOut']
    return length >= MIN_MONTAGE_S and reached < CUT_SHARE * length and length - reached > CUT_REST_S


def _cycles(before, frame: dict, name: str) -> int:
    """How many times in a row the montage `name` played through up to `frame`: one more than the stretch
    `before` when that was the same montage, played to its end, with nothing between and no long gap."""
    follows = before is not None and before['montage'] == name
    if not follows or _short(before) or frame['t'] - before['last'] > LOOP_GAP_S:
        return 0
    return before['cycles'] + 1


def _begun(frame: dict, mesh: str, playing, cycles: int) -> dict:
    """A stretch of `playing` on a mesh from `frame`, after `cycles` full plays of it in a row."""
    return {'montage': playing[0], 'mesh': mesh, 'at': frame['t'], 'last': frame['t'], 'from': playing[1],
            'played': playing[1], 'length': playing[2], 'blendOut': playing[3] if len(playing) > 3 else 0.0,
            'rate': playing[4] if len(playing) > 4 else 1.0, 'step': 0.0, 'cycles': cycles, 'end': 'running',
            'then': None}


def _playthroughs(frames: list, mesh: str) -> list:
    """Each stretch one montage played on a mesh: {montage, at, last, from, played, length, blendOut, rate,
    step (its longest frame), cycles, end, then}; end is stopped, again (the same montage began anew) or
    running."""
    runs: list = []
    current = None
    last_t = None
    for frame in frames:
        playing = frame.get('montages', {}).get(mesh)
        dt = 0.0 if last_t is None else max(0.0, frame['t'] - last_t)
        last_t = frame['t']
        if current is not None and _goes_on(current, playing, dt):
            current.update(played=max(current['played'], playing[1]), last=frame['t'], step=max(current['step'], dt))
            continue
        if current is not None:
            again = bool(playing) and playing[0] == current['montage']
            current.update(end='again' if again else 'stopped', then=playing[0] if playing else None)
            runs.append(current)
            current = None
        if playing:
            current = _begun(frame, mesh, playing, _cycles(runs[-1] if runs else None, frame, playing[0]))
    if current is not None:
        runs.append(current)
    return runs


def _stuck(run: dict) -> bool:
    """Whether a montage stayed at its start while active for STUCK_S or longer: it began near its start
    and moved on less than STUCK_SHARE of what its rate plays in that time."""
    held = run['last'] - run['at']
    rate = run['rate'] or 1.0
    began_near = run['from'] <= RESTART_START_S + rate * run['step']
    barely_moved = run['played'] - run['from'] < STUCK_SHARE * rate * held
    return run['length'] >= MIN_MONTAGE_S and held >= STUCK_S and began_near and barely_moved


def _end(run: dict) -> str:
    """How a stretch ended, its length weighed: finished, cut, restarted, loop-stopped, stuck or running."""
    if _stuck(run):
        return 'stuck'
    if run['end'] == 'running':
        return 'running'
    if not _short(run):
        return 'finished'
    if run['end'] == 'again':
        return 'restarted'
    return 'loop-stopped' if run['cycles'] >= LOOP_CYCLES else 'cut'


def montages(frames: list) -> list:
    """Every montage that played, in order: [{montage, mesh, at, playedS, lengthS, end, then}]; end is
    finished, cut (stopped well before its end), restarted (began again before its end), loop-stopped (a
    montage played over and over, stopped mid-way: a run let go), stuck (stayed at its start, heldS long)
    or running."""
    meshes = sorted({mesh for frame in frames for mesh in frame.get('montages', {})})
    runs = sorted((run for mesh in meshes for run in _playthroughs(frames, mesh)), key=lambda run: run['at'])
    listed = []
    for run in runs:
        entry = {'montage': run['montage'], 'mesh': run['mesh'], 'at': round(run['at'], 3),
                 'playedS': round(run['played'], 2), 'lengthS': round(run['length'], 2), 'end': _end(run),
                 'then': run['then']}
        if entry['end'] == 'stuck':
            entry['heldS'] = round(run['last'] - run['at'], 2)
        listed.append(entry)
    return listed


def slow_share(frames: list) -> float | None:
    """The share of the steps both frames count that are too long to read pops from; None without one."""
    steps = [dt for a, b, dt in _steps(frames) if _counted(a) and _counted(b)]
    return sum(1 for dt in steps if dt > POP_STEP_S) / len(steps) if steps else None


def flagged(frames: list, flag: str) -> dict:
    """{frames, firstAt} of the frames with a flag set (hidden, ragdoll)."""
    marked = [frame['t'] for frame in frames if frame.get(flag)]
    return {'frames': len(marked), 'firstAt': round(marked[0], 3) if marked else None}


def _problems(sliding: dict, popped: list, snaps: list, played: list, hidden: dict, slow: float | None) -> list:
    """The problems found, each {code, detail}."""
    found = []
    if slow is not None and slow > SLOW_SHARE:
        found.append((SLOW_FRAMES, MESSAGE[SLOW_FRAMES].format(share=slow, pop=POP_STEP_S, slide=SLIDE_STEP_S)))
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
    stuck = [run for run in played if run['end'] == 'stuck']
    if stuck:
        found.append((STUCK_MONTAGE, MESSAGE[STUCK_MONTAGE].format(held=stuck[0]['heldS'], montage=stuck[0]['montage'],
                                                                   t=stuck[0]['at'])))
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
    hidden, ragdoll, slow = flagged(frames, 'hidden'), flagged(frames, 'ragdoll'), slow_share(frames)
    problems = _problems(sliding, popped, snaps, played, hidden, slow)
    return {'seconds': round(seconds, 2), 'frames': len(frames),
            'fps': round((len(frames) - 1) / seconds, 1) if seconds > 0 else None,
            'travelM': round(travel / 100.0, 2),
            'slide': sliding, 'pops': popped[:MAX_LISTED], 'snapTurns': snaps[:MAX_LISTED],
            'montages': played[:MAX_LISTED * 2], 'hidden': hidden, 'ragdoll': ragdoll,
            'slowShare': None if slow is None else round(slow, 2),
            'problems': problems, 'verdict': 'problems' if problems else 'clean'}
