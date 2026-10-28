/**
 * The eval CLI's help text (`npm run eval -- --help`, `npm run eval -- <command> --help`): each
 * command's usage, one-line summary, what it does and its exit codes. The words live here; the
 * command table in `scripts/eval.ts` owns which handler runs.
 */
import { EvalCommand } from "../vocabulary.ts";

/** One command's help. */
export interface CommandHelp {
  usage: string;
  summary: string;
  details: readonly string[];
  exits: string;
}

const EXITS_COMMON = "exit 0 ok, 1 refused or red, 2 not ready, 64 bad usage";
const LIVE_NOTE = "Spends provider quota or sends data: needs --live, and never runs in CI.";

/** Every command's help, in the order `--help` lists them. */
export const MESSAGE: Readonly<Record<EvalCommand, CommandHelp>> = {
  [EvalCommand.Doctor]: {
    usage: "doctor",
    summary: "Check Node, CLIs, eval homes, disk and quota",
    details: [
      "Node 24, both CLIs, eval-home sign-in, host skills, Chromium, disk, the evals home, CLI home variables, quota.",
      "Installs and spends nothing; reading quota opens a status-only CLI session per signed-in home.",
    ],
    exits: "exit 0 every check passed, 1 a check failed",
  },
  [EvalCommand.Cases]: {
    usage: "cases [--check]",
    summary: "List and validate the frozen cases",
    details: [
      "Public cases from evals/cases.md, holdouts from $GENEX_EVALS_HOME/cases-private.md.",
      "--check also resolves every edit case's start folder.",
    ],
    exits: "exit 0 valid, 1 a malformed case, 64 bad usage",
  },
  [EvalCommand.CampaignPlan]: {
    usage:
      "campaign plan --cases a,b --lanes ids|primary --reps N [--apps base,cand] [--deadline-min 90] [--seed s] [--label l]",
    summary: "Plan a campaign: matrix, seeded order, canary brackets, estimates",
    details: ["Writes $GENEX_EVALS_HOME/campaigns/<id>/campaign.json; never overwrites one."],
    exits: "exit 0 planned, 64 bad usage or a refused plan",
  },
  [EvalCommand.CampaignRun]: {
    usage:
      "campaign run <id> [--live] [--budget-hours 8] [--max-quota 70] [--max-runs N] [--account-exclusive] [--serial]",
    summary: "Run a planned campaign's lanes (resumable); a dry run without --live",
    details: ["Without --live it lists what would run and touches nothing. --live never runs in CI."],
    exits: "exit 0 completed or dry run, 3 aborted, 4 void, 65 refused, 75 stopped (resumable), 64 bad usage",
  },
  [EvalCommand.Grade]: {
    usage: "grade <campaign> --live [--quick]",
    summary: "Grade a campaign's runs (full prober; --quick never promotes)",
    details: [LIVE_NOTE, "Needs a green calibration for the current prober and graders."],
    exits: EXITS_COMMON,
  },
  [EvalCommand.Regrade]: {
    usage: "regrade <runId> | --baseline --live [--reprobe]",
    summary: "Add a grade from retained evidence",
    details: [LIVE_NOTE, "--baseline regrades every run a committed baseline names."],
    exits: EXITS_COMMON,
  },
  [EvalCommand.Report]: {
    usage: "report <campaign> [--md | --html | --trend [--metric m]]",
    summary: "The scorecard, the ledger explorer, or trends over app builds",
    details: ["Prints the Diagnostics block first; --html writes $GENEX_EVALS_HOME/reports/<campaign>.html."],
    exits: "exit 0 ok, 1 a red diagnostic, 2 no rows, 64 bad usage",
  },
  [EvalCommand.Compare]: {
    usage: "compare --axis <axis> --a <campaign>:<lane>[@sha] --b <campaign>:<lane>[@sha]",
    summary: "Compare two arms on an axis's pre-registered endpoints",
    details: ["Refuses arms that differ on pins other than the axis's; n is distinct cases (<5 refuses)."],
    exits: "exit 0 compared, 1 incomparable, 2 an empty arm, 64 bad usage",
  },
  [EvalCommand.Check]: {
    usage: "check <campaign> [--baseline]",
    summary: "The total-break gate, base against candidate per cell",
    details: [
      "Base: the campaign's own base app (--apps base,cand), else the committed baseline.",
      "A committed baseline measured under other pins leaves its cell unarmed.",
      "Prints the Diagnostics block first, then the cell verdicts and drift.",
      "A red diagnostic or a refused baseline withholds a clear verdict.",
    ],
    exits: "exit 0 clear, 2 regression, 3 probable, 4 flaky, 1 refused or withheld, 64 bad usage",
  },
  [EvalCommand.BaselinePromote]: {
    usage: "baseline promote --campaign <id>",
    summary: "Promote a campaign's raw values to evals/baselines",
    details: [
      "Refuses on a red diagnostic, a failed canary, a red calibration, quick grades or thin cells.",
      "Writes evals/baselines/<case>.json for each public case and formats it with biome; holdouts are withheld.",
    ],
    exits: "exit 0 promoted, 1 refused, 2 no rows or no repeatability sample, 64 bad usage",
  },
  [EvalCommand.LedgerExport]: {
    usage: "ledger export --release <sha>",
    summary: "Write the per-release public snapshot",
    details: [
      "Writes evals/ledger/export-<sha>.jsonl: current public rows of the release's campaigns.",
      "A short sha resolves to the one full app sha it starts; an ambiguous one is refused.",
    ],
    exits: "exit 0 written, 1 a row the guard refused, 2 no rows, 64 bad usage or an ambiguous sha",
  },
  [EvalCommand.LedgerPublish]: {
    usage: "ledger publish <campaign> --live [--publish-evidence]",
    summary: "Upload the owner's rows with the ingest key",
    details: [LIVE_NOTE],
    exits: "exit 0 published, 1 refused, 64 bad usage",
  },
  [EvalCommand.LedgerShare]: {
    usage: "ledger share <campaign> --live [--yes]",
    summary: "Share public-case rows anonymously, after a preview",
    details: [LIVE_NOTE, "Prints the exact rows and asks first unless --yes."],
    exits: "exit 0 shared or nothing to share, 1 refused, declined or a send failed, 64 bad usage",
  },
  [EvalCommand.LedgerUnshare]: {
    usage: "ledger unshare --live [--yes]",
    summary: "Delete every row this machine shared, for each install id it kept",
    details: [LIVE_NOTE, "Lists the install ids and asks first unless --yes."],
    exits: "exit 0 deleted or nothing to delete, 1 refused, declined or a delete failed, 64 bad usage",
  },
  [EvalCommand.Calibrate]: {
    usage: "calibrate --live [--quick]",
    summary: "Grade the calibration fixtures with the full prober (--quick: the quick probe)",
    details: [
      LIVE_NOTE,
      "Grading refuses until a green calibration covers its pins; a quick one covers only grade --quick.",
    ],
    exits: "exit 0 green, 1 red, 2 no vendored three.js (npm run build), 64 bad usage",
  },
  [EvalCommand.Review]: {
    usage: "review <campaign> [--graders] [--sample N] [--seed S] [--reviewer ID]",
    summary: "Serve the human blind review on 127.0.0.1",
    details: ["--graders samples judged checklist items to validate the graders; labels become human rows."],
    exits: "exit 0 done, 1 failed, 64 bad usage",
  },
  [EvalCommand.Gc]: {
    usage: "gc --older-than <days>d [--apply]",
    summary: "List (or with --apply remove) old runs, snapshot-server copies and caches, and lane roots",
    details: [
      "Runs under work/ and evidence/ age by the stamp their name starts with.",
      "work/grade-copies, work/npm-cache, work/sandbox-scratch and the lane roots in",
      "<tmpdir>/genex-evals-lanes (shared by every evals home) age by their newest change.",
      "Never removes a run a committed baseline names, a symlink, or the ledger.",
    ],
    exits: "exit 0 ok, 1 a malformed baseline, 64 bad usage",
  },
  [EvalCommand.ValidateLedger]: {
    usage: "validate-ledger",
    summary: "Check every line of the local ledger",
    details: ["Names the first bad line as file:line."],
    exits: "exit 0 valid, 1 invalid, 64 bad usage",
  },
  [EvalCommand.Diagnostics]: {
    usage: "diagnostics <campaign> [--repeatability --live] [--seed s]",
    summary: "Eval-health diagnostics: grader repeatability, plumbing, headroom, noise floor",
    details: ["--repeatability re-grades a seeded sample (grader calls: needs --live)."],
    exits: EXITS_COMMON,
  },
  [EvalCommand.AaaSuite]: {
    usage: "aaa suite",
    summary: "List the AA+ release-gate prompts, their views, demos and references",
    details: ["Reads evals/aaa/suite.json; prints each prompt's version and its brief to send."],
    exits: "exit 0 valid, 64 bad usage",
  },
  [EvalCommand.AaaCollect]: {
    usage:
      "aaa collect --prompt <id> --run <runDir> --roles <roles.json> --out <dir> [--shots <dir>] [--facts <facts.json>] [--clean yes|no]",
    summary: "Turn a finished Genex run into an AA+ evidence bundle",
    details: [
      "Reads the integration head's judge shots and stats; --roles maps camera names to the prompt's view roles.",
      "--facts adds look facts, the provenance audit and per-tick motion and exposure tracks (genex-aaa-facts/1).",
    ],
    exits: "exit 0 written, 1 refused, 64 bad usage",
  },
  [EvalCommand.AaaGrade]: {
    usage:
      "aaa grade <bundleDir>... --out <dir> [--taste off|live] [--taste-family gpt|claude|gpt,claude] [--builder-family claude|gpt] [--votes n] [--references <dir>]",
    summary: "Grade evidence bundles below AA / AA / AA+ / AAA-ish and judge the release gate",
    details: [
      "Writes report.json and report.md to --out. --taste live asks the blind taste judge (grader calls: needs --live).",
      "Without a taste verdict no prompt can reach AA+.",
    ],
    exits: "exit 0 the release gate passes, 1 it fails or a bundle was refused, 2 references missing, 64 bad usage",
  },
  [EvalCommand.AaaReferences]: {
    usage: "aaa references --live [--dir <dir>]",
    summary: "Fetch the suite's CC0 reference stills into the eval home",
    details: [LIVE_NOTE, "Reaches only api.polyhaven.com and dl.polyhaven.org; each download must match its md5."],
    exits: EXITS_COMMON,
  },
};

/** The line every overview ends with. */
export const FOOTER =
  "Live work needs --live and runs only on the owner's Mac; nothing here runs live in CI. `<command> --help` for details.";

/** One command's full help. */
export function commandHelp(command: EvalCommand): string {
  const help = MESSAGE[command];
  return [`Usage: npm run eval -- ${help.usage}`, "", help.summary, ...help.details, help.exits].join("\n");
}
