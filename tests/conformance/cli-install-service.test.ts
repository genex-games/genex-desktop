import { test } from "node:test";
import assert from "node:assert/strict";
import { createCliInstalls, type CliInstallsDeps } from "../../src/main/cli-install.ts";
import { CliInstallOperation, CliInstallPhase, CliInstallProblem } from "../../src/shared/cli-install.ts";
import type { CodingProvider } from "../../src/shared/coding-cli.ts";
import type { InstallOutcome } from "../../src/substrate/cli-installer.ts";
import { UiEvent, type UiEvent as UiEventShape } from "../../src/shared/ui-events.ts";

const NOW = new Date("2026-09-28T12:00:00.000Z");

/** A service over recorded deps; `outcome` and `found` decide how each install ends. */
function harness(options: { outcome?: () => Promise<InstallOutcome>; found?: boolean } = {}) {
  const installs: CodingProvider[] = [];
  const events: UiEventShape[] = [];
  const logged: string[] = [];
  const deps: CliInstallsDeps = {
    install: async (provider) => {
      installs.push(provider);
      return (options.outcome ?? (async () => ({ ok: true }) as const))();
    },
    found: async () => options.found ?? true,
    pushUiEvent: (event) => events.push(event),
    log: (line) => logged.push(line),
    now: () => NOW,
  };
  return { service: createCliInstalls(deps), installs, events, logged };
}

const types = (events: UiEventShape[]) => events.map((event) => event.type);

test("an install runs the installer once, reports each step, and tells the engines when the CLI works", async () => {
  const { service, installs, events } = harness();
  const job = service.start("claude-code");
  assert.deepEqual(job, {
    provider: "claude-code",
    operation: "install",
    phase: CliInstallPhase.Installing,
    startedAt: NOW.toISOString(),
  });
  assert.deepEqual(service.start("claude-code"), job, "a second press joins the running install");
  const done = await service.settled("claude-code");
  assert.deepEqual(installs, ["claude-code"]);
  assert.deepEqual(done, { ...job, phase: CliInstallPhase.Installed, finishedAt: NOW.toISOString() });
  assert.deepEqual(types(events), [UiEvent.CliInstall, UiEvent.CliInstall, UiEvent.EnginesChanged]);
  assert.deepEqual(service.status(), [done]);
});

test("an install that fails says why, keeps the installer's words for the log, and changes no engine", async () => {
  const cases: [string, Parameters<typeof harness>[0], CliInstallProblem][] = [
    [
      "download",
      { outcome: async () => ({ ok: false, problem: CliInstallProblem.Download, detail: "fetch failed" }) },
      CliInstallProblem.Download,
    ],
    [
      "installer",
      { outcome: async () => ({ ok: false, problem: CliInstallProblem.Installer, detail: "exit 7: no space" }) },
      CliInstallProblem.Installer,
    ],
    [
      "threw",
      {
        outcome: async () => {
          throw new Error("spawn EACCES");
        },
      },
      CliInstallProblem.Installer,
    ],
    ["installed but not found", { found: false }, CliInstallProblem.NotFound],
  ];
  for (const [name, options, problem] of cases) {
    const { service, events, logged } = harness(options);
    service.start("codex");
    const done = await service.settled("codex");
    assert.equal(done?.phase, CliInstallPhase.Failed, name);
    assert.equal(done?.problem, problem, name);
    assert.equal(types(events).includes(UiEvent.EnginesChanged), false, name);
    assert.equal(logged.length, 1, name);
  }
});

test("a finished install can be started again", async () => {
  const { service, installs } = harness({ found: false });
  service.start("codex");
  await service.settled("codex");
  assert.equal(service.start("codex").phase, CliInstallPhase.Installing);
  await service.settled("codex");
  assert.deepEqual(installs, ["codex", "codex"]);
});

test("only Claude Code and Codex can be installed: anything else is refused before any work", () => {
  for (const hostile of ["gemini", "", "__proto__", "../codex", "codex ", null, undefined, 42, { provider: "codex" }]) {
    const { service, installs, events } = harness();
    assert.throws(() => service.start(hostile), /unknown coding CLI/, String(hostile));
    assert.deepEqual([installs, events, service.status()], [[], [], []], String(hostile));
  }
});

test("Pi has no in-app installer but Account can still update it", async () => {
  let updates = 0;
  let installs = 0;
  const events: UiEventShape[] = [];
  const service = createCliInstalls({
    install: async () => {
      installs++;
      return { ok: true };
    },
    update: async () => {
      updates++;
      return { ok: true };
    },
    found: async () => true,
    pushUiEvent: (event) => events.push(event),
    log: () => {},
    now: () => NOW,
  });
  assert.throws(() => service.start("pi"), /unknown coding CLI/);
  assert.equal(installs, 0);
  const job = service.start("pi", CliInstallOperation.Update);
  assert.equal(job.operation, CliInstallOperation.Update);
  const done = await service.settled("pi");
  assert.equal(done?.phase, CliInstallPhase.Installed);
  assert.equal(updates, 1);
  assert.equal(installs, 0);
});
