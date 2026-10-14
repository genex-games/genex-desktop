/**
 * Ubuntu's user-namespace restriction, and the one AppArmor profile that lifts it for Genex.
 *
 * Ubuntu 23.10 and later (`kernel.apparmor_restrict_unprivileged_userns=1`, the default on 24.04)
 * let an unconfined program create a user namespace but take every capability away inside it.
 * Chromium's namespace sandbox and bubblewrap, Genex's process sandbox, need those capabilities.
 * Ubuntu's fix for an application is a profile in `unconfined` mode that names its executable and
 * allows `userns`, as it ships for VS Code and Chrome; the system-wide switch stays on. A profile in
 * unconfined mode keeps its label across exec when the new program has no profile of its own
 * (`profile_transition` in the kernel's security/apparmor/domain.c), so the shell, bubblewrap and
 * apply-seccomp that Genex starts keep the permission too.
 *
 * That inheritance is the trade-off: with the profile loaded, every program Genex runs, including
 * the agents' sandboxed commands, may create user namespaces that hold capabilities, as on a
 * distribution without the restriction; and so may anything run as Genex's binary (its RunAsNode
 * fuse is on). apply-seccomp needs that permission for its own nested namespace, so a narrower
 * child profile is follow-up work. For a copy outside the package the profile names a path its
 * owner can write to; `writableByOthers` refuses a path anyone else could replace.
 *
 * The profile is written here only: the deb and rpm maintainer scripts install it for the packaged
 * path (forge.config.cjs loads this module), and the setup screen installs it for any other copy
 * (`linux-userns-setup.ts`, one pkexec prompt) or shows the same install as a command to run. A
 * zip copy never reaches the setup screen (Chromium's own sandbox stops Electron first), so the
 * Linux zip carries the same install in `README-LINUX.txt` ({@link portableReadme}).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { APPARMOR_PATTERN_CHARACTERS } from "../shared/boot.ts";
import { shellQuote } from "./shell-quote.ts";

/** Where the deb and rpm install Genex's executable: electron-installer's `usr/lib/<name>/<bin>`. */
export const LINUX_PACKAGED_EXECUTABLE = "/usr/lib/genex/genex";

/** Ubuntu's switch: `1` while unconfined programs get no capabilities in a new user namespace. */
export const USERNS_RESTRICTION_FILE = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** This process's AppArmor label: AppArmor's own file (kernels that stack LSMs), then the classic one. */
export const APPARMOR_LABEL_FILES = ["/proc/self/attr/apparmor/current", "/proc/self/attr/current"] as const;

/** The label of a process no profile confines. */
const UNCONFINED_LABEL = "unconfined";
/**
 * The profile Ubuntu moves an unconfined process to once it creates a user namespace: a program
 * started under it (a toolbox or rootless-container shell) is restricted just the same.
 */
const UNPRIVILEGED_USERNS_PROFILE = "unprivileged_userns";
/** How a label joins the profiles of a stack (`a//&b`). */
const STACK_SEPARATOR = "//&";
/** A label's mode suffix, such as ` (enforce)` or ` (unconfined)`. */
const LABEL_MODE = / \([^)]*\)$/;

/** The profile names Genex installs: one for the packaged executable, one for any other copy. */
export const AppArmorProfileName = {
  Packaged: "genex",
  Portable: "genex-portable",
} as const;
export type AppArmorProfileName = (typeof AppArmorProfileName)[keyof typeof AppArmorProfileName];

/** Why a path cannot be named in a profile. */
export const ProfilePathRefusal = {
  NotAbsolute: "not-absolute",
  /** An empty, `.` or `..` segment, or a trailing slash: the kernel matches the resolved path. */
  NotNormalized: "not-normalized",
  /** A character AppArmor reads as a pattern, a variable or an escape. */
  Pattern: "pattern-character",
  Control: "control-character",
} as const;
export type ProfilePathRefusal = (typeof ProfilePathRefusal)[keyof typeof ProfilePathRefusal];

/** Where AppArmor keeps and reports its state; tests point it at a temporary folder. */
export interface AppArmorSystem {
  /** Profiles loaded at boot. */
  profileDir: string;
  /** Present where the parser knows AppArmor 4's `userns` rule and `unconfined` flag. */
  abiFile: string;
  /** `Y` while AppArmor is enabled in the running kernel. */
  enabledFile: string;
}

/** Ubuntu's (and Debian's) AppArmor locations. */
export const APPARMOR_SYSTEM: AppArmorSystem = {
  profileDir: "/etc/apparmor.d",
  abiFile: "/etc/apparmor.d/abi/4.0",
  enabledFile: "/sys/module/apparmor/parameters/enabled",
};

/** One profile: its name, the executable it attaches to, its file and its text. */
export interface AppArmorProfile {
  name: AppArmorProfileName;
  executable: string;
  file: string;
  text: string;
}

/** What `sh -c` shows as `$0` when it runs the install, in `ps` and polkit's details. */
const INSTALL_ARGV0 = "genex-apparmor";

/**
 * How Set up's root script fails, in exit codes pkexec never uses itself (it answers 126 for a
 * dismissed prompt and 127 when it cannot authenticate), so 126 always means nothing ran.
 */
export const InstallExit = {
  /** The profile file could not be written. */
  NotWritten: 3,
  /** AppArmor refused the profile; the script took the file out again. */
  NotLoaded: 4,
} as const;
export type InstallExit = (typeof InstallExit)[keyof typeof InstallExit];

/**
 * What Set up runs as root: `sh -c` this with the profile's file as `$1` and its text as `$2`. It
 * writes the file and loads it; a profile AppArmor refuses is deleted again, since the boot-time
 * load of /etc/apparmor.d would fail on it. The values arrive as arguments, never read as shell.
 */
const INSTALL_SCRIPT = [
  "umask 022",
  `printf "%s\\n" "$2" > "$1" || exit ${InstallExit.NotWritten}`,
  `apparmor_parser -r "$1" || { rm -f "$1"; exit ${InstallExit.NotLoaded}; }`,
].join("; ");

/** The maintainer scripts' heredoc delimiter: no line of a profile can equal it. */
const HEREDOC = "GENEX_APPARMOR_PROFILE";

/**
 * The characters of a path AppArmor matches as written: ASCII letters, digits and `._/+-`.
 * Anything else is quoted. Spelled out rather than as ranges, so that the README command's `tr`
 * set built from the same list means the same in every locale.
 */
const PLAIN_PATH_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/+-";
const PLAIN_PATH = new RegExp(`^[${PLAIN_PATH_CHARACTERS.replaceAll("-", "\\-")}]+$`);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** The deb and rpm maintainer scripts Genex ships, by the key each package maker reads. */
export const LinuxPackageScript = {
  DebPostinst: "postinst",
  DebPostrm: "postrm",
  RpmPost: "post",
  RpmPostun: "postun",
} as const;
export type LinuxPackageScript = (typeof LinuxPackageScript)[keyof typeof LinuxPackageScript];

/** Why `executable` cannot be named in a profile, or null when it can. */
export function profilePathRefusal(executable: string): ProfilePathRefusal | null {
  if (CONTROL_CHARACTER.test(executable)) return ProfilePathRefusal.Control;
  if (!executable.startsWith("/")) return ProfilePathRefusal.NotAbsolute;
  if (APPARMOR_PATTERN_CHARACTERS.some((character) => executable.includes(character)))
    return ProfilePathRefusal.Pattern;
  const segments = executable.slice(1).split("/");
  const abnormal = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  return abnormal ? ProfilePathRefusal.NotNormalized : null;
}

/** The profile text: Ubuntu's shape for an unconfined application that needs user namespaces. */
function profileText(name: AppArmorProfileName, executable: string): string {
  const attachment = PLAIN_PATH.test(executable) ? executable : `"${executable}"`;
  return [
    "# Genex: lets Genex and the programs it starts create user namespaces under the Ubuntu",
    "# AppArmor restriction, as Chromium and bubblewrap sandboxes need. It confines nothing.",
    "abi <abi/4.0>,",
    "include <tunables/global>",
    "",
    `profile ${name} ${attachment} flags=(unconfined) {`,
    "  userns,",
    "",
    "  # Site-specific additions and overrides. See local/README for details.",
    `  include if exists <local/${name}>`,
    "}",
  ].join("\n");
}

/** Genex's profile for `executable` (a resolved path), or null when a profile cannot name it. */
export function appArmorProfile(
  executable: string,
  profileDir: string = APPARMOR_SYSTEM.profileDir,
): AppArmorProfile | null {
  if (profilePathRefusal(executable)) return null;
  const name = executable === LINUX_PACKAGED_EXECUTABLE ? AppArmorProfileName.Packaged : AppArmorProfileName.Portable;
  return { name, executable, file: path.posix.join(profileDir, name), text: profileText(name, executable) };
}

/** What a restriction check reads: a file's text, or null when it cannot be read. */
export type ReadSystemFile = (file: string) => string | null;

/** A label file's text as a label: without the trailing newline or NUL the kernel may add. */
function labelOf(text: string | null): string | null {
  return text === null ? null : text.replaceAll("\u0000", "").trim();
}

/** Is `label` one the restriction applies to: unconfined, or (in a stack) Ubuntu's `unprivileged_userns`? */
function restrictedLabel(label: string): boolean {
  if (label === UNCONFINED_LABEL) return true;
  const profiles = label.replace(LABEL_MODE, "").split(STACK_SEPARATOR);
  return profiles.includes(UNPRIVILEGED_USERNS_PROFILE);
}

/**
 * Does Ubuntu's restriction leave this process without capabilities in a new user namespace? While
 * the switch reads 1 and the process is unconfined, or runs under Ubuntu's `unprivileged_userns`
 * profile. Under any other profile the answer is no: Genex's own, or another that started it (VS
 * Code's terminal allows `userns` too); one that does not is not one Genex can see into, and
 * bubblewrap's own error says so.
 */
export function usernsRestricted(read: ReadSystemFile): boolean {
  if (read(USERNS_RESTRICTION_FILE)?.trim() !== "1") return false;
  const [apparmorLabel, classicLabel] = APPARMOR_LABEL_FILES;
  const label = labelOf(read(apparmorLabel)) ?? labelOf(read(classicLabel));
  return label !== null && restrictedLabel(label);
}

/** A path's owner, group and permission bits, as `stat` reports them. */
export interface PathOwner {
  uid: number;
  gid: number;
  mode: number;
}

/** Reads a path's owner and mode (following links), or null when it cannot. */
export type InspectPath = (file: string) => PathOwner | null;

/** The person running Genex: their user id and primary group id. */
export interface Person {
  uid: number;
  gid: number;
}

const ROOT_UID = 0;
const WORLD_WRITABLE = 0o002;
const GROUP_WRITABLE = 0o020;

/**
 * Could someone other than root and `person` replace what is at a path? Yes when it cannot be
 * read, belongs to another user, is writable by everyone (a sticky `/tmp` included: once a folder
 * there is gone, anyone may make it again), or by a group other than the person's own primary
 * group (Ubuntu gives each person a group of their own, and its umask makes folders writable by it).
 * ACLs are not read.
 */
function replaceableByOthers(owner: PathOwner | null, person: Person): boolean {
  if (!owner) return true;
  if (owner.uid !== ROOT_UID && owner.uid !== person.uid) return true;
  if (owner.mode & WORLD_WRITABLE) return true;
  return (owner.mode & GROUP_WRITABLE) !== 0 && owner.gid !== person.gid;
}

/**
 * The first of `/`, each folder down to `executable`, and `executable` itself that someone other
 * than root and `person` could replace, or null when there is none. A profile must not name such a
 * path: whoever can put a program there later gets the profile's exemption.
 */
export function writableByOthers(executable: string, inspect: InspectPath, person: Person): string | null {
  const segments = executable.split("/").filter(Boolean);
  const paths = ["/", ...segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`)];
  return paths.find((candidate) => replaceableByOthers(inspect(candidate), person)) ?? null;
}

/** The root install as argv: `sh -c` the fixed script with the profile's file and text. */
export function profileInstallArgv(profile: AppArmorProfile): string[] {
  return ["/bin/sh", "-c", INSTALL_SCRIPT, INSTALL_ARGV0, profile.file, profile.text];
}

/** Set up's argv: the install behind polkit's administrator prompt, `pkexec` by its absolute path. */
export function pkexecArgv(profile: AppArmorProfile, pkexec: string): string[] {
  return [pkexec, ...profileInstallArgv(profile)];
}

/** The same install as one terminal command, for the person to run with sudo. */
export function profileInstallCommand(profile: AppArmorProfile): string {
  // The shell, its flag and `$0` are plain words; the script, the file and the text are quoted.
  const [shell, flag, script, argv0, file, text] = profileInstallArgv(profile);
  return ["sudo", shell, flag, shellQuote(script), argv0, shellQuote(file), shellQuote(text)].join(" ");
}

/** The terminal command that unloads and deletes `profile` (sudo twice; rm runs even when it was not loaded). */
export function profileRemoveCommand(profile: AppArmorProfile): string {
  const file = shellQuote(profile.file);
  return `sudo apparmor_parser -R ${file}; sudo rm -f ${file}`;
}

/**
 * What Chromium's zygote host prints (a FATAL line) when a copy has no usable sandbox under the
 * restriction: first when a `chrome-sandbox` sits beside the executable but is not setuid root (an
 * unzipped copy: Electron ships one, unzip cannot make it root's), then when there is none. These
 * are Chromium's words, the only sign it gives: the Linux CI's unprofiled check and README-LINUX.txt
 * quote them.
 */
export const CHROMIUM_SANDBOX_FATALS = [
  "The SUID sandbox helper binary was found, but is not configured correctly",
  "No usable sandbox",
] as const;

/** The unzipped copy's executable, beside README-LINUX.txt: the packaged executable's name. */
const PORTABLE_EXECUTABLE = path.posix.basename(LINUX_PACKAGED_EXECUTABLE);
/** A plain path standing in for the unzipped copy while the profile text is split around it. */
const UNZIPPED_STAND_IN = `/genex-unzipped-folder/${PORTABLE_EXECUTABLE}`;
/** The rule around the lines README-LINUX.txt asks the person to paste. */
const README_RULE = "-".repeat(78);

/** README-LINUX.txt's words, and what its command prints when it installs nothing. */
const PORTABLE_README = {
  notHere: `Run this in the unzipped folder, the one that holds ${PORTABLE_EXECUTABLE}.`,
  unnamable: `An AppArmor profile cannot name this folder. Move Genex to a folder whose path has no control character and none of ${APPARMOR_PATTERN_CHARACTERS.join(" ")}.`,
  /** Set up's words for a shared folder, around the path the command found. */
  shared: [
    "Someone other than root and you can change ",
    ", so Genex's AppArmor profile must not name a program under it. Move Genex to a folder only you can write to, such as ~/Genex.",
  ],
  intro: [
    "Genex for Linux: the zip",
    "",
    "Install bubblewrap, socat and ripgrep with your package manager; C++ setup also needs",
    "xz-utils (Debian/Ubuntu) or xz (Fedora). The deb and rpm install these dependencies.",
    "",
    "On Ubuntu 23.10 and later (24.04 included), this copy of Genex cannot start until an",
    "AppArmor profile names it: Electron stops at once, and Chromium prints one of",
    "",
    ...CHROMIUM_SANDBOX_FATALS.map((fatal) => `  ${fatal}`),
    "",
    "Making chrome-sandbox setuid root, as the first asks, would not be enough: Genex's own",
    "sandbox needs the profile too. The deb and rpm packages load their own profile. This copy",
    "needs the one-time command below, the same install Genex's setup screen runs.",
    "",
    "1. Keep this folder where only you can write, such as ~/Genex (not /tmp): the profile",
    "   names this folder, so the command refuses one anyone else could change.",
    `2. Open a terminal in this folder (the one that holds ${PORTABLE_EXECUTABLE}) and paste every line`,
    "   between the two rules. sudo asks for your password.",
    `3. Start Genex: ./${PORTABLE_EXECUTABLE}`,
  ],
  outro: [
    "The profile lets Genex, every program it starts (the agents' sandboxed commands included)",
    "and anything run as its binary create user namespaces, as on a distribution without the",
    "restriction and as Ubuntu's own profile for VS Code does. It names one portable copy at a",
    "time: running the command for another copy, or after moving this one, points it there.",
    "",
    "To remove it:",
  ],
} as const;

/** A shell bracket expression matching any one of `characters`: `]` first, `"` and `\` escaped. */
function shellBracket(characters: readonly string[]): string {
  const ordered = [...characters].sort((a, b) => Number(b === "]") - Number(a === "]"));
  return `[${ordered.map((character) => (character === '"' || character === "\\" ? `\\${character}` : character)).join("")}]`;
}

/**
 * `find` printing the path in `$p` only when no one but root and the person could replace it: the
 * shell spelling of {@link replaceableByOthers}. `-H` follows a link as Set up's `stat` does; a path
 * it cannot read prints nothing, so it counts as shared, as in Set up.
 */
const PERSON_ONLY_FIND =
  'find -H "$p" -prune \\( -user 0 -o -user "$(id -u)" \\) ! -perm -0002 \\( ! -perm -0020 -o -group "$(id -g)" \\) -print 2>/dev/null';

/**
 * The lines README-LINUX.txt gives. Run in the unzipped folder, they install the profile Set up
 * would for `<that folder>/genex`: the same script, file and text as {@link profileInstallCommand},
 * with the folder's physical path in the text, quoted exactly when the profile quotes it. Like Set
 * up, they install nothing for a folder without the executable, one a profile cannot name
 * ({@link profilePathRefusal}), or one under a folder someone other than root and the person could
 * change ({@link writableByOthers}, walked here from the executable up to `/`).
 */
export function portableInstallScript(profileDir: string = APPARMOR_SYSTEM.profileDir): string {
  const profile = appArmorProfile(UNZIPPED_STAND_IN, profileDir);
  if (!profile) throw new Error(`the stand-in path cannot be named in a profile: ${UNZIPPED_STAND_IN}`);
  const [shell, flag, script, argv0, file, text] = profileInstallArgv(profile);
  const [before = "", after = ""] = text.split(UNZIPPED_STAND_IN);
  const install = ["sudo", shell, flag, shellQuote(script), argv0, shellQuote(file)].join(" ");
  const [sharedBefore = "", sharedAfter = ""] = PORTABLE_README.shared;
  // No `[!…]` pattern: pasted into an interactive shell, `!` could start a history expansion (a `!`
  // followed by a space, as here, never does).
  return [
    `exe="$(pwd -P)/${PORTABLE_EXECUTABLE}"`,
    'if [ ! -f "$exe" ] || [ ! -x "$exe" ]; then',
    `  echo ${shellQuote(PORTABLE_README.notHere)} >&2`,
    "else",
    '  case "$exe" in',
    `    *[[:cntrl:]]* | *${shellBracket(APPARMOR_PATTERN_CHARACTERS)}* | //*) echo ${shellQuote(PORTABLE_README.unnamable)} >&2 ;;`,
    "    *)",
    '      p="$exe"; shared=""',
    // Up to `/`, each shared path replacing the last: the highest is named, as Set up names it.
    "      while :; do",
    `        [ -n "$(${PERSON_ONLY_FIND})" ] || shared="$p"`,
    '        [ "$p" = / ] && break',
    '        p="$(dirname "$p")"',
    "      done",
    '      if [ -n "$shared" ]; then',
    `        echo ${shellQuote(sharedBefore)}"$shared"${shellQuote(sharedAfter)} >&2`,
    "      else",
    '        attach="$exe"',
    `        [ -n "$(printf '%s' "$exe" | LC_ALL=C tr -d ${shellQuote(PLAIN_PATH_CHARACTERS)})" ] && attach="\\"$exe\\""`,
    `        ${install} ${shellQuote(before)}"$attach"${shellQuote(after)}`,
    "      fi ;;",
    "  esac",
    "fi",
  ].join("\n");
}

/** README-LINUX.txt, which the Linux zip carries beside `genex` (forge.config.cjs adds it at make). */
export function portableReadme(profileDir: string = APPARMOR_SYSTEM.profileDir): string {
  const profile = appArmorProfile(UNZIPPED_STAND_IN, profileDir);
  if (!profile) throw new Error(`the stand-in path cannot be named in a profile: ${UNZIPPED_STAND_IN}`);
  return [
    ...PORTABLE_README.intro,
    "",
    README_RULE,
    portableInstallScript(profileDir),
    README_RULE,
    "",
    ...PORTABLE_README.outro,
    "",
    profileRemoveCommand(profile),
    "",
  ].join("\n");
}

/**
 * The maintainer-script lines that install and load `profile` where AppArmor 4 is present. A
 * profile AppArmor refuses (or, while AppArmor is off, cannot parse) is deleted again: left in
 * /etc/apparmor.d it would fail the AppArmor service at the next boot.
 */
function installLines(profile: AppArmorProfile, system: AppArmorSystem): string[] {
  const file = shellQuote(profile.file);
  const refused = shellQuote(
    `genex: AppArmor refused ${profile.file}, so it was removed; Genex offers the install again when it starts`,
  );
  return [
    `if command -v apparmor_parser >/dev/null 2>&1 && [ -e ${shellQuote(system.abiFile)} ]; then`,
    `  cat > ${file} <<'${HEREDOC}'`,
    profile.text,
    HEREDOC,
    `  if [ "$(cat ${shellQuote(system.enabledFile)} 2>/dev/null)" = Y ]; then`,
    `    apparmor_parser -r ${file} || { rm -f ${file}; echo ${refused} >&2; }`,
    "  else",
    // -Q parses without loading, -K without touching the cache.
    `    apparmor_parser -QK ${file} || { rm -f ${file}; echo ${refused} >&2; }`,
    "  fi",
    "fi",
  ];
}

/** The maintainer-script lines that unload and delete `profile`, if it is there. */
function removeLines(profile: AppArmorProfile, system: AppArmorSystem): string[] {
  const file = shellQuote(profile.file);
  return [
    `if [ -e ${file} ]; then`,
    `  if command -v apparmor_parser >/dev/null 2>&1 && [ "$(cat ${shellQuote(system.enabledFile)} 2>/dev/null)" = Y ]; then`,
    `    apparmor_parser -R ${file} 2>/dev/null || true`,
    "  fi",
    `  rm -f ${file}`,
    "fi",
  ];
}

/**
 * A maintainer script: `body` when `when` holds. No `set -e`: a profile that cannot be written or
 * loaded must not fail the package install; the app finds the restriction itself and offers the fix.
 */
function script(when: string, body: string[]): string {
  return [
    "#!/bin/sh",
    "# Genex's AppArmor profile: lets Genex's sandbox work under Ubuntu's user-namespace restriction",
    "# without changing any system-wide setting.",
    // The body keeps its own indentation: a heredoc's lines are written to the profile as they are.
    `if ${when}; then`,
    ...body,
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** The deb and rpm maintainer scripts, by maker key: install on install and upgrade, remove on removal. */
export function linuxPackageScripts(system: AppArmorSystem = APPARMOR_SYSTEM): Record<LinuxPackageScript, string> {
  const profile = appArmorProfile(LINUX_PACKAGED_EXECUTABLE, system.profileDir);
  if (!profile) throw new Error(`the packaged executable cannot be named in a profile: ${LINUX_PACKAGED_EXECUTABLE}`);
  return {
    // dpkg: `configure` after an install or upgrade; `remove` and `purge`, not `upgrade`, remove.
    [LinuxPackageScript.DebPostinst]: script('[ "$1" = configure ]', installLines(profile, system)),
    [LinuxPackageScript.DebPostrm]: script('[ "$1" = remove ] || [ "$1" = purge ]', removeLines(profile, system)),
    // rpm: %post on every install and upgrade; %postun with 0 packages left is the removal.
    [LinuxPackageScript.RpmPost]: script("true", installLines(profile, system)),
    [LinuxPackageScript.RpmPostun]: script('[ "$1" = 0 ]', removeLines(profile, system)),
  };
}

/** Where the package makers read each maintainer script, under `dir`. */
export function linuxPackageScriptFiles(dir: string): Record<LinuxPackageScript, string> {
  return {
    [LinuxPackageScript.DebPostinst]: path.join(dir, LinuxPackageScript.DebPostinst),
    [LinuxPackageScript.DebPostrm]: path.join(dir, LinuxPackageScript.DebPostrm),
    [LinuxPackageScript.RpmPost]: path.join(dir, LinuxPackageScript.RpmPost),
    [LinuxPackageScript.RpmPostun]: path.join(dir, LinuxPackageScript.RpmPostun),
  };
}

/** Write the maintainer scripts where the makers read them (the make step's `preMake` hook). */
export async function writeLinuxPackageScripts(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const scripts = linuxPackageScripts();
  const files = linuxPackageScriptFiles(dir);
  for (const key of Object.values(LinuxPackageScript)) await writeFile(files[key], scripts[key], { mode: 0o755 });
}
