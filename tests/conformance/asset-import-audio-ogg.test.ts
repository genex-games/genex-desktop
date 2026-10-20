/**
 * The `audio-to-ogg` import step (game systems AU-6, owner call AQ2): an Opus or AAC file becomes
 * Ogg Vorbis at 48 kHz through the pinned host tool `genex-audio-ogg`. The container check runs
 * before anything is written, the tool is held to its per-platform pin, it runs with only its
 * work folder's input and output names, and what it writes must be Ogg Vorbis at 48 kHz. The
 * plumbing rows run a stand-in tool (a shell script that writes the 48 kHz Vorbis fixture or
 * misbehaves). The real encoder's rows run where it is pinned for this platform (through
 * `convertAsset`), or where a checkout built it into `.studio-dev/tools/` (through the step, held to
 * that build's own size and sha256); elsewhere they are skipped NOT MEASURED.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  AUDIO_OGG_TOOL,
  AUDIO_OGG_TOOL_PINS,
  AudioOggFault,
  AudioSource,
  type AudioToolRun,
  audioToOgg,
  locateAudioTool,
  runAudioTool,
  sniffAudio,
  vorbisHeader,
} from "../../src/substrate/asset-import/audio-ogg.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { AssetImportRefusal, ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { IMPORTER_TOOLS_ENV } from "../../src/substrate/asset-import/decoders.ts";
import { tmpDir } from "../helpers/tmp.ts";

const IMPORT = fileURLToPath(new URL("../fixtures/asset-import/", import.meta.url));
const fixture = async (name: string) => new Uint8Array(await readFile(path.join(IMPORT, name)));
const POSIX = process.platform !== "win32";
const PLATFORM_KEY = `${process.platform}-${process.arch}`;
const PINNED = Object.hasOwn(AUDIO_OGG_TOOL_PINS, PLATFORM_KEY);
/** Where a checkout's own build of the tool sits (`locateAudioTool`'s development folder). */
const LOCAL_TOOLS = fileURLToPath(new URL("../../.studio-dev/tools/", import.meta.url));
const LOCAL_TOOL = path.join(LOCAL_TOOLS, AUDIO_OGG_TOOL.folder, AUDIO_OGG_TOOL.name);
const SKIP_REAL_TOOL =
  PINNED || (POSIX && existsSync(LOCAL_TOOL))
    ? false
    : `NOT MEASURED: no ${AUDIO_OGG_TOOL.name} pin for ${PLATFORM_KEY} and no build in .studio-dev/tools/`;

const u32be = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const fourcc = (code: string) => [...code].map((char) => char.charCodeAt(0));
/** An ISO BMFF box: size, type, payload. */
const box = (type: string, ...payload: number[][]) => {
  const body = payload.flat();
  return [...u32be(8 + body.length), ...fourcc(type), ...body];
};
/** A `hdlr` box naming `handler` (version and flags, pre_defined, handler_type, reserved, name). */
const hdlr = (handler: string) => box("hdlr", [0, 0, 0, 0], [0, 0, 0, 0], fourcc(handler), new Array(12).fill(0), [0]);
/** A `stsd` box holding one sample entry of type `entry`. */
const stsd = (entry: string) => box("stsd", [0, 0, 0, 0], u32be(1), box(entry, new Array(28).fill(0)));
/** A track of `handler` whose sample entry is `entry`. */
const trak = (handler: string, entry: string) =>
  box("trak", box("mdia", hdlr(handler), box("minf", box("stbl", stsd(entry)))));
const ftyp = box("ftyp", fourcc("M4A "), u32be(0), fourcc("isom"));
const mdat = box("mdat", [1, 2, 3, 4]);
const mp4 = (...parts: number[][]) => new Uint8Array(parts.flat());

/** ADTS frames: a 7-byte header (no CRC, AAC LC, 48 kHz, mono) and `payload` bytes each. */
function adts(frames: number, payload = 16): Uint8Array {
  const length = 7 + payload;
  const frame = [
    0xff,
    0xf1,
    (1 << 6) | (3 << 2),
    (1 << 6) | ((length >> 11) & 0x03),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
    ...new Array(payload).fill(0x21),
  ];
  return new Uint8Array(Array.from({ length: frames }, () => frame).flat());
}

/** A stand-in tool: a POSIX shell script with `body` after the shebang, executable. */
async function standIn(body: string): Promise<string> {
  const dir = await tmpDir("audio-ogg-tool-");
  const file = path.join(dir, AUDIO_OGG_TOOL.name);
  await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
/** A stand-in that writes `fixtureName` where the step asked ($4: `--from <source> <input> <output>`). */
const writing = (fixtureName: string) => standIn(`/bin/cp '${path.join(IMPORT, fixtureName)}' "$4"`);

/** A run that records its calls and never starts anything. */
function recordingRun(): { run: AudioToolRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: AudioToolRun = async (tool, args) => {
    calls.push([tool, ...args]);
    return { code: 0, timedOut: false };
  };
  return { calls, run };
}

describe("the container check before anything runs", () => {
  it("the Opus fixture is an Ogg Opus stream; AAC as ADTS frames and as an MP4 audio track", async () => {
    assert.deepEqual(sniffAudio(await fixture("tone.opus"), "opus"), { ok: true, source: AudioSource.OggOpus });
    assert.deepEqual(sniffAudio(adts(3), "aac"), { ok: true, source: AudioSource.Adts });
    assert.deepEqual(sniffAudio(mp4(ftyp, box("moov", trak("soun", "mp4a")), mdat), "m4a"), {
      ok: true,
      source: AudioSource.Mp4,
    });
  });

  it("hostile and damaged inputs: a typed fault each", async () => {
    const opus = await fixture("tone.opus");
    const vorbis = await fixture("tone.ogg");
    const rows: Array<[string, Uint8Array, string, AudioOggFault]> = [
      ["empty Opus", new Uint8Array(), "opus", AudioOggFault.Truncated],
      ["Opus cut inside its first page header", opus.slice(0, 20), "opus", AudioOggFault.Truncated],
      ["Opus cut inside OpusHead", opus.slice(0, 40), "opus", AudioOggFault.Truncated],
      ["Opus cut inside its last page", opus.slice(0, opus.length - 5), "opus", AudioOggFault.Truncated],
      ["Opus with only its header page", opus.slice(0, 47), "opus", AudioOggFault.Truncated],
      ["Ogg Vorbis named .opus", vorbis, "opus", AudioOggFault.NotOpus],
      ["WAV named .opus", await fixture("tone.wav"), "opus", AudioOggFault.NotOgg],
      ["empty AAC", new Uint8Array(), "aac", AudioOggFault.Truncated],
      ["ADTS cut inside its last frame", adts(3).slice(0, 60), "aac", AudioOggFault.Truncated],
      ["ADTS cut inside a header", adts(2).slice(0, 26), "aac", AudioOggFault.Truncated],
      ["MP3 named .aac", await fixture("tone.mp3"), "aac", AudioOggFault.NotAdts],
      ["MP4 named .aac", mp4(ftyp, box("moov", trak("soun", "mp4a")), mdat), "aac", AudioOggFault.NotAdts],
      [
        "M4A with no audio track",
        mp4(ftyp, box("moov", trak("vide", "avc1")), mdat),
        "m4a",
        AudioOggFault.NoAudioTrack,
      ],
      ["M4A with no track at all", mp4(ftyp, box("moov"), mdat), "m4a", AudioOggFault.NoAudioTrack],
      ["M4A whose audio is ALAC", mp4(ftyp, box("moov", trak("soun", "alac")), mdat), "m4a", AudioOggFault.NotAac],
      ["M4A with no movie box", mp4(ftyp, mdat), "m4a", AudioOggFault.Truncated],
      ["M4A with no media data", mp4(ftyp, box("moov", trak("soun", "mp4a"))), "m4a", AudioOggFault.Truncated],
      [
        "M4A whose box runs past the end",
        mp4(ftyp, [...u32be(4096), ...fourcc("moov")]),
        "m4a",
        AudioOggFault.Truncated,
      ],
      ["M4A box shorter than its header", mp4(ftyp, [...u32be(3), ...fourcc("moov")]), "m4a", AudioOggFault.NotMp4],
      ["M4A not starting with ftyp", mp4(box("moov", trak("soun", "mp4a")), mdat), "m4a", AudioOggFault.NotMp4],
      ["Ogg named .m4a", vorbis, "m4a", AudioOggFault.NotMp4],
      ["a format the step does not convert", vorbis, "ogg", AudioOggFault.UnknownExtension],
    ];
    for (const [label, bytes, ext, fault] of rows) {
      const found = sniffAudio(bytes, ext);
      assert.deepEqual(found, { ok: false, fault }, label);
    }
  });
});

describe("the tool's pin", () => {
  it("a platform with no pin, a missing file, a link and other bytes are refused, typed", async () => {
    const tools = await tmpDir("audio-ogg-tools-");
    const env = { [IMPORTER_TOOLS_ENV]: tools };
    const folder = path.join(tools, AUDIO_OGG_TOOL.folder);
    await mkdir(folder);
    const file = path.join(folder, AUDIO_OGG_TOOL.name);
    const pins = { [PLATFORM_KEY]: { sha256: "0".repeat(64), bytes: 4 } };
    assert.deepEqual(await locateAudioTool({ env, pins: {} }), { ok: false, fault: AudioOggFault.ToolUnpinned });
    assert.deepEqual(await locateAudioTool({ env, pins }), { ok: false, fault: AudioOggFault.ToolMissing });
    await writeFile(path.join(tools, "elsewhere"), "abcd");
    await symlink(path.join(tools, "elsewhere"), file);
    assert.deepEqual(await locateAudioTool({ env, pins }), { ok: false, fault: AudioOggFault.ToolMissing });
    await rm(file);
    await writeFile(file, "abcd");
    assert.deepEqual(await locateAudioTool({ env, pins }), { ok: false, fault: AudioOggFault.ToolMismatch });
    const right = {
      [PLATFORM_KEY]: { sha256: "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589", bytes: 4 },
    };
    assert.deepEqual(await locateAudioTool({ env, pins: right }), { ok: true, path: file });
  });

  it("without a pinned tool the step still refuses converter-missing (characterization of today's rule)", async () => {
    const tools = await tmpDir("audio-ogg-empty-");
    const result = await audioToOgg(
      { bytes: await fixture("tone.opus"), ext: "opus" },
      { env: { [IMPORTER_TOOLS_ENV]: tools } },
    );
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.ConverterMissing);
  });

  it("convertAsset hands audio-to-ogg to the step: an unpinned platform's refusal is the step's", async (t) => {
    if (PINNED) return t.skip(`${PLATFORM_KEY} is pinned`);
    const result = await convertAsset({
      converter: ImportConverter.AudioToOgg,
      ext: "opus",
      name: "tone",
      bytes: await fixture("tone.opus"),
      targets: [BuildTarget.Mac],
    });
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.ConverterMissing);
    assert.match(!result.ok ? result.detail : "", new RegExp(`^audio-ogg ${AudioOggFault.ToolUnpinned}`));
  });
});

describe("the tool's work folder: only its own input and output names", () => {
  it("a name outside the folder, a link in or out and an output already there are refused; nothing starts or is written", async () => {
    const work = await tmpDir("audio-ogg-work-");
    const outside = await tmpDir("audio-ogg-outside-");
    await writeFile(path.join(work, "in.opus"), await fixture("tone.opus"));
    await writeFile(path.join(outside, "secret.opus"), "x");
    await symlink(path.join(outside, "secret.opus"), path.join(work, "linked.opus"));
    await symlink(path.join(outside, "planted.ogg"), path.join(work, "planted.ogg"));
    await writeFile(path.join(work, "taken.ogg"), "x");
    const { run, calls } = recordingRun();
    const rows: Array<[string, string, string]> = [
      ["output climbs out", "in.opus", "../escaped.ogg"],
      ["output is absolute", "in.opus", path.join(outside, "absolute.ogg")],
      ["output in a sub folder", "in.opus", "sub/out.ogg"],
      ["output is the parent", "in.opus", ".."],
      ["output is a link out", "in.opus", "planted.ogg"],
      ["output already there", "in.opus", "taken.ogg"],
      ["input climbs out", "../secret.opus", "out.ogg"],
      ["input is absolute", path.join(outside, "secret.opus"), "out.ogg"],
      ["input is a link out", "linked.opus", "out.ogg"],
      ["input is missing", "absent.opus", "out.ogg"],
    ];
    for (const [label, input, output] of rows) {
      const result = await runAudioTool({
        tool: "/bin/false",
        workDir: work,
        input,
        output,
        source: AudioSource.OggOpus,
        run,
      });
      assert.deepEqual(result, { ok: false, fault: AudioOggFault.PathOutsideJob }, label);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual((await readdir(outside)).sort(), ["secret.opus"]);
    assert.equal(await lstat(path.join(path.dirname(work), "escaped.ogg")).catch(() => null), null);
    assert.deepEqual((await readdir(work)).sort(), ["in.opus", "linked.opus", "planted.ogg", "taken.ogg"]);
  });

  it("a contained pair runs the tool with exactly `--from <source> <input> <output>`, in the folder", async () => {
    const work = await tmpDir("audio-ogg-work-");
    await writeFile(path.join(work, "in.aac"), adts(2));
    const { run, calls } = recordingRun();
    const result = await runAudioTool({
      tool: "/opt/tool",
      workDir: work,
      input: "in.aac",
      output: "out.ogg",
      source: AudioSource.Adts,
      run,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [["/opt/tool", "--from", AudioSource.Adts, "in.aac", "out.ogg"]]);
  });
});

describe("Opus and AAC to Ogg Vorbis at 48 kHz", {
  skip: POSIX ? false : "the stand-in tool is a POSIX script",
}, () => {
  it("named flipped assertion: .opus was converter-missing, now ok with the tool; the output is Ogg Vorbis at 48 kHz", async () => {
    const work = await tmpDir("audio-ogg-step-");
    const tool = await writing("tone.ogg");
    const result = await audioToOgg({ bytes: await fixture("tone.opus"), ext: "opus" }, { tool, workDir: work });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.ok);
    assert.deepEqual(vorbisHeader(result.bytes), { channels: 1, rate: 48_000 });
    assert.deepEqual(result.bytes, await fixture("tone.ogg"));
    assert.deepEqual(await readdir(work), [], "the work folder is removed");
  });

  it("hostile inputs: a truncated Opus and an M4A with no audio track are refused malformed before the tool starts; nothing is written", async () => {
    const work = await tmpDir("audio-ogg-step-");
    const opus = await fixture("tone.opus");
    const rows: Array<[string, Uint8Array, string]> = [
      ["truncated Opus", opus.slice(0, opus.length - 5), "opus"],
      ["AAC without an audio track", mp4(ftyp, box("moov", trak("vide", "avc1")), mdat), "m4a"],
    ];
    for (const [label, bytes, ext] of rows) {
      const { run, calls } = recordingRun();
      const result = await audioToOgg({ bytes, ext }, { tool: "/opt/tool", workDir: work, run });
      assert.equal(!result.ok && result.refusal, AssetImportRefusal.Malformed, label);
      assert.deepEqual(calls, [], label);
      assert.deepEqual(await readdir(work), [], label);
    }
  });

  it("a tool that fails, times out, writes nothing or writes the wrong thing: a typed refusal, the folder removed", async () => {
    const work = await tmpDir("audio-ogg-step-");
    const notVorbis = await standIn(`/bin/cp '${path.join(IMPORT, "tone.opus")}' "$4"`);
    const vorbis441 = await standIn(
      `/bin/cp '${path.join(IMPORT, "tone.ogg")}' "$4" && /usr/bin/printf '\\104\\254\\000\\000' | /bin/dd of="$4" bs=1 seek=40 conv=notrunc 2>/dev/null`,
    );
    const rows: Array<[string, string, AssetImportRefusal, AudioOggFault, number?]> = [
      [
        "exit 65: the tool found the input damaged",
        await standIn("exit 65"),
        AssetImportRefusal.Malformed,
        AudioOggFault.ToolRefusedInput,
      ],
      ["exit 66: no audio track", await standIn("exit 66"), AssetImportRefusal.Malformed, AudioOggFault.NoAudioTrack],
      ["exit 67: longer than converted", await standIn("exit 67"), AssetImportRefusal.TooLarge, AudioOggFault.TooLong],
      ["exit 1", await standIn("exit 1"), AssetImportRefusal.ImporterFailed, AudioOggFault.ToolFailed],
      [
        "killed past its deadline",
        await standIn("exec /bin/sleep 5"),
        AssetImportRefusal.ImporterFailed,
        AudioOggFault.ToolTimedOut,
        200,
      ],
      ["exit 0 with no output", await standIn("exit 0"), AssetImportRefusal.ImporterFailed, AudioOggFault.NoOutput],
      ["Opus out instead of Vorbis", notVorbis, AssetImportRefusal.ImporterFailed, AudioOggFault.NotVorbis48k],
      ["Vorbis at 44.1 kHz", vorbis441, AssetImportRefusal.ImporterFailed, AudioOggFault.NotVorbis48k],
    ];
    for (const [label, tool, refusal, fault, timeoutMs] of rows) {
      const result = await audioToOgg(
        { bytes: await fixture("tone.opus"), ext: "opus" },
        { tool, workDir: work, ...(timeoutMs ? { timeoutMs } : {}) },
      );
      assert.equal(!result.ok && result.refusal, refusal, label);
      assert.equal(!result.ok && result.fault, fault, label);
      assert.deepEqual(await readdir(work), [], label);
    }
  });
});

/** The real tool's conversion of `bytes`: through `convertAsset` when pinned, else through the step with the local build held to its own pin. */
async function convertWithRealTool(bytes: Uint8Array, ext: string) {
  if (PINNED) {
    return await convertAsset({
      converter: ImportConverter.AudioToOgg,
      ext,
      name: "tone",
      bytes,
      targets: [BuildTarget.Mac],
    });
  }
  const built = await readFile(LOCAL_TOOL);
  const pins = {
    [PLATFORM_KEY]: { sha256: createHash("sha256").update(built).digest("hex"), bytes: built.byteLength },
  };
  const located = await locateAudioTool({ env: { [IMPORTER_TOOLS_ENV]: LOCAL_TOOLS }, pins });
  assert.ok(located.ok, JSON.stringify(located));
  return await audioToOgg({ bytes, ext }, { tool: located.path, workDir: await tmpDir("audio-ogg-real-") });
}

describe("the real encoder", { skip: SKIP_REAL_TOOL }, () => {
  it("Opus, ADTS AAC and M4A AAC become mono Ogg Vorbis at 48 kHz, the same bytes every time", async () => {
    for (const name of ["tone.opus", "tone.aac", "tone.m4a"]) {
      const bytes = await fixture(name);
      const ext = name.split(".")[1] ?? "";
      const first = await convertWithRealTool(bytes, ext);
      assert.ok(first.ok, `${name}: ${JSON.stringify(first)}`);
      assert.deepEqual(vorbisHeader(first.bytes), { channels: 1, rate: 48_000 }, name);
      const again = await convertWithRealTool(bytes, ext);
      assert.ok(again.ok, name);
      assert.deepEqual(again.bytes, first.bytes, `${name}: a fixed stream serial, one output`);
    }
  });

  it("an Opus whose pages are whole but whose first audio packet is invalid: the tool refuses it malformed", async () => {
    const opus = await fixture("tone.opus");
    // The third page holds the audio; a code-3 TOC byte with a frame count of 0 is no Opus packet.
    const damaged = new Uint8Array(opus);
    let at = 0;
    for (let page = 0; page < 2; page += 1) {
      const segments = damaged[at + 26] ?? 0;
      const body = damaged.subarray(at + 27, at + 27 + segments).reduce((sum, value) => sum + value, 0);
      at += 27 + segments + body;
    }
    const bodyAt = at + 27 + (damaged[at + 26] ?? 0);
    damaged[bodyAt] = 0x03;
    damaged[bodyAt + 1] = 0x00;
    assert.deepEqual(
      sniffAudio(damaged, "opus"),
      { ok: true, source: AudioSource.OggOpus },
      "the container check passes it",
    );
    const result = await convertWithRealTool(damaged, "opus");
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.Malformed);
  });
});
