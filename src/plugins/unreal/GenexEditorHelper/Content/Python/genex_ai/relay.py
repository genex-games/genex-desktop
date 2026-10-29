"""Genex Studio's relay of a playing game's play-time AI: the lines the game's GenexAI plugin queued
go to Studio, and Studio's answers go back to the game, through the editor's own port. The game's
plugin holds the queue (UGenexAiRelayLibrary); a project without it plays nothing here."""

import json

import unreal

NOT_PLAYING = json.dumps({'playing': False, 'lines': []})


def _library():
    """The GenexAI plugin's relay, or None in a project without the plugin."""
    return getattr(unreal, 'GenexAiRelayLibrary', None)


def pull() -> str:
    """{playing, lines, echo} as JSON text: whether a game plays, and each line it queued since."""
    library = _library()
    if library is None:
        return NOT_PLAYING
    return library.pull()


def push(answers: str) -> str:
    """Hands the playing game Studio's answers (base64 of their JSON); {taken} as JSON text."""
    library = _library()
    taken = bool(library.push(answers)) if library is not None else False
    return json.dumps({'taken': taken})
