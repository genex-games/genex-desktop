// Runs SRT's synchronous release calls against a recording spawnSync in a process of its own; never
// starts srt-win or edits a filesystem ACL. Prints each call's deadline, by its srt-win verb.
import childProcess from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const dist = path.join(path.dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "dist");
const deadlines = {};
mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    spawnSync: (_exe, args, opts) => {
      deadlines[args.slice(0, 2).join(" ")] = opts.timeout;
      return { status: 0, signal: null, stdout: "[]", stderr: "" };
    },
  },
});
const windows = await import(pathToFileURL(path.join(dist, "sandbox/windows-sandbox-utils.js")).href);
const opts = { sandboxUserSid: "fixture-sid", srtWin: { exe: "fixture-srt-win", prependArgs: [] } };
windows.revokeWindowsAclChecked(opts);
windows.restoreWindowsAcl(opts);
process.stdout.write(JSON.stringify(deadlines));
