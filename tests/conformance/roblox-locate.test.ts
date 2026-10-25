/**
 * Where Roblox Studio is on a Mac and on Windows, and whether it runs, read through an injected
 * file system and runner: what counts as installed, which version folder wins, what is refused
 * (a link out of /Applications, a path of the other system, `..`), and that nothing under the
 * person's Documents folder is ever touched.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type LocateDeps,
  type LocateFs,
  type LocateStat,
  locateStudio,
  pgrepRunning,
  type Run,
  STUDIO_MAC_APP,
  StudioMiss,
  studioPids,
  studioRunning,
  tasklistRunning,
} from "../../src/plugins/roblox/studio-locate.ts";
import { personEnv } from "../../src/plugins/roblox/studio-client.ts";

/** One entry of the fake disk: a file, a folder, or a link to another path. */
type Entry = { kind: "file" | "dir"; mtimeMs?: number } | { kind: "link"; to: string };

/** A fake disk keyed by full path, in one system's spelling; every path asked is recorded. */
function fakeFs(entries: Record<string, Entry>, flavour: path.PlatformPath): LocateFs & { touched: string[] } {
  const touched: string[] = [];
  const resolve = (file: string, depth = 0): string => {
    const entry = entries[file];
    if (entry?.kind === "link" && depth < 8) return resolve(entry.to, depth + 1);
    const parent = flavour.dirname(file);
    if (parent === file) return file;
    const real = resolve(parent, depth + 1);
    return real === parent ? file : flavour.join(real, flavour.basename(file));
  };
  return {
    touched,
    async lstat(file): Promise<LocateStat | undefined> {
      touched.push(file);
      const entry = entries[file];
      if (!entry) return undefined;
      if (entry.kind === "link") return { file: false, directory: false, link: true, mtimeMs: 0 };
      return { file: entry.kind === "file", directory: entry.kind === "dir", link: false, mtimeMs: entry.mtimeMs ?? 0 };
    },
    async realpath(file) {
      touched.push(file);
      const real = resolve(file);
      if (!entries[real]) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return real;
    },
    async readdir(dir) {
      touched.push(dir);
      const prefix = dir.endsWith(flavour.sep) ? dir : dir + flavour.sep;
      return Object.keys(entries)
        .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes(flavour.sep))
        .map((key) => key.slice(prefix.length));
    },
  };
}

/** A runner that answers each program by its full path and records every call. */
function fakeRun(answers: Record<string, { code: number; stdout: string } | Error>) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: Run = async (file, args) => {
    calls.push({ file, args });
    const answer = answers[file];
    if (!answer || answer instanceof Error) throw answer ?? new Error(`spawn ${file} ENOENT`);
    return answer;
  };
  return { run, calls };
}

const MAC_HOME = "/Users/maker";
const MAC_DOCUMENTS = path.posix.join(MAC_HOME, "Documents");
const MAC_CONTENTS = `${STUDIO_MAC_APP}/Contents`;
const PLIST_ANSWER = { code: 0, stdout: "0.743.0.7431133\n" };

/** A Mac with Roblox Studio in /Applications, its MCP binary and its Info.plist. */
const MAC_INSTALLED: Record<string, Entry> = {
  "/Applications": { kind: "dir" },
  [STUDIO_MAC_APP]: { kind: "dir" },
  [`${MAC_CONTENTS}/MacOS/RobloxStudio`]: { kind: "file" },
  [`${MAC_CONTENTS}/MacOS/StudioMCP`]: { kind: "file" },
  [`${MAC_CONTENTS}/Info.plist`]: { kind: "file" },
};

function mac(entries: Record<string, Entry>, home = MAC_HOME) {
  const fs = fakeFs(entries, path.posix);
  const { run, calls } = fakeRun({ "/usr/bin/plutil": PLIST_ANSWER });
  const deps: LocateDeps = { platform: "darwin", env: { HOME: home }, home, fs, run };
  return { deps, fs, calls };
}

const LOCAL = "C:\\Users\\maker\\AppData\\Local";
const ROBLOX = `${LOCAL}\\Roblox`;
const VERSIONS = `${ROBLOX}\\Versions`;
const OLD_VERSION = `${VERSIONS}\\version-0a1b2c3d4e5f6071`;
const NEW_VERSION = `${VERSIONS}\\version-1122334455667788`;

/** A Windows computer with two Studio version folders, the newer written later, and mcp.bat. */
const WINDOWS_INSTALLED: Record<string, Entry> = {
  "C:\\": { kind: "dir" },
  [LOCAL]: { kind: "dir" },
  [ROBLOX]: { kind: "dir" },
  [VERSIONS]: { kind: "dir" },
  [OLD_VERSION]: { kind: "dir" },
  [`${OLD_VERSION}\\RobloxStudioBeta.exe`]: { kind: "file", mtimeMs: 1_000 },
  [NEW_VERSION]: { kind: "dir" },
  [`${NEW_VERSION}\\RobloxStudioBeta.exe`]: { kind: "file", mtimeMs: 9_000 },
  [`${ROBLOX}\\mcp.bat`]: { kind: "file" },
};

function windows(entries: Record<string, Entry>, env: NodeJS.ProcessEnv = { LOCALAPPDATA: LOCAL }) {
  const fs = fakeFs(entries, path.win32);
  const { run, calls } = fakeRun({});
  const deps: LocateDeps = { platform: "win32", env, home: "C:\\Users\\maker", fs, run };
  return { deps, fs, calls };
}

/** No path the locator asked lies under the person's Documents folder, in either spelling. */
function assertNoDocuments(touched: readonly string[]): void {
  const documents = touched.filter((file) => /[\\/]documents([\\/]|$)/i.test(file));
  assert.deepEqual(documents, [], "nothing under Documents is read: macOS would ask the person for it");
}

describe("Roblox Studio on a Mac", () => {
  it("is found in /Applications with its MCP binary and its version, and Documents is never read", async () => {
    const { deps, fs, calls } = mac(MAC_INSTALLED);
    const found = await locateStudio(deps);
    assert.deepEqual(found, {
      installed: true,
      install: {
        app: STUDIO_MAC_APP,
        studio: `${MAC_CONTENTS}/MacOS/RobloxStudio`,
        mcp: `${MAC_CONTENTS}/MacOS/StudioMCP`,
        plugins: path.posix.join(MAC_DOCUMENTS, "Roblox", "Plugins"),
        version: "0.743.0.7431133",
      },
    });
    assert.deepEqual(calls, [
      {
        file: "/usr/bin/plutil",
        args: ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", `${MAC_CONTENTS}/Info.plist`],
      },
    ]);
    assertNoDocuments(fs.touched);
  });

  it("is missing when /Applications has no Roblox Studio, or the app has no Studio binary", async () => {
    for (const [label, entries] of [
      ["no app", { "/Applications": { kind: "dir" } }],
      ["an app with no binary", { "/Applications": { kind: "dir" }, [STUDIO_MAC_APP]: { kind: "dir" } }],
    ] as const) {
      const { deps, fs } = mac(entries as Record<string, Entry>);
      assert.deepEqual(await locateStudio(deps), { installed: false, miss: StudioMiss.NotInstalled }, label);
      assertNoDocuments(fs.touched);
    }
  });

  it("has no MCP binary on an older Studio, and no version when Info.plist can't be read", async () => {
    const entries = { ...MAC_INSTALLED };
    delete entries[`${MAC_CONTENTS}/MacOS/StudioMCP`];
    const fs = fakeFs(entries, path.posix);
    const { run } = fakeRun({ "/usr/bin/plutil": { code: 1, stdout: "" } });
    const found = await locateStudio({ platform: "darwin", env: {}, home: MAC_HOME, fs, run });
    assert.equal(found.installed, true);
    if (!found.installed) return;
    assert.equal(found.install.mcp, undefined);
    assert.equal(found.install.version, undefined);
  });

  it("refuses an app that is a link out of /Applications, and follows one that stays inside", async () => {
    const outside = {
      "/Applications": { kind: "dir" },
      [STUDIO_MAC_APP]: { kind: "link", to: "/Users/maker/Downloads/RobloxStudio.app" },
      "/Users/maker/Downloads/RobloxStudio.app": { kind: "dir" },
      "/Users/maker/Downloads/RobloxStudio.app/Contents/MacOS/RobloxStudio": { kind: "file" },
    } satisfies Record<string, Entry>;
    const refused = mac(outside);
    assert.deepEqual(await locateStudio(refused.deps), { installed: false, miss: StudioMiss.Refused });
    assert.deepEqual(refused.calls, [], "nothing runs for a refused app");

    const inside = {
      "/Applications": { kind: "dir" },
      [STUDIO_MAC_APP]: { kind: "link", to: "/Applications/Roblox/RobloxStudio.app" },
      "/Applications/Roblox": { kind: "dir" },
      "/Applications/Roblox/RobloxStudio.app": { kind: "dir" },
      "/Applications/Roblox/RobloxStudio.app/Contents/MacOS/RobloxStudio": { kind: "file" },
    } satisfies Record<string, Entry>;
    const found = await locateStudio(mac(inside).deps);
    assert.equal(found.installed, true);
    if (found.installed)
      assert.equal(found.install.studio, "/Applications/Roblox/RobloxStudio.app/Contents/MacOS/RobloxStudio");
  });

  it("refuses a Studio binary that is a link, and a home that isn't a Mac path", async () => {
    const linked = {
      ...MAC_INSTALLED,
      [`${MAC_CONTENTS}/MacOS/RobloxStudio`]: { kind: "link", to: "/tmp/other" },
      "/tmp": { kind: "dir" },
      "/tmp/other": { kind: "file" },
    } satisfies Record<string, Entry>;
    assert.deepEqual(await locateStudio(mac(linked).deps), { installed: false, miss: StudioMiss.Refused });
    for (const home of ["C:\\Users\\maker", "relative/home", "/Users/maker/../other", ""]) {
      const { deps, fs } = mac(MAC_INSTALLED, home);
      assert.deepEqual(await locateStudio(deps), { installed: false, miss: StudioMiss.OtherSystem }, home);
      assert.deepEqual(fs.touched, [], `${JSON.stringify(home)}: nothing is read`);
    }
  });
});

describe("Roblox Studio on Windows", () => {
  it("is the newest version folder's RobloxStudioBeta.exe, with mcp.bat and the Plugins folder", async () => {
    const { deps, fs, calls } = windows(WINDOWS_INSTALLED);
    assert.deepEqual(await locateStudio(deps), {
      installed: true,
      install: {
        app: `${NEW_VERSION}\\RobloxStudioBeta.exe`,
        studio: `${NEW_VERSION}\\RobloxStudioBeta.exe`,
        mcp: `${ROBLOX}\\mcp.bat`,
        plugins: `${ROBLOX}\\Plugins`,
      },
    });
    assert.deepEqual(calls, [], "nothing runs to find it");
    assertNoDocuments(fs.touched);
  });

  it("is missing with no version folder holding Studio (the player's alone don't count)", async () => {
    const entries: Record<string, Entry> = {
      [LOCAL]: { kind: "dir" },
      [ROBLOX]: { kind: "dir" },
      [VERSIONS]: { kind: "dir" },
      [OLD_VERSION]: { kind: "dir" },
      [`${OLD_VERSION}\\RobloxPlayerBeta.exe`]: { kind: "file" },
    };
    assert.deepEqual(await locateStudio(windows(entries).deps), { installed: false, miss: StudioMiss.NotInstalled });
    assert.deepEqual(await locateStudio(windows({ [LOCAL]: { kind: "dir" } }).deps), {
      installed: false,
      miss: StudioMiss.NotInstalled,
    });
  });

  it("has no MCP launcher when mcp.bat is missing or is a link", async () => {
    const missing = { ...WINDOWS_INSTALLED };
    delete missing[`${ROBLOX}\\mcp.bat`];
    const linked = { ...WINDOWS_INSTALLED, [`${ROBLOX}\\mcp.bat`]: { kind: "link", to: "C:\\evil.bat" } as Entry };
    for (const entries of [missing, linked]) {
      const found = await locateStudio(windows(entries).deps);
      assert.equal(found.installed, true);
      if (found.installed) assert.equal(found.install.mcp, undefined);
    }
  });

  it("refuses LOCALAPPDATA unset, a Mac path, `..`, a share, and a Roblox folder or version that is a link", async () => {
    const cases: Array<[string, NodeJS.ProcessEnv, Record<string, Entry>, StudioMiss]> = [
      ["unset", {}, WINDOWS_INSTALLED, StudioMiss.NoLocalAppData],
      ["empty", { LOCALAPPDATA: "" }, WINDOWS_INSTALLED, StudioMiss.NoLocalAppData],
      ["a Mac path", { LOCALAPPDATA: "/Users/maker/AppData/Local" }, WINDOWS_INSTALLED, StudioMiss.OtherSystem],
      ["relative", { LOCALAPPDATA: "AppData\\Local" }, WINDOWS_INSTALLED, StudioMiss.OtherSystem],
      ["dot-dot", { LOCALAPPDATA: "C:\\Users\\maker\\..\\other\\Local" }, WINDOWS_INSTALLED, StudioMiss.OtherSystem],
      ["a share", { LOCALAPPDATA: "\\\\server\\share\\Local" }, WINDOWS_INSTALLED, StudioMiss.OtherSystem],
      [
        "a Roblox folder that is a link",
        { LOCALAPPDATA: LOCAL },
        { ...WINDOWS_INSTALLED, [ROBLOX]: { kind: "link", to: "D:\\elsewhere" } },
        StudioMiss.Refused,
      ],
    ];
    for (const [label, env, entries, miss] of cases) {
      const { deps, calls } = windows(entries, env);
      assert.deepEqual(await locateStudio(deps), { installed: false, miss }, label);
      assert.deepEqual(calls, [], `${label}: nothing runs`);
    }
    const versionLink = {
      ...WINDOWS_INSTALLED,
      [NEW_VERSION]: { kind: "link", to: "D:\\elsewhere" } as Entry,
      "D:\\elsewhere": { kind: "dir" } as Entry,
      "D:\\elsewhere\\RobloxStudioBeta.exe": { kind: "file", mtimeMs: 99_000 } as Entry,
    };
    const found = await locateStudio(windows(versionLink).deps);
    assert.equal(found.installed, true);
    if (found.installed)
      assert.equal(
        found.install.studio,
        `${OLD_VERSION}\\RobloxStudioBeta.exe`,
        "a linked version folder is passed over",
      );
  });

  it("reads LOCALAPPDATA whatever its case", async () => {
    const found = await locateStudio(windows(WINDOWS_INSTALLED, { LocalAppData: LOCAL }).deps);
    assert.equal(found.installed, true);
  });

  it("finds Studio in the person's own profile when the host gave the bridge a profile of its own", async () => {
    // The host points a plugin server's profile folders at the connection's own home, as it does HOME.
    const own = "C:\\Users\\maker\\AppData\\Roaming\\Genex\\plugins\\roblox\\mcp\\demo\\home";
    const hosted = { USERPROFILE: own, APPDATA: `${own}\\AppData\\Roaming`, LOCALAPPDATA: `${own}\\AppData\\Local` };
    const missed = await locateStudio(windows(WINDOWS_INSTALLED, hosted).deps);
    assert.deepEqual(missed, { installed: false, miss: StudioMiss.NotInstalled }, "the host's profile holds no Studio");
    const found = await locateStudio(windows(WINDOWS_INSTALLED, personEnv(hosted, "win32", "C:\\Users\\maker")).deps);
    assert.equal(found.installed, true);
    assert.equal(found.installed && found.install.mcp, `${ROBLOX}\\mcp.bat`);
  });
});

describe("whether Roblox Studio runs", () => {
  it("parses pgrep: pids mean running, exit 1 means not", () => {
    assert.equal(pgrepRunning({ code: 0, stdout: "4530\n" }), true);
    assert.equal(pgrepRunning({ code: 0, stdout: "4530\n4531\n" }), true);
    assert.equal(pgrepRunning({ code: 1, stdout: "" }), false);
    assert.equal(pgrepRunning({ code: 0, stdout: "" }), false);
    assert.equal(pgrepRunning({ code: 0, stdout: "not a pid\n" }), false);
  });

  it("parses tasklist's CSV: a row for RobloxStudioBeta.exe means running, its no-tasks note doesn't", () => {
    const row = '"RobloxStudioBeta.exe","10432","Console","1","812,344 K"';
    assert.equal(tasklistRunning(`${row}\r\n`), true);
    assert.equal(tasklistRunning('"robloxstudiobeta.exe","10432","Console","1","812,344 K"\r\n'), true);
    assert.equal(tasklistRunning("INFO: No tasks are running which match the specified criteria.\r\n"), false);
    assert.equal(tasklistRunning('"RobloxPlayerBeta.exe","2210","Console","1","300,000 K"\r\n'), false);
    assert.equal(tasklistRunning(""), false);
  });

  it("asks pgrep on a Mac and tasklist by its full path on Windows, and a failure reads as not running", async () => {
    const onMac = fakeRun({ "/usr/bin/pgrep": { code: 0, stdout: "4530\n" } });
    assert.equal(
      await studioRunning({ platform: "darwin", env: {}, home: MAC_HOME, fs: fakeFs({}, path.posix), run: onMac.run }),
      true,
    );
    assert.deepEqual(onMac.calls, [{ file: "/usr/bin/pgrep", args: ["-x", "RobloxStudio"] }]);

    const tasklist = "D:\\Windows\\System32\\tasklist.exe";
    const onWindows = fakeRun({ [tasklist]: { code: 0, stdout: '"RobloxStudioBeta.exe","1","Console","1","1 K"' } });
    const env = { SystemRoot: "D:\\Windows" };
    const deps = { platform: "win32" as const, env, home: "C:\\Users\\maker", fs: fakeFs({}, path.win32) };
    assert.equal(await studioRunning({ ...deps, run: onWindows.run }), true);
    assert.deepEqual(onWindows.calls, [
      { file: tasklist, args: ["/FI", "IMAGENAME eq RobloxStudioBeta.exe", "/FO", "CSV", "/NH"] },
    ]);
    const hostile = fakeRun({ "C:\\Windows\\System32\\tasklist.exe": { code: 0, stdout: "" } });
    await studioRunning({ ...deps, env: { SystemRoot: "/usr/bin" }, run: hostile.run });
    assert.equal(
      hostile.calls[0]?.file,
      "C:\\Windows\\System32\\tasklist.exe",
      "a SystemRoot that isn't Windows' is not used",
    );

    const broken = fakeRun({});
    assert.equal(await studioRunning({ ...deps, run: broken.run }), false);
  });

  it("lists every Studio process on a Mac from pgrep's lines, keeping only whole pids", async () => {
    const mac = { platform: "darwin" as const, env: {}, home: MAC_HOME, fs: fakeFs({}, path.posix) };
    const several = fakeRun({ "/usr/bin/pgrep": { code: 0, stdout: "4530\n12a\n\n 8620 \n-1\n" } });
    assert.deepEqual(await studioPids({ ...mac, run: several.run }), [4530, 8620]);
    const none = fakeRun({ "/usr/bin/pgrep": { code: 1, stdout: "" } });
    assert.deepEqual(await studioPids({ ...mac, run: none.run }), []);
    assert.deepEqual(await studioPids({ ...mac, run: fakeRun({}).run }), [], "pgrep that can't run lists none");
    const windows = fakeRun({});
    const onWindows = { platform: "win32" as const, env: {}, home: "C:\\Users\\maker", fs: fakeFs({}, path.win32) };
    assert.deepEqual(await studioPids({ ...onWindows, run: windows.run }), []);
    assert.deepEqual(windows.calls, [], "nothing is asked on Windows");
  });
});
