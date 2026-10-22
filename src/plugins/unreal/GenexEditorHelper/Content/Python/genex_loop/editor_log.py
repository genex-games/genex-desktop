"""The editor's own log, read from where it ended when a call began: the call flushes the log, notes
its length, does its work, flushes again and reads what was added. A log shorter than the noted
length was started anew meanwhile, so nothing in it can be told apart as the call's own."""

import os

import unreal

LOG_EXTENSION = '.log'


def log_file() -> str | None:
    """The editor's own log: the newest plain .log file in the project's log folder."""
    folder = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_log_dir())
    try:
        with os.scandir(folder) as entries:
            logs = [(entry.stat(follow_symlinks=False).st_mtime_ns, entry.path) for entry in entries
                    if entry.name.endswith(LOG_EXTENSION) and entry.is_file(follow_symlinks=False)]
    except OSError:  # no log folder
        return None
    return max(logs)[1] if logs else None


def log_size(file: str | None) -> int:
    """How long the log is now (0 without one)."""
    try:
        return os.stat(file).st_size if file else 0
    except OSError:
        return 0


def mark() -> tuple[str | None, int]:
    """(the log, its length) once everything logged so far is written: where a call's own lines start."""
    unreal.log_flush()
    file = log_file()
    return file, log_size(file)


def read_since(file: str | None, offset: int, max_bytes: int) -> str:
    """Up to `max_bytes` of what the log gained after `offset`, decoded; '' without a log, or when it shrank."""
    if not file:
        return ''
    try:
        with open(file, 'rb') as handle:
            if os.fstat(handle.fileno()).st_size < offset:
                return ''
            handle.seek(offset)
            return handle.read(max_bytes).decode('utf-8', errors='replace')
    except OSError:
        return ''
