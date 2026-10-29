import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureElectronArgs, fixtureElectronEnv } from "../../scripts/electron-runtime.mjs";

test("macOS fixture launch requests mock cookie encryption before app arguments", () => {
  assert.deepEqual(fixtureElectronArgs([".", "--studio-selftest"], "darwin"), [
    "--use-mock-keychain",
    ".",
    "--studio-selftest",
  ]);
  assert.deepEqual(fixtureElectronArgs(["."], "linux"), ["."]);
});
test("a macOS fixture launch can stand in a computer's language list for its process alone", () => {
  const rows: Array<[string, string | undefined, string[]]> = [
    ["a Japanese Mac", "ja-JP,en-US", ["-AppleLanguages", "(ja-JP, en-US)"]],
    ["a Traditional Chinese Mac", "zh-Hant-TW", ["-AppleLanguages", "(zh-Hant-TW)"]],
    ["none asked for", undefined, []],
    ["a tag smuggling an argument", "ja-JP) --inspect (", []],
    ["a switch in its place", "--remote-debugging-port=9222", []],
    ["one good tag among bad ones", "ko-KR,;rm -rf,", ["-AppleLanguages", "(ko-KR)"]],
  ];
  for (const [name, list, extra] of rows)
    assert.deepEqual(
      fixtureElectronArgs(["."], "darwin", { STUDIO_FIXTURE_SYSTEM_LANGUAGES: list }),
      ["--use-mock-keychain", ".", ...extra],
      name,
    );
  assert.deepEqual(
    fixtureElectronArgs(["."], "linux", { STUDIO_FIXTURE_SYSTEM_LANGUAGES: "ja-JP" }),
    ["."],
    "only macOS",
  );
});
test("fixture launch disables Studio OS credentials and live checks regardless of inherited opt-ins", () => {
  const source = {
    PATH: "/fixture",
    STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS: "1",
    GENEX_TOKEN: "synthetic",
    OPENAI_API_KEY: "synthetic",
    ELECTRON_RUN_AS_NODE: "1",
  };
  const env = fixtureElectronEnv(source);
  assert.equal(env.STUDIO_DISABLE_OS_CREDENTIALS, "1");
  assert.equal(env.STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS, "0");
  assert.equal(env.GENEX_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "/fixture");
  assert.equal(source.GENEX_TOKEN, "synthetic", "caller environment is unchanged");
});
