/**
 * The small environment Epic's programs start with when Genex runs them outside UnrealBuildTool's
 * Mac sandbox: the headless editor of a plugin's tests, RunUAT for a game's package, and on Windows
 * Build.bat for a game's C++. Only the variables named here reach them, so none of Genex's own
 * settings or credentials do.
 */
import { windowsBaseEnv } from "../../substrate/child-env.ts";
import { envValue } from "../../substrate/toolchain.ts";

const WINDOWS = "win32";
/** The variables of Genex's environment a test run keeps; nothing else of it reaches the editor. */
const KEPT_ENV = ["HOME", "PATH", "LANG", "TMPDIR", "USER"] as const;
/**
 * What Windows' RunUAT.bat and UnrealBuildTool read beyond the small environment: where programs and
 * shared data are (Visual Studio's installer, the shared derived data), the processor and the
 * account's names. None is a credential.
 */
const WINDOWS_UAT_ENV = [
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "SystemDrive",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/**
 * The small environment a test run starts with: the kept variables Genex has (`Path` read as
 * `PATH`) and, on Windows, the basics any program needs to start and find its folders.
 */
export function programEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const kept: Record<string, string> = windowsBaseEnv(env, platform);
  for (const name of KEPT_ENV) {
    const value = envValue(env, name);
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/** RunUAT's and UnrealBuildTool's environment: the small one `plugin-test` uses and, on Windows, the system's folders and names. */
export function uatEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const kept = programEnv(env, platform);
  if (platform !== WINDOWS) return kept;
  for (const name of WINDOWS_UAT_ENV) {
    const value = envValue(env, name);
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}
