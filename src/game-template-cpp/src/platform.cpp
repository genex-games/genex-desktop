// The per-destination layer declared in platform.h.
#include "platform.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iterator>
#include <string>
#include <vector>

#include "protocol.h"

#if defined(PLATFORM_WEB)
#include <emscripten/emscripten.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#endif

// ANGLE's EGL headers come with the store's ANGLE on every native destination, and `ready.backend`
// and the CPU-fallback notice (D17) both need them. A build without them is a lane that forgot the
// ANGLE include folder: it stops here instead of shipping a game that always reports `unknown`.
#if !defined(PLATFORM_WEB)
#if !__has_include(<EGL/egl.h>)
#error "Genex: this native build has no ANGLE EGL headers (EGL/egl.h). The studio's genex.cmake adds the toolchain's ANGLE include folder; this is a toolchain problem, not the game's code."
#endif
// Keep <windows.h> out: it clashes with raylib.h, and the query needs no native window types.
#define EGL_NO_PLATFORM_SPECIFIC_TYPES 1
#include <EGL/egl.h>
#include <EGL/eglext.h>
#endif

#if defined(__linux__) && !defined(PLATFORM_WEB) && !defined(GENEX_HEADLESS)
// raylib links GLFW 3.4 into the game but installs no GLFW header: the one init hint this file
// sets, with its values from glfw3.h (GLFW_PLATFORM and GLFW_PLATFORM_X11).
#include <stdlib.h>  // setenv, unsetenv
extern "C" void glfwInitHint(int hint, int value);
#define GENEX_GLFW_LINUX_WINDOW 1
#endif

namespace studio::platform {

namespace {

#if defined(GENEX_GLFW_LINUX_WINDOW)
/** glfw3.h's GLFW_PLATFORM init hint and its GLFW_PLATFORM_X11 value. */
constexpr int GLFW_PLATFORM_HINT = 0x00050003;
constexpr int GLFW_PLATFORM_X11_VALUE = 0x00060004;
#endif

#if !defined(GENEX_HEADLESS)

/** raylib counts wheel notches, up positive; the studio counts DOM pixels, down positive (a notch is about 100). */
constexpr float WHEEL_PIXELS_PER_NOTCH = 100.0f;

/** One raylib key and the DOM `code` name the studio calls it by. */
struct KeyName {
  int key;
  std::string code;
};

/** Every key the runtime reports, raylib's code first. */
const std::vector<KeyName>& keyTable() {
  static const std::vector<KeyName> table = [] {
    std::vector<KeyName> keys;
    for (int k = KEY_A; k <= KEY_Z; ++k) keys.push_back({k, std::string("Key") + static_cast<char>('A' + (k - KEY_A))});
    for (int k = KEY_ZERO; k <= KEY_NINE; ++k) {
      keys.push_back({k, std::string("Digit") + static_cast<char>('0' + (k - KEY_ZERO))});
    }
    for (int k = KEY_F1; k <= KEY_F12; ++k) keys.push_back({k, "F" + std::to_string(k - KEY_F1 + 1)});
    for (int k = KEY_KP_0; k <= KEY_KP_9; ++k) keys.push_back({k, "Numpad" + std::to_string(k - KEY_KP_0)});
    const KeyName named[] = {
        {KEY_SPACE, "Space"},           {KEY_ESCAPE, "Escape"},          {KEY_ENTER, "Enter"},
        {KEY_TAB, "Tab"},               {KEY_BACKSPACE, "Backspace"},    {KEY_INSERT, "Insert"},
        {KEY_DELETE, "Delete"},         {KEY_RIGHT, "ArrowRight"},       {KEY_LEFT, "ArrowLeft"},
        {KEY_DOWN, "ArrowDown"},        {KEY_UP, "ArrowUp"},             {KEY_PAGE_UP, "PageUp"},
        {KEY_PAGE_DOWN, "PageDown"},    {KEY_HOME, "Home"},              {KEY_END, "End"},
        {KEY_CAPS_LOCK, "CapsLock"},    {KEY_SCROLL_LOCK, "ScrollLock"}, {KEY_NUM_LOCK, "NumLock"},
        {KEY_PRINT_SCREEN, "PrintScreen"}, {KEY_PAUSE, "Pause"},         {KEY_LEFT_SHIFT, "ShiftLeft"},
        {KEY_LEFT_CONTROL, "ControlLeft"}, {KEY_LEFT_ALT, "AltLeft"},    {KEY_LEFT_SUPER, "MetaLeft"},
        {KEY_RIGHT_SHIFT, "ShiftRight"}, {KEY_RIGHT_CONTROL, "ControlRight"}, {KEY_RIGHT_ALT, "AltRight"},
        {KEY_RIGHT_SUPER, "MetaRight"}, {KEY_KB_MENU, "ContextMenu"},    {KEY_APOSTROPHE, "Quote"},
        {KEY_COMMA, "Comma"},           {KEY_MINUS, "Minus"},            {KEY_PERIOD, "Period"},
        {KEY_SLASH, "Slash"},           {KEY_SEMICOLON, "Semicolon"},    {KEY_EQUAL, "Equal"},
        {KEY_LEFT_BRACKET, "BracketLeft"}, {KEY_BACKSLASH, "Backslash"}, {KEY_RIGHT_BRACKET, "BracketRight"},
        {KEY_GRAVE, "Backquote"},       {KEY_KP_DECIMAL, "NumpadDecimal"}, {KEY_KP_DIVIDE, "NumpadDivide"},
        {KEY_KP_MULTIPLY, "NumpadMultiply"}, {KEY_KP_SUBTRACT, "NumpadSubtract"}, {KEY_KP_ADD, "NumpadAdd"},
        {KEY_KP_ENTER, "NumpadEnter"},  {KEY_KP_EQUAL, "NumpadEqual"},
    };
    keys.insert(keys.end(), std::begin(named), std::end(named));
    return keys;
  }();
  return table;
}

/** raylib's mouse buttons and the studio's names for them (DOM order: left is Mouse1). */
constexpr struct {
  int button;
  const char* code;
} MOUSE_BUTTONS[] = {{MOUSE_BUTTON_LEFT, "Mouse1"}, {MOUSE_BUTTON_RIGHT, "Mouse2"}, {MOUSE_BUTTON_MIDDLE, "Mouse3"}};

/** raylib's gamepad buttons in the standard mapping's order (index = PadButton). */
constexpr int STANDARD_BUTTONS[PAD_BUTTONS] = {
    GAMEPAD_BUTTON_RIGHT_FACE_DOWN,  GAMEPAD_BUTTON_RIGHT_FACE_RIGHT, GAMEPAD_BUTTON_RIGHT_FACE_LEFT,
    GAMEPAD_BUTTON_RIGHT_FACE_UP,    GAMEPAD_BUTTON_LEFT_TRIGGER_1,   GAMEPAD_BUTTON_RIGHT_TRIGGER_1,
    GAMEPAD_BUTTON_LEFT_TRIGGER_2,   GAMEPAD_BUTTON_RIGHT_TRIGGER_2,  GAMEPAD_BUTTON_MIDDLE_LEFT,
    GAMEPAD_BUTTON_MIDDLE_RIGHT,     GAMEPAD_BUTTON_LEFT_THUMB,       GAMEPAD_BUTTON_RIGHT_THUMB,
    GAMEPAD_BUTTON_LEFT_FACE_UP,     GAMEPAD_BUTTON_LEFT_FACE_DOWN,   GAMEPAD_BUTTON_LEFT_FACE_LEFT,
    GAMEPAD_BUTTON_LEFT_FACE_RIGHT,  GAMEPAD_BUTTON_MIDDLE,
};

float fraction(float value, float origin, float extent) {
  if (!(extent > 0)) return 0.5f;
  return std::clamp((value - origin) / extent, 0.0f, 1.0f);
}

void sampleKeys(FrameSample& sample) {
  for (const KeyName& name : keyTable()) {
    if (IsKeyDown(name.key)) {
      sample.held.push_back(name.code);
    } else if (IsKeyPressed(name.key)) {  // pressed and released inside one frame
      sample.pressed.push_back(name.code);
      sample.released.push_back(name.code);
    }
  }
  for (const auto& mouse : MOUSE_BUTTONS) {
    if (IsMouseButtonDown(mouse.button)) {
      sample.held.push_back(mouse.code);
    } else if (IsMouseButtonPressed(mouse.button)) {
      sample.pressed.push_back(mouse.code);
      sample.released.push_back(mouse.code);
    }
  }
}

/**
 * How many axes of a pad raylib reads. The web backend never reads analog triggers, and a pad's
 * axes 4 and 5 there are whatever a non-standard mapping puts in them, so the web counts the
 * standard mapping's four and its triggers are their buttons.
 */
int padAxisCount(int gamepad) {
#if defined(PLATFORM_WEB)
  (void)gamepad;
  return PAD_AXES;
#else
  return GetGamepadAxisCount(gamepad);
#endif
}

/** A trigger as the standard mapping reads it (0..1) from raylib's button and axis. */
float sampleTrigger(int gamepad, int button, int axis) {
  return triggerValue(IsGamepadButtonDown(gamepad, button), padAxisCount(gamepad), axis,
                      GetGamepadAxisMovement(gamepad, axis));
}

PadState samplePad(int gamepad) {
  PadState pad;
  pad.connected = true;
  for (int i = 0; i < PAD_BUTTONS; ++i) {
    pad.buttons[static_cast<std::size_t>(i)] = IsGamepadButtonDown(gamepad, STANDARD_BUTTONS[i]) ? 1.0f : 0.0f;
  }
  pad.buttons[PadButton::LeftTrigger] =
      sampleTrigger(gamepad, GAMEPAD_BUTTON_LEFT_TRIGGER_2, GAMEPAD_AXIS_LEFT_TRIGGER);
  pad.buttons[PadButton::RightTrigger] =
      sampleTrigger(gamepad, GAMEPAD_BUTTON_RIGHT_TRIGGER_2, GAMEPAD_AXIS_RIGHT_TRIGGER);
  pad.axes[PadAxis::LeftX] = GetGamepadAxisMovement(gamepad, GAMEPAD_AXIS_LEFT_X);
  pad.axes[PadAxis::LeftY] = GetGamepadAxisMovement(gamepad, GAMEPAD_AXIS_LEFT_Y);
  pad.axes[PadAxis::RightX] = GetGamepadAxisMovement(gamepad, GAMEPAD_AXIS_RIGHT_X);
  pad.axes[PadAxis::RightY] = GetGamepadAxisMovement(gamepad, GAMEPAD_AXIS_RIGHT_Y);
  return pad;
}

/**
 * Whether the pointer is locked to the game. On the web it is the browser's own lock: raylib's
 * DisableCursor there only asks for it, and IsCursorHidden follows HideCursor alone. raylib 6.0
 * has no getter for its desktop lock, whose DisableCursor hides the cursor and EnableCursor
 * shows it; a cursor only hidden with HideCursor reads as locked too.
 */
bool pointerLocked() {
#if defined(PLATFORM_WEB)
  return EM_ASM_INT({
           var locked = document.pointerLockElement;
           return locked && locked === Module['canvas'] ? 1 : 0;
         }) != 0;
#else
  return IsCursorHidden();
#endif
}

#endif  // !GENEX_HEADLESS

paths::Env& environment() {
  static paths::Env env = paths::processEnv();
  return env;
}

#if defined(PLATFORM_WEB)
/** The largest canvas side the web shell may ask for, in device pixels. */
constexpr int MAX_CANVAS_PX = 8192;
int slotWidth = 0;
int slotHeight = 0;
#else
/** Where a Mac bundle's executable sits; its assets are in ../Resources/assets beside it. */
constexpr std::string_view BUNDLE_EXECUTABLE_DIR = "Contents/MacOS/";
bool quitRequested = false;
#endif

}  // namespace

#if defined(PLATFORM_WEB)

// The shell sizes the canvas to its slot in device pixels; raylib's own resize would use CSS pixels.
unsigned int windowFlags() { return 0; }

void chooseWindowSystem() {}

Vector2 initialScreenSize(Vector2 worldSize) {
  if (slotWidth > 0 && slotHeight > 0) return {static_cast<float>(slotWidth), static_cast<float>(slotHeight)};
  return worldSize;
}

void run(void (*frame)()) { emscripten_set_main_loop(frame, 0, true); }

// The EM_ASM blocks below name the mount point themselves.
static_assert(paths::WEB_SAVE_ROOT == "/save/");

void prepareSaves() {
  // Saves persist in IndexedDB when the build links IDBFS (-lidbfs.js); without it they last as
  // long as the page. Emscripten then still defines an IDBFS that throws when used, and a throw
  // here must not stop the game, so every step is caught. The first reset waits for the read-back
  // (savesReady), so a game that loads its progress in reset() finds it; a folder made before the
  // mount is kept, never a reason to stop persisting.
  EM_ASM({
    Module['genexSavesReady'] = false;
    Module['genexSavesPersist'] = false;
    try {
      if (!FS.analyzePath('/save').exists) FS.mkdir('/save');
      FS.mount(IDBFS, {}, '/save');
      FS.syncfs(true, function(error) {
        Module['genexSavesPersist'] = !error;
        Module['genexSavesReady'] = true;
      });
    } catch (e) {
      Module['genexSavesReady'] = true;
    }
  });
}

bool savesReady() {
  return EM_ASM_INT({ return Module['genexSavesReady'] ? 1 : 0; }) != 0;
}

void announceReady() {
  EM_ASM({
    if (typeof Module['genexReady'] === 'function') Module['genexReady']();
  });
}

void requestQuit() {}

bool presentsEveryFrame() { return false; }

bool followSlot() {
  bool changed = slotWidth > 0 && slotHeight > 0 && IsWindowReady() &&
                 (GetScreenWidth() != slotWidth || GetScreenHeight() != slotHeight);
  if (changed) SetWindowSize(slotWidth, slotHeight);
  return changed;
}

#else

#if defined(GENEX_HEADLESS)
// The headless platform has no window to configure: its pbuffer is the screen size InitWindow gets.
unsigned int windowFlags() { return 0; }
#else
unsigned int windowFlags() { return FLAG_WINDOW_RESIZABLE | FLAG_WINDOW_HIGHDPI | FLAG_VSYNC_HINT; }
#endif

void chooseWindowSystem() {
#if defined(GENEX_GLFW_LINUX_WINDOW)
  if (!paths::prefersX11(environment())) return;
  // Before InitWindow, whose glfwInit reads the hint. ANGLE picks its own window system for the
  // display GLFW opens (it has no EGL_EXT_platform_x11, and asking it for Vulkan by name breaks
  // GLFW's X11 surface): it reads XDG_SESSION_TYPE, so this process says X11 there too.
  glfwInitHint(GLFW_PLATFORM_HINT, GLFW_PLATFORM_X11_VALUE);
  ::setenv("XDG_SESSION_TYPE", "x11", 1);
  ::unsetenv("WAYLAND_DISPLAY");
#endif
}

Vector2 initialScreenSize(Vector2 worldSize) { return worldSize; }

void run(void (*frame)()) {
  while (!WindowShouldClose() && !quitRequested) frame();
}

void prepareSaves() {}

bool savesReady() { return true; }

void announceReady() {}

void requestQuit() { quitRequested = true; }

bool presentsEveryFrame() { return true; }

bool followSlot() { return false; }

#endif

#if defined(GENEX_HEADLESS)

// Nothing reaches a headless game but the studio's own `input` op.
FrameSample sampleInput(Rectangle) { return FrameSample{}; }

#else

FrameSample sampleInput(Rectangle view) {
  FrameSample sample;
  sampleKeys(sample);
  Vector2 look = GetMouseDelta();
  Vector2 wheel = GetMouseWheelMoveV();
  Vector2 mouse = GetMousePosition();
  sample.look = {look.x, look.y};
  sample.wheel = {wheel.x * WHEEL_PIXELS_PER_NOTCH, -wheel.y * WHEEL_PIXELS_PER_NOTCH};
  sample.pointer = {fraction(mouse.x, view.x, view.width), fraction(mouse.y, view.y, view.height)};
  sample.pointerLock = pointerLocked();
  for (int i = 0; i < MAX_PADS; ++i) {
    if (IsGamepadAvailable(i)) sample.pads[static_cast<std::size_t>(i)] = samplePad(i);
  }
  for (int codepoint = GetCharPressed(); codepoint > 0; codepoint = GetCharPressed()) {
    int size = 0;
    const char* utf8 = CodepointToUTF8(codepoint, &size);
    appendText(sample.text, std::string_view(utf8, static_cast<std::size_t>(size)));
  }
  return sample;
}

#endif

std::string shaderSource(std::string_view code) {
  std::string body(code);
  std::size_t first = body.find_first_not_of(" \t\r\n");
  if (first != std::string::npos && body.compare(first, 8, "#version") == 0) {
    std::size_t end = body.find('\n', first);
    body.erase(0, end == std::string::npos ? body.size() : end + 1);
    TraceLog(LOG_WARNING, "SHADER: removed the source's own #version line; the runtime adds #version 300 es");
  }
  return std::string(SHADER_HEADER) + body;
}

Shader loadShader(const char* vertex, const char* fragment) {
  std::string vs = vertex ? shaderSource(vertex) : std::string();
  std::string fs = fragment ? shaderSource(fragment) : std::string();
  return LoadShaderFromMemory(vertex ? vs.c_str() : nullptr, fragment ? fs.c_str() : nullptr);
}

std::string assetRoot() {
#if defined(PLATFORM_WEB)
  return "/assets/";
#else
  std::string dir = GetApplicationDirectory();
  bool inBundle = dir.size() >= BUNDLE_EXECUTABLE_DIR.size() &&
                  dir.compare(dir.size() - BUNDLE_EXECUTABLE_DIR.size(), BUNDLE_EXECUTABLE_DIR.size(),
                              BUNDLE_EXECUTABLE_DIR) == 0;
  return dir + (inBundle ? "../Resources/assets/" : "assets/");
#endif
}

std::string assetPath(std::string_view rel) {
  return paths::isSafeAssetPath(rel) ? assetRoot() + std::string(rel) : std::string();
}

paths::Destination destination() { return paths::destinationOf(environment()); }

std::string_view runningBundleId() {
#if defined(__APPLE__) && !defined(PLATFORM_WEB)
  static const std::string id = [] {
    CFBundleRef bundle = CFBundleGetMainBundle();
    CFStringRef value = bundle ? CFBundleGetIdentifier(bundle) : nullptr;
    char text[paths::MAX_BUNDLE_ID_LENGTH + 1] = {};
    bool read = value && CFStringGetCString(value, text, sizeof text, kCFStringEncodingUTF8);
    return read ? std::string(text) : std::string();
  }();
  return id;
#else
  return {};
#endif
}

paths::SaveRoot saveRoot(paths::GameIdentity game) { return paths::saveRoot(destination(), environment(), game); }

bool saveFile(paths::GameIdentity game, std::string_view file, const void* data, int size) {
  paths::SaveRoot root = saveRoot(game);
  if (!root.ok() || !paths::isSafeAssetPath(file) || size < 0) return false;
  std::string path = root.path + std::string(file);
  std::string folder = path.substr(0, path.find_last_of("/\\"));
  if (MakeDirectory(folder.c_str()) != 0) return false;
  bool saved = SaveFileData(path.c_str(), const_cast<void*>(data), size);
#if defined(PLATFORM_WEB)
  EM_ASM({
    if (Module['genexSavesPersist']) FS.syncfs(false, function() {});
  });
#endif
  return saved;
}

std::optional<std::string> loadFile(paths::GameIdentity game, std::string_view file) {
  paths::SaveRoot root = saveRoot(game);
  if (!root.ok() || !paths::isSafeAssetPath(file)) return std::nullopt;
  std::string path = root.path + std::string(file);
  if (!FileExists(path.c_str())) return std::nullopt;
  int size = 0;
  unsigned char* data = LoadFileData(path.c_str(), &size);
  if (!data) return std::nullopt;
  std::string bytes(reinterpret_cast<const char*>(data), static_cast<std::size_t>(size));
  UnloadFileData(data);
  return bytes;
}

// ── the window, as the studio's ops see it ──

#if defined(PLATFORM_WEB)

bool hasWindow() { return false; }
bool canPresent() { return true; }
bool focused() { return true; }
bool front() { return false; }
bool setVisible(bool) { return false; }
void pace(double, const std::function<void(double ms)>&) {}

#else

namespace {

/** The frame a loop nothing else paces is held to, in milliseconds (60 Hz). */
constexpr double PACED_FRAME_MS = 1000.0 / 60.0;

/** Whether this build has no window at all. */
constexpr bool HEADLESS =
#if defined(GENEX_HEADLESS)
    true;
#else
    false;
#endif

/** Whether the window is out of sight: hidden or minimized, so its swap may block rather than pace. */
bool outOfSight() { return IsWindowHidden() || IsWindowMinimized(); }

}  // namespace

bool hasWindow() { return !HEADLESS; }

// The headless pbuffer's swap is a flush: it always presents, as measured.
bool canPresent() { return HEADLESS || !outOfSight(); }

bool focused() { return HEADLESS || IsWindowFocused(); }

bool front() {
  if (HEADLESS) return false;
  SetWindowFocused();
  return true;
}

bool setVisible(bool visible) {
  if (HEADLESS) return false;
  if (visible) {
    ClearWindowState(FLAG_WINDOW_HIDDEN);
  } else {
    SetWindowState(FLAG_WINDOW_HIDDEN);
  }
  return !IsWindowHidden();
}

void pace(double frameStartMs, const std::function<void(double ms)>& wait) {
  bool unpaced = HEADLESS || outOfSight();
  if (!unpaced) return;
  double remaining = PACED_FRAME_MS - (GetTime() * 1000.0 - frameStartMs);
  if (!(remaining > 0)) return;
  if (wait) {
    wait(remaining);
  } else {
    WaitTime(remaining / 1000.0);
  }
}

#endif

// ── the graphics backend ──

namespace {

#if !defined(PLATFORM_WEB)

GraphicsBackend unknownBackend() { return GraphicsBackend{protocol::Backend::Unknown, {}, false}; }

/** The longest device name kept (the host refuses a longer `ready` field). */
constexpr std::size_t MAX_DEVICE_NAME = 200;

/** Whether `token` is one of the space-separated names in `list`. */
bool listed(std::string_view list, std::string_view token) {
  std::size_t start = 0;
  while (start <= list.size()) {
    std::size_t end = list.find(' ', start);
    if (end == std::string_view::npos) end = list.size();
    if (list.substr(start, end - start) == token) return true;
    start = end + 1;
  }
  return false;
}

/** The device extensions ANGLE answers with, one per backend it can run on. */
constexpr std::string_view DEVICE_QUERY = "EGL_EXT_device_query";
constexpr std::string_view METAL_DEVICE = "EGL_ANGLE_device_metal";
constexpr std::string_view VULKAN_DEVICE = "EGL_ANGLE_device_vulkan";
constexpr std::string_view D3D_DEVICE = "EGL_ANGLE_device_d3d";

// The two Vulkan entry points the CPU check calls, through ANGLE's own vkGetInstanceProcAddr, and
// the leading fields of VkPhysicalDeviceProperties (Vulkan 1.0 ABI), so no Vulkan header is needed.
using VulkanFunction = void (*)();
using VulkanInstanceProcAddr = VulkanFunction (*)(void* instance, const char* name);
using VulkanDeviceProperties = void (*)(void* physicalDevice, void* properties);
struct VulkanPropertiesHead {
  std::uint32_t apiVersion;
  std::uint32_t driverVersion;
  std::uint32_t vendorId;
  std::uint32_t deviceId;
  std::int32_t deviceType;
  char deviceName[256];
};
/** Room for the whole VkPhysicalDeviceProperties (824 bytes on 64-bit), with margin. */
constexpr std::size_t VULKAN_PROPERTIES_BYTES = 2048;
/** VK_PHYSICAL_DEVICE_TYPE_CPU: SwiftShader and other software devices. */
constexpr std::int32_t VULKAN_CPU_DEVICE = 4;

std::string deviceName(const char* text) {
  std::string name = text ? std::string(text) : std::string();
  return name.substr(0, MAX_DEVICE_NAME);
}

/** The Vulkan device ANGLE draws on: its name, and whether it is a CPU. */
GraphicsBackend vulkanBackend(PFNEGLQUERYDEVICEATTRIBEXTPROC deviceAttrib, EGLDeviceEXT device) {
  GraphicsBackend backend{protocol::Backend::VulkanAngle, {}, false};
  EGLAttrib instance = 0;
  EGLAttrib physical = 0;
  EGLAttrib procAddr = 0;
  bool answered = deviceAttrib(device, EGL_VULKAN_INSTANCE_ANGLE, &instance) &&
                  deviceAttrib(device, EGL_VULKAN_PHYSICAL_DEVICE_ANGLE, &physical) &&
                  deviceAttrib(device, EGL_VULKAN_GET_INSTANCE_PROC_ADDR, &procAddr);
  bool reachable = answered && instance != 0 && physical != 0 && procAddr != 0;
  if (!reachable) return backend;
  auto lookup = reinterpret_cast<VulkanInstanceProcAddr>(procAddr);
  VulkanFunction found = lookup(reinterpret_cast<void*>(instance), "vkGetPhysicalDeviceProperties");
  auto properties = reinterpret_cast<VulkanDeviceProperties>(found);
  if (!properties) return backend;
  alignas(8) unsigned char buffer[VULKAN_PROPERTIES_BYTES] = {};
  properties(reinterpret_cast<void*>(physical), buffer);
  VulkanPropertiesHead head{};
  std::memcpy(&head, buffer, sizeof head);
  head.deviceName[sizeof head.deviceName - 1] = '\0';
  backend.device = deviceName(head.deviceName);
  backend.software = head.deviceType == VULKAN_CPU_DEVICE;
  return backend;
}

/** A MTLDevice's name, through the Objective-C runtime the Metal backend has already loaded. */
std::string metalName(EGLAttrib device) {
#if defined(__APPLE__)
  using Selector = void*;
  void* send = dlsym(RTLD_DEFAULT, "objc_msgSend");
  auto selector = reinterpret_cast<Selector (*)(const char*)>(dlsym(RTLD_DEFAULT, "sel_registerName"));
  if (!send || !selector || device == 0) return {};
  auto sendForObject = reinterpret_cast<void* (*)(void*, Selector)>(send);
  auto sendForText = reinterpret_cast<const char* (*)(void*, Selector)>(send);
  void* name = sendForObject(reinterpret_cast<void*>(device), selector("name"));
  return deviceName(name ? sendForText(name, selector("UTF8String")) : nullptr);
#else
  (void)device;
  return {};
#endif
}

/** The EXT_device_query entry points, or null ones when ANGLE does not offer them. */
struct DeviceQuery {
  PFNEGLQUERYDISPLAYATTRIBEXTPROC displayAttrib = nullptr;
  PFNEGLQUERYDEVICESTRINGEXTPROC deviceString = nullptr;
  PFNEGLQUERYDEVICEATTRIBEXTPROC deviceAttrib = nullptr;
  bool ok() const { return displayAttrib && deviceString && deviceAttrib; }
};

/** An EGL extension entry point, typed. */
template <typename Function>
Function entryPoint(const char* name) {
  return reinterpret_cast<Function>(eglGetProcAddress(name));
}

DeviceQuery deviceQuery() {
  const char* client = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
  if (!client || !listed(client, DEVICE_QUERY)) return {};
  DeviceQuery query;
  query.displayAttrib = entryPoint<PFNEGLQUERYDISPLAYATTRIBEXTPROC>("eglQueryDisplayAttribEXT");
  query.deviceString = entryPoint<PFNEGLQUERYDEVICESTRINGEXTPROC>("eglQueryDeviceStringEXT");
  query.deviceAttrib = entryPoint<PFNEGLQUERYDEVICEATTRIBEXTPROC>("eglQueryDeviceAttribEXT");
  return query;
}

/** The backend's own device behind `device` when ANGLE lists `extension` and answers `attribute`, else 0. */
EGLAttrib nativeDevice(const DeviceQuery& query, EGLDeviceEXT device, std::string_view extensions,
                       std::string_view extension, EGLint attribute) {
  EGLAttrib native = 0;
  if (!listed(extensions, extension) || !query.deviceAttrib(device, attribute, &native)) return 0;
  return native;
}

GraphicsBackend queryBackend() {
  EGLDisplay display = eglGetCurrentDisplay();
  DeviceQuery query = display == EGL_NO_DISPLAY ? DeviceQuery{} : deviceQuery();
  EGLAttrib deviceValue = 0;
  bool found = query.ok() && query.displayAttrib(display, EGL_DEVICE_EXT, &deviceValue) && deviceValue != 0;
  if (!found) return unknownBackend();
  auto device = reinterpret_cast<EGLDeviceEXT>(deviceValue);
  const char* extensions = query.deviceString(device, EGL_EXTENSIONS);
  std::string_view names = extensions ? extensions : "";
  EGLAttrib metal = nativeDevice(query, device, names, METAL_DEVICE, EGL_METAL_DEVICE_ANGLE);
  if (metal != 0) {
    return GraphicsBackend{protocol::Backend::MetalAngle, metalName(metal), false};  // Metal has no software device
  }
  if (listed(names, VULKAN_DEVICE)) return vulkanBackend(query.deviceAttrib, device);
  if (nativeDevice(query, device, names, D3D_DEVICE, EGL_D3D11_DEVICE_ANGLE) != 0) {
    // Naming the adapter (and spotting WARP) needs DXGI, whose headers clash with raylib.h here.
    return GraphicsBackend{protocol::Backend::D3d11Angle, {}, false};
  }
  return unknownBackend();
}

#endif

/** The OS part of buildName(). */
constexpr std::string_view BUILD_OS =
#if defined(PLATFORM_WEB)
    "web";
#elif defined(__APPLE__)
    "macos";
#elif defined(_WIN32)
    "windows";
#else
    "linux";
#endif

/** The mode part of buildName(). */
constexpr std::string_view BUILD_MODE =
#if defined(PLATFORM_WEB)
    "page";
#elif defined(GENEX_HEADLESS)
    "headless";
#else
    "window";
#endif

}  // namespace

GraphicsBackend graphicsBackend() {
#if defined(PLATFORM_WEB)
  return GraphicsBackend{protocol::Backend::WebGl2, {}, false};
#else
  return queryBackend();
#endif
}

std::string buildName() {
#if defined(GENEX_BUILD_ID)
  return GENEX_BUILD_ID;
#else
  return "raylib-" + std::string(RAYLIB_VERSION) + "/" + std::string(BUILD_OS) + "/" + std::string(BUILD_MODE);
#endif
}

}  // namespace studio::platform

#if defined(PLATFORM_WEB)
/** The web shell's ResizeObserver reports the slot's size in device pixels; the next frame applies it. */
extern "C" EMSCRIPTEN_KEEPALIVE void studio_resize(int width, int height) {
  studio::platform::slotWidth = std::clamp(width, 1, studio::platform::MAX_CANVAS_PX);
  studio::platform::slotHeight = std::clamp(height, 1, studio::platform::MAX_CANVAS_PX);
}
#endif
