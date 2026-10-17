"""The play session (PIE) as the queue sees it: whether it runs and its clock, ending it, and the
actors the Loop checks inside it: the parts' (GenexPart:<part>) and the live builder's features'
(genex:<feature>), with the player."""

import unreal

from genex_loop import editor, paths
from genex_play import motion, play

ACTORS_CAP = 200
# The live builder tags what each feature adds genex:<feature> (genex:terrain, genex:route).
GENEX_TAG_PREFIX = 'genex:'


def play_state() -> dict:
    """{pie, world, gameSeconds, fps}: whether a play session runs, its world's name, its game clock and frame rate."""
    world = editor.play_world()
    if world is None:
        return {'pie': False, 'world': None, 'gameSeconds': None, 'fps': None}
    return {'pie': True, 'world': world.get_name(), 'gameSeconds': round(play.game_seconds(), 2), 'fps': play.fps()}


def stop_play() -> dict:
    """Lets go of every held input and asks the play session to end (it ends on a later frame)."""
    released = play.release_all()
    running = editor.play_world() is not None
    if running:
        editor.levels().editor_request_end_play()
    return {'stopping': running, 'released': released}


def _is_listed(actor: unreal.Actor, tag: str) -> bool:
    """Whether the actor carries the part's tag, or with no part, any part's or feature's tag."""
    names = [str(t) for t in actor.tags]
    if tag:
        return tag in names
    return any(name.startswith((editor.PART_TAG_PREFIX, GENEX_TAG_PREFIX)) for name in names)


def _actor_row(actor: unreal.Actor) -> dict:
    location = actor.get_actor_location()
    rotation = actor.get_actor_rotation()
    return {'label': actor.get_actor_label(), 'class': actor.get_class().get_name(),
            'location': [round(location.x), round(location.y), round(location.z)],
            'rotation': [round(rotation.pitch, 1), round(rotation.yaw, 1), round(rotation.roll, 1)],
            'hidden': bool(actor.get_editor_property('hidden')),
            'tags': [str(t) for t in actor.tags if str(t).startswith(GENEX_TAG_PREFIX)]}


def _player() -> dict | None:
    try:
        return motion.player_state()
    except RuntimeError:  # no player or pawn yet
        return None


def _genex_tags(actors: list) -> dict:
    """How many of the actors carry each genex: tag: every one counted, the ones past the rows' cap too."""
    counts: dict = {}
    for actor in actors:
        for name in {str(t) for t in actor.tags if str(t).startswith(GENEX_TAG_PREFIX)}:
            counts[name] = counts.get(name, 0) + 1
    return counts


def game_state(part: str) -> dict:
    """The part's actors (every part's and feature's when part is ''), from the play world during play;
    at most ACTORS_CAP rows, with how many genex:-tagged actors carry each tag (a tag check reads that)."""
    if part:
        paths.check_part(part)
    world = editor.play_world()
    pie = world is not None
    if not pie:
        world = editor.editor_subsystem().get_editor_world()
    tag = str(editor.part_tag(part)) if part else ''
    found = [a for a in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor) if _is_listed(a, tag)]
    return {'pie': pie, 'player': _player() if pie else None,
            'actors': [_actor_row(a) for a in found[:ACTORS_CAP]], 'more': max(0, len(found) - ACTORS_CAP),
            'tags': _genex_tags(found)}
