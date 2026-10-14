// The Mac's frame ring (frames.h's Seam) and this run's one Ring; built only into a Mac's headless
// game (STUDIO_FRAMES), every other build compiles this file to nothing.
//
// Each slot is a one-plane BGRA8 IOSurface. ANGLE wraps it as a pbuffer on the display and context
// raylib made current (EGL_ANGLE_iosurface_client_buffer), bound to a texture that is a
// framebuffer's colour attachment, so a frame is one blit of the presented screen into the slot, a
// glFinish (the studio never reads a surface the GPU is still writing) and one mach message to the
// run's frames service, carrying a send right to the surface (frames_wire.h, the studio addon's own
// wire header). GL row 0 is the surface's first row: the image is stored bottom-up, and Live draws
// it in GL coordinates, unflipped. The EGL and GL entry points come from ANGLE's eglGetProcAddress,
// so this file needs no GL header and links nothing beyond what the headless build already links.
#include "frames.h"

#if STUDIO_FRAMES

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>

#include <array>
#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <string_view>

// Keep <windows.h>-style native types out, as platform.cpp does: the ring needs none.
#define EGL_NO_PLATFORM_SPECIFIC_TYPES 1
#include <EGL/egl.h>

#include "frames_wire.h"
#include "raylib.h"

namespace studio::frames {

namespace {

/** The variable an embedded run names its frames service in (the studio's `NativeEnv.FramesService`). */
constexpr const char* SERVICE_VARIABLE = "GENEX_FRAMES_SERVICE";
/**
 * How long a send may wait for room in the service's queue. Three slots never fill it; a studio
 * that stopped reading costs the game this much per frame, never a stall.
 */
constexpr mach_msg_timeout_t SEND_TIMEOUT_MS = 4;
/** GL errors a draw clears from before it, at most (raylib never reads them). */
constexpr int STALE_GL_ERRORS_MAX = 16;

// ANGLE's values (EGL/egl.h, EGL/eglext_angle.h, GLES3/gl3.h, GLES2/gl2ext.h) for what the ring passes.
namespace egl {
constexpr EGLint NONE = 0x3038;
constexpr EGLint RED_SIZE = 0x3024;
constexpr EGLint GREEN_SIZE = 0x3023;
constexpr EGLint BLUE_SIZE = 0x3022;
constexpr EGLint ALPHA_SIZE = 0x3021;
constexpr EGLint RENDERABLE_TYPE = 0x3040;
constexpr EGLint OPENGL_ES3_BIT = 0x0040;
constexpr EGLint SURFACE_TYPE = 0x3033;
constexpr EGLint PBUFFER_BIT = 0x0001;
constexpr EGLint BIND_TO_TEXTURE_RGBA = 0x303A;
constexpr EGLint TRUE_VALUE = 1;
constexpr EGLint WIDTH = 0x3057;
constexpr EGLint HEIGHT = 0x3056;
constexpr EGLint TEXTURE_TARGET = 0x3081;
constexpr EGLint TEXTURE_FORMAT = 0x3080;
constexpr EGLint TEXTURE_RGBA = 0x305E;
constexpr EGLint TEXTURE_2D = 0x305F;
constexpr EGLint BACK_BUFFER = 0x3084;
constexpr unsigned IOSURFACE_ANGLE = 0x3454;
constexpr EGLint IOSURFACE_PLANE_ANGLE = 0x345A;
constexpr EGLint TEXTURE_TYPE_ANGLE = 0x345C;
constexpr EGLint TEXTURE_INTERNAL_FORMAT_ANGLE = 0x345D;
constexpr EGLint BIND_TO_TEXTURE_TARGET_ANGLE = 0x348D;
/** GL_BGRA_EXT and GL_UNSIGNED_BYTE, as the pbuffer's attributes carry them. */
constexpr EGLint BGRA_FORMAT = 0x80E1;
constexpr EGLint UNSIGNED_BYTE = 0x1401;
}  // namespace egl

namespace gl {
constexpr unsigned NO_ERROR_VALUE = 0;
constexpr unsigned TEXTURE_2D = 0x0DE1;
constexpr unsigned TEXTURE_RECTANGLE_ANGLE = 0x84F5;
constexpr unsigned TEXTURE_BINDING_2D = 0x8069;
constexpr unsigned TEXTURE_BINDING_RECTANGLE_ANGLE = 0x84F6;
constexpr unsigned FRAMEBUFFER = 0x8D40;
constexpr unsigned READ_FRAMEBUFFER = 0x8CA8;
constexpr unsigned DRAW_FRAMEBUFFER = 0x8CA9;
constexpr unsigned READ_FRAMEBUFFER_BINDING = 0x8CAA;
constexpr unsigned DRAW_FRAMEBUFFER_BINDING = 0x8CA6;
constexpr unsigned COLOR_ATTACHMENT0 = 0x8CE0;
constexpr unsigned FRAMEBUFFER_COMPLETE = 0x8CD5;
constexpr unsigned COLOR_BUFFER_BIT = 0x4000;
constexpr unsigned LINEAR = 0x2601;
constexpr unsigned SCISSOR_TEST = 0x0C11;
}  // namespace gl

/** The EGL and GL entry points the ring calls, from ANGLE's eglGetProcAddress. Handles are ANGLE's opaque pointers. */
struct Calls {
  void* (*currentContext)() = nullptr;
  EGLBoolean (*chooseConfig)(EGLDisplay, const EGLint*, void**, EGLint, EGLint*) = nullptr;
  EGLBoolean (*configAttrib)(EGLDisplay, void*, EGLint, EGLint*) = nullptr;
  void* (*pbufferFromClientBuffer)(EGLDisplay, unsigned, void*, void*, const EGLint*) = nullptr;
  EGLBoolean (*bindTexImage)(EGLDisplay, void*, EGLint) = nullptr;
  EGLBoolean (*releaseTexImage)(EGLDisplay, void*, EGLint) = nullptr;
  EGLBoolean (*destroySurface)(EGLDisplay, void*) = nullptr;
  void (*genTextures)(int, unsigned*) = nullptr;
  void (*deleteTextures)(int, const unsigned*) = nullptr;
  void (*bindTexture)(unsigned, unsigned) = nullptr;
  void (*genFramebuffers)(int, unsigned*) = nullptr;
  void (*deleteFramebuffers)(int, const unsigned*) = nullptr;
  void (*bindFramebuffer)(unsigned, unsigned) = nullptr;
  void (*framebufferTexture2D)(unsigned, unsigned, unsigned, unsigned, int) = nullptr;
  unsigned (*checkFramebufferStatus)(unsigned) = nullptr;
  void (*blitFramebuffer)(int, int, int, int, int, int, int, int, unsigned, unsigned) = nullptr;
  void (*clearColor)(float, float, float, float) = nullptr;
  void (*clear)(unsigned) = nullptr;
  void (*finish)() = nullptr;
  unsigned (*getError)() = nullptr;
  void (*getIntegerv)(unsigned, int*) = nullptr;
  unsigned char (*isEnabled)(unsigned) = nullptr;
  void (*enable)(unsigned) = nullptr;
  void (*disable)(unsigned) = nullptr;
};

/** `into` set to the entry point named `name`; false when ANGLE has none by that name. */
template <typename Function>
bool load(Function& into, const char* name) {
  into = reinterpret_cast<Function>(eglGetProcAddress(name));
  return into != nullptr;
}

/** Every entry point the ring calls, or false. */
bool loadCalls(Calls& c) {
  return load(c.currentContext, "eglGetCurrentContext") && load(c.chooseConfig, "eglChooseConfig") &&
         load(c.configAttrib, "eglGetConfigAttrib") &&
         load(c.pbufferFromClientBuffer, "eglCreatePbufferFromClientBuffer") &&
         load(c.bindTexImage, "eglBindTexImage") && load(c.releaseTexImage, "eglReleaseTexImage") &&
         load(c.destroySurface, "eglDestroySurface") && load(c.genTextures, "glGenTextures") &&
         load(c.deleteTextures, "glDeleteTextures") && load(c.bindTexture, "glBindTexture") &&
         load(c.genFramebuffers, "glGenFramebuffers") && load(c.deleteFramebuffers, "glDeleteFramebuffers") &&
         load(c.bindFramebuffer, "glBindFramebuffer") && load(c.framebufferTexture2D, "glFramebufferTexture2D") &&
         load(c.checkFramebufferStatus, "glCheckFramebufferStatus") && load(c.blitFramebuffer, "glBlitFramebuffer") &&
         load(c.clearColor, "glClearColor") && load(c.clear, "glClear") && load(c.finish, "glFinish") &&
         load(c.getError, "glGetError") && load(c.getIntegerv, "glGetIntegerv") && load(c.isEnabled, "glIsEnabled") &&
         load(c.enable, "glEnable") && load(c.disable, "glDisable");
}

/** Whether `name` is a frames service name: the wire prefix, then a run id of letters, digits and `-`. */
bool isServiceName(std::string_view name) {
  std::string_view prefix = GXF_SERVICE_PREFIX;
  if (!name.starts_with(prefix)) return false;
  std::string_view id = name.substr(prefix.size());
  if (id.size() < GXF_RUN_ID_MIN || id.size() > GXF_RUN_ID_MAX) return false;
  for (char c : id) {
    bool plain = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-';
    if (!plain) return false;
  }
  return true;
}

void setNumber(CFMutableDictionaryRef properties, CFStringRef key, std::int32_t value) {
  CFNumberRef number = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &value);
  CFDictionarySetValue(properties, key, number);
  CFRelease(number);
}

/** A one-plane BGRA8 IOSurface of `width` x `height`, or null. */
IOSurfaceRef createSurface(int width, int height) {
  CFMutableDictionaryRef properties = CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
                                                                &kCFTypeDictionaryValueCallBacks);
  if (!properties) return nullptr;
  setNumber(properties, kIOSurfaceWidth, width);
  setNumber(properties, kIOSurfaceHeight, height);
  setNumber(properties, kIOSurfaceBytesPerElement, static_cast<std::int32_t>(GXF_BYTES_PER_PIXEL));
  setNumber(properties, kIOSurfacePixelFormat, static_cast<std::int32_t>(GXF_PIXEL_FORMAT_BGRA));
  IOSurfaceRef surface = IOSurfaceCreate(properties);
  CFRelease(properties);
  return surface;
}

/** The realtime clock in microseconds: what the studio compares its own receive time with. */
std::uint64_t realtimeMicroseconds() {
  timespec now{};
  clock_gettime(CLOCK_REALTIME, &now);
  return static_cast<std::uint64_t>(now.tv_sec) * 1000000u + static_cast<std::uint64_t>(now.tv_nsec) / 1000u;
}

/** The framebuffers, the texture and the scissor test as raylib left them, put back when this goes out of scope. */
class KeepGlState {
 public:
  KeepGlState(const Calls& gl, unsigned textureTarget, unsigned textureBinding) : gl_(gl), target_(textureTarget) {
    gl_.getIntegerv(gl::READ_FRAMEBUFFER_BINDING, &read_);
    gl_.getIntegerv(gl::DRAW_FRAMEBUFFER_BINDING, &draw_);
    gl_.getIntegerv(textureBinding, &texture_);
    scissor_ = gl_.isEnabled(gl::SCISSOR_TEST) != 0;
  }
  ~KeepGlState() {
    gl_.bindFramebuffer(gl::READ_FRAMEBUFFER, static_cast<unsigned>(read_));
    gl_.bindFramebuffer(gl::DRAW_FRAMEBUFFER, static_cast<unsigned>(draw_));
    gl_.bindTexture(target_, static_cast<unsigned>(texture_));
    if (scissor_) gl_.enable(gl::SCISSOR_TEST);
  }
  KeepGlState(const KeepGlState&) = delete;
  KeepGlState& operator=(const KeepGlState&) = delete;

 private:
  const Calls& gl_;
  unsigned target_;
  int read_ = 0;
  int draw_ = 0;
  int texture_ = 0;
  bool scissor_ = false;
};

/** One slot: its surface and what binds it to GL. */
struct Slot {
  IOSurfaceRef surface = nullptr;
  void* pbuffer = nullptr;
  unsigned texture = 0;
  unsigned framebuffer = 0;
};

/** The ring's seam on a Mac: IOSurfaces bound to GL through ANGLE, sent to the run's frames service. */
class MacSeam : public Seam {
 public:
  Made make(const SurfaceRequest& request) override {
    if (!connect()) return Made::NoService;
    if (!bindGl()) return failed("FRAMES: ANGLE cannot wrap an IOSurface on this context");
    width_ = request.width;
    height_ = request.height;
    for (int i = 0; i < request.slots; ++i) {
      if (!makeSlot(slots_[static_cast<std::size_t>(i)])) {
        drop();
        return failed("FRAMES: a ring slot could not be made");
      }
    }
    return Made::Ok;
  }

  bool draw(int index, const Blit& blit) override {
    const Slot& slot = slots_[static_cast<std::size_t>(index)];
    if (slot.framebuffer == 0) return false;
    KeepGlState kept(gl_, textureTarget_, textureBinding_);
    clearStaleErrors();
    gl_.bindFramebuffer(gl::READ_FRAMEBUFFER, 0);
    gl_.bindFramebuffer(gl::DRAW_FRAMEBUFFER, slot.framebuffer);
    gl_.disable(gl::SCISSOR_TEST);
    gl_.clearColor(0, 0, 0, 1);
    gl_.clear(gl::COLOR_BUFFER_BIT);
    // `into` is measured from the ring's top, GL from its bottom.
    int left = static_cast<int>(std::lround(blit.into.x));
    int right = static_cast<int>(std::lround(blit.into.x + blit.into.width));
    int bottom = static_cast<int>(std::lround(height_ - (blit.into.y + blit.into.height)));
    int top = static_cast<int>(std::lround(height_ - blit.into.y));
    gl_.blitFramebuffer(0, 0, blit.screenWidth, blit.screenHeight, left, bottom, right, top, gl::COLOR_BUFFER_BIT,
                        gl::LINEAR);
    gl_.finish();
    return gl_.getError() == gl::NO_ERROR_VALUE;
  }

  Sent send(const Frame& frame) override {
    const Slot& slot = slots_[static_cast<std::size_t>(frame.slot)];
    mach_port_t right = slot.surface ? IOSurfaceCreateMachPort(slot.surface) : MACH_PORT_NULL;
    if (right == MACH_PORT_NULL) return Sent::NotTaken;
    gxf_frame_msg message{};
    message.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
    message.header.msgh_size = sizeof message;
    message.header.msgh_remote_port = service_;
    message.header.msgh_id = GXF_MSG_ID_FRAME;
    message.body.msgh_descriptor_count = 1;
    message.surface.name = right;
    message.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    message.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    message.payload = payload(frame);
    kern_return_t sent = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof message, 0, MACH_PORT_NULL,
                                  SEND_TIMEOUT_MS, MACH_PORT_NULL);
    if (sent == MACH_MSG_SUCCESS) return Sent::Taken;
    if (sent == MACH_SEND_TIMED_OUT || sent == MACH_SEND_INTERRUPTED) {
      // Pseudo-received: the kernel copied the rights back out into `message` (the surface's under a
      // possibly new name), so the message itself is destroyed, as the addon's sender does.
      mach_msg_destroy(&message.header);
      return Sent::NotTaken;
    }
    // Never copied in: the right is still ours under its own name. The service is gone or refuses us.
    mach_port_deallocate(mach_task_self(), right);
    disconnect();
    return Sent::Gone;
  }

  void drop() override {
    for (Slot& slot : slots_) {
      if (slot.framebuffer != 0) gl_.deleteFramebuffers(1, &slot.framebuffer);
      if (slot.pbuffer) {
        gl_.releaseTexImage(display_, slot.pbuffer, egl::BACK_BUFFER);
        gl_.destroySurface(display_, slot.pbuffer);
      }
      if (slot.texture != 0) gl_.deleteTextures(1, &slot.texture);
      if (slot.surface) CFRelease(slot.surface);
      slot = Slot{};
    }
  }

  /** Let the service go (the game is closing). */
  void disconnect() {
    if (service_ != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), service_);
    service_ = MACH_PORT_NULL;
  }

 private:
  /** The run's frames service, looked up once; absent or refused leaves the game as it was. */
  bool connect() {
    if (service_ != MACH_PORT_NULL) return true;
    const char* name = std::getenv(SERVICE_VARIABLE);
    if (!name || !isServiceName(name)) return false;
    mach_port_t port = MACH_PORT_NULL;
    if (bootstrap_look_up(bootstrap_port, name, &port) != KERN_SUCCESS) return false;
    service_ = port;
    return true;
  }

  /** The current display and context, the entry points and a config whose pbuffers bind to textures. */
  bool bindGl() {
    display_ = eglGetCurrentDisplay();
    if (display_ == EGL_NO_DISPLAY) return false;
    if (!loaded_) loaded_ = loadCalls(gl_);
    if (!loaded_ || gl_.currentContext() == nullptr) return false;
    if (config_) return true;
    const EGLint attributes[] = {egl::RED_SIZE,
                                 8,
                                 egl::GREEN_SIZE,
                                 8,
                                 egl::BLUE_SIZE,
                                 8,
                                 egl::ALPHA_SIZE,
                                 8,
                                 egl::RENDERABLE_TYPE,
                                 egl::OPENGL_ES3_BIT,
                                 egl::SURFACE_TYPE,
                                 egl::PBUFFER_BIT,
                                 egl::BIND_TO_TEXTURE_RGBA,
                                 egl::TRUE_VALUE,
                                 egl::NONE};
    EGLint count = 0;
    if (!gl_.chooseConfig(display_, attributes, &config_, 1, &count) || count < 1) {
      config_ = nullptr;
      return false;
    }
    EGLint target = egl::TEXTURE_2D;
    gl_.configAttrib(display_, config_, egl::BIND_TO_TEXTURE_TARGET_ANGLE, &target);
    bindTarget_ = target;
    bool flat = target == egl::TEXTURE_2D;
    textureTarget_ = flat ? gl::TEXTURE_2D : gl::TEXTURE_RECTANGLE_ANGLE;
    textureBinding_ = flat ? gl::TEXTURE_BINDING_2D : gl::TEXTURE_BINDING_RECTANGLE_ANGLE;
    return true;
  }

  /** One slot: its surface, a pbuffer over it, a texture bound to the pbuffer and a framebuffer around the texture. */
  bool makeSlot(Slot& slot) {
    slot.surface = createSurface(width_, height_);
    if (!slot.surface) return false;
    const EGLint attributes[] = {egl::WIDTH,
                                 width_,
                                 egl::HEIGHT,
                                 height_,
                                 egl::IOSURFACE_PLANE_ANGLE,
                                 0,
                                 egl::TEXTURE_TARGET,
                                 bindTarget_,
                                 egl::TEXTURE_INTERNAL_FORMAT_ANGLE,
                                 egl::BGRA_FORMAT,
                                 egl::TEXTURE_FORMAT,
                                 egl::TEXTURE_RGBA,
                                 egl::TEXTURE_TYPE_ANGLE,
                                 egl::UNSIGNED_BYTE,
                                 egl::NONE};
    slot.pbuffer = gl_.pbufferFromClientBuffer(display_, egl::IOSURFACE_ANGLE, slot.surface, config_, attributes);
    if (!slot.pbuffer) return false;
    KeepGlState kept(gl_, textureTarget_, textureBinding_);
    gl_.genTextures(1, &slot.texture);
    gl_.bindTexture(textureTarget_, slot.texture);
    if (!gl_.bindTexImage(display_, slot.pbuffer, egl::BACK_BUFFER)) return false;
    gl_.genFramebuffers(1, &slot.framebuffer);
    gl_.bindFramebuffer(gl::FRAMEBUFFER, slot.framebuffer);
    gl_.framebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, textureTarget_, slot.texture, 0);
    return gl_.checkFramebufferStatus(gl::FRAMEBUFFER) == gl::FRAMEBUFFER_COMPLETE;
  }

  /** What the frame says about itself; the studio checks every field against the ring it announced. */
  static gxf_frame_payload payload(const Frame& frame) {
    gxf_frame_payload payload{};
    payload.magic = GXF_MAGIC;
    payload.version = GXF_WIRE_VERSION;
    payload.slot = static_cast<std::uint16_t>(frame.slot);
    payload.generation = frame.generation;
    payload.width = static_cast<std::uint32_t>(frame.width);
    payload.height = static_cast<std::uint32_t>(frame.height);
    payload.pixel_format = GXF_PIXEL_FORMAT_BGRA;
    payload.seq = frame.seq;
    payload.ts_us = frame.timestampUs;
    return payload;
  }

  /** A GL error raylib left pending is not this copy's: clear it first (raylib never reads them). */
  void clearStaleErrors() {
    for (int i = 0; i < STALE_GL_ERRORS_MAX; ++i) {
      if (gl_.getError() == gl::NO_ERROR_VALUE) return;
    }
  }

  /** Say why the ring could not be made, through raylib's log as every runtime warning goes. */
  Made failed(const char* why) {
    TraceLog(LOG_WARNING, "%s", why);
    return Made::Failed;
  }

  mach_port_t service_ = MACH_PORT_NULL;
  Calls gl_;
  bool loaded_ = false;
  EGLDisplay display_ = EGL_NO_DISPLAY;
  void* config_ = nullptr;
  EGLint bindTarget_ = egl::TEXTURE_2D;
  unsigned textureTarget_ = gl::TEXTURE_2D;
  unsigned textureBinding_ = gl::TEXTURE_BINDING_2D;
  int width_ = 0;
  int height_ = 0;
  std::array<Slot, MAX_SLOTS> slots_{};
};

/** The seam this run's ring stands on. Never destroyed: its GL objects go in close(), while the context lives. */
MacSeam& seam() {
  static MacSeam* mac = new MacSeam();
  return *mac;
}

Ring& ring() {
  static Ring* only = new Ring(seam());
  return *only;
}

}  // namespace

protocol::Answer surface(const json::Value& arg) { return ring().surface(arg); }

protocol::Answer release(const json::Value& arg) { return ring().release(arg); }

void changed() { ring().changed(); }

void present(int screenWidth, int screenHeight) {
  (void)ring().present(screenWidth, screenHeight, realtimeMicroseconds());
}

bool active() { return ring().active(); }

json::Value input(const json::Value& arg, int screenWidth, int screenHeight) {
  return ring().input(arg, screenWidth, screenHeight);
}

void close() {
  ring().close();
  seam().disconnect();
}

}  // namespace studio::frames

#endif
