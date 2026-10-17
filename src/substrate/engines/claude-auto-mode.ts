/**
 * The studio's rules for Claude Code's Auto classifier: the settings key `autoMode`, which every
 * session that asks carries (a game chat's own session, a build's lead, the run's coordinator, a
 * worker of the chat's lead) and
 * which only Auto reads (and Plan, where it runs with Auto's semantics).
 *
 * Auto should let a person building a game have everything ordinary game work needs without a
 * question, and keep stopping what is truly dangerous. Claude Code's own rules already do the
 * second; the studio only adds what the classifier cannot know from the transcript (the person's
 * own Mac, the person in the chat, the game folder's checkpoints) and narrows the built-in blocks
 * that everyday game work trips: each entry names the blocks it narrows and what stays blocked.
 * The soft and hard blocks themselves stay as Claude Code ships them, so a CLI update's new
 * protections apply unchanged.
 *
 * The CLI reads `autoMode` only from user, flag (the SDK's `settings`) and managed settings, never
 * from a game's own `.claude` files; `"$defaults"` keeps its built-in entries in place (a list
 * without it replaces them). It sends the same rules to the server-side classifier.
 */

/** Claude Code's placeholder for its built-in entries of a list. */
const BUILT_IN = "$defaults";

/**
 * The most the rules may weigh, in characters of the settings JSON: the SDK hands every setting
 * to the CLI as one command-line argument (`HOME_FENCE_BUDGET` in claude-permissions.ts), and the
 * classifier reads them on every call.
 */
export const AUTO_MODE_BUDGET = 3_000;

/** Where a session that asks works, as its Auto rules describe it. */
export interface AutoModeSeat {
  /** Its working folder, absolute. */
  cwd: string;
  /**
   * True for the game chat's own session in its game folder, which the studio checkpoints before
   * each message it answers (`main/chat-checkpoints.ts`) and the chat's Rewind restores. False for
   * a build's lead or the run's coordinator, whose edits are not checkpointed that way.
   */
  gameFolder: boolean;
  /** A worker of the chat's lead: boxed, prompted by the lead, its work merged by the lead. */
  worker?: boolean;
}

/** What the classifier reads about where the session runs and who prompts it. */
function sessionFacts(seat: AutoModeSeat): string[] {
  if (seat.worker)
    return [
      "**AI Game Studio**: A game chat on the person's own Mac. The person chose Auto and expects ordinary game-development work done without asking; this session's prompts come from the chat's lead, not from them.",
      "**Worker session**: This session is a worker of the chat's lead on the person's Mac, in a sandbox that writes only its own folders; the lead merges its work. The game folder is checkpointed before each of the person's messages.",
    ];
  if (seat.gameFolder)
    return [
      "**AI Game Studio**: A game chat on the person's own Mac, no sandbox. The person is in the chat, chose Auto, and expects ordinary game-development work done without asking.",
      `**Game folder**: ${seat.cwd}, the working directory and trusted repo, is the person's game. Before each message the studio checkpoints under refs/studio/ the files git does not ignore (not .env*, nested repos or files over 50 MB); Rewind restores them while HEAD stays put.`,
    ];
  return [
    "**AI Game Studio**: A game chat on the person's own Mac, no sandbox. The person chose Auto and expects ordinary game-development work done without asking; while a build runs they may be away, and this session's prompts come from the studio's build loop, not from them.",
    "**Build session**: This session leads or answers for a build of the person's game. A lead edits and commits in the run's integration worktree, the build's workers change the game in worktrees of their own, and the studio lands the work in the game folder; its own edits there are not checkpointed.",
  ];
}

/** The session's `autoMode` settings: environment facts and carve-outs, on top of Claude Code's own. */
export function autoModeRules(seat: AutoModeSeat): { environment: string[]; allow: string[] } {
  return {
    environment: [
      BUILT_IN,
      ...sessionFacts(seat),
      "**Download sources**: Public package registries, CDNs, GitHub and font, sound or asset sites are ordinary download sources, not trusted destinations for the person's data (the game's own remote stays trusted).",
    ],
    allow: [
      BUILT_IN,
      ...(seat.gameFolder
        ? [
            "Game Folder Work: Deleting, overwriting, moving or regenerating checkpointed files in the game folder, and its build output, caches or node_modules, is recoverable: not Irreversible Local Destruction. Not: other ignored files, git clean -x, .git, refs/studio, .git.studio-backup, .studio, .env*, nested repos, files over 50 MB, paths or symlinks leading outside.",
          ]
        : []),
      "Game Toolchain: Installing and running well-known public packages, scaffolders, templates and headless browsers the game needs, declared or not, narrows Code from External and Untrusted Code Integration. Not: names picked only from fetched pages or tool output, curl|sh beyond Toolchain Bootstrap, sudo, obscure or look-alike names.",
      "Game Test Servers: Dev servers, directory servers on 127.0.0.1, local game backends and headless browsers (GPU or WebGL flags included) on the game's local page, and stopping ones the agent started or the process listening on its dev port, narrow Expose Local Services, Create RCE Surface, Safety Bypass Flag and Interfere With Workloads. Not: directory servers on all interfaces or LAN binds the person did not ask for, code-running endpoints beyond loopback, public tunnels, the person's own browser profile, killing by bare name or other processes.",
      "Person's Assets: Reading folders the person points to, looking in Downloads, Desktop, Pictures, Music or other games for an asset the person described, and copying those files into the game narrows Sensitive-Source Provenance and PII Data Handling. Not: wildcard or whole-folder sweeps of home folders, documents, scans, screenshots or keys the person did not point to, credential stores, keychains, browser profiles, .env values, the studio's folders, or sending any of it off the Mac.",
      "Game Notes and Builds: Writing conventions into the game's own CLAUDE.md, AGENTS.md, NOTES and docs narrows Instruction Poisoning; production builds or packaging on this Mac are not deploys (narrows Production Deploy). Not: text that grants permissions or weakens checks, uploading a build.",
    ],
  };
}
