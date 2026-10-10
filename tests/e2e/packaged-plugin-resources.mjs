/** Checks the unpacked plugin payload without opening an Editor or a human profile. */
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const executeFile = promisify(execFile);
const MAX_PAYLOAD_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const NATIVE_LOAD_TIMEOUT_MS = 20_000;
const NATIVE_READY = "GENEX_NATIVE_HELPER_READY";
const PACKAGE_NAME = "com.genex.unity-bridge";
const NATIVE_PROBE = `param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Script)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) { throw $errors[0].Message }
Add-Type -Path $Source
$type = [GenexNative.ContainerJob]
if (-not $type.GetMethod('Run') -or -not $type.GetMethod('Recover')) {
    throw 'The native helper entry points are missing'
}
Write-Output '${NATIVE_READY}'
`;

async function execute(binary, args, options) {
  const result = await executeFile(binary, args, { ...options, encoding: "utf8" });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function checked(name, operation) {
  try {
    await operation();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, detail: String(error?.message ?? error).slice(-1000) };
  }
}

/** Every named payload component must be plain; even an identical linked file is rejected. */
async function plainFile(root, relative) {
  let file = root;
  const parts = relative.split("/");
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Payload root is linked or missing");
  for (const [index, part] of parts.entries()) {
    if (!part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part)) throw new Error("Invalid payload path");
    file = path.join(file, part);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Linked payload: ${relative}`);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error(`Missing payload directory: ${relative}`);
    if (index === parts.length - 1 && (!info.isFile() || info.size > MAX_FILE_BYTES))
      throw new Error(`Invalid payload file: ${relative}`);
  }
  return readFile(file);
}

async function payloadFiles(root, relative = "", files = []) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Linked payload: ${file}`);
    if (entry.isDirectory()) await payloadFiles(root, file, files);
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Invalid payload file: ${file}`);
    if (files.length > MAX_PAYLOAD_FILES) throw new Error("Payload exceeds its file budget");
  }
  return files.sort();
}

async function sameFile(expectedRoot, actualRoot, relative) {
  const expected = await plainFile(expectedRoot, relative);
  const actual = await plainFile(actualRoot, relative);
  if (!expected.equals(actual)) throw new Error(`Packaged bytes differ: ${relative}`);
}

async function sameTree(expectedRoot, actualRoot, { receipt = false } = {}) {
  const expected = await payloadFiles(expectedRoot);
  const actual = (await payloadFiles(actualRoot)).filter((file) => !receipt || file !== ".genex-install.json");
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("Packaged Editor file list differs");
  for (const file of expected) await sameFile(expectedRoot, actualRoot, file);
}

async function unityResources(root, resources) {
  await plainFile(resources, "plugins/unity/plugin.json");
  await plainFile(resources, "plugins/unity/editor-package/package.json");
  const source = path.join(root, "src", "plugins", "unity");
  const built = path.join(root, "dist", "resources", "plugins", "unity");
  const shipped = path.join(resources, "plugins", "unity");
  await sameFile(source, shipped, "plugin.json");
  for (const file of ["backend.mjs", "panel.html"]) await sameFile(built, shipped, file);
  await sameTree(path.join(source, "editor-package"), path.join(shipped, "editor-package"));
  const manifest = JSON.parse((await plainFile(shipped, "plugin.json")).toString("utf8"));
  const valid = manifest.id === "unity" && manifest.apiVersion === 3 && manifest.backend === "backend.mjs";
  if (!valid) throw new Error("The shipped Unity SDK manifest is incompatible");
}

async function unityBackend(resources) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "genex-packaged-unity-"));
  try {
    for (const folder of ["Assets", "Packages", "ProjectSettings"]) await mkdir(path.join(fixture, folder));
    await writeFile(
      path.join(fixture, "Packages", "manifest.json"),
      '{"dependencies":{"com.unity.modules.physics":"1.0.0"}}',
    );
    await writeFile(path.join(fixture, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.5.5f1\n");
    const unity = path.join(resources, "plugins", "unity");
    const backend = await import(pathToFileURL(path.join(unity, "backend.mjs")).href);
    const host = async () => {
      throw new Error("Setup called an unexpected host or account service");
    };
    const plugin = await backend.activate({ call: host });
    if (typeof plugin?.action !== "function") throw new Error("The Unity backend has no setup action");
    const result = await plugin.action(
      "install-bridge",
      {},
      {
        project: "packaged-unity-fixture",
        directory: fixture,
        callId: 1,
        signal: new AbortController().signal,
        host,
      },
    );
    if (!result?.installed) throw new Error("The packaged backend did not install its Editor bridge");
    await sameTree(path.join(unity, "editor-package"), path.join(fixture, "Packages", PACKAGE_NAME), { receipt: true });
    const manifest = JSON.parse(await readFile(path.join(fixture, "Packages", "manifest.json"), "utf8"));
    const intact =
      manifest.dependencies[PACKAGE_NAME] === `file:${PACKAGE_NAME}` &&
      manifest.dependencies["com.unity.modules.physics"] === "1.0.0";
    if (!intact) throw new Error("Packaged setup did not preserve the project's package manifest");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function nativeResources(root, resources) {
  for (const file of ["windows-native.ps1", "windows-native.cs"]) {
    await plainFile(resources, `windows-native/${file}`);
    await sameFile(path.join(root, "src", "substrate", "plugins"), path.join(resources, "windows-native"), file);
  }
}

async function nativeLoad(resources, run) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "genex-packaged-native-"));
  try {
    const probe = path.join(fixture, "load.ps1");
    await writeFile(probe, NATIVE_PROBE);
    const system = process.env.SystemRoot || "C:\\Windows";
    const binary = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await run(
      binary,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        probe,
        "-Source",
        path.join(resources, "windows-native", "windows-native.cs"),
        "-Script",
        path.join(resources, "windows-native", "windows-native.ps1"),
      ],
      {
        windowsHide: true,
        timeout: NATIVE_LOAD_TIMEOUT_MS,
        maxBuffer: 64_000,
        env: { ...process.env, TMP: fixture, TEMP: fixture },
      },
    );
    if (!String(result.stdout).includes(NATIVE_READY))
      throw new Error("The native helper did not report a successful load");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

/** Verify this package's real unpacked resources, then execute only already-validated setup code. */
export async function verifyPackagedPluginResources({ root, resources, platform = process.platform, run = execute }) {
  const unity = await checked("Unity SDK backend and Editor package are unpacked and byte-exact", () =>
    unityResources(root, resources),
  );
  const checks = [
    unity,
    unity.ok
      ? await checked("unpacked Unity backend installs its adjacent Editor package", () => unityBackend(resources))
      : {
          name: "unpacked Unity backend installs its adjacent Editor package",
          ok: false,
          detail: "Unity resource validation failed; backend was not executed",
        },
  ];
  if (platform !== "win32") return checks;
  const native = await checked("Windows native helper resources are unpacked and byte-exact", () =>
    nativeResources(root, resources),
  );
  checks.push(
    native,
    native.ok
      ? await checked("Windows native helper parses and compiles from its shipped path", () =>
          nativeLoad(resources, run),
        )
      : {
          name: "Windows native helper parses and compiles from its shipped path",
          ok: false,
          detail: "Native resource validation failed; helper was not loaded",
        },
  );
  return checks;
}
