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
  PackageManager,
  SandboxProblemCode,
  SandboxTool,
  WindowsSetupNeed,
  linuxInstallCommands,
} from "../../src/shared/boot.ts";
import {
  SandboxLaunchCode,
  SandboxLaunchError,
  SandboxUnavailableError,
  missingLinuxTools,
  sandboxProblem,
  windowsProxyPortsError,
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

  it("Windows carries what Set up needs to do, when the check says", () => {
    const needs = [WindowsSetupNeed.Sandbox, WindowsSetupNeed.LogonService];
    const problem = sandboxProblem({
      platform: "win32",
      supported: true,
      dependencyErrors: ["Sandbox user is not provisioned", "The Secondary Logon service is disabled"],
      missingTools: [],
      windowsNeeds: needs,
    });
    assert.equal(problem?.code, SandboxProblemCode.NotProvisioned);
    assert.deepEqual(problem?.windowsNeeds, needs);
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

describe("Windows proxy ports", () => {
  it("Windows refusing every proxy port says what to do, by the error's code and call", () => {
    const refused = (code: string, syscall = "listen") =>
      Object.assign(new Error(`listen ${code}: permission denied 127.0.0.1:60089`), { code, syscall, port: 60089 });
    for (const code of ["EACCES", "EADDRINUSE"]) {
      const error = refused(code);
      const launch = windowsProxyPortsError(error);
      assert.ok(launch instanceof SandboxLaunchError, code);
      assert.equal(launch.code, SandboxLaunchCode.ProxyPortsRefused);
      assert.equal(launch.cause, error);
      assert.match(launch.message, /60080-60089/);
      assert.match(launch.message, /net start winnat/);
    }
    for (const error of [
      refused("EACCES", "connect"),
      refused("EINVAL"),
      Object.assign(new Error("listen EACCES"), { code: "acl_grant_failed" }),
      new Error("listen EACCES: permission denied 127.0.0.1:60080"),
      "EACCES",
      null,
    ])
      assert.equal(windowsProxyPortsError(error), null, String(error));
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
