/**
 * Signing and notarizing a creator's Mac app with their own Apple Developer ID before Publish sends
 * it: their identity from their own keychain, every program inside the app signed before the app,
 * Apple's notary asked through the keychain profile they stored, the ticket stapled. Genex holds no
 * Apple secret. A failure says why by code and leaves the app as it was built. The commands are stand-ins.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_NOTARY_PROFILE,
  developerIds,
  MacSigningSetting,
  macSigningOf,
  machOFiles,
  type NotarizeDeps,
  notarizeMacApp,
  pickIdentity,
} from "../../src/plugins/genex/mac-notarize.ts";
import { MacNotarizeFailure } from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ADA = "Developer ID Application: Ada Lovelace (ABCDE12345)";
const FIND_IDENTITY = [
  '  1) 0123ABCD0123ABCD0123ABCD0123ABCD0123ABCD "Apple Development: Ada Lovelace (XYZ9876543)"',
  `  2) 4567EF014567EF014567EF014567EF014567EF01 "${ADA}"`,
  "     2 valid identities found",
].join("\n");
const MACH_O = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

/** A packaged Mac app: its program, a framework's library, a plain data file and a link out. */
async function macApp() {
  const root = await tmpDir("notarize-");
  const app = path.join(root, "Builds", "Mac", "Dust.app");
  const contents = path.join(app, "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "UE", "Engine", "Binaries", "ThirdParty"), { recursive: true });
  await writeFile(path.join(contents, "MacOS", "Dust"), FAT);
  await writeFile(path.join(contents, "UE", "Engine", "Binaries", "ThirdParty", "libogg.dylib"), MACH_O);
  await writeFile(path.join(contents, "UE", "Dust.pak"), "cooked content");
  await writeFile(path.join(contents, "Info.plist"), "<plist/>");
  await symlink("/usr/lib/libSystem.B.dylib", path.join(contents, "UE", "linked.dylib"));
  return { root, app };
}

/** Deps whose commands answer from `answers` by program (`codesign`, `notarytool`…), every call recorded. */
function fakeDeps(answers: Partial<Record<string, { code: number; stdout?: string }>> = {}) {
  const calls: string[][] = [];
  const deps: NotarizeDeps = {
    run: async (file, args) => {
      calls.push([path.basename(file), ...args]);
      const tool = path.basename(file) === "xcrun" ? (args[0] ?? "") : path.basename(file);
      const answer = answers[tool] ?? { code: 0 };
      const stdout =
        answer.stdout ??
        (tool === "security" ? FIND_IDENTITY : tool === "notarytool" ? '{"status":"Accepted","id":"n-1"}' : "");
      if (tool === "ditto") await writeFile(args.at(-1) ?? "", "zip");
      return { code: answer.code, stdout, stderr: answer.code === 0 ? "" : "error: the stand-in failed" };
    },
  };
  return { deps, calls };
}

const tools = (calls: string[][]) => calls.map((call) => (call[0] === "xcrun" ? call[1] : call[0]));

describe("notarizing a creator's Mac app", () => {
  it("is asked for only when the creator turned it on in Genex's settings", () => {
    assert.equal(macSigningOf({}), null);
    assert.equal(macSigningOf({ [MacSigningSetting.Notarize]: false, [MacSigningSetting.Identity]: ADA }), null);
    assert.equal(macSigningOf({ [MacSigningSetting.Notarize]: "true" }), null, "only a real yes");
    assert.deepEqual(macSigningOf({ [MacSigningSetting.Notarize]: true }), {
      identity: "",
      profile: DEFAULT_NOTARY_PROFILE,
    });
    assert.deepEqual(
      macSigningOf({
        [MacSigningSetting.Notarize]: true,
        [MacSigningSetting.Identity]: `  ${ADA} `,
        [MacSigningSetting.NotaryProfile]: "ada-notary",
      }),
      { identity: ADA, profile: "ada-notary" },
    );
    assert.deepEqual(
      macSigningOf({
        [MacSigningSetting.Notarize]: true,
        [MacSigningSetting.Identity]: 7,
        [MacSigningSetting.NotaryProfile]: "-x",
      }),
      { identity: "", profile: DEFAULT_NOTARY_PROFILE },
      "a value that isn't a name, or reads as an option, is left out",
    );
  });

  it("reads the Developer ID identities of the creator's keychain, and picks the one to sign with", () => {
    assert.deepEqual(developerIds(FIND_IDENTITY), [ADA], "an Apple Development identity can't sign for downloads");
    assert.equal(pickIdentity([ADA], ""), ADA);
    assert.equal(pickIdentity([ADA], ADA), ADA);
    assert.equal(pickIdentity([], ""), MacNotarizeFailure.NoIdentity);
    assert.equal(
      pickIdentity([ADA], "Developer ID Application: Someone Else (ZZZZZ99999)"),
      MacNotarizeFailure.NoIdentity,
    );
    const two = [ADA, "Developer ID Application: Ada's Studio (FGHIJ67890)"];
    assert.equal(pickIdentity(two, ""), MacNotarizeFailure.ManyIdentities, "two identities need the creator's choice");
    assert.equal(pickIdentity(two, two[1] ?? ""), two[1]);
  });

  it("signs every program inside the app before the app, never through a link", async () => {
    const { app } = await macApp();
    assert.deepEqual(
      (await machOFiles(app)).map((file) => path.relative(app, file)),
      ["Contents/UE/Engine/Binaries/ThirdParty/libogg.dylib", "Contents/MacOS/Dust"],
    );
  });

  it("signs with hardened runtime, notarizes with the creator's stored profile, staples, and leaves no zip", async () => {
    const { root, app } = await macApp();
    const { deps, calls } = fakeDeps();
    const outcome = await notarizeMacApp(app, { identity: "", profile: "" }, deps, new AbortController().signal);
    assert.deepEqual(outcome, { notarized: true, identity: ADA });
    assert.deepEqual(tools(calls), ["security", "codesign", "codesign", "codesign", "ditto", "notarytool", "stapler"]);
    assert.deepEqual(calls[0], ["security", "find-identity", "-v", "-p", "codesigning"]);
    for (const sign of calls.filter((call) => call[0] === "codesign"))
      assert.deepEqual(sign.slice(1, 7), ["--force", "--options", "runtime", "--timestamp", "--sign", ADA]);
    assert.equal(calls[3]?.at(-1), app, "the app itself is signed last");
    const submit = calls.find((call) => call[1] === "notarytool") ?? [];
    assert.deepEqual(submit.slice(1, 3), ["notarytool", "submit"]);
    assert.ok(submit.includes(DEFAULT_NOTARY_PROFILE), "the profile the creator stored with notarytool");
    assert.ok(submit.includes("--wait"));
    assert.deepEqual(calls.at(-1), ["xcrun", "stapler", "staple", app]);
    assert.deepEqual(await readdir(path.dirname(app)), ["Dust.app"], "the zip sent to Apple is gone");
    assert.deepEqual(await readdir(root), ["Builds"]);
  });

  it("says why by code when signing, Apple's notary or the staple fails, and goes no further", async () => {
    const signal = new AbortController().signal;
    const cases: Array<[string, Parameters<typeof fakeDeps>[0], MacNotarizeFailure, string[]]> = [
      [
        "no Developer ID",
        { security: { code: 0, stdout: "     0 valid identities found" } },
        MacNotarizeFailure.NoIdentity,
        ["security"],
      ],
      ["codesign refuses", { codesign: { code: 1 } }, MacNotarizeFailure.Sign, ["security", "codesign"]],
      [
        "no stored profile",
        { notarytool: { code: 69 } },
        MacNotarizeFailure.Submit,
        ["security", "codesign", "codesign", "codesign", "ditto", "notarytool"],
      ],
      [
        "Apple rejects it",
        { notarytool: { code: 0, stdout: '{"status":"Invalid","id":"n-2"}' } },
        MacNotarizeFailure.Rejected,
        ["security", "codesign", "codesign", "codesign", "ditto", "notarytool"],
      ],
      [
        "an answer that isn't Apple's",
        { notarytool: { code: 0, stdout: "not json" } },
        MacNotarizeFailure.Submit,
        ["security", "codesign", "codesign", "codesign", "ditto", "notarytool"],
      ],
      [
        "the staple fails",
        { stapler: { code: 65 } },
        MacNotarizeFailure.Staple,
        ["security", "codesign", "codesign", "codesign", "ditto", "notarytool", "stapler"],
      ],
    ];
    for (const [why, answers, failure, ran] of cases) {
      const { app } = await macApp();
      const { deps, calls } = fakeDeps(answers);
      const outcome = await notarizeMacApp(app, { identity: "", profile: "" }, deps, signal);
      assert.equal("failure" in outcome ? outcome.failure : null, failure, why);
      assert.deepEqual(tools(calls), ran, why);
      assert.deepEqual(await readdir(path.dirname(app)), ["Dust.app"], `${why}: no zip left`);
    }
  });

  it("refuses what isn't a Mac app in a plain folder, running nothing", async () => {
    const { root, app } = await macApp();
    const linked = path.join(root, "Linked.app");
    await symlink(app, linked);
    const file = path.join(root, "Fake.app");
    await writeFile(file, "not a bundle");
    const signal = new AbortController().signal;
    for (const target of [
      linked,
      file,
      path.join(root, "Missing.app"),
      path.join(app, "Contents"),
      "relative/Dust.app",
    ]) {
      const { deps, calls } = fakeDeps();
      const outcome = await notarizeMacApp(target, { identity: "", profile: "" }, deps, signal);
      assert.deepEqual(outcome, { failure: MacNotarizeFailure.NotAnApp }, target);
      assert.deepEqual(calls, [], target);
    }
    const stopped = new AbortController();
    stopped.abort();
    const { deps, calls } = fakeDeps();
    assert.deepEqual(await notarizeMacApp(app, { identity: "", profile: "" }, deps, stopped.signal), {
      failure: MacNotarizeFailure.Stopped,
    });
    assert.deepEqual(calls, []);
  });
});
