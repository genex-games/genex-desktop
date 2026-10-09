/**
 * The director's tools as its engine sees them: their names (`DirectorTool`), their schemas
 * (`DIRECTOR_TOOLS`, flat string properties — both bridges), and the registry the studio's
 * `director_tool` dispatch forwards a call through to the live session's handler (tools.ts).
 */
import { FACET_POLICY } from "../facet-loop.ts";
import { KIND_NAMES } from "../kinds.ts";
import { CHECK_KINDS, MAX_DONE, MAX_MILESTONES, renderCheckGrammar } from "../spec.ts";
import { MAX_PLAN_WORKERS, MAX_WAIT_S } from "./budgets.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LiveToolSpec } from "../../types/host-api.d.ts";

/**
 * Every call a director's session makes, by the name its engine sends. The studio forwards them
 * as they are, and the feed and the tests read them: never rename a value.
 */
export const DirectorTool = {
  RunStatus: "run_status",
  Plan: "plan",
  GoalUpdate: "goal_update",
  WorkerStart: "worker_start",
  WorkerStatus: "worker_status",
  WorkerSteer: "worker_steer",
  WorkerStop: "worker_stop",
  Wait: "wait",
  Judge: "judge",
  Playtest: "playtest",
  Integrate: "integrate",
  Show: "show",
  Note: "note",
  Finish: "finish",
  /** Not a director tool: the studio asking where a target lives (it is in no schema below). */
  ResolveRoot: "resolve_root",
} as const;
export type DirectorTool = (typeof DirectorTool)[keyof typeof DirectorTool];

/**
 * The run tools, as the studio's engines see them (flat string properties — both bridges). Every
 * session pays for these bytes on every turn and check-grammar.test.ts ratchets the total: say
 * each rule once, and keep the phrases the wake swaps (wake-prompts.ts) replace.
 */
export const DIRECTOR_TOOLS: LiveToolSpec[] = [
  {
    name: DirectorTool.GoalUpdate,
    description:
      "Record an external blocker, or the one concrete replan after two failed attempts. It cannot pass a goal; only playtest goal=<id> can. The first plan freezes required goal ids and acceptance.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Initial required goal id from run_status." },
        blocker: {
          type: "string",
          description: "approval_required, network_unavailable, or hosted_verification_unavailable.",
        },
        replan: {
          type: "string",
          description: "A materially different approach; one per unresolved gap.",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: DirectorTool.RunStatus,
    description:
      "Time, integration branch, worker progress and budgets, pool slots, free memory, loop thresholds and user guidance. Read it when the wake snapshot is stale or incomplete. Boards show the first failing and unmeasured checks; worker_status has the whole board.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: DirectorTool.Plan,
    description:
      "Post the plan in the user's chat before worker_start (workers refuse without one): purpose, parts and ids, fork point, risks. If the user asked to review it, the first worker waits for their word. Call again when the plan changes.",
    parameters: {
      type: "object",
      properties: {
        scope_instruction: {
          type: "string",
          description:
            "Only for a scope change the user asked for: their steer, quoted exactly. Routine replans leave acceptance unchanged.",
        },
        summary: {
          type: "string",
          description: "What this run is for, in two or three sentences anyone could follow.",
        },
        workers: {
          type: "string",
          description: `JSON array of the parts you hand out, 1–${MAX_PLAN_WORKERS}: [{"id":"plaza-light","title":"Plaza light","seam":"the plaza's light and sky","owns":"src/plaza.js","done":["dusk from every camera"],"minutes":45}]. multiplayer:true on a part needing Genex online play checks its host prerequisites first. added:true on a part SCOPE does not name makes it optional. worker_start takes the same id; dropping or adding a part is a new plan.`,
        },
        cut: {
          type: "string",
          description: "What this run will not build, one per line or a JSON array; joins SCOPE's cut list.",
        },
        added: {
          type: "string",
          description:
            "What this plan builds that SCOPE does not name, one per line or a JSON array: each is a card asking the user, never scope until they say so.",
        },
        base: {
          type: "string",
          description:
            "What every worker forks from, in a sentence (the studio's starting point, the branch as it stands, your first fix).",
        },
        risks: {
          type: "string",
          description: "What could go wrong and what you will do about it — one per line, or a JSON array.",
        },
        kind: {
          type: "string",
          description: `Game kind: ${KIND_NAMES.join(", ")}. The harness drives its controls before every judgement and boards only checks it can pass; undeclared assumes nothing.`,
        },
        contract: {
          type: "string",
          description:
            'Module contract, required before loop workers when 2+ parts loop: JSON {"conventions":[…],"modules":[{"path","owner":"<part id>","api":[…]}],"shared":[{"path","owner"}]}. It freezes interfaces and conventions, with ranges for content (track 2.5–4 km), never a layout. Committed as docs/MODULE-CONTRACT.md; a bad one is answered with the grammar.',
        },
        vision: {
          type: "string",
          description:
            'Required with contract: JSON {"scale","far","set_pieces":[2–3],"headroom"} — the world\'s scale, what the player sees past the nearest building, set-pieces, what it could grow into. Committed as docs/VISION.md; never frozen.',
        },
        play_script: {
          type: "string",
          description:
            'Replaces the kind\'s controls when they are wrong for this game: JSON array of [{"type":"hold","keys":["w"],"ms":800},{"type":"look","dx":56,"dy":-8},{"type":"click","x":480,"y":300},{"type":"drag","fromX":100,"fromY":100,"x":300,"y":200}].',
        },
      },
      required: ["summary", "workers"],
    },
  },
  {
    name: DirectorTool.WorkerStart,
    description:
      "Start a background builder with its own git worktree and hidden preview. loop (default): build, gather evidence, check, compare blindly, keep or roll back, until done passes or the budget ends; accepted builds are committed. single: one session committed without a judge; you assess it. Returns a worker id — use wait and worker_status. One area the ask names per worker, on files of its own. The workers run_status allows are a ceiling: start the fewest that cover independent files.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "Required goal it advances (default: its id). Renaming a worker never resets attempts.",
        },
        id: {
          type: "string",
          description: "Slug (letters, digits, dashes), unique in the run.",
        },
        title: { type: "string", description: "A short title for the feed." },
        brief: {
          type: "string",
          description:
            "What to build, where in the code, what done looks like, what not to touch. The builder never sees your conversation.",
        },
        mode: {
          type: "string",
          description: "loop (default) or single.",
        },
        minutes: {
          type: "string",
          description: "Time budget (default 45; capped at what the run has left).",
        },
        iterations: {
          type: "string",
          description: "loop only: most iterations (default: from minutes).",
        },
        owns: {
          type: "string",
          description:
            'Its seam: comma-separated files, folders or globs (src/world/, "src/ui/*.tsx", "app/**/hud.*"). * and ? stop at a slash, ** crosses them; a pattern with * or ? must be QUOTED (on Codex the shell expands an unquoted glob). The reviewer reverts edits elsewhere. Empty means src/ on the studio\'s template, everything but the entry, the contract and index.html in a game of its own; name a seam whenever more than one worker runs.',
        },
        owns_main: {
          type: "string",
          description:
            "yes|no: may it edit the entry module beyond the FACET WIRING block (default: yes only for a lone worker).",
        },
        cameras: {
          type: "string",
          description: "Registered cameras its evidence comes from, comma-separated (default: default).",
        },
        done: {
          type: "string",
          description: `loop only: JSON array of 2–${MAX_DONE} measurable {"what","check"} outcomes, check in the checks grammar: [{"what":"a car keeps its speed after a bin","check":{"id":"bins-keep-speed","kind":"probe","demo":"prop-run","expr":"state.contact.speedKept >= 0.7"}}]. Identity checks need judge agreement to finish. Write it before the brief.`,
        },
        checks: {
          type: "string",
          // One grammar, rendered from spec.ts (M4.8a): the planner skill, the planner's
          // fallback and this schema had each grown a copy, and the three had stopped agreeing
          // about which helpers exist. `helpers: false` is the tool-schema voice — every
          // session pays for this description on every turn.
          description: [
            `loop only: JSON array of further typed checks, scored each iteration with done: {"id":"kebab","kind":…} plus the kind's fields; "hard":true marks one needing a technique spike.`,
            renderCheckGrammar({ kinds: CHECK_KINDS, indent: "  ", helpers: false }),
            `Each is dry-run against the fork point's state before the worker starts; unreadable ones come back unsatisfiable, with the paths that exist.`,
          ].join("\n"),
        },
        move: {
          type: "string",
          description:
            "loop only: the ONE structural change it builds first, in a sentence — what the game IS afterwards. A build without it loses. Omitted, the harness's planner invents one.",
        },
        milestones: {
          type: "string",
          description: `loop only: JSON array of ORDERED structural steps after the move — three concrete rungs with the move (at most ${MAX_MILESTONES}), each a transformation one accepted round builds (a system, a layer of depth, a reworked feel), never small fixes: [{"what":"herons wade","check":{"kind":"scene","js":"count('heron') >= 3"}}] (check optional) — then {"open":true}. One rung per accepted build; a rung the judge finds built is climbed. Every ladder ends open: when reached, the reviewers' best in-scope step fills it, mandatory like yours, or it is passed over. Once climbed the worker builds its reviewer's big move until worker_steer move= adds a rung.`,
        },
        stage: {
          type: "string",
          description: "finish: polish what exists, no move; blind pick wins, regressions roll back (default build).",
        },
        identity: {
          type: "string",
          description:
            "Comma-separated features that must be visibly true when done; a check naming one scores as identity. Prefer done.",
        },
        setup: {
          type: "string",
          description:
            'JSON state its window and judges open on: {"actions":[{"type":"tap","keys":["i"]},{"type":"click","x":480,"y":300,"px":true}],"verify":{"path":"maps.activeId","equals":"macba"},"note":"…"} or {"demo":"name","verify":{…}}. Default: the run\'s. {"begin":false}: judged on its title/menu (the front-end\'s owner).',
        },
        kind: {
          type: "string",
          description: `This part's game kind when it differs from the plan's: ${KIND_NAMES.join(", ")}.`,
        },
        critic: {
          type: "string",
          description:
            "Its per-round critic: screen for a UI or HUD part (readable, shows the game's state, every action answers on screen), place for a world a player stands in. Default: the kind's. screen makes it the one part that draws on the screen.",
        },
        traits: {
          type: "string",
          description:
            "Comma-separated traits the harness adds checks for: hud, mouseLook, keyboardMove. An unnamed trait is not measured (not declared false).",
        },
        policy: {
          type: "string",
          description: `loop only: JSON object of loop thresholds — ${Object.keys(FACET_POLICY).join(", ")}. Omitted keys keep the harness's values (see run_status).`,
        },
        from: {
          type: "string",
          description:
            "Fork point: integration (default, its HEAD), a worker id (its last commit) or a commit hash. The studio refuses a fork point that does not run.",
        },
        replaces: {
          type: "string",
          description: "Id of the worker you are restarting, so Builds groups its rounds into one part.",
        },
      },
      required: ["id", "brief"],
    },
  },
  {
    name: DirectorTool.WorkerStatus,
    description: "Full worker scoreboard, iterations, attempts, last commit, notes, phase and current gap.",
    parameters: { type: "object", properties: { id: { type: "string", description: "Omit for all workers." } } },
  },
  {
    name: DirectorTool.WorkerSteer,
    description:
      "Give a running worker an instruction (a correction, a priority, something you saw) and/or the next structural move it must build. A loop worker reads it at the top of its next round, maybe twenty minutes away, unless now=yes; use now whenever waiting would waste the round. A single session is always steered now.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string", description: "The instruction, with enough context for a builder." },
        now: {
          type: "string",
          description:
            "yes interrupts the build turn and hands it over now (it keeps what it has read and written); default no.",
        },
        move: {
          type: "string",
          description:
            "The next rung of its ladder, in a sentence — what the game IS afterwards. It becomes THE MOVE of the worker's next iteration (mandatory), ahead of its ladder and the harness's own.",
        },
        stage: { type: "string", description: "build|finish from its next round." },
      },
      required: ["id"],
    },
  },
  {
    name: DirectorTool.WorkerStop,
    description:
      "Stop a worker now. What it wrote is committed in its worktree (nothing rolled back), its round is recorded as stopped, not judged, and integrate can still take its last accepted commit.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        why: {
          type: "string",
          description: 'One line on why; the owner reads it instead of "at the user\'s request".',
        },
      },
      required: ["id"],
    },
  },
  {
    name: DirectorTool.Wait,
    description: `Wait until a worker ends, an iteration is accepted, new inspection evidence or user guidance arrives, or until the timeout (default 60 s, max ${MAX_WAIT_S}). Returns worker progress, touched files, contract violations, inspection and integration status. Use instead of polling; call again to wait longer.`,
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "string", description: `1–${MAX_WAIT_S}` },
        worker: { type: "string", description: "Only wake for this worker (still wakes for the user)." },
      },
    },
  },
  {
    name: DirectorTool.Judge,
    description:
      "Load a build, replay setup with seeded controls for thirty simulated seconds, capture cameras, player eyes, state and console; optionally score checks, ask a vision question or compare blindly. Returns frame paths: read them.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "integration (default), live, or a worker id." },
        against: {
          type: "string",
          description:
            "Other side of the blind comparison: start (the game as the run began, default), none, integration, live, or a worker id.",
        },
        cameras: { type: "string", description: "Comma-separated (default: every registered camera)." },
        checks: {
          type: "string",
          description: "JSON array of typed checks to score, in worker_start's checks grammar.",
        },
        question: {
          type: "string",
          description: "One yes/no question for the vision judge about the default (or first listed) camera.",
        },
        ship: {
          type: "string",
          description:
            "yes: the art director's absolute look at the whole game at 1600x900, alone (no against): ship or not, defects by part.",
        },
      },
    },
  },
  {
    name: DirectorTool.Playtest,
    description:
      "Send a playtester into a build with one question (can you reach X, does Y work, is Z fun). It plays for a few minutes and answers yes/no with a report; use it for what only play can tell.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "integration (default), live, or a worker id." },
        goal: {
          type: "string",
          description:
            "Required goal to verify on integration by its frozen acceptance scenarios, not your question (ask); report unavailable hosted prerequisites as blocked.",
        },
        scenario: {
          type: "string",
          description:
            "Zero-based acceptance scenario to verify; only independently passed scenarios reset no-progress attempts.",
        },
        ask: { type: "string", description: "One yes/no question (ignored with goal)." },
        minutes: { type: "string", description: "2–8, default 5." },
      },
      required: [],
    },
  },
  {
    name: DirectorTool.Integrate,
    description:
      "Merge a worker's last accepted commit into the integration branch (your worktree), union-merging the FACET WIRING block. A conflict elsewhere is left for you: the merge is aborted and the files listed — resolve it yourself with git in your worktree, then commit. A clean merge gets a health pass (does it run), not a verdict.",
    parameters: {
      type: "object",
      properties: {
        worker: {
          type: "string",
          description: "The worker id, or ids comma-separated: one wave, merged in order, one health pass.",
        },
        wave: {
          type: "string",
          description: "close: running workers take the integration head now (a healthy integrate closes the wave).",
        },
      },
    },
  },
  {
    name: DirectorTool.Show,
    description:
      "Offer a build to Live, the user's game view: integration (default), live, or a worker id. Live never changes under the user; its Reload button lights up and plays it when pressed. Nothing changes on disk.",
    parameters: { type: "object", properties: { target: { type: "string" } } },
  },
  {
    name: DirectorTool.Note,
    description:
      "Leave a decision card in the run's feed — what you decided and why, what you verified, what you are giving up on. The user reads these; write one at every turn.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The card; shas, worker ids and file paths are fine.",
        },
        plain: {
          type: "string",
          description:
            "The same in one sentence, which the chat shows, for someone who has never seen a terminal: no shas, ids, branch names or error text.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: DirectorTool.Finish,
    description:
      "Close the run: stop workers, land the integration branch in the live game folder when it is healthy (land=no keeps it unlanded), write the report. victory=yes only when you verified the goal. Call it before your deadline; an unfinished run lands nothing.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What was built, what was verified, what remains — the user's report.",
        },
        land: { type: "string", description: "yes (default) or no." },
        victory: { type: "string", description: "yes or no (default)." },
        user_asked: {
          type: "string",
          description:
            "Timed build with working time left: the user's words asking to stop or finish now, quoted exactly from their message to this run.",
        },
      },
      required: ["summary"],
    },
  },
];

/** runId → the tool handler of the live director session (the dispatch `director_tool` lands here). */
export const directors = new Map<string, (name: string, args: AnyRecord) => Promise<unknown>>();

/** The studio forwards a director's tool call; a run without a director answers with a sentence. */
export async function directorTool({
  runId,
  name,
  args,
}: {
  runId: string;
  name: unknown;
  args: unknown;
}): Promise<unknown> {
  const handler = directors.get(runId);
  if (!handler) return `no director session for run ${runId} — the run is not active in this harness`;
  return handler(String(name ?? ""), args && typeof args === "object" ? (args as AnyRecord) : {});
}

/**
 * Does this tool start at the integration worktree's real HEAD? (M4.10.)
 *
 * It used to be a set of eight names, and the five outside it — plan, worker_status,
 * worker_steer, worker_stop and note — are exactly the calls a director makes right after
 * committing by hand: it commits, writes a note about it, and the studio still believes the
 * head is where the last integrate left it. `syncHead` returns early when nothing moved, so
 * the honest rule is the cheap one: every tool the director has. `resolve_root` is not a
 * director tool at all — it is the studio asking where a target lives — and answering it must
 * not touch git.
 */
export function headSynced(name: unknown): boolean {
  return String(name ?? "") !== DirectorTool.ResolveRoot;
}
