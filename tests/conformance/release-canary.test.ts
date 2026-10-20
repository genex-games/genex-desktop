import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import {
  AGENT_CHECKS,
  agentChecksDone,
  agentChecksFor,
  agentVerdict,
  CLAUDE_WORKER_CHECKS,
  readSelfTest,
} from "../../scripts/canary/agent-command.ts";
import { CLAUDE_WORKER_CHECK } from "../../src/main/smoke/claude-worker-check.ts";
import { gitHubSignIn, gitHubToken, ownerResult, signInDue, sizesWithRoom } from "../../scripts/canary/azure.ts";
import { readStart } from "../../scripts/canary/first-start.ts";
import {
  assetTag,
  PackageKind,
  PUBLIC_LINKS,
  parseSha256Sums,
  resolveLink,
  type WaitClock,
  waitForRelease,
} from "../../scripts/canary/links.ts";
import { IssueAction, issueAction, summaryMarkdown, withMissing } from "../../scripts/canary/report.ts";
import { aptVersions, isRelease } from "../../scripts/canary/repository.ts";
import {
  CanaryStep,
  type MachineResult,
  machinePassed,
  mergeMachines,
  Persona,
  RESULT_FILE,
  readResult,
  StepOutcome,
} from "../../scripts/canary/results.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ASSETS = "https://github.com/genex-games/genex-desktop/releases/download";
const DMG = PUBLIC_LINKS[PackageKind.Dmg];
const EXE = PUBLIC_LINKS[PackageKind.Exe];

/** A fetch that answers HEAD requests from a table of redirects, recording what it was asked. */
function redirects(table: Record<string, string | null>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const location = table[url];
    if (location === undefined) throw new Error(`offline: ${url}`);
    return new Response(null, location === null ? { status: 200 } : { status: 302, headers: { location } });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/** A clock that only moves when the code under test sleeps. */
function heldClock(): WaitClock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe("release canary links", () => {
  test("a release asset URL names its tag; anything else names none", () => {
    const cases: Array<[string, string, string | null]> = [
      [`${ASSETS}/v0.1.10/Genex.dmg`, "Genex.dmg", "v0.1.10"],
      [`${ASSETS}/v0.1.11-rc.1/Genex-Setup.exe`, "Genex-Setup.exe", "v0.1.11-rc.1"],
      [`${ASSETS}/v0.1.10/Genex.dmg`, "Genex-Setup.exe", null],
      [`${ASSETS}/v0.1.10/Genex.dmg?x=1`, "Genex.dmg", null],
      ["http://github.com/genex-games/genex-desktop/releases/download/v0.1.10/Genex.dmg", "Genex.dmg", null],
      ["https://github.com.evil.example/genex-games/genex-desktop/releases/download/v9/Genex.dmg", "Genex.dmg", null],
      ["https://evil.example/genex-games/genex-desktop/releases/download/v9/Genex.dmg", "Genex.dmg", null],
      ["https://github.com/someone-else/genex-desktop/releases/download/v9/Genex.dmg", "Genex.dmg", null],
      ["https://github.com/genex-games/genex-desktop/releases/latest/download/Genex.dmg", "Genex.dmg", null],
    ];
    for (const [url, asset, tag] of cases) assert.equal(assetTag(url, asset), tag, url);
  });

  test("a link is followed hop by hop until it names a release asset, never to the file's CDN", async () => {
    const { fetchImpl, asked } = redirects({
      [EXE.url]: `${ASSETS}/v0.1.10/Genex-Setup.exe`,
      [`${ASSETS}/v0.1.10/Genex-Setup.exe`]: "https://release-assets.example/blob",
    });
    const target = await resolveLink(EXE.url, EXE.asset, fetchImpl);
    assert.deepEqual(target, { hops: [EXE.url, `${ASSETS}/v0.1.10/Genex-Setup.exe`], tag: "v0.1.10" });
    assert.deepEqual(asked, [EXE.url]);
  });

  test("a hostile redirect away from the repository's releases reaches no release", async () => {
    const cases: Record<string, string | null>[] = [
      {
        [DMG.url]: "https://evil.example/genex-games/genex-desktop/releases/download/v9/Genex.dmg",
        "https://evil.example/genex-games/genex-desktop/releases/download/v9/Genex.dmg": null,
      },
      { [DMG.url]: `${ASSETS}/v9/Other.dmg`, [`${ASSETS}/v9/Other.dmg`]: null },
      { [DMG.url]: null },
    ];
    for (const table of cases) {
      const { fetchImpl } = redirects(table);
      assert.equal((await resolveLink(DMG.url, DMG.asset, fetchImpl)).tag, null, JSON.stringify(table));
    }
  });

  test("a redirect loop stops after a few hops", async () => {
    const { fetchImpl, asked } = redirects({ [DMG.url]: "https://a.example/", "https://a.example/": DMG.url });
    assert.equal((await resolveLink(DMG.url, DMG.asset, fetchImpl)).tag, null);
    assert.ok(asked.length <= 5, `${asked.length} requests`);
  });

  test("the wait polls until the link serves the new tag, an outage counting as not yet", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 2) throw new Error("ECONNRESET");
      const tag = calls < 4 ? "v0.1.9" : "v0.1.10";
      return new Response(null, { status: 302, headers: { location: `${ASSETS}/${tag}/Genex.dmg` } });
    }) as typeof fetch;
    const clock = heldClock();
    const wait = await waitForRelease(PackageKind.Dmg, "v0.1.10", clock, {
      fetchImpl,
      pollMs: 1000,
      timeoutMs: 60_000,
    });
    assert.equal(wait.ok, true);
    assert.equal(wait.target.tag, "v0.1.10");
    assert.equal(wait.waitedMs, 3000);
  });

  test("a link still on the old release fails once the wait runs out", async () => {
    const { fetchImpl } = redirects({ [DMG.url]: `${ASSETS}/v0.1.9/Genex.dmg` });
    const clock = heldClock();
    const wait = await waitForRelease(PackageKind.Dmg, "v0.1.10", clock, { fetchImpl, pollMs: 1000, timeoutMs: 5000 });
    assert.equal(wait.ok, false);
    assert.equal(wait.target.tag, "v0.1.9");
    assert.ok(wait.waitedMs <= 5000);
  });

  test("SHA256SUMS lines are read by name, binary markers and blank lines included", () => {
    const hash = "A".repeat(64);
    const sums = parseSha256Sums(`${hash}  Genex.dmg\r\n\n${"b".repeat(64)} *Genex-Setup.exe\nnot a line\n`);
    assert.deepEqual(
      [...sums],
      [
        ["Genex.dmg", "a".repeat(64)],
        ["Genex-Setup.exe", "b".repeat(64)],
      ],
    );
  });
});

describe("release canary first start", () => {
  test("a start that came up reports its time and the sandbox's", () => {
    const log = [
      "2026-10-19T10:00:00.000Z [main] start: core:settings at 400 ms",
      "2026-10-19T10:00:01.000Z [main] start: core:games at 900 ms",
      "2026-10-19T10:00:05.000Z [main] start: core:sandbox at 4900 ms",
      "2026-10-19T10:00:06.000Z [main] studio ready at 6100 ms",
    ].join("\n");
    assert.deepEqual(readStart(log), { readyMs: 6100, sandboxMs: 4000, failure: null, problem: null });
  });

  test("a first start that set the sandbox up times the retry, not the failed try", () => {
    const log = [
      "[main] start: core:games at 900 ms",
      "[main] sandbox unavailable: not-provisioned srt-sandbox user missing",
      "[main] start: core:games at 30000 ms",
      "[main] start: core:sandbox at 32500 ms",
      "[main] studio ready at 33000 ms",
    ].join("\n");
    assert.deepEqual(readStart(log), {
      readyMs: 33000,
      sandboxMs: 2500,
      failure: null,
      problem: "sandbox unavailable: not-provisioned srt-sandbox user missing",
    });
  });

  test("a start that gave up says why; one still running says nothing yet", () => {
    assert.deepEqual(
      readStart("[main] start: core:games at 900 ms\n[main] startup failed: srt-win acl stamp timed out"),
      {
        readyMs: null,
        sandboxMs: null,
        failure: "startup failed: srt-win acl stamp timed out",
        problem: null,
      },
    );
    assert.deepEqual(readStart("[main] sandbox unavailable: not-provisioned"), {
      readyMs: null,
      sandboxMs: null,
      failure: null,
      problem: "sandbox unavailable: not-provisioned",
    });
  });

  test("a harness that will not boot is the start's problem, the latest line winning", () => {
    const log = [
      "[harness] [core] the harness could not boot at startup: srt-win user status exited 3221225781",
      "[main] harness would not start: Sandbox dependencies not available: srt-win user status exited 3221225781",
    ].join("\n");
    assert.equal(
      readStart(log).problem,
      "harness would not start: Sandbox dependencies not available: srt-win user status exited 3221225781",
    );
  });
});

describe("release canary agent command", () => {
  const passed = AGENT_CHECKS.map((name) => `[selftest] PASS ${name}: ok`).join("\n");

  test("the self test's streamed lines are read by check name, a colon inside a name kept", () => {
    const seen = readSelfTest(
      `noise\n[selftest] PASS game://  serves the project: frame 3\n[selftest] FAIL named debug cameras exist\n`,
    );
    assert.deepEqual(
      [...seen],
      [
        ["game://  serves the project", { ok: true, detail: "frame 3" }],
        ["named debug cameras exist", { ok: false, detail: "" }],
      ],
    );
  });

  test("the step waits for every agent check and passes only when all passed", () => {
    assert.equal(agentChecksDone(readSelfTest(passed.split("\n").slice(0, 3).join("\n"))), false);
    assert.equal(agentChecksDone(readSelfTest(passed)), true);
    assert.equal(agentVerdict(readSelfTest(passed), "stopped").outcome, StepOutcome.Pass);
  });

  test("a later machine-dependent failure does not fail it; a failed or missing agent check does", () => {
    const later = `${passed}\n[selftest] FAIL a scaffolded game animates without anyone calling start(): frame 0 -> 0`;
    assert.equal(agentVerdict(readSelfTest(later), "stopped").outcome, StepOutcome.Pass);
    const sandboxDown = passed.replace(
      "PASS harness boots inside the sandbox: ok",
      "FAIL harness boots inside the sandbox: state=failed",
    );
    const failed = agentVerdict(readSelfTest(sandboxDown), "runner exited 1");
    assert.equal(failed.outcome, StepOutcome.Fail);
    assert.match(failed.detail, /failed: harness boots inside the sandbox: state=failed/);
    const missing = agentVerdict(readSelfTest(""), "runner exited 1");
    assert.match(missing.detail, /never reported: a chat turn completes end to end/);
  });

  test("on Windows a release whose runner has the Claude worker stage also waits for that worker's checks", () => {
    const runner = 'const claudeWorker = process.argv.includes("--claude-worker");';
    const checks = agentChecksFor("win32", runner);
    assert.deepEqual(checks, [...AGENT_CHECKS, ...CLAUDE_WORKER_CHECKS]);
    assert.deepEqual(agentChecksFor("win32", "// an older runner"), AGENT_CHECKS, "an older release never had it");
    assert.deepEqual(agentChecksFor("darwin", runner), AGENT_CHECKS, "Claude Code's own sandbox runs elsewhere");
    assert.equal(agentChecksDone(readSelfTest(passed), checks), false, "the worker has not reported yet");
    const refused = `${passed}\n[selftest] PASS ${CLAUDE_WORKER_CHECKS[0]}: claude.exe\n[selftest] FAIL ${CLAUDE_WORKER_CHECKS[1]}: sandbox_unavailable\n[selftest] FAIL ${CLAUDE_WORKER_CHECKS[2]}: file missing`;
    const verdict = agentVerdict(readSelfTest(refused), "stopped", checks);
    assert.equal(verdict.outcome, StepOutcome.Fail);
    assert.match(verdict.detail, /failed: a Claude worker ran its turn without being refused: sandbox_unavailable/);
  });

  test("the canary waits for the Claude worker checks by the names the self test prints", () => {
    assert.deepEqual([...CLAUDE_WORKER_CHECKS], Object.values(CLAUDE_WORKER_CHECK));
  });
});

describe("release canary Azure size", () => {
  const usage = (name: string, used: number, limit: number) => ({ name, used, limit });

  test("sizes come in preference order, those with room for both VMs first", () => {
    const usages = [
      usage("cores", 0, 10),
      usage("standardDASv5Family", 0, 0),
      usage("standardDSv5Family", 0, 10),
      usage("standardBSFamily", 0, 2),
    ];
    assert.deepEqual(sizesWithRoom(usages), ["Standard_D2s_v5", "Standard_B2ms"]);
  });

  test("a region with room for one VM still offers sizes; one with no room offers none", () => {
    assert.deepEqual(sizesWithRoom([usage("cores", 8, 10), usage("standardDASv5Family", 0, 10)]), ["Standard_D2as_v5"]);
    assert.deepEqual(sizesWithRoom([usage("cores", 10, 10), usage("standardDASv5Family", 0, 10)]), []);
    assert.deepEqual(sizesWithRoom([]), []);
  });
});

describe("release canary Azure owner run", () => {
  const standardUser: MachineResult = {
    machine: "windows-10",
    kind: PackageKind.Exe,
    tag: "v0.1.12",
    steps: [
      {
        step: CanaryStep.AgentCommand,
        outcome: StepOutcome.Fail,
        persona: Persona.StandardUser,
        detail: "never reported: harness boots inside the sandbox",
      },
    ],
  };

  /** A VM's evidence as azure.ts unzips it: one folder per persona that wrote a result. */
  async function evidence(results: Partial<Record<Persona, MachineResult>>): Promise<string> {
    const dir = await tmpDir("canary-azure-");
    for (const [persona, result] of Object.entries(results)) {
      await mkdir(path.join(dir, persona), { recursive: true });
      await writeFile(path.join(dir, persona, RESULT_FILE), JSON.stringify(result));
    }
    return dir;
  }

  test("an owner run that left no result fails the machine as the owner's, not as Genex's", async () => {
    const dir = await evidence({ [Persona.StandardUser]: standardUser });
    const owner = await ownerResult(dir, "windows-10", "v0.1.12");
    assert.equal(machinePassed(owner), false);
    assert.deepEqual(
      owner.steps.map((step) => [step.persona, step.step, step.outcome]),
      [[Persona.Owner, CanaryStep.Link, StepOutcome.Fail]],
    );
    assert.match(owner.steps[0]?.detail ?? "", /owner run did not start/);
    assert.deepEqual(await readResult(path.join(dir, Persona.Owner, RESULT_FILE)), owner, "the report reads it");
  });

  test("an owner run that wrote its result is left as it was, passing or not", async () => {
    const passed: MachineResult = {
      ...standardUser,
      steps: [{ step: CanaryStep.FirstStart, outcome: StepOutcome.Pass, persona: Persona.Owner, detail: "ok" }],
    };
    const dir = await evidence({ [Persona.Owner]: passed });
    assert.deepEqual(await ownerResult(dir, "windows-10", "v0.1.12"), passed);
    assert.deepEqual(await readResult(path.join(dir, Persona.Owner, RESULT_FILE)), passed);
  });
});

describe("release canary Azure sign-in", () => {
  const actions = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    AZURE_CLIENT_ID: "client",
    AZURE_TENANT_ID: "tenant",
    AZURE_SUBSCRIPTION_ID: "subscription",
  };

  test("a job signs in again with a token of its own; outside Actions or without the IDs, nothing does", () => {
    assert.deepEqual(gitHubSignIn(actions), {
      requestUrl: actions.ACTIONS_ID_TOKEN_REQUEST_URL,
      requestToken: "request-token",
      clientId: "client",
      tenantId: "tenant",
      subscriptionId: "subscription",
    });
    assert.equal(gitHubSignIn({}), null);
    assert.equal(gitHubSignIn({ ...actions, AZURE_CLIENT_ID: "" }), null);
    assert.equal(gitHubSignIn({ ...actions, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }), null);
  });

  test("the fresh token is asked for Azure's audience with the job's request token", async () => {
    const asked: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ value: "oidc-token" });
    };
    const signIn = gitHubSignIn(actions);
    assert.ok(signIn);
    assert.equal(await gitHubToken(signIn, fetchImpl), "oidc-token");
    const url = new URL(asked[0]?.url ?? "");
    assert.equal(url.searchParams.get("api-version"), "2.0");
    assert.equal(url.searchParams.get("audience"), "api://AzureADTokenExchange");
    assert.equal(asked[0]?.authorization, "bearer request-token");
  });

  test("a refused or empty answer is an error, never a sign-in with no token", async () => {
    const signIn = gitHubSignIn(actions);
    assert.ok(signIn);
    await assert.rejects(
      gitHubToken(signIn, async () => new Response("no", { status: 403 })),
      /HTTP 403/,
    );
    await assert.rejects(
      gitHubToken(signIn, async () => Response.json({ value: "" })),
      /no token/,
    );
    await assert.rejects(
      gitHubToken(signIn, async () => Response.json({})),
      /no token/,
    );
  });

  test("az signs in again once the last sign-in is a few minutes old, the first time always", () => {
    assert.equal(signInDue(null, 0), true);
    assert.equal(signInDue(0, 4 * MINUTE_MS), false);
    assert.equal(signInDue(0, 5 * MINUTE_MS), true);
  });
});

describe("release canary repository", () => {
  test("only the Genex repository's versions count", () => {
    const madison = [
      "     genex |     0.1.10 | https://packages.genex.games stable/main amd64 Packages",
      "     genex |      0.1.9 | file:/var/cache local",
      "     genex |     0.2.0 | https://mirror.example stable/main amd64 Packages",
    ].join("\n");
    assert.deepEqual(aptVersions(madison), ["0.1.10"]);
  });

  test("a package revision still names its release; another release does not", () => {
    assert.equal(isRelease("0.1.10", "0.1.10"), true);
    assert.equal(isRelease("0.1.10-1", "0.1.10"), true);
    assert.equal(isRelease("0.1.100", "0.1.10"), false);
    assert.equal(isRelease("0.1.1", "0.1.10"), false);
  });
});

describe("release canary report", () => {
  const passing: MachineResult = {
    machine: "macos-26",
    kind: PackageKind.Dmg,
    tag: "v0.1.10",
    steps: [{ step: CanaryStep.FirstStart, outcome: StepOutcome.Pass, seconds: 12, detail: "studio ready" }],
  };
  const owner: MachineResult = {
    machine: "windows-11",
    kind: PackageKind.Exe,
    tag: "v0.1.10",
    steps: [{ step: CanaryStep.FirstStart, outcome: StepOutcome.Pass, persona: Persona.Owner, detail: "ok" }],
  };
  const user: MachineResult = {
    ...owner,
    steps: [
      {
        step: CanaryStep.FirstStart,
        outcome: StepOutcome.Fail,
        persona: Persona.StandardUser,
        detail: "startup failed: stamp timed out",
      },
    ],
  };

  test("a machine's personas merge into one row that fails when either failed", () => {
    const [merged] = mergeMachines([owner, user]);
    assert.equal(merged?.steps.length, 2);
    assert.equal(merged && machinePassed(merged), false);
    assert.equal(owner.steps.length, 1, "the inputs are left as they were");
  });

  test("a machine that sent nothing fails as a stand-in row", () => {
    const results = withMissing([passing], ["macos-26", "ubuntu-24.04"], "v0.1.10");
    assert.deepEqual(
      results.map((result) => [result.machine, machinePassed(result)]),
      [
        ["macos-26", true],
        ["ubuntu-24.04", false],
      ],
    );
  });

  test("the summary gives the verdict and quotes each failure", () => {
    const summary = summaryMarkdown(mergeMachines([passing, owner, user]), "v0.1.10", "https://run");
    assert.match(summary, /1 of 2 machines failed\./);
    assert.match(summary, /\*\*windows-11\*\* \(standard-user\) · first-start: startup failed: stamp timed out/);
    assert.match(summary, /\[Run and logs\]\(https:\/\/run\)/);
  });

  test("one issue per failing release: opened, then commented, closed once it passes", () => {
    assert.equal(issueAction(true, null), IssueAction.Open);
    assert.equal(issueAction(true, 42), IssueAction.Comment);
    assert.equal(issueAction(false, 42), IssueAction.Close);
    assert.equal(issueAction(false, null), IssueAction.None);
  });
});

describe("release canary lived-in profile", () => {
  test("it refuses the running account's own home and writes nothing there", async () => {
    const home = await tmpDir("canary-home-");
    const script = path.join(import.meta.dirname, "..", "..", "scripts", "canary", "lived-in-profile.ts");
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const ran = spawnSync(process.execPath, [script, "--home", home, "--files", "10"], { env, encoding: "utf8" });
    assert.notEqual(ran.status, 0);
    assert.match(ran.stderr, /own home/);
    assert.deepEqual(await readdir(home), []);
  });

  test("it fills a canary home with the folders a person's has", async () => {
    const home = await tmpDir("canary-home-");
    const script = path.join(import.meta.dirname, "..", "..", "scripts", "canary", "lived-in-profile.ts");
    const ran = spawnSync(process.execPath, [script, "--home", home, "--files", "200", "--large-files", "0"], {
      encoding: "utf8",
    });
    assert.equal(ran.status, 0, ran.stderr);
    const top = await readdir(home);
    for (const folder of ["Documents", "Downloads", "Pictures", "source", "SteamLibrary", ".ssh", ".claude", ".codex"])
      assert.ok(top.includes(folder), `${folder} in ${top.join(", ")}`);
  });
});
