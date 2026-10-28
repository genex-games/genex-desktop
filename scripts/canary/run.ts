// One canary machine's run: download Genex from its public link, install it as a person does,
// start it with no account, run one sandboxed agent command against a fake engine, and keep the
// logs. Each step's outcome goes to <evidence>/result.json as it finishes (results.ts).
//
//   node scripts/canary/run.ts --machine macos-26 --kind dmg --tag v0.1.11 --evidence <dir> \
//     [--persona owner|standard-user] [--package <file>] [--release-src <dir>] [--install-only] \
//     [--upgrade-from v0.1.23]
//
// --upgrade-from (Windows owner, with --package): install that earlier release first and start it
// once, then install the package over it as its update (upgrade.ts).
// --package reuses a file an earlier run downloaded and checked (a Windows machine's standard
// user installs the same Setup.exe its owner did). --release-src is a checkout of the release's
// tag: its tests/e2e/run-electron-e2e.mjs drives the agent command, so the fake engine's script
// matches the build. Exits 1 when a step failed.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { runAgentCommand } from "./agent-command.ts";
import { logLength, logSince, readStart, type StartWait, waitForStart } from "./first-start.ts";
import {
  download,
  PackageKind,
  PUBLIC_LINKS,
  parseSha256Sums,
  releaseAssetUrl,
  type WaitClock,
  waitForRelease,
} from "./links.ts";
import { type Installed, PLATFORMS, type Platform, screenshot, type Verdict } from "./platforms.ts";
import { waitForRepository } from "./repository.ts";
import { CanaryStep, machinePassed, type Persona, Persona as PersonaName, recorder, StepOutcome } from "./results.ts";
import { powershell, sh, tail } from "./shell.ts";
import {
  APPROVALS_FILE,
  approvalsBetween,
  PROMPTS_ON_FILE,
  PROMPTS_SWITCHED_FILE,
  approvalVerdict,
  fetchEarlierRelease,
  pressButton,
  readApprovals,
  SEEDED_GAME,
  seedGame,
  UPDATE_BUTTON,
  upgradeCardLine,
} from "./upgrade.ts";

/** How long a person's first start may take to reach the studio: Windows sets up its sandbox first. */
const FIRST_START_BUDGET_MS = {
  [PackageKind.Exe]: 3 * MINUTE_MS,
  [PackageKind.Dmg]: 90 * SECOND_MS,
  [PackageKind.Deb]: 90 * SECOND_MS,
  [PackageKind.Rpm]: 90 * SECOND_MS,
} as const satisfies Record<PackageKind, number>;
const START_POLL_MS = SECOND_MS;
/** How long the update card may take to show after the build is installed over the earlier one. */
const UPGRADE_CARD_BUDGET_MS = 4 * MINUTE_MS;
/** How long Setup.exe's own start of the updated app is waited for before the canary opens it. */
const UPGRADE_LAUNCH_WAIT_MS = MINUTE_MS;
/** How long the approval helper may take to turn Windows' prompt on before Update is pressed. */
const PROMPTS_ON_WAIT_MS = 15 * SECOND_MS;
/** How long the Update button is looked for on the card. */
const UPDATE_BUTTON_MS = 90 * SECOND_MS;
/** How long the start after the update may take: the sandbox's install, then grants on the kept profile. */
const UPGRADE_START_BUDGET_MS = 12 * MINUTE_MS;

const clock: WaitClock = { now: Date.now, sleep };

type Recorder = ReturnType<typeof recorder>;

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

/** Link and checksum: the public link serves the tag, and its file matches the release's SHA256SUMS. */
async function fetchPackage(
  kind: PackageKind,
  tag: string,
  downloads: string,
  record: Recorder,
): Promise<string | null> {
  const wait = await waitForRelease(kind, tag, clock);
  const hops = wait.target.hops.join(" → ");
  await record.add({
    step: CanaryStep.Link,
    outcome: wait.ok ? StepOutcome.Pass : StepOutcome.Fail,
    seconds: seconds(wait.waitedMs),
    detail: wait.ok
      ? hops
      : `still serves ${wait.target.tag ?? "no release"} after ${seconds(wait.waitedMs)} s: ${hops}`,
  });
  if (!wait.ok) return null;
  const { url, asset } = PUBLIC_LINKS[kind];
  await mkdir(downloads, { recursive: true });
  const file = path.join(downloads, asset);
  try {
    const sums = parseSha256Sums(await (await fetch(releaseAssetUrl(tag, "SHA256SUMS"))).text());
    const got = await download(url, file);
    const expected = sums.get(asset);
    const ok = expected === got.sha256;
    await record.add({
      step: CanaryStep.Checksum,
      outcome: ok ? StepOutcome.Pass : StepOutcome.Fail,
      detail: `${asset} ${got.bytes} bytes sha256 ${got.sha256}${ok ? "" : `, SHA256SUMS says ${expected ?? "nothing"}`}`,
    });
    return ok ? file : null;
  } catch (error) {
    await record.add({ step: CanaryStep.Checksum, outcome: StepOutcome.Fail, detail: String(error) });
    return null;
  }
}

/** The first start a person makes: open it (unless the installer did), wait for the studio, close it. */
async function firstStart(
  platform: Platform,
  installed: Installed,
  kind: PackageKind,
  offset: number,
  evidence: string,
  shot = "first-start.png",
  budgetMs: number = FIRST_START_BUDGET_MS[kind],
): Promise<Verdict & { seconds?: number }> {
  if (!installed.startedByInstaller) await platform.launch(installed, evidence);
  const log = path.join(installed.userData, "logs", "studio.log");
  const wait = await waitForStart(log, offset, budgetMs, clock, START_POLL_MS);
  if (wait.timedOut) await platform.overrun?.(installed, evidence);
  await screenshot(path.join(evidence, shot));
  await platform.quit(installed);
  const { readyMs, sandboxMs, failure, problem } = wait.reading;
  const sandbox = sandboxMs === null ? "" : `, sandbox started in ${seconds(sandboxMs)} s`;
  if (readyMs !== null)
    return {
      outcome: StepOutcome.Pass,
      seconds: seconds(wait.wallMs),
      detail: `studio ready at ${seconds(readyMs)} s of its process${sandbox}`,
    };
  const budget = `no studio after ${seconds(wait.wallMs)} s (budget ${budgetMs / SECOND_MS} s)${sandbox}`;
  const why = failure ?? (problem ? `${budget}: ${problem}` : budget);
  return { outcome: StepOutcome.Fail, seconds: seconds(wait.wallMs), detail: why };
}

/** The agent command on the installed app, then the app closed (the runner leaves it when stopped). */
async function agentCommand(
  platform: Platform,
  releaseSrc: string,
  installed: Installed,
  evidence: string,
  userData?: string,
): Promise<Verdict & { seconds?: number }> {
  const started = Date.now();
  const log = path.join(evidence, "agent-command.log");
  const verdict = await runAgentCommand(releaseSrc, installed.packageDir, log, userData);
  await platform.quit(installed);
  return { ...verdict, seconds: seconds(Date.now() - started) };
}

/** Crash dumps the app's own crash reporter wrote (main sets crashDumps to userData/Crashpad). */
async function crashpadDumps(userData: string): Promise<string[]> {
  const dir = path.join(userData, "Crashpad");
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".dmp"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Copy what a failure's reader needs: the app's logs and crash dumps, the system's crash reports, the machine. */
async function keepEvidence(platform: Platform, evidence: string): Promise<string[]> {
  const userData = platform.userData();
  const quietly = (from: string, to: string) => cp(from, to, { recursive: true, force: true }).catch(() => {});
  await quietly(path.join(userData, "logs"), path.join(evidence, "userData-logs"));
  await quietly(path.join(userData, "Crashpad"), path.join(evidence, "crashpad"));
  const reports = [...(await crashpadDumps(userData)), ...(await platform.crashReports())];
  for (const report of reports) await quietly(report, path.join(evidence, "crash-reports", path.basename(report)));
  if (process.platform === "win32") {
    const squirrel = path.join(process.env.LOCALAPPDATA ?? "", "SquirrelTemp", "SquirrelSetup.log");
    await quietly(squirrel, path.join(evidence, "SquirrelSetup.log"));
  }
  await writeFile(path.join(evidence, "machine.txt"), await machineInfo());
  return reports;
}

/** The OS, the account and what its protections said, as plain text. */
async function machineInfo(): Promise<string> {
  const lines = [
    `${os.type()} ${os.release()} ${os.version()} ${os.arch()}`,
    `user ${os.userInfo().username}, home ${os.homedir()}`,
  ];
  lines.push(`${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 2 ** 30)} GB memory`);
  if (process.platform === "darwin") lines.push((await sh("sw_vers", [])).stdout);
  if (process.platform === "linux") {
    lines.push(await readFile("/etc/os-release", "utf8").catch(() => ""));
    lines.push((await sh("sysctl", ["kernel.apparmor_restrict_unprivileged_userns"])).stdout);
  }
  if (process.platform === "win32") {
    const script = [
      "(Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber | Format-List | Out-String)",
      "(whoami /groups | Select-String 'S-1-5-32-544|Mandatory Label' | Out-String)",
      // Whether Windows asks for approval, and of whom: the account's SID (RID 500 is the built-in Administrator).
      "(whoami /user | Out-String)",
      "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' | Select-Object EnableLUA, ConsentPromptBehaviorAdmin, ConsentPromptBehaviorUser, FilterAdministratorToken, PromptOnSecureDesktop | Format-List | Out-String)",
      "(Get-MpThreatDetection -ErrorAction SilentlyContinue | Format-List | Out-String)",
    ].join("; ");
    lines.push((await powershell(script)).stdout);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      machine: { type: "string" },
      kind: { type: "string" },
      tag: { type: "string" },
      evidence: { type: "string" },
      persona: { type: "string" },
      package: { type: "string" },
      "release-src": { type: "string" },
      "install-only": { type: "boolean", default: false },
      "upgrade-from": { type: "string" },
    },
  });
  const { machine, tag } = values;
  const kind = Object.values(PackageKind).find((known) => known === values.kind);
  if (!machine || !kind || !tag || !values.evidence)
    throw new Error("--machine, --kind (dmg|exe|deb|rpm), --tag and --evidence are required");
  const persona = Object.values(PersonaName).find((known) => known === values.persona);
  const evidence = path.resolve(values.evidence);
  await mkdir(evidence, { recursive: true });
  const record = recorder(evidence, { machine, kind, tag });
  const platform: Platform = PLATFORMS[kind];
  const at = { persona };

  const earlier = values["upgrade-from"];
  if (earlier) {
    if (!values.package)
      throw new Error("--upgrade-from needs --package: the build installed over the earlier release");
    await upgradeRun(platform, record, evidence, {
      earlier,
      file: values.package,
      ...(values["release-src"] ? { releaseSrc: path.resolve(values["release-src"]) } : {}),
    });
    return finish(record, platform, evidence, at.persona);
  }
  const file = values.package ?? (await fetchPackage(kind, tag, path.join(evidence, "download"), record));
  if (!file) return finish(record, platform, evidence);

  const log = path.join(platform.userData(), "logs", "studio.log");
  const offset = logLength(log);
  let installed: Installed;
  try {
    installed = await platform.install(file, evidence);
    await record.add({ ...at, step: CanaryStep.Install, outcome: StepOutcome.Pass, detail: tail(installed.output, 3) });
  } catch (error) {
    await record.add({ ...at, step: CanaryStep.Install, outcome: StepOutcome.Fail, detail: String(error) });
    return finish(record, platform, evidence);
  }
  if (persona !== PersonaName.StandardUser)
    await record.add({ ...at, step: CanaryStep.Trust, ...(await platform.trust(file, installed)) });
  const repository = kind === PackageKind.Deb || kind === PackageKind.Rpm;
  if (repository)
    await record.add({ step: CanaryStep.Repository, ...(await waitForRepository(kind, tag.replace(/^v/, ""), clock)) });
  if (values["install-only"]) return finish(record, platform, evidence);

  await record.add({
    ...at,
    step: CanaryStep.FirstStart,
    ...(await firstStart(platform, installed, kind, offset, evidence)),
  });
  if (values["release-src"])
    await record.add({
      ...at,
      step: CanaryStep.AgentCommand,
      ...(await agentCommand(platform, path.resolve(values["release-src"]), installed, evidence)),
    });
  return finish(record, platform, evidence, at.persona);
}

/** What an upgrade run installs: the earlier release by its tag, then `file` over it. */
interface UpgradePlan {
  earlier: string;
  file: string;
  releaseSrc?: string;
}

/**
 * Upgrade mode (Windows owner): the earlier release with a game in its library, started once, which
 * sets the sandbox up for its own srt-win and grants that game with its own kept entries; then the
 * build installed over it as its update. That start must show the update card; its Update button
 * must raise exactly one approval (uac-approver.ps1 approves it); the studio must come up, and the
 * agent command runs on that same profile.
 */
async function upgradeRun(platform: Platform, record: Recorder, evidence: string, plan: UpgradePlan): Promise<void> {
  const owner = { persona: PersonaName.Owner };
  const userData = platform.userData();
  let earlier: Installed;
  try {
    const fetched = await fetchEarlierRelease(plan.earlier, path.join(evidence, "download-earlier"));
    await seedGame(userData);
    const offset = logLength(path.join(userData, "logs", "studio.log"));
    // Not as a download: SmartScreen holds an unrecognized release at "Windows protected your PC"
    // where UAC is on, and the earlier release's own install is not what this run proves.
    earlier = await platform.install(fetched.file, evidence, undefined, false).catch(async (error: unknown) => {
      await installFailed(evidence, "earlier-install");
      throw error;
    });
    // Its own budget: what is proven here is the update, and a slow first start only delays it.
    const started = await firstStart(
      platform,
      earlier,
      PackageKind.Exe,
      offset,
      evidence,
      "earlier-start.png",
      UPGRADE_START_BUDGET_MS,
    );
    await record.add({
      ...owner,
      step: CanaryStep.EarlierRelease,
      ...started,
      detail: `${fetched.detail}; ${started.detail}; ${SEEDED_GAME} in its library`,
    });
    if (started.outcome === StepOutcome.Fail) return;
  } catch (error) {
    await record.add({ ...owner, step: CanaryStep.EarlierRelease, outcome: StepOutcome.Fail, detail: String(error) });
    return;
  }
  const log = path.join(userData, "logs", "studio.log");
  const offset = logLength(log);
  let installed: Installed;
  try {
    installed = await platform.install(plan.file, evidence, earlier);
    await record.add({
      ...owner,
      step: CanaryStep.Install,
      outcome: StepOutcome.Pass,
      detail: `${installed.output}, over ${earlier.packageDir}`,
    });
  } catch (error) {
    await installFailed(evidence, "install");
    await record.add({ ...owner, step: CanaryStep.Install, outcome: StepOutcome.Fail, detail: String(error) });
    return;
  }
  const card = await waitForCard(platform, installed, log, offset, evidence);
  await record.add({ ...owner, step: CanaryStep.UpgradeCard, ...card });
  if (card.outcome === StepOutcome.Fail) return platform.quit(installed);
  const helperReady = await promptsOn(evidence);
  const pressedAt = Date.now();
  const pressed = await pressButton(UPDATE_BUTTON, UPDATE_BUTTON_MS);
  await sleep(5 * SECOND_MS);
  await screenshot(path.join(evidence, "upgrade-updating.png"));
  const wait = await waitForStart(log, offset, UPGRADE_START_BUDGET_MS, clock, START_POLL_MS);
  const readyAt = Date.now();
  await screenshot(path.join(evidence, "upgrade-ready.png"));
  await platform.quit(installed);
  const approvals = readApprovals(await readFile(path.join(evidence, APPROVALS_FILE), "utf8").catch(() => ""));
  const approval =
    pressed.outcome === StepOutcome.Fail
      ? pressed
      : approvalVerdict(approvalsBetween(approvals, pressedAt, readyAt), helperReady);
  await record.add({ ...owner, step: CanaryStep.UpgradeApproval, ...approval });
  await record.add({
    ...owner,
    step: CanaryStep.UpgradeStart,
    seconds: seconds(wait.wallMs),
    ...upgradeStartVerdict(wait),
  });
  if (plan.releaseSrc)
    await record.add({
      ...owner,
      step: CanaryStep.AgentCommand,
      ...(await agentCommand(platform, plan.releaseSrc, installed, evidence, userData)),
    });
}

/** What the screen and Setup's processes looked like when an install laid nothing down: `<name>.png`, `<name>.txt`. */
async function installFailed(evidence: string, name: string): Promise<void> {
  await screenshot(path.join(evidence, `${name}.png`));
  const processes = await powershell(
    "Get-Process | Where-Object { $_.Name -match 'setup|update|genex|smartscreen|consent' } | Format-Table Id, Name, Path, StartTime -AutoSize | Out-String -Width 300",
  );
  await writeFile(path.join(evidence, `${name}.txt`), `${processes.stdout}${processes.stderr}`);
}

/** Ask the approval helper to turn Windows' prompt on; whether it did within {@link PROMPTS_ON_WAIT_MS}. */
async function promptsOn(evidence: string): Promise<boolean> {
  await writeFile(path.join(evidence, PROMPTS_ON_FILE), new Date().toISOString());
  const deadline = Date.now() + PROMPTS_ON_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path.join(evidence, PROMPTS_SWITCHED_FILE))) return true;
    await sleep(START_POLL_MS);
  }
  return false;
}

/** The update card in the log after the build's install; Setup.exe opens the app, or the canary does. */
async function waitForCard(
  platform: Platform,
  installed: Installed,
  log: string,
  offset: number,
  evidence: string,
): Promise<Verdict & { seconds?: number }> {
  const started = Date.now();
  let launched = false;
  for (;;) {
    const text = logSince(log, offset);
    const line = upgradeCardLine(text);
    const waited = Date.now() - started;
    if (line) {
      // The card draws once main answers the window; give it a moment before the photograph.
      await sleep(3 * SECOND_MS);
      await screenshot(path.join(evidence, "upgrade-card.png"));
      return { outcome: StepOutcome.Pass, seconds: seconds(waited), detail: line.replace(/^\[main\] /, "") };
    }
    if (!launched && !text && waited > UPGRADE_LAUNCH_WAIT_MS) {
      await platform.launch(installed, evidence);
      launched = true;
    }
    if (waited > UPGRADE_CARD_BUDGET_MS) {
      await screenshot(path.join(evidence, "upgrade-card.png"));
      const reading = readStart(text);
      const seen =
        reading.readyMs !== null ? "the studio opened without asking" : (reading.problem ?? "nothing logged");
      return {
        outcome: StepOutcome.Fail,
        seconds: seconds(waited),
        detail: `no update card in ${seconds(waited)} s: ${seen}`,
      };
    }
    await sleep(START_POLL_MS);
  }
}

/** The start after the update: the studio up, its harness booted on the first try (no rewind). */
function upgradeStartVerdict(wait: StartWait): Verdict {
  const { readyMs, failure, problem } = wait.reading;
  if (readyMs === null)
    return { outcome: StepOutcome.Fail, detail: failure ?? problem ?? `no studio after ${seconds(wait.wallMs)} s` };
  const rewound = problem?.startsWith("the harness could not boot at startup") ? `; ${problem}` : "";
  return {
    outcome: rewound ? StepOutcome.Fail : StepOutcome.Pass,
    detail: `studio ready at ${seconds(readyMs)} s of its process${rewound}`,
  };
}

/** The crash step and the evidence, whatever happened before; the exit code from the result. */
async function finish(record: Recorder, platform: Platform, evidence: string, persona?: Persona): Promise<void> {
  const reports = await keepEvidence(platform, evidence);
  const crashed = reports.length > 0;
  const names = reports.map((report) => path.basename(report)).join(", ");
  await record.add({
    persona,
    step: CanaryStep.Crashes,
    outcome: crashed ? StepOutcome.Warn : StepOutcome.Pass,
    detail: crashed ? `crash reports: ${names}` : "no crash reports",
  });
  if (!machinePassed(record.result)) process.exitCode = 1;
}

await main();
