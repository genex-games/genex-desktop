/**
 * The source of Genex's game host on Windows (`windows-game.ts` compiles it once with the C#
 * compiler every Windows has in .NET Framework 4): it starts one game from Play in an AppContainer
 * of the game's own, in a job that ends with the host, and answers on stdout.
 *
 * - The container: one per game (`Genex.Play.<slug>`), with no capabilities, so no network at all,
 *   loopback included. Its own folder (`%LOCALAPPDATA%\Packages\<name>\AC`) is where Windows sends
 *   the game's AppData, so its saves stay apart from every other game's.
 * - What it reads and writes: its app folder (read and run), its saves and scratch folders (change),
 *   each an ACL entry for the container's SID, inherited by what is inside. A write folder also gets
 *   a Low integrity label: an AppContainer runs at Low integrity, and Windows lets it write only
 *   below that label, whatever the ACL says. Nothing else of the person's is readable to it.
 * - The job: killed when its handle closes (the host ends however it ends), with no access to other
 *   desktops, logging off, the clipboard's contents or system settings.
 * - It answers `pid <n>` once the game runs and `window` once a top-level window of the game is on
 *   screen (which it brings forward). On stdin, `quit` asks the game's windows to close; the end of
 *   stdin, or of the Genex process that started it, ends the game.
 *
 * C# 5: the compiler in .NET Framework knows no later syntax.
 */

/** The host's C# source, as compiled. */
export const GAME_HOST_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class GenexGameHost
{
    public class Request
    {
        public string container;
        public string displayName;
        public string binary;
        public string[] args;
        public string cwd;
        public Dictionary<string, string> env;
        public string[] reads;
        public string[] writes;
        public int parent;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
        public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }

    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr caps, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr descriptor, out bool present, out IntPtr sacl, out bool defaulted);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("user32.dll")]
    static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")]
    static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    const int ALREADY_EXISTS = unchecked((int)0x800700B7);
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_SUSPENDED = 0x4;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const int JobObjectBasicProcessIdList = 3;
    const int JobObjectBasicUIRestrictions = 4;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    // Other desktops, logging off, the clipboard's contents and system settings stay out of reach.
    const uint UI_LIMITS = 0x40 | 0x80 | 0x2 | 0x8;
    const uint SYNCHRONIZE = 0x00100000;
    const uint WAIT_OBJECT_0 = 0;
    const uint GW_OWNER = 4;
    const uint WM_CLOSE = 0x10;
    const int WINDOW_POLL_MS = 250;
    const int JOB_PIDS_MAX = 512;
    // A Low integrity label passed down to everything inside a write folder.
    const string LOW_LABEL = "S:(ML;OICI;NW;;;LW)";
    const int SE_FILE_OBJECT = 1;
    const uint LABEL_SECURITY_INFORMATION = 0x10;
    const int FAILED = 120;

    static IntPtr job;
    static volatile bool inputEnded;

    static int Main(string[] argv)
    {
        try
        {
            return Run(new JavaScriptSerializer().Deserialize<Request>(File.ReadAllText(argv[0], Encoding.UTF8)));
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("genex-game-host: " + error.Message);
            return FAILED;
        }
    }

    static IntPtr ContainerSid(Request request)
    {
        IntPtr sid;
        int result = CreateAppContainerProfile(request.container, request.displayName, request.displayName, IntPtr.Zero, 0, out sid);
        if (result == ALREADY_EXISTS) result = DeriveAppContainerSidFromAppContainerName(request.container, out sid);
        if (result != 0) throw new Exception("AppContainer profile: 0x" + result.ToString("X8"));
        return sid;
    }

    static void Grant(string folder, SecurityIdentifier sid, FileSystemRights rights)
    {
        DirectoryInfo dir = new DirectoryInfo(folder);
        DirectorySecurity security = dir.GetAccessControl(AccessControlSections.Access);
        InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
        {
            bool same = rule.IdentityReference.Equals(sid) && rule.AccessControlType == AccessControlType.Allow;
            if (same && (rule.FileSystemRights & rights) == rights && rule.InheritanceFlags == inherit) return;
        }
        security.AddAccessRule(new FileSystemAccessRule(sid, rights, inherit, PropagationFlags.None, AccessControlType.Allow));
        dir.SetAccessControl(security);
    }

    static void LabelLow(string folder)
    {
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(LOW_LABEL, 1, out descriptor, IntPtr.Zero))
            throw new Exception("label: " + Marshal.GetLastWin32Error());
        bool present, defaulted;
        IntPtr sacl;
        GetSecurityDescriptorSacl(descriptor, out present, out sacl, out defaulted);
        uint result = SetNamedSecurityInfoW(folder, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        if (result != 0) throw new Exception("label " + folder + ": " + result);
    }

    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return arg;
        StringBuilder quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            slashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }

    static IntPtr EnvironmentBlock(Dictionary<string, string> env)
    {
        List<string> keys = new List<string>(env.Keys);
        keys.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder();
        foreach (string key in keys) block.Append(key).Append('=').Append(env[key]).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    static void SetJobInfo(int infoClass, object value)
    {
        int size = Marshal.SizeOf(value);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        Marshal.StructureToPtr(value, buffer, false);
        if (!SetInformationJobObject(job, infoClass, buffer, (uint)size)) throw new Exception("job: " + Marshal.GetLastWin32Error());
    }

    static void MakeJob()
    {
        job = CreateJobObjectW(IntPtr.Zero, null);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetJobInfo(JobObjectExtendedLimitInformation, limits);
        IntPtr ui = Marshal.AllocHGlobal(4);
        Marshal.WriteInt32(ui, (int)UI_LIMITS);
        if (!SetInformationJobObject(job, JobObjectBasicUIRestrictions, ui, 4)) throw new Exception("job UI: " + Marshal.GetLastWin32Error());
    }

    static PROCESS_INFORMATION Start(Request request, IntPtr sid)
    {
        SECURITY_CAPABILITIES capabilities = new SECURITY_CAPABILITIES();
        capabilities.AppContainerSid = sid;
        IntPtr caps = Marshal.AllocHGlobal(Marshal.SizeOf(capabilities));
        Marshal.StructureToPtr(capabilities, caps, false);
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Exception("attributes: " + Marshal.GetLastWin32Error());
        if (!UpdateProcThreadAttribute(list, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, caps,
            (IntPtr)Marshal.SizeOf(capabilities), IntPtr.Zero, IntPtr.Zero))
            throw new Exception("container: " + Marshal.GetLastWin32Error());
        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(startup);
        startup.lpAttributeList = list;
        StringBuilder command = new StringBuilder(Quote(request.binary));
        foreach (string arg in request.args ?? new string[0]) command.Append(' ').Append(Quote(arg));
        PROCESS_INFORMATION info;
        uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        if (!CreateProcessW(request.binary, command, IntPtr.Zero, IntPtr.Zero, false, flags, EnvironmentBlock(request.env),
            request.cwd, ref startup, out info))
            throw new Exception("start: " + Marshal.GetLastWin32Error());
        return info;
    }

    static HashSet<int> JobPids()
    {
        int size = 8 + IntPtr.Size * JOB_PIDS_MAX;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        HashSet<int> pids = new HashSet<int>();
        if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, IntPtr.Zero))
        {
            int count = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < count; i++) pids.Add((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
        }
        Marshal.FreeHGlobal(buffer);
        return pids;
    }

    // The game's visible top-level windows: the ones a person sees and closes.
    static List<IntPtr> GameWindows()
    {
        HashSet<int> pids = JobPids();
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate (IntPtr hwnd, IntPtr lParam)
        {
            int pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pids.Contains(pid) && IsWindowVisible(hwnd) && GetWindow(hwnd, GW_OWNER) == IntPtr.Zero) found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static void Say(string line)
    {
        lock (typeof(GenexGameHost))
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    // Genex's requests on stdin, one per line; the end of stdin means Genex is gone.
    static void ReadInput()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Trim() != "quit") continue;
            foreach (IntPtr window in GameWindows()) PostMessageW(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
        inputEnded = true;
    }

    static int Run(Request request)
    {
        IntPtr sid = ContainerSid(request);
        SecurityIdentifier container = new SecurityIdentifier(sid);
        foreach (string folder in request.reads ?? new string[0]) Grant(folder, container, FileSystemRights.ReadAndExecute);
        foreach (string folder in request.writes ?? new string[0])
        {
            Grant(folder, container, FileSystemRights.Modify);
            LabelLow(folder);
        }
        MakeJob();
        PROCESS_INFORMATION game = Start(request, sid);
        if (!AssignProcessToJobObject(job, game.hProcess))
        {
            TerminateJobObject(job, FAILED);
            throw new Exception("job: " + Marshal.GetLastWin32Error());
        }
        AllowSetForegroundWindow(game.dwProcessId);
        ResumeThread(game.hThread);
        Say("pid " + game.dwProcessId);
        Thread input = new Thread(ReadInput);
        input.IsBackground = true;
        input.Start();
        IntPtr parent = request.parent > 0 ? OpenProcess(SYNCHRONIZE, false, request.parent) : IntPtr.Zero;
        IntPtr[] waits = parent != IntPtr.Zero ? new IntPtr[] { game.hProcess, parent } : new IntPtr[] { game.hProcess };
        bool shown = false;
        while (true)
        {
            uint woke = WaitForMultipleObjects((uint)waits.Length, waits, false, (uint)WINDOW_POLL_MS);
            if (woke == WAIT_OBJECT_0) break;
            if (woke == WAIT_OBJECT_0 + 1 || inputEnded)
            {
                TerminateJobObject(job, 1);
                return 1;
            }
            if (shown) continue;
            List<IntPtr> windows = GameWindows();
            if (windows.Count == 0) continue;
            shown = true;
            SetForegroundWindow(windows[0]);
            Say("window");
        }
        uint code;
        GetExitCodeProcess(game.hProcess, out code);
        TerminateJobObject(job, code);
        return (int)code;
    }
}
`;
