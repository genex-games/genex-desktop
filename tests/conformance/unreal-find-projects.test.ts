/**
 * Find projects without typing: the Unreal panel lists the user's projects from Unreal's own
 * Recent Projects list, the Unreal Projects folder (one level down, as Unreal's own browser looks)
 * and the projects Genex created, set up or was shown, once each by real path, newest first, at
 * most twelve. Listing only reads: nothing is written, no link is followed into the list, and the
 * folder scan is kept for ten seconds so the panel's three-second refresh stays cheap.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createUnrealBackend } from "../../src/plugins/unreal/backend.ts";
import type { Launch } from "../../src/plugins/unreal/editor-launch.ts";
import { findProjects, keepFor, placeOf, scanProjectsFolder } from "../../src/plugins/unreal/find-projects.ts";
import { findEngines, type SetupEnv, setUpProject } from "../../src/plugins/unreal/setup.ts";
import { type XcodeStatus, XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GIB = 1024 ** 3;
const HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
const LINKS = process.platform === "win32" && "links need privileges on Windows";
const START = Date.UTC(2026, 9, 4, 9, 0, 0);
const READY_XCODE: XcodeStatus = {
  state: XcodeState.Ready,
  app: "/Applications/Xcode.app",
  version: "26.2",
  commandLineTools: true,
  supported: null,
  command: null,
};

function fakeEnv(home: string, overrides: Partial<SetupEnv> = {}): SetupEnv {
  return {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => false,
    portListening: async () => false,
    editorAnswers: async () => false,
    xcode: async () => READY_XCODE,
    freeBytes: async () => 200 * GIB,
    totalMemory: () => 32 * GIB,
    ...overrides,
  };
}

const uproject = (engine: string) =>
  `${JSON.stringify({ FileVersion: 3, EngineAssociation: engine, Category: "", Description: "" }, null, "\t")}\n`;

/** A project `<parent>/<name>/<name>.uproject`, last changed at `modified`. */
async function project(parent: string, name: string, { engine = "5.8", modified = START - 86_400_000 } = {}) {
  const file = path.join(parent, name, `${name}.uproject`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, uproject(engine));
  await utimes(file, new Date(modified), new Date(modified));
  return file;
}

/** Every file and link under `dir` with a hash of its bytes: a no-side-effect witness. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[key] = "link";
    else if (entry.isFile())
      out[key] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
    else if (entry.isDirectory()) out[`${key}/`] = "dir";
  }
  return out;
}

/** A fake home with Epic's lists, an engine, the Unreal Projects folder and the plugin's storage. */
async function fixture() {
  const root = await realpath(await tmpDir("studio-unreal-find-"));
  const home = path.join(root, "home");
  const folder = path.join(home, "Documents", "Unreal Projects");
  const storage = path.join(root, "storage");
  const engine = path.join(root, "Engines", "UE_5.8");
  await mkdir(engine, { recursive: true });
  await mkdir(folder, { recursive: true });
  const epic = path.join(home, "Library", "Application Support", "Epic");
  await mkdir(path.join(epic, "UnrealEngineLauncher"), { recursive: true });
  await writeFile(
    path.join(epic, "UnrealEngineLauncher", "LauncherInstalled.dat"),
    JSON.stringify({
      InstallationList: [
        { InstallLocation: engine, AppVersion: "5.8.3-58210709+++UE5+Release-5.8-Mac", AppName: "UE_5.8" },
      ],
    }),
  );
  const env = fakeEnv(home);
  /** Writes Unreal's own Recent Projects list: `[file, LastOpenTime]` pairs as Epic writes them. */
  const recent = async (entries: Array<[string, string]>) => {
    const dir = path.join(epic, "UnrealEngine", "5.8", "Saved", "Config", "MacEditor");
    await mkdir(dir, { recursive: true });
    const lines = entries.map(([file, at]) => `RecentlyOpenedProjectFiles=(ProjectName="${file}",LastOpenTime=${at})`);
    await writeFile(
      path.join(dir, "EditorSettings.ini"),
      ["[/Script/UnrealEd.EditorSettings]", ...lines, ""].join("\n"),
    );
  };
  const f = {
    root,
    home,
    folder,
    storage,
    env,
    recent,
    find: async () =>
      findProjects({ env, engines: await findEngines(env), storage, scanned: await scanProjectsFolder(f.folder) }),
    names: async () => (await f.find()).map((p) => p.name),
  };
  return f;
}

/** A setup record the way setup writes one, by hand: hostile rows put what setup never would. */
async function record(storage: string, key: string, value: unknown) {
  await mkdir(path.join(storage, "setup", key), { recursive: true });
  await writeFile(path.join(storage, "setup", key, "record.json"), JSON.stringify(value));
}

describe("The Unreal panel's project list", () => {
  it("lists Unreal's recent projects, the Unreal Projects folder and the projects Genex set up, newest first", async () => {
    const f = await fixture();
    const alpha = await project(f.folder, "Alpha", { modified: Date.UTC(2026, 8, 1) });
    const beta = await project(f.folder, "Beta", { engine: "5.7", modified: Date.UTC(2026, 8, 20) });
    const gamma = await project(path.join(f.root, "Elsewhere"), "Gamma", { modified: Date.UTC(2026, 0, 1) });
    const delta = await project(path.join(f.root, "Other"), "Delta");
    await setUpProject(delta, { env: f.env, helper: HELPER, storage: f.storage });
    await utimes(delta, new Date(Date.UTC(2026, 8, 10)), new Date(Date.UTC(2026, 8, 10)));
    await f.recent([
      [gamma, "2026.10.03-20.00.00"],
      [beta, "2026.10.01-08.00.00"],
    ]);
    const found = await f.find();
    assert.deepEqual(
      found.map((p) => p.name),
      ["Gamma", "Beta", "Delta", "Alpha"],
      "last opened when Unreal says, else last changed",
    );
    assert.deepEqual(found[1], {
      file: beta,
      name: "Beta",
      place: ["Documents", "Unreal Projects"],
      engine: "5.7",
      opened: Date.UTC(2026, 9, 1, 8, 0, 0),
      modified: Date.UTC(2026, 8, 20),
    });
    assert.equal(found[0].opened, Date.UTC(2026, 9, 3, 20, 0, 0), "Unreal writes LastOpenTime in UTC");
    assert.deepEqual(found[0].place, path.dirname(path.dirname(gamma)).split(path.sep).filter(Boolean));
    assert.equal(found[3].file, alpha);
    assert.equal(found[3].opened, null);
  });

  it("lists a project once by its real path, however each list spells it", {
    skip: LINKS,
  }, async () => {
    const f = await fixture();
    const gamma = await project(path.join(f.root, "Elsewhere"), "Gamma");
    await symlink(path.join(f.root, "Elsewhere"), path.join(f.root, "Via"));
    await setUpProject(gamma, { env: f.env, helper: HELPER, storage: f.storage });
    await f.recent([[path.join(f.root, "Via", "Gamma", "Gamma.uproject"), "2026.10.03-20.00.00"]]);
    const found = await f.find();
    assert.deepEqual(
      found.map((p) => [p.file, p.opened]),
      [[gamma, Date.UTC(2026, 9, 3, 20, 0, 0)]],
    );
  });

  it("drops projects that are gone: a stale recent entry and a set-up project moved away", async () => {
    const f = await fixture();
    const drift = await project(f.folder, "Drift");
    const delta = await project(path.join(f.root, "Other"), "Delta");
    await setUpProject(delta, { env: f.env, helper: HELPER, storage: f.storage });
    await rename(path.join(f.root, "Other"), path.join(f.root, "Moved"));
    await f.recent([
      [path.join(f.root, "Gone", "Gone.uproject"), "2026.10.03-20.00.00"],
      [drift, "2026.10.01-08.00.00"],
    ]);
    assert.deepEqual(await f.names(), ["Drift"]);
  });

  it("shows at most twelve, the newest", async () => {
    const f = await fixture();
    for (let day = 1; day <= 15; day++)
      await project(f.folder, `Game${String(day).padStart(2, "0")}`, { modified: Date.UTC(2026, 8, day) });
    assert.deepEqual(
      await f.names(),
      Array.from({ length: 12 }, (_, i) => `Game${String(15 - i).padStart(2, "0")}`),
    );
  });

  it("keeps a project picked with Choose… in the list, from the panel's remembered choice", async () => {
    const f = await fixture();
    const picked = await project(path.join(f.root, "Picked"), "Picked");
    await mkdir(f.storage, { recursive: true });
    await writeFile(path.join(f.storage, "chosen.json"), JSON.stringify({ project: picked }));
    assert.deepEqual(await f.names(), ["Picked"]);
  });
});

/** Things a list could be tricked into showing, or into hanging or writing on. Baseline: Drift only. */
const hostile: Array<{
  name: string;
  links?: boolean;
  arrange: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>;
}> = [
  {
    name: "a project folder in Unreal Projects that links to a project elsewhere",
    links: true,
    arrange: async (f) => {
      await project(path.join(f.root, "Outside"), "Linked");
      await symlink(path.join(f.root, "Outside", "Linked"), path.join(f.folder, "Linked"));
    },
  },
  {
    name: "a .uproject in Unreal Projects that links to one elsewhere",
    links: true,
    arrange: async (f) => {
      const outside = await project(path.join(f.root, "Outside"), "Victim");
      await mkdir(path.join(f.folder, "Lure"));
      await symlink(outside, path.join(f.folder, "Lure", "Lure.uproject"));
    },
  },
  {
    name: "an Unreal Projects folder that is itself a link",
    links: true,
    arrange: async (f) => {
      await f.recent([[path.join(f.folder, "Drift", "Drift.uproject"), "2026.10.01-08.00.00"]]);
      await project(path.join(f.root, "Real Projects"), "Linked");
      await symlink(path.join(f.root, "Real Projects"), path.join(f.home, "Documents", "Linked Projects"));
      // The scan is pointed at the link itself; Drift still comes from Unreal's own list.
      f.folder = path.join(f.home, "Documents", "Linked Projects");
    },
  },
  {
    name: "a folder named like a project",
    arrange: async (f) => {
      await mkdir(path.join(f.folder, "Hollow", "Hollow.uproject"), { recursive: true });
    },
  },
  {
    name: "a pipe named like a project, which would hang a read",
    links: true,
    arrange: async (f) => {
      await mkdir(path.join(f.folder, "Pipe"));
      execFileSync("mkfifo", [path.join(f.folder, "Pipe", "Pipe.uproject")]);
    },
  },
  {
    name: "a project two folders down",
    arrange: async (f) => {
      await project(path.join(f.folder, "Nested"), "Deep");
    },
  },
  {
    name: "a .uproject loose at the top of Unreal Projects",
    arrange: async (f) => {
      await writeFile(path.join(f.folder, "Loose.uproject"), uproject("5.8"));
    },
  },
  {
    name: "a half-made new game in Genex's hidden build folder",
    arrange: async (f) => {
      const hidden = path.join(f.folder, ".genex-new-GxCar-0a1b2c3d");
      await mkdir(hidden);
      await writeFile(path.join(hidden, "GxCar.uproject"), uproject("5.8"));
    },
  },
  {
    name: "recent entries that are relative, not a .uproject, or a link",
    links: true,
    arrange: async (f) => {
      const outside = await project(path.join(f.root, "Outside"), "Victim");
      await writeFile(path.join(f.folder, "notes.txt"), "x");
      await symlink(outside, path.join(f.root, "Lure.uproject"));
      await f.recent([
        ["Drift/Drift.uproject", "2026.10.03-20.00.00"],
        [path.join(f.folder, "notes.txt"), "2026.10.03-20.00.00"],
        [path.join(f.root, "Lure.uproject"), "2026.10.03-20.00.00"],
      ]);
    },
  },
  {
    name: "setup records naming a link, a relative path, a missing project or no port",
    links: true,
    arrange: async (f) => {
      const outside = await project(path.join(f.root, "Outside"), "Victim");
      await symlink(outside, path.join(f.root, "Lure.uproject"));
      await record(f.storage, "a", { project: path.join(f.root, "Lure.uproject"), port: 18_001 });
      await record(f.storage, "b", { project: "Outside/Victim/Victim.uproject", port: 18_002 });
      await record(f.storage, "c", { project: path.join(f.root, "Gone", "Gone.uproject"), port: 18_003 });
      await record(f.storage, "d", { project: outside, port: "18004" });
    },
  },
  {
    name: "a remembered choice that is a link to a choice elsewhere",
    links: true,
    arrange: async (f) => {
      const outside = await project(path.join(f.root, "Outside"), "Victim");
      await writeFile(path.join(f.root, "elsewhere.json"), JSON.stringify({ project: outside }));
      await mkdir(f.storage, { recursive: true });
      await symlink(path.join(f.root, "elsewhere.json"), path.join(f.storage, "chosen.json"));
    },
  },
];

describe("The project list never shows, follows or writes", () => {
  for (const row of hostile)
    it(`${row.name}`, { skip: row.links ? LINKS : false }, async () => {
      const f = await fixture();
      await project(f.folder, "Drift");
      await row.arrange(f);
      const witness = await tree(f.root);
      assert.deepEqual(await f.names(), ["Drift"]);
      assert.deepEqual(await tree(f.root), witness, "listing wrote, moved or removed nothing");
    });
});

describe("A project's spelling", () => {
  it("is the file's own name on disk, so a recent entry in another case lists it once", async () => {
    const f = await fixture();
    const drift = await project(f.folder, "DriftRacer");
    await f.recent([[path.join(path.dirname(drift), "driftracer.uproject"), "2026.10.03-20.00.00"]]);
    const found = await f.find();
    assert.deepEqual(
      found.map((p) => [path.basename(p.file), p.name]),
      [["DriftRacer.uproject", "DriftRacer"]],
    );
  });
});

describe("Where a folder is shown", () => {
  it("names the same Documents folder the same way in the New game form and the project list, through a link", {
    skip: LINKS,
  }, async () => {
    const root = await realpath(await tmpDir("studio-unreal-place-"));
    const home = path.join(root, "home");
    const synced = path.join(root, "Synced", "Documents");
    await mkdir(path.join(synced, "Unreal Projects"), { recursive: true });
    await mkdir(home, { recursive: true });
    // Documents is a link elsewhere, as a synced Documents folder can be.
    await symlink(synced, path.join(home, "Documents"));
    const folder = path.join(home, "Documents", "Unreal Projects");
    await project(folder, "Drift");
    const backend = createUnrealBackend({
      env: fakeEnv(home),
      helper: HELPER,
      projects: async () => folder,
      launch: { open: async () => {}, applications: path.join(root, "Applications"), now: () => START },
    });
    const context = {
      signal: new AbortController().signal,
      callId: 1,
      host: (async () => path.join(root, "storage")) as never,
    };
    const offer = (await backend.action?.("templates", {}, context)) as { place: string[] };
    const status = (await backend.action?.("status", {}, context)) as { projects: Array<{ place: string[] }> };
    assert.deepEqual(status.projects[0]?.place, offer.place);
  });

  it("names a folder that doesn't exist yet from its nearest existing one", async () => {
    const f = await fixture();
    const later = path.join(f.home, "Documents", "Not Yet", "Unreal Projects");
    assert.deepEqual(await placeOf(later, f.home), ["Documents", "Not Yet", "Unreal Projects"]);
  });
});

describe("A kept scan", () => {
  it("is reused just under ten seconds, made again at ten, and made again when the clock goes back", async () => {
    let clock = 1_000_000;
    let made = 0;
    const scan = keepFor(
      10_000,
      () => clock,
      async () => ++made,
    );
    assert.equal(await scan(), 1);
    clock += 9_999;
    assert.equal(await scan(), 1, "reused at +9.999 s");
    clock += 1;
    assert.equal(await scan(), 2, "made again at +10 s");
    clock -= 1;
    assert.equal(await scan(), 3, "a clock that went back counts as stale");
  });
});

describe("Documents in OneDrive", () => {
  it("still lists a project where readdir calls every entry a link but lstat sees plain files", async () => {
    const f = await fixture();
    await project(f.folder, "Drift");
    const everyEntryALink = async (dir: string) =>
      (await readdir(dir)).map((name) => ({
        name,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
      }));
    assert.deepEqual(
      (await scanProjectsFolder(f.folder, everyEntryALink)).map((p) => p.name),
      ["Drift"],
    );
  });

  it("still skips a project folder that really is a link", { skip: LINKS }, async () => {
    const f = await fixture();
    const outside = await project(path.join(f.root, "Outside"), "Victim");
    await symlink(path.dirname(outside), path.join(f.folder, "Victim"));
    assert.deepEqual(await scanProjectsFolder(f.folder), []);
  });
});

describe("The panel's status lists projects without slowing down", () => {
  async function backendFixture() {
    const f = await fixture();
    let clock = START;
    const launched: Launch[] = [];
    const backend = createUnrealBackend({
      env: f.env,
      helper: HELPER,
      projects: async () => f.folder,
      launch: {
        open: async (launch) => {
          launched.push(launch);
        },
        applications: path.join(f.root, "Applications"),
        now: () => clock,
      },
    });
    const context = {
      signal: new AbortController().signal,
      callId: 1,
      host: (async (method: string) => {
        if (method === "storage.root") return f.storage;
        throw new Error(`unexpected host call ${method}`);
      }) as never,
    };
    const status = async () =>
      (await backend.action?.("status", {}, context)) as {
        projects: Array<{ name: string }>;
        project?: { name: string };
      };
    return { ...f, status, launched, tick: (ms: number) => (clock += ms) };
  }

  it("keeps the Unreal Projects folder's scan for ten seconds", async () => {
    const b = await backendFixture();
    await project(b.folder, "Alpha", { modified: Date.UTC(2026, 8, 1) });
    assert.deepEqual(
      (await b.status()).projects.map((p) => p.name),
      ["Alpha"],
    );
    await project(b.folder, "Beta", { modified: Date.UTC(2026, 8, 2) });
    b.tick(5_000);
    assert.deepEqual(
      (await b.status()).projects.map((p) => p.name),
      ["Alpha"],
      "a refresh five seconds later reuses the scan",
    );
    b.tick(6_000);
    assert.deepEqual(
      (await b.status()).projects.map((p) => p.name),
      ["Beta", "Alpha"],
    );
    assert.deepEqual(b.launched, [], "a status launches nothing");
  });

  it("shows the newest project when none was chosen, and writes nothing while it looks", async () => {
    const b = await backendFixture();
    await project(b.folder, "Older", { modified: Date.UTC(2026, 8, 1) });
    await project(b.folder, "Newer", { modified: Date.UTC(2026, 8, 2) });
    const witness = await tree(b.root);
    assert.equal((await b.status()).project?.name, "Newer");
    assert.deepEqual(await tree(b.root), witness);
  });
});
