// How a person installs, trusts, opens and closes Genex on each kind of machine, and where the
// machine keeps its crash reports. One entry per package kind; run.ts drives them in order.
import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { PackageKind, PUBLIC_LINKS } from "./links.ts";
import { StepOutcome } from "./results.ts";
import { asRoot, powershell, sh, tail } from "./shell.ts";

/** Squirrel's install folder name and the app's executable (forge.config.cjs). */
const SQUIRREL_NAME = "genex";
const PRODUCT_NAME = "Genex";
const MAC_APP = `/Applications/${PRODUCT_NAME}.app`;
const LINUX_DIR = "/usr/lib/genex";
/** How long Setup.exe may take to lay the app down, and how long a closed app may take to exit. */
const SETUP_SETTLE_MS = 5 * MINUTE_MS;
const QUIT_GRACE_MS = 10 * SECOND_MS;
const POLL_MS = SECOND_MS;
/** What macOS's Gatekeeper says of a notarized Developer ID app (spctl -a -vv). */
const NOTARIZED = /source=Notarized Developer ID/;

/** Where an installed Genex lives for this user. */
export interface Installed {
  /** The folder the packaged runners take as STUDIO_PACKAGE_DIR. */
  packageDir: string;
  /** The app's executable. */
  bin: string;
  /** The app's userData folder, which holds logs/studio.log and Crashpad. */
  userData: string;
  /** Whether the installer opened the app itself (Squirrel's Setup.exe does), so that was the first start. */
  startedByInstaller: boolean;
  /** What the install printed, for the evidence. */
  output: string;
}

/** A step's verdict before it is recorded. */
export interface Verdict {
  outcome: (typeof StepOutcome)[keyof typeof StepOutcome];
  detail: string;
}

/** What a Windows machine is doing while a first start runs over (`overrun`). */
const OVERRUN_SCRIPT = path.join(import.meta.dirname, "windows", "overrun.ps1");

/** One kind of machine. */
export interface Platform {
  /** The app's userData folder for this account, known before the install. */
  userData(): string;
  install(file: string, evidence: string): Promise<Installed>;
  trust(file: string, installed: Installed): Promise<Verdict>;
  launch(installed: Installed, evidence: string): Promise<void>;
  quit(installed: Installed): Promise<void>;
  /** The machine's own crash reports that name Genex. */
  crashReports(): Promise<string[]>;
  /** What the machine is doing while a first start runs over its budget, into the evidence folder. */
  overrun?(installed: Installed, evidence: string): Promise<void>;
}

async function namedFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => pattern.test(entry.name)).map((entry) => path.join(dir, entry.name));
}

/** Start `bin` detached, its output in the evidence folder, as a double-click does. */
function startDetached(bin: string, args: string[], evidence: string, name: string): void {
  const out = openSync(path.join(evidence, `${name}.log`), "a");
  spawn(bin, args, { detached: true, stdio: ["ignore", out, out], windowsHide: false }).unref();
}

async function settle<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null || Date.now() > deadline) return value;
    await sleep(POLL_MS);
  }
}

const macos: Platform = {
  userData: () => path.join(os.homedir(), "Library", "Application Support", PRODUCT_NAME),
  async install(file) {
    if (existsSync(MAC_APP)) throw new Error(`${MAC_APP} already exists; the canary installs only on a fresh machine`);
    // As a browser leaves a download: quarantined, so Gatekeeper judges what the person opens.
    const quarantine = `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`;
    const marked = await sh("xattr", ["-w", "com.apple.quarantine", quarantine, file]);
    const mount = await mkdtemp(path.join(os.tmpdir(), "genex-dmg-"));
    const attached = await sh("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-noautoopen",
      "-mountpoint",
      mount,
      file,
    ]);
    if (attached.code !== 0) throw new Error(`hdiutil attach: ${tail(attached.stderr)}`);
    const copied = await sh("ditto", [path.join(mount, `${PRODUCT_NAME}.app`), MAC_APP]);
    await sh("hdiutil", ["detach", mount, "-force"]);
    if (copied.code !== 0) throw new Error(`copy to /Applications: ${tail(copied.stderr)}`);
    return {
      packageDir: "/Applications",
      bin: path.join(MAC_APP, "Contents", "MacOS", "genex"),
      userData: macos.userData(),
      startedByInstaller: false,
      output: [marked.stderr, attached.stdout, copied.stderr].join("\n").trim(),
    };
  },
  async trust() {
    const quarantined = await sh("xattr", ["-p", "com.apple.quarantine", MAC_APP]);
    const gatekeeper = await sh("spctl", ["-a", "-vv", "-t", "exec", MAC_APP]);
    const staple = await sh("xcrun", ["stapler", "validate", MAC_APP]);
    const verdict = `${gatekeeper.stdout}${gatekeeper.stderr}`.trim();
    // The person's Open in the first-launch dialog; a test cannot click it, so the flag goes.
    await sh("xattr", ["-dr", "com.apple.quarantine", MAC_APP]);
    const ok = gatekeeper.code === 0 && NOTARIZED.test(verdict) && staple.code === 0;
    const quarantine = quarantined.code === 0 ? "quarantined like a download" : "NOT quarantined";
    return {
      outcome: ok ? StepOutcome.Pass : StepOutcome.Fail,
      detail: `${quarantine}; Gatekeeper: ${verdict.replace(/\s+/g, " ")}; staple: ${staple.code === 0 ? "valid" : tail(staple.stdout + staple.stderr, 2)}`,
    };
  },
  async launch() {
    await sh("open", ["-a", MAC_APP]);
  },
  async quit() {
    await sh("osascript", ["-e", `tell application "${PRODUCT_NAME}" to quit`]);
    await sleep(QUIT_GRACE_MS);
    await sh("pkill", ["-f", `${MAC_APP}/`]);
  },
  async crashReports() {
    return namedFiles(path.join(os.homedir(), "Library", "Logs", "DiagnosticReports"), /genex/i);
  },
};

/** The installed Squirrel app's folder, once Setup.exe has laid it down. */
async function squirrelApp(): Promise<string | null> {
  const root = path.join(process.env.LOCALAPPDATA ?? "", SQUIRREL_NAME);
  const versions = await readdir(root).catch(() => []);
  const dir = versions
    .filter((name) => name.startsWith("app-"))
    .map((name) => path.join(root, name))
    .find((candidate) => existsSync(path.join(candidate, `${SQUIRREL_NAME}.exe`)));
  return dir ?? null;
}

/** An Authenticode status and signer for one file, as Get-AuthenticodeSignature reports it. */
async function signature(file: string): Promise<{ status: string; signer: string }> {
  const ran = await powershell(
    '$s = Get-AuthenticodeSignature -LiteralPath $env:CANARY_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"',
    { file },
  );
  const [status, signer = ""] = ran.stdout.trim().split("|");
  return status ? { status, signer } : { status: "Unknown", signer: tail(ran.stderr, 2) };
}

const windows: Platform = {
  userData: () => path.join(process.env.APPDATA ?? "", PRODUCT_NAME),
  async install(file, evidence) {
    // As a browser leaves a download: Mark of the Web, which SmartScreen and Office read.
    const zone = `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${PUBLIC_LINKS[PackageKind.Exe].url}\r\n`;
    await writeFile(`${file}:Zone.Identifier`, zone);
    // A double-click: no arguments. Setup.exe installs into %LOCALAPPDATA%\genex and opens the app.
    startDetached(file, [], evidence, "setup");
    const dir = await settle(squirrelApp, SETUP_SETTLE_MS);
    if (!dir)
      throw new Error(
        `Setup.exe laid down no app-<version>\\${SQUIRREL_NAME}.exe in ${SETUP_SETTLE_MS / MINUTE_MS} minutes`,
      );
    return {
      packageDir: dir,
      bin: path.join(dir, `${SQUIRREL_NAME}.exe`),
      userData: windows.userData(),
      startedByInstaller: true,
      output: `installed into ${dir}`,
    };
  },
  async trust(file, installed) {
    const setup = await signature(file);
    const app = await signature(installed.bin);
    const detail = `Genex-Setup.exe: ${setup.status} ${setup.signer}; genex.exe: ${app.status} ${app.signer}`.trim();
    const valid = setup.status === "Valid" && app.status === "Valid";
    const unsigned = setup.status === "NotSigned" || app.status === "NotSigned";
    if (valid) return { outcome: StepOutcome.Pass, detail };
    if (unsigned)
      return {
        outcome: StepOutcome.Warn,
        detail: `${detail} (unsigned: SmartScreen warns a person before Setup runs)`,
      };
    return { outcome: StepOutcome.Fail, detail };
  },
  async launch(installed, evidence) {
    startDetached(installed.bin, [], evidence, "launch");
  },
  async quit(installed) {
    await powershell(
      'Get-Process genex -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$env:CANARY_DIR\\*" } | Stop-Process -Force',
      { dir: path.dirname(installed.packageDir) },
    );
    await sleep(QUIT_GRACE_MS);
  },
  async overrun(installed, evidence) {
    const script = await readFile(OVERRUN_SCRIPT, "utf8");
    await powershell(script, { userdata: installed.userData, file: path.join(evidence, "overrun.txt") });
  },
  async crashReports() {
    const local = await namedFiles(path.join(process.env.LOCALAPPDATA ?? "", "CrashDumps"), /^genex/i);
    const wer = path.join(process.env.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "WER");
    const archived = await namedFiles(path.join(wer, "ReportArchive"), /genex/i);
    const queued = await namedFiles(path.join(wer, "ReportQueue"), /genex/i);
    return [...local, ...archived, ...queued];
  },
};

/** Linux: the package manager installs it into /usr/lib/genex; it opens from there. */
function linux(installArgs: (file: string) => string[]): Platform {
  const userData = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), PRODUCT_NAME);
  return {
    userData,
    async install(file) {
      const [command, args] = asRoot(installArgs(path.resolve(file)));
      const ran = await sh(command, args, { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
      if (ran.code !== 0) throw new Error(`install: ${tail(ran.stdout + ran.stderr)}`);
      return {
        packageDir: LINUX_DIR,
        bin: path.join(LINUX_DIR, "genex"),
        userData: userData(),
        startedByInstaller: false,
        output: tail(ran.stdout + ran.stderr, 40),
      };
    },
    async trust() {
      return {
        outcome: StepOutcome.Skip,
        detail: "Linux packages are trusted through the signed repository (repository step)",
      };
    },
    async launch(installed, evidence) {
      startDetached(installed.bin, [], evidence, "launch");
    },
    async quit(installed) {
      await sh("pkill", ["-f", installed.bin]);
      await sleep(QUIT_GRACE_MS);
      await sh("pkill", ["-9", "-f", installed.bin]);
    },
    async crashReports() {
      return namedFiles("/var/crash", /genex/i);
    },
  };
}

/** Each package kind's machine. */
export const PLATFORMS = {
  [PackageKind.Dmg]: macos,
  [PackageKind.Exe]: windows,
  [PackageKind.Deb]: linux((file) => ["apt-get", "install", "-y", "-q", file]),
  [PackageKind.Rpm]: linux((file) => ["dnf", "install", "-y", "-q", file]),
} as const satisfies Record<PackageKind, Platform>;

/** Save the screen to `file` with the system's own tool; false when there is no screen to save. */
export async function screenshot(file: string): Promise<boolean> {
  if (process.platform === "darwin") return (await sh("screencapture", ["-x", file])).code === 0;
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
      "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
      "[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
      "$bmp.Save($env:CANARY_FILE, [System.Drawing.Imaging.ImageFormat]::Png)",
    ].join("; ");
    return (await powershell(script, { file })).code === 0;
  }
  return (await sh("import", ["-window", "root", file])).code === 0;
}
