// Rows for src/paths.*: the save root of each destination, computed from an injected environment,
// and the asset-path check. Everything here is a pure computation: the runner executes this
// binary in an empty directory and asserts nothing was created. Run with no argument for every
// row, or with a row name for one.
#include <cassert>
#include <cstdio>
#include <cstring>
#include <map>
#include <optional>
#include <string>

#include "paths.h"

namespace {

using studio::paths::Destination;
using studio::paths::GameIdentity;
using studio::paths::SaveRefusal;
using studio::paths::saveRoot;

/** An environment that holds exactly `vars`. */
studio::paths::Env envOf(std::map<std::string, std::string> vars) {
  return [vars](std::string_view name) -> std::optional<std::string> {
    auto found = vars.find(std::string(name));
    if (found == vars.end()) return std::nullopt;
    return found->second;
  };
}

const GameIdentity PONG{"Pong", "games.genex.game.0123456789ab"};

void genexRun() {
  // The run's state/ is an absolute path in this platform's own form; the other form is relative
  // here (`C:\\x` on a Mac, `/x` on Windows), so it is refused rather than resolved against the cwd.
  auto posix = saveRoot(Destination::GenexRun, envOf({{"GENEX_STATE_DIR", "/runs/r1/state"}}), PONG);
  auto windows = saveRoot(Destination::GenexRun, envOf({{"GENEX_STATE_DIR", "C:\\runs\\r1\\state\\"}}), PONG);
#if defined(_WIN32)
  assert(windows.ok() && windows.path == "C:\\runs\\r1\\state\\");
  assert(posix.refusal == SaveRefusal::NoStateDir);
#else
  assert(posix.ok() && posix.path == "/runs/r1/state/");
  assert(windows.refusal == SaveRefusal::NoStateDir);
#endif
  assert(saveRoot(Destination::GenexRun, envOf({}), PONG).refusal == SaveRefusal::NoStateDir);
}

void macRoot() {
  auto root = saveRoot(Destination::Mac, envOf({{"HOME", "/Users/ada"}}), PONG);
  assert(root.ok() && root.path == "/Users/ada/Library/Application Support/games.genex.game.0123456789ab/");
  assert(saveRoot(Destination::Mac, envOf({}), PONG).refusal == SaveRefusal::NoHome);
}

void windowsRoot() {
  auto root = saveRoot(Destination::Windows, envOf({{"APPDATA", "C:\\Users\\Ada\\AppData\\Roaming"}}), PONG);
  assert(root.ok() && root.path == "C:\\Users\\Ada\\AppData\\Roaming\\Pong\\");
  auto unc = saveRoot(Destination::Windows, envOf({{"APPDATA", "\\\\server\\share\\ada"}}), PONG);
  assert(unc.ok() && unc.path == "\\\\server\\share\\ada\\Pong\\");
  assert(saveRoot(Destination::Windows, envOf({}), PONG).refusal == SaveRefusal::NoAppData);
}

void linuxRoot() {
  auto xdg = saveRoot(Destination::Linux, envOf({{"XDG_DATA_HOME", "/home/ada/data/"}, {"HOME", "/home/ada"}}), PONG);
  assert(xdg.ok() && xdg.path == "/home/ada/data/Pong/");
  auto fallback = saveRoot(Destination::Linux, envOf({{"HOME", "/home/ada"}}), PONG);
  assert(fallback.ok() && fallback.path == "/home/ada/.local/share/Pong/");
}

void webRoot() {
  auto root = saveRoot(Destination::Web, envOf({{"HOME", "/home/web_user"}}), PONG);
  assert(root.ok() && root.path == studio::paths::WEB_SAVE_ROOT);
}

void hostileEnv() {
  const std::string home = "/home/ada";
  // XDG says a relative XDG_DATA_HOME is ignored; an empty one or one that climbs is ignored too.
  for (const char* xdg : {"relative/data", "", "/home/ada/../eve", "/home/ada/data/..", "./data", "/a\\..\\b"}) {
    auto root = saveRoot(Destination::Linux, envOf({{"XDG_DATA_HOME", xdg}, {"HOME", home}}), PONG);
    assert(root.ok() && root.path == "/home/ada/.local/share/Pong/");
  }
  const std::string badRoots[] = {"", "relative", "/home/../root", "..", std::string("/home/a\0b", 9),
                                  "/home/a\\b"};
  for (const std::string& bad : badRoots) {
    assert(saveRoot(Destination::Linux, envOf({{"HOME", bad}}), PONG).refusal == SaveRefusal::NoHome);
    assert(saveRoot(Destination::Mac, envOf({{"HOME", bad}}), PONG).refusal == SaveRefusal::NoHome);
    assert(saveRoot(Destination::GenexRun, envOf({{"GENEX_STATE_DIR", bad}}), PONG).refusal == SaveRefusal::NoStateDir);
  }
  const char* badAppData[] = {"", "Roaming", "C:", "C:relative", "\\\\?\\C:\\x", "\\\\.\\pipe\\x", "C:\\a\\..\\b",
                              "/unix"};
  for (const char* bad : badAppData) {
    assert(saveRoot(Destination::Windows, envOf({{"APPDATA", bad}}), PONG).refusal == SaveRefusal::NoAppData);
  }
}

void hostileNames() {
  auto env = envOf({{"HOME", "/home/ada"}, {"APPDATA", "C:\\A"}});
  for (const char* name : {"", ".", "..", "../x", "a/b", "a\\b", ".hidden", "CON", "nul", "com1", "lpt9",
                           "trailing ", "tab\tname"}) {
    assert(saveRoot(Destination::Linux, env, {name, PONG.bundleId}).refusal == SaveRefusal::BadName);
    assert(saveRoot(Destination::Windows, env, {name, PONG.bundleId}).refusal == SaveRefusal::BadName);
  }
  assert(saveRoot(Destination::Linux, env, {std::string(65, 'n'), PONG.bundleId}).refusal == SaveRefusal::BadName);
  assert(saveRoot(Destination::Linux, env, {"My Game-2_v1.0", PONG.bundleId}).ok());
  for (const char* bundle : {"", "nodots", "a..b", ".a.b", "a.b.", "a/b.c", "a.b c", "../x.y"}) {
    assert(saveRoot(Destination::Mac, env, {PONG.name, bundle}).refusal == SaveRefusal::BadBundleId);
  }
}

void assetPaths() {
  for (const char* ok : {"hero.png", "models/ship.glb", "a/b/c.ogg", "sfx/hit-1.wav", "My Save 2.dat", "console.png"}) {
    assert(studio::paths::isSafeAssetPath(ok));
  }
  // Win32 strips a segment's trailing dots and spaces (`.. ` is `..`) and opens a device for a
  // reserved stem whatever its extension, so those segments are refused on every destination.
  for (const char* bad : {"", "/etc/passwd", "../secret.png", "a/../../b", "a/./b", "C:\\x.png", "a\\b.png", "a//b",
                          "a/", "..", "~/x", ".. /x", "a/... ", "a/...", "x.", "x ", "con.png", "NUL", "a/Lpt1.txt",
                          "com9.sav", "con .png"}) {
    assert(!studio::paths::isSafeAssetPath(bad));
  }
  assert(!studio::paths::isSafeAssetPath(std::string("a\0b", 3)));
}

void buildIdentity() {
  // What the build named this game (genex.cmake's GENEX_GAME_NAME and GENEX_BUNDLE_ID), printed
  // for the runner, which builds this row once without the defines and once with them.
  GameIdentity built = studio::paths::identityOf("", "");
  assert(built.name == studio::paths::BUILD_IDENTITY.name && built.bundleId == studio::paths::BUILD_IDENTITY.bundleId);
  std::printf("identity %.*s|%.*s\n", static_cast<int>(built.name.size()), built.name.data(),
              static_cast<int>(built.bundleId.size()), built.bundleId.data());
  // The game's own save name, and the running app's bundle id (the host writes its Info.plist), win.
  GameIdentity own = studio::paths::identityOf("Pong Remix", "games.genex.game.0123456789ab");
  assert(own.name == "Pong Remix" && own.bundleId == "games.genex.game.0123456789ab");
  // A build the host did not name saves nowhere outside Genex and the browser, rather than in a
  // folder every other unnamed game shares.
  if (built.name.empty()) {
    assert(saveRoot(Destination::Linux, envOf({{"HOME", "/home/ada"}}), built).refusal == SaveRefusal::BadName);
    assert(saveRoot(Destination::Windows, envOf({{"APPDATA", "C:\\A"}}), built).refusal == SaveRefusal::BadName);
  }
  if (built.bundleId.empty()) {
    assert(saveRoot(Destination::Mac, envOf({{"HOME", "/Users/ada"}}), built).refusal == SaveRefusal::BadBundleId);
  }
}

void logClaims() {
  using studio::paths::claimedFile;
  const std::string_view save = "/save/";
  assert(claimedFile(true, "FILEIO: [/assets/hero.png] File loaded successfully", save) == "/assets/hero.png");
  assert(claimedFile(true, "FILEIO: [/assets/theme.ogg] Music file loaded successfully", save) == "/assets/theme.ogg");
  // A failure is a warning, not a load; a save is the game's own file, not an asset it loaded.
  assert(claimedFile(false, "FILEIO: [/assets/missing.png] Failed to open file", save).empty());
  assert(claimedFile(false, "FILEIO: [/assets/theme.ogg] Music file could not be opened", save).empty());
  assert(claimedFile(true, "FILEIO: [/save/slot1] File saved successfully", save).empty());
  assert(claimedFile(true, "FILEIO: [/save/slots/2.dat] File loaded successfully", save).empty());
  // Not a file line, or a broken one.
  assert(claimedFile(true, "TEXTURE: [ID 3] Texture loaded successfully", save).empty());
  assert(claimedFile(true, "FILEIO: [unterminated", save).empty());
  assert(claimedFile(true, "FILEIO: [] File loaded successfully", save).empty());
  // With no save folder (saves are off), nothing is excluded for being under it.
  assert(claimedFile(true, "FILEIO: [/save/x] File loaded successfully", "") == "/save/x");
}

void assetClaims() {
  using studio::paths::assetClaim;
  for (const std::string& root : {"/native-runs/one/assets/", "/native-runs/two/assets/", "/assets/"}) {
    assert(assetClaim(root + "fish.glb", root) == "/assets/fish.glb");
    assert(assetClaim(root + "audio/bite.wav", root) == "/assets/audio/bite.wav");
    assert(assetClaim(root + "other.glb", root) != assetClaim(root + "fish.glb", root));
  }
  const std::string bundle = "/Applications/Fish.app/Contents/MacOS/../Resources/assets/";
  assert(assetClaim(bundle + "fish.glb", bundle) == "/assets/fish.glb");
  assert(assetClaim("/Applications/Fish.app/Contents/Resources/assets/fish.glb", bundle) == "/assets/fish.glb");
  assert(assetClaim("C:\\runs\\one\\assets\\fish.glb", "C:\\runs\\one\\assets\\") == "/assets/fish.glb");
  assert(assetClaim("C:/runs/one/assets/audio/bite.wav", "C:\\runs\\one\\assets\\") == "/assets/audio/bite.wav");
  assert(assetClaim("\\\\server\\share\\game\\assets\\fish.glb", "\\\\server\\share\\game\\assets\\") ==
         "/assets/fish.glb");
  const std::string root = "/runs/one/assets/";
  for (const std::string& file : {"/runs/one/assets-other/fish.glb", "/runs/one/assets/../other/fish.glb",
                                "/runs/one/assets/CON.png", "/runs/one/assets/fish.glb ",
                                "/runs/one/assets/", "assets/fish.glb", "/outside/fish.glb"}) {
    assert(assetClaim(file, root) == file);
  }
  for (const std::string& badRoot : {"", "assets/", "C:assets/", "\\\\?\\C:\\assets\\"}) {
    assert(assetClaim("/runs/one/assets/fish.glb", badRoot) == "/runs/one/assets/fish.glb");
  }
  std::string nulFile = root + "fish";
  nulFile.push_back('\0');
  nulFile += ".glb";
  assert(assetClaim(nulFile, root) == nulFile);
  std::string nulRoot = root;
  nulRoot.push_back('\0');
  assert(assetClaim(root + "fish.glb", nulRoot) == root + "fish.glb");
}

void captureRoots() {
  using studio::paths::captureFolder;
  using studio::paths::capturePath;
#if !defined(_WIN32)
  assert(captureFolder("/runs/r1/state/") == "/runs/r1/state/captures/");
  assert(capturePath("/runs/r1/state/", 7) == "/runs/r1/state/captures/7.bgra");
#endif
  // No usable state root: nothing, never `/captures/`, the working folder or a climb out.
  for (std::string_view root : {"", "state/", "/a/../b/", "/a/.."}) {
    assert(captureFolder(root).empty());
    assert(capturePath(root, 1).empty());
  }
}

void windowSystem() {
  using studio::paths::prefersX11;
  // An X server named: X11 (Xorg, or XWayland beside a Wayland session), exported or run by the studio.
  assert(prefersX11(envOf({{"DISPLAY", ":0"}})));
  assert(prefersX11(envOf({{"DISPLAY", ":0"}, {"WAYLAND_DISPLAY", "wayland-0"}, {"XDG_SESSION_TYPE", "wayland"}})));
  assert(prefersX11(envOf({{"DISPLAY", ":99"}, {"GENEX_STUDIO_FD", "3"}})));
  // No X server, as in the studio's Linux box (a Wayland socket only): GLFW's own choice.
  assert(!prefersX11(envOf({})));
  assert(!prefersX11(envOf({{"DISPLAY", ""}, {"WAYLAND_DISPLAY", "wayland-0"}})));
  assert(!prefersX11(envOf({{"WAYLAND_DISPLAY", "wayland-genex-0"}, {"GENEX_STUDIO_FD", "3"}})));
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"genex-run", genexRun},     {"mac", macRoot},           {"windows", windowsRoot},
    {"linux", linuxRoot},            {"web", webRoot},           {"hostile-env", hostileEnv},
    {"hostile-names", hostileNames}, {"asset-paths", assetPaths},
    {"build-identity", buildIdentity}, {"log-claims", logClaims}, {"capture-roots", captureRoots},
    {"asset-claims", assetClaims},
    {"window-system", windowSystem},
};

}  // namespace

int main(int argc, char** argv) {
  int ran = 0;
  for (const Row& row : ROWS) {
    if (argc > 1 && std::strcmp(argv[1], row.name) != 0) continue;
    row.run();
    std::printf("ok %s\n", row.name);
    ++ran;
  }
  if (ran > 0) return 0;
  std::fprintf(stderr, "no row named %s\n", argc > 1 ? argv[1] : "(none)");
  return 2;
}
