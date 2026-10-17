"""A stand-in for Epic's toolset_registry. Like Epic's, a tool that fails outside raising mode
reports a script error (which fails the whole MCP call) and returns None instead of raising."""

import contextlib
import functools

import unreal

_raising = [False]


def tool_call(func):
    """Marks one of the helper's own tools; the stub leaves it as it is."""
    return func


@contextlib.contextmanager
def tool_raising_exceptions():
    before = _raising[0]
    _raising[0] = True
    try:
        yield
    finally:
        _raising[0] = before


def epic_tool(func):
    """How Epic's tool_call wraps its own tools (BlueprintTools and the like)."""

    @functools.wraps(func)
    def wrapped(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception as error:
            if _raising[0]:
                # Epic's ufunction wrapper raises a RuntimeError carrying the whole traceback.
                trace = '  File "blueprint.py", line 1, in create\n    raise error\n'
                raise RuntimeError(f'BlueprintTools: Traceback (most recent call last):\n{trace}'
                                   f'{type(error).__name__}: {error}\n  in: create') from None
            unreal.SystemLibrary.raise_script_error(str(error))
            return None

    return wrapped
