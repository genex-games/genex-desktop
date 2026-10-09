import path from "node:path";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import {
  PluginCapability,
  type PluginManifest,
  type PluginScan,
  type PluginScanFinding,
} from "../../shared/plugins.ts";
import { isIconPicture, pluginSkillDigests } from "./manifest.ts";
import { isPackageEntry } from "./pack.ts";

/**
 * Install-time static scan: disclosure, not isolation. Backends stay trusted native code in a
 * crash-isolated child process, so the verdict only tells the user what the package appears to do
 * before they approve it. Rules are heuristics; a legitimate plugin that spawns a CLI reads 'dangerous'.
 */
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".html", ".json"]);
const RANK: Record<PluginScan["verdict"], number> = { safe: 0, caution: 1, dangerous: 2 };
const EXCERPT = 160;
/** Lines longer than this are checked for minified or encoded payloads. */
const LONG_LINE_CHARS = 2000;
/** Below this share of letters and digits a long line reads as an encoded blob. */
const MIN_ALNUM_RATIO = 0.3;
/** Enough of a file to read its `#!` line or binary magic. */
const HEAD_BYTES = 200;
/** The largest declared icon the scan reads as a picture; the manifest's own cap is smaller. */
const ICON_SCAN_BYTES = 1024 * 1024;
type Severity = PluginScanFinding["severity"];
interface LineRule {
  rule: string;
  severity: Severity;
  test: (line: string) => boolean;
}

const CHILD_PROCESS = /\bchild_process\b|\b(?:spawn|spawnSync|execSync|execFile|execFileSync)\s*\(/;
const DYNAMIC_CODE =
  /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w*|compileFunction)\s*\(|\bnode:vm\b|(?:from|require\s*\()\s*['"]vm['"]/;
const NETWORK =
  /\bfetch\s*\(|\bhttps?\.(?:request|get)\s*\(|(?:from|require\s*\()\s*['"](?:node:)?(?:https?|net|tls|dgram|http2)['"]|\bimport\s*\(\s*['"](?:node:)?(?:https?|net|tls|dgram|http2|undici|ws)['"]|\bnet\.(?:connect|createConnection)\s*\(|\bnew\s+WebSocket\s*\(/;
/** `import('…')` of anything but a path inside the package: what it loads is not in what was scanned. */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!['"][./])/;
const HOST = /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*)/gi;
const ESCAPE_RUN = /(?:\\x[0-9a-fA-F]{2}){8,}|(?:\\u[0-9a-fA-F]{4}){8,}/;
const FROM_CHAR_CODE = /String\.fromCharCode\s*\(([^)]*)\)/;
const BASE64_NEAR_EVAL = /(?:\batob\s*\(|['"]base64['"])/;
const CREDENTIAL_PATH =
  /~\/\.ssh|\bid_rsa\b|\.aws\/credentials|(?<![A-Za-z0-9_.])\.netrc\b|(?<![A-Za-z0-9_.])\.npmrc\b|Library\/Keychains|(?<![A-Za-z0-9_.])\.(?:genex|codex|claude)\b|(?<![A-Za-z0-9_.])\.env\b|\bLogin Data\b|\/Cookies\b|Application Support\/(?:AI Game Studio|Genex)\b/;
const NATIVE_LOAD = /\bprocess\.dlopen\s*\(/;

function lowAlnum(line: string): boolean {
  if (line.length <= LONG_LINE_CHARS) return false;
  let alnum = 0;
  for (const ch of line) if (/[A-Za-z0-9]/.test(ch)) alnum++;
  return alnum / line.length < MIN_ALNUM_RATIO;
}
function manyCharCodes(line: string): boolean {
  const m = FROM_CHAR_CODE.exec(line);
  return !!m && m[1].split(",").length >= 8;
}
function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}
function excerpt(line: string): string {
  const t = line.trim();
  return t.length > EXCERPT ? `${t.slice(0, EXCERPT - 1)}…` : t;
}
/** The line rules for a package; an undeclared network call is dangerous only without the capability. */
function lineRules(network: boolean): LineRule[] {
  return [
    { rule: "child-process", severity: "dangerous", test: (l) => CHILD_PROCESS.test(l) },
    { rule: "native-binary", severity: "dangerous", test: (l) => NATIVE_LOAD.test(l) },
    { rule: "dynamic-code", severity: "dangerous", test: (l) => DYNAMIC_CODE.test(l) },
    ...(network
      ? []
      : [{ rule: "network-undeclared", severity: "dangerous" as const, test: (l: string) => NETWORK.test(l) }]),
    { rule: "dynamic-import", severity: "caution", test: (l) => DYNAMIC_IMPORT.test(l) },
    {
      rule: "obfuscation",
      severity: "caution",
      test: (l) =>
        lowAlnum(l) ||
        ESCAPE_RUN.test(l) ||
        manyCharCodes(l) ||
        (BASE64_NEAR_EVAL.test(l) && /\beval\s*\(|\bFunction\s*\(/.test(l)),
    },
    { rule: "credential-path", severity: "dangerous", test: (l) => CREDENTIAL_PATH.test(l) },
  ];
}

/** What the rules say about one line, and each host it names that the manifest does not declare. */
function lineFindings(
  text: string,
  line: number,
  file: string,
  rules: LineRule[],
  hosts: string[],
): PluginScanFinding[] {
  const findings: PluginScanFinding[] = [];
  for (const r of rules)
    if (r.test(text)) findings.push({ rule: r.rule, severity: r.severity, file, line, excerpt: excerpt(text) });
  const seen = new Set<string>();
  for (const m of text.matchAll(HOST)) {
    const host = m[1].toLowerCase();
    if (seen.has(host) || hostAllowed(host, hosts)) continue;
    seen.add(host);
    findings.push({ rule: "host-undeclared", severity: "caution", file, line, excerpt: `${host} — ${excerpt(text)}` });
  }
  return findings;
}

/** One file's findings: a native addon, a shebang, a file the scan cannot read, or its text's lines. */
async function fileFindings(
  full: string,
  entry: string,
  file: string,
  rules: LineRule[],
  hosts: string[],
): Promise<PluginScanFinding[]> {
  const ext = path.extname(entry).toLowerCase();
  if (ext === ".node")
    return [{ rule: "native-binary", severity: "dangerous", file, line: 0, excerpt: `${entry} (native addon)` }];
  const findings: PluginScanFinding[] = [];
  const head = await readHead(full);
  if (head.startsWith("#!"))
    findings.push({
      rule: "native-binary",
      severity: "dangerous",
      file,
      line: 1,
      excerpt: excerpt(head.split(/\r?\n/)[0] ?? "#!"),
    });
  // Node loads a file of any extension as JavaScript when asked to, so a file the rules did not
  // read is disclosed as such rather than counted towards a clean verdict.
  if (!TEXT_EXTENSIONS.has(ext)) {
    findings.push({
      rule: "not-scanned",
      severity: "caution",
      file,
      line: 0,
      excerpt: `${entry}: not read by the scan (${ext || "no"} extension)`,
    });
    return findings;
  }
  const lines = (await readFile(full, "utf8")).split(/\r?\n/);
  lines.forEach((text, i) => {
    findings.push(...lineFindings(text, i + 1, file, rules, hosts));
  });
  return findings;
}

export async function scanPackage(root: string, manifest: PluginManifest): Promise<PluginScan> {
  const network = manifest.capabilities.includes(PluginCapability.Network);
  const hosts = manifest.network?.hosts ?? [];
  const rules = lineRules(network);
  const findings: PluginScanFinding[] = [];
  let files = 0,
    bytes = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    // What is never installed is never run: the scan reads the package as it will be installed.
    const entries = (await readdir(dir)).filter((entry) => isPackageEntry(entry, rel)).sort();
    for (const entry of entries) {
      const full = path.join(dir, entry),
        file = rel ? `${rel}/${entry}` : entry,
        s = await lstat(full);
      if (s.isDirectory()) {
        await walk(full, file);
        continue;
      }
      if (!s.isFile()) continue;
      files++;
      bytes += s.size;
      if (await isDeclaredIcon(full, file, manifest)) continue;
      findings.push(...(await fileFindings(full, entry, file, rules, hosts)));
    }
  };
  await walk(root, "");
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
  const verdict = findings.reduce<PluginScan["verdict"]>(
    (v, f) => (RANK[f.severity] > RANK[v] ? f.severity : v),
    "safe",
  );
  const skillDigests = await pluginSkillDigests(root, manifest);
  return { verdict, findings, files, bytes, scannedAt: new Date().toISOString(), skillDigests };
}

/** The manifest's own icon, when its bytes are the picture it says: a picture runs nothing, so the scan has nothing to read. */
async function isDeclaredIcon(full: string, file: string, manifest: PluginManifest): Promise<boolean> {
  if (!manifest.icon || file !== manifest.icon) return false;
  const s = await lstat(full);
  return s.size <= ICON_SCAN_BYTES && isIconPicture(file, await readFile(full));
}

async function readHead(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("latin1");
  } finally {
    await handle.close();
  }
}
