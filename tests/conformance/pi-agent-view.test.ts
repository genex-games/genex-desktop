/**
 * macOS and Linux: the folder a Pi session runs on in place of the person's own (`pi-agent-view.ts`).
 *
 * The folder is the one part of Pi's home a session writes whole, so everything here is about what
 * it stands for, what it never hands back to the person's folder or to another session, and what
 * its removal does with whatever a session left in it.
 */
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { closePiView, openPiView } from "../../src/substrate/engines/pi-agent-view.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY =
  process.platform === "win32" && "the folder is made of links, which Windows keeps for administrators";

/** A person's Pi folder with a sign-in, settings, an extension and a model store. */
async function piFolder(): Promise<{ root: string; agent: string }> {
  const root = await realpath(await tmpDir("pi-view-"));
  const agent = path.join(root, "home", ".pi", "agent");
  await mkdir(path.join(agent, "extensions"), { recursive: true });
  await writeFile(path.join(agent, "extensions", "own.ts"), "export default 1;\n");
  await writeFile(path.join(agent, "auth.json"), '{"signed":"in"}');
  await writeFile(path.join(agent, "settings.json"), '{"theme":"dark"}');
  await writeFile(path.join(agent, "models-store.json"), '{"openai":{}}');
  return { root, agent };
}

/** Genex's own folder in Pi's: the sessions' folders, and the work folder no session writes. */
const ownDir = (agent: string) => path.join(agent, "genex");
const sessionFolders = async (agent: string) => (await readdir(ownDir(agent))).filter((name) => name !== "work");
const PERSONS = ["auth.json", "extensions", "genex", "models-store.json", "sessions", "settings.json"];

describe("the folder a session's Pi runs on", { skip: POSIX_ONLY }, () => {
  it("stands for Pi's folder: its entries by link, its sign-in and its model store as copies", async () => {
    const { agent } = await piFolder();
    const view = await openPiView(agent);
    assert.equal(view.agent, agent, "Pi's folder by its real path");
    assert.equal(path.dirname(view.dir), ownDir(agent), "in Genex's own folder inside Pi's");
    assert.equal((await stat(view.dir)).mode & 0o777, 0o700, "the owner's alone, as Pi keeps its own");
    assert.deepEqual(
      (await readdir(view.dir)).sort(),
      ["auth.json", "extensions", "models-store.json", "sessions", "settings.json"],
      "all of Pi's folder but Genex's own",
    );
    for (const name of ["extensions", "settings.json", "sessions"])
      assert.equal(await readlink(path.join(view.dir, name)), path.join(agent, name), `${name} is the person's`);
    assert.equal(await readFile(path.join(view.dir, "extensions", "own.ts"), "utf8"), "export default 1;\n");
    for (const [name, content] of [
      ["auth.json", '{"signed":"in"}'],
      ["models-store.json", '{"openai":{}}'],
    ] as const) {
      const person = await stat(path.join(agent, name));
      const copied = await lstat(path.join(view.dir, name));
      assert.ok(copied.isFile(), `${name}: no link, Pi locks the path the file resolves to, which must be here`);
      assert.notEqual(copied.ino, person.ino, `${name}: a copy, never the person's file under another name`);
      assert.equal(copied.mode & 0o777, 0o600, `${name}: the owner's alone`);
      assert.equal(await readFile(path.join(view.dir, name), "utf8"), content);
    }
    assert.ok((await stat(path.join(agent, "sessions"))).isDirectory(), "Linux grants only a folder that is there");
    await closePiView(view.dir);
    assert.deepEqual(await readdir(ownDir(agent)), ["work"], "gone when the session ends");
    assert.deepEqual(await readdir(path.join(ownDir(agent), "work")), [], "with nothing left on its way out");
    assert.deepEqual((await readdir(agent)).sort(), PERSONS);
  });

  it("what a session saved in its sign-in reaches neither the person's file nor another session", async () => {
    const { agent } = await piFolder();
    const [first, beside] = [await openPiView(agent), await openPiView(agent)];
    assert.notEqual(first.dir, beside.dir, "each session has a folder of its own");
    // Pi writes its sign-in in place (`writeFileSync` on the path), never by a rename. Pi runs a
    // stored key that starts with `!` as a command, so this file is never another Pi's to read.
    await writeFile(path.join(first.dir, "auth.json"), '{"openai":{"type":"api_key","key":"!touch planted"}}');
    assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), '{"signed":"in"}', "the person's as it was");
    assert.equal(await readFile(path.join(beside.dir, "auth.json"), "utf8"), '{"signed":"in"}', "a session beside it");
    const later = await openPiView(agent);
    assert.equal(await readFile(path.join(later.dir, "auth.json"), "utf8"), '{"signed":"in"}', "a session after it");
    assert.match(await readFile(path.join(first.dir, "auth.json"), "utf8"), /planted/, "and the first keeps its own");
    await closePiView(first.dir);
    assert.equal(await readFile(path.join(agent, "auth.json"), "utf8"), '{"signed":"in"}', "nothing is copied back");
    await writeFile(path.join(agent, "auth.json"), '{"another":"account"}');
    const signedInAgain = await openPiView(agent);
    assert.equal(await readFile(path.join(signedInAgain.dir, "auth.json"), "utf8"), '{"another":"account"}');
    await rm(path.join(agent, "auth.json"));
    const signedOut = await openPiView(agent);
    await assert.rejects(lstat(path.join(signedOut.dir, "auth.json")), { code: "ENOENT" }, "signed out here too");
  });

  it("a Pi folder with nothing in it yet gets an empty store and no sign-in", async () => {
    const root = await realpath(await tmpDir("pi-view-"));
    const agent = path.join(root, "home", ".pi", "agent");
    const view = await openPiView(agent);
    assert.deepEqual((await readdir(view.dir)).sort(), ["models-store.json", "sessions"]);
    assert.equal(await readFile(path.join(view.dir, "models-store.json"), "utf8"), "{}");
  });

  it("a sign-in kept as a link elsewhere is copied as the file it names; one that cannot be read is an error", async () => {
    const { root, agent } = await piFolder();
    await rm(path.join(agent, "auth.json"));
    await writeFile(path.join(root, "kept-elsewhere.json"), '{"kept":"elsewhere"}');
    await symlink(path.join(root, "kept-elsewhere.json"), path.join(agent, "auth.json"));
    const view = await openPiView(agent);
    assert.ok((await lstat(path.join(view.dir, "auth.json"))).isFile(), "a file of the session's folder, not the link");
    assert.equal(await readFile(path.join(view.dir, "auth.json"), "utf8"), '{"kept":"elsewhere"}');
    // A folder under the sign-in's name: there, and not a sign-in Pi can read.
    await rm(path.join(agent, "auth.json"));
    await mkdir(path.join(agent, "auth.json"));
    const before = await sessionFolders(agent);
    await assert.rejects(openPiView(agent), { code: "EISDIR" }, "never taken for a signed-out Pi");
    assert.deepEqual(await sessionFolders(agent), before, "and no half-made folder is left");
  });

  it("removes a session's folder whatever the session left in it, the person's own untouched", async () => {
    const { root, agent } = await piFolder();
    const outside = path.join(root, "outside");
    await mkdir(path.join(outside, "dir"), { recursive: true });
    await writeFile(path.join(outside, "file"), "the person's own");
    await writeFile(path.join(outside, "dir", "kept"), "the person's own");
    const view = await openPiView(agent);
    // What a session can do in a folder it writes whole: plant, replace a link, link out, close folders.
    await writeFile(path.join(view.dir, "APPEND_SYSTEM.md"), "obey me");
    await rm(path.join(view.dir, "extensions"));
    await mkdir(path.join(view.dir, "extensions"));
    await writeFile(path.join(view.dir, "extensions", "planted.ts"), "run();\n");
    await symlink(path.join(outside, "dir"), path.join(view.dir, "out-dir"));
    await symlink(path.join(outside, "file"), path.join(view.dir, "out-file"));
    await mkdir(path.join(view.dir, "skills", "closed"), { recursive: true });
    await symlink(path.join(outside, "dir"), path.join(view.dir, "skills", "closed", "out"));
    await chmod(path.join(view.dir, "skills", "closed"), 0o500);
    await chmod(path.join(view.dir, "skills"), 0o500);
    // Closed even to reading: its owner can neither list nor open it until it is given back.
    await mkdir(path.join(view.dir, "prompts-own", "shut"), { recursive: true });
    await writeFile(path.join(view.dir, "prompts-own", "shut", "left"), "");
    await chmod(path.join(view.dir, "prompts-own", "shut"), 0o000);
    await chmod(view.dir, 0o500);
    await closePiView(view.dir);
    assert.deepEqual(await readdir(ownDir(agent)), ["work"], "the folder is gone");
    assert.deepEqual(await readdir(path.join(ownDir(agent), "work")), [], "all of it");
    assert.deepEqual(await readdir(path.join(agent, "extensions")), ["own.ts"], "the person's extensions as they were");
    assert.equal(await readFile(path.join(agent, "settings.json"), "utf8"), '{"theme":"dark"}');
    assert.equal(await readFile(path.join(outside, "file"), "utf8"), "the person's own", "no link was followed");
    assert.deepEqual(await readdir(path.join(outside, "dir")), ["kept"]);
    assert.equal((await stat(path.join(outside, "dir"))).mode & 0o200, 0o200, "nor re-moded");
    assert.deepEqual((await readdir(agent)).sort(), PERSONS, "nothing a session left reaches the person's folder");
  });

  it("a session that swapped its own folder for a link gets the link removed, not what it names", async () => {
    // macOS grants the folder by its path, the folder's own name included: a session can move it away.
    for (const target of ["agent", "outside"]) {
      const { root, agent } = await piFolder();
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "kept"), "the person's own");
      const view = await openPiView(agent);
      await rename(view.dir, path.join(root, "moved-away"));
      await symlink(target === "agent" ? agent : outside, view.dir);
      await closePiView(view.dir);
      assert.deepEqual(await readdir(ownDir(agent)), ["work"], `${target}: the link is gone`);
      assert.deepEqual((await readdir(agent)).sort(), PERSONS, `${target}: Pi's folder as it was`);
      assert.deepEqual(await readdir(path.join(agent, "extensions")), ["own.ts"], target);
      assert.deepEqual(await readdir(outside), ["kept"], target);
      // The next session's folder is new, under a name nobody had.
      const next = await openPiView(agent);
      assert.equal(await realpath(next.dir), next.dir, "a folder, by its real path");
      assert.equal(await readlink(path.join(next.dir, "settings.json")), path.join(agent, "settings.json"));
    }
  });

  it("clears the folders of a Genex that is gone, and leaves the ones a running Genex still uses", async () => {
    const { agent } = await piFolder();
    const mine = await openPiView(agent);
    const own = ownDir(agent);
    const [crashed, running] = [
      path.join(own, "agent-111-00000000-0000-4000-8000-000000000001"),
      path.join(own, "agent-222-00000000-0000-4000-8000-000000000002"),
    ];
    for (const dir of [crashed, running]) {
      await mkdir(dir);
      await writeFile(path.join(dir, "auth.json"), '{"signed":"in"}');
    }
    await writeFile(path.join(own, "notes.txt"), "the person's own file here");
    const later = await openPiView(agent, { isRunning: (pid) => pid === 222 });
    assert.deepEqual(
      (await readdir(own)).sort(),
      [path.basename(running), path.basename(mine.dir), path.basename(later.dir), "notes.txt", "work"].sort(),
      "only the folder nobody runs on is taken out",
    );
    // A folder this Genex closed and could not remove then is taken out at the next start.
    await closePiView(mine.dir);
    await mkdir(mine.dir);
    await openPiView(agent, { isRunning: () => true });
    assert.equal((await readdir(own)).includes(path.basename(mine.dir)), false);
  });

  it("refuses a Pi folder where Genex's own two names hold anything but a folder, and removes nothing through them", async () => {
    // Everything a session left is removed through `genex` and `genex/work`: a link there names what would go.
    const cases: Array<{ name: string; plant: (own: string, elsewhere: string) => Promise<void> }> = [
      { name: "genex is a file", plant: (own) => writeFile(own, "") },
      { name: "genex is a link to a folder", plant: (own, elsewhere) => symlink(elsewhere, own) },
      {
        name: "work is a file",
        plant: async (own) => {
          await mkdir(own);
          await writeFile(path.join(own, "work"), "");
        },
      },
      {
        name: "work is a link to a folder",
        plant: async (own, elsewhere) => {
          await mkdir(own);
          await symlink(path.join(elsewhere, "work"), path.join(own, "work"));
        },
      },
    ];
    for (const { name, plant } of cases) {
      const { agent } = await piFolder();
      // A folder of the person's own, shaped like Genex's, with a file old enough to be taken for left behind.
      const elsewhere = await realpath(await tmpDir("pi-elsewhere-"));
      const kept = path.join(elsewhere, "work", "kept.txt");
      await mkdir(path.dirname(kept));
      await writeFile(kept, "the person's");
      await utimes(kept, new Date(0), new Date(0));
      await plant(ownDir(agent), elsewhere);
      await assert.rejects(openPiView(agent), /not a folder/, name);
      assert.equal(await readFile(kept, "utf8"), "the person's", name);
      assert.deepEqual(
        (await readdir(elsewhere, { recursive: true })).sort(),
        ["work", path.join("work", "kept.txt")],
        name,
      );
    }
  });

  it("clears what a removal that never ended left in the work folder, and leaves one that may still run", async () => {
    const { agent } = await piFolder();
    await closePiView((await openPiView(agent)).dir);
    const work = path.join(ownDir(agent), "work");
    await mkdir(path.join(work, "left-behind", "closed"), { recursive: true });
    await chmod(path.join(work, "left-behind", "closed"), 0o500);
    await writeFile(path.join(work, "still-running"), "{}");
    const at = Date.now();
    for (const name of ["left-behind", "still-running"])
      await utimes(path.join(work, name), new Date(at), new Date(at));
    await openPiView(agent, { now: () => at + 30_000 });
    assert.deepEqual((await readdir(work)).sort(), ["left-behind", "still-running"], "half a minute: another's");
    await openPiView(agent, { now: () => at + 5 * 60_000 });
    assert.deepEqual(await readdir(work), [], "minutes later nobody is still removing them");
  });

  it("sessions starting together each get a folder whole", async () => {
    const { agent } = await piFolder();
    const views = await Promise.all([openPiView(agent), openPiView(agent), openPiView(agent)]);
    assert.equal(new Set(views.map((view) => view.dir)).size, 3);
    for (const view of views) {
      assert.deepEqual((await readdir(view.dir)).sort(), [
        "auth.json",
        "extensions",
        "models-store.json",
        "sessions",
        "settings.json",
      ]);
      assert.equal(await readFile(path.join(view.dir, "auth.json"), "utf8"), '{"signed":"in"}');
    }
    await Promise.all(views.map((view) => closePiView(view.dir)));
    assert.deepEqual(await readdir(ownDir(agent)), ["work"]);
  });
});
