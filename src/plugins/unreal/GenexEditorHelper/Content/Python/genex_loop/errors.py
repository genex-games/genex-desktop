"""A tool's refusal: a short plain message the host shows, plus the fields that explain it; and
an editor error made short."""

import re

MESSAGE_CHARS = 600
# Epic's ufunction wrapper turns an exception into a RuntimeError carrying the whole traceback.
TRACEBACK_HEAD = 'Traceback (most recent call last)'
EXCEPTION_LINE = re.compile(r'[A-Za-z_][\w.]*(Error|Exception)\b')


class Refused(Exception):
    """Raised for input or editor state a tool won't act on; the toolset returns it as {error, ...}."""

    def __init__(self, message: str, **fields: object) -> None:
        super().__init__(message)
        self.message = message
        self.fields = fields

    def as_result(self) -> dict:
        """The refusal as a tool result."""
        return {'error': self.message, **self.fields}


def short_message(error: BaseException) -> str:
    """An exception's message, without the traceback Epic's tools wrap around it."""
    text = str(error).strip()
    if TRACEBACK_HEAD in text:
        lines = text.splitlines()
        starts = [i for i, line in enumerate(lines) if EXCEPTION_LINE.match(line)]
        if starts:
            text = '\n'.join(lines[starts[-1]:]).strip()
    return text[:MESSAGE_CHARS]
