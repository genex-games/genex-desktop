/**
 * What Windows itself says about the desktop, for computer control on a PC: the app that holds the
 * keyboard and whether its focused field is a password field (UI Automation's `IsPassword`, or a
 * Win32 edit control's own password style, which .NET's UI Automation does not read), and the app
 * a click at a screen point reaches (UI Automation's element at that point, up to its top-level
 * window, as the click lands in that window). cua's window list cannot say either: it lists windows
 * on other virtual desktops and transparent overlays (a game overlay over the whole screen) as on
 * screen, and its app listing rescans every installed app.
 *
 * A host helper like the driver: Windows PowerShell (Microsoft's, on every Windows 10 and 11) runs a
 * fixed script, handed over as `-EncodedCommand` (no file, so no execution policy applies), outside
 * the ProcessSandbox, using only .NET's own UI Automation, Windows Forms, process reads and user32's
 * `GetWindowLongW` declared in memory: nothing is compiled and no cmdlet runs, so no generated DLL,
 * no compiler and no first-use preparation of PowerShell's modules stand between it and its first
 * answer. It reports its start in stages, says it is ready with the primary screen's size as
 * it sees it (Windows may scale a process's points), then answers one JSON line for each request
 * line on its stdin: `front`, `at <x> <y>` (in its own points: the caller scales the driver's
 * physical pixels to them) or `pid <n>`. An app is its executable's name and its file description
 * (the name the person knows it by); a window no process can be read for answers pid 0, which the
 * caller refuses. A request that does not answer in time ends the helper, and the next request
 * starts a fresh one.
 */
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";

/** How long the helper has to start PowerShell, load UI Automation and say it is ready. */
const START_MS = 30 * SECOND_MS;
/** How long one request may take: UI Automation waits on the focused app, which can hang. */
const REQUEST_MS = 5 * SECOND_MS;
/** How long a helper whose output closed has to exit, so its own words say why. */
const EXIT_WAIT_MS = 2 * SECOND_MS;
/** How much of the helper's stderr is kept to say why it stopped. */
const MAX_STDERR_CHARS = 2_000;
/** How long the helper waits before asking again for focus that is on no text field. */
const FOCUS_SETTLE_MS = 250;

const MESSAGE = {
  notStarted: (why: string) => `the Windows window probe did not start: ${why}`,
  ended: (why: string) => `the Windows window probe stopped: ${why}`,
  timedOut: (request: string) => `the Windows window probe did not answer "${request}" in time`,
  startLate: (ms: number, stage: string, said: string) =>
    `the Windows window probe was not ready after ${Math.round(ms / SECOND_MS)} s (last stage: ${stage}${said ? `; it said: ${said}` : ""})`,
  closed: "the Windows window probe was closed",
  badAnswer: (line: string) => `the Windows window probe answered something unreadable: ${line.slice(0, 200)}`,
} as const;

/**
 * The helper's script. Its answers are ASCII JSON (every other character escaped), so no console
 * code page can garble them.
 */
export const WINDOW_PROBE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
# No cmdlets, so no module is ever loaded: a first cmdlet makes PowerShell prepare every installed
# module for first use, which can take many seconds on a fresh machine.
$PSModuleAutoLoadingPreference = 'None'
$Culture = [System.Globalization.CultureInfo]::InvariantCulture

# One JSON value: ASCII only (every other character escaped), so no console code page can garble it.
function Quote([string]$text) {
  $json = [System.Text.StringBuilder]::new('"')
  foreach ($c in $text.ToCharArray()) {
    $code = [int]$c
    if ($c -eq '"' -or $c -eq '\') { [void]$json.Append('\').Append($c) }
    elseif ($code -lt 0x20 -or $code -gt 0x7e) { [void]$json.Append('\u').Append($code.ToString('x4')) }
    else { [void]$json.Append($c) }
  }
  return $json.Append('"').ToString()
}
function Json($value) {
  if ($null -eq $value) { return 'null' }
  if ($value -is [bool]) { if ($value) { return 'true' } return 'false' }
  if ($value -is [int] -or $value -is [long] -or $value -is [double]) { return $value.ToString($Culture) }
  if ($value -is [System.Collections.IDictionary]) {
    $fields = foreach ($key in $value.Keys) { (Quote $key) + ':' + (Json $value[$key]) }
    return '{' + ($fields -join ',') + '}'
  }
  return Quote ([string]$value)
}
function Say($value) {
  [Console]::Out.WriteLine((Json $value))
  [Console]::Out.Flush()
}

Say @{ stage = 'started' }
foreach ($assembly in 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase', 'System.Windows.Forms') {
  [void][System.Reflection.Assembly]::LoadWithPartialName($assembly)
}
Say @{ stage = 'loaded' }
$Element = [System.Windows.Automation.AutomationElement]
$Root = $Element::RootElement
$Walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$Edit = [System.Windows.Automation.ControlType]::Edit
# A Win32 edit control's class (Notepad's, a Windows Forms text box's, a rich edit's), and the style
# that makes one a password field (ES_PASSWORD).
$EditClass = '^(Edit|RichEdit\w*|WindowsForms10\.(EDIT|RichEdit\w*)\..*)$'
$PasswordStyle = 0x20

# user32's GetWindowLongW, declared in memory (Reflection.Emit): nothing is compiled. .NET's UI
# Automation names a Windows Forms text box a Pane with no password flag, so a Win32 edit's own
# style is read instead. Without it the caller reads the window's tree.
$User32 = $null
try {
  $assembly = [System.AppDomain]::CurrentDomain.DefineDynamicAssembly([System.Reflection.AssemblyName]::new('GenexWindowProbe'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
  $type = $assembly.DefineDynamicModule('GenexWindowProbe').DefineType('User32', 'Public, Class')
  $method = $type.DefinePInvokeMethod('GetWindowLongW', 'user32.dll', 'Public, Static, PinvokeImpl', 'Standard', [int], [Type[]]@([IntPtr], [int]), 'Winapi', 'Unicode')
  $method.SetImplementationFlags('PreserveSig')
  $User32 = $type.CreateType()
} catch { }

# The primary screen in UI Automation's own points: Windows Forms' view of it, scaled by how the two
# see the whole desktop (both are scaled alike unless Windows treats them differently).
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$desktop = $Root.Current.BoundingRectangle
$scaleX = 1
$scaleY = 1
if ($virtual.Width -gt 0) { $scaleX = $desktop.Width / $virtual.Width }
if ($virtual.Height -gt 0) { $scaleY = $desktop.Height / $virtual.Height }
$view = [ordered]@{ width = [int][math]::Round($primary.Width * $scaleX); height = [int][math]::Round($primary.Height * $scaleY) }

# The top-level window an element is in: the window a click on it lands in.
function TopOf($node) {
  $current = $node
  for ($depth = 0; $depth -lt 64; $depth++) {
    $parent = $Walker.GetParent($current)
    if ($null -eq $parent -or [System.Windows.Automation.Automation]::Compare($parent, $Root)) { return $current }
    $current = $parent
  }
  return $current
}

# Whether an element is a Win32 edit control, by its class.
function IsWin32Edit($node) {
  try { return [string]$node.Current.ClassName -match $EditClass } catch { return $false }
}

# Whether a Win32 edit control has the password style; null when it is none or its style can't be read.
function Win32SecureOf($node) {
  if ($null -eq $User32 -or -not (IsWin32Edit $node)) { return $null }
  try {
    $handle = [IntPtr][long]$node.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return $null }
    return ($User32::GetWindowLongW($handle, -16) -band $PasswordStyle) -ne 0
  } catch { return $null }
}

# Whether the focused element is a password field: UI Automation's flag, or a Win32 edit's own
# style; null when focus is on no text field (an app whose accessibility wakes on first asking may
# still say its window), so the caller reads the tree.
function SecureOf($node) {
  $win32 = Win32SecureOf $node
  if ($win32 -eq $true) { return $true }
  try {
    if ($node.Current.ControlType -ne $Edit) { return $win32 }
    return [bool]$node.Current.IsPassword
  } catch { return $win32 }
}

# Whether an element is a text field, as UI Automation or its Win32 class says.
function IsTextField($node) {
  try { if ($node.Current.ControlType -eq $Edit) { return $true } } catch { }
  return IsWin32Edit $node
}

function AppOfProcess([int]$id) {
  if ($id -le 0) { return @{ pid = 0 } }
  try { $process = [System.Diagnostics.Process]::GetProcessById($id) } catch { return @{ pid = 0 } }
  $name = ''
  try { $name = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($process.MainModule.FileName).FileDescription } catch { }
  return [ordered]@{ pid = $id; exe = $process.ProcessName + '.exe'; name = ([string]$name).Trim() }
}

function AppOfElement($node, [bool]$focus) {
  if ($null -eq $node) { return @{ pid = 0 } }
  $top = TopOf $node
  $app = AppOfProcess ([int]$top.Current.ProcessId)
  if ($app.pid -le 0) { return $app }
  $app.window = [long]$top.Current.NativeWindowHandle
  if ($focus) { $app.secure = SecureOf $node }
  return $app
}

# The focused element. An app whose accessibility wakes on first asking (Chromium, Electron) says its
# window before its field: focus that is on no text field is asked for once more, a moment later.
function Focused() {
  $node = $Element::FocusedElement
  if ($null -eq $node -or (IsTextField $node)) { return $node }
  [System.Threading.Thread]::Sleep(${FOCUS_SETTLE_MS})
  $again = $Element::FocusedElement
  if ($null -eq $again) { return $node }
  return $again
}

function Ask([string]$line) {
  $parts = $line.Trim().Split(' ')
  if ($parts[0] -eq 'front' -and $parts.Length -eq 1) { return AppOfElement (Focused) $true }
  if ($parts[0] -eq 'at' -and $parts.Length -eq 3) {
    $point = [System.Windows.Point]::new([int]::Parse($parts[1], $Culture), [int]::Parse($parts[2], $Culture))
    return AppOfElement ($Element::FromPoint($point)) $false
  }
  if ($parts[0] -eq 'pid' -and $parts.Length -eq 2) { return AppOfProcess ([int]::Parse($parts[1], $Culture)) }
  return @{ error = 'unknown request' }
}

Say ([ordered]@{ ready = $true; view = $view })
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { Say (Ask $line) } catch { Say @{ error = $_.Exception.Message } }
}
`;

/** An app as Windows names it: its process, its executable, its file description, and (for the one in front) whether its focused field is a password field, when UI Automation could say. */
export interface ProbedApp {
  pid: number;
  exe: string;
  name: string;
  secure: boolean | null;
  /** Its top-level window's handle (the driver's window id), when Windows gave one. */
  window: number | null;
}

/** A screen's size in pixels or points. */
export interface ScreenSize {
  width: number;
  height: number;
}

/** What the helper answers. */
export interface WindowsProbe {
  /** The app that holds the keyboard, with its focused field's password flag; null when none can be read. */
  front(): Promise<ProbedApp | null>;
  /**
   * The app a click at this point reaches; null when none can be read. The point is in the driver's
   * physical pixels of a primary screen this size, scaled here to the helper's own points.
   */
  at(x: number, y: number, screen: ScreenSize): Promise<ProbedApp | null>;
  /** A running process as an app; null when it cannot be read. */
  process(pid: number): Promise<ProbedApp | null>;
  /** Stop the helper. */
  close(): Promise<void>;
}

/** How the helper is started: Windows PowerShell, its arguments and the environment it may see. */
export interface ProbeCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Windows PowerShell by its full path under SystemRoot, so neither PATH nor the current folder stands in. */
export function windowsPowerShell(env: Record<string, string | undefined>): ProbeCommand["command"] {
  return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The helper as Windows PowerShell runs it: no profile, no prompt, the script as an encoded command. */
export function probeCommand(env: Record<string, string>): ProbeCommand {
  const script = Buffer.from(WINDOW_PROBE_SCRIPT, "utf16le").toString("base64");
  return {
    command: windowsPowerShell(env),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
    env,
  };
}

/** One answer line as an app, or null for none; throws on an answer that is neither. */
export function parseProbeAnswer(line: string): ProbedApp | null {
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    throw new Error(MESSAGE.badAnswer(line));
  }
  if (!body || typeof body !== "object") throw new Error(MESSAGE.badAnswer(line));
  const answer = body as Record<string, unknown>;
  if (typeof answer.error === "string") throw new Error(answer.error);
  const pid = typeof answer.pid === "number" && Number.isSafeInteger(answer.pid) ? answer.pid : null;
  if (pid === null) throw new Error(MESSAGE.badAnswer(line));
  const exe = typeof answer.exe === "string" ? answer.exe : "";
  if (pid === 0 || !exe) return null;
  const secure = typeof answer.secure === "boolean" ? answer.secure : null;
  const window =
    typeof answer.window === "number" && Number.isSafeInteger(answer.window) && answer.window > 0
      ? answer.window
      : null;
  return { pid, exe, name: typeof answer.name === "string" ? answer.name : "", secure, window };
}

/** A started helper: its process, its answers in order, why it ended if it did, and its screen. */
interface Running {
  child: ChildProcess;
  lines: AsyncIterator<string>;
  exited: Promise<void>;
  ended: () => string | null;
  /** What it last said of its start, and everything it wrote to stderr: why a start was late. */
  stage: string;
  said: () => string;
  /** The primary screen in its own points, once it is ready. */
  view: ScreenSize | null;
}

/** Start the helper and wait for it to say it is ready. */
async function startProbe(command: ProbeCommand, startMs: number): Promise<Running> {
  const child = spawn(command.command, command.args, {
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // A helper that ended while idle makes the next write fail: that request answers why instead.
  child.stdin.on("error", () => {});
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    said = `${said}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
  });
  let ended: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      ended ??= errorMessage(error);
      resolve();
    });
    child.once("exit", (code) => {
      ended ??= `it exited (${code ?? "signal"})`;
      resolve();
    });
  });
  const running: Running = {
    child,
    lines: readline.createInterface({ input: child.stdout })[Symbol.asyncIterator](),
    exited,
    ended: () => (ended === null ? null : said.trim() || ended),
    stage: "launched",
    said: () => said.trim(),
    view: null,
  };
  try {
    await untilReady(running, startMs);
    return running;
  } catch (error) {
    await stopProbe(running);
    throw new Error(MESSAGE.notStarted(errorMessage(error)));
  }
}

/** One line the helper says while it starts: its stage, or that it is ready with its screen. */
function startLine(line: string): { stage: string } | { view: ScreenSize | null } | null {
  let body: unknown;
  try {
    body = JSON.parse(line.replace(/^\uFEFF/, "").trim());
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const said = body as Record<string, unknown>;
  if (typeof said.stage === "string") return { stage: said.stage };
  if (said.ready !== true) return null;
  const view = said.view && typeof said.view === "object" ? (said.view as Record<string, unknown>) : {};
  const sized = typeof view.width === "number" && view.width > 0 && typeof view.height === "number" && view.height > 0;
  return { view: sized ? { width: Number(view.width), height: Number(view.height) } : null };
}

/**
 * Wait for the helper's ready line, keeping its stages so a late start says where it stood.
 * PowerShell may say something else first, which is passed over.
 */
async function untilReady(running: Running, startMs: number): Promise<void> {
  const began = Date.now();
  const deadline = began + startMs;
  for (;;) {
    const late = MESSAGE.startLate(Date.now() - began, running.stage, running.said());
    const line = await nextLine(running, Math.max(1, deadline - Date.now()), late).catch((error: unknown) => {
      // The message is written before the wait: say where it stood when the wait ran out.
      if (running.ended() !== null) throw error;
      throw new Error(MESSAGE.startLate(Date.now() - began, running.stage, running.said()));
    });
    const said = startLine(line);
    if (said && "stage" in said) running.stage = said.stage;
    if (said && "view" in said) {
      running.view = said.view;
      return;
    }
  }
}

/** The helper's next line, within `ms`; refuses with `late` when it says nothing in time, or why it ended. */
async function nextLine(running: Running, ms: number, late: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(late)), ms);
  });
  try {
    const next = await Promise.race([running.lines.next(), deadline]);
    if (!next.done) return next.value;
    // Its output closes before its exit is seen: wait for that, so its own words are the reason.
    await Promise.race([running.exited, sleep(EXIT_WAIT_MS)]);
    throw new Error(MESSAGE.ended(running.ended() ?? "its output closed"));
  } finally {
    clearTimeout(timer);
  }
}

/** Stop the helper. */
async function stopProbe(running: Running): Promise<void> {
  running.child.stdin?.end();
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
  await Promise.race([running.exited, sleep(EXIT_WAIT_MS)]);
}

/** A request line, made once the helper is live from its view of the screen. */
type Request = (view: ScreenSize | null) => string;

/**
 * The helper, started on its first request (or by `ready`) and kept for the next ones. Requests
 * go one at a time; one that fails or does not answer in `requestMs` stops the helper, so a hung
 * one never answers a later request.
 */
export function windowsProbe(
  command: ProbeCommand,
  options: { startMs?: number; requestMs?: number } = {},
): WindowsProbe & { ready(): Promise<void> } {
  const startMs = options.startMs ?? START_MS;
  const requestMs = options.requestMs ?? REQUEST_MS;
  let running: Promise<Running> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const live = (): Promise<Running> => {
    if (closed) return Promise.reject(new Error(MESSAGE.closed));
    running ??= startProbe(command, startMs).catch((error: unknown) => {
      running = null;
      throw error;
    });
    return running;
  };
  const drop = async (): Promise<void> => {
    const current = await running?.catch(() => null);
    running = null;
    if (current) await stopProbe(current);
  };
  /** One request to the live helper; a failed one ends it, so a late answer never meets a later request. */
  const askOnce = async (
    requestOf: Request,
  ): Promise<{ answer: ProbedApp | null } | { error: unknown; died: boolean }> => {
    const probe = await live();
    const request = requestOf(probe.view);
    try {
      probe.child.stdin?.write(`${request}\n`);
      return { answer: parseProbeAnswer(await nextLine(probe, requestMs, MESSAGE.timedOut(request))) };
    } catch (error) {
      const died = probe.ended() !== null;
      await drop();
      return { error, died };
    }
  };
  // A helper that ended while idle (its end not yet seen) fails the request it is sent: that request
  // is asked once more of a fresh helper. One that is alive but late is not asked again.
  const answerOf = async (request: Request): Promise<ProbedApp | null> => {
    const first = await askOnce(request);
    if ("answer" in first) return first.answer;
    if (!first.died) throw first.error;
    const second = await askOnce(request);
    if ("answer" in second) return second.answer;
    throw second.error;
  };
  const ask = (request: Request): Promise<ProbedApp | null> => {
    const answer = queue.then(() => answerOf(request));
    queue = answer.catch(() => {});
    return answer;
  };
  return {
    ready: async () => {
      await live();
    },
    front: () => ask(() => "front"),
    at: (x, y, screen) =>
      ask((seen) => {
        // Windows may scale the helper's points: a physical pixel is a point of its own screen size.
        const view = seen ?? screen;
        const px = Math.round((x * view.width) / Math.max(1, screen.width));
        const py = Math.round((y * view.height) / Math.max(1, screen.height));
        return `at ${px} ${py}`;
      }),
    process: (pid) => ask(() => `pid ${Math.trunc(pid)}`),
    close: async () => {
      closed = true;
      await drop();
    },
  };
}
