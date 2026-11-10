// Other entities drawn on the tick timeline (PROTOCOL.md §17.11 *Drawing other seats*), a port of
// packages/multiplayer/src/authority/tick-drawing.ts (and of Unity's TickDrawing.cs), held to the
// TypeScript's own test cases by core/tools/tick_drawing_check.cpp.
//
// In a predicting room every patch is one keyframe, so each sample is timed by its keyframe's tick, not
// by the patch's server stamp: the stamp is the room clock at the fixed step's call that ran the tick
// (late by up to a tick, and shared by every tick a late call caught up), which at 60 keyframes a
// second made a remote car's drawn speed jump from segment to segment. An entity a keyframe left
// unchanged held its fields since the keyframe before, so a sample after a gap first repeats the last
// one a keyframe period before it. A new life (an epoch change: a respawn or a kickoff's teleport) is
// never interpolated into: between the old life's last sample and the new one's first the old pose
// holds. Pure and transport-free: the session feeds it keyframe samples and asks for poses at its
// render time.
//
// Differences from the TypeScript, by shape only: keys are entity ids (strings), not the entity
// objects; a sample at a NaN or infinite instant is ignored (the TypeScript would append it out of
// order) and a NaN render time draws the newest sample (the TypeScript would draw NaN); At also gives the life the drawn pose belongs to, so the session's output spring snaps on
// the very frame the drawn pose changes life.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace genex {

/** A drawn pose: position, the heading (unwrapped: each sample folded onto the last along the short
 *  arc), and a firstperson body's aim pitch and duck. */
struct TickPose {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double yaw = 0.0;
  double pitch = 0.0;
  double duck = 0.0;
};

/** What TickDrawing::At draws: the pose and the life (epoch) it belongs to. */
struct TickDrawn {
  TickPose pose;
  double life = 0.0;
};

/** Each entity's keyframe samples, by id, and its pose at a render time. */
class GENEX_CORE_API TickDrawing {
 public:
  /** Samples kept per entity: a little over a second at 60 keyframes a second. */
  static constexpr std::size_t kRing = 80;

  /**
   * Entity `key`'s fields at the keyframe of instant `t` (ms on the room clock), in its life `life` (its
   * epoch). `period` is the time between keyframes: a sample more than one and a half periods after the
   * last of the same life first repeats the last one a period before `t` (the entity held still
   * meanwhile). A sample not after the last, or at a NaN or infinite instant, changes nothing.
   */
  void Push(const std::string& key, double t, const TickPose& pose, double period, double life = 0.0);

  /** Entity `key` at render time `target`, between the two samples around it (never across lives: the
   *  old one holds until the new one's first sample); held at the oldest or newest outside them; none
   *  before its first sample. */
  std::optional<TickDrawn> At(const std::string& key, double target) const;

  /** Forgets an entity's samples (its id now names another entity, or none). */
  void Forget(const std::string& key);
  /** Forgets every entity's samples. */
  void Clear();
  /** How many samples entity `key` holds (0: none). */
  std::size_t Count(const std::string& key) const;

 private:
  struct Sample {
    double t = 0.0;
    double life = 0.0;
    TickPose pose;
  };
  std::map<std::string, std::vector<Sample>> rings_;
};

}  // namespace genex
