/**
 * When the process sandbox cannot start, the studio opens on a setup screen instead of quitting.
 * These tests pin the mapping from what sandbox-runtime reports to the typed problem that screen
 * shows, and that `ProcessSandbox` raises it as a `SandboxUnavailableError`.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AppArmorBlockCode,
  PackageManager,
  SandboxProblemCode,
  SandboxTool,
  StudioPlatform,
  linuxInstallCommands,
} from "../../src/shared/boot.ts";
import {
  APPARMOR_LABEL_FILES,
  USERNS_RESTRICTION_FILE,
  appArmorProfile,
  profileInstallCommand,
  profileRemoveCommand,
  type PathOwner,
} from "../../src/substrate/linux-apparmor.ts";
import {
  SandboxUnavailableError,
  type UsernsCheck,
  missingLinuxTools,
  sandboxProblem,
  windowsSetupProblem,
} from "../../src/substrate/sandbox-unavailable.ts";
import { ProcessSandbox, type SandboxRuntime } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

describe("sandbox problem mapping", () => {
  it("a working sandbox is no problem", () => {
    assert.equal(sandboxProblem({ platform: "linux", supported: true, dependencyErrors: [], missingTools: [] }), null);
  });

  it("Linux names the missing tools and the commands that install exactly those", () => {
    const problem = sandboxProblem({
      platform: "linux",
      supported: true,
      dependencyErrors: ["bubblewrap (bwrap) not installed", "socat not installed"],
      missingTools: [SandboxTool.Bubblewrap, SandboxTool.Socat],
    });
    assert.deepEqual(problem, {
      code: SandboxProblemCode.MissingTools,
      platform: "linux",
      missingTools: [SandboxTool.Bubblewrap, SandboxTool.Socat],
      installCommands: [
        { manager: PackageManager.Apt, command: "sudo apt install bubblewrap socat" },
        { manager: PackageManager.Dnf, command: "sudo dnf install bubblewrap socat" },
      ],
      details: ["bubblewrap (bwrap) not installed", "socat not installed"],
    });
  });

  it("Linux with a failed check but every tool on PATH offers to reinstall all three", () => {
    const problem = sandboxProblem({
      platform: "linux",
      supported: true,
      dependencyErrors: ["bubblewrap (bwrap) not executable at /opt/bwrap"],
      missingTools: [],
    });
    assert.equal(problem?.code, SandboxProblemCode.MissingTools);
    assert.deepEqual(problem?.installCommands, linuxInstallCommands([]));
    assert.deepEqual(
      problem?.installCommands.map((install) => install.command),
      ["sudo apt install bubblewrap socat ripgrep", "sudo dnf install bubblewrap socat ripgrep"],
    );
  });

  it("an unsupported platform (WSL 1, BSD) offers no command", () => {
    const problem = sandboxProblem({ platform: "freebsd", supported: false, dependencyErrors: [], missingTools: [] });
    assert.equal(problem?.code, SandboxProblemCode.UnsupportedPlatform);
    assert.deepEqual(problem?.installCommands, []);
    assert.deepEqual(problem?.missingTools, []);
  });

  it("Windows dependency errors mean the sandbox is not provisioned", () => {
    const problem = sandboxProblem({
      platform: "win32",
      supported: true,
      dependencyErrors: ["Sandbox user is not provisioned"],
      missingTools: [],
    });
    assert.equal(problem?.code, SandboxProblemCode.NotProvisioned);
    assert.deepEqual(problem?.installCommands, []);
  });

  it("Windows initialize errors map by their code, never by their words", () => {
    for (const code of ["not_provisioned", "wfp_fence_inactive"]) {
      const error = Object.assign(new Error("anything at all"), { code });
      assert.equal(windowsSetupProblem(error)?.code, SandboxProblemCode.NotProvisioned, code);
    }
    for (const error of [
      Object.assign(new Error("Sandbox user is not provisioned"), { code: "spawn_failed" }),
      Object.assign(new Error("not_provisioned"), { code: "ENOENT" }),
      new Error("not_provisioned"),
      "not_provisioned",
      null,
    ])
      assert.equal(windowsSetupProblem(error), null, String(error));
  });
});

describe("missing Linux tools", () => {
  it("looks each tool up on the PATH it is given", () => {
    const found = new Set<string>([SandboxTool.Socat]);
    assert.deepEqual(
      missingLinuxTools((command) => found.has(command)),
      [SandboxTool.Bubblewrap, SandboxTool.Ripgrep],
    );
  });

  it("the default lookup finds an executable on PATH and ignores a plain file", {
    skip: process.platform === "win32" && "Linux's tools are looked up on Linux; Windows files have no exec bit",
  }, async () => {
    const bin = path.join(await tmpDir("sandbox-tools-"), "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "bwrap"), "#!/bin/sh\n");
    await chmod(path.join(bin, "bwrap"), 0o755);
    await writeFile(path.join(bin, "socat"), "not executable");
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      assert.deepEqual(missingLinuxTools(), [SandboxTool.Socat, SandboxTool.Ripgrep]);
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("ProcessSandbox raises a typed error", () => {
  function runtime(overrides: Partial<SandboxRuntime>): SandboxRuntime {
    return {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: (async () => ({ argv: ["/bin/true"], env: {} })) as never,
      annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
      ...overrides,
    } as SandboxRuntime;
  }

  async function create(fake: SandboxRuntime): Promise<ProcessSandbox> {
    const root = await tmpDir("sandbox-unavailable-");
    return ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      runtime: fake,
    });
  }

  it("on an unsupported platform, before initializing anything", async () => {
    let initialized = false;
    const fake = runtime({
      isSupportedPlatform: () => false,
      initialize: async () => {
        initialized = true;
      },
    });
    await assert.rejects(create(fake), (error: unknown) => {
      assert.ok(error instanceof SandboxUnavailableError);
      assert.equal(error.problem.code, SandboxProblemCode.UnsupportedPlatform);
      assert.equal(error.problem.platform, process.platform);
      return true;
    });
    assert.equal(initialized, false);
  });

  it("when a dependency is missing, carrying sandbox-runtime's findings", {
    skip:
      process.platform === "win32" && "Windows skips srt's dependency probe (its setup codes: windows-sandbox.test.ts)",
  }, async () => {
    const fake = runtime({ checkDependencies: () => ({ errors: ["socat not installed"], warnings: [] }) });
    await assert.rejects(create(fake), (error: unknown) => {
      assert.ok(error instanceof SandboxUnavailableError);
      assert.deepEqual(error.problem.details, ["socat not installed"]);
      return true;
    });
  });

  it("an initialize failure that is not a setup problem stays what it was", async () => {
    const fake = runtime({
      initialize: async () => {
        throw new Error("proxy failed to bind");
      },
    });
    await assert.rejects(create(fake), (error: unknown) => {
      assert.ok(!(error instanceof SandboxUnavailableError));
      assert.match(String(error), /proxy failed to bind/);
      return true;
    });
  });

  it("a Windows setup code from initialize becomes the setup problem", async () => {
    const fake = runtime({
      initialize: async () => {
        throw Object.assign(new Error("sandbox user missing"), { code: "not_provisioned" });
      },
    });
    await assert.rejects(create(fake), (error: unknown) => {
      assert.ok(error instanceof SandboxUnavailableError);
      assert.equal(error.problem.code, SandboxProblemCode.NotProvisioned);
      return true;
    });
  });
});

describe("Ubuntu's user-namespace restriction", () => {
  const ready = { platform: StudioPlatform.Linux, supported: true, dependencyErrors: [], missingTools: [] };
  const executable = "/home/ada/Genex portable/genex";
  /** This copy, in the person's own folders, with no profile installed yet. */
  const fresh: UsernsCheck = { executable, sharedPath: null, installed: null };

  it("a Linux sandbox with every tool but under the restriction offers Genex's profile, and its removal", () => {
    const problem = sandboxProblem({ ...ready, userns: fresh });
    const profile = appArmorProfile(executable);
    assert.ok(profile);
    assert.equal(problem?.code, SandboxProblemCode.UsernsRestricted);
    assert.equal(problem?.platform, StudioPlatform.Linux);
    assert.deepEqual(problem?.apparmor, {
      profile: profile.file,
      command: profileInstallCommand(profile),
      remove: profileRemoveCommand(profile),
    });
    assert.equal(problem?.apparmorBlock, undefined);
    assert.deepEqual(problem?.missingTools, []);
    assert.deepEqual(problem?.installCommands, []);
    assert.ok(problem?.details.length, "Details say what was found");
  });

  it("missing tools come first: the restriction is only worth fixing once bubblewrap is there", () => {
    const problem = sandboxProblem({
      ...ready,
      dependencyErrors: ["bubblewrap (bwrap) not installed"],
      missingTools: [SandboxTool.Bubblewrap],
      userns: { ...fresh, executable: "/usr/lib/genex/genex" },
    });
    assert.equal(problem?.code, SandboxProblemCode.MissingTools);
    assert.equal(problem?.apparmor, undefined);
  });

  it("offers no profile, says why and names the path when Set up must not or cannot help", () => {
    const profile = appArmorProfile(executable);
    assert.ok(profile);
    const cases: Array<[string, UsernsCheck, AppArmorBlockCode, string]> = [
      [
        "a folder a profile cannot name",
        { ...fresh, executable: "/home/ada/Genex [old]/genex" },
        AppArmorBlockCode.Unnamable,
        "/home/ada/Genex [old]/genex",
      ],
      [
        "a folder someone else can change",
        { ...fresh, sharedPath: "/srv/team" },
        AppArmorBlockCode.SharedFolder,
        "/srv/team",
      ],
      [
        "the same profile already installed, yet not attached (a second Set up would not help)",
        { ...fresh, installed: `${profile.text}\n` },
        AppArmorBlockCode.NotAttached,
        profile.file,
      ],
    ];
    for (const [name, userns, block, named] of cases) {
      const problem = sandboxProblem({ ...ready, userns });
      assert.equal(problem?.code, SandboxProblemCode.UsernsRestricted, name);
      assert.equal(problem?.apparmor, undefined, name);
      assert.equal(problem?.apparmorBlock, block, name);
      assert.ok(
        problem?.details.some((line) => line.includes(named)),
        `${name}: Details name ${named}`,
      );
    }
  });

  it("a profile that names another copy is offered again, and Details say it moves", () => {
    const other = appArmorProfile("/opt/Genex/genex");
    assert.ok(other);
    const problem = sandboxProblem({ ...ready, userns: { ...fresh, installed: other.text } });
    assert.ok(problem?.apparmor);
    assert.ok(problem.details.some((line) => line.includes("another copy")));
  });

  it("no restriction, or not Linux, is no problem", () => {
    assert.equal(sandboxProblem(ready), null);
    assert.equal(sandboxProblem({ ...ready, platform: StudioPlatform.Mac, userns: fresh }), null);
  });
});

describe("ProcessSandbox under Ubuntu's restriction", () => {
  const [AA_LABEL] = APPARMOR_LABEL_FILES;
  const OWN = (): PathOwner => ({ uid: 1000, gid: 1000, mode: 0o040755 });
  function linuxRuntime(counts: { initialized: number }): SandboxRuntime {
    return {
      isSupportedPlatform: () => true,
      checkDependencies: () => ({ errors: [], warnings: [] }),
      initialize: async () => {
        counts.initialized++;
      },
      reset: async () => {},
      updateConfig: () => {},
      wrapWithSandboxArgv: (async () => ({ argv: ["/bin/true"], env: {} })) as never,
      annotateStderrWithSandboxFailures: (_command: string, stderr: string) => stderr,
    } as SandboxRuntime;
  }
  async function create(runtime: SandboxRuntime, label: string | null): Promise<ProcessSandbox> {
    const root = await tmpDir("sandbox-userns-");
    const files: Record<string, string> = { [USERNS_RESTRICTION_FILE]: "1\n" };
    if (label !== null) files[AA_LABEL] = `${label}\n`;
    return ProcessSandbox.create({
      writableRoots: [root],
      scratchDir: path.join(root, "scratch"),
      secretPaths: [],
      runtime,
      platform: StudioPlatform.Linux,
      linux:
        label === null
          ? undefined
          : {
              read: (file) => files[file] ?? null,
              execPath: "/opt/Genex/genex",
              inspect: OWN,
              person: { uid: 1000, gid: 1000 },
            },
    });
  }

  it("refuses an unconfined process with the setup problem, before initializing anything", async () => {
    const counts = { initialized: 0 };
    await assert.rejects(create(linuxRuntime(counts), "unconfined"), (error: unknown) => {
      assert.ok(error instanceof SandboxUnavailableError);
      assert.equal(error.problem.code, SandboxProblemCode.UsernsRestricted);
      assert.equal(error.problem.apparmor?.profile, "/etc/apparmor.d/genex-portable");
      return true;
    });
    assert.equal(counts.initialized, 0);
  });

  it("starts under Genex's profile", async () => {
    const counts = { initialized: 0 };
    const sandbox = await create(linuxRuntime(counts), "genex-portable (unconfined)");
    assert.equal(counts.initialized, 1);
    await sandbox.dispose();
  });

  it("a fake runtime without a reader never reads the host's /proc, so an Ubuntu 24.04 host changes nothing", async () => {
    const counts = { initialized: 0 };
    const sandbox = await create(linuxRuntime(counts), null);
    assert.equal(counts.initialized, 1);
    await sandbox.dispose();
  });
});
