/**
 * The Genex CLI's credential, as Studio's preload hands it over. The pinned CLI (1.35+) reads a
 * per-origin sign-in record beside its env file; Studio serves exactly one such record, for the
 * API origin it pinned for the run (`GENEX_API_URL`), from the token it pipes in. The CLI's own
 * origin binding stays whole: a run aimed at any other origin finds no record and sends no token,
 * and nothing lands on disk beside the virtual env path or in the CLI's HOME.
 *
 * Everything runs the real pinned CLI against local fixture APIs; nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { genexCliEnv, genexCliPath, runGenexCli } from "../../src/plugins/genex/cli.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";

/** The virtual env path the CLI is pointed at; never a real file. */
const VIRTUAL_ENV = "/__studio_genex_credentials__";
const PRELOAD = path.resolve(import.meta.dirname, "../../src/genex-host/preload.mjs");
const TOKEN = "synthetic-origin-token";
const CLI_TIMEOUT_MS = 30_000;

const credits = { balance: 100, spendable: 100, reserved: 0, unlimited: false, prices: { model: 3 } };

/** A fixture API that answers the credits snapshot and records every request it saw. */
async function recordingApi(): Promise<{ api: GenexFixtureApi; seen: GenexRequest[] }> {
  const seen: GenexRequest[] = [];
  const api = await startGenexFixtureApi((request, reply) => {
    seen.push(request);
    if (request.url === "/api/credits/me") return reply.json(credits);
  });
  return { api, seen };
}

/** Every file under `dir`, path to bytes, so a run can be proven to have written nothing. */
async function tree(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, full)] = entry.isFile() ? await readFile(full, "base64") : "dir";
  }
  return files;
}

/** A contained HOME whose update check is already fresh, so the CLI neither fetches nor writes it. */
async function freshHome(root: string): Promise<string> {
  const home = path.join(root, "home");
  await mkdir(path.join(home, ".genex"), { recursive: true });
  const cache = { checkedAt: new Date().toISOString(), latest: {} };
  await writeFile(path.join(home, ".genex/update-check.json"), `${JSON.stringify(cache)}\n`);
  return home;
}

async function virtualSiblingsAbsent(): Promise<void> {
  for (const sibling of [`${VIRTUAL_ENV}.origins`, `${VIRTUAL_ENV}.auth`, VIRTUAL_ENV]) {
    await assert.rejects(lstat(sibling), { code: "ENOENT" }, `${sibling} must never exist`);
  }
}

interface PreloadedRun {
  /** `GENEX_API_URL`: the origin Studio pinned for this run; undefined leaves it unset. */
  pinned: string | undefined;
  /** The CLI's own `--api-url`. */
  flag: string;
  /** What arrives on the credential descriptor. */
  payload: string;
  /** `STUDIO_GENEX_CREDENTIAL_FD`; undefined leaves it unset (fd 3). */
  fd?: string;
  home: string;
  cwd: string;
}

/** `genex budget --json` behind the preload, exactly as `runGenexCli` builds it, but with each part free. */
function runPreloaded(run: PreloadedRun): Promise<{ code: number | null; out: string }> {
  const env = { ...genexCliEnv(process.env, { api: run.pinned ?? "", home: run.home }) };
  if (run.pinned === undefined) delete env.GENEX_API_URL;
  if (run.fd !== undefined) env.STUDIO_GENEX_CREDENTIAL_FD = run.fd;
  const viaStdin = run.fd === "0";
  const args = [
    "--import",
    pathToFileURL(PRELOAD).href,
    genexCliPath(),
    "budget",
    "--env",
    VIRTUAL_ENV,
    "--api-url",
    run.flag,
    "--json",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: run.cwd,
      env,
      stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe", viaStdin ? "ignore" : "pipe"],
    });
    const pipe = viaStdin ? child.stdin : child.stdio[3];
    if (pipe && "end" in pipe) {
      pipe.on("error", () => {});
      pipe.end(run.payload);
    }
    let out = "";
    child.stdout?.on("data", (b) => (out += b));
    child.stderr?.on("data", (b) => (out += b));
    const timer = setTimeout(() => child.kill("SIGKILL"), CLI_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe("the Genex CLI's per-origin credential record", () => {
  let target: { api: GenexFixtureApi; seen: GenexRequest[] };
  let other: { api: GenexFixtureApi; seen: GenexRequest[] };
  let root: string;

  before(async () => {
    target = await recordingApi();
    other = await recordingApi();
    root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-credential-"));
  });
  after(async () => {
    await target.api.close();
    await other.api.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A fresh HOME and working folder for one run, and their contents before it. */
  async function scene(name: string) {
    const dir = path.join(root, name);
    const cwd = path.join(dir, "work");
    await mkdir(cwd, { recursive: true });
    const home = await freshHome(dir);
    return { cwd, home, before: await tree(dir), dir };
  }

  const carriesToken = (seen: GenexRequest[]) => seen.some((r) => r.authorization.includes(TOKEN));

  it("authenticates a run pointed at the API Studio pinned, and writes nothing beside the virtual path or in HOME", async () => {
    const { cwd, home, before, dir } = await scene("pinned");
    target.seen.length = 0;
    const answer = (await runGenexCli({
      cli: genexCliPath(),
      preload: PRELOAD,
      api: target.api.url,
      token: TOKEN,
      cwd,
      args: ["budget"],
      signal: undefined,
      timeoutMs: CLI_TIMEOUT_MS,
      parse: true,
      home,
    })) as { balance?: number };
    assert.equal(answer.balance, credits.balance);
    assert.ok(
      target.seen.some((r) => r.url === "/api/credits/me" && r.authorization === `Bearer ${TOKEN}`),
      "the pinned origin received the token",
    );
    assert.deepEqual(await tree(dir), before, "the run's HOME and working folder are byte-identical");
    await virtualSiblingsAbsent();
  });

  it("serves the record over a descriptor named by STUDIO_GENEX_CREDENTIAL_FD", async () => {
    const { cwd, home, before, dir } = await scene("stdin");
    target.seen.length = 0;
    const run = await runPreloaded({
      pinned: target.api.url,
      flag: target.api.url,
      payload: `GENEX_TOKEN=${TOKEN}\n`,
      fd: "0",
      home,
      cwd,
    });
    assert.equal(run.code, 0, run.out);
    assert.ok(carriesToken(target.seen), "the token arrived on stdin and reached the pinned origin");
    assert.deepEqual(await tree(dir), before);
  });

  // Each row pins one thing and asks the CLI for another (or hands it nothing usable): the CLI
  // must find no record, send no token anywhere, and leave no file behind.
  const refused: { name: string; pinned: (api: string, other: string) => string | undefined; payload?: string }[] = [
    { name: "a run aimed at a different origin", pinned: (_api, otherApi) => otherApi },
    { name: "no pinned origin", pinned: () => undefined },
    { name: "a pinned URL carrying credentials", pinned: (api) => api.replace("http://", "http://user:pass@") },
    { name: "a pinned URL with a path", pinned: (api) => `${api}/api` },
    { name: "a pinned URL with a query", pinned: (api) => `${api}/?next=1` },
    { name: "a pinned URL that is not a URL", pinned: () => "not a url" },
    { name: "a locked account's empty pipe", pinned: (api) => api, payload: "" },
    { name: "a payload with no token line", pinned: (api) => api, payload: `TOKEN=${TOKEN}\n` },
    { name: "an empty token line", pinned: (api) => api, payload: "GENEX_TOKEN=\n" },
  ];
  for (const row of refused) {
    it(`sends no token for ${row.name}`, async () => {
      const { cwd, home, before, dir } = await scene(row.name.replaceAll(/\W+/g, "-"));
      target.seen.length = 0;
      other.seen.length = 0;
      const run = await runPreloaded({
        pinned: row.pinned(target.api.url, other.api.url),
        flag: target.api.url,
        payload: row.payload ?? `GENEX_TOKEN=${TOKEN}\n`,
        home,
        cwd,
      });
      assert.notEqual(run.code, 0, "the CLI reports it is not signed in");
      assert.ok(!carriesToken(target.seen), "the requested origin never saw the token");
      assert.ok(!carriesToken(other.seen), "the pinned origin was not contacted with it either");
      assert.deepEqual(await tree(dir), before);
      await virtualSiblingsAbsent();
    });
  }

  it("keeps an uppercase scheme and a trailing slash on the pinned origin", async () => {
    const { cwd, home } = await scene("normalized");
    target.seen.length = 0;
    const run = await runPreloaded({
      pinned: `${target.api.url.replace("http://", "HTTP://")}/`,
      flag: target.api.url,
      payload: `GENEX_TOKEN=${TOKEN}\n`,
      home,
      cwd,
    });
    assert.equal(run.code, 0, run.out);
    assert.ok(carriesToken(target.seen));
  });

  // A descriptor that is not a plain number, or is stdout/stderr, stops the preload before the CLI
  // runs: no request is made at all.
  for (const fd of ["1", "2", "-1", "abc", "3 ", "0x3", "", "4.5"]) {
    it(`refuses STUDIO_GENEX_CREDENTIAL_FD=${JSON.stringify(fd)} before the CLI runs`, async () => {
      const { cwd, home, before, dir } = await scene(`fd-${Buffer.from(fd).toString("hex")}`);
      target.seen.length = 0;
      const run = await runPreloaded({
        pinned: target.api.url,
        flag: target.api.url,
        payload: `GENEX_TOKEN=${TOKEN}\n`,
        fd,
        home,
        cwd,
      });
      assert.notEqual(run.code, 0);
      assert.deepEqual(target.seen, [], "the CLI never started");
      assert.deepEqual(await tree(dir), before);
    });
  }
});
