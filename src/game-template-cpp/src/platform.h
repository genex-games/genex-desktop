// What differs between destinations, in one place: how the frame loop runs and is paced, how the
// window follows its slot or the studio's front/visible ops, how real input is read, which graphics
// path draws, where assets and saves live, and the shader header. Everything else in the game is
// shared code. The studio runtime (studio.cpp) is the only caller of the loop, window and input
// parts; game code uses studio::asset(), studio::shader() and studio::save().
//
// A native build is a window (the person's Play) or, compiled with GENEX_HEADLESS, an agent's
// headless run on raylib's Genex headless platform, drawing into an ANGLE pbuffer: no window, no
// real input, every input from the studio protocol.
#pragma once

#include <functional>
#include <optional>
#include <string>
#include <string_view>

#include "input.h"
#include "paths.h"
#include "raylib.h"

namespace studio::platform {

/** The header every shader gets: ANGLE and WebGL2 both speak GLSL ES 3.00. */
inline constexpr std::string_view SHADER_HEADER = "#version 300 es\nprecision highp float;\nprecision highp int;\n";

/** The raylib window flags for this destination (set before InitWindow). */
unsigned int windowFlags();
/** Pick the window system before InitWindow: X11 for a Linux window with an X server named (`paths::prefersX11`); elsewhere nothing. */
void chooseWindowSystem();
/** The screen size to open at: the slot's size on the web once the shell has reported it, else `worldSize`. */
Vector2 initialScreenSize(Vector2 worldSize);
/** Drive `frame` until the game ends: the browser's animation frames, or a native loop until the window closes. */
void run(void (*frame)());
/** End a native loop after the current frame. The web has no quit: the page stays until it is closed. */
void requestQuit();
/** Whether every loop iteration must present (a native window keeps its events flowing only through EndDrawing). */
bool presentsEveryFrame();
/** Apply the web shell's latest slot size to the canvas; true when it changed (the frame must be presented again). */
bool followSlot();

/** Real input for one rendered frame, the pointer relative to `view` (the letterboxed world); none when headless. */
FrameSample sampleInput(Rectangle view);

/** Whether this build has a window the person sees (a native window build; not headless, not the web). */
bool hasWindow();
/**
 * Whether presenting a frame now reaches a screen: false while a native window is hidden or
 * minimized, whose swap may block for a long time instead of pacing. The world texture, which
 * captures read, is drawn either way.
 */
bool canPresent();
/** The window's OS focus; true where there is no window. */
bool focused();
/** Raise the window and give it focus (the studio's `front`); false where there is no window. */
bool front();
/** Show or hide the window (the studio's `visible`); whether it is visible now, false where there is none. */
bool setVisible(bool visible);
/**
 * Wait out the rest of a frame that began at `frameStartMs` when nothing else paces the loop:
 * always headless, and while a window is hidden or minimized (it presents nothing then). `wait`
 * waits up to its milliseconds and returns early when the studio sends a request; without one the
 * loop sleeps. The window's vsync and the browser's animation frames pace everything else.
 */
void pace(double frameStartMs, const std::function<void(double ms)>& wait);

/** The graphics path this process draws through, as `ready.backend` reports it. */
struct GraphicsBackend {
  /** A protocol::Backend value. */
  std::string_view api;
  /** The device's name, "" when the query does not say. */
  std::string device;
  /** A software (CPU) device: the HUD shows the CPU-fallback notice. */
  bool software = false;
};
/** Asked once after InitWindow, of ANGLE's EGL device (EGL_EXT_device_query): never the GL renderer string. */
GraphicsBackend graphicsBackend();
/** What this build is, for `ready.build`: the lane's GENEX_BUILD_ID, else raylib's version, the OS and the mode. */
std::string buildName();

/** Make the save folder usable before the game's first reset: the browser mounts IndexedDB and reads it back. */
void prepareSaves();
/** Whether the save folder is ready, so the first reset may run (at once natively; the browser's read-back is asynchronous). */
bool savesReady();
/** Tell the page the game is up: the web shell binds window.__studio then (natively, studio.cpp sends `ready`). */
void announceReady();

/** `code` with any `#version` line removed and SHADER_HEADER in front. */
std::string shaderSource(std::string_view code);
/** A shader from source strings without a `#version` line; null keeps raylib's default stage. */
Shader loadShader(const char* vertex, const char* fragment);

/** The actual asset folder, ending in `/`, used for file loading and replay claim labels. */
std::string assetRoot();
/** Where assets/<rel> is on this destination, or "" when `rel` is not a safe asset path. */
std::string assetPath(std::string_view rel);

/** This process's destination. */
paths::Destination destination();
/** The running app's own bundle id (the Info.plist the host wrote into a Mac app), or "" anywhere else. */
std::string_view runningBundleId();
/** The save root on this destination. */
paths::SaveRoot saveRoot(paths::GameIdentity game);
/** Write `file` (a safe relative name) under the save root. */
bool saveFile(paths::GameIdentity game, std::string_view file, const void* data, int size);
/** Read `file` from the save root, or nothing. */
std::optional<std::string> loadFile(paths::GameIdentity game, std::string_view file);

}  // namespace studio::platform
