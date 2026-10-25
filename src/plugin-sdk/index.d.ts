/**
 * Studio plugin SDK — the typed contract a plugin is written against.
 *
 * Self-contained on purpose: a plugin package is built outside this repository, so nothing here
 * imports from `src/shared` or any other Studio path. `PluginManifest` below is a mirror of
 * `src/shared/plugins.ts`; `tests/conformance/plugin-sdk-types.test.ts` compiles the two against
 * each other in both directions, so a change to one that is not mirrored fails the suite.
 *
 * API 2 is additive over API 1. New manifest sections arrive as further optional fields; nothing
 * documented here is removed.
 *
 * A backend written in JavaScript points its JSDoc at the copy of this file it ships beside:
 * `@type {import('./plugin-sdk/index.d.ts').Activate}` on `export const activate`. One in
 * TypeScript imports `Activate` from the same path. Either way the host-service names, the
 * activation shape and the panel bridge are checked before anyone installs the package.
 */

/** API 3. Runtime names and launch recipes come from reviewed plugin code, never tool inputs. */
export interface PluginNativeRuntime {
  id: string;
  label: string;
  candidates: string[];
  version: { args: string[]; pattern: string; minimum: string };
  /** The pinned download, for a Mac with Apple silicon unless it names another `platform`. */
  install?: PluginRuntimePin;
  /** Pinned downloads for other computers, one per `platform`. */
  installs?: PluginRuntimePin[];
}
/** One pinned runtime download behind a confirmed setup action, for one kind of computer. */
export interface PluginRuntimePin {
  action: string;
  url: string;
  sha256: string;
  bytes: number;
  unpackedBytes: number;
  format: "dmg" | "tar.gz" | "zip";
  entry: string;
  executable: string;
  notices: string[];
  /** The computer this download runs on; left out, a Mac with Apple silicon. */
  platform?: "darwin-arm64" | "win32-x64" | "win32-arm64";
}
export type PluginNativeArg = string | { source: "package" | "input" | "output" | "value"; name: string };
export interface PluginNativeJob {
  id: string;
  runtime: string;
  args: PluginNativeArg[];
  inputs: string[];
  values: Record<string, { pattern: string; maxLength: number }>;
  outputs: string[];
  /** Integer milliseconds, 1000–300000. Expiry terminates the local process. */
  timeoutMs: number;
  /** Retained stdout/stderr tail per stream, 1–256000 bytes. This is not the asset size. */
  maxOutputBytes: number;
  /** Maximum aggregate bytes in declared generated files, 1–104857600. */
  maxAssetBytes: number;
  /** Needed for GPU rendering, including Blender EEVEE; permits the runtime's Metal cache, and lets Metal's compiler use it. */
  gpu?: boolean;
}
/**
 * `sandbox.run`: the program (inside one of `reads`), its arguments, the folders it reads, the real
 * folders inside the bound game it writes, variables Genex sets to a scratch folder of the job's own,
 * further variables, and a deadline of 1000 ms to 60 minutes. On Windows, Genex's sandbox grants
 * writes for its whole session: `writes` is what the job asks for, not a per-job fence.
 */
export interface PluginSandboxRunArgs {
  program: string;
  args: string[];
  reads: string[];
  writes: string[];
  scratchEnv?: string[];
  env?: Record<string, string>;
  timeoutMs: number;
}
/** A sandbox job: running, exited (with its exit code), timed out, stopped, or failed to start. */
export interface PluginSandboxJob {
  id: string;
  state: "running" | "exited" | "timed-out" | "stopped" | "failed";
  exitCode?: number | null;
  /** The last 4 MiB of each stream, where a long log ends with its verdict; `truncated` when cut. */
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  seconds?: number;
  reason?: string;
}
export interface PluginNativeStatus {
  state: "ready" | "missing" | "incompatible" | "failed";
  path?: string;
  version?: string;
  detail: string;
  /** The pinned download for this computer, when the runtime has one: its setup action and size. */
  download?: { action: string; url: string; bytes: number };
}
export interface PluginRuntimeInstall {
  runtime: string;
  phase: "preflight" | "downloading" | "verifying" | "extracting" | "ready" | "failed" | "cancelled" | "interrupted";
  completed: number;
  total: number;
  active: boolean;
  updatedAt: string;
  error?: string;
}
export interface PluginNativeResult {
  inputs?: Record<string, { file: string; sha256: string }>;
  id: string;
  recipe: string;
  runtime: string;
  version?: string;
  state: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  project: string;
  output: string;
  files: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  reason?: string;
  createdAt: string;
  finishedAt?: string;
}

export type PluginApiVersion = 1 | 2 | 3;
export type PluginScalar = string | number | boolean;

/** Host services a manifest may declare. `export` is API 2. */
export type PluginCapability =
  | "settings"
  | "project.read"
  | "project.write"
  | "credentials"
  | "external-auth"
  | "observe"
  | "jobs"
  | "network"
  | "export"
  | "native-runtime"
  | "game-engine";

export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string; acceptJsonString?: boolean }>;
    required?: string[];
  };
  /** API 2: the tool needs the user's consent before it runs. 1–300 characters. */
  confirmation?: string;
}

/**
 * A program Studio itself runs for a manifest tool instead of your backend. Reserved for the
 * bundled Genex plugin on API 3; any other plugin that names one is refused.
 */
export type PluginHostTool = "genex-cli" | "genex-cli-paid" | "genex-package";

/**
 * Who may call a tool (API 3): `agents`, the default, or `harness`: only Genex's own harness loop
 * calls it by name, and no agent, chat or plan is handed it or told of it.
 */
export type PluginToolAudience = "agents" | "harness";

/** The kinds of asset Genex draws while one is being made. */
export type PluginAssetKind =
  | "character"
  | "creature"
  | "model"
  | "rigged-model"
  | "animation"
  | "image"
  | "texture"
  | "video"
  | "sound-effect"
  | "music"
  | "voice";

/**
 * API 3: what a call of a tool makes. While the call runs, Genex shows it as a card of that kind on
 * the Assets canvas and in the chat, in the spot its files will land, with the tool's name (`tool`,
 * else your plugin's), your plugin's icon, and the argument named `prompt` (default `prompt`) as
 * what was asked. An MCP server says the same per tool in its `tools/list` entry, as
 * `_meta: { "genex/asset": { kind, prompt?, tool? } }`. It changes how a call is shown, nothing else.
 */
export interface PluginToolAsset {
  kind: PluginAssetKind;
  /** The argument that says what to make: one of the tool's parameters, at most 64 characters. */
  prompt?: string;
  /** The outside service doing the work, when your plugin is a front for one (at most 40 characters). */
  tool?: string;
}

/** A tool as your manifest declares it. Agents see it as a plain `PluginTool`. */
export interface PluginManifestTool extends PluginTool {
  /** Reserved for the bundled Genex plugin. */
  host?: PluginHostTool;
  /** API 3: who may call the tool; agents when absent. */
  audience?: PluginToolAudience;
  /**
   * API 3, with `confirmation`: one of the tool's string parameters the person may edit on its card,
   * shown under the question in a field labelled `label` (one plain line, at most 60 characters).
   * Their Allow runs the call with what the field holds (one plain line, 1–200 characters).
   */
  confirmationInput?: { parameter: string; label: string };
  /** API 3, agent tools only: the kind of asset a call makes. */
  asset?: PluginToolAsset;
  /**
   * API 3: the longest one call may run, in whole milliseconds, when that is longer than the host's
   * ceiling (190 s): a game engine's import or export. At most 9 minutes.
   */
  timeoutMs?: number;
}

/**
 * An engine a game builds in: `web` (three.js in the browser, every game unless Genex linked it to
 * an engine project), `unreal` or `godot`. A skill that names engines (non-empty, each once) reaches only
 * those games' briefs, so web-only advice never reaches an Unreal game.
 */
export type PluginGameEngine = "web" | "unreal" | "godot";

/** What an engine's editor can do in play (`engine.play`); absent fields are the editor defaults. */
export interface PluginEnginePlay {
  /** The most players one play opens, 1–8. */
  players?: number;
  clock?: "none" | "freeze" | "step-locked" | "replayable";
  /** Whether the mouse aims as a player's does. */
  pointer?: boolean;
  /** Whether the game's state can be read in play. */
  state?: boolean;
}

/**
 * API 3, capability `game-engine`: the engine your plugin declares (`engine` in the manifest).
 * - `id` is your plugin's own id (2–40 lowercase letters, digits and dashes), never `web`.
 * - `label` is the engine's name as people read it, 1–40 characters on one line.
 * - `projectFiles` lists 1–4 project files a game may link, each an extension of one or two
 *   lowercase dotted parts (`.uproject`, `.project.json`) or, for a project that is a folder marked
 *   by one fixed file, that file's whole lowercase name (`project.godot`: the project is named by
 *   its folder).
 * - `fact` is the fact a linked game holds: one your `detect` declares, or one of Genex's own.
 * - `projectInFolder` is true when the Loop needs the project inside the game folder, because its
 *   save points hold it.
 * - `writesProjectFiles` is true when your agents change the project as files (scenes, scripts):
 *   a linked project outside the game folder is then a folder the game's sessions read and write.
 * - `apps` names the apps your editor runs as (Mac bundle ids, Windows `.exe` names, at most 4
 *   each): computer use never drives them to build or play.
 */
export interface PluginEngineDeclaration {
  id: string;
  label: string;
  projectFiles: string[];
  fact: string;
  projectInFolder: boolean;
  writesProjectFiles?: boolean;
  play?: PluginEnginePlay;
  apps?: { mac?: string[]; windows?: string[] };
}

/**
 * API 3, beside an `engine`: a blind judge that plays your engine's games in its editor (`judges` in
 * the manifest, at most 8). It never sees code and answers from playing.
 * - `id` 2–40 lowercase letters, digits and dashes, unique in the manifest; `label` 1–40 characters.
 * - `facts` the facts of the games it judges (none: every game your plugin plays in its editor).
 * - `brief` a Markdown file in your package (at most 16 000 characters), added to the judge's rubric.
 * - `players` how many players its play opens, 1 to your `engine.play.players` (one when absent).
 * - `probe` one of your harness tools that asks nothing, runs no host program and needs every lock
 *   `play-open` needs; Genex runs it once right after the judge's play opens, and its `note` and
 *   `images` (measurements and pictures, never source) open the judge's first answer.
 */
export interface PluginJudge {
  id: string;
  label: string;
  facts?: string[];
  brief: string;
  players?: number;
  probe?: string;
}

/** A skill whose text sits in the manifest (1–16 000 characters); agents get all of it in their brief. */
export interface PluginInlineSkill {
  name: string;
  text: string;
  /** API 3: the engines whose games' briefs carry this skill; every engine when absent. */
  engines?: PluginGameEngine[];
}

/**
 * API 3: a skill whose text is a Markdown file in your package (at most 128 KiB, 1 MiB for all
 * skill files together). Agents get the summary in their brief and read the file, and its
 * references, on demand through the host's `<pluginId>__skill` tool, so a manifest with a file
 * skill may not declare a tool named `skill`. Paths are package-relative, end in `.md` and never
 * pass through a dot folder.
 */
export interface PluginFileSkill {
  name: string;
  /** 1–300 characters. */
  summary: string;
  file: string;
  /** At most 16, each distinct from `file`. */
  references?: string[];
  /** API 3: the engines whose games' briefs carry this skill; every engine when absent. */
  engines?: PluginGameEngine[];
}

/** One of at most 32 skills a plugin gives agents; names are unique. */
export type PluginSkill = PluginInlineSkill | PluginFileSkill;

export type PluginToolbarTarget =
  | { kind: "action"; name: string; args?: Record<string, PluginScalar> }
  | { kind: "panel"; id: string };

export interface PluginToolbarItem {
  id: string;
  /** 1–24 characters and not one of Studio's reserved stage-strip labels. */
  label: string;
  /** 1–60 characters, unique across the manifest. */
  ariaLabel: string;
  /** A glyph of at most 4 characters, or a host icon: globe, export, play, image, box, boxes, unreal, godot, unity. */
  icon?: string;
  /** Default true: the button waits for a loaded game. */
  requiresProject?: boolean;
  /**
   * API 3: the facts of the games whose strip shows this button; every game when absent. Its status
   * can still bring it out on another game (`shown`).
   */
  facts?: string[];
  target: PluginToolbarTarget;
  /** Names a declared action without confirmation that returns a PluginToolbarStatus. */
  status?: string;
}

export interface PluginToolbarStatus {
  badge?: string;
  disabled?: boolean;
  title?: string;
  tone?: "ok" | "warn" | "err" | "info";
  /** The button's action is due now: Studio draws it in the accent fill, otherwise in the quiet one. */
  attention?: boolean;
  /** Draw the badge as a dot in its tone (ok green, warn amber, err red, info grey); its word moves to the tooltip. */
  dot?: boolean;
  /** A button scoped to `facts` shows on this game anyway (its chat chose the engine before the project exists). */
  shown?: boolean;
}

/** A button on the setup card: the plugin action it runs (declared in `actions`), its arguments and its label. */
export interface PluginSetupButton {
  name: string;
  args: Record<string, string>;
  label: string;
}

/**
 * One step of the setup card. `you` marks a step only the person can do (signing in) or one that
 * stopped and waits for them, drawn with an orange ring; `working` one under way; `command` a line
 * the person runs in Terminal themselves.
 */
export interface PluginSetupStep {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  you?: true;
  working?: true;
  action?: PluginSetupButton;
  command?: string;
}

/**
 * What a `game-engine` plugin's `steps` action answers: the setup card the chat shows above the
 * composer while `open`, read again every few seconds (`game.engine.steps` shows it; the plugin's
 * `show-steps` tool is how its agent asks for it). `primary` does every step it can for the person
 * (Do it for me); `secondary` is the plugin's own way out in Hide's place (Don't use Unity, or Stop
 * while it works); `doneSays` is what the agent is told once nothing is open, so the chat goes on,
 * and `stuckSays` what it is told once when a step stopped. See "Setup in the chat" in the guide.
 */
export interface PluginSetupCard {
  title: string;
  intro: string;
  open: boolean;
  steps: PluginSetupStep[];
  primary?: PluginSetupButton;
  secondary?: PluginSetupButton;
  doneSays?: string;
  stuckSays?: string;
}

/**
 * Where one environment variable of a plugin's MCP server gets its value. The manifest names a
 * source, never a value: `setting:<key>` a declared setting, `secret:<name>` a value the user
 * stored for this connector, `literal:<value>` a constant, and `credential-file` the plugin's own
 * credential. For a `node` server the variable is set to `/dev/fd/3`: Studio writes the bare token
 * (no `NAME=` framing, no trailing newline) to an anonymous pipe on file descriptor 3 and closes
 * it, so the token never travels in the environment. Read it once at start-up, for example
 * `readFileSync(process.env.MY_TOKEN_FILE, 'utf8')`; an empty read means the account is locked.
 */
export type PluginMcpEnvValue = `setting:${string}` | `secret:${string}` | `literal:${string}` | "credential-file";

/**
 * API 2: an MCP server the plugin ships. Studio runs it as a connector the plugin owns — started
 * with it, stopped with it, removed with it, and trusted by the plugin's own install dialog. Its
 * tools reach every coding path as `<pluginId>-<id>__<tool>`.
 */
export interface PluginMcpServer {
  /** Lowercase letters, digits and dashes, no `_`, at most 32 characters. */
  id: string;
  transport: "stdio";
  /** `node` runs a script inside your package; `host-cli` is reserved for the bundled Genex plugin. */
  command: "node" | "host-cli";
  /** For `node`, `args[0]` is the script, relative to the package root. */
  args: string[];
  /** Plugin storage, or a per-project folder inside it. HOME is set inside whichever you pick. */
  cwd: "storage" | "storage:project";
  env?: Record<string, PluginMcpEnvValue>;
  /** What must be true before the server is started; otherwise it is listed with the reason. */
  requires?: { credential?: boolean; settings?: string[] };
  /** Raw MCP tool names. Deny wins; Studio caps a connector at 64 tools regardless. */
  toolPolicy?: { allow?: string[]; deny?: string[] };
  /** API 3: raw MCP tool names that only read (list or describe what the server offers): they run with no card in any mode, as a file read does. A local plugin's still ask. */
  reads?: string[];
  maxTools?: number;
  /** At most 1 800 000. */
  callTimeoutMs?: number;
  description: string;
}

export interface PluginManifest {
  /** API 3: delivery limits enforced by the host per plugin and project. */
  assetLimits?: { fileBytes: number; projectBytes: number };
  nativeRuntimes?: PluginNativeRuntime[];
  nativeJobs?: PluginNativeJob[];
  apiVersion: PluginApiVersion;
  id: string;
  version: string;
  name: string;
  publisher: string;
  description: string;
  backend: string;
  capabilities: string[];
  tools: PluginManifestTool[];
  skills: PluginSkill[];
  panels: Array<{ id: string; title: string; file: string; placement: "settings" | "project" }>;
  settings: Array<{
    key: string;
    label: string;
    type: "string" | "boolean" | "number";
    default: string | boolean | number;
  }>;
  actions: Array<{
    name: string;
    label: string;
    confirmation?: string;
    /** The action starts, quits or opens a desktop app or the browser, or writes outside your storage; a fixture profile refuses it. */
    native?: true;
  }>;
  /** API 2: hosts the backend talks to, disclosed at install and checked by the static scan. */
  network?: { hosts: string[] };
  /** API 2: up to four buttons contributed beside Live/Builds. */
  toolbar?: PluginToolbarItem[];
  /** API 2: up to four MCP servers the plugin ships, run by the host as connectors it owns. */
  mcpServers?: PluginMcpServer[];
  /** API 3, capability `game-engine`: the engine the plugin declares. */
  engine?: PluginEngineDeclaration;
  /** API 3, beside `engine`: the blind judges that play your engine's games in its editor. */
  judges?: PluginJudge[];
  /** Host-managed account flow. Status may finish a pending browser authorization. */
  account?: { connect: string; unlock: string; disconnect: string; status: string; cancel?: string };
  /**
   * The plugin's picture, like an app's in the Dock: a .png, .jpg, .webp or .svg file in the
   * package (at most 512 KiB), square and full-bleed; Studio rounds the corners. Without one
   * Studio shows the plugin's initial.
   */
  icon?: string;
}

/** What `export.stage` returns: Studio's public copy of the bound game. */
export interface PluginExportResult {
  dir: string;
  files: number;
  included: string[];
  excluded: string[];
  /**
   * What the game's own package.json tells Genex, which the copy does not carry: its Genex SDK
   * versions and `genex` settings. Absent when the game names none.
   */
  genex?: {
    dependencies: Partial<Record<"@genex-ai/multiplayer" | "@genex-ai/embed-sdk", string>>;
    genex?: { matchmaking?: Record<string, unknown>; mobileControls?: boolean };
  };
}

/**
 * API 3: which view a still photographs, exactly one of a demo (a `config.demos` key, run to its
 * end state) or a camera (a `config.cameras` key or a built-in `eye:*`). A name is 1 to 64 letters,
 * digits, `:`, `_` or `-`, starting with a letter or digit.
 */
export type PluginStillView = { demo: string; camera?: undefined } | { camera: string; demo?: undefined };
/**
 * API 3: `observe` with a `still` photographs one view of the bound game on a hidden window of its
 * own at `width`×`height` (whole pixels, 320–1920 by 240–1200), encoded as PNG, or as the
 * best JPEG (quality 95, 90, then 85) that fits `maxBytes` (64 KiB to 16 MiB, default 8 MiB).
 * The image is never larger than asked; a game that draws smaller is not scaled up. A host older
 * than this option ignores `still` and answers an ordinary observation ({@link PluginStillIgnored}),
 * so check the answer for `still`, then `stillProblem`, and handle neither.
 */
export type PluginStillRequest = PluginStillView & { width: number; height: number; maxBytes?: number };
/**
 * Why no still was taken. `unavailable`: the host has no hidden window (a still never borrows the
 * person's own) or could not open or size one; `view_unknown` comes with `available`.
 */
export type PluginStillProblemCode =
  | "unavailable"
  | "load_failed"
  | "view_unknown"
  | "view_failed"
  | "capture_failed"
  | "too_large"
  | "timeout";
/** The still's exposure on a small downscale, each 0–1: Rec.709 luma of the sRGB bytes. */
export interface PluginStillExposure {
  lumaMean: number;
  lumaStdDev: number;
  /** The share of samples whose luma is below 0.10. */
  nearBlackFraction: number;
  /** The share of samples above the preview's unlit threshold (8 of 255). */
  litFraction: number;
}
export interface PluginStill {
  image: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** `page` is the page's own read of its canvas; `compositor` is the window's frame. */
  source: "page" | "compositor";
  view: PluginStillView;
  stats: PluginStillExposure;
  /** JPEG, at most 1280 px on its long side: for showing, never for sending on. */
  preview: Uint8Array;
}
export interface PluginStillProblem {
  code: PluginStillProblemCode;
  reason?: string;
  /** With `view_unknown`: the demo or camera names the game has, at most 32. */
  available?: string[];
}
export type PluginStillAnswer = { still: PluginStill } | { stillProblem: PluginStillProblem };
/**
 * What an API-3 host older than stills answers instead: it ignores `still` and returns an ordinary
 * observation, with neither `still` nor `stillProblem`. Check for each before reading it.
 */
export type PluginStillIgnored = { still?: undefined; stillProblem?: undefined; [key: string]: unknown };

/**
 * API 3: `observe` with a `clip` records `seconds` (2–10, default 5) of the bound game running, from
 * the start of a moment its demo `demo` stages (a `config.demos` key: it sets up the moment and its
 * own scripted input, and returns; the host then starts the game's clock and sends no input), on a
 * hidden window of its own at `width`×`height` (whole pixels, 320–1920 by 240–1200), at `fps`
 * (15–30, default 30), in at most `maxBytes` (256 KiB to 8 MiB, default 8 MiB). Send `files: []`
 * and no `still`. A host older than this option ignores `clip` and answers an ordinary observation
 * ({@link PluginClipIgnored}), so check the answer for `clip`, then `clipProblem`, and handle neither.
 */
export interface PluginClipRequest {
  demo: string;
  width: number;
  height: number;
  seconds?: number;
  fps?: number;
  maxBytes?: number;
}
export interface PluginClip {
  video: Uint8Array;
  /** MP4 (H.264) where the host's recorder can, else WebM (VP9 or VP8). */
  mimeType: "video/webm" | "video/mp4";
  /** The recorded canvas's size; a game that draws smaller is not scaled up. */
  width: number;
  height: number;
  durationMs: number;
  view: { demo: string };
  /** JPEG of the first recorded frame, at most 1280 px on its long side. */
  poster: Uint8Array;
  /** 0–1: the share of sampled frame pairs that differ visibly; a frozen recording is about 0. */
  motion: number;
}
/** A clip's problem codes are a still's: `too_large` when even the lowest bitrate is over `maxBytes`. */
export type PluginClipAnswer = { clip: PluginClip } | { clipProblem: PluginStillProblem };
/** What an API-3 host older than clips answers instead: an ordinary observation, with neither `clip` nor `clipProblem`. */
export type PluginClipIgnored = { clip?: undefined; clipProblem?: undefined; [key: string]: unknown };

/** Sanitized progress for Studio. `kind: 'toolbar'` updates a toolbar item's badge. */
export interface PluginEvent {
  kind?: string;
  item?: string;
  badge?: string;
  title?: string;
  tone?: PluginToolbarStatus["tone"];
  attention?: boolean;
  dot?: boolean;
  [key: string]: unknown;
}

/**
 * A published game's ids at its engine's service, kept beside a link when the project lives there:
 * positive decimal strings of at most 20 digits, never numbers, which would lose digits.
 */
export interface PluginEngineRemote {
  placeId: string;
  universeId: string;
}

/**
 * A game's link to an engine project (`game-engine`): the engine (your `engine.id`), the project
 * file's real path, its name (the file name without its declared extension, or its folder's name
 * for a whole-name project file), when it was linked, and the published game's ids when you linked
 * them. The host keeps it in the plugin's storage as `links/<game>.json`, where the plugin's MCP
 * servers may read it, and mirrors it into the game's `studio.json`.
 */
export interface PluginEngineLink {
  /** Your `engine.id`: the project's engine. */
  kind: string;
  project: string;
  name: string;
  linkedAt: string;
  remote?: PluginEngineRemote;
}

/**
 * The host services a plugin may call, each gated by the matching capability and answered only
 * during an active invocation. An unknown method name is a type error, not a runtime surprise.
 */
export interface PluginHostCall {
  (method: "runtime.detect", args: { runtime: string }): Promise<PluginNativeStatus>;
  (method: "runtime.install", args: { runtime: string }): Promise<PluginNativeStatus>;
  (method: "runtime.installation", args: { runtime: string }): Promise<PluginRuntimeInstall | null>;
  /** User setup actions only. Downloaded partial bytes remain available for retry. */
  (method: "runtime.cancelInstall", args: { runtime: string }): Promise<true>;
  (
    method: "native.run",
    args: { job: string; inputs: Record<string, string>; values: Record<string, string> },
  ): Promise<PluginNativeResult>;
  (method: "native.jobs"): Promise<PluginNativeResult[]>;
  /**
   * `game-engine`: starts a long job in Genex's process sandbox and answers its id at once; Genex owns
   * the job from then on and ends it when the plugin stops, is turned off or is removed. A `.bat` or
   * `.cmd` program on Windows runs through `cmd.exe`, its command line quoted by Genex.
   */
  (method: "sandbox.run", args: PluginSandboxRunArgs): Promise<{ id: string }>;
  (method: "sandbox.result", args: { id: string }): Promise<PluginSandboxJob | null>;
  (method: "sandbox.stop", args: { id: string }): Promise<{ stopped: boolean }>;
  (method: "native.result", args: { id: string }): Promise<PluginNativeResult | null>;
  /**
   * Every setting this version declares: the stored value when it has the declared type, else the
   * default. A key an earlier version declared, or stored under another type, is never returned.
   */
  (method: "settings.read"): Promise<Record<string, PluginScalar>>;
  (method: "storage.root"): Promise<string>;
  (method: "project.read", args: { path: string }): Promise<string>;
  (method: "project.write", args: { path: string; text: string }): Promise<{ file: string }>;
  (method: "assets.deliver", args: { output: string; jobId: string }): Promise<string[]>;
  (method: "export.stage"): Promise<PluginExportResult>;
  (method: "jobs.read", args: { id: string }): Promise<unknown>;
  (method: "jobs.write", args: { id: string; value: unknown }): Promise<true>;
  (method: "events.emit", args: PluginEvent): Promise<true>;
  /**
   * API 3: one named view of the bound game as a still; see {@link PluginStillRequest}. A host
   * older than the option answers an ordinary observation ({@link PluginStillIgnored}).
   */
  (
    method: "observe",
    args: { project: string; root: string; files: []; still: PluginStillRequest },
  ): Promise<PluginStillAnswer | PluginStillIgnored>;
  /**
   * API 3: a few seconds of the bound game running from a moment its demo stages; see
   * {@link PluginClipRequest}. A host older than the option answers an ordinary observation
   * ({@link PluginClipIgnored}).
   */
  (
    method: "observe",
    args: { project: string; root: string; files: []; clip: PluginClipRequest },
  ): Promise<PluginClipAnswer | PluginClipIgnored>;
  (method: "observe", args: { project: string; root: string; files: string[] }): Promise<unknown>;
  /** Current plugin's explicitly unlocked memory lease; null never triggers OS access. */
  (method: "credentials.session"): Promise<string | null>;
  (method: "credentials.read"): Promise<string | null>;
  (method: "credentials.write", args: { token: string }): Promise<void>;
  (method: "credentials.clear"): Promise<void>;
  /**
   * `game-engine`: links the bound game to a project file of the engine your manifest declares
   * (`engine.projectFiles`, checked by real path); a plugin that declares no engine is refused.
   * `remote` keeps the published game's ids beside the link (ids of any other shape are dropped and
   * the link is still made); linking the same file with other ids makes a new link. The chat it was
   * called from shows one line with Undo, naming the project by `name` when you give one (one plain
   * line, at most 80 characters: the project as people know it, when its file's name isn't), else
   * by its file's name; `auto` says the link was made by the game's first call rather than asked
   * for. `setUp` says you set the project up for Genex to make this link: the chat line says so,
   * and its Undo first runs your `undo-setup` action with `{project, ifSetUp: true}` (no question;
   * answer nothing when the project is no longer set up, and refuse with a reason to keep the link).
   * Linking the project the game already uses with `setUp` makes a new link. From outside any game,
   * `game` names one this plugin made with `game.create`; any other game is refused.
   */
  (
    method: "game.engine.link",
    args: {
      project: string;
      remote?: PluginEngineRemote;
      name?: string;
      auto?: boolean;
      setUp?: boolean;
      game?: string;
    },
  ): Promise<PluginEngineLink>;
  /** `game-engine`: the bound game's link, or null while it has none that still holds. */
  (method: "game.engine.read"): Promise<PluginEngineLink | null>;
  /** `game-engine`: shows the plugin's steps card (its `steps` action's answer) in the chat the call came from. */
  (method: "game.engine.steps"): Promise<boolean>;
  /**
   * `game-engine`: a snapshot of the bound game, taken before the plugin changes files there, which
   * Rewind lists under `reason` (one plain line, at most 200 characters). Refused without a bound game.
   */
  (method: "game.snapshot", args: { reason: string }): Promise<{ snapshotId: string }>;
  /**
   * `game-engine`: a new Genex game titled `title` (one plain line, at most 80 characters), for an
   * engine project made with no game open: its name (`project`) and its folder, which the plugin
   * may then link with `game.engine.link {game}`.
   */
  (method: "game.create", args: { title: string }): Promise<{ project: string; directory: string }>;
  /**
   * `game-engine`: the games whose run (a Loop) is going now and that this plugin linked to a
   * project, each with that project file, so the plugin never quits an editor a run is using.
   * Needs no bound game.
   */
  (method: "game.engine.runs"): Promise<PluginEngineRun[]>;
  /**
   * `game-engine`: Do it for me. Hands a setup task (one plain line, at most 300 characters) to the
   * bound game's chat, shown there verbatim as "<your plugin's name> asks: <task>"; that chat's
   * agent clicks it with the person's computer control, on the apps your `engine.apps` declares
   * and no others. Only for setup clicks and publishing the person approved, never to build or
   * play-test. The person must have asked: call it from an action they pressed, or from a tool
   * that declares `confirmation` whose card they approved; any other call answers `not-person`
   * (a plugin that came with Genex may also call it from its own tools, never from a moment; while
   * the chat's own assist is under way, such a call answers `in-assist` and posts nothing).
   * A plugin that did not come with Genex shows the task on a card first; computer control that
   * is off is offered on a card for every chat. Windows, or a Mac with no driver, answers
   * `unavailable`: show the click path instead.
   */
  (method: "game.engine.assist", args: PluginEngineAssistArgs): Promise<PluginEngineAssistAnswer>;
  /**
   * `game-engine`: whether Do it for me can run for your plugin on this computer: computer control
   * has a desktop and its driver, and your `engine.apps` names apps here. Computer control that is
   * off still counts (its card offers to turn it on). Asks the person nothing; false on Windows.
   * Offer Do it for me only when it answers true, and the click path otherwise.
   */
  (method: "game.engine.canAssist"): Promise<boolean>;
}

/** `game.engine.assist`'s task: what the chat is asked to click, in plain words. */
export interface PluginEngineAssistArgs {
  task: string;
}

/** Why `game.engine.assist` started nothing. */
export type PluginEngineAssistRefusal = "unavailable" | "declined" | "no-chat" | "not-person" | "no-apps" | "in-assist";

/** `game.engine.assist`'s answer: whether the chat's turn started, and why not. */
export interface PluginEngineAssistAnswer {
  started: boolean;
  reason?: PluginEngineAssistRefusal;
}

/** A game whose run is going, as `game.engine.runs` names it: its name, its title and its linked project file. */
export interface PluginEngineRun {
  game: string;
  title: string;
  project: string;
}

/**
 * The object handed to `activate`. Activation must be side-effect-free and must not call the
 * host: an installation probe loads the backend with no account or project authority.
 */
export interface PluginHost {
  call: PluginHostCall;
}

/**
 * API 3: one of Genex's moments a manifest `hooks` entry names. Your handler runs at it as a
 * harness tool, in plugin order and then declaration order.
 */
export type PluginHookEvent =
  | "run.prepare"
  | "run.end"
  | "turn.start"
  | "turn.end"
  | "checkpoint.before"
  | "checkpoint.after"
  | "restore.before"
  | "restore.after"
  | "worker.start"
  | "worker.end"
  | "tool.before"
  | "tool.after"
  | "health"
  | "crash"
  | "finish";

/**
 * API 3: what a handler is told about the moment it runs at. `args` is only a digest of your own
 * tool's arguments at `tool.before`/`tool.after`, never the arguments themselves.
 */
export interface PluginHookContext {
  on: PluginHookEvent;
  runId?: string;
  turn?: string;
  label?: string;
  worker?: { id: string; title: string; type?: string };
  tool?: string;
  args?: string;
  /** The person asked for this moment themselves (their own Rewind): nothing waits for them. */
  forPerson?: boolean;
}

/**
 * API 3: what a handler answers. `block` stops a moment that can be stopped, with a reason;
 * `note` adds a line to the record; `pending` says it is not ready yet, and Genex asks again;
 * `images` hands back base64 PNG pictures; `recording` (an observer's) a short play recording as
 * at most 8 frames in order. Anything else is ignored: a handler never rewrites arguments and never
 * gives instructions.
 */
export interface PluginHookAnswer {
  block?: string;
  note?: string;
  pending?: string;
  images?: Array<{ name: string; data: string; measures?: Record<string, number> }>;
  recording?: Array<{ name: string; data: string; measures?: Record<string, number> }>;
}

/**
 * API 3: what an observer's tool is told when Genex runs it as one of your manifest's `observers`:
 * the observer (`<plugin>/<id>`), the run it captures for, why (`finish`: a reviewer checks a
 * lead's claim), and how long Genex gives this call (`withinMs`): answer the pictures you have by
 * then, since a call cut at its limit hands back none.
 */
export interface PluginObserveContext {
  observer: string;
  runId: string;
  why: "finish";
  withinMs?: number;
}

/**
 * One invocation's binding. Never store it: concurrent calls can belong to different games and
 * different workers.
 */
export interface PluginContext {
  /** The bound game, when the call has one. */
  project?: string;
  /** The bound game's worktree. */
  directory?: string;
  threadId?: string;
  /** Set when Genex runs this tool at one of its moments; answer a `PluginHookAnswer`. */
  hook?: PluginHookContext;
  /** Set when Genex runs this tool as one of your observers; answer `{images, recording?, note?}`. */
  observe?: PluginObserveContext;
  /** Aborted when the user stops the turn. Local waiting ends; remote work may continue. */
  signal: AbortSignal;
  callId: number;
  host: PluginHostCall;
}

/** What an optional `review` returns before a confirmed action reaches the native dialog. */
export interface PluginReview {
  /**
   * The dialog's short question (at most 2,000 characters), asked instead of the manifest's
   * `confirmation`; its confirm button then reads the action's label.
   */
  message?: string;
  /** Plain text under the question (at most 4,000 characters), shown only with a `message`. */
  detail?: string;
  images?: Array<{ label: string; dataUrl: string }>;
}

export interface PluginActivation {
  /** Agent-invoked, named `<plugin>__<tool>` in engines. Parameters are scalars. */
  tool?(name: string, args: Record<string, PluginScalar>, context: PluginContext): Promise<unknown>;
  /** User-invoked from a panel, the Plugins dialog or a toolbar button. Never an agent tool. */
  action?(name: string, args: Record<string, unknown>, context: PluginContext): Promise<unknown>;
  /** Host-rendered evidence for a confirmed action. */
  review?(name: string, args: Record<string, unknown>, context: PluginContext): Promise<PluginReview>;
}

/** The backend module's single export. */
export type Activate = (host: PluginHost) => PluginActivation | Promise<PluginActivation>;

/** What `studioPlugin.call('context')` answers inside a panel frame. */
export interface PluginPanelContext {
  project: string | null;
  apiVersion: PluginApiVersion;
  theme: {
    background: string;
    foreground: string;
    /** The theme's raw accent: rings, marks and focus outlines. */
    accent: string;
    /** A primary button's fill under `accentForeground` text, at least 5:1; absent from older hosts. */
    accentFill?: string;
    /** Text on `accentFill` and `accentHover`. */
    accentForeground?: string;
    /** A primary button's fill while hovered, still readable under `accentForeground`. */
    accentHover?: string;
  };
  /**
   * What the frame sits on: `"page"` (the plugin's page) or `"card"` (a dialog). In a dialog the SDK
   * marks the document `data-surface="card"`, shows the panel's visible `[data-panel-head]` (its
   * heading and the line under it) as the dialog's title, sizes the frame to the panel's height so
   * the dialog scrolls once, and lets the dialog's Back arrow press the visible `[data-panel-back]`.
   * Absent from older hosts.
   */
  surface?: "page" | "card";
  /**
   * Genex's language as a BCP 47 tag: `en`, `ru`, `es`, `pt-BR`, `de`, `fr`, `ja`, `ko` or
   * `zh-Hans`. `studioPlugin.t` already speaks it when the plugin brings its words; absent from
   * older hosts, which speak English.
   */
  locale?: string;
}

/**
 * How `studioPlugin.call` rejects: an Error with the host's words, and `code: "cancelled"` when
 * the person declined Studio's confirmation of the action. Any other failure has no code.
 */
export type PluginPanelError = Error & { code?: "cancelled" };

/**
 * What `studioPlugin.chooseFile` asks Studio's file picker for. Studio checks it in the panel host
 * and again before the picker opens; any other field is refused. Mirrors
 * `src/shared/plugin-file-request.ts`.
 */
export interface PluginFileRequest {
  /** 1–80 characters on one line; Studio shows it after the plugin's name. */
  title: string;
  /** 1–4 different extensions without the dot: lowercase letters and digits, at most 10 each. */
  extensions: string[];
}

/** The framework-free helpers `src/plugin-sdk/ui.js` installs on the bridge. */
export interface StudioPluginUi {
  text(tag: string, value: unknown): HTMLElement;
  status(label: string, value: unknown): HTMLElement;
  error(message: unknown): HTMLElement;
  job(job: Record<string, unknown>): HTMLElement;
}

/**
 * The only bridge a panel has. The frame is sandboxed with an opaque origin and no Studio
 * preload: there is no `window.studio`, no `require` and no direct IPC.
 */
export interface StudioPluginPanel {
  /** Host context changed; re-read status. No secrets are included in notifications. */
  onContextChanged(callback: () => void): () => void;
  call(method: "context"): Promise<PluginPanelContext>;
  call(method: "settings"): Promise<Record<string, PluginScalar>>;
  call(
    method: "action",
    name: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs: number },
  ): Promise<unknown>;
  call(
    method: "chooseFile",
    name: undefined,
    args: PluginFileRequest,
    options?: { timeoutMs: number },
  ): Promise<string | null>;
  /**
   * Studio's own native file picker, over its window: one existing file of the listed types. The
   * answer is the file's real path, or null when the person cancels. Studio names the plugin in
   * the picker, opens one at a time, and refuses an answer that is not a file of a listed type.
   * The panel may wait as long as a panel request may (30 minutes). A fixture profile refuses it.
   */
  chooseFile(request: PluginFileRequest): Promise<string | null>;
  /** Present once `src/plugin-sdk/ui.js` is inlined after `panel.js`. */
  ui?: StudioPluginUi;
  /**
   * `english` (ICU message syntax: `{name}`, `{count, plural, one {# game} other {# games}}`,
   * `{choice, select, …}`) in Genex's language, its placeholders filled in from `params`; the
   * English when the plugin's `locales/<lang>.json` has no translation. Call it once `ready` has
   * settled. Present once `src/plugin-sdk/words.js` is inlined (the SDK marker does it).
   */
  t?(english: string, params?: Record<string, string | number>): string;
  /** "a, b and c" in the panel's language. */
  formatList?(items: string[]): string;
  /** The language the panel speaks: Genex's when the plugin brings its words, else `en`. */
  readonly locale?: string;
  /**
   * Settles with `locale` once the host has named the language (or after two seconds, in English)
   * and the page's `data-t` marks speak it: await it before the panel writes any words.
   */
  ready?: Promise<string>;
}

declare global {
  interface Window {
    studioPlugin: StudioPluginPanel;
  }
}
