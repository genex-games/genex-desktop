/**
 * Validate a plugin package the way Studio will, before anyone installs it.
 *
 *     npm run plugin:doctor -- <directory> [--json]
 *
 * Six checks, in the order Studio runs them:
 *   1. `inspectPackage` — the real manifest validator, plus the link/special-file refusal.
 *   2. `scanPackage` — the install-time static scan, so the author sees the verdict a user will.
 *   3. a real `PluginProcess` ping probe, with a host service that throws: activation must be
 *      side-effect-free and must not need host authority, exactly as at install time. Backend
 *      stderr is echoed, since that is where an import-time failure explains itself.
 *   4. toolbar reserved labels and aria-label uniqueness.
 *   5. panel CSP: an external script or an absolute http(s) URL inside a panel cannot load in the
 *      sandboxed frame Studio serves it in.
 *   6. mcpServers: a `node` server's script must really be a file inside the package, and every
 *      declared server is listed with the environment sources it asked for — because an MCP server
 *      is native code the host starts, and the author should see exactly what they are asking for.
 *
 * Exit 1 on an error. Scan findings and CSP problems are reported as warnings: they do not stop
 * an install, they change what the trust dialog says and what the panel can do.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectPackage } from "../src/substrate/plugins/manifest.ts";
import { RESERVED_TOOLBAR_LABELS } from "../src/substrate/plugins/reserved-labels.ts";
import { containedReal } from "../src/substrate/paths.ts";
import { scanPackage } from "../src/substrate/plugins/scan.ts";
import { PluginProcess } from "../src/substrate/plugins/process.ts";
import type { PluginManifest, PluginScan } from "../src/shared/plugins.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const target = argv.find((a) => !a.startsWith("--"));

interface Report {
  ok: boolean;
  dir: string;
  id?: string;
  version?: string;
  name?: string;
  capabilities?: string[];
  scan?: PluginScan;
  probe: "ready" | "failed" | "skipped";
  toolbar: Array<{ id: string; label: string; ariaLabel: string; target: string; status?: string }>;
  mcpServers: Array<{ id: string; command: string; args: string; cwd: string; env: string[]; requires: string[] }>;
  stderr: string[];
  warnings: string[];
  errors: string[];
}

const report: Report = {
  ok: false,
  dir: target ? path.resolve(target) : "",
  probe: "skipped",
  toolbar: [],
  mcpServers: [],
  stderr: [],
  warnings: [],
  errors: [],
};

/** How many scan findings the text report lists before it says how many more there are. */
const SHOWN_FINDINGS = 20;

function packageLine(r: Report): string[] {
  if (!r.id) return [];
  const capabilities = r.capabilities?.length ? r.capabilities.join(", ") : "none";
  return [`  ${r.name} (${r.id} ${r.version}) — capabilities: ${capabilities}`];
}

function scanLines(scan: PluginScan | undefined): string[] {
  if (!scan) return [];
  const hidden = scan.findings.length - SHOWN_FINDINGS;
  return [
    `  Scan: ${scan.verdict} — ${scan.findings.length} finding(s) over ${scan.files} file(s)`,
    ...scan.findings
      .slice(0, SHOWN_FINDINGS)
      .map((f) => `    ${f.severity}  ${f.rule}  ${f.file}:${f.line}  ${f.excerpt}`),
    ...(hidden > 0 ? [`    … ${hidden} more`] : []),
  ];
}

function toolbarLine(item: Report["toolbar"][number]): string {
  const status = item.status ? ` · status ${item.status}` : "";
  return `  Toolbar: ${item.id} "${item.label}" (${item.ariaLabel}) → ${item.target}${status}`;
}

function serverLine(server: Report["mcpServers"][number]): string {
  const env = server.env.length ? ` · env ${server.env.join(", ")}` : "";
  const requires = server.requires.length ? ` · needs ${server.requires.join(", ")}` : "";
  return `  MCP server: ${server.id} — ${server.command} ${server.args} in ${server.cwd}${env}${requires}`;
}

/** The report as text, one finding per line. */
function reportLines(r: Report): string[] {
  return [
    `${r.ok ? "ok" : "FAILED"}  ${r.dir}`,
    ...packageLine(r),
    ...scanLines(r.scan),
    `  Probe: ${r.probe}`,
    ...r.toolbar.map(toolbarLine),
    ...r.mcpServers.map(serverLine),
    ...r.stderr.map((line) => `  [backend] ${line}`),
    ...r.warnings.map((w) => `  warning: ${w}`),
    ...r.errors.map((e) => `  error: ${e}`),
  ];
}

function finish(): never {
  report.ok = report.errors.length === 0;
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${reportLines(report).join("\n")}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (!target) {
  report.errors.push("Usage: npm run plugin:doctor -- <directory> [--json]");
  finish();
}

const dir = report.dir;
let manifest: PluginManifest | undefined;
try {
  manifest = await inspectPackage(dir);
} catch (e) {
  report.errors.push(`Package is not installable: ${(e as Error).message}`);
  finish();
}

report.id = manifest!.id;
report.version = manifest!.version;
report.name = manifest!.name;
report.capabilities = manifest!.capabilities;

try {
  report.scan = await scanPackage(dir, manifest!);
  if (report.scan.verdict !== "safe")
    report.warnings.push(
      `The install-time scan reads "${report.scan.verdict}"; users will see that verdict and the findings in the trust dialog.`,
    );
} catch (e) {
  report.errors.push(`Scan failed: ${(e as Error).message}`);
}

// The probe: the same bootstrap Studio forks, with no host authority at all.
const denied = async () => {
  throw new Error("Host services are unavailable during activation");
};
let failure = "";
const probe = new PluginProcess(
  path.join(root, "src/plugin-sdk/backend.mjs"),
  path.join(dir, manifest!.backend),
  denied,
  (error) => {
    failure ||= error;
  },
  {
    onStderr: (line) => {
      if (report.stderr.length < 40) report.stderr.push(line);
    },
  },
);
try {
  const result = (await Promise.race([
    probe.call("ping", "", {}),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("The backend did not answer a ping within 20 s")), 20_000).unref(),
    ),
  ])) as { ready?: boolean };
  if (!result?.ready) throw new Error("The backend answered a ping without ready:true");
  report.probe = "ready";
} catch (e) {
  report.probe = "failed";
  report.errors.push(`Backend probe failed: ${failure || (e as Error).message}`);
} finally {
  probe.stop();
}

const arias = new Map<string, string>();
for (const item of manifest!.toolbar ?? []) {
  report.toolbar.push({
    id: item.id,
    label: item.label,
    ariaLabel: item.ariaLabel,
    target: item.target.kind === "panel" ? `panel:${item.target.id}` : `action:${item.target.name}`,
    ...(item.status === undefined ? {} : { status: item.status }),
  });
  if (RESERVED_TOOLBAR_LABELS.has(item.label))
    report.errors.push(`Toolbar label "${item.label}" is reserved by Studio`);
  const previous = arias.get(item.ariaLabel.toLowerCase());
  if (previous)
    report.errors.push(
      `Toolbar aria-label "${item.ariaLabel}" is used by both ${previous} and ${item.id}; every control must be uniquely addressable`,
    );
  else arias.set(item.ariaLabel.toLowerCase(), item.id);
}

for (const server of manifest!.mcpServers ?? []) {
  const requires = [
    ...(server.requires?.credential ? ["an unlocked account"] : []),
    ...(server.requires?.settings ?? []).map((key) => `setting ${key}`),
  ];
  report.mcpServers.push({
    id: server.id,
    command: server.command,
    args: server.args.join(" "),
    cwd: server.cwd,
    env: Object.entries(server.env ?? {}).map(([name, source]) => `${name}=${source}`),
    requires,
  });
  if (server.command === "node") {
    const script = await containedReal(dir, server.args[0]!).then(
      () => true,
      () => false,
    );
    if (!script)
      report.errors.push(`MCP server ${server.id} runs "${server.args[0]}", which is not a file inside the package`);
  }
  report.warnings.push(
    `MCP server ${server.id} is started by Studio as trusted native code in a child process — crash isolation, not an OS sandbox. Users approve it through the install dialog together with your capabilities, and changing what it runs asks them again.`,
  );
}

for (const panel of manifest!.panels) {
  const html = await readFile(path.join(dir, panel.file), "utf8").catch(() => "");
  if (!html) {
    report.errors.push(`Panel ${panel.id} (${panel.file}) is empty or unreadable`);
    continue;
  }
  if (/<script[^>]+\bsrc\s*=/i.test(html))
    report.warnings.push(
      `Panel ${panel.id} loads an external script; the panel CSP is script-src 'unsafe-inline', so it will not load. Inline the code instead.`,
    );
  for (const m of html.matchAll(/\bhttps?:\/\/[^\s"'<>)]+/gi)) {
    report.warnings.push(
      `Panel ${panel.id} references ${m[0]}; the panel CSP allows no network (connect-src 'none', img-src data:). Use data: URLs and an action on the backend.`,
    );
    break;
  }
}

finish();
