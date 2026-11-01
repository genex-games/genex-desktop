/**
 * Model-written text on a git command line (HQ-1). `run.exec` hands its command to `/bin/sh -c`,
 * and a judge's reason, a build error or a worker's title used to reach it inside double quotes
 * with only `"` replaced — so a backtick or `$(…)` in that text ran as a command and the commit
 * message lost it. `loop/shell.ts` single-quotes such text; these tests run it through a real
 * shell, in a real repository.
 */
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { isCommit, shellQuote } from "../../src/harness-seed/loop/shell.ts";
import { readProjectShape } from "../../src/substrate/game-workspace.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Text a model could write that a shell would act on, each piece leaving a file behind if it ran. */
const HOSTILE = [
  "a judge's `touch backtick` reason",
  "$(touch dollar) and ${HOME} and $HOME",
  "it's \"quoted\" and 'single' and \\ back",
  "semi; touch semi && touch and || touch or | cat",
  "new\nline and\ttab and * glob ? and ~ tilde and # hash",
  "'; touch escaped; echo '",
];

describe("shellQuote", () => {
  it("hands every hostile string to the program exactly and runs none of it", async () => {
    const dir = await tmpDir("studio-quote-");
    for (const text of HOSTILE) {
      const out = await sh(`printf '%s' ${shellQuote(text)}`, dir);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(out.stdout, text);
    }
    assert.deepEqual(await readdir(dir), [], "nothing in the text ran");
  });
});

describe("hostile names and hashes on the loop's command lines (M3)", () => {
  it("isCommit takes a hash or HEAD and nothing a shell or git would act on", () => {
    for (const ok of ["0123abc", "a".repeat(40), "b".repeat(64), "HEAD"]) assert.equal(isCommit(ok), true, ok);
    for (const bad of [
      "",
      "abc",
      "HEAD; touch PWNED",
      "$(touch PWNED)",
      "--output=/tmp/x",
      "a".repeat(65),
      "0123ABZ",
      "main",
      null,
      42,
    ])
      assert.equal(isCommit(bad), false, String(bad));
  });

  it("a game's studio.json cannot name an entry that is not a plain relative path", async () => {
    for (const main of ["src/main.js; touch PWNED", "/etc/passwd", "../outside.js", "src/$(x).js", "a\nb.js"]) {
      const dir = await tmpDir("studio-shape-main-");
      await writeFile(path.join(dir, "studio.json"), JSON.stringify({ entry: "index.html", main }));
      assert.equal((await readProjectShape(dir)).main, "src/main.js", JSON.stringify(main));
    }
    const dir = await tmpDir("studio-shape-main-");
    await writeFile(path.join(dir, "studio.json"), JSON.stringify({ entry: "index.html", main: "game/Main Scene.js" }));
    assert.equal(
      (await readProjectShape(dir)).main,
      "game/Main Scene.js",
      "an ordinary name with a space still counts",
    );
  });
});
