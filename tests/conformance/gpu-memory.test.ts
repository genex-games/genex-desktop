/**
 * Graphics memory for the local-model fit: what a PC's cards hold, read the way each platform
 * reports it. A wrong answer here is a wrong Download: too small hides models the card runs, too
 * large offers ones it cannot load. So every unreadable answer must read as no card at all.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { detectGpus, parseNvidiaSmi, parseRegistryGpus, type ProbeRun } from "../../src/substrate/gpu-memory.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CLASS = "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";

/** `reg query <class> /s /v HardwareInformation.qwMemorySize` as reg.exe prints it (CRLF). */
const REG_MEMORY = [
  "",
  `${CLASS}\\0000`,
  "    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000",
  "",
  `${CLASS}\\0001`,
  "    HardwareInformation.qwMemorySize    REG_QWORD    0x20000000",
  "",
  `${CLASS}\\0002`,
  "    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000",
  "",
  "End of search: 3 match(es) found.",
  "",
].join("\r\n");

/** `reg query <class> /s /v DriverDesc`: 0000 is the card in the machine, 0002 one swapped out. */
const REG_NAMES = [
  "",
  `${CLASS}\\0000`,
  "    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4090",
  "",
  `${CLASS}\\0001`,
  "    DriverDesc    REG_SZ    Intel(R) UHD Graphics 770",
  "",
  `${CLASS}\\0002`,
  "    DriverDesc    REG_SZ    NVIDIA GeForce RTX 3070",
  "",
  `${CLASS}\\0003`,
  "    DriverDesc    REG_SZ    Microsoft Basic Display Adapter",
  "",
  "End of search: 4 match(es) found.",
  "",
].join("\r\n");

/** A runner that answers each program by its arguments and records what was run. */
function recording(answers: (file: string, args: readonly string[]) => string) {
  const runs: Array<{ file: string; args: readonly string[] }> = [];
  const run: ProbeRun = async (file, args) => {
    runs.push({ file, args });
    return answers(file, args);
  };
  return { run, runs };
}

/** A PC without NVIDIA's tool answering: the registry's two queries get `memory` and `names`. */
const registryAnswers = (memory: string, names: string) => (file: string, args: readonly string[]) => {
  if (file.endsWith("nvidia-smi.exe")) return "";
  return args.includes("DriverDesc") ? names : memory;
};

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: MiB, one card a line. */
const SMI = "NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 3090, 24576\nNVIDIA T400, [N/A]\n";

describe("graphics memory on Windows", () => {
  it("reads each adapter's dedicated memory and driver name from the registry", () => {
    assert.deepEqual(parseRegistryGpus(REG_MEMORY, REG_NAMES), [
      { name: "NVIDIA GeForce RTX 4090", memoryGb: 24 },
      { name: "Intel(R) UHD Graphics 770", memoryGb: 0.5 },
      { name: "NVIDIA GeForce RTX 3070", memoryGb: 16 },
    ]);
  });

  it("counts NVIDIA's cards from nvidia-smi in System32, and then never reads the registry", async () => {
    // The registry keeps a swapped-out card's key; nvidia-smi lists only the cards in the machine.
    const { run, runs } = recording((file) => (file.endsWith("nvidia-smi.exe") ? SMI : REG_MEMORY));
    const gpus = await detectGpus({ platform: "win32", env: { SystemRoot: "D:\\Win" }, run });
    assert.deepEqual(gpus, [
      { name: "NVIDIA GeForce RTX 4090", memoryGb: 24 },
      { name: "NVIDIA GeForce RTX 3090", memoryGb: 24 },
    ]);
    assert.deepEqual(
      runs.map((r) => r.file),
      ["D:\\Win\\System32\\nvidia-smi.exe"],
      "a PATH entry never stands in for nvidia-smi",
    );
  });

  it("without NVIDIA, counts only the largest registry card, by reg.exe's full path", async () => {
    const { run, runs } = recording(registryAnswers(REG_MEMORY, REG_NAMES));
    const gpus = await detectGpus({ platform: "win32", env: { SystemRoot: "D:\\Win" }, run });
    assert.deepEqual(gpus, [{ name: "NVIDIA GeForce RTX 4090", memoryGb: 24 }]);
    const registry = runs.filter((r) => !r.file.endsWith("nvidia-smi.exe"));
    assert.equal(registry.length, 2);
    for (const { file, args } of registry) {
      assert.equal(file, "D:\\Win\\System32\\reg.exe", "a PATH entry never stands in for reg.exe");
      assert.equal(args[0], "query");
      assert.ok(args.includes("/s"));
    }
  });

  it("reads a key whose name the driver does not give as a GPU", () => {
    const memory = `${CLASS}\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x300000000\r\n`;
    assert.deepEqual(parseRegistryGpus(memory, ""), [{ name: "GPU", memoryGb: 12 }]);
  });

  it("reads anything else as no card", async () => {
    const unreadable: Array<[string, string]> = [
      ["nothing printed", ""],
      ["a localized error", "ERROR: Zugriff verweigert.\r\n"],
      ["a value that is not hex", `${CLASS}\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    lots\r\n`],
      ["a zero size", `${CLASS}\\0000\r\n    HardwareInformation.qwMemorySize    REG_QWORD    0x0\r\n`],
      ["a value before any key", "    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000\r\n"],
      [
        "a binary size of an old driver",
        `${CLASS}\\0000\r\n    HardwareInformation.MemorySize    REG_BINARY    00000080\r\n`,
      ],
    ];
    for (const [label, memory] of unreadable) {
      const { run } = recording(registryAnswers(memory, REG_NAMES));
      assert.deepEqual(await detectGpus({ platform: "win32", env: {}, run }), [], label);
    }
    const failing: ProbeRun = async () => {
      throw new Error("spawn EACCES");
    };
    assert.deepEqual(await detectGpus({ platform: "win32", env: {}, run: failing }), []);
  });
});

describe("graphics memory on Linux", () => {
  it("reads NVIDIA's cards from nvidia-smi, in MiB", () => {
    assert.deepEqual(parseNvidiaSmi(SMI), [
      { name: "NVIDIA GeForce RTX 4090", memoryGb: 24 },
      { name: "NVIDIA GeForce RTX 3090", memoryGb: 24 },
    ]);
    assert.deepEqual(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the driver.\n"), []);
  });

  /** A drm folder with an AMD card, an integrated carve-out, an unnamed AMD card and a connector. */
  async function drmFolder(): Promise<string> {
    const drm = await tmpDir("gpu-drm-");
    const card = async (name: string, files: Record<string, string>) => {
      await mkdir(path.join(drm, name, "device"), { recursive: true });
      for (const [file, text] of Object.entries(files)) await writeFile(path.join(drm, name, "device", file), text);
    };
    await card("card0", { mem_info_vram_total: `${16 * 1024 ** 3}\n`, product_name: "AMD Radeon RX 7800 XT\n" });
    await card("card1", { mem_info_vram_total: `${512 * 1024 ** 2}\n` });
    await card("card2", { mem_info_vram_total: `${20 * 1024 ** 3}\n` });
    await card("card3", { vendor: "0x8086\n" });
    await card("card0-DP-1", { mem_info_vram_total: `${64 * 1024 ** 3}\n` });
    return drm;
  }

  it("counts NVIDIA's cards alone where there are any: Ollama does not split a model across vendors", async () => {
    const { run, runs } = recording((file) => (file === "nvidia-smi" ? SMI : ""));
    const gpus = await detectGpus({ platform: "linux", run, drmRoot: await drmFolder() });
    assert.deepEqual(gpus, [
      { name: "NVIDIA GeForce RTX 4090", memoryGb: 24 },
      { name: "NVIDIA GeForce RTX 3090", memoryGb: 24 },
    ]);
    assert.deepEqual(
      runs.map((r) => r.file),
      ["nvidia-smi"],
    );
  });

  it("without NVIDIA, counts every amdgpu card in the machine, leaving out a small carve-out", async () => {
    const { run } = recording(() => "");
    assert.deepEqual(await detectGpus({ platform: "linux", run, drmRoot: await drmFolder() }), [
      { name: "AMD Radeon", memoryGb: 20 },
      { name: "AMD Radeon RX 7800 XT", memoryGb: 16 },
    ]);
  });

  it("finds no card where neither nvidia-smi nor the drm folder answers", async () => {
    const { run } = recording(() => "");
    assert.deepEqual(
      await detectGpus({ platform: "linux", run, drmRoot: path.join(await tmpDir("gpu-none-"), "gone") }),
      [],
    );
  });
});

it("answers no card when a probe never finishes, at its deadline", async () => {
  // nvidia-smi stuck on a card that fell off the bus ignores the timeout's kill and never exits.
  const stuck: ProbeRun = () => new Promise<string>(() => {});
  for (const platform of ["linux", "win32"] as const)
    assert.deepEqual(await detectGpus({ platform, env: {}, run: stuck, deadlineMs: 20 }), [], platform);
});

it("never probes a Mac: Apple Silicon memory is already counted as RAM", async () => {
  const { run, runs } = recording(() => REG_MEMORY);
  assert.deepEqual(await detectGpus({ platform: "darwin", run }), []);
  assert.equal(runs.length, 0);
});
