/**
 * The bundled Genex CLI reports crashes to Sentry unless its environment opts out, and Studio
 * builds that environment from scratch, both where the asset adapter runs it and where the Genex
 * plugin starts it as its `blender` MCP server. Crash reporting is off by default, and the user's
 * own opt-outs reach the CLI; nothing else of Studio's environment does.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { PluginToolService } from "../../src/main/core/plugin-tools.ts";
import { genexCliEnv } from "../../src/plugins/genex/adapter.ts";
import type { PluginMcpServer } from "../../src/shared/plugins.ts";
import { windowsHomeEnv } from "../../src/substrate/child-env.ts";
import type { PluginMcpLaunch } from "../../src/substrate/plugins/registry.ts";
import { tmpDir } from "../helpers/tmp.ts";

const api = "https://api.genex.games";

describe("Genex CLI environment", () => {
  it("turns the CLI's crash reporting off by default", () => {
    const env = genexCliEnv({ PATH: "/usr/bin", HOME: "/Users/someone" }, { api });
    assert.equal(env.GENEX_TELEMETRY, "0");
  });

  it("forwards the user's standard opt-outs", () => {
    const env = genexCliEnv({ PATH: "/usr/bin", DO_NOT_TRACK: "1", GENEX_DISABLE_SENTRY: "1" }, { api });
    assert.equal(env.DO_NOT_TRACK, "1");
    assert.equal(env.GENEX_DISABLE_SENTRY, "1");
    assert.equal(env.GENEX_TELEMETRY, "0");
  });

  it("keeps an explicit GENEX_TELEMETRY choice and passes nothing else through", () => {
    const env = genexCliEnv(
      { PATH: "/usr/bin", GENEX_TELEMETRY: "1", ANTHROPIC_API_KEY: "secret", GENEX_TOKEN: "leak" },
      { api, home: "/tmp/publish/home" },
    );
    assert.equal(env.GENEX_TELEMETRY, "1", "someone who opted in on purpose stays opted in");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GENEX_TOKEN, undefined, "the token only travels on fd 3");
    assert.equal(env.HOME, "/tmp/publish/home");
    assert.equal(env.GENEX_API_URL, api);
  });
});

describe("Genex CLI environment on Windows", () => {
  const parent = {
    Path: "C:\\Windows\\system32;C:\\Program Files\\nodejs",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    USERPROFILE: "C:\\Users\\Ada",
    APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
    TEMP: "C:\\Users\\Ada\\AppData\\Local\\Temp",
    TMP: "C:\\Users\\Ada\\AppData\\Local\\Temp",
    GITHUB_TOKEN: "leak",
    ANTHROPIC_API_KEY: "secret",
  };

  it("carries what a Windows program needs to start, and still no credential", () => {
    const env = genexCliEnv(parent, { api, platform: "win32" });
    assert.equal(env.PATH, parent.Path, "PATH is read whatever its case");
    for (const name of [
      "SystemRoot",
      "windir",
      "ComSpec",
      "PATHEXT",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
    ])
      assert.equal(env[name], parent[name as keyof typeof parent], name);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  it("keeps a publish run's profile folders inside its contained home", () => {
    const home = "C:\\Users\\Ada\\AppData\\Local\\Genex\\publish\\home";
    const env = genexCliEnv(parent, { api, home, platform: "win32" });
    assert.equal(env.USERPROFILE, home);
    assert.equal(env.HOME, home);
    assert.equal(env.APPDATA, `${home}\\AppData\\Roaming`);
    assert.equal(env.LOCALAPPDATA, `${home}\\AppData\\Local`);
  });

  it("adds none of it on macOS", () => {
    const env = genexCliEnv({ ...parent, PATH: "/usr/bin" }, { api, platform: "darwin" });
    assert.equal(env.SystemRoot, undefined);
    assert.equal(env.USERPROFILE, undefined);
  });
});

describe("Genex CLI started as the Genex plugin's MCP server (host-cli, DOC-1)", () => {
  const launch = {
    packageDir: "/pkg",
    storageRoot: async () => "/s",
    projectStorage: async () => "/s/p",
    settings: async () => ({}),
    credential: async () => undefined,
  } as unknown as PluginMcpLaunch;
  const server = (command: PluginMcpServer["command"]): PluginMcpServer => ({
    id: "blender",
    description: "Blender tools",
    transport: "stdio",
    command,
    args: ["blender", "mcp"],
    cwd: "storage",
  });
  const service = new PluginToolService({} as never, { mcpSecrets: null } as never);
  const saved = { ...process.env };
  const withParent = async (parent: Record<string, string>, command: PluginMcpServer["command"]) => {
    for (const name of ["GENEX_TELEMETRY", "DO_NOT_TRACK", "GENEX_DISABLE_SENTRY"]) delete process.env[name];
    Object.assign(process.env, parent);
    try {
      return await service.pluginMcpEnv("genex", server(command), launch);
    } finally {
      process.env = { ...saved };
    }
  };

  it("has crash reporting off by default, like the asset adapter's CLI", async () => {
    assert.equal((await withParent({}, "host-cli")).GENEX_TELEMETRY, "0");
  });

  it("forwards the user's opt-outs and keeps an explicit choice", async () => {
    const env = await withParent({ DO_NOT_TRACK: "1", GENEX_DISABLE_SENTRY: "1" }, "host-cli");
    assert.deepEqual([env.DO_NOT_TRACK, env.GENEX_DISABLE_SENTRY, env.GENEX_TELEMETRY], ["1", "1", "0"]);
    assert.equal((await withParent({ GENEX_TELEMETRY: "1" }, "host-cli")).GENEX_TELEMETRY, "1");
  });

  it("adds nothing Genex-specific to a plugin's own node server", async () => {
    assert.equal((await withParent({ DO_NOT_TRACK: "1" }, "node")).GENEX_TELEMETRY, undefined);
  });

  it("starts the server with its own home, and on Windows its own profile folders inside it", async () => {
    const root = await tmpDir("studio-genex-mcp-home-");
    const target = await service
      .pluginMcpLaunch("genex", server("host-cli"), { ...launch, storageRoot: async () => root })
      .resolve?.(null);
    const home = path.join(root, "mcp", "home");
    const env = target?.extraEnv ?? {};
    assert.equal(env.HOME, home);
    // The CLI's legacy cleanup finds `~` through os.homedir(), which reads USERPROFILE on Windows.
    assert.deepEqual(
      [env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA],
      process.platform === "win32"
        ? [home, path.join(home, "AppData", "Roaming"), path.join(home, "AppData", "Local")]
        : [undefined, undefined, undefined],
    );
  });
});

describe("a contained home's Windows profile folders", () => {
  it("are USERPROFILE, APPDATA and LOCALAPPDATA inside it on Windows, and nothing elsewhere", () => {
    assert.deepEqual(windowsHomeEnv("C:\\s\\home", "win32"), {
      USERPROFILE: "C:\\s\\home",
      APPDATA: "C:\\s\\home\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\s\\home\\AppData\\Local",
    });
    assert.deepEqual(windowsHomeEnv("/s/home", "darwin"), {});
    assert.deepEqual(windowsHomeEnv("/s/home", "linux"), {});
  });
});
