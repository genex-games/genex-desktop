// The only randomness a simulation may use: PCG32 (O'Neill's pcg32_random_r, XSH RR 64/32),
// seeded by the studio's seed(n) and handed to update() as ctx.rng. Same seed, same stream, on
// every destination. raylib-free.
#pragma once

#include <cstdint>

namespace studio {

/** A PCG32 stream. */
class Rng {
 public:
  /** The stream the studio seeds when a game names none. */
  static constexpr std::uint64_t DEFAULT_SEQUENCE = 54;

  explicit Rng(std::uint64_t seed = 1, std::uint64_t sequence = DEFAULT_SEQUENCE) { reseed(seed, sequence); }

  /** Restart the stream, exactly as pcg32_srandom_r does. */
  void reseed(std::uint64_t seed, std::uint64_t sequence = DEFAULT_SEQUENCE) {
    state_ = 0;
    increment_ = (sequence << 1u) | 1u;
    next();
    state_ += seed;
    next();
  }

  /** The next 32 random bits. */
  std::uint32_t next() {
    std::uint64_t old = state_;
    state_ = old * MULTIPLIER + increment_;
    auto shifted = static_cast<std::uint32_t>(((old >> 18u) ^ old) >> 27u);
    auto rotation = static_cast<std::uint32_t>(old >> 59u);
    return (shifted >> rotation) | (shifted << ((32u - rotation) & 31u));
  }

  /** Uniform in [0, bound), without modulo bias; 0 when `bound` is 0. */
  std::uint32_t below(std::uint32_t bound) {
    if (bound == 0) return 0;
    std::uint32_t threshold = (0u - bound) % bound;
    for (;;) {
      std::uint32_t value = next();
      if (value >= threshold) return value % bound;
    }
  }

  /** Uniform in [lo, hi], both ends included (the ends may come in either order). */
  int nextInt(int lo, int hi) {
    if (hi < lo) return nextInt(hi, lo);
    auto span = static_cast<std::uint32_t>(static_cast<std::int64_t>(hi) - lo + 1);
    if (span == 0) return static_cast<int>(next());  // the whole int range
    return static_cast<int>(static_cast<std::int64_t>(lo) + below(span));
  }

  /** Uniform in [0, 1): 24 random bits, so every value is exact in a float. */
  float unit() { return static_cast<float>(next() >> 8) * (1.0f / 16777216.0f); }

  /** Uniform in [lo, hi). */
  float nextFloat(float lo, float hi) { return lo + (hi - lo) * unit(); }

  /** True with probability `p`. */
  bool chance(float p) { return unit() < p; }

 private:
  static constexpr std::uint64_t MULTIPLIER = 6364136223846793005ULL;
  std::uint64_t state_ = 0;
  std::uint64_t increment_ = 0;
};

}  // namespace studio
