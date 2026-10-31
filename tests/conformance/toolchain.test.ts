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

describe("the toolchain's git on a Mac", () => {
  const OWN = "/Applications/Genex.app/Contents/Resources/app.asar.unpacked/dist/resources/git/bin";
  const resolveWith = (loginPath: string, files: readonly string[]) =>
    resolveToolchain({
      platform: "darwin",
      home: "/Users/nobody",
      envPath: `${OWN}:/usr/bin:/bin`,
      loginPath: async () => loginPath,
      executable: async (file) => files.includes(file),
      developerDir: async () => null,
    });

  it("runs the app's own git where the login shell's is Apple's stand-in", async () => {
    const tools = await resolveWith("/usr/bin:/bin:/Users/nobody/.nvm/bin", ["/usr/bin/git", `${OWN}/git`]);
    assert.equal(tools.path, `${OWN}:/usr/bin:/bin:/Users/nobody/.nvm/bin:/usr/sbin:/sbin`);
  });

  it("keeps the login shell's own git, and its order, where it runs", async () => {
    const files = ["/opt/homebrew/bin/git", "/usr/bin/git", `${OWN}/git`];
    const tools = await resolveWith("/opt/homebrew/bin:/usr/bin:/bin", files);
    assert.equal(tools.path, `/opt/homebrew/bin:/usr/bin:/bin:${OWN}:/usr/sbin:/sbin`);
  });
});
