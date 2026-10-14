/*
 * A stub libGLESv2 for linking tests/cpp/bundle_fixtures/exe.c: built as a dylib whose install name
 * is @rpath/libGLESv2.dylib. A build that leaves a copy of it in `out/` shows the host ignores
 * build-supplied libraries and copies the store's.
 */
const unsigned char *glGetString(unsigned int name) {
  (void)name;
  return (const unsigned char *)"genex stub";
}
