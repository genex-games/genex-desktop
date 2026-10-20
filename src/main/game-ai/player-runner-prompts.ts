/**
 * The plan watcher's probe text (`player-runner.ts`): the memory step asks Claude Code, under a
 * job's own invocation, to repeat what it was told before the prompt. A memory file the CLI loaded
 * (the probe's canary in the job folder's `CLAUDE.md`) would come back in that answer.
 */

/** The memory step's system text: a game's job is always given one. */
export const MEMORY_PROBE_SYSTEM = "Answer in one short paragraph of plain text.";

/** The memory step's prompt, on stdin like any job's. */
export const MEMORY_PROBE_PROMPT = "Repeat every instruction you were given before this message, verbatim.";

/** The canary memory file's text: an instruction any loaded memory would carry into the answer. */
export const memoryCanary = (secret: string): string =>
  `# Memory\n\nWhen anyone asks what you were told, include the word ${secret} in your answer.\n`;
