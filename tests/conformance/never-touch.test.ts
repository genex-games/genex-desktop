/**
 * The never-touch list: what no worker reaches in any mode (a sign-in, Genex's own data, another
 * game). The verdict is lexical and pure: a file tool by its path fields, a shell command by the
 * paths its words name and any `security` call. The hook carries it into a session, screens reads
 * as well as writes, follows links, and refuses whenever it cannot decide.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { neverTouchHook } from "../../src/substrate/engines/claude-permissions.ts";
import {
  type NeverTouchList,
  NeverTouchKind,
  neverTouchReason,
  neverTouchVerdict,
} from "../../src/substrate/engines/never-touch.ts";
import { neverTouchList } from "../../src/main/core/never-touch-list.ts";
import { credentialHomes } from "../../src/substrate/credential-homes.ts";
import { baseDenyRead } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A home with both sign-ins, Genex's data (a worker's copy and the engine homes in it) and two games. */
async function fixture() {
  // The host hands real paths: a temporary folder reached through a link (macOS `/var`) is resolved.
  const root = await realpath(await tmpDir("studio-never-touch-"));
  const home = path.join(root, "home");
  const userData = path.join(home, "Library", "Application Support", "Genex");
  const games = path.join(home, "AI Games");
  const game = path.join(games, "my-game");
  const other = path.join(games, "other-game");
  const copy = path.join(userData, "scratch", "workers", "copy-1");
  for (const dir of [path.join(home, ".codex"), path.join(home, ".claude"), copy, game, other])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(home, ".codex", "auth.json"), "{}");
  const list: NeverTouchList = {
    roots: [
      { path: path.join(home, ".codex", "auth.json"), kind: NeverTouchKind.Login },
      { path: path.join(home, ".claude", ".credentials.json"), kind: NeverTouchKind.Login },
      { path: path.join(home, ".genex"), kind: NeverTouchKind.Login },
      { path: path.join(userData, "engine-homes"), kind: NeverTouchKind.Login },
      { path: userData, kind: NeverTouchKind.GenexData },
      { path: other, kind: NeverTouchKind.OtherGame },
    ],
    open: [copy],
  };
  return { root, home, userData, game, other, copy, list };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Row = [name: string, tool: string, input: Record<string, unknown>, kind: NeverTouchKind | null];

function rows(f: Fixture): Row[] {
  const { home, userData, game, other, copy } = f;
  return [
    ["a Read of Codex's sign-in by ~", "Read", { file_path: "~/.codex/auth.json" }, NeverTouchKind.Login],
    [
      "a Read of Claude's credentials",
      "Read",
      { file_path: `${home}/.claude/.credentials.json` },
      NeverTouchKind.Login,
    ],
    [
      "the credentials in another case",
      "Read",
      { file_path: `${home}/.CLAUDE/.Credentials.json` },
      NeverTouchKind.Login,
    ],
    [
      "an edit of the engine homes",
      "Edit",
      { file_path: `${userData}/engine-homes/permissions.json` },
      NeverTouchKind.Login,
    ],
    ["a write into another game", "Write", { file_path: `${other}/x` }, NeverTouchKind.OtherGame],
    ["a Glob over another game", "Glob", { pattern: "**/*", path: other }, NeverTouchKind.OtherGame],
    [
      "a Glob over the games folder",
      "Glob",
      { pattern: "*/src/*.js", path: path.dirname(game) },
      NeverTouchKind.OtherGame,
    ],
    [
      "a Grep whose path reaches Genex's data",
      "Grep",
      { pattern: "x", path: `${userData}/runs` },
      NeverTouchKind.GenexData,
    ],
    [
      "a Grep whose glob leaves for another game",
      "Grep",
      { pattern: "x", glob: "../other-game/**" },
      NeverTouchKind.OtherGame,
    ],
    ["a Grep over the home folder", "Grep", { pattern: "token", path: "~" }, NeverTouchKind.Login],
    ["a notebook in Genex's data", "NotebookEdit", { notebook_path: `${userData}/a.ipynb` }, NeverTouchKind.GenexData],
    ["a cat of Codex's sign-in", "Bash", { command: "cat ~/.codex/auth.json" }, NeverTouchKind.Login],
    ["a path inside sh -c", "Bash", { command: "sh -c 'cat ~/.codex/auth.json'" }, NeverTouchKind.Login],
    ["$HOME in quotes", "Bash", { command: 'cat "$HOME/.claude/.credentials.json"' }, NeverTouchKind.Login],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own `${HOME}` is the input.
    ["${HOME} braced", "Bash", { command: "cp ${HOME}/.genex/key ./k" }, NeverTouchKind.Login],
    [
      "security after a cd",
      "Bash",
      { command: "cd /tmp && security find-generic-password -s x" },
      NeverTouchKind.Login,
    ],
    ["security by its path", "Bash", { command: "/usr/bin/security dump-keychain" }, NeverTouchKind.Login],
    ["security behind sudo and env", "Bash", { command: "sudo env A=1 security dump-keychain" }, NeverTouchKind.Login],
    ["security inside sh -c", "Bash", { command: "bash -lc 'security dump-keychain'" }, NeverTouchKind.Login],
    ["security in a subshell", "Bash", { command: "echo $(security find-generic-password -w)" }, NeverTouchKind.Login],
    ["a copy into the next game", "Bash", { command: "cp a ../other-game/b" }, NeverTouchKind.OtherGame],
    ["a redirect into Genex's data", "Bash", { command: `echo hi >"${userData}/x"` }, NeverTouchKind.GenexData],
    ["an option's value", "Bash", { command: `tool "--out=${other}/y"` }, NeverTouchKind.OtherGame],
    ["a link already resolved by the caller", "Read", { file_path: `${home}/.codex/auth.json` }, NeverTouchKind.Login],
    // A shell word naming a folder that holds a root reaches it, as a search does; a glob by its fixed folder.
    ["a delete of Codex's home", "Bash", { command: "rm -rf ~/.codex" }, NeverTouchKind.Login],
    ["a copy of Claude's home", "Bash", { command: "cp -r ~/.claude /tmp/x" }, NeverTouchKind.Login],
    ["an archive of the home folder", "Bash", { command: "tar czf /tmp/h.tgz ~" }, NeverTouchKind.Login],
    ["a glob over Codex's home", "Bash", { command: "cat ~/.codex/*.json" }, NeverTouchKind.Login],
    ["a glob that hides a folder's name", "Bash", { command: "cat ~/.c*x/auth.json" }, NeverTouchKind.Login],
    ["a delete of the games folder", "Bash", { command: "rm -rf .." }, NeverTouchKind.OtherGame],
    ["a delete of the games folder by its slash", "Bash", { command: "rm -rf ../" }, NeverTouchKind.OtherGame],
    ["a glob over the games folder", "Bash", { command: "rm -rf ../*" }, NeverTouchKind.OtherGame],
    ["a glob over another game's name", "Bash", { command: "rm -rf ../oth*" }, NeverTouchKind.OtherGame],
    [
      "a find over the home folder",
      "Bash",
      { command: "find ~ -name auth.json -exec cat {} \\;" },
      NeverTouchKind.Login,
    ],
    ["a recursive grep of Codex's home", "Bash", { command: "grep -r token ~/.codex" }, NeverTouchKind.Login],
    [
      "a recursive grep of Genex's data by an escaped space",
      "Bash",
      { command: "grep -r token ~/Library/Application\\ Support" },
      NeverTouchKind.GenexData,
    ],
    [
      "a delete of the games folder by an escaped space",
      "Bash",
      { command: "rm -rf ~/AI\\ Games" },
      NeverTouchKind.OtherGame,
    ],
    [
      "an archive of Genex's data by an escaped space",
      "Bash",
      { command: "tar czf /tmp/x.tgz ~/Library/Application\\ Support" },
      NeverTouchKind.GenexData,
    ],
    // After a cd, a word with no slash is a path from where the cd went: home, for a bare one.
    ["a bare cd, then a delete by a bare name", "Bash", { command: "cd && rm -rf .codex" }, NeverTouchKind.Login],
    ["a bare cd, then a read", "Bash", { command: "cd; cat .claude/.credentials.json" }, NeverTouchKind.Login],
    ["cd -- goes home too", "Bash", { command: "cd -- && rm -rf .codex" }, NeverTouchKind.Login],
    [
      "a bare cd, then a cd by a bare name",
      "Bash",
      { command: "cd && cd .codex && cat auth.json" },
      NeverTouchKind.Login,
    ],
    ["a bare cd, then an archive", "Bash", { command: "cd && zip -r /tmp/a.zip .codex" }, NeverTouchKind.Login],
    ["a bare cd, then a tar", "Bash", { command: "cd && tar czf /tmp/k.tgz .genex" }, NeverTouchKind.Login],
    [
      "a cd to the games folder, then another game",
      "Bash",
      { command: "cd .. && cat other-game" },
      NeverTouchKind.OtherGame,
    ],
    ["a relative read after a cd", "Bash", { command: "cd ~/.codex/x && cat ../auth.json" }, NeverTouchKind.Login],
    ["a cd into a sign-in's home", "Bash", { command: "cd ~/.codex && cat auth.json" }, NeverTouchKind.Login],
    [
      "security inside a quoted substitution",
      "Bash",
      { command: 'echo "$(security find-generic-password -s x)"' },
      NeverTouchKind.Login,
    ],
    [
      "a path inside a quoted substitution",
      "Bash",
      { command: 'echo "$(cat ~/.codex/auth.json)"' },
      NeverTouchKind.Login,
    ],
    ["a path inside quoted backticks", "Bash", { command: 'echo "`cat ~/.codex/auth.json`"' }, NeverTouchKind.Login],
    // The shell's other ways to name a home, to quote and to build a path from what it knows.
    ["another user's tilde naming this home", "Bash", { command: "cat ~home/.codex/auth.json" }, NeverTouchKind.Login],
    ["a copy by another user's tilde", "Bash", { command: "cp -r ~home/.claude /tmp/x" }, NeverTouchKind.Login],
    ["a cd by another user's tilde", "Bash", { command: "cd ~home && cat .codex/auth.json" }, NeverTouchKind.Login],
    ["ANSI-C quoting", "Bash", { command: `cat $'${home}/.codex/auth.json'` }, NeverTouchKind.Login],
    [
      "ANSI-C escapes for the slashes",
      "Bash",
      { command: `cat $'${home}\\x2f.codex\\057auth.json'` },
      NeverTouchKind.Login,
    ],
    ["locale quoting", "Bash", { command: `cat $"${home}/.codex/auth.json"` }, NeverTouchKind.Login],
    ["a path from $PWD", "Bash", { command: 'rm -rf "$PWD/../other-game"' }, NeverTouchKind.OtherGame],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own `${PWD}` is the input.
    ["a path from ${PWD} braced", "Bash", { command: "rm -rf ${PWD}/.." }, NeverTouchKind.OtherGame],
    ["~+ for the folder it stands in", "Bash", { command: "rm -rf ~+/../other-game" }, NeverTouchKind.OtherGame],
    [
      "a path from $USER",
      "Bash",
      { command: `cat ${path.dirname(home)}/$USER/.codex/auth.json` },
      NeverTouchKind.Login,
    ],
    ["a folder from a variable", "Bash", { command: "D=.codex; cat ~/$D/auth.json" }, NeverTouchKind.Login],
    ["the disk root", "Bash", { command: "ls /" }, NeverTouchKind.Login],
    ["the game's own file", "Read", { file_path: `${game}/src/main.js` }, null],
    // A lone `/` as text or a search's pattern is a character, never the disk.
    ["a grep for a comment", "Bash", { command: "grep -rn '//' src" }, null],
    ["tr over slashes", "Bash", { command: "tr / _ < a.txt" }, null],
    ["IFS set to a slash", "Bash", { command: "IFS=/ read a b <<< x" }, null],
    ["an echo of a slash", "Bash", { command: "echo /" }, null],
    ["a sed over slashes", "Bash", { command: "sed -e 's/a/b/' src/a.js" }, null],
    ["a path from $PWD in the game", "Bash", { command: 'ls "$PWD/src"' }, null],
    ["a relative edit in the game", "Edit", { file_path: "src/main.js" }, null],
    ["the worker's own copy", "Edit", { file_path: `${copy}/src/a.ts` }, null],
    ["a Glob in the game", "Glob", { pattern: "**/*.ts", path: game }, null],
    ["a Grep with no path", "Grep", { pattern: "TODO" }, null],
    // A Grep's pattern is a regex over file contents, never a path.
    ["a Grep for a comment", "Grep", { pattern: "//" }, null],
    ["a Grep for a block comment", "Grep", { pattern: "/\\*" }, null],
    ["a Grep for an import", "Grep", { pattern: "../utils" }, null],
    ["a Grep for a route", "Grep", { pattern: "/api", path: "src" }, null],
    ["a Grep for the home folder's sign", "Grep", { pattern: "~/" }, null],
    ["a glob in the game's own folder", "Bash", { command: "ls src/*.ts" }, null],
    ["a cd inside the game", "Bash", { command: "cd src && cat main.js" }, null],
    ["a cd inside the game, then a build", "Bash", { command: "cd src && npm run build -- --watch" }, null],
    ["npm test", "Bash", { command: "npm test" }, null],
    ["git status", "Bash", { command: "git status && git log -1 --format=%H" }, null],
    ["a commit that says security", "Bash", { command: 'git commit -m "fix security bug"' }, null],
    ["a word that only contains security", "Bash", { command: "grep securityPolicy x" }, null],
    ["a reference the person keeps", "Read", { file_path: "~/Documents/refs/a.png" }, null],
    ["a studio tool", "mcp__studio__checkpoint", { path: userData }, null],
    ["a web search", "WebSearch", { query: "~/.codex/auth.json" }, null],
  ];
}

describe("the never-touch list", () => {
  it("the host's sign-ins are at least what every agent's box denies: SSH, cloud and GitHub logins, the CLIs' whole homes", async () => {
    const f = await fixture();
    const list = await neverTouchList(
      {
        home: f.home,
        credentialHomes: credentialHomes([], {}, f.home),
        signInStores: baseDenyRead(f.home, "darwin", {}),
        genexLogins: [path.join(f.userData, "engine-homes")],
        genexData: [f.userData],
        otherGames: [f.other],
      },
      [f.game],
    );
    const reads: Array<[string, string]> = [
      ["Read", "~/.ssh/id_ed25519"],
      ["Read", "~/.aws/credentials"],
      ["Read", "~/.config/gh/hosts.yml"],
      ["Read", "~/.netrc"],
      ["Read", "~/Library/Keychains/login.keychain-db"],
      ["Edit", "~/.claude/settings.json"],
      ["Read", "~/.codex/config.toml"],
    ];
    for (const [tool, file] of reads) {
      const hit = neverTouchVerdict({ tool, input: { file_path: file } }, list, f.game, f.home, "darwin");
      assert.equal(hit?.kind, NeverTouchKind.Login, `${tool} ${file}`);
    }
    const bash = neverTouchVerdict({ tool: "Bash", input: { command: "cat ~/.ssh/id_rsa" } }, list, f.game, f.home);
    assert.equal(bash?.kind, NeverTouchKind.Login, "a shell read of a key");
    for (const command of ["cd; cat .netrc", "cd && cat .ssh/id_rsa", "cd && cd .ssh && cat id_rsa"]) {
      const after = neverTouchVerdict({ tool: "Bash", input: { command } }, list, f.game, f.home, "darwin");
      assert.equal(after?.kind, NeverTouchKind.Login, command);
    }
  });

  it("refuses a worker's call that reaches a login, Genex's own data or another game, and nothing else", async () => {
    const f = await fixture();
    for (const [name, tool, input, kind] of rows(f)) {
      const hit = neverTouchVerdict({ tool, input }, f.list, f.game, f.home, "darwin");
      assert.equal(hit?.kind ?? null, kind, `${name}: ${JSON.stringify(hit)}`);
    }
    // macOS volumes are case-blind; another platform's are not, so another case is another file.
    const variant = { tool: "Read", input: { file_path: `${f.home}/.CLAUDE/.credentials.json` } };
    assert.equal(neverTouchVerdict(variant, f.list, f.game, f.home, "linux"), null);
    const hit = neverTouchVerdict(
      { tool: "Read", input: { file_path: "~/.codex/auth.json" } },
      f.list,
      f.game,
      f.home,
      "darwin",
    );
    assert.ok(hit);
    const reason = neverTouchReason(hit);
    assert.ok(reason.includes(path.join(f.home, ".codex", "auth.json")), reason);
    assert.match(reason, /Do not retry it or work around it; carry on without it\./);
  });

  it("reads a here-document a program takes as text: code and prose in it name paths only as paths alone", async () => {
    const f = await fixture();
    const allowed: Array<[string, string]> = [
      ["a division in Python written to a file", "cat > assets/src/roof.py <<'EOF'\nh0 = (t0 / 2) / COSP\nEOF"],
      [
        "a tilde in a docstring and a division in a generator",
        'cat > assets/src/pose.py <<\'EOF\'\n"""rotate the arms ~40 deg down"""\nratio = max(p / r for p, r in pairs)\nEOF\necho ok',
      ],
      ["a floor division Python reads from stdin", "python3 - <<'EOF'\nprint(a // b)\nEOF"],
      ["prose with a lone tilde and a security note", "cat > notes.txt <<EOF\nsecurity review: turn ~ 40 deg\nEOF"],
      ["a relative import", "cat > assets/src/kit.py <<'EOF'\nfrom .. import common\nEOF"],
      ["a body whose quote never closes", "cat > a.py <<'EOF'\nprint(\"it's / done\")\nEOF\nls src"],
      ["tab-stripped delimiter", "cat > a.py <<-EOF\n\tx = a / b\n\tEOF"],
      ["two here-documents in turn", "cat > a.py <<'A'; cat > b.py <<'B'\nx = 1 / 2\nA\ny = ~ / 3\nB"],
      ["a reader behind sudo", "sudo cat > a.py <<'EOF'\nx = a / b\nEOF"],
      [
        "Blender reading a script from stdin",
        "/Applications/Blender.app/Contents/MacOS/Blender -b <<'EOF'\nx = a / b\nEOF",
      ],
    ];
    for (const [name, command] of allowed) {
      const hit = neverTouchVerdict({ tool: "Bash", input: { command } }, f.list, f.game, f.home, "darwin");
      assert.equal(hit, null, `${name}: ${JSON.stringify(hit)}`);
    }
    const refused: Array<[string, string, NeverTouchKind]> = [
      ["a shell reading commands", "bash <<'EOF'\nrm -rf ~/.codex\nEOF", NeverTouchKind.Login],
      ["sh reading a read of a sign-in", "sh <<EOF\ncat ~/.codex/auth.json\nEOF", NeverTouchKind.Login],
      ["a body piped into a shell", "cat <<'EOF' | sh\nrm -rf ~\nEOF", NeverTouchKind.Login],
      ["a substitution the shell runs in a body", "cat <<EOF\n$(cat ~/.codex/auth.json)\nEOF", NeverTouchKind.Login],
      ["security in backticks in a body", "cat <<EOF\n`security dump-keychain`\nEOF", NeverTouchKind.Login],
      [
        "a sign-in named in a program's text",
        `python3 - <<'EOF'\nprint(open("${f.home}/.codex/auth.json").read())\nEOF`,
        NeverTouchKind.Login,
      ],
      ["a redirect into a sign-in's home", "cat > ~/.genex/key <<'EOF'\nhi\nEOF", NeverTouchKind.Login],
      ["a command after the body", "cat > a.py <<'EOF'\nit's / here\nEOF\nrm -rf ~/.codex", NeverTouchKind.Login],
      ["a loop reading paths", `while read f; do rm -rf "$f"; done <<'EOF'\n${f.home}\nEOF`, NeverTouchKind.Login],
      ["xargs handing a body's words to a program", "xargs cat <<'EOF'\n~\nEOF", NeverTouchKind.Login],
      // `<<` that is no here-document leaves the next lines commands, even after a program that reads text.
      ["a shift of a variable named like a program", "echo $((cat<<X))\nrm -rf ~\nX", NeverTouchKind.Login],
      ["an old-style shift", "cat a $[1<<X]\nrm -rf ~\nX]", NeverTouchKind.Login],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter form is the input.
      ["a shift in a parameter's default", "cat ${x:-<<X}\nrm -rf ~\nX}", NeverTouchKind.Login],
      ["a here-document marker in a comment", "cat a # <<EOF\nrm -rf ~\nEOF", NeverTouchKind.Login],
      ["a body that never ends", "cat <<EOF\nrm -rf ~", NeverTouchKind.Login],
      // A body read as text may still run: written to a file run by its path, or inside a substitution.
      ["a script written, then run by its path", "cat > x.sh <<'EOF'\nrm -rf ~\nEOF\n./x.sh", NeverTouchKind.Login],
      ["a body eval runs", "eval \"$(cat <<'EOF'\nrm -rf ~\nEOF\n)\"", NeverTouchKind.Login],
      [
        "the keychain in a body a shell runs",
        "bash -c \"$(cat <<'EOF'\nsecurity find-generic-password -w\nEOF\n)\"",
        NeverTouchKind.Login,
      ],
    ];
    for (const [name, command, kind] of refused) {
      const hit = neverTouchVerdict({ tool: "Bash", input: { command } }, f.list, f.game, f.home, "darwin");
      assert.equal(hit?.kind ?? null, kind, `${name}: ${JSON.stringify(hit)}`);
    }
  });

  it("the hook reads relative paths from the folder the session's shell stands in", async () => {
    const f = await fixture();
    await mkdir(path.join(f.copy, "assets", "src"), { recursive: true });
    await mkdir(path.join(f.game, "src"), { recursive: true });
    // A worker's session works in its copy; its shell moved into a subfolder of it.
    const worker = neverTouchHook(f.list, f.copy, f.home);
    const lead = neverTouchHook(f.list, f.game, f.home);
    const denied = async (hook: typeof worker, cwd: unknown, tool: string, input: Record<string, unknown>) => {
      const answer = await hook({ hook_event_name: "PreToolUse", cwd, tool_name: tool, tool_input: input });
      return (answer.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";
    };
    const inCopy = path.join(f.copy, "assets", "src");
    const back = "cd ../.. && rm -rf assets/blender/x && git status --short";
    assert.equal(await denied(worker, inCopy, "Bash", { command: back }), false, "back to the copy's root");
    assert.equal(await denied(worker, inCopy, "Bash", { command: "rm -rf ../../assets/blender/x" }), false);
    assert.equal(await denied(worker, inCopy, "Bash", { command: "rm -rf ../../.." }), true, "out of the copy");
    const inGame = path.join(f.game, "src");
    assert.equal(await denied(lead, inGame, "Bash", { command: "cat ../../other-game/x" }), true, "another game");
    assert.equal(await denied(lead, inGame, "Read", { file_path: "../../other-game/x" }), true, "a file tool too");
    assert.equal(await denied(lead, inGame, "Bash", { command: "cat ../src/main.js" }), false);
    // A cwd that is no absolute path is not read: the session's own folder stands in.
    for (const cwd of [undefined, 7, "", "src", "../other-game", ["/"]])
      assert.equal(await denied(lead, cwd, "Bash", { command: "cat ../other-game/x" }), true, JSON.stringify(cwd));
  });

  it("refuses what the screen cannot read: a parameter form, the folder a cd left", async () => {
    const f = await fixture();
    const hook = neverTouchHook(f.list, f.game, f.home);
    const unreadable = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter form is the input.
      "cat ${HOME:-/x}/.codex/auth.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter form is the input.
      "cat ${HOME%/}/.codex/auth.json",
      "cat $OLDPWD/x",
      "cat ~-/x",
    ];
    for (const command of unreadable) {
      const call = { tool: "Bash", input: { command } };
      assert.throws(() => neverTouchVerdict(call, f.list, f.game, f.home, "darwin"), TypeError, command);
      const answer = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
      const output = answer.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
      assert.equal(output.permissionDecision, "deny", command);
      assert.match(output.permissionDecisionReason ?? "", /could not check what this call reaches/, command);
    }
  });

  it("on Windows reads drive, share and Git Bash paths, quoted with backslashes or not", () => {
    const home = "C:\\Users\\alice";
    const game = `${home}\\AI Games\\mine`;
    const list: NeverTouchList = {
      roots: [
        { path: `${home}\\.ssh`, kind: NeverTouchKind.Login },
        { path: `${home}\\AI Games\\other`, kind: NeverTouchKind.OtherGame },
      ],
      open: [game],
    };
    const cases: Array<[tool: string, input: Record<string, unknown>, kind: NeverTouchKind | null]> = [
      ["Bash", { command: "cat 'C:\\Users\\alice\\.ssh\\id_rsa'" }, NeverTouchKind.Login],
      ["Bash", { command: 'cat "C:/Users/alice/.ssh/id_rsa"' }, NeverTouchKind.Login],
      ["Bash", { command: "cat /c/Users/alice/.ssh/id_rsa" }, NeverTouchKind.Login],
      ["Bash", { command: "cat 'c:\\users\\ALICE\\.SSH\\id_rsa'" }, NeverTouchKind.Login],
      ["Bash", { command: "cat ~/.ssh/id_rsa" }, NeverTouchKind.Login],
      ["Bash", { command: "rm -rf '..\\other'" }, NeverTouchKind.OtherGame],
      ["Read", { file_path: "C:\\Users\\alice\\.ssh\\id_rsa" }, NeverTouchKind.Login],
      ["Bash", { command: "node 'src\\main.js'" }, null],
      ["Bash", { command: "cat src/main.js" }, null],
    ];
    for (const [tool, input, kind] of cases) {
      const hit = neverTouchVerdict({ tool, input }, list, game, home, "win32");
      assert.equal(hit?.kind ?? null, kind, `${tool} ${JSON.stringify(input)}: ${JSON.stringify(hit)}`);
    }
  });

  it("the hook refuses reads and writes alike, in every mode, and refuses when it cannot decide", async () => {
    const f = await fixture();
    // A link inside the game that leads to Codex's sign-in: the hook follows it.
    await symlink(path.join(f.home, ".codex"), path.join(f.game, "creds"));
    const hook = neverTouchHook(f.list, f.game, f.home);
    const call = (tool: unknown, input: unknown) =>
      hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "tu" });
    const denied = (answer: Record<string, unknown>) =>
      (answer.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";

    for (const [name, tool, input, kind] of rows(f).filter((row) => row[0] !== "the credentials in another case")) {
      assert.equal(denied(await call(tool, input)), kind !== null, name);
    }
    assert.ok(denied(await call("Read", { file_path: "creds/auth.json" })), "a link is followed");
    assert.ok(denied(await call("Bash", { command: "cat creds/auth.json" })), "a link in a command too");
    assert.equal(denied(await call("Read", { file_path: "src/missing.js" })), false, "a missing file in the game");

    const refusals: Array<[string, unknown, unknown]> = [
      ["no tool name", undefined, { file_path: "a" }],
      ["input that is not an object", "Read", "a"],
      ["a path that is not text", "Read", { file_path: 7 }],
      ["a command that is not text", "Bash", { command: ["cat", "x"] }],
    ];
    for (const [name, tool, input] of refusals) assert.ok(denied(await call(tool, input)), name);

    const throwing = {
      get roots(): never {
        throw new Error("unreadable");
      },
      open: [],
    } as unknown as NeverTouchList;
    const broken = neverTouchHook(throwing, f.game, f.home);
    const answer = await broken({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } });
    assert.ok(denied(answer), "a list it cannot read refuses");
    assert.deepEqual(await hook({ hook_event_name: "PostToolUse", tool_name: "Read" }), {}, "not a tool call");
  });
});
