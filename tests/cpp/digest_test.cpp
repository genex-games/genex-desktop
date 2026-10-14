// Rows for src/digest.h: FNV-1a 64, the digest a capture reports and the host recomputes. The
// `print` row writes the digest of a known buffer so the runner can check it against its own
// computation. Run with no argument for every row, or with a row name for one.
#include <cassert>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "digest.h"

namespace {

void known() {
  // The published FNV-1a 64 test vectors.
  assert(studio::fnv1a64(std::string_view("")) == 0xcbf29ce484222325ULL);
  assert(studio::fnv1a64(std::string_view("a")) == 0xaf63dc4c8601ec8cULL);
  assert(studio::fnv1a64(std::string_view("foobar")) == 0x85944171f73967e8ULL);
  static_assert(studio::fnv1a64(std::string_view("a")) == 0xaf63dc4c8601ec8cULL, "usable at compile time");
  assert(studio::hex64(0xaf63dc4c8601ec8cULL) == "af63dc4c8601ec8c");
  assert(studio::hex64(1) == "0000000000000001");
}

void chained() {
  const char text[] = "genex capture";
  std::uint64_t whole = studio::fnv1a64(text, sizeof text - 1);
  std::uint64_t half = studio::fnv1a64(text, 6);
  assert(studio::fnv1a64(text + 6, sizeof text - 7, half) == whole);
}

/** The digest of 4096 bytes, byte i = (i * 31 + 7) mod 256: a BGRA-sized buffer the runner rebuilds. */
void print() {
  std::vector<unsigned char> bytes(4096);
  for (std::size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<unsigned char>((i * 31 + 7) % 256);
  std::printf("digest %s\n", studio::hex64(studio::fnv1a64(bytes.data(), bytes.size())).c_str());
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"known", known},
    {"chained", chained},
    {"print", print},
};

}  // namespace

int main(int argc, char** argv) {
  int ran = 0;
  for (const Row& row : ROWS) {
    if (argc > 1 && std::strcmp(argv[1], row.name) != 0) continue;
    row.run();
    std::printf("ok %s\n", row.name);
    ++ran;
  }
  if (ran > 0) return 0;
  std::fprintf(stderr, "no row named %s\n", argc > 1 ? argv[1] : "(none)");
  return 2;
}
