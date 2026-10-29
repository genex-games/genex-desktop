import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addAttachedFiles,
  addToBoard,
  DropTone,
  dropLine,
  heldFiles,
  leftOutLine,
  MAX_ATTACHED_FILES,
  messageWithFiles,
} from "../../src/renderer/ui/composer-drop.ts";
import { MAX_REFERENCE_FRAMES } from "../../src/renderer/reference-frames.ts";

const item = (type: string) => ({ kind: "file", type });
const frame = (data: string) => ({ label: data, mimeType: "image/png", data });
const frames = (count: number, prefix = "f") => Array.from({ length: count }, (_, i) => frame(`${prefix}${i}`));
const file = (name: string, dir = "/Users/me/Downloads") => ({ name, path: `${dir}/${name}` });
const files = (count: number) => Array.from({ length: count }, (_, i) => file(`notes-${i}.txt`));
const empty = { pictures: 0, files: 0 };

test("a drag holds files only when it carries some: pictures counted apart from the rest", () => {
  assert.equal(heldFiles(undefined), null);
  assert.equal(heldFiles([{ kind: "string", type: "text/plain" }]), null, "dragged text is not a file");
  assert.deepEqual(heldFiles([item("image/png"), item("image/jpeg"), item("application/zip"), item("")]), {
    pictures: 2,
    others: 2,
  });
});

test("the prompt bar's line while files are held: any file goes in, orange only past the limits", () => {
  const cases = [
    { held: { pictures: 1, others: 0 }, board: empty, tone: DropTone.Takes, words: "Drop to add 1 picture" },
    { held: { pictures: 2, others: 0 }, board: empty, tone: DropTone.Takes, words: "Drop to add 2 pictures" },
    { held: { pictures: 0, others: 1 }, board: empty, tone: DropTone.Takes, words: "Drop to add 1 file" },
    { held: { pictures: 2, others: 1 }, board: empty, tone: DropTone.Takes, words: "Drop to add 3 files" },
    {
      held: { pictures: 14, others: 0 },
      board: empty,
      tone: DropTone.Refuses,
      words: "Room for 12 pictures, 2 will stay out",
    },
    {
      held: { pictures: 0, others: 2 },
      board: { pictures: 0, files: MAX_ATTACHED_FILES - 1 },
      tone: DropTone.Refuses,
      words: "Room for 1 file, 1 will stay out",
    },
    {
      held: { pictures: 1, others: 0 },
      board: { pictures: MAX_REFERENCE_FRAMES, files: 0 },
      tone: DropTone.Refuses,
      words: "12 pictures at most",
    },
  ];
  for (const { held, board, tone, words } of cases)
    assert.deepEqual(dropLine(held, board), { tone, words }, JSON.stringify({ held, board }));
});

test("a drop fills the board up to its limit, never twice with the same picture, and counts what stays out", () => {
  const current = frames(10);
  const added = addToBoard(current, [frame("f1"), ...frames(4, "new")]);
  assert.deepEqual(
    added.frames.map((f) => f.data),
    [...current.map((f) => f.data), "new0", "new1"],
  );
  assert.equal(added.overLimit, 2);
  assert.deepEqual(addToBoard([], frames(2)), { frames: frames(2), overLimit: 0 });
});

test("a file goes with the message once, however often it is dropped, up to the limit", () => {
  const first = addAttachedFiles([], [file("notes.txt"), file("notes.txt"), file("notes.txt", "/Users/me/Desktop")]);
  assert.deepEqual(
    first.files.map((f) => f.path),
    ["/Users/me/Downloads/notes.txt", "/Users/me/Desktop/notes.txt"],
    "the same name in two folders is two files",
  );
  const full = addAttachedFiles(files(MAX_ATTACHED_FILES - 1), [file("a.glb"), file("b.mp3")]);
  assert.equal(full.files.length, MAX_ATTACHED_FILES);
  assert.equal(full.overLimit, 1);
});

test("what a drop left out reads as one plain line, or nothing when everything went in", () => {
  const none = { overPictures: 0, overFiles: 0, unlinked: [] };
  assert.equal(leftOutLine(none), null);
  assert.equal(leftOutLine({ ...none, overPictures: 2 }), "2 pictures left out, 12 at most");
  assert.equal(leftOutLine({ ...none, overFiles: 1 }), "1 file left out, 12 at most");
  assert.equal(leftOutLine({ ...none, unlinked: ["clip.bin"] }), "clip.bin couldn’t be added");
  assert.equal(leftOutLine({ ...none, unlinked: ["a", "b"] }), "2 files couldn’t be added");
  assert.equal(leftOutLine({ overPictures: 1, overFiles: 0, unlinked: ["a"] }), "2 files didn’t go in");
});

test("a message sends its files as links after its words, a path with a space as a file URL", () => {
  assert.equal(messageWithFiles("Use this", []), "Use this");
  assert.equal(
    messageWithFiles("Use these", [file("notes.txt"), file("level plan.pdf")]),
    "Use these\n\n/Users/me/Downloads/notes.txt\nfile:///Users/me/Downloads/level%20plan.pdf",
  );
  assert.equal(messageWithFiles("", [file("notes.txt")]), "/Users/me/Downloads/notes.txt", "a file alone is a message");
});
