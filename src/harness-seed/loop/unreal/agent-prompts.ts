/**
 * The words of the lead's workers: each kind's brief (what to make, where it delivers, the
 * manifest it writes and the checks it runs before it says done), the news the lead reads when one
 * delivers, fails or stops, and the plain answers of the agent tools. Tools are spelled the way the
 * reading session's engine calls them. Pure text from plain facts: nothing here reads the run.
 */
import type { FactRef } from "../folder-facts.ts";
import { toolCall } from "../model-roles.ts";
import { appIdentity } from "../project-prompts.ts";
import { UNREAL_AT_ROOT } from "../workers/identity.ts";
import {
  AGENT_MANIFEST_FILE,
  AgentFileRole,
  AgentKind,
  type AgentManifest,
  type AgentManifestFile,
  AgentPluginTool,
  AgentVerdict,
  type AssetLook,
  AssetVerdict,
  LeadTool,
} from "./lead-contract.ts";

/** Local Blender's tool a Blender brief names, by its agent name (`src/plugins/blender/plugin.json`). */
export const LocalBlenderTool = { Model: `${AgentPluginTool.Blender}model` } as const;

/** A prop's triangle budget after its prep, unless its brief calls it a hero piece. */
export const PROP_TRIANGLES = 30_000;
/** The longest side of a delivered texture, unless its brief calls it a hero piece. */
const TEXTURE_PX = 2048;

/** Each kind's word on the graph and in the lead's news: "Blender: Katana". */
export const AGENT_KIND_WORD = {
  [AgentKind.BlenderModel]: "Blender",
  [AgentKind.BlenderPrep]: "Blender",
  [AgentKind.GenexCast]: "Meshy",
  [AgentKind.Sound]: "Sound",
  [AgentKind.Texture]: "Texture",
  [AgentKind.Cpp]: "C++",
} as const satisfies Record<AgentKind, string>;

/** A word as a pattern that matches only itself: "C++" has signs a pattern reads otherwise. */
const literal = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every kind's phrase a lead may lead a title with: each kind's word ("Blender") and its own name ("Blender model"), longest first. */
const KIND_PHRASES = [
  ...new Set([...Object.values(AGENT_KIND_WORD), ...Object.values(AgentKind).map((kind) => kind.replaceAll("_", " "))]),
].sort((a, b) => b.length - a.length);

/** A title led by any kind's phrase and a colon ("Blender model: Bike", "c++:Grapple"), in any case. */
const LED_BY_KIND = new RegExp(`^(?:${KIND_PHRASES.map(literal).join("|")})\\s*:\\s*`, "i");

/**
 * A title without the kind the lead may have put in it itself ("Meshy: Goblin", "Blender model:
 * Bike", "Goblin (Meshy)", "Meshy Goblin"), so the kind is named once. A word that only starts a
 * phrase ("Sound of rain") stays: the space form goes only before a capital.
 */
function withoutKind(word: string, title: string): string {
  const kind = literal(word);
  const named = title
    .trim()
    .replace(new RegExp(`\\s*\\(${kind}\\)$`, "i"), "")
    .replace(LED_BY_KIND, "");
  const spaced = new RegExp(`^${kind}\\s+`, "i").exec(named)?.[0];
  const rest = spaced ? named.slice(spaced.length) : "";
  const bare = /^\p{Lu}/u.test(rest) ? rest : named;
  return bare || title.trim();
}

/** A worker as the graph and the news name it: its kind's word, then its title without that word. */
export function agentTitle(kind: AgentKind, title: string): string {
  const word = AGENT_KIND_WORD[kind];
  return `${word}: ${withoutKind(word, title)}`;
}

/** What a brief is written from. */
export type AgentBriefOptions = {
  kind: AgentKind;
  title: string;
  brief: string;
  /** The game's name as the user knows it. */
  game: string;
  /** Where it delivers, from the game folder: `assets/agents/<id>`. */
  folder: string;
  /** A C++ agent's folder in the game's module, from the game folder; null for every other kind. */
  cppFolder: string | null;
  /** The inputs it reads, by their game-folder paths: its copy of the game holds them. */
  inputs: string[];
  /** The engine the worker runs on, which spells its tools. */
  engine: string;
  /** What the game's folder holds (`game.list`'s `facts`); absent: the Unreal project the lead works in. */
  facts?: readonly FactRef[] | null;
  /** The game folder as its brief names it (its last two parts); absent: named as the game's folder. */
  folderLabel?: string;
};

/** The manifest's shape, as the brief shows it. */
function manifestShape(options: AgentBriefOptions): string {
  const { folder, kind, title } = options;
  const roles = Object.values(AgentFileRole).join(" | ");
  const example = {
    kind,
    title,
    files: [
      {
        path: `${folder}/<file>`,
        role: roles,
        triangles: 0,
        sizeCm: [0, 0, 0],
        pivot: "base centre",
        materials: ["<name>"],
        meshes: 1,
      },
    ],
    renders: [`${folder}/render.png`],
    importCalls: [
      `import_model {"file": "${folder}/<file>", "dest": "/Game/Genex/Agents", "name": "<Name>", "collision": "box", "nanite": true}`,
    ],
    notes: "what the lead must know before it imports",
    credits: 0,
  };
  return JSON.stringify(example, null, 2);
}

/** How a mesh is made ready for Unreal, for every kind that delivers one. */
const MESH_CHECKS = [
  "One mesh object per file: join the parts, or one file per moving part named for it. Only when the brief asks for several meshes in one file, set meshes to their count and meshesAsked to true.",
  "Real size in metres in Blender with +Z up and the front along +X (Unreal imports metres as centimetres), except a rigged character, which keeps the facing it came with (say which way it faces in notes); put the measured bounds in sizeCm.",
  "The pivot at the base (or where the brief asks), and say where in pivot.",
  "Welded (merge by distance, about 0.0001 m) before any decimate, with no open edges added.",
  `At most ${PROP_TRIANGLES.toLocaleString("en-US")} triangles per prop unless the brief calls it a hero piece; put the count in triangles.`,
  "At most three material slots, each named, each with its base colour set as its viewport colour so the renders show colour.",
  "UVs on every mesh.",
  "Renders you have looked at (each Local Blender job draws a three-quarter and a front view), copied into your folder (role render) and listed in renders; a rigged character also with its arms down (posed, or at a frame of a clip), where cloth webbed to the arms shows. The critic checks them against your brief before the lead hears of it.",
] as const;

/** What each kind makes and how; the tools are spelled for the agent's engine. */
const KIND_WORK = {
  [AgentKind.BlenderModel]: (o: AgentBriefOptions) =>
    `Model it in Local Blender: write the bpy script in assets/src/, call ${toolCall(o.engine, LocalBlenderTool.Model)}, look at its renders and fix the script until they look right. Copy the finished GLB and its render into ${o.folder}/.`,
  [AgentKind.BlenderPrep]: (o: AgentBriefOptions) =>
    `Prepare the inputs in Local Blender with ${toolCall(o.engine, LocalBlenderTool.Model)} (its model and inputs arguments stage them read-only): weld, decimate, scale, set the pivot, join, or make LODs, as the brief asks. Keep each source as it is; write the prepared GLBs and their renders into ${o.folder}/.`,
  [AgentKind.GenexCast]: (o: AgentBriefOptions) =>
    `Make it with ${toolCall(o.engine, AgentPluginTool.GenexAsset)} (its character or creature operation, rigged, with the catalog clips the brief names). Ask for clothes that fit close: a long open coat, cloak, cape or heavy armour makes Meshy's rig fail (Genex then rigs it with Uthana and says so), and its cloth webs to the arms and legs once they move; keep cloth short, and when the brief wants a cloak, say in notes that it should be its own piece. Use the rigged file Genex's answer names. Pass it through Local Blender (${toolCall(o.engine, LocalBlenderTool.Model)} with the GLB as its model and rig on): Genex applies the armature's scale (Meshy's rigs hang under 0.01) to the bones and clips as it exports the GLB; your script deletes helper objects such as a stray Icosphere and decimates when over budget. Check the height in metres, then copy the GLB (role skeletal) and its renders into ${o.folder}/. Genex jobs spend the user's credits: one job per thing asked, no retries for variety.`,
  [AgentKind.Sound]: (o: AgentBriefOptions) =>
    `Make it with ${toolCall(o.engine, AgentPluginTool.GenexAsset)} (its sfx or music operation), each sound as long as the brief asks, loops clean at their ends. Deliver WAV, 44.1 kHz, 16-bit, into ${o.folder}/ (convert an MP3 with afconvert -f WAVE -d LEI16@44100 <in> <out>). Genex jobs spend the user's credits: one job per sound asked.`,
  [AgentKind.Texture]: (o: AgentBriefOptions) =>
    `Make it with ${toolCall(o.engine, AgentPluginTool.GenexAsset)} (its texture or image operation), or bake it in Local Blender (${toolCall(o.engine, LocalBlenderTool.Model)}). Deliver PNG, at most ${TEXTURE_PX} pixels on a side unless the brief calls it a hero piece, tileable when it covers a surface, into ${o.folder}/; say which map each file is (base colour, normal, roughness) in notes. Never a photo standing in for 3D.`,
  [AgentKind.Cpp]: (o: AgentBriefOptions) => {
    const folder = o.cppFolder ?? o.folder;
    const part = cppPartOf(folder);
    return [
      `Write the C++ (*.h and *.cpp) only in ${folder}/, named after this worker so no two collide, with a UCLASS(Blueprintable) per class and GENERATED_BODY() first inside it. Never use Live Coding.`,
      `${toolCall(o.engine, AgentPluginTool.CppCheck)} checks and compiles that folder as the part ${part}: first write unreal/parts/${part}/part.json as {"title": "<what it is>", "goal": "<what it does>", "cpp": ["<Class>"]} (each class's name without its A or U prefix) and unreal/parts/${part}/apply.py holding only pass, then call it with part=${part} until it compiles. That folder stays in your copy.`,
      "Your manifest lists no files: its notes name each class and how the lead uses it.",
    ].join(" ");
  },
} as const satisfies Record<AgentKind, (options: AgentBriefOptions) => string>;

/** The part a C++ agent's folder is checked as: the folder's own name (`cpp_1`), as the Unreal plugin's parts are named. */
const cppPartOf = (folder: string): string => folder.split("/").at(-1) ?? folder;

/** The kinds whose delivery holds meshes the lead imports. */
const MESH_KINDS: ReadonlySet<AgentKind> = new Set([
  AgentKind.BlenderModel,
  AgentKind.BlenderPrep,
  AgentKind.GenexCast,
]);

/** Whether a kind's delivery holds meshes the lead imports (and the critic looks at its renders first). */
export const deliversMesh = (kind: AgentKind): boolean => MESH_KINDS.has(kind);

/** The checks a kind runs before it says done, one line each. */
function checksOf(kind: AgentKind): readonly string[] {
  if (MESH_KINDS.has(kind)) return MESH_CHECKS;
  if (kind === AgentKind.Sound)
    return ["Each file plays, is the length asked for, and a loop has no click at its seam."];
  if (kind === AgentKind.Texture)
    return [
      "Each image is the size asked for, tiles without a seam when it covers a surface, and shows no text or logo.",
    ];
  return ["It compiles with the check, and every class it adds is named in notes."];
}

/** How the manifest's import calls are written: every argument, since Unreal's tool schema has no defaults. */
const IMPORT_CALLS =
  "importCalls: one line per file the lead imports, the genex_build tool and its JSON arguments exactly as the lead will send them, every argument given: import_model {file, dest, name, collision, nanite} for a mesh (collision box for props, convex for odd shapes, complex for what is walked on, or none; nanite true for a heavy mesh), which lands in <dest>/<name>/; import_character {file, dest, name} for a skeletal mesh; import_animation {file, skeleton, dest, name} for a clip, skeleton being the character's skeleton asset; import_sound {file, dest, name} for a sound. dest is a /Game/ folder with no dashes, name a letter, then letters, digits or _. credits: the Genex credits your jobs spent, from their answers (creditsCharged); 0 when you ran none.";

/**
 * A worker's turn is its whole job: Genex reads its folder the moment the turn ends, and a
 * delegated session that ends to wait is never woken again.
 */
const ONE_TURN =
  "Your turn is your whole job: Genex reads your folder when it ends. Never end it to wait for something, and never wait with sleep or a background command. A Genex job that is still running: call genex__asset wait again with the same id until it is done (each wait answers within a few minutes).";

/**
 * A worker's brief: Genex's identity first, then what to make, its inputs, how its kind works, where
 * it delivers, the manifest and the checks.
 */
export function agentBrief(options: AgentBriefOptions): string {
  const { kind, title, brief, game, folder, inputs } = options;
  const reads = inputs.length
    ? `Inputs, by their paths in your copy of the game folder (read them; never change them): ${inputs.join(", ")}.`
    : "";
  return [
    appIdentity({ folderLabel: options.folderLabel ?? "", facts: options.facts ?? UNREAL_AT_ROOT }),
    `You are a worker of the Unreal Loop: the lead builds ${game} in the user's Unreal editor and asked you for one thing. You work in a copy of the game folder, without Unreal: never open, call or script the Unreal Editor, and never touch unreal/Content or unreal/Config.`,
    `Make: ${title}.\n${brief}`,
    reads,
    KIND_WORK[kind](options),
    `Write only in ${folder}/ (and your scripts in assets/src/). When every file is there, write ${folder}/${AGENT_MANIFEST_FILE} last, in this shape:\n${manifestShape(options)}\n${IMPORT_CALLS}`,
    `Before you write the manifest, check:\n${checksOf(kind)
      .map((line) => `- ${line}`)
      .join("\n")}`,
    ONE_TURN,
    "Then stop: Genex lands your folder in the game and tells the lead.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── the lead's news ──────────────────────────────────────────────────────────────────────────

/** One delivered file in a line: its name, role and what was measured. */
function fileLine(file: AgentManifestFile): string {
  const name = file.path.split("/").at(-1) ?? file.path;
  const measured = [
    file.role,
    file.triangles === undefined ? "" : `${file.triangles.toLocaleString("en-US")} triangles`,
    file.sizeCm ? `${file.sizeCm.map((n) => Math.round(n)).join(" × ")} cm` : "",
    file.pivot ? `pivot ${file.pivot}` : "",
    file.materials?.length ? `materials ${file.materials.join(", ")}` : "",
    file.meshes !== undefined && file.meshes > 1 ? `${file.meshes} meshes` : "",
  ].filter(Boolean);
  return `- ${name}: ${measured.join(", ")}`;
}

/** What one delivery holds, as the lead's news says it. */
export type DeliveryNews = {
  id: string;
  kind: AgentKind;
  title: string;
  folder: string;
  manifest: AgentManifest | null;
  landed: string[];
  /** Files git couldn't check out into the game folder yet. */
  pending: string[];
  refused: string[];
  /** The critic's look at its renders, when it had renders to look at. */
  look?: AssetLook;
  /** The lead's engine, which spells `worker_mark`. */
  engine: string;
};

/** The critic's look at a delivery's renders, as the news says it ("" when it had none to look at). */
function lookText(look: AssetLook | undefined): string {
  if (!look) return "";
  if ("error" in look) return DELIVERY_WORDS.LookFailed(look.error);
  if (look.verdict === AssetVerdict.Ready) return DELIVERY_WORDS.LooksReady;
  const defects = look.defects.map((item) => `- ${item.defect}${item.fix ? ` — fix: ${item.fix}` : ""}`);
  return [DELIVERY_WORDS.NotReady, ...defects, DELIVERY_WORDS.DontImport].join("\n");
}

/** A delivered worker's news, repeated until the lead marks it: its files, hero render, import calls and notes. */
export function deliveredNews(news: DeliveryNews): string {
  const { manifest } = news;
  const head = `Worker ${news.id} (${agentTitle(news.kind, news.title)}) delivered into ${news.folder}/:`;
  const named = news.landed.length ? news.landed : news.pending;
  const files = manifest?.files.length
    ? manifest.files.map(fileLine)
    : named.map((path) => `- ${path.split("/").at(-1) ?? path}`);
  const lines = [head, ...files];
  if (news.pending.length) lines.push(DELIVERY_WORDS.NotLandedYet);
  const [hero] = manifest?.renders ?? [];
  if (hero) lines.push(`Hero render: ${hero}`);
  if (manifest?.importCalls.length) lines.push(`Import: ${manifest.importCalls.join("\n  ")}`);
  if (manifest?.notes) lines.push(`Notes: ${manifest.notes}`);
  if (news.refused.length) lines.push(`Left out: ${news.refused.join("; ")}.`);
  const look = lookText(news.look);
  if (look) lines.push(look);
  const mark = toolCall(news.engine, LeadTool.WorkerMark);
  lines.push(`When you have imported it or decided against it, call ${mark} with id=${news.id}.`);
  return lines.join("\n");
}

/** What the agent tools answer, and the news of an agent that failed or stopped. */
export const AGENT_WORDS = {
  /** A worker's turn ended with nothing delivered: it goes on in its session. */
  GoOn: (folder: string) =>
    `Your turn ended, but there is no ${folder}/${AGENT_MANIFEST_FILE} yet, so nothing was delivered. Go on and finish in this turn. If Genex jobs are still running, call genex__asset wait with their ids again until they are done (never sleep or wait in the background), then write the files and the manifest.`,
  Started: (id: string, engine: string) =>
    `Started worker ${id}: it works in a copy of the game while you keep building. Genex lands its delivery and tells you; ${toolCall(engine, LeadTool.WorkerStatus)} says how it goes.`,
  Refused: (why: string) => `No worker started: ${why}.`,
  TooMany: (max: number) => `at most ${max} workers work at once; wait for one first`,
  UnknownKind: (kinds: readonly string[]) =>
    `no plugin that is on declares that worker type; the known types are ${kinds.join(", ") || "none"} (or start one with no type)`,
  TypedIsolation: (kind: string) =>
    `a ${kind} worker always works in a copy of its own (isolation copy); start a reader with no type`,
  NeedsTitle: "it needs a title and a whole brief",
  NoBlender: "Local Blender isn't on, so there is no modeling tool",
  NoGenex: "Genex Tools isn't on, so there is no asset tool",
  OverCap: (spent: number, cap: number) =>
    `the run's workers have spent ${spent} of their ${cap} Genex credits; use Local Blender instead`,
  NoCpp: "this computer can't build the game's C++",
  NoModule:
    "the game has no C++ module yet: Genex adds it after this turn (Unreal restarts once); ask again in your next turn",
  BadInput: (input: string, why: string) => `input ${input} ${why}`,
  TooManyInputs: (max: number) => `at most ${max} inputs`,
  Unknown: (id: string) => `There is no worker ${id}.`,
  NoAgents: "No workers started yet.",
  Status: (line: { id: string; what: string; state: string; minutes: number; extra: string }) =>
    `${line.id} (${line.what}): ${line.state}, ${line.minutes} min${line.extra ? ` — ${line.extra}` : ""}`,
  MarkedAs: (verdict: string) => `marked ${verdict}`,
  NotDelivered: (id: string, state: string) => `Worker ${id} is ${state}: only a delivered one can be marked.`,
  BadVerdict: `verdict must be ${Object.values(AgentVerdict).join(" or ")}`,
  AlreadyMarked: (id: string, verdict: string) => `${id} is already marked ${verdict}; a verdict stands once given.`,
  InGameAlready: (id: string, savePoint: string) =>
    `${id}'s work is already in the game (save point ${savePoint}), so it cannot be rejected. To take something of it out, change it in the game folder.`,
  Marked: (id: string, verdict: string) =>
    verdict === AgentVerdict.Used
      ? `Marked ${id} used: it joins your next save point on the graph.`
      : `Marked ${id} rejected: its news stops; its files stay in the game folder.`,
  Failed: (id: string, what: string, why: string) => `Worker ${id} (${what}) failed: ${why}`,
  Stopped: (id: string, what: string) => `Worker ${id} (${what}) was stopped before it delivered.`,
  InputsSnapshot: (id: string) => `Before worker ${id}`,
  /** A typed worker whose copy was too large to make: the host's words, then where to work instead. */
  CopyTooLarge: (host: string, engine: string) =>
    `${host} Start a worker with no type and isolation lock (${toolCall(engine, LeadTool.WorkerStart)}) to work in the game folder itself.`,
  CannotSteer: (id: string) =>
    `${id} is a typed worker and cannot be steered: stop it and start another with the new task.`,
  Stopping: (id: string) =>
    `Stopping ${id}: a delivery whose manifest it wrote still lands; otherwise it ends as stopped.`,
  NotRunning: (id: string, state: string) => `Worker ${id} is ${state}, not running.`,
  WaitingForPerson: (question: string) =>
    `waiting for the person: ${question}. Stop it, or work around it; other workers keep going.`,
  StoppedByLead: "stopped by the lead",
} as const;

/** Why a delivered file stayed out, or what the lead should know about it. */
export const DELIVERY_WORDS = {
  LooksReady: "The critic looked at its renders: ready, it matches its brief.",
  NotReady: "The critic looked at its renders: not ready.",
  DontImport:
    "Don't put it in the game as it is: start a worker again with these fixes in its brief, or mark it rejected.",
  LookFailed: (why: string) =>
    `The critic couldn't look at its renders (${why}): look at them yourself before you import it.`,
  NotRegular: (path: string) => `${path} is not a regular file`,
  Outside: (path: string) => `${path} is outside the worker's folder`,
  TooLarge: (path: string) => `${path} is too large`,
  Malformed: "an entry git could not name",
  TooManyFiles: (count: number, max: number) => `it made ${count} files, more than the ${max} one delivery takes`,
  NothingToLand: "it delivered nothing Genex could land",
  NoManifest: `it wrote no ${AGENT_MANIFEST_FILE}: look at the files yourself`,
  BadManifest: (why: string) => `its ${AGENT_MANIFEST_FILE} could not be read (${why}): look at the files yourself`,
  MultiMesh: (path: string, meshes: number) =>
    `${path} holds ${meshes} meshes, and one file holds one mesh unless the brief asked for more`,
  OverBudget: (path: string, triangles: number) =>
    `${path} has ${triangles.toLocaleString("en-US")} triangles; a prop is at most ${PROP_TRIANGLES.toLocaleString("en-US")} unless it is a hero piece`,
  NotDelivered: (path: string) => `its manifest lists ${path}, which it did not deliver`,
  RunEnded: "the run ended while it worked",
  NotLandedYet:
    "Its files are not in the game folder yet (git was busy): Genex puts them there before your next turn. Import nothing from it until then.",
  NoReason: "no reason given",
} as const;
