// The save roots and asset-path rule declared in paths.h. raylib-free.
#include "paths.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <initializer_list>
#include <iterator>
#include <vector>

namespace studio::paths {

namespace {

/** Windows device names a file or folder may not take, whatever its extension. */
constexpr std::string_view RESERVED_NAMES[] = {"CON",  "PRN",  "AUX",  "NUL",  "COM1", "COM2", "COM3", "COM4",
                                               "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3",
                                               "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"};

bool isAsciiAlnum(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'); }

/** Letters, digits, space, `_`, `-` and `.`: what a save name or an asset path segment may hold. */
bool isNameChar(char c) { return isAsciiAlnum(c) || c == ' ' || c == '_' || c == '-' || c == '.'; }

bool isLabelChar(char c) { return isAsciiAlnum(c) || c == '-'; }

char upper(char c) { return static_cast<char>(std::toupper(static_cast<unsigned char>(c))); }

/** Whether any `separator`-delimited segment of `path` is `..`. */
bool climbs(std::string_view path, char separator) {
  std::size_t start = 0;
  for (;;) {
    std::size_t end = path.find(separator, start);
    if (path.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start) == "..") return true;
    if (end == std::string_view::npos) return false;
    start = end + 1;
  }
}

bool hasNul(std::string_view text) { return text.find('\0') != std::string_view::npos; }

/** An absolute POSIX path that does not climb and has no backslash or NUL. */
bool isPosixRoot(std::string_view path) {
  return !path.empty() && path.front() == '/' && !climbs(path, '/') && !hasNul(path) &&
         path.find('\\') == std::string_view::npos;
}

/** `C:\…` or `\\server\share…`, never a device path (`\\?\`, `\\.\`), without `..` or NUL. */
bool isWindowsRoot(std::string_view path) {
  bool drive = path.size() >= 3 && std::isalpha(static_cast<unsigned char>(path[0])) && path[1] == ':' &&
               (path[2] == '\\' || path[2] == '/');
  bool share = path.size() >= 3 && path.substr(0, 2) == "\\\\" && path[2] != '?' && path[2] != '.';
  return (drive || share) && !climbs(path, '\\') && !climbs(path, '/') && !hasNul(path);
}

/** An absolute path in a common separator form, with `.` and `..` resolved without reading the filesystem. */
std::string absoluteClaimPath(std::string_view value) {
  if (value.empty() || hasNul(value)) return {};
  std::string path(value);
  bool windows = isWindowsRoot(path);
  if (windows) std::replace(path.begin(), path.end(), '\\', '/');
  if (!windows && (path.front() != '/' || path.find('\\') != std::string::npos)) return {};
  std::size_t first = 1;
  if (windows) first = path.front() == '/' ? 2 : 3;
  std::string root = path.substr(0, first);
  std::vector<std::string_view> parts;
  while (first < path.size()) {
    std::size_t end = path.find('/', first);
    std::size_t size = end == std::string::npos ? end : end - first;
    std::string_view part = std::string_view(path).substr(first, size);
    if (part == "..") {
      if (parts.empty()) return {};
      parts.pop_back();
    } else if (!part.empty() && part != ".") {
      parts.push_back(part);
    }
    if (end == std::string::npos) break;
    first = end + 1;
  }
  for (std::string_view part : parts) {
    if (root.back() != '/') root += '/';
    root += part;
  }
  return root;
}

/** This platform's own separator, and whether `path` is absolute in this platform's own form. */
#if defined(_WIN32)
constexpr char NATIVE_SEPARATOR = '\\';
bool isNativeRoot(std::string_view path) { return isWindowsRoot(path); }
#else
constexpr char NATIVE_SEPARATOR = '/';
bool isNativeRoot(std::string_view path) { return isPosixRoot(path); }
#endif

/** How raylib names a file it read or wrote: `FILEIO: [path] …`. */
constexpr std::string_view FILEIO_PREFIX = "FILEIO: [";

/** `base` with its trailing separators removed and `parts` appended, each followed by `separator`. */
std::string join(std::string_view base, std::initializer_list<std::string_view> parts, char separator) {
  while (base.size() > 1 && (base.back() == '/' || base.back() == '\\')) base.remove_suffix(1);
  std::string out(base);
  out += separator;
  for (std::string_view part : parts) {
    out += part;
    out += separator;
  }
  return out;
}

bool isReservedName(std::string_view name) {
  std::string stem(name.substr(0, name.find('.')));
  // Win32 matches a device name with trailing spaces too (`con .png`).
  while (!stem.empty() && stem.back() == ' ') stem.pop_back();
  std::transform(stem.begin(), stem.end(), stem.begin(), upper);
  return std::find(std::begin(RESERVED_NAMES), std::end(RESERVED_NAMES), stem) != std::end(RESERVED_NAMES);
}

/** A folder name every destination accepts. */
bool isSafeName(std::string_view name) {
  if (name.empty() || name.size() > MAX_NAME_LENGTH) return false;
  bool allowed = std::all_of(name.begin(), name.end(), isNameChar);
  bool edges = name.front() != '.' && name.front() != ' ' && name.back() != '.' && name.back() != ' ';
  return allowed && edges && !isReservedName(name);
}

/** Reverse-DNS: two or more non-empty labels of letters, digits and `-`. */
bool isBundleId(std::string_view id) {
  if (id.empty() || id.size() > MAX_BUNDLE_ID_LENGTH || id.find('.') == std::string_view::npos) return false;
  std::size_t start = 0;
  for (;;) {
    std::size_t end = id.find('.', start);
    std::string_view label = id.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
    bool valid = !label.empty() && std::all_of(label.begin(), label.end(), isLabelChar);
    if (!valid) return false;
    if (end == std::string_view::npos) return true;
    start = end + 1;
  }
}

std::string lookup(const Env& env, std::string_view name) {
  return env ? env(name).value_or(std::string()) : std::string();
}

SaveRoot refused(SaveRefusal why) { return SaveRoot{why, {}}; }

SaveRoot genexRun(const Env& env) {
  std::string state = lookup(env, STATE_DIR_ENV);
  if (!isNativeRoot(state)) return refused(SaveRefusal::NoStateDir);
  return SaveRoot{SaveRefusal::None, join(state, {}, NATIVE_SEPARATOR)};
}

/** One asset or save path segment that every destination reads the same way. */
bool isSafeSegment(std::string_view segment) {
  if (segment.empty() || segment == "." || segment == "..") return false;
  bool plain = std::all_of(segment.begin(), segment.end(), isNameChar);
  bool stripped = segment.back() == '.' || segment.back() == ' ';
  return plain && !stripped && !isReservedName(segment);
}

SaveRoot linuxRoot(const Env& env, std::string_view name) {
  std::string xdg = lookup(env, "XDG_DATA_HOME");
  if (isPosixRoot(xdg)) return SaveRoot{SaveRefusal::None, join(xdg, {name}, '/')};
  std::string home = lookup(env, "HOME");
  if (isPosixRoot(home)) return SaveRoot{SaveRefusal::None, join(home, {".local", "share", name}, '/')};
  return refused(SaveRefusal::NoHome);
}

}  // namespace

SaveRoot saveRoot(Destination where, const Env& env, GameIdentity game) {
  switch (where) {
    case Destination::GenexRun:
      return genexRun(env);
    case Destination::Web:
      return SaveRoot{SaveRefusal::None, std::string(WEB_SAVE_ROOT)};
    case Destination::Mac: {
      if (!isBundleId(game.bundleId)) return refused(SaveRefusal::BadBundleId);
      std::string home = lookup(env, "HOME");
      if (!isPosixRoot(home)) return refused(SaveRefusal::NoHome);
      return SaveRoot{SaveRefusal::None, join(home, {"Library", "Application Support", game.bundleId}, '/')};
    }
    case Destination::Windows: {
      if (!isSafeName(game.name)) return refused(SaveRefusal::BadName);
      std::string appData = lookup(env, "APPDATA");
      if (!isWindowsRoot(appData)) return refused(SaveRefusal::NoAppData);
      return SaveRoot{SaveRefusal::None, join(appData, {game.name}, '\\')};
    }
    case Destination::Linux:
      if (!isSafeName(game.name)) return refused(SaveRefusal::BadName);
      return linuxRoot(env, game.name);
  }
  return refused(SaveRefusal::NoHome);
}

bool prefersX11(const Env& env) { return !lookup(env, X11_DISPLAY_ENV).empty(); }

Destination destinationOf(const Env& env) {
  if (!lookup(env, STUDIO_FD_ENV).empty()) return Destination::GenexRun;
#if defined(PLATFORM_WEB) || defined(__EMSCRIPTEN__)
  return Destination::Web;
#elif defined(_WIN32)
  return Destination::Windows;
#elif defined(__APPLE__)
  return Destination::Mac;
#else
  return Destination::Linux;
#endif
}

Env processEnv() {
  return [](std::string_view name) -> std::optional<std::string> {
    const char* value = std::getenv(std::string(name).c_str());
    if (!value) return std::nullopt;
    return std::string(value);
  };
}

GameIdentity identityOf(std::string_view saveName, std::string_view runningBundleId) {
  return {saveName.empty() ? BUILD_IDENTITY.name : saveName,
          runningBundleId.empty() ? BUILD_IDENTITY.bundleId : runningBundleId};
}

bool isSafeAssetPath(std::string_view rel) {
  if (rel.empty() || hasNul(rel)) return false;
  std::size_t start = 0;
  for (;;) {
    std::size_t end = rel.find('/', start);
    std::string_view segment = rel.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
    if (!isSafeSegment(segment)) return false;
    if (end == std::string_view::npos) return true;
    start = end + 1;
  }
}

std::string assetClaim(std::string_view file, std::string_view assetRoot) {
  std::string root = absoluteClaimPath(assetRoot);
  std::string absolute = absoluteClaimPath(file);
  if (root.empty() || absolute.empty()) return std::string(file);
  if (root.back() != '/') root += '/';
  if (absolute.substr(0, root.size()) != root) return std::string(file);
  std::string_view relative = std::string_view(absolute).substr(root.size());
  return isSafeAssetPath(relative) ? "/assets/" + std::string(relative) : std::string(file);
}

std::string captureFolder(std::string_view stateRoot) {
  // "" would join to the filesystem's root and a relative root to the working folder: neither is a run's state.
  if (!isNativeRoot(stateRoot)) return {};
  return join(stateRoot, {CAPTURES_DIR}, NATIVE_SEPARATOR);
}

std::string capturePath(std::string_view stateRoot, std::uint32_t seq) {
  std::string folder = captureFolder(stateRoot);
  if (folder.empty()) return {};
  return folder + std::to_string(seq) + std::string(CAPTURE_EXTENSION);
}

std::string_view claimedFile(bool informational, std::string_view line, std::string_view saveRoot) {
  if (!informational || line.substr(0, FILEIO_PREFIX.size()) != FILEIO_PREFIX) return {};
  std::size_t end = line.find(']', FILEIO_PREFIX.size());
  if (end == std::string_view::npos) return {};
  std::string_view file = line.substr(FILEIO_PREFIX.size(), end - FILEIO_PREFIX.size());
  bool saved = !saveRoot.empty() && file.substr(0, saveRoot.size()) == saveRoot;
  return saved ? std::string_view() : file;
}

}  // namespace studio::paths
