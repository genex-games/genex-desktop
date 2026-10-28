/**
 * The eval CLI (`npm run eval -- <command> [args]`, docs/evals.md): one registry row per command of
 * the plan (§12), each naming how it uses `--live` and delegating to the handler its owning module
 * exports (`scripts/evals/cli/bindings.ts`). The registry resolves the command, answers `--help`,
 * applies the live gate (a command that spends quota or sends data needs `--live`, and none runs
 * live in CI) and hands the rest of the line to the handler; it decides nothing else.
 */
import { pathToFileURL } from "node:url";
import { SYSTEM_HANDLERS } from "./evals/cli/bindings.ts";
import { CliExit, type CliRun, EXIT_USAGE, type Out } from "./evals/cli/exit.ts";
import { commandHelp, FOOTER, MESSAGE } from "./evals/cli/help.ts";
import { LIVE_FLAG, LiveNeed, LiveRefusal, liveGate } from "./evals/cli/live.ts";
import { AaaTasteMode, EvalCommand } from "./evals/vocabulary.ts";

export { CliExit, type CliRun, type CommandHandler, EXIT_USAGE, type Out } from "./evals/cli/exit.ts";

/** One registry row: the command, how its line uses `--live`, and its handler. */
export interface CommandSpec {
  command: EvalCommand;
  live: (args: readonly string[]) => LiveNeed;
  run: CliRun;
}

/** What the CLI prints before a handler runs, as codes a caller can match. */
export const CliOutcome = {
  UnknownCommand: "unknown-command",
  ...LiveRefusal,
} as const;
export type CliOutcome = (typeof CliOutcome)[keyof typeof CliOutcome];

const local = () => LiveNeed.None;
const live = () => LiveNeed.Required;
/** `diagnostics` spends grader quota only when it re-grades the repeatability sample. */
const liveWhenResampling = (args: readonly string[]) =>
  args.includes("--repeatability") ? LiveNeed.Required : LiveNeed.None;

/** `aaa grade` asks a model only when its taste judge is live. */
const liveWhenTasteLive = (args: readonly string[]) => {
  const at = args.indexOf("--taste");
  return at >= 0 && args[at + 1] === AaaTasteMode.Live ? LiveNeed.Required : LiveNeed.None;
};

/** The machine's registry row of a command. */
const row = (command: EvalCommand, need: CommandSpec["live"]): CommandSpec => ({
  command,
  live: need,
  run: SYSTEM_HANDLERS[command],
});

/** Every command, in the order `--help` lists them. */
export const COMMANDS: readonly CommandSpec[] = [
  row(EvalCommand.Doctor, local),
  row(EvalCommand.Cases, local),
  row(EvalCommand.CampaignPlan, local),
  row(EvalCommand.CampaignRun, () => LiveNeed.Switch),
  row(EvalCommand.Grade, live),
  row(EvalCommand.Regrade, live),
  row(EvalCommand.Report, local),
  row(EvalCommand.Compare, local),
  row(EvalCommand.Check, local),
  row(EvalCommand.BaselinePromote, local),
  row(EvalCommand.LedgerExport, local),
  row(EvalCommand.LedgerPublish, live),
  row(EvalCommand.LedgerShare, live),
  row(EvalCommand.LedgerUnshare, live),
  row(EvalCommand.Calibrate, live),
  row(EvalCommand.Review, local),
  row(EvalCommand.Gc, local),
  row(EvalCommand.ValidateLedger, local),
  row(EvalCommand.Diagnostics, liveWhenResampling),
  row(EvalCommand.AaaSuite, local),
  row(EvalCommand.AaaCollect, local),
  row(EvalCommand.AaaGrade, liveWhenTasteLive),
  row(EvalCommand.AaaReferences, live),
];

/** The registry row a command line names: the longest command that starts the arguments. */
export function findCommand(args: readonly string[]): { spec: CommandSpec; rest: string[] } | undefined {
  const matches = COMMANDS.filter((spec) => spec.command.split(" ").every((word, index) => args[index] === word));
  const spec = matches.sort((a, b) => b.command.length - a.command.length)[0];
  return spec ? { spec, rest: args.slice(spec.command.split(" ").length) } : undefined;
}

/** The overview: every command and its summary; `<command> --help` gives its usage and exit codes. */
export function helpText(): string {
  const width = Math.max(...COMMANDS.map((spec) => spec.command.length));
  const lines = COMMANDS.map((spec) => `  ${spec.command.padEnd(width)}  ${MESSAGE[spec.command].summary}`);
  return ["Usage: npm run eval -- <command> [args]", "", ...lines, "", FOOTER].join("\n");
}

/** How a test or a wrapper runs the CLI: another environment, or handlers bound to fakes. */
export interface MainOptions {
  env?: Readonly<Record<string, string | undefined>>;
  handlers?: Partial<Record<EvalCommand, CliRun>>;
}

const isHelp = (arg: string | undefined) => arg === "--help" || arg === "-h";

/** Run one command line; returns the exit code. */
export async function main(
  args: readonly string[],
  out: Out = console.log,
  options: MainOptions = {},
): Promise<number> {
  if (!args.length || isHelp(args[0])) {
    out(helpText());
    return 0;
  }
  const found = findCommand(args);
  if (!found) {
    out(`${CliOutcome.UnknownCommand}: ${args.join(" ")}`);
    out(helpText());
    return EXIT_USAGE;
  }
  const { spec, rest } = found;
  if (rest.some(isHelp)) {
    out(commandHelp(spec.command));
    return 0;
  }
  const gate = liveGate(spec.live(rest), rest, options.env ?? process.env);
  if (gate.refusal !== null) {
    out(`${gate.refusal}: ${spec.command}${gate.refusal === LiveRefusal.Required ? ` needs ${LIVE_FLAG}` : ""}`);
    return gate.refusal === LiveRefusal.Required ? EXIT_USAGE : CliExit.Refused;
  }
  return (options.handlers?.[spec.command] ?? spec.run)(gate.args, out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
