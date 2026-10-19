/**
 * The sandbox user's read-attributes entry on one folder, set or taken back on that folder alone.
 * It allows SYNCHRONIZE too: CreateFileW adds it to every synchronous open, and Node's stat opens
 * the folder that way on Windows before 11 24H2 (no GetFileInformationByName), so an entry with
 * read attributes alone refused the harness's realpath with EPERM on `AppData`.
 *
 * `icacls`, like every call that sets a folder's DACL by name or handle (SetNamedSecurityInfo,
 * SetSecurityInfo, PowerShell's Set-Acl), re-propagates the folder's inheritable entries to
 * everything under it, even when the entry it adds is not inheritable. A grant on `AppData` walked
 * all of it (1.6 s per 10,000 files on a hosted runner, 16 ms on an empty folder) and held each
 * folder open while it did, so removing a folder in there failed meanwhile. `SetFileSecurityW`
 * writes the one folder's DACL and nothing else, which is all an entry without inheritance needs.
 * Node cannot call it, so one Windows PowerShell run per batch does, through a P/Invoke defined
 * at run time (no compiler). Where PowerShell may not do that (Constrained Language Mode), or
 * does not answer, the batch falls back to `icacls`: slow, but the same entries.
 *
 * The same script sets the deny entries Genex keeps itself for the deny paths that exist
 * (`ownDenyStamps` in `windows-sandbox.ts`): a deny on the path, passed down to everything under
 * it, and a FILE_DELETE_CHILD deny on its parent folder alone. Those have no `icacls` fallback:
 * `icacls` would walk the parent, which is what they exist to avoid.
 */
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";

const run = promisify(execFile);

/** What one edit does to the sandbox user's entry on its folder. */
export const FolderAceOp = {
  /** Allow FILE_READ_ATTRIBUTES and SYNCHRONIZE, without inheritance: merged into an explicit allow it already has. */
  Grant: "grant",
  /** Remove every explicit allow for the SID, as `icacls /remove:g` does; its denies stay. */
  Remove: "remove",
  /** Make the SID's explicit denies on the path exactly the edit's `deny` and `guard` ({@link FolderDenyEdit}). */
  Deny: "deny",
} as const;
export type FolderAceOp = (typeof FolderAceOp)[keyof typeof FolderAceOp];

/** What a deny entry refuses: everything (as srt-win's read deny), or writing, deleting and renaming. */
export const DenyAccess = {
  Read: "read",
  Write: "write",
} as const;
export type DenyAccess = (typeof DenyAccess)[keyof typeof DenyAccess];

/** One change to one folder's own DACL. */
export interface FolderAceEdit {
  dir: string;
  sid: string;
  op: typeof FolderAceOp.Grant | typeof FolderAceOp.Remove;
}

/** The SID's denies on one path, made exactly these; both off takes them back. */
export interface FolderDenyEdit {
  dir: string;
  sid: string;
  op: typeof FolderAceOp.Deny;
  /** Denied on the path and, through inheritance, on everything under it. */
  deny: DenyAccess | null;
  /** FILE_DELETE_CHILD denied on the path alone, so a denied entry in it cannot be deleted or renamed. */
  guard: boolean;
}

/** What became of one edit: done, or the reason Windows refused it. */
export type FolderAceOutcome = { ok: true } | { ok: false; error: string };

/** Applies edits in order and answers one outcome per edit; never throws. */
export type FolderAceEditor = (edits: readonly FolderAceEdit[]) => Promise<FolderAceOutcome[]>;
/** {@link FolderAceEditor} for process exit, when nothing asynchronous runs any more. */
export type FolderAceEditorSync = (edits: readonly FolderAceEdit[]) => FolderAceOutcome[];
/**
 * Applies deny edits in order and answers one outcome per edit, or null when PowerShell could not
 * apply the batch here (locked down, no answer, or a SID the running user holds); never throws.
 */
export type FolderDenyEditor = (edits: readonly FolderDenyEdit[]) => Promise<FolderAceOutcome[] | null>;
/** {@link FolderDenyEditor} for process exit. */
export type FolderDenyEditorSync = (edits: readonly FolderDenyEdit[]) => FolderAceOutcome[] | null;

const MESSAGE = {
  /** A refusal the script gave no words for. */
  Refused: "refused",
} as const;

/** How long one PowerShell batch or one `icacls` call may take. */
const TOOL_TIMEOUT_MS = 15 * SECOND_MS;
/**
 * How long one batch of deny edits may take: srt-win's own `acl stamp` deadline, which these
 * edits replace. Each passes its deny down through everything under its path, as srt-win did,
 * but no longer through everything under the path's parent.
 */
const DENY_TIMEOUT_MS = 60 * SECOND_MS;
/** The variable that hands a batch to the script: base64 of its UTF-8 JSON, so no console code page touches a path. */
const EDITS_ENV = "GENEX_FOLDER_ACES";

/**
 * Edits each folder's DACL through GetFileSecurityW and SetFileSecurityW, which touch that folder
 * only. The DACL is edited as raw entries, never through .NET's canonicalizing ACL classes, so an
 * order srt-win or anyone else chose survives. A deny edit that changes an inheritable entry is
 * written by name instead (SetNamedSecurityInfoW), which passes it down through everything under
 * that path, as srt-win's own stamp does. Writes one JSON outcome per edit, as UTF-8 bytes; a batch
 * that would deny a SID the running user holds is refused whole, with no outcomes.
 */
export const FOLDER_ACE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${EDITS_ENV})) | ConvertFrom-Json
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'GenexFolderAce'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $assembly.DefineDynamicModule('GenexFolderAce').DefineType('GenexFolderAce', 'Public, Class')
$import = [Runtime.InteropServices.DllImportAttribute]
$fields = [Reflection.FieldInfo[]]@($import.GetField('SetLastError'), $import.GetField('CharSet'))
$values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)
foreach ($native in @(
    @('GetFileSecurityW', [bool], [Type[]]@([string], [int], [byte[]], [int], [int].MakeByRefType())),
    @('SetFileSecurityW', [bool], [Type[]]@([string], [int], [byte[]])),
    @('SetNamedSecurityInfoW', [uint32], [Type[]]@([string], [int], [uint32], [IntPtr], [IntPtr], [byte[]], [IntPtr])))) {
  $method = $type.DefineMethod($native[0], 'Public, Static, PinvokeImpl', $native[1], $native[2])
  $attribute = New-Object Reflection.Emit.CustomAttributeBuilder($import.GetConstructor([Type[]]@([string])), [object[]]@('advapi32.dll'), [Reflection.PropertyInfo[]]@(), [object[]]@(), $fields, $values)
  $method.SetCustomAttribute($attribute)
}
$api = $type.CreateType()
$DACL = 4
# FILE_READ_ATTRIBUTES | SYNCHRONIZE
$READ_ATTRIBUTES = 0x100080
# What a deny refuses: FILE_ALL_ACCESS, as srt-win's read deny; or srt-win's write deny (write
# data, append, extended attributes, attributes, DELETE) with FILE_DELETE_CHILD, which no
# inheritable entry on the parent passes down any more.
$DENIED = @{ read = 0x1F01FF; write = 0x10156 }
$DELETE_CHILD = 0x40
$PASSED_DOWN = [Security.AccessControl.AceFlags]'ObjectInherit, ContainerInherit'
$SE_FILE_OBJECT = 1
# DACL_SECURITY_INFORMATION with PROTECTED_DACL_SECURITY_INFORMATION (inheritance stays cut off),
# or with UNPROTECTED_DACL_SECURITY_INFORMATION (what the path inherits is worked out again).
$PROTECTED = [uint32]2147483652
$UNPROTECTED = [uint32]536870916
# Read the call's error before anything else runs: a function call or a variable lookup in
# between makes PowerShell's own calls, which overwrite it.
function Refused($code) { New-Object ComponentModel.Win32Exception ([int]$code) }
function Explicit($ace, $sid, $qualifier) {
  ($ace -is [Security.AccessControl.QualifiedAce]) -and (-not $ace.IsInherited) -and
    ($ace.AceQualifier -eq $qualifier) -and ($ace.SecurityIdentifier -eq $sid)
}
function ExplicitAllow($ace, $sid) { Explicit $ace $sid ([Security.AccessControl.AceQualifier]::AccessAllowed) }
function ExplicitDeny($ace, $sid) { Explicit $ace $sid ([Security.AccessControl.AceQualifier]::AccessDenied) }
# Each edit answers how its DACL must be written: 'none', 'folder' (that path alone) or 'tree'.
function Grant($acl, $sid) {
  for ($i = 0; $i -lt $acl.Count; $i++) {
    $ace = $acl[$i]
    if ((ExplicitAllow $ace $sid) -and $ace.AceFlags -eq [Security.AccessControl.AceFlags]::None) {
      if (($ace.AccessMask -band $READ_ATTRIBUTES) -eq $READ_ATTRIBUTES) { return 'none' }
      $ace.AccessMask = $ace.AccessMask -bor $READ_ATTRIBUTES
      $acl[$i] = $ace
      return 'folder'
    }
  }
  $at = 0
  while ($at -lt $acl.Count -and -not $acl[$at].IsInherited -and "$($acl[$at].AceType)" -like '*Denied*') { $at++ }
  $acl.InsertAce($at, (New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessAllowed, $READ_ATTRIBUTES, $sid, $false, $null)))
  return 'folder'
}
function Remove($acl, $sid) {
  $how = 'none'
  for ($i = $acl.Count - 1; $i -ge 0; $i--) {
    if (ExplicitAllow $acl[$i] $sid) { $acl.RemoveAce($i); $how = 'folder' }
  }
  return $how
}
# Entries as comparable text (inheritance flags and mask of each), the inheritable ones alone when asked.
function Shapes($aces, $inheritable) {
  (@($aces | Where-Object { -not $inheritable -or [int]$_.AceFlags -ne 0 } | ForEach-Object { "$([int]$_.AceFlags):$($_.AccessMask)" }) | Sort-Object) -join ','
}
function Deny($acl, $sid, $edit) {
  $want = @()
  if ($edit.deny) { $want += ,(New-Object Security.AccessControl.CommonAce($PASSED_DOWN, [Security.AccessControl.AceQualifier]::AccessDenied, $DENIED[[string]$edit.deny], $sid, $false, $null)) }
  if ($edit.guard) { $want += ,(New-Object Security.AccessControl.CommonAce([Security.AccessControl.AceFlags]::None, [Security.AccessControl.AceQualifier]::AccessDenied, $DELETE_CHILD, $sid, $false, $null)) }
  $had = @(for ($i = 0; $i -lt $acl.Count; $i++) { if (ExplicitDeny $acl[$i] $sid) { $acl[$i] } })
  if ((Shapes $had $false) -eq (Shapes $want $false)) { return 'none' }
  for ($i = $acl.Count - 1; $i -ge 0; $i--) { if (ExplicitDeny $acl[$i] $sid) { $acl.RemoveAce($i) } }
  foreach ($ace in $want) { $acl.InsertAce(0, $ace) }
  if ((Shapes $had $true) -eq (Shapes $want $true)) { return 'folder' }
  return 'tree'
}
# By name, with the path's explicit entries alone: Windows works out again what it inherits and
# passes its inheritable entries down through everything under it, as srt-win's stamp does.
function WriteTree($dir, $sd) {
  $acl = $sd.DiscretionaryAcl
  $own = New-Object Security.AccessControl.RawAcl($acl.Revision, $acl.Count)
  foreach ($ace in $acl) { if (-not $ace.IsInherited) { $own.InsertAce($own.Count, $ace) } }
  $bytes = New-Object byte[] $own.BinaryLength
  $own.GetBinaryForm($bytes, 0)
  $protected = ([int]$sd.ControlFlags -band [int][Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -ne 0
  $info = if ($protected) { $PROTECTED } else { $UNPROTECTED }
  $code = $api::SetNamedSecurityInfoW($dir, $SE_FILE_OBJECT, $info, [IntPtr]::Zero, [IntPtr]::Zero, $bytes, [IntPtr]::Zero)
  if ($code -ne 0) { throw (Refused $code) }
}
function Edit($edit) {
  $needed = 0
  $ok = $api::GetFileSecurityW($edit.dir, $DACL, $null, 0, [ref]$needed); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($needed -le 0) { throw (Refused $code) }
  $bytes = New-Object byte[] $needed
  $ok = $api::GetFileSecurityW($edit.dir, $DACL, $bytes, $needed, [ref]$needed); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (-not $ok) { throw (Refused $code) }
  $sd = New-Object Security.AccessControl.RawSecurityDescriptor($bytes, 0)
  $acl = $sd.DiscretionaryAcl
  $deny = $edit.op -eq '${FolderAceOp.Deny}'
  # No DACL lets everyone in: there is nothing to add an entry to, and a deny must not pass for done.
  if ($null -eq $acl) { if ($deny) { throw 'the path has no DACL' } else { return } }
  $sid = New-Object Security.Principal.SecurityIdentifier ([string]$edit.sid)
  $how = if ($deny) { Deny $acl $sid $edit } elseif ($edit.op -eq '${FolderAceOp.Grant}') { Grant $acl $sid } else { Remove $acl $sid }
  if ($how -eq 'none') { return }
  $sd.DiscretionaryAcl = $acl
  if ($how -eq 'tree') { WriteTree $edit.dir $sd; return }
  $out = New-Object byte[] $sd.BinaryLength
  $sd.GetBinaryForm($out, 0)
  $ok = $api::SetFileSecurityW($edit.dir, $DACL, $out); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (-not $ok) { throw (Refused $code) }
}
function Answer($json) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
# A deny for the running user, or a group it is in, would lock the person out of their own files.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$held = @($identity.User) + @($identity.Groups)
foreach ($edit in @($request)) {
  if ($edit.op -eq '${FolderAceOp.Deny}' -and ($held -contains (New-Object Security.Principal.SecurityIdentifier ([string]$edit.sid)))) {
    Answer '{"refused":"the running user holds this SID"}'
    exit
  }
}
$outcomes = foreach ($edit in @($request)) {
  try { Edit $edit; @{ ok = $true } } catch { @{ ok = $false; error = $_.Exception.Message } }
}
Answer (ConvertTo-Json -InputObject @($outcomes) -Compress)
`;

/** Windows PowerShell by its full path: a folder on PATH must not stand in for it. */
function powershell(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** The PowerShell command line and environment that run one batch. */
export function folderAceCommand(
  edits: readonly (FolderAceEdit | FolderDenyEdit)[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const script = Buffer.from(FOLDER_ACE_SCRIPT, "utf16le").toString("base64");
  const payload = Buffer.from(JSON.stringify(edits), "utf8").toString("base64");
  return {
    file: powershell(env),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
    env: { ...env, [EDITS_ENV]: payload },
  };
}

/** The script's answer, when it is one outcome per edit; anything else is null. */
export function folderAceOutcomes(stdout: string, count: number): FolderAceOutcome[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== count) return null;
    return parsed.map((item: unknown): FolderAceOutcome => {
      const answer = typeof item === "object" && item !== null ? item : {};
      if ("ok" in answer && answer.ok === true) return { ok: true };
      return { ok: false, error: "error" in answer ? String(answer.error) : MESSAGE.Refused };
    });
  } catch {
    return null;
  }
}

/** The `icacls` arguments that make the same change, walking everything under the folder. */
export function icaclsArgs(edit: FolderAceEdit): string[] {
  return edit.op === FolderAceOp.Grant
    ? [edit.dir, "/grant", `*${edit.sid}:(S,RA)`]
    : [edit.dir, "/remove:g", `*${edit.sid}`];
}

/** A failed icacls call's own words: Node's message names only the command, icacls writes to stdout. */
function icaclsFailure(error: unknown): string {
  const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout).trim() : "";
  return [errorMessage(error), stdout].filter(Boolean).join(": ");
}

/** What an editor runs; each default is the real program, with `env` (default: this process's). */
export interface FolderAceTools {
  env?: NodeJS.ProcessEnv;
  /** Runs PowerShell and answers what it wrote; rejects when it fails or does not finish. */
  powershell?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** Runs `icacls`; rejects with its output when it fails. */
  icacls?: (args: string[]) => Promise<void>;
}

async function runPowerShell(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<string> {
  const running = run(file, args, { env, timeout: timeoutMs, windowsHide: true, encoding: "utf8" });
  // PowerShell may wait for its input to end before it exits; it reads none.
  running.child.stdin?.end();
  return (await running).stdout;
}

async function runIcacls(args: string[]): Promise<void> {
  await run("icacls", args, { timeout: TOOL_TIMEOUT_MS, windowsHide: true });
}

/** Each edit through `icacls`, one call each. */
async function viaIcacls(icacls: (args: string[]) => Promise<void>, edits: readonly FolderAceEdit[]) {
  const outcomes: FolderAceOutcome[] = [];
  for (const edit of edits) {
    try {
      await icacls(icaclsArgs(edit));
      outcomes.push({ ok: true });
    } catch (error) {
      outcomes.push({ ok: false, error: icaclsFailure(error) });
    }
  }
  return outcomes;
}

/** An editor that runs one PowerShell batch, and `icacls` for the batch when PowerShell cannot. */
export function folderAceEditor(tools: FolderAceTools = {}): FolderAceEditor {
  const powershellRun = tools.powershell ?? runPowerShell;
  const icacls = tools.icacls ?? runIcacls;
  return async (edits) => {
    if (edits.length === 0) return [];
    const command = folderAceCommand(edits, tools.env);
    const stdout = await powershellRun(command.file, command.args, command.env).catch(() => "");
    return folderAceOutcomes(stdout, edits.length) ?? viaIcacls(icacls, edits);
  };
}

/** One batch through PowerShell, synchronously: its outcomes, or null when it gave none. */
function batchSync(
  edits: readonly (FolderAceEdit | FolderDenyEdit)[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): FolderAceOutcome[] | null {
  const command = folderAceCommand(edits, env);
  try {
    const stdout = execFileSync(command.file, command.args, {
      env: command.env,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return folderAceOutcomes(stdout, edits.length);
  } catch {
    return null;
  }
}

/** {@link folderAceEditor} for process exit, with the real programs. */
export function folderAceEditorSync(env: NodeJS.ProcessEnv = process.env): FolderAceEditorSync {
  const options = { env, timeout: TOOL_TIMEOUT_MS, windowsHide: true, stdio: "pipe" } as const;
  return (edits) => {
    if (edits.length === 0) return [];
    const outcomes = batchSync(edits, env, TOOL_TIMEOUT_MS);
    if (outcomes) return outcomes;
    return edits.map((edit): FolderAceOutcome => {
      try {
        execFileSync("icacls", icaclsArgs(edit), options);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: icaclsFailure(error) };
      }
    });
  };
}

/**
 * An editor for deny entries: one PowerShell batch, with no `icacls` to fall back to (it would walk
 * everything under each parent folder); null where PowerShell cannot apply the batch.
 */
export function folderDenyEditor(tools: Pick<FolderAceTools, "env" | "powershell"> = {}): FolderDenyEditor {
  const powershellRun = tools.powershell ?? ((file, args, env) => runPowerShell(file, args, env, DENY_TIMEOUT_MS));
  return async (edits) => {
    if (edits.length === 0) return [];
    const command = folderAceCommand(edits, tools.env);
    const stdout = await powershellRun(command.file, command.args, command.env).catch(() => "");
    return folderAceOutcomes(stdout, edits.length);
  };
}

/** {@link folderDenyEditor} for process exit, with the real program. */
export function folderDenyEditorSync(env: NodeJS.ProcessEnv = process.env): FolderDenyEditorSync {
  return (edits) => (edits.length === 0 ? [] : batchSync(edits, env, DENY_TIMEOUT_MS));
}

/** The editor the sandbox uses. */
export const editFolderAces: FolderAceEditor = folderAceEditor();
/** The editor the sandbox uses on process exit. */
export const editFolderAcesSync: FolderAceEditorSync = folderAceEditorSync();
/** The deny editor the sandbox uses. */
export const editFolderDenies: FolderDenyEditor = folderDenyEditor();
/** The deny editor the sandbox uses on process exit. */
export const editFolderDeniesSync: FolderDenyEditorSync = folderDenyEditorSync();
