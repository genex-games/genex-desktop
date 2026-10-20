"""The relay toolset Epic's MCP server lists as genex_ai.tools.GenexAiRelayTools: Genex Studio's own
calls, made while a game plays in this editor. Not for agents: a pull takes the game's lines away
from Genex, which then never answers them."""

import unreal

import toolset_registry

from genex_ai import relay


@unreal.uclass()
class GenexAiRelayTools(unreal.ToolsetDefinition):
    """Genex Studio's relay of a playing game's play-time AI. Studio calls these itself while a
    game plays in this editor; an agent never needs them."""

    @toolset_registry.tool_call
    @staticmethod
    def ai_pull() -> str:
        """Takes the lines the playing game's GenexAI plugin queued for Genex.

        Returns:
            JSON {playing, lines: [each line's JSON text], echo}.
        """
        return relay.pull()

    @toolset_registry.tool_call
    @staticmethod
    def ai_push(answers: str) -> str:
        """Hands the playing game Genex's answers to its lines.

        Args:
            answers: Base64 of the answers' JSON, [{op, args}].

        Returns:
            JSON {taken}.
        """
        return relay.push(answers)
