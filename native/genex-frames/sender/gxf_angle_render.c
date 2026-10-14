#include "gxf_angle_render.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <EGL/eglext_angle.h>
#include <GLES3/gl3.h>
#include <stdlib.h>
#include <string.h>

#ifndef GL_BGRA_EXT
#define GL_BGRA_EXT 0x80E1
#endif
#ifndef GL_TEXTURE_RECTANGLE_ANGLE
#define GL_TEXTURE_RECTANGLE_ANGLE 0x84F5
#endif

struct gxf_angle {
  EGLDisplay display;
  EGLConfig config;
  EGLContext context;
  GLuint program;
  GLint seq_location;
  GLint height_location;
  uint32_t width, height, slots;
  EGLSurface pbuffers[GXF_MAX_SLOTS];
  GLuint textures[GXF_MAX_SLOTS];
  GLuint framebuffers[GXF_MAX_SLOTS];
  GLenum texture_target;
  EGLint bind_target;
  char renderer[128];
};

static const char* VERTEX =
    "#version 300 es\n"
    "const vec2 p[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));\n"
    "void main() { gl_Position = vec4(p[gl_VertexID], 0.0, 1.0); }\n";

/* The test sender's pattern (pattern_pixel), for image row y = height-1-gl_FragCoord.y: GL row 0
 * is IOSurface row 0, which a reader sees as the bottom of the image. */
static const char* FRAGMENT =
    "#version 300 es\n"
    "precision highp float;\n"
    "precision highp int;\n"
    "uniform uint seq;\n"
    "uniform int height;\n"
    "out vec4 color;\n"
    "void main() {\n"
    "  uint x = uint(gl_FragCoord.x);\n"
    "  uint y = uint(height - 1 - int(gl_FragCoord.y));\n"
    "  uint r = (x + 3u * seq) & 255u;\n"
    "  uint g = (y + 5u * seq) & 255u;\n"
    "  uint b = ((x >> 8u) * 64u + (y >> 8u) * 16u + 7u * seq) & 255u;\n"
    "  color = vec4(float(r), float(g), float(b), 255.0) / 255.0;\n"
    "}\n";

static GLuint compile(GLenum type, const char* source) {
  GLuint shader = glCreateShader(type);
  glShaderSource(shader, 1, &source, NULL);
  glCompileShader(shader);
  GLint ok = 0;
  glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    glDeleteShader(shader);
    return 0;
  }
  return shader;
}

static int build_program(gxf_angle* a) {
  GLuint vs = compile(GL_VERTEX_SHADER, VERTEX), fs = compile(GL_FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return -1;
  a->program = glCreateProgram();
  glAttachShader(a->program, vs);
  glAttachShader(a->program, fs);
  glLinkProgram(a->program);
  glDeleteShader(vs);
  glDeleteShader(fs);
  GLint ok = 0;
  glGetProgramiv(a->program, GL_LINK_STATUS, &ok);
  if (!ok) return -1;
  a->seq_location = glGetUniformLocation(a->program, "seq");
  a->height_location = glGetUniformLocation(a->program, "height");
  return 0;
}

gxf_angle* gxf_angle_create(int* egl_error) {
  gxf_angle* a = calloc(1, sizeof *a);
  if (a == NULL) return NULL;
  const EGLAttrib display_attrs[] = {EGL_PLATFORM_ANGLE_TYPE_ANGLE, EGL_PLATFORM_ANGLE_TYPE_METAL_ANGLE, EGL_NONE};
  a->display = eglGetPlatformDisplay(EGL_PLATFORM_ANGLE_ANGLE, (void*)EGL_DEFAULT_DISPLAY, display_attrs);
  EGLint major = 0, minor = 0, count = 0;
  const EGLint config_attrs[] = {EGL_RED_SIZE,
                                 8,
                                 EGL_GREEN_SIZE,
                                 8,
                                 EGL_BLUE_SIZE,
                                 8,
                                 EGL_ALPHA_SIZE,
                                 8,
                                 EGL_RENDERABLE_TYPE,
                                 EGL_OPENGL_ES3_BIT,
                                 EGL_SURFACE_TYPE,
                                 EGL_PBUFFER_BIT,
                                 EGL_BIND_TO_TEXTURE_RGBA,
                                 EGL_TRUE,
                                 EGL_NONE};
  const EGLint context_attrs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE};
  if (a->display == EGL_NO_DISPLAY || !eglInitialize(a->display, &major, &minor) ||
      !eglChooseConfig(a->display, config_attrs, &a->config, 1, &count) || count < 1) {
    *egl_error = eglGetError();
    free(a);
    return NULL;
  }
  a->context = eglCreateContext(a->display, a->config, EGL_NO_CONTEXT, context_attrs);
  if (a->context == EGL_NO_CONTEXT || !eglMakeCurrent(a->display, EGL_NO_SURFACE, EGL_NO_SURFACE, a->context) ||
      build_program(a) != 0) {
    *egl_error = eglGetError();
    gxf_angle_destroy(a);
    return NULL;
  }
  eglGetConfigAttrib(a->display, a->config, EGL_BIND_TO_TEXTURE_TARGET_ANGLE, &a->bind_target);
  a->texture_target = a->bind_target == EGL_TEXTURE_2D ? GL_TEXTURE_2D : GL_TEXTURE_RECTANGLE_ANGLE;
  const char* renderer = (const char*)glGetString(GL_RENDERER);
  strncpy(a->renderer, renderer ? renderer : "?", sizeof a->renderer - 1);
  return a;
}

static void unbind_ring(gxf_angle* a) {
  for (uint32_t i = 0; i < GXF_MAX_SLOTS; i++) {
    if (a->framebuffers[i]) glDeleteFramebuffers(1, &a->framebuffers[i]);
    if (a->pbuffers[i] != EGL_NO_SURFACE && a->pbuffers[i] != NULL) {
      eglReleaseTexImage(a->display, a->pbuffers[i], EGL_BACK_BUFFER);
      eglDestroySurface(a->display, a->pbuffers[i]);
    }
    if (a->textures[i]) glDeleteTextures(1, &a->textures[i]);
    a->framebuffers[i] = a->textures[i] = 0;
    a->pbuffers[i] = EGL_NO_SURFACE;
  }
}

int gxf_angle_bind_ring(gxf_angle* a, const gxf_ring* ring) {
  unbind_ring(a);
  a->width = ring->width;
  a->height = ring->height;
  a->slots = ring->slots;
  for (uint32_t i = 0; i < ring->slots; i++) {
    const EGLint attrs[] = {EGL_WIDTH,
                            (EGLint)ring->width,
                            EGL_HEIGHT,
                            (EGLint)ring->height,
                            EGL_IOSURFACE_PLANE_ANGLE,
                            0,
                            EGL_TEXTURE_TARGET,
                            a->bind_target,
                            EGL_TEXTURE_INTERNAL_FORMAT_ANGLE,
                            GL_BGRA_EXT,
                            EGL_TEXTURE_FORMAT,
                            EGL_TEXTURE_RGBA,
                            EGL_TEXTURE_TYPE_ANGLE,
                            GL_UNSIGNED_BYTE,
                            EGL_NONE};
    a->pbuffers[i] = eglCreatePbufferFromClientBuffer(a->display, EGL_IOSURFACE_ANGLE,
                                                      (EGLClientBuffer)ring->surfaces[i], a->config, attrs);
    if (a->pbuffers[i] == EGL_NO_SURFACE) return -1;
    glGenTextures(1, &a->textures[i]);
    glBindTexture(a->texture_target, a->textures[i]);
    if (!eglBindTexImage(a->display, a->pbuffers[i], EGL_BACK_BUFFER)) return -2;
    glGenFramebuffers(1, &a->framebuffers[i]);
    glBindFramebuffer(GL_FRAMEBUFFER, a->framebuffers[i]);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, a->texture_target, a->textures[i], 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) return -3;
  }
  return 0;
}

int gxf_angle_draw(gxf_angle* a, uint32_t slot, uint64_t seq, gxf_angle_sync sync) {
  if (slot >= a->slots) return -1;
  glBindFramebuffer(GL_FRAMEBUFFER, a->framebuffers[slot]);
  glViewport(0, 0, (GLsizei)a->width, (GLsizei)a->height);
  glUseProgram(a->program);
  glUniform1ui(a->seq_location, (GLuint)seq);
  glUniform1i(a->height_location, (GLint)a->height);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  if (sync == GXF_ANGLE_SYNC_FINISH) {
    glFinish();
  } else {
    glFlush();
  }
  return glGetError() == GL_NO_ERROR ? 0 : -2;
}

const char* gxf_angle_renderer(const gxf_angle* a) { return a->renderer; }

void gxf_angle_destroy(gxf_angle* a) {
  if (a == NULL) return;
  if (a->display != EGL_NO_DISPLAY) {
    unbind_ring(a);
    if (a->program) glDeleteProgram(a->program);
    eglMakeCurrent(a->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (a->context != EGL_NO_CONTEXT) eglDestroyContext(a->display, a->context);
    eglTerminate(a->display);
  }
  free(a);
}
