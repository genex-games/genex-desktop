/**
 * Packaging.
 *
 * Supported target: macOS on Apple Silicon (arm64); Linux x64 packages (deb, rpm, zip) and the
 * Windows x64 Squirrel installer (unsigned until a certificate exists) are built and smoke-tested
 * in CI. Without a signing identity the macOS build is signed ad-hoc once packaged and opens only
 * on the Mac that built it; with one it is a hardened, notarized Developer ID build
 * (scripts/package-signing.cjs, .github/workflows/release.yml).
 * Open release decisions are in docs/release-readiness.md.
 *
 * The one subtlety is asar: the harness bootstrap and the self-edit gate's TypeScript compiler
 * (dist/resources/tsc) are **spawned** as child processes and the vendored three.js is **served**
 * to the preview, and none of that works from inside an asar archive.
 * Runtime resources (including the Genex plugin payload) are unpacked. Coding CLIs are external installations:
 * exclude Codex and Claude SDK native packages; retain the Claude JavaScript SDK only.
 */
const { execFile } = require("node:child_process");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const {
  pruneUnreachable,
  refuseLinkedModules,
  trimNodePty,
  trimSandboxVendor,
} = require("./scripts/package-prune.cjs");
const { APP_BUNDLE_ID, localSigningHook, macSigning, windowsSigning } = require("./scripts/package-signing.cjs");
const {
  LinuxPackageScript,
  linuxPackageScriptFiles,
  portableReadme,
  writeLinuxPackageScripts,
} = require("./src/substrate/linux-apparmor.ts");
const { version } = require("./package.json");

const PRODUCT_NAME = "Genex";
const EXECUTABLE_NAME = "genex";
const HOMEPAGE = "https://github.com/genex-games/genex-desktop";
const SUMMARY = "Self-improving AI game studio";
/** The Linux desktop entry's generic name, beside the product name. */
const GENERIC_NAME = "Game studio";
/** Who the packages name as their authors. */
const AUTHORS = "Genex contributors";
const DESCRIPTION =
  "A desktop studio where coding agents build three.js games, run them in a live preview, judge the result and improve their own harness.";
// Renditions of the 1024x1024 app icon master: .icns for macOS, .png for Linux, .ico for Windows.
const ICON = path.join(__dirname, "build", "icon");
/** The install window's 660x400 art; appdmg picks up the @2x file beside it for Retina. */
const DMG_BACKGROUND = path.join(__dirname, "build", "dmg-background.png");
/** Icon centres in the install window, either side of the background's arrow. */
const DMG_ICON_Y = 170;
const DMG_APP_X = 165;
const DMG_APPLICATIONS_X = 495;
const DMG_ICON_SIZE = 128;
/** Linux's process sandbox and code search; package-specific xz supplies C++ archive decoding. */
const LINUX_DEPENDS = ["bubblewrap", "socat", "ripgrep"];
const DEB_DEPENDS = [...LINUX_DEPENDS, "xz-utils"];
const RPM_REQUIRES = [...LINUX_DEPENDS, "xz"];
const LINUX_CATEGORIES = ["Development", "Game"];
/**
 * The rpm's maintainer scripts, written before the makers run (`preMake`): they install
 * Genex's AppArmor profile where AppArmor 4 is present, so Ubuntu's user-namespace restriction
 * lets its sandbox work, and remove it with the package (src/substrate/linux-apparmor.ts). The
 * deb takes `DEB_SCRIPTS` below.
 */
const LINUX_PACKAGE_SCRIPTS_DIR = path.join(__dirname, "out", "linux-package-scripts");
const LINUX_SCRIPTS = linuxPackageScriptFiles(LINUX_PACKAGE_SCRIPTS_DIR);
/**
 * The note the Linux zip carries beside `genex`: a zip copy on Ubuntu 23.10 and later stops in
 * Chromium's sandbox before the setup screen can offer the AppArmor profile, so the command to add
 * it travels with the zip (`portableReadme`, the same install Set up runs).
 */
const LINUX_ZIP_README = "README-LINUX.txt";

/**
 * Add README-LINUX.txt to each Linux zip the make step produced, inside its top folder. maker-zip
 * names a zip `<top folder>-<version>.zip` and zips that folder with the `zip` tool, which is
 * therefore here to append with. Every other artifact is left as it is.
 */
async function addLinuxZipReadme(results) {
  for (const { platform, artifacts, packageJSON } of results) {
    if (platform !== "linux") continue;
    for (const zip of artifacts.filter((artifact) => artifact.endsWith(".zip"))) {
      const suffix = `-${packageJSON.version}.zip`;
      const name = path.basename(zip);
      if (!name.endsWith(suffix)) throw new Error(`${name}: not named <folder>${suffix} as maker-zip names a zip`);
      const staging = await mkdtemp(path.join(os.tmpdir(), "genex-linux-zip-"));
      try {
        const entry = path.posix.join(name.slice(0, -suffix.length), LINUX_ZIP_README);
        await mkdir(path.join(staging, path.dirname(entry)));
        await writeFile(path.join(staging, entry), portableReadme(), { mode: 0o644 });
        // -X: no extra file attributes, so the entry is the same wherever the zip is made.
        await promisify(execFile)("zip", ["-q", "-X", zip, entry], { cwd: staging });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  }
  return results;
}
/**
 * The deb's maintainer scripts: install and remove the AppArmor profile that lets the sandbox
 * create user namespaces on Ubuntu 24.04 and the distributions built on it.
 */
const DEB_SCRIPTS = {
  postinst: path.join(__dirname, "build", "linux", "postinst"),
  postrm: path.join(__dirname, "build", "linux", "postrm"),
};
/** The Windows installer's file name, the same for every version so a download link can stay put. */
const WINDOWS_SETUP_EXE = "Genex-Setup.exe";
/** Only with a WINDOWS_SIGN_* certificate, parameters or hook; otherwise unsigned. */
const windowsSign = windowsSigning(process.env);
/** Only with MACOS_SIGN_IDENTITY (and the notarytool API key); otherwise ad-hoc once packaged. */
const macSign = macSigning(process.env, APP_BUNDLE_ID);
/** Why macOS asks before the app's agents read or write in a protected folder. */
const folderAccess = (where) => `Genex's agents build and run games in the folders you choose, including ${where}.`;

module.exports = {
  packagerConfig: {
    name: PRODUCT_NAME,
    executableName: EXECUTABLE_NAME,
    appBundleId: APP_BUNDLE_ID,
    appCategoryType: "public.app-category.developer-tools",
    icon: ICON,
    asar: {
      unpack:
        "{**/dist/resources/**,**/node_modules/node-pty/**,**/node_modules/@anthropic-ai/sandbox-runtime/vendor/**}",
    },
    // Ship only what the app needs at runtime; sources and tests stay out of the bundle.
    ignore: [
      /^\/node_modules\/@genex-ai\/cli-demo(?:\/|$)/,
      /\/node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+(?:\/|$)/,
      /\/node_modules\/@openai\/codex(?:-[^/]+)?(?:\/|$)/,
      /^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$|LICENSE(?:\..*)?$|THIRD-PARTY-NOTICES\.md$)/,
      /^\/archive($|\/)/,
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/scripts($|\/)/,
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.(studio-dev|claude|codex|agents)($|\/)/,
      /^\/docs\/agent($|\/)/,
      /^\/(AGENTS|CLAUDE)\.md$/,
      /^\/PLAN\.md$/,
      /^\/research($|\/)/,
      /^\/tsconfig\.json$/,
      /\.map$/,
    ],
    // Forge's prune keeps the trees of ignored dependencies and every platform's node-pty and
    // sandbox-runtime helpers; drop what the target never loads (scripts/package-prune.cjs).
    afterPrune: [
      async ({ buildPath, platform, arch }) => {
        await pruneUnreachable(buildPath);
        await trimNodePty(buildPath, platform, arch);
        await trimSandboxVendor(buildPath, platform, arch);
      },
    ],
    extendInfo: {
      // The studio is meant to keep working while unattended and in the background.
      LSUIElement: false,
      NSHumanReadableCopyright: `© ${AUTHORS}`,
      // Agent children run as this app, so macOS attributes their folder access to it.
      NSDocumentsFolderUsageDescription: folderAccess("your Documents folder"),
      NSDesktopFolderUsageDescription: folderAccess("your Desktop"),
      NSDownloadsFolderUsageDescription: folderAccess("your Downloads folder"),
      NSRemovableVolumesUsageDescription: folderAccess("folders on an external drive"),
      // app_look reads an app window's accessibility tree through System Events (Automation).
      NSAppleEventsUsageDescription:
        "Genex reads the accessibility tree of an app window when an agent looks at it. It never clicks or types.",
    },
    // The Windows executable's version resource: what Explorer, Task Manager and UAC show.
    win32metadata: {
      CompanyName: PRODUCT_NAME,
      ProductName: PRODUCT_NAME,
      FileDescription: PRODUCT_NAME,
      InternalName: EXECUTABLE_NAME,
    },
    ...macSign,
    ...(windowsSign ? { windowsSign } : {}),
  },
  // Windows uses node-pty's own N-API prebuilds (conpty and winpty included) rather than
  // compiling it: nothing else native ships, and no Visual Studio is needed to package.
  rebuildConfig: process.platform === "win32" ? { ignoreModules: ["node-pty"] } : {},
  hooks: {
    // Before anything is copied: a linked node_modules would be pruned in place.
    prePackage: () => refuseLinkedModules(__dirname),
    // A macOS build no identity signs is signed again over its finished Info.plist: the fuses'
    // ad-hoc signature predates it, and macOS then refuses the agents protected folders unasked.
    postPackage: localSigningHook(macSign, PRODUCT_NAME),
    preMake: () => writeLinuxPackageScripts(LINUX_PACKAGE_SCRIPTS_DIR),
    postMake: (_forgeConfig, results) => addLinuxZipReadme(results),
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: PRODUCT_NAME,
        icon: `${ICON}.icns`,
        format: "ULFO",
        background: DMG_BACKGROUND,
        iconSize: DMG_ICON_SIZE,
        contents: ({ appPath }) => [
          { x: DMG_APP_X, y: DMG_ICON_Y, type: "file", path: appPath },
          { x: DMG_APPLICATIONS_X, y: DMG_ICON_Y, type: "link", path: "/Applications" },
        ],
      },
    },
    // Windows: a per-user install under %LOCALAPPDATA%\genex (Squirrel), which update.electronjs.org
    // updates from the release's RELEASES and nupkg. Named `genex`, not the npm package name.
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: EXECUTABLE_NAME,
        title: PRODUCT_NAME,
        authors: AUTHORS,
        description: SUMMARY,
        setupExe: WINDOWS_SETUP_EXE,
        setupIcon: `${ICON}.ico`,
        noMsi: true,
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
    // The darwin zip is also what update.electronjs.org serves to installed copies.
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux"] },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: EXECUTABLE_NAME,
          // The packaged binary is `executableName`, not the npm package name the makers default to.
          bin: EXECUTABLE_NAME,
          productName: PRODUCT_NAME,
          genericName: GENERIC_NAME,
          description: SUMMARY,
          productDescription: DESCRIPTION,
          categories: LINUX_CATEGORIES,
          section: "devel",
          maintainer: AUTHORS,
          homepage: HOMEPAGE,
          icon: `${ICON}.png`,
          depends: DEB_DEPENDS,
          scripts: DEB_SCRIPTS,
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: EXECUTABLE_NAME,
          // The packaged binary is `executableName`, not the npm package name the makers default to.
          bin: EXECUTABLE_NAME,
          productName: PRODUCT_NAME,
          genericName: GENERIC_NAME,
          description: SUMMARY,
          productDescription: DESCRIPTION,
          categories: LINUX_CATEGORIES,
          homepage: HOMEPAGE,
          icon: `${ICON}.png`,
          requires: RPM_REQUIRES,
          license: "MIT",
          scripts: {
            post: LINUX_SCRIPTS[LinuxPackageScript.RpmPost],
            postun: LINUX_SCRIPTS[LinuxPackageScript.RpmPostun],
          },
        },
      },
    },
  ],
  plugins: [
    // Applied to the Electron binary before signing.
    new FusesPlugin({
      version: FuseVersion.V1,
      // ON: the harness, plugin backends, MCP servers, Genex and the self-edit gate are this
      // binary run with ELECTRON_RUN_AS_NODE.
      [FuseV1Options.RunAsNode]: true,
      // ON: cookies at rest are encrypted with the OS key store.
      [FuseV1Options.EnableCookieEncryption]: true,
      // OFF: NODE_OPTIONS and --inspect cannot inject code into a signed app (the harness host
      // already clears NODE_OPTIONS for its children).
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // ON: the app loads only from app.asar, and that archive must match the hash in Info.plist
      // (packaged smoke checks both).
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      // ON: the renderer loads over file://, which needs the privileges this fuse keeps.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        // The public repository, as UPDATE_REPO in src/main/auto-update.ts names it.
        repository: { owner: "genex-games", name: "genex-desktop" },
        draft: true,
        // The tag is v<version>; a pre-release version (0.2.0-rc.1) makes a GitHub pre-release.
        prerelease: version.includes("-"),
      },
    },
  ],
};
