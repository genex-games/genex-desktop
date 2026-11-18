/**
 * The sandbox user's right to sign in on this PC ("Allow log on locally", SeInteractiveLogonRight).
 * srt-win starts every sandboxed command as `srt-sandbox` through CreateProcessWithLogonW, an
 * interactive logon. The account has that right as a member of Users; where a policy or a security
 * program took it from Users, or put the account under "Deny log on locally", Windows refuses each
 * start with ERROR_LOGON_TYPE_NOT_GRANTED (0x80070569), which srt-win's own words blame on the
 * Secondary Logon service.
 *
 * Nothing says so before a start is refused: reading account rights needs an administrator. Set up
 * then gives the account the right itself and takes its own deny entry off, behind Windows'
 * approval prompt (`windows-elevated.ts`), through the LSA calls, which add and remove one
 * account's entry and leave every other account's rights as they were. A deny that reaches the
 * account through a group, or a domain policy that writes the rights again, is not Genex's to
 * lift: the next refusal says so in plain words (`SandboxLaunchCode.LogonRightRefused`).
 */
import { ELEVATION_CANCELLED_EXIT, type ElevatedAnswer, encodedPowerShell, runElevated } from "./windows-elevated.ts";

/** The sandbox user's account name, as srt-win makes it. */
export const SANDBOX_ACCOUNT = "srt-sandbox";

/** Windows' HRESULT for ERROR_LOGON_TYPE_NOT_GRANTED, as srt-win prints it. */
export const LOGON_TYPE_NOT_GRANTED_HRESULT = 0x80070569;

/** The right an interactive logon needs, and the one that refuses it whatever else is granted. */
const ALLOW_RIGHT = "SeInteractiveLogonRight";
const DENY_RIGHT = "SeDenyInteractiveLogonRight";

/** POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES: what adding an account's right needs. */
const POLICY_ACCESS = 0x810;
/** STATUS_OBJECT_NAME_NOT_FOUND: the account held no such right to remove. */
const STATUS_NOT_HELD = 0xc0000034;

/** The elevated step's exit statuses, beside 0 and {@link ELEVATION_CANCELLED_EXIT}. */
const AllowExit = {
  NoAccount: 20,
  PolicyRefused: 21,
  GrantRefused: 22,
  DenyKept: 23,
  NoHelper: 24,
} as const;

/**
 * Gives `account` the right `allow` and takes its own entry off `deny`, answering one of
 * {@link AllowExit} or 0. Both calls change that account's entry only.
 */
const HELPER = `
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class GenexLogonRight {
  [StructLayout(LayoutKind.Sequential)]
  struct LsaString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct LsaObjectAttributes { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")]
  static extern uint LsaOpenPolicy(IntPtr system, ref LsaObjectAttributes attributes, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")]
  static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")]
  static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, [MarshalAs(UnmanagedType.U1)] bool all, LsaString[] rights, uint count);
  [DllImport("advapi32.dll")]
  static extern uint LsaClose(IntPtr policy);
  static LsaString[] Right(string name) {
    LsaString right = new LsaString();
    right.Buffer = Marshal.StringToHGlobalUni(name);
    right.Length = (ushort)(name.Length * 2);
    right.MaximumLength = (ushort)(name.Length * 2 + 2);
    return new LsaString[] { right };
  }
  public static int Allow(string account, string allow, string deny) {
    byte[] sid;
    try {
      SecurityIdentifier id = (SecurityIdentifier)new NTAccount(account).Translate(typeof(SecurityIdentifier));
      sid = new byte[id.BinaryLength];
      id.GetBinaryForm(sid, 0);
    } catch (IdentityNotMappedException) {
      return ${AllowExit.NoAccount};
    }
    LsaObjectAttributes attributes = new LsaObjectAttributes();
    attributes.Length = Marshal.SizeOf(typeof(LsaObjectAttributes));
    IntPtr policy;
    if (LsaOpenPolicy(IntPtr.Zero, ref attributes, ${POLICY_ACCESS}, out policy) != 0) return ${AllowExit.PolicyRefused};
    try {
      if (LsaAddAccountRights(policy, sid, Right(allow), 1) != 0) return ${AllowExit.GrantRefused};
      uint removed = LsaRemoveAccountRights(policy, sid, false, Right(deny), 1);
      return removed == 0 || removed == ${STATUS_NOT_HELD} ? 0 : ${AllowExit.DenyKept};
    } finally {
      LsaClose(policy);
    }
  }
}
`;

/** The elevated PowerShell's whole script: load the helper, run it, exit with its answer. */
const ALLOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
${HELPER.trim()}
'@
} catch {
  exit ${AllowExit.NoHelper}
}
exit [GenexLogonRight]::Allow('${SANDBOX_ACCOUNT}', '${ALLOW_RIGHT}', '${DENY_RIGHT}')
`;

const WHY: Record<number, string> = {
  [AllowExit.NoAccount]: "Windows has no such account",
  [AllowExit.PolicyRefused]: "Windows refused to open its security policy",
  [AllowExit.GrantRefused]: `Windows refused to give it ${ALLOW_RIGHT}`,
  [AllowExit.DenyKept]: `Windows refused to take it off ${DENY_RIGHT}`,
  [AllowExit.NoHelper]: "Windows PowerShell could not load Genex's helper (an antivirus or a policy may block it)",
};

const MESSAGE = {
  NotAllowed: (status: number, stderr: string) =>
    [`could not let the sandbox user (${SANDBOX_ACCOUNT}) sign in on this PC: exit ${status}`, WHY[status], stderr]
      .filter(Boolean)
      .join(": "),
} as const;

/** Whether this run of Genex already gave the sandbox user the right: a refusal after that is a policy's. */
let allowed = false;

/** Whether Set up gave the sandbox user its sign-in right since Genex started. */
export const sandboxLogonAllowed = (): boolean => allowed;

/** The elevated step: Windows PowerShell as an administrator, running {@link ALLOW_SCRIPT}. */
const runElevatedAllow = (): Promise<ElevatedAnswer> =>
  runElevated(
    "WindowsPowerShell\\v1.0\\powershell.exe",
    `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${encodedPowerShell(ALLOW_SCRIPT)}`,
  );

/**
 * Let the sandbox user sign in on this PC, behind one approval prompt: `cancelled` when the prompt
 * was dismissed; throws, with the step's exit status and what it stands for, when Windows would not.
 */
export async function allowSandboxLogon(
  elevate: () => Promise<ElevatedAnswer> = runElevatedAllow,
): Promise<{ cancelled: boolean }> {
  const { status, stderr } = await elevate();
  if (status === ELEVATION_CANCELLED_EXIT) return { cancelled: true };
  if (status !== 0) throw new Error(MESSAGE.NotAllowed(status, stderr));
  allowed = true;
  return { cancelled: false };
}
