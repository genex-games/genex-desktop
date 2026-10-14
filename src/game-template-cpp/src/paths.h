// Where a game keeps its saves on each destination, which asset paths it may open, and which
// files it reported loading. The environment is injected, so every rule here is a pure
// computation: nothing is created or read. A Genex run saves in the run's own `state/`
// (GENEX_STATE_DIR), an exported Mac app in ~/Library/Application Support/<bundle id>/, Windows
// in %APPDATA%\<name>\, Linux in $XDG_DATA_HOME/<name>/ (or ~/.local/share/<name>/), and the
// browser in the IDBFS mount. raylib-free.
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>

namespace studio::paths {

/** Where the game is running. */
enum class Destination { GenexRun, Web, Mac, Windows, Linux };

/** Why there is no save root. */
enum class SaveRefusal { None, NoStateDir, NoHome, NoAppData, BadName, BadBundleId };

/** An environment lookup: the value of a variable, or nothing. */
using Env = std::function<std::optional<std::string>(std::string_view name)>;

/** The name the game saves under (Windows, Linux) and its bundle id (Mac). */
struct GameIdentity {
  std::string_view name;
  std::string_view bundleId;
};

// The identity the studio's build gives a game: its genex.cmake defines both, from the game's
// name and its once-chosen bundle id. A build without them saves nowhere outside a Genex run and
// the browser, rather than in a folder every other unnamed game would share.
#ifndef GENEX_GAME_NAME
#define GENEX_GAME_NAME ""
#endif
#ifndef GENEX_BUNDLE_ID
#define GENEX_BUNDLE_ID ""
#endif

/** The identity this build was given (empty parts when it was given none). */
inline constexpr GameIdentity BUILD_IDENTITY{GENEX_GAME_NAME, GENEX_BUNDLE_ID};

/** A save root ending in its separator, or why there is none. */
struct SaveRoot {
  SaveRefusal refusal = SaveRefusal::None;
  std::string path;
  bool ok() const { return refusal == SaveRefusal::None; }
};

/** The variable a Genex run names its `state/` folder in. */
inline constexpr std::string_view STATE_DIR_ENV = "GENEX_STATE_DIR";
/** Set only when the studio runs the game; it names the protocol's file descriptor. */
inline constexpr std::string_view STUDIO_FD_ENV = "GENEX_STUDIO_FD";
/** The X server a Linux session names (Xorg, or XWayland beside a Wayland compositor). */
inline constexpr std::string_view X11_DISPLAY_ENV = "DISPLAY";
/** The folder of a Genex run's state that captures go in. */
inline constexpr std::string_view CAPTURES_DIR = "captures";
/** A capture file's extension: raw BGRA, top row first, width * height * 4 bytes. */
inline constexpr std::string_view CAPTURE_EXTENSION = ".bgra";
/** Where the web shell mounts IDBFS. */
inline constexpr std::string_view WEB_SAVE_ROOT = "/save/";
/** The longest save name accepted. */
inline constexpr std::size_t MAX_NAME_LENGTH = 64;
/** The longest bundle id accepted. */
inline constexpr std::size_t MAX_BUNDLE_ID_LENGTH = 155;

/**
 * The save root of `game` on `where`. A variable that is empty, relative, climbs with `..` or
 * carries a NUL is not trusted: XDG_DATA_HOME then falls back to HOME, everything else refuses.
 * GENEX_STATE_DIR must be absolute in this platform's own form (`C:\\…` is relative on a Mac).
 */
SaveRoot saveRoot(Destination where, const Env& env, GameIdentity game);

/**
 * The identity a game saves under: its own `saveName` when it set one, else the build's; the
 * running app's bundle id when it has one (the host writes every Mac app's Info.plist), else the build's.
 */
GameIdentity identityOf(std::string_view saveName, std::string_view runningBundleId);

/** This process's destination: a Genex run when the studio passed its descriptor, else the build's platform. */
Destination destinationOf(const Env& env);

/** The process environment, through getenv. */
Env processEnv();

/**
 * Whether a Linux window build opens its window on X11 instead of GLFW's own choice: whenever
 * DISPLAY names an X server. GLFW picks Wayland whenever the session says so, and ANGLE on Vulkan
 * offers it no usable EGLConfig there yet, so the window would not open; XWayland runs beside
 * every common Wayland desktop. The studio's Linux box never names an X server (it refuses X11:
 * any X11 client reads every window's keys), so its runs keep GLFW's choice.
 */
bool prefersX11(const Env& env);

/**
 * Whether `rel` may name a file under assets/ (or the save folder): `/`-separated segments of
 * letters, digits, space, `_`, `-` and `.`, none empty, `.` or `..`. Absolute paths, backslashes
 * and drive letters are refused, and so is what Windows would read differently: a segment ending
 * in a dot or a space (Win32 strips them, so `.. ` is `..`) and a device name (`con.png`).
 */
bool isSafeAssetPath(std::string_view rel);

/**
 * A loaded file under the platform's assets root labelled `/assets/<rel>` for replay. Both paths
 * must be absolute and the relative name must be safe; everything else keeps its original label.
 * This is a lexical evidence label only: it never opens a file or grants access to one.
 */
std::string assetClaim(std::string_view file, std::string_view assetRoot);

/**
 * `<stateRoot>captures/`: the folder captures go in, for a save root ending in its separator; ""
 * unless `stateRoot` is absolute in this platform's own form and does not climb (as GENEX_STATE_DIR
 * must be), so an empty or relative root never lands at `/captures/` or in the working folder.
 */
std::string captureFolder(std::string_view stateRoot);
/** `<stateRoot>captures/<seq>.bgra`: where the host reads capture `seq`; "" where captureFolder() is. */
std::string capturePath(std::string_view stateRoot, std::uint32_t seq);

/**
 * The file a raylib log line says was loaded: an informational `FILEIO: [path] …` line, unless
 * the path is under `saveRoot` (the game's own saves are not assets). "" for anything else,
 * failures included (raylib logs those as warnings).
 */
std::string_view claimedFile(bool informational, std::string_view line, std::string_view saveRoot);

}  // namespace studio::paths
