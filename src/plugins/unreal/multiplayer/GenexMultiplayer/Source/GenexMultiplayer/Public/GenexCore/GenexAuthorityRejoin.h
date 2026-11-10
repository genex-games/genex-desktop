// Drain and rejoin (PROTOCOL.md §17.13): which close sends a seat back into play by itself, which refusal
// ends the rejoin, and each attempt's wait, region and way in. Pure, as the TypeScript's rejoin.ts;
// core/tools/authority_rejoin_check.cpp holds authority-rejoin.json exactly, as every SDK does.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <optional>

namespace genex::rejoin {

/** Waits before each attempt, ms; past the end the last one repeats. */
inline constexpr double kScheduleMs[] = {0.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0};
inline constexpr std::size_t kScheduleSteps = sizeof(kScheduleMs) / sizeof(kScheduleMs[0]);
/** Each wait adds up to this much, by chance, so a room's seats do not arrive at once. */
inline constexpr double kJitterMs = 250.0;
/** How long a seat keeps trying: long enough for a roll's next process to come up on a full node. */
inline constexpr double kBudgetMs = 180000.0;
/** How long a seat stays with its own region before it tries the next one. */
inline constexpr double kRegionStayMs = 60000.0;
/** How long a public seat looks for its room's successor before it joins the game's pool. */
inline constexpr double kSuccessorMs = 90000.0;
/** `Draining` when an older server does not say how long the room has. */
inline constexpr double kUnknownCloseMs = -1.0;

/** The ways back: the lost room by its id (a socket drop, where it may still live), its successor, or
 *  the game's pool. */
enum class Way { Room, Successor, Pool };

enum class Stop { None, Final, Budget };

/** The closes a seat comes back from: the server's trouble, never the game's or the player's. */
inline bool ComesBackAfter(int code) {
  switch (code) {
    case 1001:
    case 1005:
    case 1006:
    case 1011:
    case 1012:
    case 1013:
    case 4001:
    case 4003:
    case 4010:
      return true;
    default:
      return false;
  }
}

/** The refusals a retry cannot change: a bad join, no entitlement, a game taken down, no module, an SDK
 *  too old. A full server, a quota, an expired token and a matchmaker shutting down all go on. */
inline bool RefusalIsFinal(int code) {
  return code == 400 || code == 402 || code == 403 || code == 424 || code == 426;
}

/** What an attempt is decided from. */
struct Input {
  /** Attempts already made. */
  int attempt = 0;
  /** Since the close, ms. */
  double elapsedMs = 0.0;
  /** What the last attempt was refused with; none yet, or a failed network: empty. */
  std::optional<int> refusal;
  /** The close that started this rejoin. */
  int lostCode = 0;
  /** The lost room was private: its seats keep to its successor. */
  bool closed = false;
  /** How many regions the client knows. */
  std::size_t regions = 0;
  /** A number in [0, 1): the attempt's share of the jitter window. */
  double jitter = 0.0;
};

/** The next attempt of a rejoin, or why there is none (`stop`). */
struct Step {
  Stop stop = Stop::None;
  double waitMs = 0.0;
  std::size_t region = 0;
  Way way = Way::Successor;
};

inline Step NextStep(const Input& input) {
  Step step;
  if (input.refusal.has_value() && RefusalIsFinal(*input.refusal)) {
    step.stop = Stop::Final;
    return step;
  }
  if (input.elapsedMs >= kBudgetMs) {
    step.stop = Stop::Budget;
    return step;
  }
  const std::size_t at = std::min(static_cast<std::size_t>(std::max(input.attempt, 0)), kScheduleSteps - 1);
  step.waitMs = kScheduleMs[at] + std::floor(input.jitter * kJitterMs);
  if (input.attempt == 0 && input.lostCode != 4001) {
    step.way = Way::Room;
    return step;
  }
  step.region = input.regions < 1 ? 0 : static_cast<std::size_t>(std::floor(input.elapsedMs / kRegionStayMs)) % input.regions;
  step.way = input.closed || input.elapsedMs < kSuccessorMs ? Way::Successor : Way::Pool;
  return step;
}

}  // namespace genex::rejoin
