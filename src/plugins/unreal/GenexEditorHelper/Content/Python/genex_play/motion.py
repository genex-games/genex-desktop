"""Settling and driving the player's pawn in the play session, both on the game clock with
play's wall-clock cap.

settle watches the pawn come to rest: under STILL_CM_S with its height steady (STILL_Z_CM) for
STILL_FOR_S game seconds is settled; still moving when its seconds run out is unsettled.
drive_route holds the throttle and, when the game has a GenexRoute, steers each frame toward the
route's point route_math.LOOK_AHEAD_CM past the pawn's nearest one, through the same forced input
a hold uses; it counts the pawn's progress along the route (round a closed one, never negative).
On a route it also keeps a steady lap pace (route_math.pace_kmh), easing off and braking for the
bends ahead, so the car can make them (at full throttle a car runs wide of a sharp bend). Without a
route it only holds the throttle. player_state reports both.
"""

import math

from genex_play import play, route, route_math

SETTLE_MAX_S = 8.0
DRIVE_MAX_S = 30.0
MIN_STEP_S = 0.1
STILL_CM_S = 20.0
STILL_Z_CM = 2.0
STILL_FOR_S = 1.0
# The steering, throttle and brake are forced again only when they change by this much.
STEER_STEP = 0.05
# The brake a test drive slows for bends with, when the game has one.
BRAKE_ACTION = 'Brake'
CM_PER_M = 100.0


class SettleState:
    WATCHING = 'watching'
    SETTLED = 'settled'
    UNSETTLED = 'unsettled'


class DriveState:
    DRIVING = 'driving'
    DONE = 'done'


# The latest settle and drive, as plain records; their watches step them every frame.
_settle: dict | None = None
_drive: dict | None = None


def _seconds(seconds: float, highest: float) -> float:
    """Game seconds clamped to (0, highest]; ValueError for a value that isn't a finite number."""
    value = float(seconds)
    if not math.isfinite(value):
        raise ValueError('seconds must be a finite number.')
    return min(highest, max(MIN_STEP_S, value))


def _caps(span: float) -> tuple[float, float, float]:
    """(now, game deadline, wall deadline) for a step of `span` game seconds starting now."""
    now = play.game_seconds()
    return now, now + span, play.wall_clock() + play.wall_cap(span)


def _end_settle(record: dict, state: str, now: float) -> None:
    record['state'], record['ended'] = state, now


def _settle_step(record: dict, now: float, wall: float) -> bool:
    if record['state'] != SettleState.WATCHING:
        return False
    record['last'] = now
    try:
        pawn = play.player_pawn()
    except RuntimeError:
        _end_settle(record, SettleState.UNSETTLED, now)
        return False
    speed, z = float(pawn.get_velocity().length()), float(pawn.get_actor_location().z)
    record['speed'] = speed
    if speed >= STILL_CM_S:
        record['still_since'] = None
    elif record['still_since'] is None or abs(z - record['z']) >= STILL_Z_CM:
        record['still_since'], record['z'] = now, z
    elif now - record['still_since'] >= STILL_FOR_S:
        _end_settle(record, SettleState.SETTLED, now)
        return False
    if now >= record['until'] or wall >= record['wall_until']:
        _end_settle(record, SettleState.UNSETTLED, now)
        return False
    return True


def _stop_settle(record: dict) -> None:
    if record['state'] == SettleState.WATCHING:
        _end_settle(record, SettleState.UNSETTLED, record['last'])


def settle(seconds: float) -> dict:
    """Starts watching the player's pawn come to rest for at most `seconds` game seconds."""
    global _settle
    span = _seconds(seconds, SETTLE_MAX_S)
    play.player_pawn()
    now, until, wall_until = _caps(span)
    if _settle is not None:
        _stop_settle(_settle)
    record = {'state': SettleState.WATCHING, 'started': now, 'until': until, 'wall_until': wall_until,
              'still_since': None, 'z': None, 'speed': None, 'last': now, 'ended': None}
    _settle = record
    play.watch(lambda game_now, wall_now: _settle_step(record, game_now, wall_now), lambda: _stop_settle(record))
    return {'watching': True, 'seconds': span}


def _finish_drive(record: dict, now: float) -> None:
    record['state'], record['ended'] = DriveState.DONE, now
    play.release(record['throttle'].label)
    for pedal in ('steer', 'brake'):
        if record[pedal] is not None:
            play.release(record[pedal].label)


def _follow(record: dict, now: float) -> None:
    """One frame of following the route: count the progress, force the steering when it changed."""
    path = record['route']
    pawn = play.player_pawn()
    location = pawn.get_actor_location()
    x, y, yaw = float(location.x), float(location.y), float(pawn.get_actor_rotation().yaw)
    near = route_math.nearest(path, x, y)
    record['progress'] += route_math.advance(path, record['s'], near.s)
    record['s'] = near.s
    left = record['until'] - now
    _force(record, 'steer', round(route_math.steer(path, x, y, yaw), 2), left)
    speed_kmh = float(pawn.get_velocity().length()) * play.KMH_PER_CM_PER_S
    gas, brake = route_math.pedals(speed_kmh, route_math.pace_kmh(path, near.s))
    _force(record, 'throttle', gas, left)
    if record['brake'] is not None:
        _force(record, 'brake', brake, left)


def _force(record: dict, pedal: str, value: float, seconds: float) -> None:
    """Forces one of the drive's inputs to a new value when it changed enough since the last one."""
    last = record['values'].get(pedal)
    if last is None or abs(value - last) >= STEER_STEP:
        play.press(record[pedal], value, 0.0, seconds)
        record['values'][pedal] = value


def _drive_step(record: dict, now: float, wall: float) -> bool:
    if record['state'] != DriveState.DRIVING:
        return False
    record['last'] = now
    if now >= record['until'] or wall >= record['wall_until']:
        _finish_drive(record, now)
        return False
    if record['route'] is None:
        return True
    try:
        _follow(record, now)
    except RuntimeError:  # the pawn is gone
        _finish_drive(record, now)
        return False
    return True


def _stop_drive(record: dict) -> None:
    if record['state'] == DriveState.DRIVING:
        record['state'], record['ended'] = DriveState.DONE, record['last']


def drive_route(seconds: float, throttle: str, steer: str) -> dict:
    """Drives the player's pawn along the game's route (or straight on without one) for `seconds` game seconds."""
    global _drive
    span = _seconds(seconds, DRIVE_MAX_S)
    pawn = play.player_pawn()
    path = route.find_route(play.game_world())
    gas = play.resolve(throttle)
    wheel = play.resolve(steer) if path is not None else None
    now, until, wall_until = _caps(span)
    if _drive is not None and _drive['state'] == DriveState.DRIVING:
        _finish_drive(_drive, now)  # a new drive replaces one under way, letting go of its inputs first
    location = pawn.get_actor_location()
    start = route_math.nearest(path, float(location.x), float(location.y)).s if path is not None else None
    record = {'state': DriveState.DRIVING, 'route': path, 'started': now, 'until': until, 'wall_until': wall_until,
              'throttle': gas, 'steer': wheel, 'brake': play.optional_action(BRAKE_ACTION) if path is not None else None,
              's': start, 'progress': 0.0 if path is not None else None,
              'values': {'throttle': 1.0}, 'last': now, 'ended': None}
    play.press(gas, 1.0, 0.0, span)
    _drive = record
    play.watch(lambda game_now, wall_now: _drive_step(record, game_now, wall_now), lambda: _stop_drive(record))
    return {'driving': True, 'seconds': span, 'route': path is not None}


def _elapsed(record: dict, now: float) -> float:
    end = record['ended'] if record['ended'] is not None else now
    return round(max(0.0, end - record['started']), 2)


def _settle_report(now: float) -> dict | None:
    record = _settle
    if record is None or now < record['started']:  # none yet, or one from an earlier play session
        return None
    speed = record['speed']
    return {'state': record['state'], 'gameSeconds': _elapsed(record, now),
            'speedCmS': round(speed) if speed is not None else None}


def _drive_report(now: float) -> dict | None:
    record = _drive
    if record is None or now < record['started']:
        return None
    progress = record['progress']
    return {'state': record['state'], 'gameSeconds': _elapsed(record, now),
            'progressM': round(max(0.0, progress) / CM_PER_M, 1) if progress is not None else None,
            'route': record['route'] is not None}


def player_state() -> dict:
    """The player's pawn and the play session's clock, the route progress of the latest drive, the settle and the drive."""
    state = play.pawn_state()
    now = play.game_seconds()
    drive = _drive_report(now)
    state.update({'routeProgressM': drive['progressM'] if drive is not None else None,
                  'settle': _settle_report(now), 'drive': drive})
    return state
