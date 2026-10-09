import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanPackage } from "../../src/substrate/plugins/scan.ts";
import { inspectPackage } from "../../src/substrate/plugins/manifest.ts";
import type { PluginScan } from "../../src/shared/plugins.ts";

const source = path.resolve("src/plugins/example");
/** Copy the bundled example, apply an edit, then scan exactly what an install would scan. */
async function scanned(
  edit?: (dir: string) => Promise<void>,
): Promise<{ scan: PluginScan; dir: string; clean: () => Promise<void> }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "studio-scan-")),
    dir = path.join(base, "package");
  await cp(source, dir, { recursive: true });
  if (edit) await edit(dir);
  const scan = await scanPackage(dir, await inspectPackage(dir));
  return {
    scan,
    dir,
    clean: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}
const appendBackend = (text: string) => async (dir: string) => {
  await writeFile(path.join(dir, "backend.mjs"), `${await readFile(path.join(dir, "backend.mjs"), "utf8")}\n${text}\n`);
};
const withManifest = (mutate: (m: any) => void, text?: string) => async (dir: string) => {
  const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  mutate(m);
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m, null, 2));
  if (text) await appendBackend(text)(dir);
};
const rules = (scan: PluginScan) => scan.findings.map((f) => f.rule);

test("the bundled example scans safe, which is what the install dialog promises", async () => {
  const f = await scanned();
  try {
    assert.equal(f.scan.verdict, "safe");
    assert.deepEqual(f.scan.findings, []);
    assert.equal(f.scan.files, 3);
    assert.ok(f.scan.bytes > 0);
    assert.ok(!Number.isNaN(Date.parse(f.scan.scannedAt)));
  } finally {
    await f.clean();
  }
});
test("spawning processes and running generated code read dangerous", async () => {
  const child = await scanned(
    appendBackend("import {execSync} from 'node:child_process';\nexport const run=()=>execSync('ls');"),
  );
  try {
    assert.equal(child.scan.verdict, "dangerous");
    const finding = child.scan.findings.find((x) => x.rule === "child-process")!;
    assert.equal(finding.severity, "dangerous");
    assert.equal(finding.file, "backend.mjs");
    assert.ok(finding.line > 1);
    assert.match(finding.excerpt, /child_process/);
  } finally {
    await child.clean();
  }
  const dynamic = await scanned(
    appendBackend("export const a=(s)=>eval(s);\nexport const b=new Function('return 1');"),
  );
  try {
    assert.equal(dynamic.scan.verdict, "dangerous");
    const lines = dynamic.scan.findings.filter((x) => x.rule === "dynamic-code");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]!.line < lines[1]!.line);
  } finally {
    await dynamic.clean();
  }
});
test("network use is dangerous without the capability, caution for an undeclared host and safe once declared", async () => {
  const undeclared = await scanned(appendBackend("export const ping=()=>fetch('https://x.example/v1');"));
  try {
    assert.equal(undeclared.scan.verdict, "dangerous");
    assert.ok(rules(undeclared.scan).includes("network-undeclared"));
  } finally {
    await undeclared.clean();
  }
  const noHosts = await scanned(
    withManifest((m) => {
      m.capabilities.push("network");
    }, "export const ping=()=>fetch('https://x.example/v1');"),
  );
  try {
    assert.equal(noHosts.scan.verdict, "caution");
    assert.ok(!rules(noHosts.scan).includes("network-undeclared"));
    const host = noHosts.scan.findings.find((x) => x.rule === "host-undeclared")!;
    assert.equal(host.severity, "caution");
    assert.match(host.excerpt, /x\.example/);
  } finally {
    await noHosts.clean();
  }
  const declared = await scanned(
    withManifest((m) => {
      m.capabilities.push("network");
      m.network = { hosts: ["x.example"] };
    }, "export const ping=()=>fetch('https://x.example/v1');"),
  );
  try {
    assert.equal(declared.scan.verdict, "safe");
    assert.deepEqual(declared.scan.findings, []);
  } finally {
    await declared.clean();
  }
});
test("a dynamic import reaches the network too, and a relative one is only a caution", async () => {
  const hidden = await scanned(
    appendBackend("export const ping=async()=>(await import('node:https')).request('https://x.example/v1');"),
  );
  try {
    assert.equal(hidden.scan.verdict, "dangerous", "import() of node:https is network use, capability or not");
    const network = hidden.scan.findings.find((x) => x.rule === "network-undeclared")!;
    assert.equal(network.severity, "dangerous");
    assert.equal(network.file, "backend.mjs");
    assert.match(network.excerpt, /node:https/);
    assert.ok(rules(hidden.scan).includes("dynamic-import"));
  } finally {
    await hidden.clean();
  }
  const bare = await scanned(appendBackend("export const load=async()=>import('undici');"));
  try {
    assert.equal(bare.scan.verdict, "dangerous");
    assert.ok(rules(bare.scan).includes("network-undeclared"));
  } finally {
    await bare.clean();
  }
  const declared = await scanned(
    withManifest((m) => {
      m.capabilities.push("network");
    }, "export const load=async()=>import('ws');"),
  );
  try {
    assert.equal(
      declared.scan.verdict,
      "caution",
      "with the capability it is only the dynamic import that is disclosed",
    );
    assert.deepEqual(rules(declared.scan), ["dynamic-import"]);
  } finally {
    await declared.clean();
  }
  const nearby = await scanned(appendBackend("export const load=async()=>import('./helper.mjs');"));
  try {
    assert.equal(nearby.scan.verdict, "safe");
    assert.deepEqual(nearby.scan.findings, []);
  } finally {
    await nearby.clean();
  }
});
test("obfuscated source is caution and credential paths are dangerous", async () => {
  const hidden = await scanned(
    appendBackend(
      `const blob="${"-".repeat(2600)}";\nconst text=String.fromCharCode(72,101,108,108,111,32,116,104,101,114,101);\nexport {blob,text};`,
    ),
  );
  try {
    assert.equal(hidden.scan.verdict, "caution");
    assert.equal(hidden.scan.findings.filter((x) => x.rule === "obfuscation").length, 2);
  } finally {
    await hidden.clean();
  }
  const secrets = await scanned(appendBackend('export const key="~/.ssh/id_rsa";'));
  try {
    assert.equal(secrets.scan.verdict, "dangerous");
    const finding = secrets.scan.findings.find((x) => x.rule === "credential-path")!;
    assert.equal(finding.severity, "dangerous");
    assert.match(finding.excerpt, /id_rsa/);
  } finally {
    await secrets.clean();
  }
});
test("native addons and executables are dangerous even though no text rule matched them", async () => {
  const addon = await scanned(async (dir) => {
    await mkdir(path.join(dir, "bin"), { recursive: true });
    await writeFile(path.join(dir, "bin", "fast.node"), "binary");
  });
  try {
    assert.equal(addon.scan.verdict, "dangerous");
    assert.deepEqual(
      addon.scan.findings.map((x) => ({ rule: x.rule, file: x.file, line: x.line })),
      [{ rule: "native-binary", file: "bin/fast.node", line: 0 }],
    );
    assert.equal(addon.scan.files, 4);
  } finally {
    await addon.clean();
  }
  const script = await scanned(async (dir) => {
    await writeFile(path.join(dir, "run.js"), "#!/bin/sh\nexit 0\n");
  });
  try {
    assert.equal(script.scan.verdict, "dangerous");
    assert.ok(rules(script.scan).includes("native-binary"));
  } finally {
    await script.clean();
  }
});
test("the verdict is the highest severity found and findings are sorted by file then line", async () => {
  const f = await scanned(async (dir) => {
    await writeFile(path.join(dir, "zz.js"), "const s='~/.ssh/id_rsa';\nexport default s;\n");
    await writeFile(
      path.join(dir, "aa.js"),
      "export const u='https://late.example';\nexport const v='https://early.example';\n",
    );
  });
  try {
    assert.equal(f.scan.verdict, "dangerous");
    assert.deepEqual(
      f.scan.findings.map((x) => [x.file, x.line, x.rule]),
      [
        ["aa.js", 1, "host-undeclared"],
        ["aa.js", 2, "host-undeclared"],
        ["zz.js", 1, "credential-path"],
      ],
    );
    const sorted = [...f.scan.findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    assert.deepEqual(f.scan.findings, sorted);
  } finally {
    await f.clean();
  }
});
test("a file the scan did not read is reported as not scanned, never as safe (GPX-4)", async () => {
  // CommonJS loads an unknown extension as JavaScript: this is code the text rules never saw.
  const hidden = await scanned(async (dir) => {
    await mkdir(path.join(dir, "data"));
    await writeFile(path.join(dir, "data", "strings.txt"), "require('child'+'_process').execSync('id')\n");
  });
  try {
    assert.notEqual(hidden.scan.verdict, "safe");
    assert.deepEqual(
      hidden.scan.findings.map((x) => ({ rule: x.rule, severity: x.severity, file: x.file })),
      [{ rule: "not-scanned", severity: "caution", file: "data/strings.txt" }],
    );
    assert.match(hidden.scan.findings[0]!.excerpt, /not read/);
  } finally {
    await hidden.clean();
  }
});
test("Studio's own data and the coding agents' homes are credential paths, and loading a native library is dangerous", async () => {
  for (const target of [
    "~/.codex/auth.json",
    "~/.claude/.credentials.json",
    "Library/Application Support/AI Game Studio/secrets",
    "Library/Application Support/Genex/secrets",
  ]) {
    const f = await scanned(appendBackend(`export const p=${JSON.stringify(target)};`));
    try {
      assert.equal(f.scan.verdict, "dangerous", target);
      assert.ok(rules(f.scan).includes("credential-path"), target);
    } finally {
      await f.clean();
    }
  }
  const dl = await scanned(appendBackend("export const load=(file)=>process.dlopen({exports:{}},file);"));
  try {
    assert.equal(dl.scan.verdict, "dangerous");
    assert.ok(rules(dl.scan).includes("native-binary"));
  } finally {
    await dl.clean();
  }
});
test("the scan records each skill's digest, and two packages whose skill bytes differ get different ones", async () => {
  const withCard = (text: string) => async (dir: string) => {
    await mkdir(path.join(dir, "skills"));
    await writeFile(path.join(dir, "skills", "card.md"), text);
    await withManifest((m) => {
      m.apiVersion = 3;
      m.skills.push({ name: "card", summary: "A card read on demand.", file: "skills/card.md" });
    })(dir);
  };
  const first = await scanned(withCard("# Card\n\nFirst edition.\n"));
  const second = await scanned(withCard("# Card\n\nSecond edition.\n"));
  try {
    assert.deepEqual(Object.keys(first.scan.skillDigests ?? {}).sort(), ["card", "greeting"]);
    assert.notEqual(first.scan.skillDigests?.card, second.scan.skillDigests?.card);
    assert.equal(first.scan.skillDigests?.greeting, second.scan.skillDigests?.greeting);
  } finally {
    await first.clean();
    await second.clean();
  }
});

test("the scan reads what installs: dotfiles anywhere and the scaffold's authoring files are not part of a package", async () => {
  const outside = await scanned(async (dir) => {
    await mkdir(path.join(dir, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(dir, ".git", "hooks", "pre-push.sample"), "#!/bin/sh\nexec child_process\n");
    await writeFile(path.join(dir, ".env"), "TOKEN=1\n");
    await writeFile(path.join(dir, "AGENTS.md"), "Notes for a coding agent.\n");
    await mkdir(path.join(dir, "plugin-sdk"));
    await writeFile(path.join(dir, "plugin-sdk", "index.d.ts"), "export {};\n");
  });
  try {
    assert.equal(outside.scan.verdict, "safe", JSON.stringify(outside.scan.findings));
    assert.deepEqual(outside.scan.findings, []);
  } finally {
    await outside.clean();
  }
  // Only the package root's authoring files are left out: the same name deeper in is package code.
  const nested = await scanned(async (dir) => {
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "AGENTS.md"), "x\n");
  });
  try {
    assert.deepEqual(rules(nested.scan), ["not-scanned"]);
  } finally {
    await nested.clean();
  }
});
