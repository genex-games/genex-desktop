/**
 * Roblox Studio setup on a real disk: Set up adds the Genex helper to Studio's Plugins folder
 * (making the folder when Studio hasn't yet) and turns on Studio's MCP server in every account's
 * settings file, only while Studio is closed; Undo takes back only what still holds Genex's bytes.
 * Every hostile shape (a link, a folder of the other system, unreadable settings, Studio running)
 * is refused before anything is written, inside the home or through a link out of it.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { switchBackText, switchOnText } from "../../src/plugins/roblox/mcp-switch.ts";
import {
  HELPER_FILE,
  HELPER_VERSION,
  HelperChange,
  HelperState,
  helperVersionOf,
  inspectSetup,
  type SetupOptions,
  type SetupPaths,
  setUp,
  setupPaths,
  undoSetup,
  recordedHelper,
  updateHelper,
} from "../../src/plugins/roblox/setup.ts";
import { RobloxSetupError, SetupRefusal } from "../../src/plugins/roblox/setup-refusal.ts";
import { shippedHelper } from "../helpers/roblox-helper.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const SHIPPED_HELPER = await shippedHelper();
const ACCOUNT = "9172881962";
const OTHER_ACCOUNT = "9173494966";

/** A settings file as Studio writes it: four-space indents, the switch off, other keys around it. */
const SETTINGS_OFF = `{
    "mcp-server": {
        "enabled": false
    },
    "integrations": {
        "integrations": []
    },
    "AssistantSkillsCloudMigrated": true
}`;
/** A settings file Studio wrote before the switch existed. */
const SETTINGS_WITHOUT_SWITCH = `{
    "integrations": {
        "integrations": [
            "codex"
        ]
    },
    "AssistantSkillsCloudMigrated": 1.50
}`;
const SETTINGS_ON = `{
    "mcp-server": {
        "enabled": true
    }
}`;

/** One computer's home, made for a test: Roblox's folders as a Mac lays them out, Studio closed. */
interface Home {
  root: string;
  home: string;
  storage: string;
  paths: SetupPaths;
  running: boolean;
  options(): SetupOptions;
}

async function makeHome(settings: Record<string, string> = { [ACCOUNT]: SETTINGS_OFF }): Promise<Home> {
  const root = await tmpDir("roblox-setup-");
  const home = path.join(root, "home");
  const roblox = path.join(home, "Documents", "Roblox");
  const settingsFolder = path.join(home, "Library", "Roblox", "AssistantSettings");
  await mkdir(roblox, { recursive: true });
  await mkdir(settingsFolder, { recursive: true });
  for (const [name, text] of Object.entries(settings)) await writeFile(path.join(settingsFolder, `${name}.json`), text);
  const paths: SetupPaths = {
    guarded: [roblox],
    roblox,
    plugins: path.join(roblox, "Plugins"),
    settings: settingsFolder,
  };
  const state: Home = {
    root,
    home,
    storage: path.join(root, "storage"),
    paths,
    running: false,
    options: () => ({
      paths: state.paths,
      helper: SHIPPED_HELPER,
      storage: state.storage,
      running: async () => state.running,
      now: () => Date.parse("2030-01-02T03:04:05.000Z"),
    }),
  };
  return state;
}

/** Everything under `root`, links not followed: each path's kind and its bytes or target. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  async function visit(dir: string) {
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const key = path.relative(root, full);
      if (info.isSymbolicLink()) seen.set(key, `link → ${await readlink(full)}`);
      else if (info.isDirectory()) {
        seen.set(key, "folder");
        await visit(full);
      } else seen.set(key, `file ${(await readFile(full)).toString("base64")}`);
    }
  }
  await visit(root);
  return seen;
}

/** Makes a link, or skips the row on a Windows runner that may not make one. */
async function link(t: { skip(reason: string): void }, target: string, at: string, type?: "dir" | "file") {
  try {
    await symlink(target, at, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (process.platform !== "win32") throw error;
    t.skip(`this runner can't make links: ${(error as Error).message}`);
    return false;
  }
}

const settingsFile = (home: Home, name = ACCOUNT) => path.join(home.paths.settings, `${name}.json`);
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const recordFile = (home: Home) => path.join(home.storage, "setup", "record.json");

async function refusedWith(work: Promise<unknown>, code: SetupRefusal) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof RobloxSetupError, `a setup refusal, not ${String(error)}`);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /overnight|night|morning|tonight/i);
    return true;
  });
}

/** A helper file as Genex ships it, at another version. */
const helperAt = (version: number) =>
  `<roblox version="4"><Item class="Script"><Properties><ProtectedString name="Source"><![CDATA[local GENEX_HELPER_VERSION = ${version}\n]]></ProtectedString></Properties></Item></roblox>\n`;

describe("where Roblox keeps its plugins and settings", () => {
  it("is spelled from the home on a Mac and from LOCALAPPDATA on Windows", () => {
    assert.deepEqual(setupPaths("darwin", {}, "/Users/maker"), {
      guarded: ["/Users/maker/Documents/Roblox"],
      roblox: "/Users/maker/Documents/Roblox",
      plugins: "/Users/maker/Documents/Roblox/Plugins",
      settings: "/Users/maker/Library/Roblox/AssistantSettings",
    });
    assert.deepEqual(setupPaths("win32", { LOCALAPPDATA: "C:\\Users\\maker\\AppData\\Local" }, "C:\\Users\\maker"), {
      guarded: ["C:\\Users\\maker\\AppData\\Local", "C:\\Users\\maker\\AppData\\Local\\Roblox"],
      roblox: "C:\\Users\\maker\\AppData\\Local\\Roblox",
      plugins: "C:\\Users\\maker\\AppData\\Local\\Roblox\\Plugins",
      settings: "C:\\Users\\maker\\AppData\\Local\\Roblox\\AssistantSettings",
    });
  });

  const hostile: Array<[string, NodeJS.Platform, NodeJS.ProcessEnv, string]> = [
    ["a home that climbs with ..", "darwin", {}, "/Users/maker/../other"],
    ["a Windows home on a Mac", "darwin", {}, "C:\\Users\\maker"],
    ["a relative home", "darwin", {}, "Users/maker"],
    ["no LOCALAPPDATA", "win32", {}, "C:\\Users\\maker"],
    ["a LOCALAPPDATA that climbs with ..", "win32", { LOCALAPPDATA: "C:\\Users\\maker\\..\\x" }, "C:\\Users\\maker"],
    ["a Mac LOCALAPPDATA on Windows", "win32", { LOCALAPPDATA: "/Users/maker/Local" }, "C:\\Users\\maker"],
    ["a network share for LOCALAPPDATA", "win32", { LOCALAPPDATA: "\\\\server\\share\\Local" }, "C:\\Users\\maker"],
    ["a system Studio doesn't run on", "linux", {}, "/home/maker"],
  ];
  for (const [name, platform, env, home] of hostile)
    it(`refuses ${name}`, () => {
      assert.throws(
        () => setupPaths(platform, env, home),
        (error: unknown) => error instanceof RobloxSetupError && error.code === SetupRefusal.OtherSystem,
      );
    });
});

describe("Set up refuses a hostile computer and writes nothing", () => {
  type Row = [string, SetupRefusal, (home: Home, t: { skip(reason: string): void }) => Promise<boolean | undefined>];
  const rows: Row[] = [
    [
      "a Plugins folder that is a link",
      SetupRefusal.Linked,
      async (home, t) => {
        const elsewhere = path.join(home.root, "elsewhere");
        await mkdir(elsewhere);
        return link(t, elsewhere, home.paths.plugins, "dir");
      },
    ],
    [
      "a Documents › Roblox folder that is a link (no folder is made through it)",
      SetupRefusal.Linked,
      async (home, t) => {
        const elsewhere = path.join(home.root, "elsewhere");
        await mkdir(elsewhere);
        await removeTree(home.paths.roblox);
        return link(t, elsewhere, home.paths.roblox, "dir");
      },
    ],
    [
      "a helper file that is a link",
      SetupRefusal.Linked,
      async (home, t) => {
        await mkdir(home.paths.plugins);
        const elsewhere = path.join(home.root, "elsewhere.rbxmx");
        await writeFile(elsewhere, "the person's own file");
        return link(t, elsewhere, path.join(home.paths.plugins, HELPER_FILE), "file");
      },
    ],
    [
      "a folder where the helper file goes",
      SetupRefusal.NotAFolder,
      async (home) => {
        await mkdir(path.join(home.paths.plugins, HELPER_FILE), { recursive: true });
        return true;
      },
    ],
    [
      "a file where the Plugins folder goes",
      SetupRefusal.NotAFolder,
      async (home) => {
        await writeFile(home.paths.plugins, "not a folder");
        return true;
      },
    ],
    [
      "an AssistantSettings folder that is a link",
      SetupRefusal.Linked,
      async (home, t) => {
        const elsewhere = path.join(home.root, "settings-elsewhere");
        await mkdir(elsewhere);
        await writeFile(path.join(elsewhere, `${ACCOUNT}.json`), SETTINGS_OFF);
        await removeTree(home.paths.settings);
        return link(t, elsewhere, home.paths.settings, "dir");
      },
    ],
    [
      "a settings file that is a link",
      SetupRefusal.Linked,
      async (home, t) => {
        const elsewhere = path.join(home.root, "settings.json");
        await writeFile(elsewhere, SETTINGS_OFF);
        await rm(settingsFile(home));
        return link(t, elsewhere, settingsFile(home), "file");
      },
    ],
    [
      "a settings file that isn't JSON",
      SetupRefusal.UnreadableSettings,
      async (home) => {
        await writeFile(settingsFile(home), "{ not json");
        return true;
      },
    ],
    [
      "a settings file holding a JSON array",
      SetupRefusal.UnreadableSettings,
      async (home) => {
        await writeFile(settingsFile(home), '[{"mcp-server": {"enabled": false}}]');
        return true;
      },
    ],
    [
      "a settings file over the size Genex reads",
      SetupRefusal.UnreadableSettings,
      async (home) => {
        await writeFile(settingsFile(home), `{"pad": "${"x".repeat(300 * 1024)}"}`);
        return true;
      },
    ],
    [
      "a settings file naming the switch twice",
      SetupRefusal.UnreadableSettings,
      async (home) => {
        await writeFile(settingsFile(home), '{"mcp-server": {"enabled": false}, "mcp-server": {"enabled": false}}');
        return true;
      },
    ],
    [
      "a folder named like a settings file",
      SetupRefusal.UnreadableSettings,
      async (home) => {
        await mkdir(path.join(home.paths.settings, `${OTHER_ACCOUNT}.json`));
        return true;
      },
    ],
    [
      "no Roblox folder in Documents (Studio never ran)",
      SetupRefusal.NoRobloxFolder,
      async (home) => {
        await removeTree(home.paths.roblox);
        return true;
      },
    ],
    [
      "Roblox Studio running",
      SetupRefusal.StudioRunning,
      async (home) => {
        home.running = true;
        return true;
      },
    ],
  ];
  for (const [name, code, arrange] of rows)
    it(`refuses ${name}`, async (t) => {
      const home = await makeHome();
      if ((await arrange(home, t)) === false) return;
      const before = await snapshot(home.root);
      await refusedWith(setUp(home.options()), code);
      assert.deepEqual(await snapshot(home.root), before, "nothing was written anywhere, nor through a link");
    });

  it("refuses a LOCALAPPDATA that is a link on Windows", { skip: process.platform !== "win32" }, async (t) => {
    const home = await makeHome();
    const real = path.join(home.root, "real-local");
    await mkdir(path.join(real, "Roblox"), { recursive: true });
    const local = path.join(home.root, "Local");
    if (!(await link(t, real, local, "dir"))) return;
    home.paths = setupPaths("win32", { LOCALAPPDATA: local }, home.home);
    const before = await snapshot(home.root);
    await refusedWith(setUp(home.options()), SetupRefusal.Linked);
    assert.deepEqual(await snapshot(home.root), before);
  });

  it("a file whose name isn't an account number is never touched: with no other file there are no settings", async () => {
    const home = await makeHome({ "not-an-account": SETTINGS_OFF, [`${ACCOUNT}.backup`]: SETTINGS_OFF });
    const done = await setUp(home.options());
    assert.equal(done.switches.files, 0, "no settings file: Genex never makes one or guesses an account");
    assert.equal(done.helper, HelperChange.Added, "the helper is still added");
    assert.equal(await readFile(path.join(home.paths.settings, "not-an-account.json"), "utf8"), SETTINGS_OFF);
    assert.deepEqual(
      (await readdir(home.paths.settings)).sort(),
      [`${ACCOUNT}.backup.json`, "not-an-account.json"],
      "no settings file was made",
    );
  });
});

describe("Set up on a closed Studio", () => {
  it("makes the missing Plugins folder, adds the helper and turns the switch on, recording each write", async () => {
    const home = await makeHome();
    await chmod(home.paths.roblox, 0o700);
    const done = await setUp(home.options());
    assert.deepEqual(done, {
      helper: HelperChange.Added,
      pluginsCreated: true,
      switches: { files: 1, turnedOn: 1, alreadyOn: 0 },
    });
    const shipped = await readFile(SHIPPED_HELPER);
    assert.deepEqual(await readFile(path.join(home.paths.plugins, HELPER_FILE)), shipped);
    if (process.platform !== "win32")
      assert.equal((await stat(home.paths.roblox)).mode & 0o777, 0o700, "the folder around it is left as it was");
    assert.equal(JSON.parse(await readFile(settingsFile(home), "utf8"))["mcp-server"].enabled, true);
    const record = JSON.parse(await readFile(recordFile(home), "utf8"));
    assert.deepEqual(record.plugins, { folder: home.paths.plugins, created: true });
    assert.deepEqual(record.helper, {
      file: path.join(home.paths.plugins, HELPER_FILE),
      sha256: sha256(shipped),
      version: HELPER_VERSION,
    });
    assert.equal(record.switches.length, 1);
    assert.equal(record.switches[0].file, settingsFile(home));
    assert.equal(record.at, "2030-01-02T03:04:05.000Z");
  });

  it("keeps every other key of the settings byte for byte, with or without a switch there before", async () => {
    const home = await makeHome({ [ACCOUNT]: SETTINGS_OFF, [OTHER_ACCOUNT]: SETTINGS_WITHOUT_SWITCH });
    const done = await setUp(home.options());
    assert.deepEqual(done.switches, { files: 2, turnedOn: 2, alreadyOn: 0 }, "every account's file is turned on");
    const first = await readFile(settingsFile(home), "utf8");
    assert.equal(first, SETTINGS_OFF.replace('"enabled": false', '"enabled": true'), "only the one value changed");
    const second = await readFile(settingsFile(home, OTHER_ACCOUNT), "utf8");
    assert.equal(JSON.parse(second)["mcp-server"].enabled, true);
    assert.ok(second.includes('"AssistantSkillsCloudMigrated": 1.50'), "a number keeps its own spelling");
    assert.ok(
      second.includes('"integrations": {\n        "integrations": [\n            "codex"\n        ]\n    }'),
      "integrations is untouched",
    );
  });

  it("leaves a switch that is already on alone and records nothing for it", async () => {
    const home = await makeHome({ [ACCOUNT]: SETTINGS_ON });
    const before = await stat(settingsFile(home));
    const done = await setUp(home.options());
    assert.deepEqual(done.switches, { files: 1, turnedOn: 0, alreadyOn: 1 });
    const after = await stat(settingsFile(home));
    assert.equal(after.ino, before.ino, "the file was not rewritten");
    assert.deepEqual(JSON.parse(await readFile(recordFile(home), "utf8")).switches, []);
  });

  it("answers no settings when Studio has written none, and still adds the helper", async () => {
    const home = await makeHome({});
    const done = await setUp(home.options());
    assert.deepEqual(done.switches, { files: 0, turnedOn: 0, alreadyOn: 0 });
    assert.deepEqual(await readdir(home.paths.settings), []);
    assert.equal(done.helper, HelperChange.Added);
  });
});

describe("the helper's version", () => {
  it("is read from the shipped file and equals the TypeScript constant", async () => {
    assert.equal(helperVersionOf(await readFile(SHIPPED_HELPER, "utf8")), HELPER_VERSION);
    assert.equal(helperVersionOf("print('no marker')"), undefined);
  });

  const table: Array<[string, string | undefined, HelperState, HelperChange, "shipped" | "kept"]> = [
    ["missing", undefined, HelperState.Missing, HelperChange.Added, "shipped"],
    ["outdated", helperAt(HELPER_VERSION - 1), HelperState.Outdated, HelperChange.Updated, "shipped"],
    ["newer", helperAt(HELPER_VERSION + 5), HelperState.Newer, HelperChange.Kept, "kept"],
    ["unmarked (not Genex's)", "the person's own plugin", HelperState.Outdated, HelperChange.Updated, "shipped"],
  ];
  for (const [name, installed, state, change, ends] of table)
    for (const how of ["setUp", "updateHelper"] as const)
      it(`${name} → ${change} by ${how}`, async () => {
        const home = await makeHome();
        const target = path.join(home.paths.plugins, HELPER_FILE);
        if (installed !== undefined) {
          await mkdir(home.paths.plugins);
          await writeFile(target, installed);
        }
        assert.equal((await inspectSetup(home.options())).helper, state);
        const answer = how === "setUp" ? (await setUp(home.options())).helper : await updateHelper(home.options());
        assert.equal(answer, change);
        const expected = ends === "shipped" ? await readFile(SHIPPED_HELPER, "utf8") : installed;
        assert.equal(await readFile(target, "utf8"), expected);
        if (ends === "shipped") assert.equal((await inspectSetup(home.options())).helper, HelperState.Current);
      });

  it("an earlier Genex's helper of the same version but other bytes is updated; a person's edit of it is kept", async () => {
    const home = await makeHome();
    await setUp(home.options());
    const target = path.join(home.paths.plugins, HELPER_FILE);
    const recordFile = path.join(home.storage, "setup", "record.json");
    // An earlier Genex shipped other bytes under the same HELPER_VERSION, and recorded them.
    const earlier = helperAt(HELPER_VERSION);
    await writeFile(target, earlier);
    const record = JSON.parse(await readFile(recordFile, "utf8"));
    record.helper.sha256 = createHash("sha256").update(earlier).digest("hex");
    await writeFile(recordFile, JSON.stringify(record));
    assert.equal((await inspectSetup(home.options())).helper, HelperState.Outdated);
    assert.deepEqual(await recordedHelper(home.storage, SHIPPED_HELPER), { version: HELPER_VERSION, current: false });
    assert.equal(await updateHelper(home.options()), HelperChange.Updated);
    assert.deepEqual(await recordedHelper(home.storage, SHIPPED_HELPER), { version: HELPER_VERSION, current: true });
    assert.equal(await readFile(target, "utf8"), await readFile(SHIPPED_HELPER, "utf8"));
    assert.equal((await inspectSetup(home.options())).helper, HelperState.Current);

    // The person's own edit, at the same version and not what Genex recorded, stays theirs.
    const edited = `${helperAt(HELPER_VERSION)}-- my change\n`;
    await writeFile(target, edited);
    assert.equal((await inspectSetup(home.options())).helper, HelperState.Current);
    assert.equal(await updateHelper(home.options()), HelperChange.Kept);
    assert.equal(await readFile(target, "utf8"), edited);
  });

  it("a current helper is not rewritten", async () => {
    const home = await makeHome();
    await setUp(home.options());
    const before = await stat(path.join(home.paths.plugins, HELPER_FILE));
    assert.equal(await updateHelper(home.options()), HelperChange.Kept);
    assert.equal((await stat(path.join(home.paths.plugins, HELPER_FILE))).ino, before.ino);
  });
});

describe("Undo Set up", () => {
  it("removes an unchanged helper and the Plugins folder Genex made, and puts the switch back", async () => {
    const home = await makeHome({ [ACCOUNT]: SETTINGS_OFF, [OTHER_ACCOUNT]: SETTINGS_WITHOUT_SWITCH });
    const before = await snapshot(home.home);
    await setUp(home.options());
    const undone = await undoSetup(home.options());
    assert.deepEqual(undone.kept, []);
    assert.deepEqual(await snapshot(home.home), before, "the home is byte for byte as it was");
    await assert.rejects(stat(recordFile(home)), "the record is gone, so Genex reads as not set up");
  });

  it("keeps a helper the person edited, a folder holding their own plugin, and a switch they changed since", async () => {
    const home = await makeHome({ [ACCOUNT]: SETTINGS_OFF, [OTHER_ACCOUNT]: SETTINGS_WITHOUT_SWITCH });
    await setUp(home.options());
    const helper = path.join(home.paths.plugins, HELPER_FILE);
    await writeFile(helper, "-- the person's edit\n");
    await writeFile(path.join(home.paths.plugins, "Theirs.rbxmx"), "their plugin");
    const changed = '{\n    "mcp-server": {\n        "enabled": true,\n        "port": 2\n    }\n}';
    await writeFile(settingsFile(home, OTHER_ACCOUNT), changed);
    const undone = await undoSetup(home.options());
    assert.equal(await readFile(helper, "utf8"), "-- the person's edit\n");
    assert.equal(await readFile(settingsFile(home, OTHER_ACCOUNT), "utf8"), changed, "not Genex's value any more");
    assert.equal(await readFile(settingsFile(home), "utf8"), SETTINGS_OFF, "still Genex's value: put back");
    assert.deepEqual(undone.kept.sort(), [helper, settingsFile(home, OTHER_ACCOUNT)].sort());
    assert.ok((await stat(home.paths.plugins)).isDirectory(), "a folder that isn't empty stays");
  });

  it("puts back the file that was there before Genex's helper", async () => {
    const home = await makeHome();
    await mkdir(home.paths.plugins);
    const target = path.join(home.paths.plugins, HELPER_FILE);
    await writeFile(target, helperAt(HELPER_VERSION - 1));
    await setUp(home.options());
    await setUp(home.options());
    await undoSetup(home.options());
    assert.equal(await readFile(target, "utf8"), helperAt(HELPER_VERSION - 1), "the first before, not Genex's own");
    assert.ok((await stat(home.paths.plugins)).isDirectory(), "a folder Genex didn't make stays");
  });

  it("never follows a link put where the helper was", async (t) => {
    const home = await makeHome();
    await setUp(home.options());
    const target = path.join(home.paths.plugins, HELPER_FILE);
    const elsewhere = path.join(home.root, "elsewhere.rbxmx");
    await writeFile(elsewhere, await readFile(SHIPPED_HELPER));
    await rm(target);
    if (!(await link(t, elsewhere, target, "file"))) return;
    const undone = await undoSetup(home.options());
    assert.deepEqual(await readFile(elsewhere), await readFile(SHIPPED_HELPER), "the link's target is untouched");
    assert.ok((await lstat(target)).isSymbolicLink());
    assert.ok(undone.kept.includes(target));
  });

  it("refuses while Studio runs, and when Genex set nothing up", async () => {
    const home = await makeHome();
    await refusedWith(undoSetup(home.options()), SetupRefusal.NotSetUp);
    await setUp(home.options());
    home.running = true;
    const before = await snapshot(home.root);
    await refusedWith(undoSetup(home.options()), SetupRefusal.StudioRunning);
    assert.deepEqual(await snapshot(home.root), before);
  });
});

describe("the switch inside one settings file", () => {
  const shapes: Array<[string, string]> = [
    ["Studio's own layout, off", SETTINGS_OFF],
    ["no switch", SETTINGS_WITHOUT_SWITCH],
    ["compact", '{"a":1,"b":[1,2,{"c":"}"}]}'],
    ["empty", "{}"],
    ["a switch that isn't an object", '{"mcp-server": true, "z": null}'],
    ["a switch with other keys", '{"mcp-server": {"port": 9, "enabled": "yes"}}'],
    ["escapes in keys and strings", '{"a\\"b": "c\\\\", "mcp-server": {}}'],
  ];
  for (const [name, text] of shapes)
    it(`turns on and back exactly: ${name}`, () => {
      const on = switchOnText(text);
      assert.ok(on, "it was not on");
      assert.equal(JSON.parse(on.text)["mcp-server"].enabled, true);
      const others = JSON.parse(text) as Record<string, unknown>;
      const after = JSON.parse(on.text) as Record<string, unknown>;
      for (const key of Object.keys(others).filter((key) => key !== "mcp-server"))
        assert.deepEqual(after[key], others[key], `${key} kept`);
      assert.equal(switchBackText(on.text, on.change), text);
      assert.equal(switchOnText(on.text), undefined, "on once is on");
    });

  it("doesn't put back a value the person changed since", () => {
    const on = switchOnText(SETTINGS_OFF);
    assert.ok(on);
    const edited = on.text.replace('"enabled": true', '"enabled": true, "port": 3');
    assert.equal(switchBackText(edited, on.change), undefined);
  });
});
