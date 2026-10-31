# Start a command as SYSTEM in an account's desktop session, for the canary's upgrade mode
# (azure-vm.ps1 starts uac-approver.ps1 so). Run Command runs as SYSTEM in session 0, which has
# no desktop: the copy of its own token given the account's session id (SeTcbPrivilege, which
# SYSTEM holds) starts a process on that session's interactive desktop. Only on a disposable VM.
param(
  [Parameter(Mandatory)] [string] $UserName,
  [Parameter(Mandatory)] [string] $CommandLine
)
$ErrorActionPreference = "Stop"
if (-not $env:CANARY_DISPOSABLE) { throw "in-session.ps1 starts SYSTEM processes on a desktop: only on a disposable canary machine" }
$shell = Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$UserName" } | Select-Object -First 1
if (-not $shell) { throw "$UserName has no desktop session" }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CanarySession {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public int x, y, width, height, countX, countY, fill, flags; public short show, reserved2;
    public IntPtr reserved3, stdIn, stdOut, stdErr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInformation { public IntPtr process, thread; public int processId, threadId; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int infoClass, ref int info, int length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string application, string commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
  // TOKEN_PRIVILEGES with one entry: the LUID is two DWORDs, so it sits at offset 4.
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct TokenPrivilege { public int count; public long luid; public int attributes; }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, int length, IntPtr previous, IntPtr returned);
  const int PrivilegeEnabled = 2;
  static void Enable(IntPtr token, string name) {
    var state = new TokenPrivilege { count = 1, attributes = PrivilegeEnabled };
    if (!LookupPrivilegeValue(null, name, out state.luid)) throw Failed("LookupPrivilegeValue " + name);
    if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw Failed("AdjustTokenPrivileges " + name);
  }
  static Exception Failed(string step) {
    return new Exception(step + ": " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
  }
  const uint TokenAllAccess = 0xF01FF;
  const int SecurityImpersonation = 2, TokenPrimary = 1, TokenSessionId = 12;
  // No window of its own: a console on the owner's desktop is not what a person's PC shows.
  const uint NoWindow = 0x08000000, BreakawayFromJob = 0x01000000;
  public static int Start(int sessionId, string commandLine) {
    IntPtr own, copy;
    if (!OpenProcessToken(GetCurrentProcess(), TokenAllAccess, out own)) throw Failed("OpenProcessToken");
    // Held by SYSTEM, not all on by default: the session id, and starting a process with a token.
    foreach (var name in new[] { "SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" }) Enable(own, name);
    if (!DuplicateTokenEx(own, TokenAllAccess, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out copy)) throw Failed("DuplicateTokenEx");
    if (!SetTokenInformation(copy, TokenSessionId, ref sessionId, 4)) throw Failed("SetTokenInformation");
    var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), desktop = "winsta0\\default" };
    ProcessInformation info;
    // Out of whatever job holds this process, where the job allows it: a job spans one session.
    if (!CreateProcessAsUser(copy, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, NoWindow | BreakawayFromJob, IntPtr.Zero, null, ref startup, out info)
      && !CreateProcessAsUser(copy, null, commandLine, IntPtr.Zero, IntPtr.Zero, false, NoWindow, IntPtr.Zero, null, ref startup, out info))
      throw Failed("CreateProcessAsUser");
    CloseHandle(info.thread); CloseHandle(info.process); CloseHandle(copy); CloseHandle(own);
    return info.processId;
  }
}
"@
$id = [CanarySession]::Start($shell.SessionId, $CommandLine)
Write-Output "started process $id as SYSTEM in $UserName's session $($shell.SessionId)"
