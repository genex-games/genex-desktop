/**
 * Per-stack setup status beside the C++ store's (`src/main/core/stack-setup-status.ts`, read by
 * `studio:toolchain.status`): Xcode found apart from the Command Line Tools (only `xcode-select -p`
 * runs, and Xcode's own `version.plist` is read as a plain file), the Rust stack's current lock,
 * and the harness parts a Rust night refuses. Each piece degrades to "not found" on its own.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { HostExec } from "../../src/main/core/toolchains.ts";
import { probeXcode, type StackSetupSource, stackSetupStatus } from "../../src/main/core/stack-setup-status.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerToolchainIpc } from "../../src/main/ipc/toolchain.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { ToolchainHost, type ToolchainLock } from "../../src/shared/toolchain.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLIST = (version: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict></plist>\n`;

/** An exec answering `xcode-select -p` with `selected` (null: it fails), recording every call. */
function selecting(selected: string | null) {
  const calls: Array<[string, readonly string[]]> = [];
  const exec: HostExec = async (file, args) => {
    calls.push([file, args]);
    return selected === null
      ? { code: 2, stdout: "", stderr: "xcode-select: error: unable to get active developer directory" }
      : { code: 0, stdout: `${selected}\n`, stderr: "" };
  };
  return { exec, calls };
}

/** An `Xcode.app` with its version.plist under a fresh folder. */
async function xcodeApp(version: string, name = "Xcode.app"): Promise<string> {
  const root = await tmpDir("xcode-probe-");
  const app = path.join(root, name);
  await mkdir(path.join(app, "Contents", "Developer"), { recursive: true });
  await writeFile(path.join(app, "Contents", "version.plist"), PLIST(version));
  return app;
}

describe("probeXcode", () => {
  it("finds the selected Xcode and reads its version from its version.plist, running only xcode-select -p", async () => {
    const app = await xcodeApp("26.6", "Xcode-beta.app");
    const { exec, calls } = selecting(path.join(app, "Contents", "Developer"));
    const found = await probeXcode({ exec, platform: StudioPlatform.Mac, defaultApp: "/nonexistent/Xcode.app" });
    assert.deepEqual(found, { present: true, version: "26.6" });
    assert.deepEqual(calls, [["/usr/bin/xcode-select", ["-p"]]]);
  });

  it("with the Command Line Tools selected, an installed Xcode.app in the default place still counts", async () => {
    const app = await xcodeApp("26.5");
    const { exec } = selecting("/Library/Developer/CommandLineTools");
    assert.deepEqual(await probeXcode({ exec, platform: StudioPlatform.Mac, defaultApp: app }), {
      present: true,
      version: "26.5",
    });
  });

  it("the Command Line Tools alone are not Xcode", async () => {
    const { exec } = selecting("/Library/Developer/CommandLineTools");
    const found = await probeXcode({ exec, platform: StudioPlatform.Mac, defaultApp: "/nonexistent/Xcode.app" });
    assert.deepEqual(found, { present: false, version: null });
  });

  it("nothing selected and no Xcode.app: not present", async () => {
    const { exec } = selecting(null);
    const found = await probeXcode({ exec, platform: StudioPlatform.Mac, defaultApp: "/nonexistent/Xcode.app" });
    assert.deepEqual(found, { present: false, version: null });
  });

  it("a version.plist reached through a link is not read: no Xcode", async () => {
    const real = await xcodeApp("26.6");
    const root = await tmpDir("xcode-link-");
    const app = path.join(root, "Xcode.app");
    await mkdir(path.join(app, "Contents"), { recursive: true });
    await symlink(path.join(real, "Contents", "version.plist"), path.join(app, "Contents", "version.plist"));
    const { exec } = selecting(null);
    assert.deepEqual(await probeXcode({ exec, platform: StudioPlatform.Mac, defaultApp: app }), {
      present: false,
      version: null,
    });
  });

  it("off a Mac nothing runs and nothing is found", async () => {
    for (const platform of [StudioPlatform.Windows, StudioPlatform.Linux]) {
      const { exec, calls } = selecting("/Applications/Xcode.app/Contents/Developer");
      assert.deepEqual(await probeXcode({ exec, platform, defaultApp: "/Applications/Xcode.app" }), {
        present: false,
        version: null,
      });
      assert.deepEqual(calls, [], platform);
    }
  });
});

const RUST_LOCK: ToolchainLock = { version: 1, entries: {}, digest: "1".repeat(64) };

/** A source whose pieces answer as given; `fail` names those that throw. */
function source(fail: ReadonlyArray<keyof StackSetupSource> = []): StackSetupSource {
  const or =
    <T>(name: keyof StackSetupSource, value: T) =>
    async () => {
      if (fail.includes(name)) throw new Error(`${name} failed`);
      return value;
    };
  return {
    xcode: or("xcode", { present: true, version: "26.6" }),
    rustLock: or("rustLock", RUST_LOCK),
    keptPreRust: or("keptPreRust", ["loop/judge.ts"]),
  };
}

describe("stackSetupStatus", () => {
  it("answers Xcode, the Rust lock and the kept harness parts", async () => {
    assert.deepEqual(await stackSetupStatus(source()), {
      xcode: { present: true, version: "26.6" },
      stackLocks: { [GameStack.RustWgpu]: RUST_LOCK },
      keptPreRust: ["loop/judge.ts"],
    });
  });

  it("a piece that fails is left out on its own, never failing the status", async () => {
    assert.deepEqual(await stackSetupStatus(source(["xcode", "keptPreRust"])), {
      stackLocks: { [GameStack.RustWgpu]: RUST_LOCK },
    });
    assert.deepEqual(await stackSetupStatus(source(["rustLock"])), {
      xcode: { present: true, version: "26.6" },
      keptPreRust: ["loop/judge.ts"],
    });
  });
});

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;

describe("studio:toolchain.status with the per-stack setup", () => {
  it("adds Xcode, the Rust lock and the kept parts to the C++ status and plan", async () => {
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      { fixture: false, isStudioUi: () => true },
    );
    const toolchains = {
      status: async () => ({ host: ToolchainHost.MacArm64, storeBytes: 7 }),
      plan: async () => ({ downloads: [], freeBytes: 99, reserveBytes: 5 }),
    };
    registerToolchainIpc(handle, { toolchains, games: {} } as never, source());
    const status = listeners.get("studio:toolchain.status");
    assert.ok(status);
    assert.deepEqual(await status({ sender: "studio", senderFrame: "main-frame" } as never, undefined), {
      ok: true,
      value: {
        host: ToolchainHost.MacArm64,
        storeBytes: 7,
        downloads: [],
        freeBytes: 99,
        reserveBytes: 5,
        xcode: { present: true, version: "26.6" },
        stackLocks: { [GameStack.RustWgpu]: RUST_LOCK },
        keptPreRust: ["loop/judge.ts"],
      },
    });
  });
});
