/**
 * Each command's handler bound to the machine's own dependencies, loaded only when its command runs
 * (so `--help` and a local command never load the grader engines, Playwright or the lane runners).
 * Every binding delegates to the handler its owning module exports; nothing here decides anything.
 */
import { EvalCommand } from "../vocabulary.ts";
import type { CliRun } from "./exit.ts";

/** The machine's handler of every command. */
export const SYSTEM_HANDLERS: Readonly<Record<EvalCommand, CliRun>> = {
  [EvalCommand.Doctor]: async (args, out) => (await import("../doctor.ts")).doctorCommand(args, out),
  [EvalCommand.Cases]: async (args, out) => (await import("./cases.ts")).casesCommand(args, out),
  [EvalCommand.CampaignPlan]: async (args, out) =>
    (await import("../campaign/commands.ts")).campaignPlanCommand(args, out),
  [EvalCommand.CampaignRun]: async (args, out) =>
    (await import("../campaign/commands.ts")).campaignRunCommand(args, out),
  [EvalCommand.Grade]: async (args, out) => (await import("../grade/commands.ts")).gradeCommand(args, out),
  [EvalCommand.Regrade]: async (args, out) => (await import("../grade/commands.ts")).regradeCommand(args, out),
  [EvalCommand.Report]: async (args, out) => (await import("./report.ts")).reportCommand(args, out),
  [EvalCommand.Compare]: async (args, out) => (await import("./compare.ts")).compareCommand(args, out),
  [EvalCommand.Check]: async (args, out) => (await import("./check.ts")).checkCommand(args, out),
  [EvalCommand.BaselinePromote]: async (args, out) => (await import("./promote.ts")).baselinePromoteCommand(args, out),
  [EvalCommand.LedgerExport]: async (args, out) => (await import("./ledger.ts")).ledgerExportCommand(args, out),
  [EvalCommand.LedgerPublish]: async (args, out) => {
    const [{ ledgerPublishCommand }, { systemPublishDeps }] = await Promise.all([
      import("../remote/publish.ts"),
      import("./ledger.ts"),
    ]);
    return ledgerPublishCommand(systemPublishDeps(out))(args);
  },
  [EvalCommand.LedgerShare]: async (args, out) => {
    const [{ ledgerShareCommand }, { systemShareDeps }] = await Promise.all([
      import("../remote/share.ts"),
      import("./ledger.ts"),
    ]);
    return ledgerShareCommand(systemShareDeps(out))(args);
  },
  [EvalCommand.LedgerUnshare]: async (args, out) => {
    const [{ ledgerUnshareCommand }, { systemUnshareDeps }] = await Promise.all([
      import("../remote/share.ts"),
      import("./ledger.ts"),
    ]);
    return ledgerUnshareCommand(systemUnshareDeps(out))(args);
  },
  [EvalCommand.Calibrate]: async (args, out) => (await import("../grade/commands.ts")).calibrateCommand(args, out),
  [EvalCommand.Review]: async (args, out) => {
    const { defaultReviewDeps, reviewCommand } = await import("../review/command.ts");
    return reviewCommand({ ...defaultReviewDeps(), out })(args);
  },
  [EvalCommand.Gc]: async (args, out) => (await import("./gc.ts")).gcCommand(args, out),
  [EvalCommand.ValidateLedger]: async (args, out) => (await import("./ledger.ts")).validateLedgerCommand(args, out),
  [EvalCommand.Diagnostics]: async (args, out) => (await import("../grade/commands.ts")).diagnosticsCommand(args, out),
  [EvalCommand.AaaSuite]: async (args, out) => (await import("../aaa/command.ts")).aaaSuiteCommand(args, out),
  [EvalCommand.AaaCollect]: async (args, out) => (await import("../aaa/command.ts")).aaaCollectCommand(args, out),
  [EvalCommand.AaaGrade]: async (args, out) => (await import("../aaa/command.ts")).aaaGradeCommand(args, out),
  [EvalCommand.AaaReferences]: async (args, out) => (await import("../aaa/command.ts")).aaaReferencesCommand(args, out),
};
