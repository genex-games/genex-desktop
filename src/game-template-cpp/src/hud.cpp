// The HUD declared in hud.h.
#include "hud.h"

#include <algorithm>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace studio::hud {

namespace {

/** Items one frame may queue: more than this is a HUD called from a loop by mistake. */
constexpr std::size_t MAX_ITEMS = 256;
/** How much of a text item names it in state().hud. */
constexpr std::size_t MAX_ITEM_NAME = 64;
/** A flash keeps this share of its alpha each drawn frame, and is gone below FLASH_CUTOFF. */
constexpr float FLASH_DECAY = 0.85f;
constexpr float FLASH_CUTOFF = 0.01f;
/** The dimmed track a bar is drawn on. */
constexpr Color BAR_TRACK = {0, 0, 0, 140};
/** What the CPU-fallback notice says, and the name state().hud gives it. */
constexpr std::string_view CPU_FALLBACK_TEXT = "No GPU driver: drawn on the CPU, may run slowly";
constexpr const char* CPU_FALLBACK_NOTICE = "cpu-fallback";
/** The notice's type size is the world's width over this, kept between the two sizes below (world pixels). */
constexpr int NOTICE_WIDTH_SHARE = 40;
constexpr int NOTICE_MIN_SIZE = 8;
constexpr int NOTICE_MAX_SIZE = 48;
/** The smallest padding inside the notice's backdrop, in world pixels. */
constexpr int NOTICE_MIN_PADDING = 2;
constexpr Color NOTICE_BACKDROP = {0, 0, 0, 200};
constexpr Color NOTICE_TEXT = {255, 214, 102, 255};

enum class ItemKind { Text, Bar };

struct Item {
  ItemKind kind = ItemKind::Text;
  std::string name;
  std::string text;
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
  int size = 0;
  float fraction = 0;
  Color color = RAYWHITE;
};

struct Crosshair {
  bool visible = false;
  int size = 10;
  Color color = RAYWHITE;
};

std::vector<Item> queued;
std::vector<std::string> lastItems;
Crosshair cross;
Color flashColor = WHITE;
float flashAlpha = 0;
bool cpuNotice = false;

void drawItem(const Item& item) {
  if (item.kind == ItemKind::Text) {
    DrawText(item.text.c_str(), item.x, item.y, item.size, item.color);
    return;
  }
  int filled = static_cast<int>(static_cast<float>(item.width) * item.fraction);
  DrawRectangle(item.x, item.y, item.width, item.height, BAR_TRACK);
  DrawRectangle(item.x, item.y, filled, item.height, item.color);
  DrawRectangleLines(item.x, item.y, item.width, item.height, Fade(item.color, 0.8f));
}

void drawCrosshair(int width, int height) {
  int cx = width / 2;
  int cy = height / 2;
  DrawLine(cx - cross.size, cy, cx + cross.size, cy, cross.color);
  DrawLine(cx, cy - cross.size, cx, cy + cross.size, cross.color);
}

/** `text` broken at spaces into lines at most `width` wide at type `size`; a longer word keeps a line of its own. */
std::vector<std::string> wrapped(std::string_view text, int size, int width) {
  std::vector<std::string> lines;
  std::string line;
  std::size_t start = 0;
  while (start < text.size()) {
    std::size_t end = std::min(text.find(' ', start), text.size());
    std::string word(text.substr(start, end - start));
    std::string longer = line.empty() ? word : line + " " + word;
    if (line.empty() || MeasureText(longer.c_str(), size) <= width) {
      line = std::move(longer);
    } else {
      lines.push_back(std::move(line));
      line = std::move(word);
    }
    start = end + 1;
  }
  if (!line.empty()) lines.push_back(std::move(line));
  return lines;
}

/**
 * The CPU-fallback notice along the frame's bottom edge, over everything the game drew: sized from
 * the world's width and wrapped to it, so a pixel-art world shows all of it and a large one reads it.
 */
void drawCpuNotice(int worldWidth, int worldHeight) {
  int size = std::clamp(worldWidth / NOTICE_WIDTH_SHARE, NOTICE_MIN_SIZE, NOTICE_MAX_SIZE);
  int margin = size / 2;
  int padding = std::max(NOTICE_MIN_PADDING, size / 3);
  int gap = size / 4;
  std::vector<std::string> lines = wrapped(CPU_FALLBACK_TEXT, size, worldWidth - 2 * (margin + padding));
  int widest = 0;
  for (const std::string& line : lines) widest = std::max(widest, MeasureText(line.c_str(), size));
  int count = static_cast<int>(lines.size());
  int boxHeight = count * size + (count - 1) * gap + 2 * padding;
  int top = std::max(0, worldHeight - margin - boxHeight);  // a world too short for it keeps its top line
  DrawRectangle(margin, top, widest + 2 * padding, boxHeight, NOTICE_BACKDROP);
  for (int i = 0; i < count; ++i) {
    DrawText(lines[static_cast<std::size_t>(i)].c_str(), margin + padding, top + padding + i * (size + gap), size,
             NOTICE_TEXT);
  }
}

}  // namespace

void text(const char* text, int x, int y, int size, Color color) {
  if (!text || queued.size() >= MAX_ITEMS) return;
  Item item;
  item.kind = ItemKind::Text;
  item.text = text;
  item.name = item.text.substr(0, MAX_ITEM_NAME);
  item.x = x;
  item.y = y;
  item.size = std::max(1, size);
  item.color = color;
  queued.push_back(std::move(item));
}

void bar(const char* id, float fraction, int x, int y, int width, int height, Color color) {
  if (!id || queued.size() >= MAX_ITEMS) return;
  Item item;
  item.kind = ItemKind::Bar;
  item.name = std::string(id).substr(0, MAX_ITEM_NAME);
  item.fraction = fraction > 0 ? std::min(fraction, 1.0f) : 0.0f;  // NaN reads as empty
  item.x = x;
  item.y = y;
  item.width = std::max(0, width);
  item.height = std::max(0, height);
  item.color = color;
  queued.push_back(std::move(item));
}

void crosshair(bool visible, int size, Color color) { cross = Crosshair{visible, std::max(1, size), color}; }

void flash(Color color, float alpha) {
  flashColor = color;
  flashAlpha = alpha > 0 ? std::min(alpha, 1.0f) : 0.0f;
}

void drawFrame(int worldWidth, int worldHeight) {
  lastItems.clear();
  for (const Item& item : queued) {
    drawItem(item);
    lastItems.push_back(item.name);
  }
  queued.clear();
  if (cross.visible) drawCrosshair(worldWidth, worldHeight);
  if (flashAlpha > FLASH_CUTOFF) {
    DrawRectangle(0, 0, worldWidth, worldHeight, Fade(flashColor, flashAlpha));
    flashAlpha *= FLASH_DECAY;
  } else {
    flashAlpha = 0;
  }
  if (cpuNotice) drawCpuNotice(worldWidth, worldHeight);
}

json::Value summary() {
  json::Value items = json::Value::array();
  for (const std::string& name : lastItems) items.push(name);
  json::Value out = json::Value::object();
  out.set("items", std::move(items));
  out.set("crosshair", cross.visible);
  out.set("flash", flashAlpha);
  if (cpuNotice) out.set("notice", CPU_FALLBACK_NOTICE);
  return out;
}

void reset() {
  queued.clear();
  lastItems.clear();
  cross = Crosshair{};
  flashAlpha = 0;
}

void cpuFallback(bool shown) { cpuNotice = shown; }

}  // namespace studio::hud
