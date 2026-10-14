/**********************************************************************************************
*
*   rcore_genex_headless - Genex's headless raylib platform: no window, no WindowServer.
*   raylib draws into an EGL pbuffer on the bundled Metal-only ANGLE; nothing polls the OS for
*   input (a game takes its input only from the studio protocol, into the template's raylib-free
*   input merge).
*
*   DERIVATION: an altered copy of raylib 6.0's src/platforms/rcore_template.c (tag 6.0, commit
*   dbc56a87), zlib/libpng licensed as below. ALTERED SOURCE: this header; the EGL includes; the
*   EGL members of PlatformData and the monotonic time base; SwapScreenBuffer (glFlush: a pbuffer
*   has no front buffer); GetTime (a monotonic clock on every POSIX host); PollInputEvents (no
*   event source); InitPlatform (an ANGLE-Metal display, an RGBA8 D24S8 ES3 pbuffer config, a
*   pbuffer the size of the screen, an ES3 context made current); ClosePlatform (tears all of
*   that down). Every other window function keeps the template's no-op and its TraceLog line.
*
*   The prebuild compiles raylib from a build-tree copy in which this file replaces
*   platforms/rcore_memory.c, with -DPLATFORM_MEMORY -DGRAPHICS_API_OPENGL_ES3 (native/raylib-
*   platform/README.md): no raylib file is edited and nothing here is shipped as a patch to raylib.
*
**********************************************************************************************/

/**********************************************************************************************
*
*   rcore_<platform> template - Functions to manage window, graphics device and inputs
*
*   PLATFORM: <PLATFORM>
*       - TODO: Define the target platform for the core
*
*   LIMITATIONS:
*       - Limitation 01
*       - Limitation 02
*
*   POSSIBLE IMPROVEMENTS:
*       - Improvement 01
*       - Improvement 02
*
*   ADDITIONAL NOTES:
*       - TRACELOG() function is located in raylib [utils] module
*
*   CONFIGURATION:
*       #define RCORE_PLATFORM_CUSTOM_FLAG
*           Custom flag for rcore on target platform -not used-
*
*   DEPENDENCIES:
*       - <platform-specific SDK dependency>
*       - gestures: Gestures system for touch-ready devices (or simulated from mouse inputs)
*
*
*   LICENSE: zlib/libpng
*
*   Copyright (c) 2013-2026 Ramon Santamaria (@raysan5) and contributors
*
*   This software is provided "as-is", without any express or implied warranty. In no event
*   will the authors be held liable for any damages arising from the use of this software.
*
*   Permission is granted to anyone to use this software for any purpose, including commercial
*   applications, and to alter it and redistribute it freely, subject to the following restrictions:
*
*     1. The origin of this software must not be misrepresented; you must not claim that you
*     wrote the original software. If you use this software in a product, an acknowledgment
*     in the product documentation would be appreciated but is not required.
*
*     2. Altered source versions must be plainly marked as such, and must not be misrepresented
*     as being the original software.
*
*     3. This notice may not be removed or altered from any source distribution.
*
**********************************************************************************************/

// Genex: ANGLE's EGL (the display, the pbuffer, the context) from the bundled ANGLE's headers;
// GL ES 3 itself comes in through rlgl.h, which rcore.c includes before this file.
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <time.h>       // Required for: clock_gettime() [Used in GetTime()]

//----------------------------------------------------------------------------------
// Types and Structures Definition
//----------------------------------------------------------------------------------
typedef struct {
    // Genex: the EGL objects; the pbuffer is the screen. timeBase is the monotonic clock's reading
    // at InitPlatform (raylib's own InitTimer sets no base on Apple).
    EGLDisplay device;
    EGLSurface surface;
    EGLContext context;
    EGLConfig config;
    unsigned long long int timeBase;
} PlatformData;

//----------------------------------------------------------------------------------
// Global Variables Definition
//----------------------------------------------------------------------------------
extern CoreData CORE;                   // Global CORE state context

static PlatformData platform = { 0 };   // Platform specific data

//----------------------------------------------------------------------------------
// Module Internal Functions Declaration
//----------------------------------------------------------------------------------
int InitPlatform(void);          // Initialize platform (graphics, inputs and more)
bool InitGraphicsDevice(void);   // Initialize graphics device

//----------------------------------------------------------------------------------
// Module Functions Declaration
//----------------------------------------------------------------------------------
// NOTE: Functions declaration is provided by raylib.h

//----------------------------------------------------------------------------------
// Module Functions Definition: Window and Graphics Device
//----------------------------------------------------------------------------------

// Check if application should close
bool WindowShouldClose(void)
{
    if (CORE.Window.ready) return CORE.Window.shouldClose;
    else return true;
}

// Toggle fullscreen mode
void ToggleFullscreen(void)
{
    TRACELOG(LOG_WARNING, "ToggleFullscreen() not available on target platform");
}

// Toggle borderless windowed mode
void ToggleBorderlessWindowed(void)
{
    TRACELOG(LOG_WARNING, "ToggleBorderlessWindowed() not available on target platform");
}

// Set window state: maximized, if resizable
void MaximizeWindow(void)
{
    TRACELOG(LOG_WARNING, "MaximizeWindow() not available on target platform");
}

// Set window state: minimized
void MinimizeWindow(void)
{
    TRACELOG(LOG_WARNING, "MinimizeWindow() not available on target platform");
}

// Restore window from being minimized/maximized
void RestoreWindow(void)
{
    TRACELOG(LOG_WARNING, "RestoreWindow() not available on target platform");
}

// Set window configuration state using flags
void SetWindowState(unsigned int flags)
{
    TRACELOG(LOG_WARNING, "SetWindowState() not available on target platform");
}

// Clear window configuration state flags
void ClearWindowState(unsigned int flags)
{
    TRACELOG(LOG_WARNING, "ClearWindowState() not available on target platform");
}

// Set icon for window
void SetWindowIcon(Image image)
{
    TRACELOG(LOG_WARNING, "SetWindowIcon() not available on target platform");
}

// Set icon for window
void SetWindowIcons(Image *images, int count)
{
    TRACELOG(LOG_WARNING, "SetWindowIcons() not available on target platform");
}

// Set title for window
void SetWindowTitle(const char *title)
{
    CORE.Window.title = title;
}

// Set window position on screen (windowed mode)
void SetWindowPosition(int x, int y)
{
    TRACELOG(LOG_WARNING, "SetWindowPosition() not available on target platform");
}

// Set monitor for the current window
void SetWindowMonitor(int monitor)
{
    TRACELOG(LOG_WARNING, "SetWindowMonitor() not available on target platform");
}

// Set window minimum dimensions (FLAG_WINDOW_RESIZABLE)
void SetWindowMinSize(int width, int height)
{
    CORE.Window.screenMin.width = width;
    CORE.Window.screenMin.height = height;
}

// Set window maximum dimensions (FLAG_WINDOW_RESIZABLE)
void SetWindowMaxSize(int width, int height)
{
    CORE.Window.screenMax.width = width;
    CORE.Window.screenMax.height = height;
}

// Set window dimensions
void SetWindowSize(int width, int height)
{
    TRACELOG(LOG_WARNING, "SetWindowSize() not available on target platform");
}

// Set window opacity, value opacity is between 0.0 and 1.0
void SetWindowOpacity(float opacity)
{
    TRACELOG(LOG_WARNING, "SetWindowOpacity() not available on target platform");
}

// Set window focused
void SetWindowFocused(void)
{
    TRACELOG(LOG_WARNING, "SetWindowFocused() not available on target platform");
}

// Get native window handle
void *GetWindowHandle(void)
{
    TRACELOG(LOG_WARNING, "GetWindowHandle() not implemented on target platform");
    return NULL;
}

// Get number of monitors
int GetMonitorCount(void)
{
    TRACELOG(LOG_WARNING, "GetMonitorCount() not implemented on target platform");
    return 1;
}

// Get current monitor where window is placed
int GetCurrentMonitor(void)
{
    TRACELOG(LOG_WARNING, "GetCurrentMonitor() not implemented on target platform");
    return 0;
}

// Get selected monitor position
Vector2 GetMonitorPosition(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorPosition() not implemented on target platform");
    return (Vector2){ 0, 0 };
}

// Get selected monitor width (currently used by monitor)
int GetMonitorWidth(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorWidth() not implemented on target platform");
    return 0;
}

// Get selected monitor height (currently used by monitor)
int GetMonitorHeight(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorHeight() not implemented on target platform");
    return 0;
}

// Get selected monitor physical width in millimetres
int GetMonitorPhysicalWidth(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorPhysicalWidth() not implemented on target platform");
    return 0;
}

// Get selected monitor physical height in millimetres
int GetMonitorPhysicalHeight(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorPhysicalHeight() not implemented on target platform");
    return 0;
}

// Get selected monitor refresh rate
int GetMonitorRefreshRate(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorRefreshRate() not implemented on target platform");
    return 0;
}

// Get the human-readable, UTF-8 encoded name of the selected monitor
const char *GetMonitorName(int monitor)
{
    TRACELOG(LOG_WARNING, "GetMonitorName() not implemented on target platform");
    return "";
}

// Get window position XY on monitor
Vector2 GetWindowPosition(void)
{
    TRACELOG(LOG_WARNING, "GetWindowPosition() not implemented on target platform");
    return (Vector2){ 0, 0 };
}

// Get window scale DPI factor for current monitor
Vector2 GetWindowScaleDPI(void)
{
    TRACELOG(LOG_WARNING, "GetWindowScaleDPI() not implemented on target platform");
    return (Vector2){ 1.0f, 1.0f };
}

// Set clipboard text content
void SetClipboardText(const char *text)
{
    TRACELOG(LOG_WARNING, "SetClipboardText() not implemented on target platform");
}

// Get clipboard text content
// NOTE: returned string is allocated and freed by GLFW
const char *GetClipboardText(void)
{
    TRACELOG(LOG_WARNING, "GetClipboardText() not implemented on target platform");
    return NULL;
}

// Get clipboard image
Image GetClipboardImage(void)
{
    Image image = { 0 };

    TRACELOG(LOG_WARNING, "GetClipboardImage() not implemented on target platform");

    return image;
}

// Show mouse cursor
void ShowCursor(void)
{
    CORE.Input.Mouse.cursorHidden = false;
}

// Hides mouse cursor
void HideCursor(void)
{
    CORE.Input.Mouse.cursorHidden = true;
}

// Enables cursor (unlock cursor)
void EnableCursor(void)
{
    // Set cursor position in the middle
    SetMousePosition(CORE.Window.screen.width/2, CORE.Window.screen.height/2);

    CORE.Input.Mouse.cursorHidden = false;
}

// Disables cursor (lock cursor)
void DisableCursor(void)
{
    // Set cursor position in the middle
    SetMousePosition(CORE.Window.screen.width/2, CORE.Window.screen.height/2);

    CORE.Input.Mouse.cursorHidden = true;
}

// Swap back buffer with front buffer (screen drawing)
// Genex: a pbuffer has no front buffer; flushing submits the frame so a read-back sees it.
void SwapScreenBuffer(void)
{
    glFlush();
}

//----------------------------------------------------------------------------------
// Module Functions Definition: Misc
//----------------------------------------------------------------------------------

// Genex: the monotonic clock in nanoseconds
static unsigned long long int MonotonicNanoseconds(void)
{
    struct timespec ts = { 0 };
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long long int)ts.tv_sec*1000000000LLU + (unsigned long long int)ts.tv_nsec;
}

// Get elapsed time measure in seconds since InitPlatform()
// Genex: measured from the platform's own base, which every POSIX host sets
double GetTime(void)
{
    return (double)(MonotonicNanoseconds() - platform.timeBase)*1e-9;
}

// Open URL with default system browser (if available)
// NOTE: This function is only safe to use if you control the URL given.
// A user could craft a malicious string performing another action.
// Only call this function yourself not with user input or make sure to check the string yourself.
// Ref: https://github.com/raysan5/raylib/issues/686
void OpenURL(const char *url)
{
    // Security check to (partially) avoid malicious code on target platform
    if (strchr(url, '\'') != NULL) TRACELOG(LOG_WARNING, "SYSTEM: Provided URL could be potentially malicious, avoid [\'] character");
    else
    {
        // TODO: Load url using default browser
    }
}

//----------------------------------------------------------------------------------
// Module Functions Definition: Inputs
//----------------------------------------------------------------------------------

// Set internal gamepad mappings
int SetGamepadMappings(const char *mappings)
{
    TRACELOG(LOG_WARNING, "SetGamepadMappings() not implemented on target platform");
    return 0;
}

// Set gamepad vibration
void SetGamepadVibration(int gamepad, float leftMotor, float rightMotor, float duration)
{
    TRACELOG(LOG_WARNING, "SetGamepadVibration() not implemented on target platform");
}

// Set mouse position XY
void SetMousePosition(int x, int y)
{
    CORE.Input.Mouse.currentPosition = (Vector2){ (float)x, (float)y };
    CORE.Input.Mouse.previousPosition = CORE.Input.Mouse.currentPosition;
}

// Set mouse cursor
void SetMouseCursor(int cursor)
{
    TRACELOG(LOG_WARNING, "SetMouseCursor() not implemented on target platform");
}

// Get physical key name.
const char *GetKeyName(int key)
{
    TRACELOG(LOG_WARNING, "GetKeyName() not implemented on target platform");
    return "";
}

// Register all input events
// Genex: no event source exists; only raylib's per-frame bookkeeping runs, so the previous and
// current input states stay consistent (all released) for any raylib call that reads them.
void PollInputEvents(void)
{
#if SUPPORT_GESTURES_SYSTEM
    // NOTE: Gestures update must be called every frame to reset gestures correctly
    // because ProcessGestureEvent() is called on an event, not every frame
    UpdateGestures();
#endif

    // Reset keys/chars pressed registered
    CORE.Input.Keyboard.keyPressedQueueCount = 0;
    CORE.Input.Keyboard.charPressedQueueCount = 0;

    // Reset key repeats
    for (int i = 0; i < MAX_KEYBOARD_KEYS; i++) CORE.Input.Keyboard.keyRepeatInFrame[i] = 0;

    // Reset last gamepad button/axis registered state
    CORE.Input.Gamepad.lastButtonPressed = 0; // GAMEPAD_BUTTON_UNKNOWN
    //CORE.Input.Gamepad.axisCount = 0;

    // Register previous touch states
    for (int i = 0; i < MAX_TOUCH_POINTS; i++) CORE.Input.Touch.previousTouchState[i] = CORE.Input.Touch.currentTouchState[i];

    // Reset touch positions
    // TODO: It resets on target platform the mouse position and not filled again until a move-event,
    // so, if mouse is not moved it returns a (0, 0) position... this behaviour should be reviewed!
    //for (int i = 0; i < MAX_TOUCH_POINTS; i++) CORE.Input.Touch.position[i] = (Vector2){ 0, 0 };

    // Register previous keys states
    // NOTE: Android supports up to 260 keys
    for (int i = 0; i < 260; i++)
    {
        CORE.Input.Keyboard.previousKeyState[i] = CORE.Input.Keyboard.currentKeyState[i];
        CORE.Input.Keyboard.keyRepeatInFrame[i] = 0;
    }
}

//----------------------------------------------------------------------------------
// Module Internal Functions Definition
//----------------------------------------------------------------------------------

// Genex: the display ANGLE draws on, asked for Metal explicitly (ANGLE_DEFAULT_PLATFORM is only
// the host's redundancy: with no type, a multi-backend ANGLE would pick Apple's GL).
static EGLDisplay MetalDisplay(void)
{
    const EGLAttrib displayAttribs[] = {
        EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE,
        EGL_NONE
    };

    return eglGetPlatformDisplay(EGL_PLATFORM_ANGLE_ANGLE, (void *)EGL_DEFAULT_DISPLAY, displayAttribs);
}

// Genex: an RGBA8, depth 24, stencil 8, ES 3 config that can back a pbuffer
static bool ChooseConfig(void)
{
    const bool msaa = FLAG_IS_SET(CORE.Window.flags, FLAG_MSAA_4X_HINT);
    const EGLint configAttribs[] = {
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_SAMPLE_BUFFERS, msaa? 1 : 0,
        EGL_SAMPLES, msaa? 4 : 0,
        EGL_NONE
    };
    EGLint configCount = 0;

    if (msaa) TRACELOG(LOG_INFO, "DISPLAY: Trying to enable MSAA x4");

    const EGLBoolean chosen = eglChooseConfig(platform.device, configAttribs, &platform.config, 1, &configCount);

    return (chosen == EGL_TRUE) && (configCount > 0);
}

// Genex: the pbuffer the size of the screen, and an ES 3.0 context made current on it
static bool CreatePbufferContext(void)
{
    const EGLint surfaceAttribs[] = {
        EGL_WIDTH, (EGLint)CORE.Window.screen.width,
        EGL_HEIGHT, (EGLint)CORE.Window.screen.height,
        EGL_NONE
    };
    const EGLint contextAttribs[] = {
        EGL_CONTEXT_MAJOR_VERSION, 3,
        EGL_CONTEXT_MINOR_VERSION, 0,
        EGL_NONE
    };

    platform.surface = eglCreatePbufferSurface(platform.device, platform.config, surfaceAttribs);
    if (platform.surface == EGL_NO_SURFACE) return false;

    if (eglBindAPI(EGL_OPENGL_ES_API) != EGL_TRUE) return false;
    platform.context = eglCreateContext(platform.device, platform.config, EGL_NO_CONTEXT, contextAttribs);
    if (platform.context == EGL_NO_CONTEXT) return false;

    return eglMakeCurrent(platform.device, platform.surface, platform.surface, platform.context) == EGL_TRUE;
}

// Initialize platform: graphics, inputs and more
int InitPlatform(void)
{
    // Genex: a monotonic base first, so GetTime() counts from here on every host
    platform.timeBase = MonotonicNanoseconds();

    // Initialize graphic device: an ANGLE-Metal display, a pbuffer and an ES 3 context
    //----------------------------------------------------------------------------
    platform.device = MetalDisplay();
    if (platform.device == EGL_NO_DISPLAY)
    {
        TRACELOG(LOG_WARNING, "DISPLAY: Failed to get an ANGLE Metal EGL display (0x%04x)", eglGetError());
        return -1;
    }

    EGLint major = 0, minor = 0;
    if (eglInitialize(platform.device, &major, &minor) != EGL_TRUE)
    {
        TRACELOG(LOG_WARNING, "DISPLAY: Failed to initialize the ANGLE Metal EGL display (0x%04x)", eglGetError());
        return -1;
    }

    if (!ChooseConfig() || !CreatePbufferContext())
    {
        TRACELOG(LOG_WARNING, "DISPLAY: Failed to create the headless pbuffer context (0x%04x)", eglGetError());
        ClosePlatform();
        return -1;
    }

    CORE.Window.ready = true;
    CORE.Window.display.width = CORE.Window.screen.width;
    CORE.Window.display.height = CORE.Window.screen.height;
    CORE.Window.render.width = CORE.Window.screen.width;
    CORE.Window.render.height = CORE.Window.screen.height;
    CORE.Window.currentFbo.width = CORE.Window.render.width;
    CORE.Window.currentFbo.height = CORE.Window.render.height;
    //----------------------------------------------------------------------------

    TRACELOG(LOG_INFO, "DISPLAY: Headless pbuffer initialized successfully (EGL %i.%i)", major, minor);
    TRACELOG(LOG_INFO, "    > Screen size:  %i x %i", CORE.Window.screen.width, CORE.Window.screen.height);
    TRACELOG(LOG_INFO, "    > Render size:  %i x %i", CORE.Window.render.width, CORE.Window.render.height);

    // Load OpenGL extensions
    // NOTE: GL procedures address loader is required to load extensions
    //----------------------------------------------------------------------------
    rlLoadExtensions(eglGetProcAddress);
    //----------------------------------------------------------------------------

    // Initialize timing system
    //----------------------------------------------------------------------------
    InitTimer();
    //----------------------------------------------------------------------------

    // Initialize storage system
    //----------------------------------------------------------------------------
    CORE.Storage.basePath = GetWorkingDirectory();
    //----------------------------------------------------------------------------

    TRACELOG(LOG_INFO, "PLATFORM: GENEX HEADLESS: Initialized successfully");

    return 0;
}

// Close platform
// Genex: releases the context, the pbuffer and the display, in that order; safe after a partial init
void ClosePlatform(void)
{
    if (platform.device != EGL_NO_DISPLAY)
    {
        eglMakeCurrent(platform.device, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (platform.context != EGL_NO_CONTEXT) eglDestroyContext(platform.device, platform.context);
        if (platform.surface != EGL_NO_SURFACE) eglDestroySurface(platform.device, platform.surface);
        eglTerminate(platform.device);
    }
    eglReleaseThread();

    platform.context = EGL_NO_CONTEXT;
    platform.surface = EGL_NO_SURFACE;
    platform.device = EGL_NO_DISPLAY;
    CORE.Window.ready = false;
}

// EOF
