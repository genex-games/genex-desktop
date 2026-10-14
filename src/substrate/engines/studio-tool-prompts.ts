/**
 * What a delegated contractor reads about the studio's own tools: their descriptions and the
 * replies a call gets. Claude Code sees them as MCP tools (`claude-code.ts`), Codex as bridge
 * commands (`codex.ts`); the words are the same so both contractors are told the same thing.
 *
 * It also holds what every engine hands a compiled game's session besides its brief: a C++ ·
 * raylib game's (`CppSession`) and a Rust · wgpu game's (`RustSession`) — the store it reads, the
 * shell environment its lock builds with, how long one command may run and, for Rust, the target
 * folder of its own — and the per-stack record every engine reads them through
 * (`compiledSessionOf`), so no engine switches on one stack.
 */
import path from "node:path";
import { deviceToolDirs, withoutDeviceTools } from "../credential-homes.ts";
import { type CompiledStack, GameStack } from "../../shared/game-project.ts";
import { COMMAND_TIMEOUT_MS } from "../../shared/toolchain.ts";
import type { DelegateRequest } from "./types.ts";

/** The studio tools every delegation may be granted, by the name the contractor calls. */
export const StudioTool = {
  Checkpoint: "checkpoint",
  Capture: "capture",
  /** The Loop chat's question tool: it records the question and ends the reply. */
  AskUser: "ask_user",
} as const;
export type StudioTool = (typeof StudioTool)[keyof typeof StudioTool];

/** The studio's own MCP server, as a contractor sees it: every tool is `mcp__studio__<name>`. */
export const STUDIO_MCP_SERVER = "studio";
export const STUDIO_TOOL_PREFIX = `mcp__${STUDIO_MCP_SERVER}__`;

/** The name a contractor calls a studio tool by. */
export function studioToolName(name: string): string {
  return `${STUDIO_TOOL_PREFIX}${name}`;
}

/** `checkpoint`: the contractor decides which moments are worth showing. */
export const CHECKPOINT_TOOL = {
  description:
    "Tell the studio the game just reached a moment worth seeing (it first runs end-to-end, a feature became playable). The studio lights the user's Reload with your note, so they see it the moment they press it.",
  note: "One short sentence: what just became visible or playable.",
  reply: "Shown to the user.",
  /** The studio's own checkpoint (`DelegateRequest.onCheckpoint`) threw: the session reads why and goes on. */
  failed: (why: string) => `The checkpoint failed: ${why}`,
} as const;

/** `capture` as Claude Code reads it: an MCP tool whose answer is a list of frame files. */
export const CLAUDE_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: renders THIS workspace (your uncommitted edits included) in a hidden preview and saves fresh screenshots to files. Returns the file paths — Read them to actually see the frames. Use it after every meaningful change; a defect you catch here is an iteration you do not lose.",
  cameras:
    "Comma-separated camera names to capture (as registered in the studio contract). Omit for your part's own cameras, or every registered camera when it has none.",
  page: "A bench page to capture instead of the game: a .html file in this workspace that mounts just your module (for example bench/<part>.html). It loads in seconds; omit it to capture the game, and capture the game before you finish.",
} as const;

/** `capture` as Codex reads it: a bridge command that prints the frame files. */
export const CODEX_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: renders THIS workspace (your uncommitted edits included) in a hidden preview and saves fresh screenshots to files. Prints the file paths — read them to actually see the frames. Use it after every meaningful change.",
  cameras:
    "Comma-separated camera names as registered in the studio contract. Omit for your part's own cameras, or every camera when it has none.",
  page: "A bench page to capture instead of the game: a .html file in this workspace that mounts just your module (for example bench/<part>.html). Omit it to capture the game, and capture the game before you finish.",
} as const;

/** What a C++ game's capture says of `target`: web, and macos for a Mac game; the rest are said, never claimed. */
const CPP_CAPTURE_TARGET =
  'The destination to build and look at: "web" (the browser build) or "macos" (the Mac build, run headless on this Mac). Omit for the game\'s judging destination. Before you report done, capture web and, when the game is made for the Mac, macos; Windows and Linux builds are not run here yet, so say so instead of claiming them.';

/** `capture` for a C++ · raylib game, as Claude Code reads it: the studio builds before it looks. */
export const CLAUDE_CPP_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: the studio builds THIS workspace (your uncommitted edits included) through its own C++ lane for the destination you name (target; the game's judging destination when omitted), runs it and saves fresh screenshots to files. Returns the file paths — Read them to actually see the frames; a build that fails returns its first compiler error instead, which is the one to fix. Use it after every meaningful change, and on web and (for a Mac game) macos before you finish; never run build/… yourself.",
  cameras: CLAUDE_CAPTURE_TOOL.cameras,
  target: CPP_CAPTURE_TARGET,
} as const;

/** `capture` for a C++ · raylib game, as Codex reads it. */
export const CODEX_CPP_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: the studio builds THIS workspace (your uncommitted edits included) through its own C++ lane for the destination you name (target; the game's judging destination when omitted), runs it and saves fresh screenshots to files. Prints the file paths — read them to actually see the frames; a build that fails prints its first compiler error instead. Use it after every meaningful change, and on web and (for a Mac game) macos before you finish; never run build/… yourself.",
  cameras: CODEX_CAPTURE_TOOL.cameras,
  target: CPP_CAPTURE_TARGET,
} as const;

/** What a Rust game's capture says of `target`: web, and macos for a Mac game; the rest are said, never claimed. */
const RUST_CAPTURE_TARGET =
  'The destination to build and look at: "web" (the browser build) or "macos" (the Mac build, run headless on this Mac). Omit for the game\'s judging destination. Before you report done, capture web and, when the game is made for the Mac, macos; Windows, Linux, iOS and Android builds are not run here, so say so instead of claiming them.';

/** `capture` for a Rust · wgpu game, as Claude Code reads it: the studio builds through its Rust lane before it looks. */
export const CLAUDE_RUST_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: the studio builds THIS workspace (your uncommitted edits included) through its own Rust lane for the destination you name (target; the game's judging destination when omitted), runs it and saves fresh screenshots to files. Returns the file paths — Read them to actually see the frames; a build that fails returns its first cargo diagnostic instead, which is the one to fix. Use it after every meaningful change, and on web and (for a Mac game) macos before you finish; a cargo check in your shell finds type errors faster, but only this build is the game's.",
  cameras: CLAUDE_CAPTURE_TOOL.cameras,
  target: RUST_CAPTURE_TARGET,
} as const;

/** `capture` for a Rust · wgpu game, as Codex reads it. */
export const CODEX_RUST_CAPTURE_TOOL = {
  description:
    "LOOK at your own build: the studio builds THIS workspace (your uncommitted edits included) through its own Rust lane for the destination you name (target; the game's judging destination when omitted), runs it and saves fresh screenshots to files. Prints the file paths — read them to actually see the frames; a build that fails prints its first cargo diagnostic instead. Use it after every meaningful change, and on web and (for a Mac game) macos before you finish; a cargo check in your shell finds type errors faster, but only this build is the game's.",
  cameras: CODEX_CAPTURE_TOOL.cameras,
  target: RUST_CAPTURE_TARGET,
} as const;

// ── a C++ · raylib game's session ──────────────────────────────────────────────────────────

/** How long one shell command of a C++ session may run: the raylib row of the per-stack table. */
export const CPP_COMMAND_TIMEOUT_MS = COMMAND_TIMEOUT_MS[GameStack.RaylibCpp];

/**
 * What the host hands a C++ · raylib game's session besides its brief (`DelegateRequest.cpp`).
 * Absent for a Three.js game, whose sessions are exactly what they were.
 */
export interface CppSession {
  /** The toolchain store: readable, and never writable by the session's tools or shell. */
  store: string;
  /** Folders put ahead of the login PATH: the lock's CMake and Ninja, and for the web emcc and its Node. */
  path: string[];
  /** The rest of the lock's C++ environment: GENEX_CMAKE, EM_CONFIG, an EM_CACHE of the session's own, … (never PATH). */
  env: Record<string, string>;
  /** How long one shell command may run (`CPP_COMMAND_TIMEOUT_MS`). */
  commandTimeoutMs: number;
}

/** The shell every compiled stack's session carries: the store it reads, its tools and variables, its command timeout. */
export type CompiledShell = Pick<CppSession, "store" | "path" | "env" | "commandTimeoutMs">;

/**
 * A compiled session's shell environment: the lock's variables, and its tools ahead of the login
 * `PATH`, which loses the Android SDK's device tools (C1): `adb` and `emulator` never resolve there.
 */
export function compiledShellEnv(
  session: CompiledShell,
  loginPath: string | null | undefined,
  deviceTools: readonly string[] = deviceToolDirs(),
): Record<string, string> {
  const login = withoutDeviceTools(loginPath ?? "", deviceTools, path.delimiter)
    .split(path.delimiter)
    .filter(Boolean);
  return { ...session.env, PATH: [...new Set([...session.path, ...login])].join(path.delimiter) };
}

/** A C++ session's shell environment ({@link compiledShellEnv}, by the name it had before Rust). */
export const cppShellEnv = compiledShellEnv;

/**
 * How a C++ session builds in its own shell, exactly as said to it. CMake reads `GENEX_CMAKE` as a
 * cache variable and never from the environment, so the configure passes it on; the generator and
 * (for the web) the toolchain file come from the environment the host set. `build/` is scratch.
 */
export const CPP_SHELL_BUILD = {
  configure: 'cmake -S . -B build -DGENEX_CMAKE="$GENEX_CMAKE"',
  build: "cmake --build build",
} as const;

/** The variables of a session's environment a model reads about, in the order it is told them. */
const TOLD_VARIABLES = ["GENEX_CMAKE", "CMAKE_TOOLCHAIN_FILE", "EM_CONFIG", "EM_CACHE"] as const;

/** `a`, `a and b`, `a, b and c`. */
function spokenList(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What a session on a C++ · raylib game is told about its shell when its engine takes no command
 * timeout of the host's (Codex), from what the host actually set: the tools first on PATH, the
 * variables, the configure line, how long a command may run and that the store is for reading. A
 * store with no prewarm for the session's destination sets nothing: capture is then its only build.
 */
export function cppShellNote(cpp: CppSession): string {
  const store = `The toolchain store (${cpp.store}) is read-only.`;
  if (!cpp.path.length || !cpp.env.GENEX_CMAKE)
    return `C++ TOOLCHAIN: the studio has no toolchain ready for your shell, so build only with the capture tool, which builds through the studio's own lane and says what is missing. ${store}`;
  const tools = cpp.env.EM_CONFIG ? "CMake, Ninja and emcc" : "CMake and Ninja";
  const variables = spokenList(TOLD_VARIABLES.filter((name) => cpp.env[name]));
  return `C++ TOOLCHAIN: your shell has the studio's ${tools} first on PATH, with ${variables} set. To compile in your shell, configure with \`${CPP_SHELL_BUILD.configure}\` (CMake never reads GENEX_CMAKE from the environment) and build with \`${CPP_SHELL_BUILD.build}\`; build/ is scratch. A configure or a first build can take minutes: give such a command a timeout of up to ${cpp.commandTimeoutMs} ms. Prefer the capture tool, which builds through the studio's own lane. ${store}`;
}

// ── a Rust · wgpu game's session ───────────────────────────────────────────────────────────

/** How long one shell command of a Rust session may run: the Rust row of the per-stack table. */
export const RUST_COMMAND_TIMEOUT_MS = COMMAND_TIMEOUT_MS[GameStack.RustWgpu];

/** The variables of a Rust session's environment the studio names itself (cargo's own keep cargo's names). */
export const RustSessionVariable = {
  /** The host-written `Cargo.toml` the session checks with: a game folder holds none. */
  Manifest: "GENEX_CARGO_MANIFEST",
} as const;
export type RustSessionVariable = (typeof RustSessionVariable)[keyof typeof RustSessionVariable];

/**
 * What the host hands a Rust · wgpu game's session besides its brief (`DelegateRequest.rust`):
 * the store's cargo on PATH, the store's CARGO_HOME (read-only, offline over the vendored crates)
 * and a CARGO_TARGET_DIR of the session's own, cloned from the prewarmed dependency build. A store
 * with no prewarm for the session's destination sets nothing: capture is then its only build.
 */
export interface RustSession extends CompiledShell {
  /** Folders put ahead of the login PATH: the lock's sysroot `bin` (cargo, rustc). */
  path: string[];
  /** CARGO_HOME, CARGO_TARGET_DIR, CARGO_BUILD_TARGET, CARGO_ENCODED_RUSTFLAGS, RUSTC, GENEX_CARGO_MANIFEST, … (never PATH). */
  env: Record<string, string>;
  /** The session's own target folder (`CARGO_TARGET_DIR`): the one folder it writes besides its workspace; null when nothing was set. */
  targetDir: string | null;
}

/**
 * How a Rust session checks its game in its own shell, exactly as said to it: the host's manifest
 * names the workspace's `src/main.rs`, cargo reads only the store's vendored crates, and the lock
 * the host wrote is the one used.
 */
export const RUST_SHELL_CHECK = {
  check: `cargo check --offline --locked --manifest-path "$${RustSessionVariable.Manifest}"`,
} as const;

/**
 * What a session on a Rust · wgpu game is told about its shell when its engine takes no command
 * timeout of the host's (Codex), from what the host actually set.
 */
export function rustShellNote(rust: RustSession): string {
  const store = `The toolchain store (${rust.store}) is read-only, its CARGO_HOME with it.`;
  const ready = rust.path.length > 0 && rust.targetDir !== null && Boolean(rust.env[RustSessionVariable.Manifest]);
  if (!ready)
    return `RUST TOOLCHAIN: the studio has no Rust toolchain ready for your shell, so check only with the capture tool, which builds through the studio's own Rust lane and says what is missing. ${store}`;
  return `RUST TOOLCHAIN: your shell has the studio's cargo and rustc first on PATH, with CARGO_HOME (the studio's, offline over the vendored crates), CARGO_TARGET_DIR (your own, ${rust.targetDir}: the one folder outside your workspace you write), CARGO_BUILD_TARGET and ${RustSessionVariable.Manifest} set. Your game folder holds no Cargo.toml and must not: to type-check in your shell, run \`${RUST_SHELL_CHECK.check}\` (the studio wrote that manifest from genex.toml when this session started). A first check can take minutes: give it a timeout of up to ${rust.commandTimeoutMs} ms. Prefer the capture tool, which builds through the studio's own Rust lane. ${store}`;
}

declare module "./types.ts" {
  interface DelegateRequest {
    /** A C++ · raylib game's session (`CppSession`): set by the host only, absent for a Three.js game. */
    cpp?: CppSession;
    /** A Rust · wgpu game's session (`RustSession`): set by the host only, never beside `cpp`. */
    rust?: RustSession;
  }
}

// ── the per-stack record every engine reads ───────────────────────────────────────────────

/**
 * A capture tool's words: its description, its cameras parameter and, for a compiled game, its
 * target; for a Three.js game, its bench page.
 */
export interface CaptureToolWords {
  description: string;
  cameras: string;
  target?: string;
  page?: string;
}

/**
 * A compiled game's session as every engine reads it: its stack, its shell, the folders its own
 * tools write besides its workspace, and what it is told. Engines read this, never `cpp`/`rust`.
 */
export interface CompiledSession {
  stack: CompiledStack;
  shell: CompiledShell;
  /** Folders the session's tools write besides its workspace (Codex's writable roots): a web C++ session's Emscripten cache, a Rust session's target folder. */
  writes: string[];
  /** The same for a local engine's commands (its sandbox's `allowWrite`). */
  localWrites: string[];
  claudeCapture: CaptureToolWords;
  codexCapture: CaptureToolWords;
  /** What a session whose engine takes no command timeout of the host's (Codex) is told of its shell. */
  shellNote: string;
}

/** The capture words of each compiled stack. */
const COMPILED_CAPTURE = {
  [GameStack.RaylibCpp]: { claude: CLAUDE_CPP_CAPTURE_TOOL, codex: CODEX_CPP_CAPTURE_TOOL },
  [GameStack.RustWgpu]: { claude: CLAUDE_RUST_CAPTURE_TOOL, codex: CODEX_RUST_CAPTURE_TOOL },
} as const satisfies Record<CompiledStack, { claude: CaptureToolWords; codex: CaptureToolWords }>;

/** A C++ session's record: Codex writes its Emscripten cache, a local engine's commands write nothing more (as before). */
function cppCompiled(cpp: CppSession): CompiledSession {
  const cache = cpp.env.EM_CACHE;
  const { claude, codex } = COMPILED_CAPTURE[GameStack.RaylibCpp];
  return {
    stack: GameStack.RaylibCpp,
    shell: cpp,
    writes: cache ? [cache] : [],
    localWrites: [],
    claudeCapture: claude,
    codexCapture: codex,
    shellNote: cppShellNote(cpp),
  };
}

/** A Rust session's record: every engine's tools write its own target folder, and nothing else. */
function rustCompiled(rust: RustSession): CompiledSession {
  const writes = rust.targetDir ? [rust.targetDir] : [];
  const { claude, codex } = COMPILED_CAPTURE[GameStack.RustWgpu];
  return {
    stack: GameStack.RustWgpu,
    shell: rust,
    writes,
    localWrites: writes,
    claudeCapture: claude,
    codexCapture: codex,
    shellNote: rustShellNote(rust),
  };
}

/** The compiled session a request carries, or null for a Three.js game's. */
export function compiledSessionOf(request: Pick<DelegateRequest, "cpp" | "rust">): CompiledSession | null {
  if (request.cpp) return cppCompiled(request.cpp);
  if (request.rust) return rustCompiled(request.rust);
  return null;
}

/** What a Loop chat's bridged tool answers: it only records; the harness runs the real thing once the reply ends. */
const INTAKE_REPLY = {
  question:
    "Question recorded. End your reply now; the user's answer arrives in the next turn. Do not launch a run or repeat the question in prose.",
  launch:
    "Recorded — the studio launches this when your reply ends. Do not call this tool again and do not edit any more files; end with a short recap.",
} as const;

/** The answer a delegated contractor gets for calling bridged tool `name` (a launch, or `ask_user`). */
export function intakeToolReply(name: string): string {
  return name === StudioTool.AskUser ? INTAKE_REPLY.question : INTAKE_REPLY.launch;
}
