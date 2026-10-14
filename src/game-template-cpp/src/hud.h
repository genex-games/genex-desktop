// The game's only UI: text, bars, a crosshair and a flash, drawn inside the frame (into the world
// texture, tagged "hud") so a capture sees exactly what a player sees. Call these from draw():
// the HUD is immediate, rebuilt every rendered frame, and state().hud reports the last one.
#pragma once

#include "json.h"
#include "raylib.h"

namespace studio::hud {

/** Text at (x, y) in world pixels, y down. */
void text(const char* text, int x, int y, int size = 20, Color color = RAYWHITE);
/** A bar filled to `fraction` (clamped to 0..1); `id` names it in state().hud. */
void bar(const char* id, float fraction, int x = 16, int y = 16, int width = 200, int height = 12,
         Color color = GOLD);
/** A crosshair at the centre of the frame, until it is turned off. */
void crosshair(bool visible = true, int size = 10, Color color = RAYWHITE);
/** Cover the frame with `color` at `alpha`, fading over the next frames (a hit, a pickup). */
void flash(Color color, float alpha);

/** The runtime's side: draw this frame's items into the world texture and remember them. */
void drawFrame(int worldWidth, int worldHeight);
/** `{items, crosshair, flash}` for the last drawn frame, plus `notice` while the runtime shows one. */
json::Value summary();
/** Forget every item, the crosshair and the flash (seed does); a notice stays. */
void reset();

/**
 * The runtime's own notice that the game is drawn on the CPU (a software device such as
 * SwiftShader, D17): drawn over every frame from then on, so players and captures both see it.
 */
void cpuFallback(bool shown);

}  // namespace studio::hud
