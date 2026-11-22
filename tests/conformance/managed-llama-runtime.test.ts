/**
 * Inkling 2 Mini on a Windows or Linux PC: Studio downloads mainline llama.cpp and the GGUF
 * itself, as it does Bonsai on a Mac, unpacks the build and runs Inkling with its own flags.
 * The build is a stand-in llama-server packed in a real archive, so the unpack is the real one.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { gzipSync } from "node:zlib";
import {
  INKLING_MODELS,
  INKLING_PROJECTOR,
  LLAMA_CPP_LINUX_BUILD,
  LLAMA_CPP_WINDOWS_BUILD,
  BONSAI_MODELS,
  managedModel,
  type DownloadFile,
} from "../../src/substrate/bonsai/manifest.ts";
import { BonsaiRuntime, type Machine } from "../../src/substrate/bonsai/runtime.ts";
import { BonsaiEngine } from "../../src/substrate/engines/bonsai.ts";
import { ModelInstallProblem } from "../../src/shared/model-install.ts";
import { errorCodeIn } from "../../src/shared/errors.ts";

const inkling = INKLING_MODELS[0].id;
const GIB = 1024 ** 3;
const LINUX_PC: Machine = { appleSilicon: false, memoryBytes: 32 * GIB, platform: "linux", arch: "x64" };
const [LINUX_ARCHIVE] = LLAMA_CPP_LINUX_BUILD.archives;

/** The stand-in server is a Node script with a shebang, which Windows cannot run. */
const POSIX_ONLY = { skip: process.platform === "win32" && "the stand-in build is a POSIX tarball" };

/**
 * A stand-in llama-server: it notes its arguments, then answers health, the chat template, the
 * tokenizer and one streamed reply, writing each request's path and body beside itself.
 */
const FAKE_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const here = path.dirname(process.argv[1]);
fs.writeFileSync(path.join(here, "argv.json"), JSON.stringify(process.argv.slice(2)));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const answers = {
  "/health": '{"status":"ok"}',
  "/apply-template": '{"prompt":"p"}',
  "/tokenize": '{"tokens":[1,2,3]}',
  "/v1/chat/completions": 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n',
};
require("node:http")
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      fs.appendFileSync(path.join(here, "requests.jsonl"), JSON.stringify({ url: req.url, body }) + "\\n");
      res.end(answers[req.url] ?? "");
    });
  })
  .listen(port, "127.0.0.1");
`;

/** One ustar header block for a regular file named `name` (any spelling, even absolute) of `size` bytes. */
function ustarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  assert.ok(Buffer.byteLength(name) <= 100, `entry name too long for the test archive: ${name}`);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
  );
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

/**
 * A gzip tarball whose entries are `entries` (path → text), written byte by byte so a hostile
 * entry name (absolute, a drive, `..`) goes in exactly as spelled and nothing lands on disk.
 */
async function tarball(root: string, entries: Record<string, string>): Promise<string> {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    blocks.push(ustarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  await mkdir(root, { recursive: true });
  const archive = path.join(root, "build.tar.gz");
  await writeFile(archive, gzipSync(Buffer.concat(blocks)));
  return archive;
}

/** A download that puts `archive` where the build's archive goes and sparse stand-ins of exact size for the rest. */
function stagedDownload(archive: string, fetched: string[]) {
  return async (file: DownloadFile, directory: string) => {
    fetched.push(file.name);
    const target = path.join(directory, file.name);
    await mkdir(directory, { recursive: true });
    if (file === LINUX_ARCHIVE) await copyFile(archive, target);
    else {
      await writeFile(target, "");
      await truncate(target, file.bytes);
    }
    return target;
  };
}

/** Every file under `root`, relative and sorted. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}

it("only an x64 Windows or Linux PC runs Inkling, on the Vulkan build for its platform; Bonsai stays on Apple Silicon", () => {
  const host = (platform: string, arch: string, appleSilicon = false) => ({ platform, arch, appleSilicon });
  const runs = (id: string, h: ReturnType<typeof host>) => managedModel(id).runtimeFor(h)?.name ?? null;
  assert.equal(runs(inkling, host("win32", "x64")), LLAMA_CPP_WINDOWS_BUILD.name);
  assert.equal(runs(inkling, host("linux", "x64")), LLAMA_CPP_LINUX_BUILD.name);
  for (const h of [
    host("darwin", "arm64", true),
    host("darwin", "x64"),
    host("win32", "arm64"),
    host("linux", "arm64"),
  ])
    assert.equal(runs(inkling, h), null, `${h.platform}/${h.arch}`);
  assert.equal(runs(BONSAI_MODELS[0].id, host("win32", "x64")), null);
  assert.ok(runs(BONSAI_MODELS[0].id, host("darwin", "arm64", true)));
});

it(
  "a PC downloads llama.cpp and Inkling, unpacks the build and runs Inkling's flags and reasoning control",
  POSIX_ONLY,
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inkling-pc-"));
    const fetched: string[] = [];
    const archive = await tarball(path.join(root, "src"), { "build/bin/llama-server": FAKE_SERVER });
    const runtime = new BonsaiRuntime(path.join(root, "runtime"), {
      machine: LINUX_PC,
      download: stagedDownload(archive, fetched),
    });
    const engine = new BonsaiEngine({ root, runtime });
    try {
      assert.equal(await runtime.installed(inkling), false);
      await runtime.install(inkling, () => {});
      assert.deepEqual(fetched, [LINUX_ARCHIVE.name, INKLING_MODELS[0].file.name, INKLING_PROJECTOR.name]);
      assert.equal(await runtime.installed(inkling), true);
      const binary = await runtime.binary(inkling);
      assert.equal(binary, path.join(root, "runtime", LLAMA_CPP_LINUX_BUILD.name, "build", "bin", "llama-server"));

      const reply = await engine.complete({ model: inkling, messages: [{ role: "user", content: "hi" }] });
      assert.equal(reply.message.content, "ok");
      const argv: string[] = JSON.parse(await readFile(path.join(path.dirname(binary), "argv.json"), "utf8"));
      const flag = (name: string) => argv[argv.indexOf(name) + 1];
      assert.equal(flag("--model"), path.join(root, "runtime", "models", INKLING_MODELS[0].file.name));
      assert.equal(flag("--mmproj"), path.join(root, "runtime", "models", INKLING_PROJECTOR.name));
      assert.equal(flag("--ctx-size"), "65536");
      assert.ok(argv.includes("--jinja"));
      assert.ok(!argv.includes("--n-gpu-layers"), "llama-server's --fit splits it between the card and RAM");
      assert.ok(!argv.includes("--reasoning-budget"), "Inkling's effort is its chat template's");

      const requests = (await readFile(path.join(path.dirname(binary), "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const completion = JSON.parse(requests.find((r) => r.url === "/v1/chat/completions").body);
      assert.deepEqual(completion.chat_template_kwargs, { reasoning_effort: "low" });
      assert.equal(completion.reasoning_budget_tokens, undefined);
      assert.deepEqual([completion.top_p, completion.top_k, completion.min_p], [1, 0, 0]);
      assert.equal((await engine.models())[0]?.contextWindow, 65536);
    } finally {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("a machine without a build for the model is refused before anything is fetched", async () => {
  const cases: Array<[string, Machine, string]> = [
    [inkling, { appleSilicon: true, memoryBytes: 64 * GIB }, ModelInstallProblem.UnsupportedMachine],
    [
      inkling,
      { appleSilicon: false, memoryBytes: 64 * GIB, platform: "win32", arch: "arm64" },
      ModelInstallProblem.UnsupportedMachine,
    ],
    [
      inkling,
      { appleSilicon: false, memoryBytes: 64 * GIB, platform: "darwin", arch: "x64" },
      ModelInstallProblem.UnsupportedMachine,
    ],
    [BONSAI_MODELS[0].id, LINUX_PC, ModelInstallProblem.NeedsAppleSilicon],
  ];
  for (const [id, machine, problem] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "managed-refused-"));
    const fetched: string[] = [];
    const runtime = new BonsaiRuntime(root, { machine, download: stagedDownload("", fetched) });
    try {
      const failure = await runtime.install(id, () => {}).catch((err: unknown) => err);
      assert.equal(errorCodeIn(ModelInstallProblem, failure), problem, `${id} on ${JSON.stringify(machine)}`);
      assert.deepEqual(fetched, [], "nothing was fetched");
      assert.deepEqual(await filesUnder(root), [], "nothing was written");
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});

it(
  "a build archive with an entry that would land outside its folder is refused, unpacking nothing",
  POSIX_ONLY,
  async () => {
    const escapes = (root: string) => [
      "../escaped",
      path.join(root, "absolute-escape"),
      "C:/drive-escape",
      "build\\..\\..\\backslash-escape",
    ];
    const probe = await mkdtemp(path.join(os.tmpdir(), "inkling-hostile-"));
    for (const entry of escapes(probe)) {
      const root = await mkdtemp(path.join(probe, "case-"));
      const archive = await tarball(path.join(root, "src"), { "build/bin/llama-server": FAKE_SERVER, [entry]: "x" });
      const runtime = new BonsaiRuntime(path.join(root, "runtime"), {
        machine: LINUX_PC,
        download: stagedDownload(archive, []),
      });
      try {
        const failure = await runtime.install(inkling, () => {}).catch((err: unknown) => err);
        assert.equal(errorCodeIn(ModelInstallProblem, failure), ModelInstallProblem.UnsafeArchive, entry);
        const unpacked = (await filesUnder(path.join(root, "runtime"))).filter((f) => !/^(downloads|models)\//.test(f));
        assert.deepEqual(
          unpacked.filter((f) => f !== "install-job.json"),
          [],
          `${entry}: nothing unpacked`,
        );
        assert.equal(await runtime.binary(inkling), null);
      } finally {
        await runtime.dispose();
      }
    }
    const leaked = (await readdir(probe)).filter((name) => !name.startsWith("case-"));
    assert.deepEqual(leaked, [], "no entry escaped its folder");
    await rm(probe, { recursive: true, force: true });
  },
);

it("deleting a PC's only Inkling frees its weights, projector and llama.cpp build", POSIX_ONLY, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inkling-remove-"));
  const archive = await tarball(path.join(root, "src"), { "build/bin/llama-server": FAKE_SERVER });
  const runtime = new BonsaiRuntime(path.join(root, "runtime"), {
    machine: LINUX_PC,
    download: stagedDownload(archive, []),
  });
  try {
    await runtime.install(inkling, () => {});
    await runtime.remove(inkling);
    assert.equal(await runtime.installed(inkling), false);
    assert.equal(await runtime.binary(inkling), null);
    assert.deepEqual(await filesUnder(path.join(root, "runtime")), ["runtime.log"]);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
