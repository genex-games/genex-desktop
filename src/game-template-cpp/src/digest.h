// FNV-1a 64: the digest a capture reports for its pixels (the host recomputes it before it trusts
// the file) and the checksum state() reports for the simulation. raylib-free.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace studio {

inline constexpr std::uint64_t FNV_OFFSET_BASIS = 0xcbf29ce484222325ULL;
inline constexpr std::uint64_t FNV_PRIME = 0x100000001b3ULL;

/** FNV-1a 64 of `bytes`, continuing from `hash` (so a digest can be taken in pieces). */
constexpr std::uint64_t fnv1a64(std::string_view bytes, std::uint64_t hash = FNV_OFFSET_BASIS) {
  for (char byte : bytes) {
    hash ^= static_cast<unsigned char>(byte);
    hash *= FNV_PRIME;
  }
  return hash;
}

/** FNV-1a 64 of `size` bytes at `data`, continuing from `hash`. */
inline std::uint64_t fnv1a64(const void* data, std::size_t size, std::uint64_t hash = FNV_OFFSET_BASIS) {
  const auto* bytes = static_cast<const unsigned char*>(data);
  for (std::size_t i = 0; i < size; ++i) {
    hash ^= bytes[i];
    hash *= FNV_PRIME;
  }
  return hash;
}

/** `value` as 16 lowercase hex digits, the way the host writes a digest. */
inline std::string hex64(std::uint64_t value) {
  static constexpr char DIGITS[] = "0123456789abcdef";
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) {
    out[static_cast<std::size_t>(i)] = DIGITS[value & 0xF];
    value >>= 4;
  }
  return out;
}

}  // namespace studio
