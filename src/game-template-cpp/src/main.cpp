// The game's entry. The starter below only proves the pipeline: a textured floor and one textured
// block, so the very first frame shows something drawn. Replace it with the game in the brief, and
// keep two things: studio::install(...) at the end of main(), and the FACET WIRING block, where
// every other facet adds exactly one line.
#include <utility>

#include "studio.h"

namespace {

/** The starter's GPU resources, built once the window exists. */
struct Starter {
  Texture2D checker{};
  Model floor{};
  Model block{};
  float spin = 0;
};

Starter starter;

/** A procedural checker, mipmapped: a flat colour with no texture is a defect even in a starter. */
Texture2D checkerTexture() {
  Image image = GenImageChecked(256, 256, 32, 32, Color{196, 164, 120, 255}, Color{120, 88, 60, 255});
  Texture2D texture = LoadTextureFromImage(image);
  UnloadImage(image);
  GenTextureMipmaps(&texture);
  SetTextureFilter(texture, TEXTURE_FILTER_TRILINEAR);
  return texture;
}

void buildStarter() {
  starter.checker = checkerTexture();
  starter.floor = LoadModelFromMesh(GenMeshPlane(20.0f, 20.0f, 1, 1));
  starter.floor.materials[0].maps[MATERIAL_MAP_DIFFUSE].texture = starter.checker;
  starter.block = LoadModelFromMesh(GenMeshCube(2.0f, 2.0f, 2.0f));
  starter.block.materials[0].maps[MATERIAL_MAP_DIFFUSE].texture = starter.checker;
}

Camera3D lookingAt(Vector3 position) {
  Camera3D camera{};
  camera.position = position;
  camera.target = {0.0f, 1.0f, 0.0f};
  camera.up = {0.0f, 1.0f, 0.0f};
  camera.fovy = 45.0f;
  camera.projection = CAMERA_PERSPECTIVE;
  return camera;
}

studio::Game starterGame() {
  studio::Game game;
  game.title = "__GAME_TITLE__";
  game.worldSize = {960.0f, 540.0f};
  game.reset = [](int) {
    if (starter.checker.id == 0) buildStarter();
    starter.spin = 0;
  };
  game.update = [](float dt, const studio::Ctx&) { starter.spin += 30.0f * dt; };
  game.camera = [] { return lookingAt({6.0f, 5.0f, 8.0f}); };
  game.draw = [](const Camera3D& camera) {
    BeginMode3D(camera);
    studio::tag("ground");
    studio::drawModel(starter.floor, {0.0f, 0.0f, 0.0f}, 1.0f, WHITE);
    studio::tag("block");
    studio::drawModelEx(starter.block, {0.0f, 1.0f, 0.0f}, {0.0f, 1.0f, 0.0f}, starter.spin, {1.0f, 1.0f, 1.0f}, WHITE);
    EndMode3D();
  };
  game.probes = [] {
    json::Value probes = json::Value::object();
    probes.set("phase", "empty");
    return probes;
  };
  game.cameras = {{"overview", [] { return lookingAt({0.0f, 14.0f, 0.1f}); }}};
  return game;
}

}  // namespace

int main() {
  studio::Game game = starterGame();
  // ── FACET WIRING ── one line per facet, nothing else: void wire_<slug>(studio::Game&); wire_<slug>(game);
  // ── END FACET WIRING ──
  studio::install(std::move(game));
  return 0;
}
