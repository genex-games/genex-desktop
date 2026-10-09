/** Real Windows jobs: private files, offline execution, bounded host HTTP and cancellation. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { runWindowsCli } from "../../src/main/core/genex-cli-windows.ts";
import { ProcessSandbox, shellQuote } from "../../src/substrate/spawn.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

const ready = process.platform === "win32" && process.env.GENEX_WINDOWS_SANDBOX === "ready";
const options = { skip: ready ? false : "requires provisioned Windows SRT", timeout: 30_000 };
const TOKEN = "synthetic-private-cli-token";
const source = path.resolve(import.meta.dirname, "../../src/genex-host");

function completion() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rig() {
  const root = await tmpDir("genex-native-cli-");
  const resources = path.join(root, "resources");
  const work = path.join(root, "private-cli", "work");
  const other = path.join(root, "other");
  await Promise.all([mkdir(resources), mkdir(work, { recursive: true }), mkdir(other)]);
  for (const name of ["preload.mjs", "stdio-fetch.mjs"]) await cp(path.join(source, name), path.join(resources, name));
  const sandbox = await ProcessSandbox.create({
    writableRoots: [other],
    readableRoots: [resources],
    scratchDir: path.join(root, "sandbox-tmp"),
    secretPaths: [],
  });
  closeBeforeCleanup(() => sandbox.dispose());
  return { root, resources, work, other, sandbox };
}

async function server(handler: RequestListener) {
  const api = createServer(handler);
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  closeBeforeCleanup(async () => {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  const address = api.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function launch(r: Awaited<ReturnType<typeof rig>>, api: string, code: string, signal?: AbortSignal) {
  const script = path.join(r.resources, "probe.mjs");
  await writeFile(script, code);
  return runWindowsCli(
    {
      command: "owned Windows CLI probe",
      cwd: r.work,
      stdin: `GENEX_TOKEN=${TOKEN}\n`,
      env: { GENEX_API_URL: api, STUDIO_GENEX_CREDENTIAL_FD: "0" },
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      signal,
    },
    [process.execPath, "--import", pathToFileURL(path.join(r.resources, "preload.mjs")).href, script],
    r.resources,
    (request) => r.sandbox.runNative(request),
  );
}

it(
  "the offline CLI reaches its pinned API; neither job nor shared account reads the other's private files",
  options,
  async () => {
    const r = await rig();
    const privateFile = path.join(path.dirname(r.work), "private.txt");
    const otherFile = path.join(r.other, "other.txt");
    await writeFile(privateFile, "private to CLI");
    await writeFile(otherFile, "private to shared account");
    let control: unknown;
    let probeFailure: unknown;
    let authorized = false;
    const api = await server(async (request, response) => {
      authorized = request.headers.authorization === `Bearer ${TOKEN}`;
      try {
        const probeScript = path.join(r.resources, "shared-probe.cjs");
        await writeFile(
          probeScript,
          `const fs=require('node:fs');const p=${JSON.stringify(privateFile)};let read=false,write=false;try{fs.readFileSync(p);read=true}catch{}try{fs.writeFileSync(p,'wrong');write=true}catch{}console.log(JSON.stringify({read,write,user:require('node:os').userInfo().username}));`,
        );
        const probe = await r.sandbox.run({
          command: `${shellQuote(process.execPath.replaceAll("\\", "/"))} ${shellQuote(probeScript.replaceAll("\\", "/"))}`,
          cwd: r.other,
        });
        assert.equal(probe.code, 0, probe.stderr);
        control = JSON.parse(probe.stdout);
      } catch (error) {
        probeFailure = error;
      }
      response.setHeader("Content-Type", "application/json");
      response.end('{"ok":true}');
    });
    const result = await launch(
      r,
      api,
      `
    import fs from 'node:fs/promises'; import path from 'node:path'; import {createHash} from 'node:crypto';
    const origin=process.env.GENEX_API_URL;
    const key=createHash('sha256').update(origin).digest('hex');
    const record=JSON.parse(await fs.readFile(path.join('/__studio_genex_credentials__.origins',key+'.json'),'utf8'));
    let otherReadable=false;try{await fs.readFile(${JSON.stringify(otherFile)});otherReadable=true}catch{}
    const response=await fetch(origin+'/ok',{headers:{Authorization:'Bearer '+record.token}});
    console.log(JSON.stringify({ok:(await response.json()).ok,otherReadable}));
  `,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, otherReadable: false });
    assert.equal(probeFailure, undefined);
    assert.deepEqual(control, { read: false, write: false, user: "srt-sandbox" });
    assert.equal(authorized, true);
    assert.ok(!result.stdout.includes(TOKEN));
    for (const entry of await readdir(r.root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile())
        assert.ok(!(await readFile(path.join(entry.parentPath, entry.name), "utf8")).includes(TOKEN), entry.name);
    }
    assert.equal(await readFile(privateFile, "utf8"), "private to CLI");
    assert.equal(await readFile(otherFile, "utf8"), "private to shared account");
  },
);

it("a different origin and a redirect to it are refused before contacting that server", options, async () => {
  const r = await rig();
  let foreignCalls = 0;
  const foreign = await server((_request, response) => {
    foreignCalls++;
    response.end("wrong");
  });
  const api = await server((_request, response) => {
    response.writeHead(302, { Location: foreign });
    response.end();
  });
  const result = await launch(
    r,
    api,
    `
    let direct=false,redirect=false;
    try{await fetch(${JSON.stringify(foreign)});direct=true}catch{}
    try{await fetch(process.env.GENEX_API_URL+'/redirect');redirect=true}catch{}
    console.log(JSON.stringify({direct,redirect}));
  `,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { direct: false, redirect: false });
  assert.equal(foreignCalls, 0);
});

it("a CLI AbortSignal cancels the host HTTP request without waiting for the job deadline", options, async () => {
  const r = await rig();
  let closed: Promise<void> | undefined;
  const api = await server((request, response) => {
    if (request.url === "/wait") {
      request.on("error", () => {});
      closed = new Promise<void>((resolve) => response.once("close", resolve));
      return;
    }
    response.end("ready");
  });
  const result = await launch(
    r,
    api,
    `
    const stop=new AbortController();
    const pending=fetch(process.env.GENEX_API_URL+'/wait',{signal:stop.signal}).then(()=>false,()=>true);
    await fetch(process.env.GENEX_API_URL+'/ready');stop.abort();
    console.log(JSON.stringify({cancelled:await pending}));
  `,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cancelled: true });
  assert.ok(closed, "the host did start the cancellable request");
  await closed;
  assert.equal(result.timedOut, false);
});

it("Stop ends the native job and its pending host request", options, async () => {
  const r = await rig();
  const started = completion();
  const closed = completion();
  const api = await server((request, response) => {
    request.on("error", () => {});
    response.once("close", () => closed.resolve());
    started.resolve();
  });
  const stop = new AbortController();
  const pending = launch(r, api, "await fetch(process.env.GENEX_API_URL+'/wait');", stop.signal);
  await started.promise;
  stop.abort();
  const result = await pending;
  await closed.promise;
  assert.notEqual(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.sandboxed, true);
});

it("a long final output line remains bounded and reports truncation", options, async () => {
  const r = await rig();
  const result = await launch(r, "http://127.0.0.1:1", "process.stdout.write('x'.repeat(100_000));");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout), 64 * 1024);
  assert.equal(result.truncated, true);
});
