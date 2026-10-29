// One canary machine's run: download Genex from its public link, install it as a person does,
// start it with no account, run one sandboxed agent command against a fake engine, and keep the
// logs. Each step's outcome goes to <evidence>/result.json as it finishes (results.ts).
//
//   node scripts/canary/run.ts --machine macos-26 --kind dmg --tag v0.1.11 --evidence <dir> \
//     [--persona owner|standard-user] [--package <file>] [--release-src <dir>] [--install-only]
//
// --package reuses a file an earlier run downloaded and checked (a Windows machine's standard
// user installs the same Setup.exe its owner did). --release-src is a checkout of the release's
// tag: its tests/e2e/run-electron-e2e.mjs drives the agent command, so the fake engine's script
// matches the build. Exits 1 when a step failed.
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { runAgentCommand } from "./agent-command.ts";
import { logLength, waitForStart } from "./first-start.ts";
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

/** How long a person's first start may take to reach the studio: Windows sets up its sandbox first. */
const FIRST_START_BUDGET_MS = {
  [PackageKind.Exe]: 3 * MINUTE_MS,
  [PackageKind.Dmg]: 90 * SECOND_MS,
  [PackageKind.Deb]: 90 * SECOND_MS,
  [PackageKind.Rpm]: 90 * SECOND_MS,
} as const satisfies Record<PackageKind, number>;
const START_POLL_MS = SECOND_MS;

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
): Promise<Verdict & { seconds?: number }> {
  if (!installed.startedByInstaller) await platform.launch(installed, evidence);
  const log = path.join(installed.userData, "logs", "studio.log");
  const wait = await waitForStart(log, offset, FIRST_START_BUDGET_MS[kind], clock, START_POLL_MS);
  if (wait.timedOut) await platform.overrun?.(installed, evidence);
  await screenshot(path.join(evidence, "first-start.png"));
  await platform.quit(installed);
  const { readyMs, sandboxMs, failure, problem } = wait.reading;
  const sandbox = sandboxMs === null ? "" : `, sandbox started in ${seconds(sandboxMs)} s`;
  if (readyMs !== null)
    return {
      outcome: StepOutcome.Pass,
      seconds: seconds(wait.wallMs),
      detail: `studio ready at ${seconds(readyMs)} s of its process${sandbox}`,
    };
  const budget = `no studio after ${seconds(wait.wallMs)} s (budget ${FIRST_START_BUDGET_MS[kind] / SECOND_MS} s)${sandbox}`;
  const why = failure ?? (problem ? `${budget}: ${problem}` : budget);
  return { outcome: StepOutcome.Fail, seconds: seconds(wait.wallMs), detail: why };
}

/** The agent command on the installed app, then the app closed (the runner leaves it when stopped). */
async function agentCommand(
  platform: Platform,
  releaseSrc: string,
  installed: Installed,
  evidence: string,
): Promise<Verdict & { seconds?: number }> {
  const started = Date.now();
  const verdict = await runAgentCommand(releaseSrc, installed.packageDir, path.join(evidence, "agent-command.log"));
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
