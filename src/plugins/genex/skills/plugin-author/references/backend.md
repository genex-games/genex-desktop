# backend.mjs

The backend is a Node module (plain JavaScript, `.mjs`) that exports `async function activate()`.
It returns an object whose `tool(name, args, context)` answers every tool the manifest declares, by
name. Genex runs it in a process of its own with the person's access and a small environment
(`PATH`, `HOME`, `TMPDIR`).

- `activate()` does nothing but return the handlers: Genex loads the module to check it starts when
  the person turns the plugin on, with no project, so it must not start programs or read files there.
- `context.directory` is the project folder the call is bound to and `context.project` its name;
  `context.signal` aborts when the call is stopped. Never keep a context for a later call.
- `context.hook` is set when Genex runs the tool at one of its moments, `context.observe` when it
  runs it as an observer (`observe.withinMs`: how long it may take).
- Answer a plain object. When the engine is missing or a step fails, answer `{ok: false, problem}`
  in words the agent can act on, rather than throwing.
- Don't start programs from the backend: Genex's scan marks any use of `child_process` dangerous,
  and the person is warned before they load it. Talk to the engine instead (a local control port
  with `fetch`, the `network` capability and its host declared, as Sketch does), read and write the
  project's files with `node:fs` inside `context.directory`, and leave the engine's command-line
  programs to the lead, who runs them as jobs in the chat's permission mode. A program that turns
  named files into others runs in Genex's sandbox through `nativeJobs` and `native.run` (Genex's
  plugin guide).
- The backend can't start the engine, so it never closes it either: no hook at `run.end` closes
  the editor the next run's `run.prepare` needs open. The person's editor stays as they left it.
- A tool's call lasts minutes at most. For longer work (a long build), start it, answer at once and
  add a status tool that reads how it is going.

Write `genex-plugins/sketch/backend.mjs`:

```js
// Sketch's tools, each answered by name. Every one asks the Sketch editor's control port on this
// Mac, which the editor opens while it runs: 7311, or the port the project's .sketch/editor.json names.
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_PORT = 7311;
const CALL_MS = 5 * 60 * 1000;
const STEP_MS = 30 * 1000;
const OUTPUT_CHARS = 4000;

/** The editor's control port for the bound project. */
async function editorPort(context) {
  try {
    const text = await readFile(path.join(context.directory, ".sketch", "editor.json"), "utf8");
    const port = JSON.parse(text).port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Ask the editor `route` for the bound project; answers {ok, response} or {ok: false, problem}, with
 * `closed: true` when nothing listens on the port: the editor isn't running.
 */
async function editor(route, context, { body, timeout = STEP_MS } = {}) {
  const port = await editorPort(context);
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeout)]);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify({ project: context.directory, ...body }),
      signal,
    });
    if (response.ok) return { ok: true, response };
    const problem = (await response.text()).slice(-OUTPUT_CHARS);
    return { ok: false, problem: `The Sketch editor refused ${route}: ${problem}` };
  } catch (error) {
    return {
      ok: false,
      closed: error?.cause?.code === "ECONNREFUSED",
      problem: `The Sketch editor isn't answering on port ${port}. Ask the person to open this project in Sketch.`,
    };
  }
}

/** The editor's JSON answer to `route`, or {ok: false, problem}. */
async function editorJson(route, context, options) {
  const result = await editor(route, context, options);
  if (!result.ok) return result;
  try {
    return { ok: true, value: await result.response.json() };
  } catch {
    return { ok: false, problem: `The Sketch editor's answer to ${route} wasn't JSON.` };
  }
}

/** What a harness step answers: nothing when it worked, else a note Genex logs. */
const noteOf = (result) => (result.ok ? {} : { note: result.problem });

const TOOLS = {
  async build(args, context) {
    const scene = typeof args.scene === "string" && args.scene ? { scene: args.scene } : {};
    const result = await editorJson("build", context, { body: scene, timeout: CALL_MS });
    if (!result.ok) return result;
    const output = String(result.value.output ?? "").slice(-OUTPUT_CHARS);
    return result.value.ok === true ? { ok: true, output } : { ok: false, problem: output };
  },
  async "new-project"(args, context) {
    if (typeof args.name !== "string" || !/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(args.name))
      return { ok: false, problem: "Give the project a name of letters, digits, spaces, dashes or underscores." };
    const result = await editor("new", context, { body: { name: args.name } });
    return result.ok ? { ok: true } : result;
  },
  async "editor-state"(_args, context) {
    const state = await editorJson("status", context);
    // A closed editor: nobody is in it and nothing is unsaved, so the lock is free at once. An editor
    // that runs but whose answer can't be read gets {}: Genex can't tell, and it waits.
    if (!state.ok) return state.closed ? { personActive: false, unsaved: 0 } : {};
    return { personActive: state.value.focused === true, unsaved: Number(state.value.unsaved) || 0 };
  },
  async "open-editor"(_args, context) {
    const result = await editor("open", context, { body: {} });
    return result.ok ? {} : { block: result.problem };
  },
  async "save-scenes"(_args, context) {
    return noteOf(await editor("save-all", context, { body: {} }));
  },
  async capture(_args, context) {
    const timeout = context.observe?.withinMs ?? STEP_MS;
    const result = await editor("capture", context, { timeout });
    if (!result.ok) return { note: result.problem };
    const png = Buffer.from(await result.response.arrayBuffer());
    return { images: [png.toString("base64")] };
  },
  async "reload-scenes"(_args, context) {
    return noteOf(await editor("reload", context, { body: {} }));
  },
  async "check-editor"(_args, context) {
    const state = await editorJson("status", context);
    if (!state.ok) return { pending: true };
    return state.value.open ? {} : { block: "The Sketch editor has no project open." };
  },
  async "reopen-editor"(_args, context) {
    return noteOf(await editor("open", context, { body: {} }));
  },
};

export async function activate() {
  return {
    async tool(name, args, context) {
      const run = TOOLS[name];
      if (!run) throw new Error(`Sketch has no tool named ${name}`);
      return run(args ?? {}, context);
    },
  };
}
```
