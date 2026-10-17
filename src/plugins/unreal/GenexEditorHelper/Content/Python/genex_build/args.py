"""The build tools' arguments, checked before anything in the editor changes: numbers in range
and finite, counts that are whole numbers, and the compound arguments that come as JSON text
(route points, a palette, an offset) in exactly their shape. Every refusal is a Refused naming
what was wrong."""

import json
import math
from typing import NamedTuple

from genex_loop import paths
from genex_loop.errors import Refused

# The most JSON text a compound argument may be.
MAX_JSON_CHARS = 64 * 1024
# A route: at most this many points, each within this far of the origin (10 km).
MAX_ROUTE_POINTS = 1024
MAX_COORD_CM = 1_000_000.0
# An offset: within this far of its parent (10 m), and a scale in this range.
MAX_OFFSET_CM = 1000.0
SCALE_RANGE = (0.001, 100.0)
OFFSET_KEYS = ('location', 'rotation', 'scale')
PALETTE_KEYS = ('dark', 'light')


class Offset(NamedTuple):
    """Where a component sits on its parent: location (cm), rotation (pitch, yaw, roll degrees), scale."""
    location: tuple
    rotation: tuple
    scale: tuple


NO_OFFSET = Offset((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))


def _is_number(value: object) -> bool:
    """A real int or float (never a bool) that is finite."""
    plain = isinstance(value, (int, float)) and not isinstance(value, bool)
    return plain and math.isfinite(value)


def number(value: object, field: str, low: float, high: float) -> float:
    """A finite number in [low, high], or Refused."""
    if not _is_number(value) or not low <= value <= high:
        raise Refused(f'{field} must be a number from {low:g} to {high:g}.', **{field: repr(value)})
    return float(value)


def count(value: object, field: str, low: int, high: int) -> int:
    """A whole number in [low, high], or Refused."""
    whole = isinstance(value, int) and not isinstance(value, bool)
    if not whole or not low <= value <= high:
        raise Refused(f'{field} must be a whole number from {low} to {high}.', **{field: repr(value)})
    return value


def seed(value: object) -> int:
    """A whole number (never a bool), or Refused."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise Refused('seed must be a whole number.', seed=repr(value))
    return value


def name(value: object, field: str = 'name') -> str:
    """An asset or component name: a letter, then up to 63 letters, digits or _; or Refused."""
    if not paths.is_name(value):
        raise Refused(paths.MESSAGE['name'], **{field: repr(value)})
    return value


def _json(text: object, field: str) -> object:
    """Parsed JSON text without NaN or Infinity, or Refused."""
    if not isinstance(text, str) or len(text) > MAX_JSON_CHARS:
        raise Refused(f'{field} must be JSON text of at most {MAX_JSON_CHARS} characters.')

    def no_constants(constant: str) -> None:
        raise ValueError(f'{constant} is not a number')

    try:
        return json.loads(text, parse_constant=no_constants)
    except ValueError as error:
        raise Refused(f'{field} is not JSON: {error}.') from None


def _triple(value: object, field: str, low: float, high: float) -> tuple:
    """Three finite numbers in [low, high], or Refused."""
    shaped = isinstance(value, list) and len(value) == 3 and all(_is_number(v) for v in value)
    if not shaped or not all(low <= v <= high for v in value):
        raise Refused(f'{field} must be three numbers from {low:g} to {high:g}.')
    return tuple(float(v) for v in value)


def route_points(text: str) -> list:
    """JSON [[x, y, z], ...] (cm): 2 to MAX_ROUTE_POINTS points within MAX_COORD_CM; or Refused."""
    points = _json(text, 'points')
    if not isinstance(points, list) or not 2 <= len(points) <= MAX_ROUTE_POINTS:
        raise Refused(f'points must be a JSON list of 2 to {MAX_ROUTE_POINTS} [x, y, z] points in cm.')
    return [_triple(point, 'Each point', -MAX_COORD_CM, MAX_COORD_CM) for point in points]


def palette(text: str, default: tuple) -> tuple:
    """(dark, light) colours from JSON {"dark": [r, g, b], "light": [r, g, b]} (0 to 1), or the default for ''."""
    if text == '':
        return default
    parsed = _json(text, 'palette')
    if not isinstance(parsed, dict) or sorted(parsed) != sorted(PALETTE_KEYS):
        raise Refused('palette must be JSON {"dark": [r, g, b], "light": [r, g, b]}.')
    return tuple(_triple(parsed[key], f'palette {key}', 0.0, 1.0) for key in PALETTE_KEYS)


def offset(text: str) -> Offset:
    """An Offset from JSON {"location"?: [x, y, z], "rotation"?: [pitch, yaw, roll], "scale"?: [x, y, z]}; '' is none."""
    if text == '':
        return NO_OFFSET
    parsed = _json(text, 'offset')
    if not isinstance(parsed, dict) or not set(parsed) <= set(OFFSET_KEYS):
        raise Refused('offset must be JSON {"location": [x, y, z], "rotation": [pitch, yaw, roll], "scale": [x, y, z]}.')
    location = _triple(parsed.get('location', [0, 0, 0]), 'offset location', -MAX_OFFSET_CM, MAX_OFFSET_CM)
    rotation = _triple(parsed.get('rotation', [0, 0, 0]), 'offset rotation', -360.0, 360.0)
    scale = _triple(parsed.get('scale', [1, 1, 1]), 'offset scale', *SCALE_RANGE)
    return Offset(location, rotation, scale)


def json_list(text: object, field: str) -> list:
    """A JSON list from JSON text, or Refused."""
    parsed = _json(text, field)
    if not isinstance(parsed, list):
        raise Refused(f'{field} must be a JSON list.')
    return parsed


def json_object(text: object, field: str) -> dict | None:
    """A JSON object from JSON text ('' is None), or Refused."""
    if text == '':
        return None
    parsed = _json(text, field)
    if not isinstance(parsed, dict):
        raise Refused(f'{field} must be a JSON object, or empty.')
    return parsed
