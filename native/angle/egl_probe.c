/*
 * egl_probe: loads a staged ANGLE (libEGL + libGLESv2) from a directory, creates an OpenGL ES 3.0
 * context on a pbuffer, draws a triangle with a GLSL ES 3.00 program, reads the pixels back and
 * reports which native device ANGLE runs on. It prints one JSON line and exits 0 only when every
 * check passes; "failed" names the checks that did not.
 *
 *   egl_probe <dir> [--expect metal|d3d11|vulkan] [--swiftshader | --warp]
 *
 * --expect names the backend the build must report (EGL_ANGLE_device_metal, _d3d or _vulkan).
 * --swiftshader asks ANGLE's Vulkan backend for its bundled SwiftShader device (CI without a GPU).
 * --warp asks ANGLE's D3D11 backend for the WARP software device (CI without a GPU).
 * An ES 3.0 request may return a later, backward-compatible ES 3.x context (EGL_KHR_create_context):
 * ANGLE's Vulkan backend reports 3.1, so any ES 3.x passes.
 * The libraries are resolved at run time, so no import library is needed on any OS.
 *
 * macOS:   xcrun clang -I <dir>/include egl_probe.c -o egl_probe -lobjc
 * Linux:   cc -I <dir>/include egl_probe.c -o egl_probe -ldl
 * Windows: cl /I <dir>\include egl_probe.c
 */
#if defined(__linux__)
#define _GNU_SOURCE /* dladdr and RTLD_NOLOAD */
#endif
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Only the loader pointer types are used, and the native display is always EGL_DEFAULT_DISPLAY. */
#define EGL_NO_PLATFORM_SPECIFIC_TYPES 1
#define EGL_EGL_PROTOTYPES 0
#define GL_GLES_PROTOTYPES 0
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>

#if defined(_WIN32)
#include <windows.h>
typedef HMODULE Library;
static const char *const EGL_NAME = "libEGL.dll";
static const char *const GLES_NAME = "libGLESv2.dll";
static Library library_open(const char *path) {
  char native[4096];
  snprintf(native, sizeof native, "%s", path);
  for (char *c = native; *c; c++)
    if (*c == '/') *c = '\\'; /* LoadLibrary documents backslashes only; CI passes mixed separators. */
  return LoadLibraryA(native);
}
static void *library_symbol(Library library, const char *name) { return (void *)GetProcAddress(library, name); }
#else
#include <dlfcn.h>
typedef void *Library;
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#include <objc/message.h>
#include <objc/runtime.h>
static const char *const EGL_NAME = "libEGL.dylib";
static const char *const GLES_NAME = "libGLESv2.dylib";
#else
static const char *const EGL_NAME = "libEGL.so";
static const char *const GLES_NAME = "libGLESv2.so";
#endif
static Library library_open(const char *path) { return dlopen(path, RTLD_NOW | RTLD_LOCAL); }
static void *library_symbol(Library library, const char *name) { return dlsym(library, name); }
#endif

#define SIZE 64
#define TOLERANCE 3

static const char *const VERTEX_SHADER =
    "#version 300 es\n"
    "in vec2 position;\n"
    "void main() { gl_Position = vec4(position, 0.0, 1.0); }\n";
static const char *const FRAGMENT_SHADER =
    "#version 300 es\n"
    "precision mediump float;\n"
    "out vec4 color;\n"
    "void main() { color = vec4(1.0, 0.5, 0.0, 1.0); }\n";
static const float TRIANGLE[] = {-0.5f, -0.5f, 0.5f, -0.5f, 0.0f, 0.5f};
static const unsigned char CLEAR_RGBA[4] = {26, 51, 77, 255};
static const unsigned char TRIANGLE_RGBA[4] = {255, 128, 0, 255};

static Library egl_library;
static Library gles_library;
static PFNEGLGETPROCADDRESSPROC egl_get_proc_address;

static void fail(const char *format, ...) {
  va_list args;
  printf("{\"ok\":false,\"error\":\"");
  va_start(args, format);
  vprintf(format, args);
  va_end(args);
  printf("\"}\n");
  exit(1);
}

static void *egl(const char *name) {
  void *symbol = library_symbol(egl_library, name);
  if (!symbol && egl_get_proc_address) symbol = (void *)egl_get_proc_address(name);
  if (!symbol) fail("missing EGL entry point %s", name);
  return symbol;
}

static void *gles(const char *name) {
  void *symbol = library_symbol(gles_library, name);
  if (!symbol) symbol = (void *)egl_get_proc_address(name);
  if (!symbol) fail("missing GLES entry point %s", name);
  return symbol;
}

static Library load(const char *dir, const char *name) {
  char path[4096];
  snprintf(path, sizeof path, "%s/%s", dir, name);
  Library library = library_open(path);
  if (!library) fail("cannot load %s", path);
  return library;
}

/* The path the EGL library was actually loaded from, so a system copy cannot pass unnoticed. */
static const char *loaded_from(void *symbol) {
#if defined(_WIN32)
  static char path[MAX_PATH];
  HMODULE module = NULL;
  GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     (LPCSTR)symbol, &module);
  GetModuleFileNameA(module, path, sizeof path);
  for (char *c = path; *c; c++)
    if (*c == '\\') *c = '/';
  return path;
#else
  Dl_info info;
  return dladdr(symbol, &info) && info.dli_fname ? info.dli_fname : "?";
#endif
}

/*
 * Whether the platform's own GL library is mapped into the process. Reported, never gated: on macOS 26
 * loading Metal.framework (or IOSurface, CoreGraphics, QuartzCore) maps OpenGL.framework by itself, so
 * the backend is proven by the EGL device query and the build's imports instead.
 */
static int system_gl_mapped(void) {
#if defined(_WIN32)
  return GetModuleHandleA("opengl32.dll") != NULL;
#elif defined(__APPLE__)
  for (uint32_t i = 0; i < _dyld_image_count(); i++)
    if (strstr(_dyld_get_image_name(i), "OpenGL.framework")) return 1;
  return 0;
#else
  void *gl = dlopen("libGL.so.1", RTLD_NOW | RTLD_NOLOAD);
  return gl != NULL;
#endif
}

static const char *metal_device_name(EGLAttrib device) {
#if defined(__APPLE__)
  id name = ((id (*)(id, SEL))objc_msgSend)((id)device, sel_registerName("name"));
  return name ? ((const char *(*)(id, SEL))objc_msgSend)(name, sel_registerName("UTF8String")) : "?";
#else
  (void)device;
  return "?";
#endif
}

typedef enum { DEVICE_DEFAULT, DEVICE_SWIFTSHADER, DEVICE_WARP } SoftwareDevice;

static EGLDisplay open_display(SoftwareDevice software) {
  PFNEGLGETPLATFORMDISPLAYPROC get_platform_display = (PFNEGLGETPLATFORMDISPLAYPROC)egl("eglGetPlatformDisplay");
  EGLAttrib swiftshader_attribs[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_VULKAN_ANGLE,
                                     EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE,
                                     EGL_PLATFORM_ANGLE_DEVICE_TYPE_SWIFTSHADER_ANGLE, EGL_NONE};
  EGLAttrib warp_attribs[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_D3D11_ANGLE,
                              EGL_PLATFORM_ANGLE_DEVICE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_DEVICE_TYPE_D3D_WARP_ANGLE,
                              EGL_NONE};
  EGLAttrib default_attribs[] = {EGL_NONE};
  EGLAttrib *attribs = software == DEVICE_SWIFTSHADER ? swiftshader_attribs : default_attribs;
  if (software == DEVICE_WARP) attribs = warp_attribs;
  EGLDisplay display = get_platform_display(EGL_PLATFORM_ANGLE_ANGLE, (void *)EGL_DEFAULT_DISPLAY, attribs);
  EGLint major = 0, minor = 0;
  if (display == EGL_NO_DISPLAY) fail("eglGetPlatformDisplay returned EGL_NO_DISPLAY");
  if (!((PFNEGLINITIALIZEPROC)egl("eglInitialize"))(display, &major, &minor)) fail("eglInitialize failed");
  return display;
}

static void make_current(EGLDisplay display) {
  const EGLint config_attribs[] = {EGL_SURFACE_TYPE,
                                   EGL_PBUFFER_BIT,
                                   EGL_RENDERABLE_TYPE,
                                   EGL_OPENGL_ES3_BIT,
                                   EGL_RED_SIZE,
                                   8,
                                   EGL_GREEN_SIZE,
                                   8,
                                   EGL_BLUE_SIZE,
                                   8,
                                   EGL_ALPHA_SIZE,
                                   8,
                                   EGL_NONE};
  const EGLint surface_attribs[] = {EGL_WIDTH, SIZE, EGL_HEIGHT, SIZE, EGL_NONE};
  const EGLint context_attribs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE};
  EGLConfig config;
  EGLint count = 0;
  if (!((PFNEGLCHOOSECONFIGPROC)egl("eglChooseConfig"))(display, config_attribs, &config, 1, &count) || count < 1)
    fail("no RGBA8 ES3 pbuffer config");
  EGLSurface surface =
      ((PFNEGLCREATEPBUFFERSURFACEPROC)egl("eglCreatePbufferSurface"))(display, config, surface_attribs);
  if (surface == EGL_NO_SURFACE) fail("eglCreatePbufferSurface failed");
  EGLContext context =
      ((PFNEGLCREATECONTEXTPROC)egl("eglCreateContext"))(display, config, EGL_NO_CONTEXT, context_attribs);
  if (context == EGL_NO_CONTEXT) fail("eglCreateContext (ES 3.0) failed");
  if (!((PFNEGLMAKECURRENTPROC)egl("eglMakeCurrent"))(display, surface, surface, context))
    fail("eglMakeCurrent failed");
}

static GLuint compile(GLenum type, const char *source) {
  GLuint shader = ((PFNGLCREATESHADERPROC)gles("glCreateShader"))(type);
  GLint ok = 0;
  ((PFNGLSHADERSOURCEPROC)gles("glShaderSource"))(shader, 1, &source, NULL);
  ((PFNGLCOMPILESHADERPROC)gles("glCompileShader"))(shader);
  ((PFNGLGETSHADERIVPROC)gles("glGetShaderiv"))(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) fail("shader compile failed");
  return shader;
}

static void draw(void) {
  GLuint program = ((PFNGLCREATEPROGRAMPROC)gles("glCreateProgram"))();
  GLuint buffer = 0;
  GLint ok = 0;
  ((PFNGLATTACHSHADERPROC)gles("glAttachShader"))(program, compile(GL_VERTEX_SHADER, VERTEX_SHADER));
  ((PFNGLATTACHSHADERPROC)gles("glAttachShader"))(program, compile(GL_FRAGMENT_SHADER, FRAGMENT_SHADER));
  ((PFNGLBINDATTRIBLOCATIONPROC)gles("glBindAttribLocation"))(program, 0, "position");
  ((PFNGLLINKPROGRAMPROC)gles("glLinkProgram"))(program);
  ((PFNGLGETPROGRAMIVPROC)gles("glGetProgramiv"))(program, GL_LINK_STATUS, &ok);
  if (!ok) fail("program link failed");
  ((PFNGLVIEWPORTPROC)gles("glViewport"))(0, 0, SIZE, SIZE);
  ((PFNGLCLEARCOLORPROC)gles("glClearColor"))(0.1f, 0.2f, 0.3f, 1.0f);
  ((PFNGLCLEARPROC)gles("glClear"))(GL_COLOR_BUFFER_BIT);
  ((PFNGLGENBUFFERSPROC)gles("glGenBuffers"))(1, &buffer);
  ((PFNGLBINDBUFFERPROC)gles("glBindBuffer"))(GL_ARRAY_BUFFER, buffer);
  ((PFNGLBUFFERDATAPROC)gles("glBufferData"))(GL_ARRAY_BUFFER, sizeof TRIANGLE, TRIANGLE, GL_STATIC_DRAW);
  ((PFNGLVERTEXATTRIBPOINTERPROC)gles("glVertexAttribPointer"))(0, 2, GL_FLOAT, GL_FALSE, 0, 0);
  ((PFNGLENABLEVERTEXATTRIBARRAYPROC)gles("glEnableVertexAttribArray"))(0);
  ((PFNGLUSEPROGRAMPROC)gles("glUseProgram"))(program);
  ((PFNGLDRAWARRAYSPROC)gles("glDrawArrays"))(GL_TRIANGLES, 0, 3);
  ((PFNGLFINISHPROC)gles("glFinish"))();
}

static int pixel_matches(const unsigned char *actual, const unsigned char *expected) {
  for (int i = 0; i < 4; i++)
    if (abs(actual[i] - expected[i]) > TOLERANCE) return 0;
  return 1;
}

static const char *device_extensions(EGLDisplay display, EGLAttrib *device) {
  PFNEGLQUERYDISPLAYATTRIBEXTPROC query_display = (PFNEGLQUERYDISPLAYATTRIBEXTPROC)egl("eglQueryDisplayAttribEXT");
  PFNEGLQUERYDEVICESTRINGEXTPROC query_string = (PFNEGLQUERYDEVICESTRINGEXTPROC)egl("eglQueryDeviceStringEXT");
  if (!query_display(display, EGL_DEVICE_EXT, device) || !*device)
    fail("eglQueryDisplayAttribEXT(EGL_DEVICE_EXT) failed");
  const char *extensions = query_string((EGLDeviceEXT)*device, EGL_EXTENSIONS);
  return extensions ? extensions : "";
}

/* The native device behind the expected backend, or NULL when ANGLE does not report it. */
static const char *backend_device(const char *expect, EGLAttrib device, const char *extensions) {
  PFNEGLQUERYDEVICEATTRIBEXTPROC query_attrib = (PFNEGLQUERYDEVICEATTRIBEXTPROC)egl("eglQueryDeviceAttribEXT");
  EGLAttrib native = 0;
  if (strcmp(expect, "metal") == 0) {
    if (!strstr(extensions, "EGL_ANGLE_device_metal")) return NULL;
    if (!query_attrib((EGLDeviceEXT)device, EGL_METAL_DEVICE_ANGLE, &native) || !native) return NULL;
    return metal_device_name(native);
  }
  if (strcmp(expect, "d3d11") == 0) {
    if (!strstr(extensions, "EGL_ANGLE_device_d3d")) return NULL;
    return query_attrib((EGLDeviceEXT)device, EGL_D3D11_DEVICE_ANGLE, &native) && native ? "ID3D11Device" : NULL;
  }
  if (strcmp(expect, "vulkan") == 0) return strstr(extensions, "EGL_ANGLE_device_vulkan") ? "VkPhysicalDevice" : NULL;
  fail("unknown --expect %s", expect);
  return NULL;
}

/* Whether GL_VERSION names an OpenGL ES 3.x context, the only family the destinations target. */
static int is_es3(const char *version) {
  int major = 0, minor = 0;
  return version && sscanf(version, "OpenGL ES %d.%d", &major, &minor) == 2 && major == 3;
}

int main(int argc, char **argv) {
  const char *dir = NULL, *expect = NULL;
  SoftwareDevice software = DEVICE_DEFAULT;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--expect") == 0 && i + 1 < argc)
      expect = argv[++i];
    else if (strcmp(argv[i], "--swiftshader") == 0)
      software = DEVICE_SWIFTSHADER;
    else if (strcmp(argv[i], "--warp") == 0)
      software = DEVICE_WARP;
    else
      dir = argv[i];
  }
  if (!dir) fail("usage: egl_probe <dir> [--expect metal|d3d11|vulkan] [--swiftshader | --warp]");
  gles_library = load(dir, GLES_NAME);
  egl_library = load(dir, EGL_NAME);
  egl_get_proc_address = (PFNEGLGETPROCADDRESSPROC)library_symbol(egl_library, "eglGetProcAddress");
  EGLDisplay display = open_display(software);
  make_current(display);
  draw();
  unsigned char center[4], corner[4];
  ((PFNGLREADPIXELSPROC)gles("glReadPixels"))(SIZE / 2, SIZE / 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, center);
  ((PFNGLREADPIXELSPROC)gles("glReadPixels"))(1, 1, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, corner);
  PFNGLGETSTRINGPROC get_string = (PFNGLGETSTRINGPROC)gles("glGetString");
  const char *version = (const char *)get_string(GL_VERSION);
  const char *renderer = (const char *)get_string(GL_RENDERER);
  EGLAttrib device = 0;
  const char *extensions = device_extensions(display, &device);
  const char *native = expect ? backend_device(expect, device, extensions) : "unchecked";
  int es3 = is_es3(version);
  int pixels_ok = pixel_matches(center, TRIANGLE_RGBA) && pixel_matches(corner, CLEAR_RGBA);
  int system_gl = system_gl_mapped();
  int ok = es3 && pixels_ok && native;
  char failed[64];
  snprintf(failed, sizeof failed, "%s%s%s", es3 ? "" : "\"es3\",", pixels_ok ? "" : "\"pixels\",",
           native ? "" : "\"backend\",");
  if (failed[0]) failed[strlen(failed) - 1] = '\0';
  printf(
      "{\"ok\":%s,\"failed\":[%s],\"eglFrom\":\"%s\",\"glVersion\":\"%s\",\"renderer\":\"%s\","
      "\"deviceExtensions\":\"%s\",\"expect\":\"%s\",\"nativeDevice\":\"%s\",\"center\":[%d,%d,%d,%d],"
      "\"corner\":[%d,%d,%d,%d],\"systemGlMapped\":%s}\n",
      ok ? "true" : "false", failed, loaded_from((void *)egl_get_proc_address), version ? version : "?",
      renderer ? renderer : "?", extensions, expect ? expect : "", native ? native : "", center[0], center[1],
      center[2], center[3], corner[0], corner[1], corner[2], corner[3], system_gl ? "true" : "false");
  return ok ? 0 : 1;
}
