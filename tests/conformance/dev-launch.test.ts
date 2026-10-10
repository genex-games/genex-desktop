import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { safeChild, readVersion } from "../../scripts/studio-dev/files.mjs";
import { allocateProfile, validateProfile, assertStopped } from "../../scripts/studio-dev/ownership.mjs";
import { DevErrorCode, operationSchema } from "../../src/main/dev/protocol.ts";
test("build identity includes project licenses and refuses notice changes during publication", async (t) => {
  const { sourceIdentity, publishBuild, maintained } = await import("../../scripts/studio-dev/files.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-notices-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, ".studio-dev/builds/b-notices");
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules/electron"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) fs.writeFileSync(path.join(root, file), "{}");
  fs.writeFileSync(path.join(root, "node_modules/electron/package.json"), '{"version":"43.7.6"}');
  fs.writeFileSync(path.join(root, "LICENSE"), "Fixture project license");
  fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "Fixture source notices");
  const before = sourceIdentity(root);
  assert.ok(maintained(root).includes("LICENSE"));
  assert.ok(maintained(root).includes("THIRD-PARTY-NOTICES.md"));
  fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "Changed attribution");
  assert.throws(() => publishBuild(root, output, "b-notices", before), /inputs changed/);
  assert.equal(fs.existsSync(path.join(output, "build.json")), false);
});
test("owned profiles reject traversal, aliases, copied ownership, silent reuse and provider changes", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-owner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of ["..", "../normal", "/tmp", "a/../b", "a//b"]) assert.throws(() => safeChild(root, rel));
  fs.symlinkSync(os.tmpdir(), path.join(root, "alias"));
  assert.throws(() => safeChild(root, "alias/games"), /symlink/);
  const a = allocateProfile(root, "a", "fixture", "app-basics");
  const b = allocateProfile(root, "b", "fixture", "app-basics");
  assert.notEqual(a.core, b.core);
  assert.notEqual(a.games, b.games);
  assert.throws(() => allocateProfile(root, "a", "fixture", "app-basics"), /reuse/);
  assert.throws(() => allocateProfile(root, "a", "live", null, true), /change provider/);
  fs.writeFileSync(
    path.join(a.root, "lease.json"),
    JSON.stringify({ version: 1, ownerId: a.ownerId, pid: process.pid }),
  );
  assert.throws(() => assertStopped(a), /running/);
  fs.writeFileSync(path.join(b.root, "owner.json"), JSON.stringify({ ...a, root: b.root, profileId: "b" }));
  assert.throws(() => validateProfile(root, "b"), /copied/);
  fs.writeFileSync(path.join(root, "unknown.json"), '{"version":2}');
  assert.throws(() => readVersion(path.join(root, "unknown.json")), /version/);
});
test("closed controller schema rejects privileged fields, eval, unbounded work and unsafe artifacts", () => {
  for (const value of [
    { method: "evaluate", params: { expression: "process.exit()" } },
    { method: "stop", params: { pid: 42 } },
    { method: "capture", params: { surface: "desktop", name: "../private" } },
    { method: "click", params: { selector: "button", webContentsId: 1 } },
    { method: "trace.start", params: { traceId: "trace", durationMs: 600000, categories: ["*"] } },
    {
      method: "game.input",
      params: {
        actions: [
          { type: "wait", ms: 8000 },
          { type: "wait", ms: 8000 },
        ],
      },
    },
  ])
    assert.equal(operationSchema.safeParse(value).success, false);
  assert.equal(operationSchema.safeParse({ method: "click", params: { selector: "button" } }).success, true);
});
test("build publication refuses inputs changed during build and never publishes a ready manifest", async (t) => {
  const { sourceIdentity, publishBuild } = await import("../../scripts/studio-dev/files.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-build-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, ".studio-dev/builds/b-test");
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules/electron"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "node_modules/electron/package.json"), '{"version":"43.4.1"}');
  fs.writeFileSync(path.join(root, "src/a.ts"), "before");
  const before = sourceIdentity(root);
  fs.writeFileSync(path.join(root, "src/a.ts"), "after");
  assert.throws(() => publishBuild(root, output, "b-test", before), /changed during build/);
  assert.equal(fs.existsSync(path.join(output, "build.json")), false);
  publishBuild(root, output, "b-test", sourceIdentity(root));
  assert.equal(readVersion(path.join(output, "build.json")).flags.developer, true);
});
test("lost debugger ownership is explicit and does not silently reattach", async () => {
  const { DesktopControl } = await import("../../src/main/dev/control.ts");
  let attached = false,
    calls = 0;
  const wc = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand: async () => {
        calls++;
        return {};
      },
    },
  };
  const control = new DesktopControl();
  await control.cdp(wc as any, "Profiler.enable");
  attached = false;
  await assert.rejects(control.cdp(wc as any, "Profiler.start"), /restart the owned session/);
  assert.equal(calls, 1);
});
test("interrupted controller response cannot be reported as a successful capture", async (t) => {
  const { createServer } = await import("node:net");
  const { request } = await import("../../scripts/studio-dev/client.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-test-"));
  // Node's local sockets are named pipes on Windows, which live in their own namespace.
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, "s");
  const server = createServer((client) => client.once("data", () => client.end('{"version":1')));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    request(
      { instanceId: "00000000-0000-4000-8000-000000000001", capability: "0".repeat(64), socket },
      { method: "capture", params: { surface: "desktop", name: "interrupted" } },
    ),
    /closed before response/,
  );
});
test("an input whose target is still opening is tried again until reachable; any other refusal is final", async (t) => {
  const { createServer } = await import("node:net");
  const { requestWhenReachable } = await import("../../scripts/studio-dev/client.ts");
  const { tmpDir } = await import("../helpers/tmp.ts");
  const refused = (code: string) => ({ ok: false, error: { code, message: code } });
  const reached = { ok: true, value: { dispatched: true } };
  let answers: object[] = [];
  let requests = 0;
  const dir = await tmpDir("ipc-reach-");
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, "s");
  const server = createServer((client) =>
    client.once("data", (line) => {
      const { requestId } = JSON.parse(line.toString());
      const answer = answers[Math.min(requests++, answers.length - 1)];
      client.end(`${JSON.stringify({ version: 1, requestId, ...answer })}\n`);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const descriptor = { instanceId: "00000000-0000-4000-8000-000000000001", capability: "0".repeat(64), socket };
  const click = { method: "click", params: { selector: '[data-chat-action="export"]' } } as const;
  const cases = [
    // A modal dialog or menu that has just opened takes pointer input one render later.
    { answers: [refused(DevErrorCode.TargetNotVisible), reached], timeoutMs: 5000, requests: 2 },
    {
      answers: [refused(DevErrorCode.AmbiguousSelector), reached],
      timeoutMs: 5000,
      requests: 1,
      refusal: DevErrorCode.AmbiguousSelector,
    },
    {
      answers: [refused(DevErrorCode.TargetNotVisible), reached],
      timeoutMs: 0,
      requests: 1,
      refusal: DevErrorCode.TargetNotVisible,
    },
  ];
  for (const [n, row] of cases.entries()) {
    answers = row.answers;
    requests = 0;
    const sent = requestWhenReachable(descriptor, click, row.timeoutMs);
    if (row.refusal) await assert.rejects(sent, (e: { code?: string }) => e.code === row.refusal, `case ${n}`);
    else assert.deepEqual(await sent, reached.value, `case ${n}`);
    assert.equal(requests, row.requests, `case ${n}`);
  }
});
test("source fingerprints re-read only files whose size or modification time changed", async (t) => {
  const { fingerprints } = await import("../../scripts/studio-dev/files.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-prints-")));
  t.after(() => {
    fs.chmodSync(path.join(root, "kept.ts"), 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const kept = path.join(root, "kept.ts");
  const edited = path.join(root, "edited.ts");
  fs.writeFileSync(kept, "export const a = 1;\n");
  fs.writeFileSync(edited, "export const b = 1;\n");
  const before = fingerprints(root, ["kept.ts", "edited.ts"]);
  // An unchanged file is answered from what was read before: unreadable now, it still prints.
  fs.chmodSync(kept, 0);
  const sameSize = "export const b = 2;\n";
  fs.writeFileSync(edited, sameSize);
  const later = new Date(fs.statSync(edited).mtimeMs + 2000);
  fs.utimesSync(edited, later, later);
  const after = fingerprints(root, ["kept.ts", "edited.ts"]);
  assert.equal(after["kept.ts"], before["kept.ts"]);
  assert.notEqual(after["edited.ts"], before["edited.ts"]);
  fs.writeFileSync(edited, "export const b = 1;\n");
  assert.equal(fingerprints(root, ["edited.ts"])["edited.ts"], before["edited.ts"]);
});
