/**
 * On Linux bubblewrap isolates every agent process, and it needs user namespaces that carry
 * capabilities. Ubuntu 24.04 and the distributions built on it hand those out only to programs an
 * AppArmor profile allows (`kernel.apparmor_restrict_unprivileged_userns`), so with bwrap installed
 * the harness still never booted and the window said only "The studio could not start". Startup
 * now runs one command in the sandbox first: when it cannot start, the window opens on the setup
 * screen, and under AppArmor's restriction it offers the command that installs the profile.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SandboxProblemCode, StudioPlatform } from "../../src/shared/boot.ts";
import {
  appArmorAllowCommand,
  appArmorProfile,
  appArmorRestrictsNamespaces,
  checkLinuxIsolation,
  isolationProblem,
} from "../../src/substrate/linux-isolation.ts";
import { SandboxUnavailableError } from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox, type SandboxRuntime } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" && "runs POSIX shells and scripts";
const DEB_EXEC = "/usr/lib/genex/genex";
/** What bubblewrap prints when AppArmor strips the new namespace of its capabilities. */
const BWRAP_REFUSAL = "bwrap: setting up uid map: Permission denied";

describe("the AppArmor profile", () => {
  it("allows user namespaces for exactly the executable it names", () => {
    assert.equal(
      appArmorProfile(DEB_EXEC),
      [
        "abi <abi/4.0>,",
        "include <tunables/global>",
        "",
        'profile genex "/usr/lib/genex/genex" flags=(unconfined) {',
        "  userns,",
        "",
        "  include if exists <local/genex>",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("is not written for a path AppArmor would read as a pattern or could not quote", () => {
    for (const execPath of [
      "relative/genex",
      '/opt/Gen"ex/genex',
      "/opt/Gen\\ex/genex",
      "/opt/Genex*/genex",
      "/opt/Genex?/genex",
      "/opt/[Genex]/genex",
      "/opt/@{HOME}/genex",
      "/opt/Gen^ex/genex",
      "/opt/Genex\n/genex",
      "/opt/Genex\t/genex",
      "/opt/Genex\u0000/genex",
    ]) {
      assert.equal(appArmorProfile(execPath), null, JSON.stringify(execPath));
      assert.equal(appArmorAllowCommand(execPath), null, JSON.stringify(execPath));
    }
  });
});

describe("the command that installs the profile", { skip: POSIX_ONLY }, () => {
  /**
   * Run `command` with stand-ins for sudo, tee and apparmor_parser on PATH: tee writes its input to
   * `written`, the parser records its arguments. Nothing outside `root` is touched.
   */
  async function runCommand(command: string) {
    const root = await tmpDir("apparmor-command-");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const stub = async (name: string, body: string) => {
      await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(path.join(bin, name), 0o755);
    };
    await stub("sudo", 'exec "$@"');
    await stub("tee", 'echo "$1" > "$ROOT/tee-target"; cat > "$ROOT/written"');
    await stub("apparmor_parser", 'echo "$*" > "$ROOT/parser-args"');
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, ROOT: root },
      encoding: "utf8",
    });
    const read = (name: string) => readFile(path.join(root, name), "utf8").catch(() => null);
    return {
      root,
      status: result.status,
      written: await read("written"),
      target: (await read("tee-target"))?.trim(),
      parser: (await read("parser-args"))?.trim(),
    };
  }

  it("writes exactly the profile to /etc/apparmor.d and loads it", async () => {
    const command = appArmorAllowCommand(DEB_EXEC);
    assert.ok(command);
    const ran = await runCommand(command);
    assert.equal(ran.status, 0);
    assert.equal(ran.written, appArmorProfile(DEB_EXEC));
    assert.equal(ran.target, "/etc/apparmor.d/genex");
    assert.equal(ran.parser, "-r /etc/apparmor.d/genex");
  });

  it("carries a hostile but representable path into the profile literally, running nothing it holds", async () => {
    for (const execPath of [
      "/home/a b/Genex-linux-x64/genex",
      "/home/o'neil/Genex/genex",
      "/home/$(touch pwned)/genex",
      "/home/`touch pwned`/genex",
      "/home/x; touch pwned; /genex",
      "/home/%s%n/genex",
      "/home/-n/genex",
    ]) {
      const command = appArmorAllowCommand(execPath);
      assert.ok(command, execPath);
      const ran = await runCommand(command);
      assert.equal(ran.status, 0, execPath);
      assert.equal(ran.written, appArmorProfile(execPath), execPath);
      assert.equal(existsSync(path.join(ran.root, "pwned")), false, execPath);
    }
  });
});

describe("AppArmor's user-namespace restriction", () => {
  async function procWith(value: string | null): Promise<string> {
    const proc = await tmpDir("proc-");
    if (value === null) return proc;
    await mkdir(path.join(proc, "sys", "kernel"), { recursive: true });
    await writeFile(path.join(proc, "sys", "kernel", "apparmor_restrict_unprivileged_userns"), value);
    return proc;
  }

  it("is on only when the kernel says 1", async () => {
    assert.equal(await appArmorRestrictsNamespaces(await procWith("1\n")), true);
    assert.equal(await appArmorRestrictsNamespaces(await procWith("0\n")), false);
    assert.equal(await appArmorRestrictsNamespaces(await procWith("")), false);
    assert.equal(await appArmorRestrictsNamespaces(await procWith(null)), false, "a kernel without AppArmor 4");
  });
});

describe("the isolation problem", () => {
  it("under AppArmor's restriction offers the profile for this executable", () => {
    assert.deepEqual(isolationProblem({ details: [BWRAP_REFUSAL], restricted: true, execPath: DEB_EXEC }), {
      code: SandboxProblemCode.IsolationBlocked,
      platform: StudioPlatform.Linux,
      missingTools: [],
      installCommands: [],
      details: [BWRAP_REFUSAL],
      allowCommand: appArmorAllowCommand(DEB_EXEC),
    });
  });

  it("offers no command without the restriction, or for an executable the profile cannot name", () => {
    for (const [restricted, execPath] of [
      [false, DEB_EXEC],
      [true, "/opt/Genex*/genex"],
    ] as const) {
      const problem = isolationProblem({ details: [BWRAP_REFUSAL], restricted, execPath });
      assert.equal(problem.code, SandboxProblemCode.IsolationBlocked);
      assert.equal(problem.allowCommand, undefined, `${restricted} ${execPath}`);
      assert.deepEqual(problem.details, [BWRAP_REFUSAL]);
    }
  });
});

describe("checking the sandbox at startup", { skip: POSIX_ONLY }, () => {
  /** A sandbox-runtime stand-in whose wrapped command is `argv`; `wrapped` counts the wraps. */
  function runtime(argv: string[]) {
    const calls = { wrapped: 0 };
    const fake = {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      reset: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: async () => {
        calls.wrapped++;
        return { argv, env: {} };
      },
      annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
    } as unknown as SandboxRuntime;
    return { fake, calls };
  }

  async function sandbox(fake: SandboxRuntime, platform: NodeJS.Platform, enabled = true) {
    const root = await tmpDir("linux-isolation-");
    return ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      runtime: fake,
      platform,
      enabled,
    });
  }

  async function restrictedProc(): Promise<string> {
    const proc = await tmpDir("proc-");
    await mkdir(path.join(proc, "sys", "kernel"), { recursive: true });
    await writeFile(path.join(proc, "sys", "kernel", "apparmor_restrict_unprivileged_userns"), "1\n");
    return proc;
  }

  it("a sandbox that cannot start a process is the setup problem, with bwrap's own words", async () => {
    const { fake } = runtime(["/bin/sh", "-c", `echo '${BWRAP_REFUSAL}' >&2; exit 1`]);
    const linux = await sandbox(fake, StudioPlatform.Linux);
    try {
      const procRoot = await restrictedProc();
      const check = checkLinuxIsolation(linux, { platform: StudioPlatform.Linux, procRoot, execPath: DEB_EXEC });
      await assert.rejects(check, (error: unknown) => {
        assert.ok(error instanceof SandboxUnavailableError);
        assert.equal(error.problem.code, SandboxProblemCode.IsolationBlocked);
        assert.deepEqual(error.problem.details, [BWRAP_REFUSAL]);
        assert.equal(error.problem.allowCommand, appArmorAllowCommand(DEB_EXEC));
        return true;
      });
    } finally {
      await linux.dispose();
    }
  });

  it("a sandbox that starts a process passes", async () => {
    const { fake, calls } = runtime(["/bin/sh", "-c", "exit 0"]);
    const linux = await sandbox(fake, StudioPlatform.Linux);
    try {
      await checkLinuxIsolation(linux, { platform: StudioPlatform.Linux, procRoot: await restrictedProc() });
      assert.equal(calls.wrapped, 1, "the check ran inside the sandbox");
    } finally {
      await linux.dispose();
    }
  });

  it("starts nothing on macOS or Windows, or with the sandbox off", async () => {
    const { fake, calls } = runtime(["/bin/sh", "-c", "exit 1"]);
    const mac = await sandbox(fake, StudioPlatform.Mac);
    const off = await sandbox(fake, StudioPlatform.Linux, false);
    try {
      await checkLinuxIsolation(mac, { platform: StudioPlatform.Mac });
      await checkLinuxIsolation(mac, { platform: StudioPlatform.Windows });
      await checkLinuxIsolation(off, { platform: StudioPlatform.Linux });
      assert.equal(calls.wrapped, 0);
    } finally {
      await Promise.all([mac.dispose(), off.dispose()]);
    }
  });
});
