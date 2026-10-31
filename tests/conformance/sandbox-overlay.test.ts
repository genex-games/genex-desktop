/**
 * PH-3: a per-run network overlay (the "Install packages" button opening registry.npmjs.org)
 * must reach the filtering proxy. sandbox-runtime's proxy judges every request against its
 * process-wide config, never the per-spawn overlay, so the sandbox has to push the widened
 * allow-list for exactly as long as the run lasts — and put it back however the run ends.
 *
 * A fake runtime stands in for the singleton, so the proxy config can be read at every moment;
 * `sandbox.test.ts` proves the same against the real proxy. On Windows a fake grant session stands
 * in for the folder grants too, so this file changes no folder's entries: real ones re-propagate
 * through `%TEMP%` and held other test files' folders open while they removed them.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { ProcessSandbox, type SandboxRuntime } from "../../src/substrate/spawn.ts";
import { type AncestorGrants, WindowsSandboxSession } from "../../src/substrate/windows-sandbox.ts";
import { posixShell } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REGISTRY = "registry.npmjs.org";

function fakeRuntime(options: { failWrap?: boolean } = {}) {
  type Config = Parameters<SandboxRuntime["updateConfig"]>[0];
  let current: Config | null = null;
  const wraps: string[][] = [];
  let wrapped = () => {};
  const firstWrap = new Promise<void>((resolve) => {
    wrapped = resolve;
  });
  const runtime: SandboxRuntime = {
    isSupportedPlatform: () => true,
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: async (config: Config) => {
      current = config;
    },
    reset: async () => {},
    updateConfig: (config: Config) => {
      current = config;
    },
    wrapWithSandboxArgv: (async (command: string) => {
      wraps.push([...(current?.network.allowedDomains ?? [])]);
      wrapped();
      if (options.failWrap) throw new Error("wrap failed");
      return { argv: [await posixShell(), "-c", command], env: process.env };
    }) as never,
    annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
  } as SandboxRuntime;
  return {
    runtime,
    wraps,
    /** Resolves once the first command has been wrapped: it is about to start. */
    firstWrap,
    domains: () => [...(current?.network.allowedDomains ?? [])],
    writes: () => [...(current?.filesystem.allowWrite ?? [])],
  };
}

/** Folder grants above the roots that answer only once the test lets them: a regrant as slow as it likes. */
function heldAncestors() {
  let open = () => {};
  let held: Promise<void> = Promise.resolve();
  const ancestors: AncestorGrants = {
    sync: () => held,
    revokeAll: async () => {},
    revokeAllSync: () => {},
  };
  return {
    ancestors,
    hold: () => {
      held = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
  };
}

/**
 * A sandbox on this platform's backend over `fake`, disposed when the test ends. On Windows its
 * grant session is the test's own, so `settled` waits for a regrant instead of a clock.
 */
async function sandboxWith(
  t: TestContext,
  fake: ReturnType<typeof fakeRuntime>,
  options: { platform?: NodeJS.Platform; ancestors?: AncestorGrants } = {},
) {
  const root = await tmpDir("sandbox-overlay-");
  const platform = options.platform ?? process.platform;
  const ancestors = options.ancestors ?? heldAncestors().ancestors;
  const session =
    platform === "win32" ? new WindowsSandboxSession({ runtime: fake.runtime, profile: root, ancestors }) : null;
  const sandbox = await ProcessSandbox.create({
    writableRoots: [root],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    runtime: fake.runtime,
    platform,
    ...(session ? { windows: { bash: await posixShell(), session, profile: root }, toolPath: async () => "" } : {}),
  });
  const settled = async () => {
    await session?.settled();
  };
  t.after(async () => {
    await sandbox.dispose();
    await settled();
  });
  return { sandbox, root, settled };
}

describe("PH-3: a per-run domain reaches the proxy for the run, and only the run", () => {
  it("is open while the install runs and closed once it ends", async (t) => {
    const fake = fakeRuntime();
    const { sandbox, root } = await sandboxWith(t, fake);
    assert.deepEqual(fake.domains(), [], "no network by default");
    const run = sandbox.run({ command: "sleep 0.3", cwd: root, policy: { allowedDomains: [REGISTRY] } });
    await fake.firstWrap;
    assert.deepEqual(fake.wraps[0], [REGISTRY], "the proxy already allows the registry when the command is wrapped");
    assert.deepEqual(fake.domains(), [REGISTRY], "and still does while it runs");
    assert.equal((await run).code, 0);
    assert.deepEqual(fake.domains(), [], "closed again afterwards");
  });

  it("is closed again when the command fails", async (t) => {
    const fake = fakeRuntime();
    const { sandbox, root } = await sandboxWith(t, fake);
    const result = await sandbox.run({ command: "exit 3", cwd: root, policy: { allowedDomains: [REGISTRY] } });
    assert.equal(result.code, 3);
    assert.deepEqual(fake.wraps[0], [REGISTRY]);
    assert.deepEqual(fake.domains(), []);
  });

  it("is closed again when the sandbox cannot even start the command", async (t) => {
    const fake = fakeRuntime({ failWrap: true });
    const { sandbox, root } = await sandboxWith(t, fake);
    await assert.rejects(
      () => sandbox.run({ command: "true", cwd: root, policy: { allowedDomains: [REGISTRY] } }),
      /wrap failed/,
    );
    assert.deepEqual(fake.wraps[0], [REGISTRY]);
    assert.deepEqual(fake.domains(), []);
  });

  it("two overlapping installs share the opening: the first to finish does not close it on the second", async (t) => {
    const fake = fakeRuntime();
    const { sandbox, root } = await sandboxWith(t, fake);
    const long = sandbox.run({ command: "sleep 0.4", cwd: root, policy: { allowedDomains: [REGISTRY] } });
    await sandbox.run({ command: "true", cwd: root, policy: { allowedDomains: [REGISTRY] } });
    assert.deepEqual(fake.domains(), [REGISTRY], "the longer install is still running");
    await long;
    assert.deepEqual(fake.domains(), []);
  });

  it("a folder opened mid-install survives the close, and the opening survives the folder", async (t) => {
    const fake = fakeRuntime();
    const { sandbox, root, settled } = await sandboxWith(t, fake);
    const extra = path.join(await tmpDir("sandbox-overlay-later-"), "later");
    const run = sandbox.run({ command: "sleep 0.2", cwd: root, policy: { allowedDomains: [REGISTRY] } });
    await fake.firstWrap;
    sandbox.allowWrite(extra);
    assert.deepEqual(fake.domains(), [REGISTRY], "opening a folder does not close the registry on a running install");
    await run;
    // On Windows the folder's regrant starts as the install ends, and the closing reaches the
    // proxy once that regrant is applied: wait for it rather than sample the moment between.
    await settled();
    assert.deepEqual(fake.domains(), [], "the install's opening is closed");
    assert.ok(fake.writes().includes(extra), "closing the registry does not take the folder back");
  });

  it("on Windows, the closing waits for the regrant that takes the folder in, however long it takes", async (t) => {
    const fake = fakeRuntime();
    const hold = heldAncestors();
    const { sandbox, root, settled } = await sandboxWith(t, fake, { platform: "win32", ancestors: hold.ancestors });
    const extra = path.join(await tmpDir("sandbox-overlay-later-"), "later");
    const run = sandbox.run({ command: "sleep 0.2", cwd: root, policy: { allowedDomains: [REGISTRY] } });
    await fake.firstWrap;
    hold.hold();
    sandbox.allowWrite(extra);
    await run;
    const applied = settled();
    hold.release();
    await applied;
    assert.deepEqual(fake.domains(), [], "the install's opening is closed");
    // The Windows backend spells every grant with backslashes, here on any platform.
    const slashes = (p: string | { path: string }) => (typeof p === "string" ? p : p.path).replaceAll("\\", "/");
    assert.ok(fake.writes().map(slashes).includes(slashes(extra)), "the regrant took the folder in");
  });

  it("a run with no overlay pushes nothing", async (t) => {
    const fake = fakeRuntime();
    const { sandbox, root } = await sandboxWith(t, fake);
    let pushes = 0;
    const update = fake.runtime.updateConfig;
    fake.runtime.updateConfig = ((config: Parameters<typeof update>[0]) => {
      pushes++;
      update(config);
    }) as typeof update;
    await sandbox.run({ command: "true", cwd: root });
    assert.equal(pushes, 0);
  });
});
