/**
 * Computer control on a real Windows desktop, without Electron: the pinned cua-driver.exe vendored as
 * a release vendors it, run embedded on a named pipe as the app runs it, and driven through the same
 * `desktop` tool an agent session holds (desktopControl → desktopTools → the desktop target → the
 * driver and the window probe), with a scripted agent in place of a model. It checks that:
 *
 * - the daemon is the bundled, validly signed exe, listening on a `\\.\pipe\genex-cua-…` pipe;
 * - the agent clicks into Notepad and types a line, which the window's own tree reads back, and the
 *   screenshot shows;
 * - an app the studio never drives (the saved-passwords dialog, Windows Settings) is refused;
 * - typing into a focused password field is refused;
 * - Windows does not take Ctrl+Alt+Shift+Esc (the stop shortcut) for itself: no Task Manager opens;
 * - the stop (the call the shortcut and quitting make) ends the session under a call, and the
 *   daemon with it;
 * - an app that dies without stopping leaves no cua-driver.exe behind (the lifetime pipe).
 *
 * Evidence (one JSON report and the screenshots) goes to .studio-dev/evidence/windows-desktop-control.
 * It needs a signed-in Windows desktop session (a hosted CI runner has one):
 *
 *   node tests/e2e/run-windows-desktop-control.mjs
 */
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { vendorCuaDriver } from "../../scripts/vendor-cua-driver.ts";
import { desktopControl } from "../../src/main/core/desktop-control.ts";
import { DesktopQuestion } from "../../src/main/core/desktop-tools.ts";
import { connectCuaDriver, driverEnv, GrantHolder } from "../../src/substrate/cua-driver-client.ts";
import { bundledCuaDriver, embeddedCuaDriver, HOST_BUNDLE_ID } from "../../src/substrate/cua-embedded.ts";
import { probeCommand, windowsPowerShell, windowsProbe } from "../../src/substrate/windows-window-probe.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const evidence = path.join(root, ".studio-dev", "evidence", "windows-desktop-control");
const LINE = "Genex drives Notepad on Windows";
const run = promisify(execFile);
/** An answer that says the studio refused the action. */
const REFUSED = /refus|never driven|did not allow|password field/i;
/**
 * A small window with one focused password field, as Windows Forms draws it, labelled nothing: only
 * UI Automation's own password flag can say what it is.
 */
const PASSWORD_FORM =
  "$PSModuleAutoLoadingPreference = 'None'; [void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $f = [Windows.Forms.Form]::new(); $f.Text = 'Genex password field'; $t = [Windows.Forms.TextBox]::new(); $t.UseSystemPasswordChar = $true; $t.Dock = 'Fill'; $f.Controls.Add($t); $f.Add_Shown({ $f.Activate(); [void]$t.Focus() }); [Windows.Forms.Application]::Run($f)";
/**
 * The start of a PowerShell command that runs no cmdlet: a first cmdlet makes PowerShell prepare
 * every installed module, which takes many seconds on a fresh machine. UI Automation is loaded.
 */
const DOTNET =
  "$PSModuleAutoLoadingPreference = 'None'; foreach ($a in 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Windows.Forms') { [void][Reflection.Assembly]::LoadWithPartialName($a) }";
/** How many points across and down a covered window is tried at, for one only it covers. */
const GRID = 5;
/** A UI Automation element's rectangle, as left,top,right,bottom. */
const RECT = '$r = $e.Current.BoundingRectangle; "$([int]$r.Left),$([int]$r.Top),$([int]$r.Right),$([int]$r.Bottom)"';
const report = { at: new Date().toISOString(), checks: [], asked: [], failed: 0 };

function check(name, ok, detail) {
  report.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) report.failed += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`,
  );
}

/** A PowerShell command's output, trimmed; its error's words when it fails. */
async function powershell(command) {
  const shell = windowsPowerShell(process.env);
  const answer = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
  }).catch((error) => ({ stdout: "", stderr: String(error) }));
  return (answer.stdout || answer.stderr || "").trim();
}

/** Every running cua-driver.exe: its pid, path and command line. */
async function driverProcesses() {
  const json = await powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='cua-driver.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  );
  if (!json) return [];
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Whether a process by this image name runs. */
async function running(image) {
  const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"]).catch(() => ({
    stdout: "",
  }));
  return stdout.toLowerCase().includes(image.toLowerCase());
}

/** A window's screen rectangle from PowerShell's answer: left, top, right, bottom. */
function rectOf(out) {
  const match = /^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/m.exec(out);
  return match ? { left: +match[1], top: +match[2], right: +match[3], bottom: +match[4] } : null;
}

/** The screen rectangle of a process's main window (by process name), or null. */
async function windowRect(processName) {
  return rectOf(
    await powershell(`${DOTNET}
foreach ($p in [Diagnostics.Process]::GetProcessesByName('${processName}')) {
  if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $e = [Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle); ${RECT}; break }
}`),
  );
}

/** The screen rectangle of the top-level window with this exact title, or null. */
async function titledRect(title) {
  return rectOf(
    await powershell(`${DOTNET}
$named = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, '${title}')
$e = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $named)
if ($null -ne $e) { ${RECT} }`),
  );
}

/**
 * Minimize every window on the desktop that can be, as the person would before opening a window to
 * work in: what this background runner opens next cannot take the front from them (the runner's own
 * console, a dialog its image left open), so they are moved out of its way.
 */
async function clearDesktop() {
  await powershell(`${DOTNET}
$pattern = [Windows.Automation.WindowPattern]::Pattern
foreach ($w in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
  try { $p = $w.GetCurrentPattern($pattern); if ($p.Current.CanMinimize) { $p.SetWindowVisualState([Windows.Automation.WindowVisualState]::Minimized) } } catch { }
}`);
  await sleep(700);
}

/**
 * Bring a window to the front, as the person would by clicking it in the taskbar: by its process id
 * or its title. A window launched from a background process can open behind another one.
 */
async function toFront(target) {
  const which = typeof target === "number" ? String(target) : `'${target.replaceAll("'", "''")}'`;
  await powershell(
    `$PSModuleAutoLoadingPreference = 'None'; [void][Activator]::CreateInstance([Type]::GetTypeFromProgID('WScript.Shell')).AppActivate(${which})`,
  );
  await sleep(700);
}

/** The primary screen's size in pixels. */
async function screenSize() {
  const out = await powershell(
    `${DOTNET}; $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width),$($b.Height)"`,
  );
  const [width, height] = out.split(",").map(Number);
  return { width, height };
}

/** A PNG's width and height from its header. */
function pngSize(bytes) {
  return bytes.length > 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
}

/** An answer's text and pictures, the shape the tool answers with. */
function partsOf(answer) {
  if (typeof answer === "string") return { text: answer, images: [] };
  return { text: answer.text ?? "", images: answer.images ?? [] };
}

/** Start a program on the desktop, on its own. */
function launch(file, args = []) {
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child;
}

/** Wait for a window (a process's main window, or `find`'s); null when none appears in time. */
async function untilWindow(processName, ms = 15_000, find = windowRect) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const rect = await find(processName);
    if (rect && rect.right > rect.left) return rect;
    await sleep(500);
  }
  return null;
}

/** The child mode: start an embedded daemon, say its pid, then wait to be killed. */
async function child(resources) {
  const daemon = embeddedCuaDriver(
    { command: bundledCuaDriver(resources), args: [] },
    { hostBundleId: HOST_BUNDLE_ID, env: driverEnv() },
  );
  await daemon.command();
  console.log("daemon-up");
  await sleep(10 * 60_000);
}

/** Vendor the pinned driver as a release does, and check its signature. */
async function vendored() {
  const resources = await mkdtemp(path.join(os.tmpdir(), "genex-cua-resources-"));
  const driver = await vendorCuaDriver(root, resources);
  const binary = bundledCuaDriver(resources);
  check("the pinned cua-driver.exe is vendored", driver.version.length > 0, driver);
  const literal = binary.replaceAll("'", "''");
  const signature = await powershell(
    `$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`,
  );
  check(
    "cua-driver.exe carries a valid Authenticode signature from Cua AI, Inc.",
    /^Valid\|.*Cua AI/.test(signature),
    signature,
  );
  return { resources, binary };
}

/**
 * The app's own wiring (desktop-control-host.ts) without Electron, and one session's `desktop` tool
 * whose person allows computer control and the apps this run means to use.
 */
function session(binary) {
  let embedded = null;
  const control = desktopControl({
    findDriver: async () => binary,
    connect: (found) => {
      embedded ??= embeddedCuaDriver({ command: found, args: [] }, { hostBundleId: HOST_BUNDLE_ID, env: driverEnv() });
      const daemon = embedded;
      return connectCuaDriver(() => daemon.command(), {
        local: true,
        holder: GrantHolder.Host,
        restart: () => daemon.restart(),
      });
    },
    ownApp: (app) => app.pid === process.pid,
    shutdown: async () => {
      await embedded?.stop();
    },
  });
  const allowed = new Set(["notepad.exe", "powershell.exe", "rundll32.exe", "applicationframehost.exe"]);
  const tools = control.toolsFor({
    frameDir: path.join(evidence, "frames"),
    ask: async (question, app) => {
      report.asked.push({ question, app: app ?? null });
      return question === DesktopQuestion.Session || allowed.has(app?.bundleId ?? "");
    },
  });
  let shot = 0;
  const call = async (args) => {
    const { text, images } = partsOf(await tools.onLiveTool("desktop", args));
    for (const image of images) {
      shot += 1;
      const name = `${String(shot).padStart(2, "0")}-${args.action}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`;
      await writeFile(path.join(evidence, name), Buffer.from(image.data, "base64"));
    }
    return { text, images };
  };
  return { control, call };
}

/** The first call starts the daemon and the probe, as an agent's first call does; answers the screen's size and where a screen point is in the picture. */
async function firstLook(call, binary) {
  const first = await call({ action: "screenshot" });
  const picture = first.images[0] ? pngSize(Buffer.from(first.images[0].data, "base64")) : null;
  check("the desktop tool takes a picture of the screen", picture !== null, {
    picture,
    said: first.text.slice(0, 200),
  });
  const processes = await driverProcesses();
  const daemon = processes.find((p) => /\sserve\s/.test(p.CommandLine ?? ""));
  const onPipe = /--embedded --socket \\\\\.\\pipe\\genex-cua-[0-9a-f-]{36}/.test(daemon?.CommandLine ?? "");
  const bundled = path.resolve(daemon?.ExecutablePath ?? "") === path.resolve(binary);
  check("the daemon is the bundled exe, embedded on a private named pipe", onPipe && bundled, processes);
  const screen = await screenSize();
  const scale = (value, to) => (picture ? Math.round((value * picture[to]) / screen[to]) : value);
  return { screen, at: (point) => `${scale(point.x, "width")},${scale(point.y, "height")}` };
}

/** A rectangle's centre on screen. */
function middle(rect) {
  return { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) };
}

/**
 * A screen point inside `rect` that Windows says reaches `exe` (its centre when it can), or the
 * apps that cover it instead. Windows lets only the app in front hand the front over, so a window
 * this background runner opens can stay behind what is already there: the runner's own console,
 * or a dialog the runner image left open. A click at a covered point lands in the window over it,
 * and the studio rightly charges it to that app, so the step looks for a point only this window
 * covers, asking the same probe the studio asks.
 */
async function uncovered(probe, screen, rect, exe) {
  const points = [middle(rect)];
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++)
      points.push({
        x: Math.round(rect.left + ((rect.right - rect.left) * (i + 0.5)) / GRID),
        y: Math.round(rect.top + ((rect.bottom - rect.top) * (j + 0.5)) / GRID),
      });
  const over = new Set();
  for (const point of points) {
    const app = await probe.at(point.x, point.y, screen).catch(() => null);
    if (app?.exe.toLowerCase() === exe) return { point };
    over.add(app ? app.name || app.exe : "no app");
  }
  return { covered: [...over] };
}

/** Notepad: click into it, type a line, read it back from its own tree. Answers its process. */
async function notepadStep(call, look) {
  const notepadProcess = launch("notepad.exe");
  const notepad = await untilWindow("notepad");
  check("Notepad opens a window", notepad !== null, notepad);
  if (!notepad) return null;
  await toFront(notepadProcess.pid);
  const click = await call({ action: "left_click", coordinate: look.at(middle(notepad)) });
  check(
    "a click into Notepad is allowed once the person allows Notepad",
    !REFUSED.test(click.text),
    click.text.slice(0, 300),
  );
  const typed = await call({ action: "type", text: LINE });
  check("typing into Notepad goes ahead", !REFUSED.test(typed.text), typed.text.slice(0, 300));
  await call({ action: "screenshot" });
  const state = await call({ action: "state" });
  check("Notepad's own tree reads the typed line back", state.text.includes(LINE), state.text.slice(0, 600));
  return notepadProcess;
}

/**
 * The stop shortcut's chord, sent to Notepad: Windows must not take it for Task Manager. With no app
 * registering it (no Genex here), Windows reads its Alt+Esc and sends the front window back; what
 * is in front after it is recorded.
 */
async function chordStep(call, notepadProcess) {
  if (!notepadProcess) return;
  await toFront(notepadProcess.pid);
  const before = await running("Taskmgr.exe");
  const chord = await call({ action: "key", text: "ctrl+alt+shift+escape" });
  await sleep(2000);
  const after = await call({ action: "state" });
  check("Windows does not take Ctrl+Alt+Shift+Esc for Task Manager", before || !(await running("Taskmgr.exe")), {
    chord: chord.text.slice(0, 120),
    inFrontAfter: after.text.slice(0, 160),
  });
}

/** The saved-passwords dialog (rundll32.exe) and Windows Settings (a packaged app's frame): never driven. */
async function neverDrivenSteps(call, look, probe) {
  launch("rundll32.exe", ["keymgr.dll,KRShowKeyMgr"]);
  const keys = await untilWindow("rundll32");
  if (keys) {
    const refused = await call({ action: "left_click", coordinate: look.at(middle(keys)) });
    check(
      "a click in the saved-passwords dialog is refused",
      /never driven/i.test(refused.text),
      refused.text.slice(0, 300),
    );
  } else check("the saved-passwords dialog opens (not on every Windows edition)", true, "no window: skipped");
  await run("taskkill", ["/IM", "rundll32.exe", "/F"]).catch(() => {});
  await clearDesktop();
  launch("explorer.exe", ["ms-settings:"]);
  const settings = await untilWindow("ApplicationFrameHost", 20_000);
  if (settings) {
    await toFront("Settings");
    const free = await uncovered(probe, look.screen, settings, "applicationframehost.exe");
    const refused = free.point ? await call({ action: "left_click", coordinate: look.at(free.point) }) : null;
    check(
      "a click in Windows Settings (ApplicationFrameHost) is refused",
      refused !== null && /never driven/i.test(refused.text),
      refused ? refused.text.slice(0, 300) : `Settings is covered everywhere by: ${free.covered.join(", ")}`,
    );
  } else check("Windows Settings opens (not on every Windows edition)", true, "no Settings window: skipped");
  await run("taskkill", ["/IM", "SystemSettings.exe", "/F"]).catch(() => {});
}

/** A focused password field in an allowed app: typing into it is refused. */
async function passwordStep(call, look, probe) {
  // Started as this runner's own child, not detached: what PowerShell says, and its exit, are kept
  // to say why no window opened.
  await clearDesktop();
  const form = spawn(windowsPowerShell(process.env), ["-NoProfile", "-NonInteractive", "-Command", PASSWORD_FORM], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  let exit = null;
  const keep = (chunk) => {
    said = `${said}${chunk}`.slice(-2_000);
  };
  form.stdout.on("data", keep);
  form.stderr.on("data", keep);
  form.on("error", (error) => keep(String(error)));
  form.on("exit", (code, signal) => {
    exit = code ?? signal;
  });
  // Windows PowerShell and Windows Forms start slowly on a cold machine.
  const window = await untilWindow("Genex password field", 60_000, titledRect);
  const free = window ? await uncovered(probe, look.screen, window, "powershell.exe") : null;
  if (free?.point) {
    await toFront(form.pid);
    await call({ action: "left_click", coordinate: look.at(free.point) });
    // What Windows says has the keyboard, as the studio's probe reads it: why a refusal did not come.
    const front = await probe.front().catch((error) => String(error));
    const focused = await powershell(
      `${DOTNET}; $e = [Windows.Automation.AutomationElement]::FocusedElement; "$($e.Current.ControlType.ProgrammaticName)|$($e.Current.ClassName)|$($e.Current.IsPassword)|$($e.Current.FrameworkId)"`,
    );
    const refused = await call({ action: "type", text: "hunter2" });
    check(
      "typing into a focused password field is refused",
      // The refusal's own words: the form's title also says "password field".
      /the focused field is a password field/i.test(refused.text),
      { front, focused, said: refused.text.slice(0, 160) },
    );
    await call({ action: "screenshot" });
  } else if (window)
    check("the password form can be clicked", false, `covered everywhere by: ${free.covered.join(", ")}`);
  else check("the password form opens", false, { exit, said: said.trim() || "nothing" });
  try {
    process.kill(form.pid);
  } catch {}
}

/** The stop: what the shortcut and quitting call, under a call that is still waiting. */
async function stopStep(control, call) {
  const waiting = call({ action: "wait", duration: 4 });
  await sleep(800);
  await control.stopAll();
  const stopped = await waiting;
  check(
    "a stop ends the session under its call",
    /stopped computer control/i.test(stopped.text),
    stopped.text.slice(0, 300),
  );
  await sleep(1500);
  const left = await driverProcesses();
  check("the stop ends the daemon: no cua-driver.exe runs", left.length === 0, left);
}

/** An app that dies without stopping: the lifetime pipe ends its daemon. */
async function crashStep(resources) {
  const app = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", resources], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const up = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    app.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("daemon-up")) return;
      clearTimeout(timer);
      resolve(true);
    });
  });
  check("a second app starts its own daemon", up && (await driverProcesses()).length > 0);
  await run("taskkill", ["/PID", String(app.pid), "/F"]).catch(() => {});
  await sleep(3000);
  const left = await driverProcesses();
  check("an app killed without a stop leaves no cua-driver.exe behind", left.length === 0, left);
}

async function main() {
  if (process.argv[2] === "--child") return child(process.argv[3]);
  if (process.platform !== "win32") throw new Error("this runner drives a Windows desktop");
  await rm(evidence, { recursive: true, force: true });
  await mkdir(evidence, { recursive: true });
  const { resources, binary } = await vendored();
  const { control, call } = session(binary);
  const look = await firstLook(call, binary);
  const probe = windowsProbe(probeCommand(process.env));
  const notepad = await notepadStep(call, look);
  await chordStep(call, notepad);
  // Notepad would sit over what opens next.
  await run("taskkill", ["/IM", "notepad.exe", "/F"]).catch(() => {});
  await neverDrivenSteps(call, look, probe);
  await passwordStep(call, look, probe);
  await probe.close();
  await stopStep(control, call);
  await crashStep(resources);
  await run("taskkill", ["/IM", "notepad.exe", "/F"]).catch(() => {});
  await writeFile(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(resources, { recursive: true, force: true }).catch(() => {});
  console.log(`${report.checks.length - report.failed}/${report.checks.length} checks passed; evidence in ${evidence}`);
  process.exit(report.failed ? 1 : 0);
}

main().catch(async (error) => {
  check("the run finished", false, String(error?.stack ?? error));
  await mkdir(evidence, { recursive: true }).catch(() => {});
  await writeFile(path.join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`).catch(() => {});
  process.exit(1);
});
