/*
 * A stand-in for a Mac game's executable, as the lane links one: it imports libEGL and libGLESv2
 * through @rpath (MAC_ANGLE_IMPORTS) and carries one LC_RPATH, @executable_path/../Frameworks.
 * Built at test time by tests/conformance/native-bundle.test.ts with `xcrun clang` against the stub
 * libraries beside it; at run time the loader binds whatever the host put in Contents/Frameworks.
 *
 * It initializes EGL's default display once and writes one JSON line to the protocol pipe
 * (GENEX_STUDIO_FD): whether EGL initialized, its version and vendor. Then it exits 0.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void *EGLDisplay;
typedef unsigned int EGLBoolean;
typedef int EGLint;

#define EGL_VENDOR 0x3053
#define GL_VENDOR 0x1F00

extern EGLDisplay eglGetDisplay(void *native_display);
extern EGLBoolean eglInitialize(EGLDisplay display, EGLint *major, EGLint *minor);
extern const char *eglQueryString(EGLDisplay display, EGLint name);
extern EGLBoolean eglTerminate(EGLDisplay display);
extern const unsigned char *glGetString(unsigned int name);

/* The vendor string with anything JSON would need escaped replaced, so the line stays one object. */
static void plain(const char *text, char *out, size_t size) {
  size_t at = 0;
  for (const char *c = text ? text : ""; *c && at + 1 < size; c++) out[at++] = (*c == '"' || *c == '\\' || *c < 0x20) ? '_' : *c;
  out[at] = '\0';
}

int main(void) {
  const char *fd_text = getenv("GENEX_STUDIO_FD");
  int fd = fd_text ? atoi(fd_text) : 1;
  EGLDisplay display = eglGetDisplay((void *)0);
  EGLint major = 0, minor = 0;
  EGLBoolean ok = display ? eglInitialize(display, &major, &minor) : 0;
  char vendor[256];
  plain(ok ? eglQueryString(display, EGL_VENDOR) : "", vendor, sizeof vendor);
  /* Referenced so the link keeps libGLESv2 as an import; there is no context to call it in. */
  int gles = &glGetString != NULL;
  char line[512];
  int length = snprintf(line, sizeof line, "{\"egl\":%d,\"major\":%d,\"minor\":%d,\"vendor\":\"%s\",\"gles\":%d}\n",
                        ok ? 1 : 0, major, minor, vendor, gles);
  if (length > 0) (void)write(fd, line, (size_t)length);
  if (ok) eglTerminate(display);
  return 0;
}
