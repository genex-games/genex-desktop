/**
 * Choose file for plugin panels: `studioPlugin.chooseFile({ title, extensions })` opens Studio's
 * own native file picker and answers the chosen file's path, or null. The request is read by one
 * shared reader, in the renderer before it leaves the panel host and in main again before the
 * dialog opens; main also checks that a panel of an enabled plugin asks and that the answer is a
 * real file of a listed type. Every refusal opens no dialog. The dialog is a recorder here, so
 * nothing native opens.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createPluginFilePicker,
  type PickerPlugin,
  type PluginFileDialogOptions,
} from "../../src/main/core/plugin-file-picker.ts";
import { PluginFileProblem, pluginFileRequest, readPluginFileRequest } from "../../src/shared/plugin-file-request.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LINKS = process.platform === "win32" && "links need privileges on Windows";
const REQUEST = { title: "Choose a project", extensions: ["uproject"] };
const WINDOW = { id: "studio-window" };
const UNREAL: PickerPlugin = {
  enabled: true,
  removed: false,
  manifest: {
    id: "unreal",
    name: "Unreal Editor",
    panels: [{ id: "setup", title: "Set up Unreal", file: "panel.html", placement: "settings" }],
  },
};

type DialogAnswer = { canceled: boolean; filePaths: string[] };

/** A picker over a recorded dialog that answers `answer` for every open. */
function picker(
  answer: () => DialogAnswer | Promise<DialogAnswer>,
  options: { plugins?: PickerPlugin[]; window?: typeof WINDOW | null } = {},
) {
  const opened: Array<{ window: typeof WINDOW; options: PluginFileDialogOptions }> = [];
  const choose = createPluginFilePicker({
    window: () => (options.window === undefined ? WINDOW : options.window),
    showOpenDialog: async (window, dialogOptions) => {
      opened.push({ window, options: dialogOptions });
      return answer();
    },
    plugins: () => options.plugins ?? [UNREAL],
  });
  return { choose, opened };
}

const sparse: string[] = [];
sparse[1] = "uproject";

/** Requests a panel must not get a picker for, and why each is refused. */
const HOSTILE_REQUESTS: Array<[string, unknown, PluginFileProblem]> = [
  ["nothing", undefined, PluginFileProblem.NotAnObject],
  ["null", null, PluginFileProblem.NotAnObject],
  ["a string", "uproject", PluginFileProblem.NotAnObject],
  ["an array", ["uproject"], PluginFileProblem.NotAnObject],
  ["a starting folder", { ...REQUEST, defaultPath: "/etc" }, PluginFileProblem.UnknownField],
  ["several files", { ...REQUEST, properties: ["multiSelections"] }, PluginFileProblem.UnknownField],
  ["no title", { extensions: ["uproject"] }, PluginFileProblem.BadTitle],
  ["an empty title", { ...REQUEST, title: "" }, PluginFileProblem.BadTitle],
  ["a blank title", { ...REQUEST, title: "   " }, PluginFileProblem.BadTitle],
  ["a title that is no string", { ...REQUEST, title: 7 }, PluginFileProblem.BadTitle],
  ["a title of 81 characters", { ...REQUEST, title: "x".repeat(81) }, PluginFileProblem.BadTitle],
  ["a title of two lines", { ...REQUEST, title: "Choose\nStudio's password file" }, PluginFileProblem.BadTitle],
  ["a title with a control character", { ...REQUEST, title: "Choose\u0007" }, PluginFileProblem.BadTitle],
  ["a title that reverses itself", { ...REQUEST, title: "Choose \u202etcejorp" }, PluginFileProblem.BadTitle],
  ["no extensions", { title: REQUEST.title }, PluginFileProblem.BadExtensions],
  ["extensions that are no list", { ...REQUEST, extensions: "uproject" }, PluginFileProblem.BadExtensions],
  ["an empty list", { ...REQUEST, extensions: [] }, PluginFileProblem.BadExtensions],
  ["five extensions", { ...REQUEST, extensions: ["a", "b", "c", "d", "e"] }, PluginFileProblem.BadExtensions],
  ["an extension with its dot", { ...REQUEST, extensions: [".uproject"] }, PluginFileProblem.BadExtensions],
  ["any file", { ...REQUEST, extensions: ["*"] }, PluginFileProblem.BadExtensions],
  ["an uppercase extension", { ...REQUEST, extensions: ["UPROJECT"] }, PluginFileProblem.BadExtensions],
  ["an extension of 11 characters", { ...REQUEST, extensions: ["x".repeat(11)] }, PluginFileProblem.BadExtensions],
  ["an extension with a path", { ...REQUEST, extensions: ["../ssh"] }, PluginFileProblem.BadExtensions],
  ["an extension with a slash", { ...REQUEST, extensions: ["a/b"] }, PluginFileProblem.BadExtensions],
  ["an empty extension", { ...REQUEST, extensions: [""] }, PluginFileProblem.BadExtensions],
  ["an extension that is no string", { ...REQUEST, extensions: [7] }, PluginFileProblem.BadExtensions],
  ["the same extension twice", { ...REQUEST, extensions: ["png", "png"] }, PluginFileProblem.BadExtensions],
  ["a list with a hole", { ...REQUEST, extensions: sparse }, PluginFileProblem.BadExtensions],
];

/** Who must not get a picker: a caller that is no panel of an enabled plugin. */
const HOSTILE_CALLERS: Array<[string, unknown, PickerPlugin[]]> = [
  ["no plugin id", undefined, [UNREAL]],
  ["an id that is no string", 7, [UNREAL]],
  ["an unknown plugin", "genex", [UNREAL]],
  ["a disabled plugin", "unreal", [{ ...UNREAL, enabled: false }]],
  ["a removed plugin", "unreal", [{ ...UNREAL, removed: true }]],
  ["a plugin with no panel", "unreal", [{ ...UNREAL, manifest: { ...UNREAL.manifest, panels: [] } }]],
];

describe("a Choose file request", () => {
  it("is read into a clean copy of its title and extensions", () => {
    const extensions = ["uproject", "uplugin"];
    const read = readPluginFileRequest({ title: "  Choose a project ", extensions });
    assert.deepEqual(read, { request: { title: "Choose a project", extensions: ["uproject", "uplugin"] } });
    assert.ok("request" in read);
    assert.notEqual(read.request.extensions, extensions, "the panel's own list is not kept");
    assert.deepEqual(
      readPluginFileRequest({ title: "x".repeat(80), extensions: ["a", "b", "c", "d"] }),
      { request: { title: "x".repeat(80), extensions: ["a", "b", "c", "d"] } },
      "80 characters and four extensions are the most",
    );
  });

  for (const [label, value, problem] of HOSTILE_REQUESTS)
    it(`with ${label} is refused, in the renderer and in main, and opens no picker`, async () => {
      assert.deepEqual(readPluginFileRequest(value), { problem });
      assert.throws(() => pluginFileRequest(value));
      const { choose, opened } = picker(() => ({ canceled: false, filePaths: ["/never/asked.uproject"] }));
      await assert.rejects(choose("unreal", value));
      assert.deepEqual(opened, []);
    });
});

describe("Choose file in main", () => {
  // A panel never names the folder the picker starts in, nor asks for more than one file.
  it("opens one file picker over Studio's window, named for the plugin, for the listed types", async () => {
    const dir = await tmpDir("plugin-file-picker-");
    const project = path.join(dir, "Racer.uproject");
    await writeFile(project, "{}");
    const { choose, opened } = picker(() => ({ canceled: false, filePaths: [project] }));
    assert.equal(
      await choose("unreal", { title: "Choose a project", extensions: ["uproject", "uplugin"] }),
      await realpath(project),
    );
    assert.deepEqual(opened, [
      {
        window: WINDOW,
        options: {
          title: "Unreal Editor: Choose a project",
          message: "Unreal Editor: Choose a project",
          buttonLabel: "Choose",
          properties: ["openFile"],
          filters: [{ name: ".uproject, .uplugin", extensions: ["uproject", "uplugin"] }],
        },
      },
    ]);
  });

  it("answers null when the person cancels", async () => {
    for (const answer of [
      { canceled: true, filePaths: [] },
      { canceled: true, filePaths: ["/ignored/Racer.uproject"] },
      { canceled: false, filePaths: [] },
    ]) {
      const { choose, opened } = picker(() => answer);
      assert.equal(await choose("unreal", REQUEST), null, JSON.stringify(answer));
      assert.equal(opened.length, 1);
    }
  });
});

describe("Choose file in main refuses", () => {
  for (const [label, id, plugins] of HOSTILE_CALLERS)
    it(`${label} and opens no picker`, async () => {
      const { choose, opened } = picker(() => ({ canceled: false, filePaths: ["/never/asked.uproject"] }), {
        plugins,
      });
      await assert.rejects(choose(id, REQUEST));
      assert.deepEqual(opened, []);
    });

  it("while Studio's window is closed and opens no picker", async () => {
    const { choose, opened } = picker(() => ({ canceled: true, filePaths: [] }), { window: null });
    await assert.rejects(choose("unreal", REQUEST));
    assert.deepEqual(opened, []);
  });

  it("a second picker while one is open", async () => {
    let finish: (answer: DialogAnswer) => void = () => {};
    // The first picker stays open until the test answers it; any later one answers at once.
    const { choose, opened } = picker(() =>
      opened.length > 1
        ? { canceled: true, filePaths: [] }
        : new Promise<DialogAnswer>((resolve) => {
            finish = resolve;
          }),
    );
    const first = choose("unreal", REQUEST);
    await assert.rejects(choose("unreal", REQUEST), "a second picker while the first is open");
    assert.equal(opened.length, 1);
    finish({ canceled: true, filePaths: [] });
    assert.equal(await first, null);
    assert.equal(await choose("unreal", REQUEST), null);
    assert.equal(opened.length, 2, "the next one opens once the first is answered");
  });
});

describe("Choose file's answer", () => {
  it("is a chosen file's real path, whatever case its extension is in", async () => {
    const dir = await tmpDir("plugin-file-picker-");
    const upper = path.join(dir, "Racer.UPROJECT");
    await writeFile(upper, "{}");
    const { choose } = picker(() => ({ canceled: false, filePaths: [upper] }));
    assert.equal(await choose("unreal", REQUEST), await realpath(upper));
  });

  it("for a link is the file it leads to", { skip: LINKS }, async () => {
    const dir = await tmpDir("plugin-file-picker-");
    const real = path.join(dir, "real", "Racer.uproject");
    await mkdir(path.dirname(real));
    await writeFile(real, "{}");
    const link = path.join(dir, "Shortcut.uproject");
    await symlink(real, link);
    const { choose } = picker(() => ({ canceled: false, filePaths: [link] }));
    assert.equal(await choose("unreal", REQUEST), await realpath(real));
  });

  describe("is refused when it is not a file of a listed type", () => {
    const ANSWERS: Array<[string, (dir: string) => Promise<string>, string | false]> = [
      // On Windows a typed name gets past the dialog's filter.
      ["a file of another type", (dir) => file(dir, "notes.txt"), false],
      ["a file with no extension", (dir) => file(dir, "uproject"), false],
      ["a folder named like a project", (dir) => folder(dir, "Racer.uproject"), false],
      ["a file that is not there", async (dir) => path.join(dir, "Gone.uproject"), false],
      ["a relative path", async () => "Racer.uproject", false],
      ["a link named like a project that leads to another file", (dir) => link(dir, "notes.txt"), LINKS],
      ["a link named like a project that leads to a folder", (dir) => link(dir, "folder"), LINKS],
    ];
    for (const [label, make, skip] of ANSWERS)
      it(label, { skip }, async () => {
        const dir = await tmpDir("plugin-file-picker-");
        const answer = await make(dir);
        const before = await readdir(dir, { recursive: true });
        const { choose, opened } = picker(() => ({ canceled: false, filePaths: [answer] }));
        await assert.rejects(choose("unreal", REQUEST));
        assert.equal(opened.length, 1);
        assert.deepEqual(await readdir(dir, { recursive: true }), before, "nothing was written");
      });
  });
});

async function file(dir: string, name: string): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, "secret");
  return target;
}

async function folder(dir: string, name: string): Promise<string> {
  const target = path.join(dir, name);
  await mkdir(target);
  return target;
}

/** A link named `Racer.uproject` to a file or folder named `target` beside it. */
async function link(dir: string, target: string): Promise<string> {
  const destination = path.join(dir, target);
  if (target === "folder") await mkdir(destination);
  else await writeFile(destination, "secret");
  const named = path.join(dir, "Racer.uproject");
  await symlink(destination, named);
  return named;
}
