/**
 * The toolchain on Windows: no login shell, a `;`-separated PATH compared case-insensitively,
 * the registry's PATH for tools installed after Explorer started, and PATHEXT names. Every case
 * passes the platform, so it runs on any host; the last one reads the real registry on Windows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  candidateDirs,
  envPath,
  executableNames,
  expandWindowsVariables,
  mergePathsFor,
  parseRegistryPath,
  parseRegistryValue,
  readLoginPath,
  readRegistryPath,
  resolveToolchain,
  withEnvPath,
} from "../../src/substrate/toolchain.ts";

const WINDOWS_ENV = {
  APPDATA: "C:\\Users\\Ada\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  Path: "C:\\Windows\\system32;C:\\Windows",
};

describe("the toolchain on Windows", () => {
  it("never starts a login shell", async () => {
    assert.equal(await readLoginPath(1000, undefined, "win32"), null);
  });

  it("merges `;` PATHs case-insensitively, keeping drive roots and dropping trailing separators", () => {
    const merged = mergePathsFor("win32", "C:\\Tools\\;C:\\Windows", "c:\\tools;D:\\;C:\\Windows\\System32", "");
    assert.equal(merged, "C:\\Tools;C:\\Windows;D:\\;C:\\Windows\\System32");
    assert.equal(mergePathsFor("darwin", "/a/:/b", "/a"), "/a:/b");
  });

  it("names each tool by PATHEXT, and only by its own name elsewhere", () => {
    assert.deepEqual(executableNames("npm", "win32", { PATHEXT: ".EXE;.CMD" }), ["npm.exe", "npm.cmd"]);
    assert.deepEqual(executableNames("npm", "win32", {}), ["npm.com", "npm.exe", "npm.bat", "npm.cmd"]);
    assert.deepEqual(executableNames("npm", "darwin", { PATHEXT: ".EXE" }), ["npm"]);
  });

  it("reads PATH under any case and writes it back under one key", () => {
    assert.equal(envPath({ Path: "C:\\a" }), "C:\\a");
    assert.equal(envPath({ PATH: "/usr/bin" }), "/usr/bin");
    assert.deepEqual(withEnvPath({ Path: "C:\\a", HOME: "h" }, "C:\\b"), { HOME: "h", PATH: "C:\\b" });
  });

  it("looks where the Node installer, npm, pnpm, Volta, Bun and Scoop put themselves", () => {
    assert.deepEqual(candidateDirs("C:\\Users\\Ada", "win32", WINDOWS_ENV), [
      "C:\\Program Files\\nodejs",
      "C:\\Users\\Ada\\AppData\\Roaming\\npm",
      "C:\\Users\\Ada\\AppData\\Local\\pnpm",
      "C:\\Users\\Ada\\AppData\\Local\\Volta\\bin",
      "C:\\Users\\Ada\\.bun\\bin",
      "C:\\Users\\Ada\\scoop\\shims",
    ]);
  });

  it("reads one named value out of a registry key, and nothing for a name it only contains", () => {
    const output = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    OLD_LINUX_MULTIARCH_ROOT    REG_SZ    C:\\Old\\",
      "    LINUX_MULTIARCH_ROOT    REG_SZ    C:\\UnrealToolchains\\v26_clang-20.1.8-rockylinux8\\",
      "",
    ].join("\r\n");
    assert.equal(
      parseRegistryValue(output, "LINUX_MULTIARCH_ROOT"),
      "C:\\UnrealToolchains\\v26_clang-20.1.8-rockylinux8\\",
    );
    assert.equal(parseRegistryValue(output, "MULTIARCH_ROOT"), null);
    assert.equal(
      parseRegistryValue("ERROR: The system was unable to find the specified registry key or value.", "X"),
      null,
    );
  });

  it("reads the registry's PATH value and expands its variables", () => {
    const output = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%APPDATA%\\npm",
      "",
    ].join("\r\n");
    const value = parseRegistryPath(output);
    assert.equal(value, "%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;%APPDATA%\\npm");
    assert.equal(parseRegistryPath("ERROR: The system was unable to find the specified registry key or value."), null);
    assert.equal(
      expandWindowsVariables(value ?? "", { userprofile: "C:\\Users\\Ada", APPDATA: "C:\\R" }),
      "C:\\Users\\Ada\\AppData\\Local\\Microsoft\\WindowsApps;C:\\R\\npm",
    );
    assert.equal(expandWindowsVariables("%NOT_SET%\\bin", {}), "%NOT_SET%\\bin");
  });

  it("finds node.exe and npm.cmd along the process PATH, then the registry's, without asking a login shell", async () => {
    let askedLogin = false;
    const nodeDir = "C:\\Program Files\\nodejs";
    const tools = await resolveToolchain({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: WINDOWS_ENV,
      loginPath: async () => {
        askedLogin = true;
        return "/bin";
      },
      registryPath: async () => `C:\\Windows;${nodeDir};C:\\Users\\Ada\\AppData\\Roaming\\npm`,
      executable: async (file) => [`${nodeDir}\\node.exe`, `${nodeDir}\\npm.cmd`].includes(file),
    });
    assert.equal(askedLogin, false);
    assert.equal(tools.fromLoginShell, false);
    assert.equal(tools.found.node, `${nodeDir}\\node.exe`);
    assert.equal(tools.found.npm, `${nodeDir}\\npm.cmd`);
    assert.equal(tools.found.pnpm, undefined);
    assert.equal(
      tools.path,
      `C:\\Windows\\system32;C:\\Windows;${nodeDir};C:\\Users\\Ada\\AppData\\Roaming\\npm`,
      "the process PATH first, the registry's new entries after it, each once",
    );
  });

  it("reads the machine and user PATH from the real registry", {
    skip: process.platform !== "win32" && "Windows registry only",
  }, async () => {
    const value = await readRegistryPath();
    assert.ok(value, "the registry holds a PATH");
    assert.match(value, /\\system32/i);
    assert.doesNotMatch(value, /%SystemRoot%/i, "variables are expanded");
  });
});
