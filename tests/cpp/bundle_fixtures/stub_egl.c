/*
 * A stub libEGL for linking tests/cpp/bundle_fixtures/exe.c: built as a dylib whose install name is
 * @rpath/libEGL.dylib, exactly as the store's Metal-only ANGLE names itself. It links nothing but
 * libSystem, so it also serves as a store copy in rows that have no real ANGLE.
 */
typedef void *EGLDisplay;
typedef unsigned int EGLBoolean;
typedef int EGLint;

static int stub_display;

EGLDisplay eglGetDisplay(void *native_display) {
  (void)native_display;
  return &stub_display;
}

EGLBoolean eglInitialize(EGLDisplay display, EGLint *major, EGLint *minor) {
  if (display != &stub_display) return 0;
  if (major) *major = 1;
  if (minor) *minor = 5;
  return 1;
}

const char *eglQueryString(EGLDisplay display, EGLint name) {
  (void)display;
  (void)name;
  return "genex stub";
}

EGLBoolean eglTerminate(EGLDisplay display) {
  return display == &stub_display;
}
