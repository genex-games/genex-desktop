// A scripted stand-in for raylib 6.0 and the slice of ANGLE's EGL the runtime asks about, so the
// template's raylib-including sources (studio.cpp, platform.cpp, hud.cpp) build and run with any
// C++ compiler and no GPU. The runner puts it on the include path as raylib.h, EGL/egl.h and
// EGL/eglext.h; tests/cpp/capture_test.cpp picks a scenario through stub::configure().
//
// What it fakes, and how:
// - Time: GetTime() is a clock that advances exactly one 60 Hz frame per WindowShouldClose(), so
//   frame timings are exact, whatever the machine.
// - The window: InitWindow() succeeds (or not, by scenario); IsWindowFocused() plays a script, one
//   value per frame; SetWindowFocused(), the hidden flag and every present (EndDrawing) are
//   recorded.
// - Pixels: LoadImageFromTexture() returns a scripted RGBA image, bottom-up as glReadPixels
//   returns a render texture's rows.
// - Text: every DrawText() since the last BeginTextureMode() is kept, with MeasureText()'s width.
// - Audio: the attached mixed processor is fed one block of the scenario's signal per frame.
// - EGL: no device, or an ANGLE Vulkan device whose physical device is a CPU (SwiftShader) or a
//   discrete GPU.
// Other drawing, input and files do nothing; nothing here reads or writes outside the process.
#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

// ── raylib types (the members the runtime touches, in raylib's order) ──

#define RAYLIB_VERSION "6.0"

struct Vector2 {
  float x;
  float y;
};
struct Vector3 {
  float x;
  float y;
  float z;
};
struct Matrix {
  float m0, m4, m8, m12, m1, m5, m9, m13, m2, m6, m10, m14, m3, m7, m11, m15;
};
struct Color {
  unsigned char r;
  unsigned char g;
  unsigned char b;
  unsigned char a;
};
struct Rectangle {
  float x;
  float y;
  float width;
  float height;
};
struct Image {
  void* data;
  int width;
  int height;
  int mipmaps;
  int format;
};
struct Texture {
  unsigned int id;
  int width;
  int height;
  int mipmaps;
  int format;
};
using Texture2D = Texture;
struct RenderTexture {
  unsigned int id;
  Texture texture;
  Texture depth;
};
using RenderTexture2D = RenderTexture;
struct Camera3D {
  Vector3 position;
  Vector3 target;
  Vector3 up;
  float fovy;
  int projection;
};
struct Mesh {
  int vertexCount;
  int triangleCount;
};
struct Shader {
  unsigned int id;
  int* locs;
};
struct MaterialMap {
  Texture2D texture;
  Color color;
  float value;
};
struct Material {
  Shader shader;
  MaterialMap* maps;
  float params[4];
};
struct Model {
  Matrix transform;
  int meshCount;
  int materialCount;
  Mesh* meshes;
  Material* materials;
  int* meshMaterial;
};
struct Sound {
  void* stream;
  unsigned int frameCount;
};

using TraceLogCallback = void (*)(int logLevel, const char* text, va_list args);
using AudioCallback = void (*)(void* bufferData, unsigned int frames);

enum TraceLogLevel { LOG_ALL = 0, LOG_TRACE, LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERROR, LOG_FATAL, LOG_NONE };

enum ConfigFlags : unsigned int {
  FLAG_VSYNC_HINT = 0x00000040,
  FLAG_WINDOW_RESIZABLE = 0x00000004,
  FLAG_WINDOW_HIDDEN = 0x00000080,
  FLAG_WINDOW_MINIMIZED = 0x00000200,
  FLAG_WINDOW_UNFOCUSED = 0x00000800,
  FLAG_WINDOW_HIGHDPI = 0x00002000,
  FLAG_MSAA_4X_HINT = 0x00000020,
};

enum KeyboardKey {
  KEY_NULL = 0,
  KEY_APOSTROPHE = 39,
  KEY_COMMA = 44,
  KEY_MINUS = 45,
  KEY_PERIOD = 46,
  KEY_SLASH = 47,
  KEY_ZERO = 48,
  KEY_NINE = 57,
  KEY_SEMICOLON = 59,
  KEY_EQUAL = 61,
  KEY_A = 65,
  KEY_Z = 90,
  KEY_LEFT_BRACKET = 91,
  KEY_BACKSLASH = 92,
  KEY_RIGHT_BRACKET = 93,
  KEY_GRAVE = 96,
  KEY_SPACE = 32,
  KEY_ESCAPE = 256,
  KEY_ENTER = 257,
  KEY_TAB = 258,
  KEY_BACKSPACE = 259,
  KEY_INSERT = 260,
  KEY_DELETE = 261,
  KEY_RIGHT = 262,
  KEY_LEFT = 263,
  KEY_DOWN = 264,
  KEY_UP = 265,
  KEY_PAGE_UP = 266,
  KEY_PAGE_DOWN = 267,
  KEY_HOME = 268,
  KEY_END = 269,
  KEY_CAPS_LOCK = 280,
  KEY_SCROLL_LOCK = 281,
  KEY_NUM_LOCK = 282,
  KEY_PRINT_SCREEN = 283,
  KEY_PAUSE = 284,
  KEY_F1 = 290,
  KEY_F12 = 301,
  KEY_KP_0 = 320,
  KEY_KP_9 = 329,
  KEY_KP_DECIMAL = 330,
  KEY_KP_DIVIDE = 331,
  KEY_KP_MULTIPLY = 332,
  KEY_KP_SUBTRACT = 333,
  KEY_KP_ADD = 334,
  KEY_KP_ENTER = 335,
  KEY_KP_EQUAL = 336,
  KEY_LEFT_SHIFT = 340,
  KEY_LEFT_CONTROL = 341,
  KEY_LEFT_ALT = 342,
  KEY_LEFT_SUPER = 343,
  KEY_RIGHT_SHIFT = 344,
  KEY_RIGHT_CONTROL = 345,
  KEY_RIGHT_ALT = 346,
  KEY_RIGHT_SUPER = 347,
  KEY_KB_MENU = 348,
};

enum MouseButton { MOUSE_BUTTON_LEFT = 0, MOUSE_BUTTON_RIGHT = 1, MOUSE_BUTTON_MIDDLE = 2 };

enum GamepadButton {
  GAMEPAD_BUTTON_UNKNOWN = 0,
  GAMEPAD_BUTTON_LEFT_FACE_UP,
  GAMEPAD_BUTTON_LEFT_FACE_RIGHT,
  GAMEPAD_BUTTON_LEFT_FACE_DOWN,
  GAMEPAD_BUTTON_LEFT_FACE_LEFT,
  GAMEPAD_BUTTON_RIGHT_FACE_UP,
  GAMEPAD_BUTTON_RIGHT_FACE_RIGHT,
  GAMEPAD_BUTTON_RIGHT_FACE_DOWN,
  GAMEPAD_BUTTON_RIGHT_FACE_LEFT,
  GAMEPAD_BUTTON_LEFT_TRIGGER_1,
  GAMEPAD_BUTTON_LEFT_TRIGGER_2,
  GAMEPAD_BUTTON_RIGHT_TRIGGER_1,
  GAMEPAD_BUTTON_RIGHT_TRIGGER_2,
  GAMEPAD_BUTTON_MIDDLE_LEFT,
  GAMEPAD_BUTTON_MIDDLE,
  GAMEPAD_BUTTON_MIDDLE_RIGHT,
  GAMEPAD_BUTTON_LEFT_THUMB,
  GAMEPAD_BUTTON_RIGHT_THUMB,
};

enum GamepadAxis {
  GAMEPAD_AXIS_LEFT_X = 0,
  GAMEPAD_AXIS_LEFT_Y = 1,
  GAMEPAD_AXIS_RIGHT_X = 2,
  GAMEPAD_AXIS_RIGHT_Y = 3,
  GAMEPAD_AXIS_LEFT_TRIGGER = 4,
  GAMEPAD_AXIS_RIGHT_TRIGGER = 5,
};

enum PixelFormat { PIXELFORMAT_UNCOMPRESSED_GRAYSCALE = 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8 = 7 };
enum TextureFilter { TEXTURE_FILTER_POINT = 0, TEXTURE_FILTER_BILINEAR, TEXTURE_FILTER_TRILINEAR };
enum CameraProjection { CAMERA_PERSPECTIVE = 0, CAMERA_ORTHOGRAPHIC };
enum MaterialMapIndex { MATERIAL_MAP_ALBEDO = 0 };
#define MATERIAL_MAP_DIFFUSE MATERIAL_MAP_ALBEDO

#define WHITE Color{255, 255, 255, 255}
#define BLACK Color{0, 0, 0, 255}
#define RAYWHITE Color{245, 245, 245, 255}
#define GOLD Color{255, 203, 0, 255}
#define MAGENTA Color{255, 0, 255, 255}

// ── EGL types and names (ANGLE's spellings; only what the backend query reads) ──

using EGLint = std::int32_t;
using EGLBoolean = unsigned int;
using EGLAttrib = std::intptr_t;
using EGLDisplay = void*;
using EGLDeviceEXT = void*;
using __eglMustCastToProperFunctionPointerType = void (*)();
#define EGLAPIENTRY
#define EGL_NO_DISPLAY (static_cast<EGLDisplay>(nullptr))
#define EGL_TRUE 1u
#define EGL_FALSE 0u
#define EGL_EXTENSIONS 0x3055
#define EGL_DEVICE_EXT 0x322C
#define EGL_D3D11_DEVICE_ANGLE 0x33A1
#define EGL_METAL_DEVICE_ANGLE 0x34A6
#define EGL_VULKAN_INSTANCE_ANGLE 0x34A9
#define EGL_VULKAN_PHYSICAL_DEVICE_ANGLE 0x34AB
#define EGL_VULKAN_GET_INSTANCE_PROC_ADDR 0x34D1
using PFNEGLQUERYDISPLAYATTRIBEXTPROC = EGLBoolean (*)(EGLDisplay dpy, EGLint attribute, EGLAttrib* value);
using PFNEGLQUERYDEVICESTRINGEXTPROC = const char* (*)(EGLDeviceEXT device, EGLint name);
using PFNEGLQUERYDEVICEATTRIBEXTPROC = EGLBoolean (*)(EGLDeviceEXT device, EGLint attribute, EGLAttrib* value);

// ── the script ──

namespace stub {

/** One 60 Hz frame, in seconds: what the clock advances per WindowShouldClose(). */
inline constexpr double FRAME_S = 1.0 / 60.0;
/** Stereo frames fed to the mixed processor per frame (raylib's mixer works in blocks too). */
inline constexpr unsigned int AUDIO_BLOCK_FRAMES = 512;
/** A full-scale square wave's half period, in frames (750 Hz at 48 kHz). */
inline constexpr unsigned int SQUARE_HALF_PERIOD = 32;
/** A full-scale sine's period, in frames: 1500 Hz at 48 kHz, exactly bin 64 of a 2048-frame window. */
inline constexpr unsigned int SINE_PERIOD = 32;
inline constexpr double TWO_PI = 6.283185307179586;
/** How long the windowed loop sleeps per frame, so a stub game never spins a core. */
inline constexpr auto IDLE = std::chrono::milliseconds(1);

/** What the mixer plays. */
enum class Signal { Silence, Square, Sine };
/** The graphics device EGL reports. */
enum class Device { None, SwiftShader, DiscreteGpu };

/** One DrawText() call, as the runtime made it. */
struct TextDraw {
  std::string text;
  int x;
  int y;
  int size;
};

struct State {
  bool windowFails = false;
  Signal signal = Signal::Silence;
  Device device = Device::None;
  /** IsWindowFocused() per frame; the last value holds once the script ends. */
  std::vector<bool> focus{true};
  /** The RGBA image LoadImageFromTexture() returns (bottom-up rows), or empty for a grey one. */
  std::vector<unsigned char> pixels;
  int pixelsWidth = 0;
  int pixelsHeight = 0;
  /** Assets exist only in the asset-claims scenario; loads record the real file path given to raylib. */
  bool assets = false;
  std::string applicationDirectory = "/nonexistent/stub/";
  std::vector<std::string> assetLoads;

  TraceLogCallback trace = nullptr;
  AudioCallback mixer = nullptr;
  bool windowReady = false;
  int screenWidth = 0;
  int screenHeight = 0;
  unsigned int flags = 0;
  int frame = 0;
  double clock = 0;
  unsigned int audioPhase = 0;
  int fronted = 0;
  /** EndDrawing() calls: frames presented to the window. */
  int presented = 0;
  /** The DrawText() calls since the last BeginTextureMode(): the last world frame's text. */
  std::vector<TextDraw> texts;
};

inline State& state() {
  static State current;
  return current;
}

inline bool focusedNow() {
  const State& s = state();
  if (s.focus.empty()) return true;
  // Frame 1 is the loop's first WindowShouldClose(); before it, the script's first value holds.
  std::size_t frame = s.frame > 0 ? static_cast<std::size_t>(s.frame - 1) : 0;
  std::size_t index = std::min(frame, s.focus.size() - 1);
  return s.focus[index];
}

inline void feedAudio() {
  State& s = state();
  if (!s.mixer) return;
  std::vector<float> block(AUDIO_BLOCK_FRAMES * 2, 0.0f);
  for (unsigned int i = 0; i < AUDIO_BLOCK_FRAMES; ++i) {
    float value = 0.0f;
    if (s.signal == Signal::Square) value = ((s.audioPhase / SQUARE_HALF_PERIOD) % 2 == 0) ? 1.0f : -1.0f;
    if (s.signal == Signal::Sine) {
      value = static_cast<float>(std::sin(TWO_PI * static_cast<double>(s.audioPhase % SINE_PERIOD) / SINE_PERIOD));
    }
    block[i * 2] = value;
    block[i * 2 + 1] = value;
    ++s.audioPhase;
  }
  s.mixer(block.data(), AUDIO_BLOCK_FRAMES);
}

// The fake Vulkan entry points ANGLE's device query hands out for the scenario's device.
inline constexpr std::int32_t VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU = 2;
inline constexpr std::int32_t VK_PHYSICAL_DEVICE_TYPE_CPU = 4;
inline constexpr const char* SWIFTSHADER_NAME = "SwiftShader Device (Subzero)";
inline constexpr const char* DISCRETE_GPU_NAME = "Stub Discrete GPU";
inline int fakeInstance = 0;
inline int fakePhysicalDevice = 0;

/** vkGetPhysicalDeviceProperties: the Vulkan 1.0 layout's leading fields, a CPU or a discrete GPU. */
inline void physicalDeviceProperties(void* device, void* properties) {
  if (device != &fakePhysicalDevice || !properties) return;
  bool cpu = state().device == Device::SwiftShader;
  std::int32_t type = cpu ? VK_PHYSICAL_DEVICE_TYPE_CPU : VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU;
  auto* bytes = static_cast<unsigned char*>(properties);
  std::uint32_t versions[4] = {(1u << 22) | (3u << 12), 1, 0x1AE0, 0xC0DE};
  std::memcpy(bytes, versions, sizeof versions);
  std::memcpy(bytes + 16, &type, sizeof type);
  std::strncpy(reinterpret_cast<char*>(bytes + 20), cpu ? SWIFTSHADER_NAME : DISCRETE_GPU_NAME, 255);
}

inline void (*instanceProcAddr(void* instance, const char* name))() {
  if (instance != &fakeInstance || !name || std::strcmp(name, "vkGetPhysicalDeviceProperties") != 0) return nullptr;
  return reinterpret_cast<void (*)()>(&physicalDeviceProperties);
}

inline int fakeDisplay = 0;
inline int fakeDevice = 0;

inline EGLBoolean queryDisplayAttrib(EGLDisplay display, EGLint attribute, EGLAttrib* value) {
  if (display != &fakeDisplay || attribute != EGL_DEVICE_EXT || !value) return EGL_FALSE;
  *value = reinterpret_cast<EGLAttrib>(&fakeDevice);
  return EGL_TRUE;
}

inline const char* queryDeviceString(EGLDeviceEXT device, EGLint name) {
  if (device != &fakeDevice || name != EGL_EXTENSIONS) return nullptr;
  return "EGL_ANGLE_device_vulkan";
}

inline EGLBoolean queryDeviceAttrib(EGLDeviceEXT device, EGLint attribute, EGLAttrib* value) {
  if (device != &fakeDevice || !value) return EGL_FALSE;
  switch (attribute) {
    case EGL_VULKAN_INSTANCE_ANGLE:
      *value = reinterpret_cast<EGLAttrib>(&fakeInstance);
      return EGL_TRUE;
    case EGL_VULKAN_PHYSICAL_DEVICE_ANGLE:
      *value = reinterpret_cast<EGLAttrib>(&fakePhysicalDevice);
      return EGL_TRUE;
    case EGL_VULKAN_GET_INSTANCE_PROC_ADDR:
      *value = reinterpret_cast<EGLAttrib>(&instanceProcAddr);
      return EGL_TRUE;
    default:
      return EGL_FALSE;
  }
}

/** Pick a scenario: `basic`, `nowindow`, `capture`, `focus`, `square`, `sine`, `cpu`, `gpu`. */
inline void configure(const std::string& scenario) {
  State& s = state();
  if (scenario == "nowindow") s.windowFails = true;
  if (scenario == "square") s.signal = Signal::Square;
  if (scenario == "sine") s.signal = Signal::Sine;
  if (scenario == "cpu") s.device = Device::SwiftShader;
  if (scenario == "gpu") s.device = Device::DiscreteGpu;
  if (scenario == "focus") s.focus = {false, false, true, true, false};
  if (scenario == "assets") {
    s.assets = true;
    const char* application = std::getenv("GENEX_STUB_APPLICATION_DIR");
    if (application) s.applicationDirectory = application;
  }
  if (scenario == "capture") {
    // 3x2 RGBA, bottom row first: the bottom row is red, green, blue; the top row is white, an
    // opaque grey and a half-transparent orange, which the runtime composites over black.
    s.pixels = {255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 10, 20, 30, 255, 200, 100, 50, 128};
    s.pixelsWidth = 3;
    s.pixelsHeight = 2;
  }
}

}  // namespace stub

// ── raylib functions ──

inline void SetTraceLogCallback(TraceLogCallback callback) { stub::state().trace = callback; }
inline void TraceLog(int logLevel, const char* text, ...) {
  TraceLogCallback callback = stub::state().trace;
  if (!callback || !text) return;
  va_list args;
  va_start(args, text);
  callback(logLevel, text, args);
  va_end(args);
}

inline void SetConfigFlags(unsigned int flags) { stub::state().flags = flags; }
// GLFW's init hint, which a Linux window build sets before InitWindow (raylib links GLFW in): no window system here.
extern "C" inline void glfwInitHint(int, int) {}
inline void InitWindow(int width, int height, const char*) {
  stub::State& s = stub::state();
  s.screenWidth = width;
  s.screenHeight = height;
  s.windowReady = !s.windowFails;
}
inline bool IsWindowReady() { return stub::state().windowReady; }
inline void CloseWindow() { stub::state().windowReady = false; }
inline bool WindowShouldClose() {
  stub::State& s = stub::state();
  ++s.frame;
  s.clock += stub::FRAME_S;
  stub::feedAudio();
  std::this_thread::sleep_for(stub::IDLE);
  return false;
}
inline bool IsWindowFocused() { return stub::focusedNow(); }
inline bool IsWindowHidden() { return (stub::state().flags & FLAG_WINDOW_HIDDEN) != 0; }
inline bool IsWindowMinimized() { return (stub::state().flags & FLAG_WINDOW_MINIMIZED) != 0; }
inline bool IsWindowState(unsigned int flag) { return (stub::state().flags & flag) == flag; }
inline void SetWindowState(unsigned int flags) { stub::state().flags |= flags; }
inline void ClearWindowState(unsigned int flags) { stub::state().flags &= ~flags; }
inline void SetWindowFocused() { ++stub::state().fronted; }
inline void SetWindowSize(int width, int height) {
  stub::state().screenWidth = width;
  stub::state().screenHeight = height;
}
inline int GetScreenWidth() { return stub::state().screenWidth; }
inline int GetScreenHeight() { return stub::state().screenHeight; }
inline void SetExitKey(int) {}
inline double GetTime() { return stub::state().clock; }
inline float GetFrameTime() { return static_cast<float>(stub::FRAME_S); }
inline void WaitTime(double seconds) {
  if (seconds > 0) std::this_thread::sleep_for(std::chrono::duration<double>(seconds));
}
inline void PollInputEvents() {}
inline const char* GetApplicationDirectory() { return stub::state().applicationDirectory.c_str(); }

inline void BeginDrawing() {}
inline void EndDrawing() { ++stub::state().presented; }
inline void BeginTextureMode(RenderTexture2D) { stub::state().texts.clear(); }
inline void EndTextureMode() {}
inline void ClearBackground(Color) {}
inline void DrawTexturePro(Texture2D, Rectangle, Rectangle, Vector2, float, Color) {}
inline void DrawText(const char* text, int x, int y, int size, Color) {
  stub::state().texts.push_back(stub::TextDraw{text ? text : "", x, y, size});
}
/**
 * Three quarters of the type size per byte: wider than raylib's default font (about 0.6, letters 5
 * of its 10 px plus spacing), so a layout that fits under the stub fits on raylib too.
 */
inline int MeasureText(const char* text, int fontSize) {
  return text ? static_cast<int>(std::strlen(text)) * fontSize * 3 / 4 : 0;
}
inline void DrawRectangle(int, int, int, int, Color) {}
inline void DrawRectangleLines(int, int, int, int, Color) {}
inline void DrawLine(int, int, int, int, Color) {}
inline Color Fade(Color color, float alpha) {
  color.a = static_cast<unsigned char>(std::lround(std::fmin(std::fmax(alpha, 0.0f), 1.0f) * 255.0f));
  return color;
}

inline RenderTexture2D LoadRenderTexture(int width, int height) {
  return RenderTexture2D{1, Texture2D{2, width, height, 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8}, Texture2D{}};
}
inline void UnloadRenderTexture(RenderTexture2D) {}
inline void SetTextureFilter(Texture2D, int) {}
inline Image LoadImageFromTexture(Texture2D texture) {
  const stub::State& s = stub::state();
  bool scripted = !s.pixels.empty();
  int width = scripted ? s.pixelsWidth : texture.width;
  int height = scripted ? s.pixelsHeight : texture.height;
  std::size_t size = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4;
  auto* data = static_cast<unsigned char*>(std::malloc(size));
  if (!data) return Image{};
  if (scripted) {
    std::memcpy(data, s.pixels.data(), size);
  } else {
    std::memset(data, 128, size);
  }
  return Image{data, width, height, 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8};
}
inline Image GenImageChecked(int width, int height, int, int, Color, Color) {
  return Image{nullptr, width, height, 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8};
}
inline void UnloadImage(Image image) { std::free(image.data); }
inline Texture2D LoadTextureFromImage(Image image) {
  return Texture2D{3, image.width, image.height, 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8};
}
inline bool LoadStubAsset(const char* file) {
  if (!stub::state().assets) return false;
  stub::state().assetLoads.emplace_back(file);
  TraceLog(LOG_INFO, "FILEIO: [%s] File loaded successfully", file);
  return true;
}
inline Texture2D LoadTexture(const char* file) {
  return LoadStubAsset(file) ? Texture2D{7, 64, 64, 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8} : Texture2D{};
}
inline void GenTextureMipmaps(Texture2D*) {}
inline bool FileExists(const char* file) {
  return stub::state().assets && std::string(file).find("missing") == std::string::npos;
}
inline Mesh GenMeshCube(float, float, float) { return Mesh{24, 12}; }
inline Model LoadModelFromMesh(Mesh) { return Model{}; }
inline Model LoadModel(const char* file) {
  Model model{};
  if (LoadStubAsset(file)) model.meshCount = 1;
  return model;
}
inline void DrawModel(Model, Vector3, float, Color) {}
inline void DrawModelEx(Model, Vector3, Vector3, float, Vector3, Color) {}
inline void DrawMesh(Mesh, Material, Matrix) {}
inline Shader LoadShaderFromMemory(const char*, const char*) { return Shader{}; }
inline void SetRandomSeed(unsigned int) {}

inline void InitAudioDevice() {}
inline void CloseAudioDevice() {}
inline void SetMasterVolume(float) {}
inline Sound LoadSound(const char* file) {
  return LoadStubAsset(file) ? Sound{&stub::state(), 1} : Sound{};
}
inline bool IsSoundValid(Sound sound) { return sound.stream != nullptr; }
inline void AttachAudioMixedProcessor(AudioCallback processor) { stub::state().mixer = processor; }
inline void DetachAudioMixedProcessor(AudioCallback processor) {
  if (stub::state().mixer == processor) stub::state().mixer = nullptr;
}

inline bool IsKeyDown(int) { return false; }
inline bool IsKeyPressed(int) { return false; }
inline bool IsMouseButtonDown(int) { return false; }
inline bool IsMouseButtonPressed(int) { return false; }
inline bool IsGamepadAvailable(int) { return false; }
inline bool IsGamepadButtonDown(int, int) { return false; }
inline int GetGamepadAxisCount(int) { return 0; }
inline float GetGamepadAxisMovement(int, int) { return 0.0f; }
inline bool IsCursorHidden() { return false; }
inline Vector2 GetMouseDelta() { return Vector2{0, 0}; }
inline Vector2 GetMouseWheelMoveV() { return Vector2{0, 0}; }
inline Vector2 GetMousePosition() { return Vector2{0, 0}; }
inline int GetCharPressed() { return 0; }
inline const char* CodepointToUTF8(int, int* utf8Size) {
  if (utf8Size) *utf8Size = 0;
  return "";
}
inline bool MakeDirectory(const char*) { return false; }
inline bool SaveFileData(const char*, void*, int) { return false; }
inline unsigned char* LoadFileData(const char*, int* dataSize) {
  if (dataSize) *dataSize = 0;
  return nullptr;
}
inline void UnloadFileData(unsigned char* data) { std::free(data); }

// ── EGL functions ──

inline EGLDisplay eglGetCurrentDisplay() {
  return stub::state().device == stub::Device::None ? EGL_NO_DISPLAY : static_cast<EGLDisplay>(&stub::fakeDisplay);
}
inline const char* eglQueryString(EGLDisplay display, EGLint name) {
  if (display != EGL_NO_DISPLAY || name != EGL_EXTENSIONS) return nullptr;
  return "EGL_EXT_device_query EGL_ANGLE_platform_angle";
}
inline __eglMustCastToProperFunctionPointerType eglGetProcAddress(const char* name) {
  if (!name) return nullptr;
  if (std::strcmp(name, "eglQueryDisplayAttribEXT") == 0) {
    return reinterpret_cast<__eglMustCastToProperFunctionPointerType>(&stub::queryDisplayAttrib);
  }
  if (std::strcmp(name, "eglQueryDeviceStringEXT") == 0) {
    return reinterpret_cast<__eglMustCastToProperFunctionPointerType>(&stub::queryDeviceString);
  }
  if (std::strcmp(name, "eglQueryDeviceAttribEXT") == 0) {
    return reinterpret_cast<__eglMustCastToProperFunctionPointerType>(&stub::queryDeviceAttrib);
  }
  return nullptr;
}
