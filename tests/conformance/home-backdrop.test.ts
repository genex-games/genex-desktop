/**
 * Home's background: saved settings read back inside their ranges, and the picture turned into ink
 * the same way on both themes, so an effect draws the picture rather than its negative.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  colorLightness,
  coverageAt,
  coverageField,
  coverCrop,
  grainAt,
  rampCharacter,
  thresholded,
} from "../../src/renderer/home-backdrop/field.ts";
import { SHADER_PRESETS, withPreset } from "../../src/renderer/home-backdrop/presets.ts";
import { lumaOf, type Rgba, readableColor } from "../../src/renderer/home-backdrop/readable-color.ts";
import { homeView, previewView } from "../../src/renderer/home-backdrop/view.ts";
import {
  BACKDROP_RANGES,
  BackdropEffect,
  BackdropSource,
  backdropDecimals,
  DEFAULT_BACKDROP,
  DotGrid,
  EFFECT_LOOKS,
  normalizeBackdrop,
  THEME_COLORS,
  withEffect,
} from "../../src/renderer/home-backdrop/settings.ts";

const FLAT = { grain: 0, gamma: 1, blackPoint: 0, whitePoint: 255 };
/** RGBA for grey levels. */
const greys = (...levels: number[]): Uint8ClampedArray =>
  Uint8ClampedArray.from(levels.flatMap((level) => [level, level, level, 255]));

describe("home background settings read back", () => {
  it("nothing saved, or something unreadable, is the default", () => {
    for (const saved of [null, undefined, 42, "dots", []]) assert.deepEqual(normalizeBackdrop(saved), DEFAULT_BACKDROP);
  });

  it("keeps what it can use and defaults the rest", () => {
    const settings = normalizeBackdrop({
      effect: BackdropEffect.Ascii,
      image: "upload:3f1c-aa",
      dotGrid: DotGrid.Benday,
      asciiColumns: 90,
      strength: "loud",
    });
    assert.equal(settings.effect, BackdropEffect.Ascii);
    assert.equal(settings.image, "upload:3f1c-aa");
    assert.equal(settings.dotGrid, DotGrid.Benday);
    assert.equal(settings.asciiColumns, 90);
    assert.equal(settings.strength, DEFAULT_BACKDROP.strength);
  });

  const hostile: Array<[string, Record<string, unknown>, Partial<typeof DEFAULT_BACKDROP>]> = [
    ["an unknown effect", { effect: "plasma" }, { effect: DEFAULT_BACKDROP.effect }],
    ["an unknown source", { source: "webcam" }, { source: DEFAULT_BACKDROP.source }],
    ["a picture path", { image: "../../etc/passwd" }, { image: DEFAULT_BACKDROP.image }],
    ["a picture URL", { image: "https://example.com/a.png" }, { image: DEFAULT_BACKDROP.image }],
    ["columns past the range", { lineColumns: 100_000 }, { lineColumns: BACKDROP_RANGES.lineColumns.max }],
    ["a negative grid", { dotStep: -5 }, { dotStep: BACKDROP_RANGES.dotStep.min }],
    ["a value off the step", { gamma: 1.234 }, { gamma: 1.25 }],
    ["not a number", { blur: Number.NaN }, { blur: DEFAULT_BACKDROP.blur }],
    ["a one-character ramp", { asciiCharacters: "#" }, { asciiCharacters: DEFAULT_BACKDROP.asciiCharacters }],
    ["control characters", { asciiCharacters: " .\u0007:#\n" }, { asciiCharacters: " .:#" }],
    ["levels crossed", { blackPoint: 200, whitePoint: 100 }, { blackPoint: 200, whitePoint: 201 }],
    ["dots inverted", { dotMin: 10, dotMax: 4 }, { dotMin: 4, dotMax: 4 }],
    ["a threshold past white", { threshold: 400 }, { threshold: 255 }],
    ["a dot straying more than a step", { dotNoise: 3 }, { dotNoise: 1 }],
    ["a shader path", { shader: "../../etc/passwd" }, { shader: DEFAULT_BACKDROP.shader }],
    ["a shader URL", { shader: "https://example.com/x.wgsl" }, { shader: DEFAULT_BACKDROP.shader }],
    ["a made shader's id with a path in it", { shader: "custom:../x" }, { shader: DEFAULT_BACKDROP.shader }],
    ["shader source in place of an id", { shader: "@fragment fn fs_main() {}" }, { shader: DEFAULT_BACKDROP.shader }],
    ["a speed past the range", { speed: 50 }, { speed: BACKDROP_RANGES.speed.max }],
    ["a backwards speed", { speed: -1 }, { speed: BACKDROP_RANGES.speed.min }],
    ["a pattern too small", { scale: 0.01 }, { scale: BACKDROP_RANGES.scale.min }],
  ];
  for (const [name, saved, expected] of hostile)
    it(`holds ${name} to what it may be`, () => {
      const settings = normalizeBackdrop(saved);
      for (const [key, value] of Object.entries(expected))
        assert.equal(settings[key as keyof typeof settings], value, key);
    });

  it("keeps a colour for each theme, the theme's own until one is picked", () => {
    assert.deepEqual(DEFAULT_BACKDROP.colors, { light: null, dark: null });
    assert.deepEqual(normalizeBackdrop({ colors: { light: "#A1B2C3", dark: null } }).colors, {
      light: "#a1b2c3",
      dark: null,
    });
    // One colour saved before themes had their own is let go: each theme starts from its default.
    assert.deepEqual(normalizeBackdrop({ color: "#e8e8e8" }).colors, DEFAULT_BACKDROP.colors);
    for (const hostile of ["red", "url(x)", "#fff", 42, { r: 1 }])
      assert.deepEqual(
        normalizeBackdrop({ colors: { light: hostile, dark: hostile } }).colors,
        DEFAULT_BACKDROP.colors,
      );
  });

  it("keeps a live background's shader and its colours: the theme's when saved so, the default's when unreadable", () => {
    const settings = normalizeBackdrop({
      source: BackdropSource.Shader,
      effect: BackdropEffect.None,
      shader: "custom:5b1e-9f",
      shaderColors: { light: "#FF00AA", dark: "teal" },
      shaderAccents: { light: null, dark: 42 },
    });
    assert.equal(settings.source, BackdropSource.Shader);
    assert.equal(settings.effect, BackdropEffect.None);
    assert.equal(settings.shader, "custom:5b1e-9f");
    assert.deepEqual(settings.shaderColors, { light: "#ff00aa", dark: DEFAULT_BACKDROP.shaderColors.dark });
    assert.deepEqual(settings.shaderAccents, { light: null, dark: DEFAULT_BACKDROP.shaderAccents.dark });
    assert.equal(normalizeBackdrop({ shader: "preset:phosphor" }).shader, "preset:phosphor");
  });

  it("cuts a long ramp to its longest", () => {
    assert.equal(normalizeBackdrop({ asciiCharacters: "x".repeat(200) }).asciiCharacters.length, 24);
  });
});

describe("a background's source and effect read back", () => {
  it("keeps an effect on top of a live background, and a picture with none", () => {
    const live = normalizeBackdrop({ source: BackdropSource.Shader, effect: BackdropEffect.Dots });
    assert.deepEqual([live.source, live.effect], [BackdropSource.Shader, BackdropEffect.Dots]);
    const plain = normalizeBackdrop({ source: BackdropSource.Picture, effect: BackdropEffect.None });
    assert.deepEqual([plain.source, plain.effect], [BackdropSource.Picture, BackdropEffect.None]);
  });

  it("reads settings saved before the source had its own field", () => {
    const cases: Array<[unknown, BackdropSource, BackdropEffect]> = [
      [{ effect: "off" }, BackdropSource.Off, DEFAULT_BACKDROP.effect],
      [{ effect: "dots" }, BackdropSource.Picture, BackdropEffect.Dots],
      [{ effect: "ascii" }, BackdropSource.Picture, BackdropEffect.Ascii],
      [{ effect: "shader" }, BackdropSource.Shader, BackdropEffect.None],
    ];
    for (const [saved, source, effect] of cases) {
      const settings = normalizeBackdrop(saved);
      assert.deepEqual([settings.source, settings.effect], [source, effect], JSON.stringify(saved));
    }
  });
});

describe("a picture as ink", () => {
  it("dark is ink on a light page, light is ink on a dark one", () => {
    const light = coverageField(greys(0, 255), 2, 1, FLAT, false);
    const dark = coverageField(greys(0, 255), 2, 1, FLAT, true);
    assert.deepEqual([...light.values], [1, 0]);
    assert.deepEqual([...dark.values], [0, 1]);
  });

  it("levels stretch the range between the black and white points", () => {
    const field = coverageField(greys(50, 100, 150, 200), 4, 1, { ...FLAT, blackPoint: 100, whitePoint: 150 }, true);
    assert.deepEqual([...field.values], [0, 0, 1, 1]);
  });

  it("gamma above 1 lifts the midtones", () => {
    const flat = coverageField(greys(128), 1, 1, FLAT, true).values[0] ?? 0;
    const lifted = coverageField(greys(128), 1, 1, { ...FLAT, gamma: 2 }, true).values[0] ?? 0;
    assert.ok(lifted > flat, `${lifted} > ${flat}`);
  });

  it("grain is the same each time it is drawn, and stays within the ink's range", () => {
    const tone = { ...FLAT, grain: 1 };
    const once = coverageField(greys(...Array(64).fill(128)), 8, 8, tone, true);
    const again = coverageField(greys(...Array(64).fill(128)), 8, 8, tone, true);
    assert.deepEqual(once.values, again.values);
    assert.ok([...once.values].every((value) => value >= 0 && value <= 1));
    assert.ok(new Set(once.values).size > 1, "grain varies between samples");
    for (let index = 0; index < 1000; index++) assert.ok(grainAt(index) >= 0 && grainAt(index) < 1);
  });

  it("blends between samples and holds at the edges", () => {
    const field = { width: 2, height: 1, values: Float32Array.from([0, 1]) };
    assert.equal(coverageAt(field, 1, 0.5), 0.5);
    assert.equal(coverageAt(field, -10, 0.5), 0);
    assert.equal(coverageAt(field, 10, 0.5), 1);
  });

  it("a threshold leaves out ink below it and keeps the rest as it is", () => {
    assert.equal(thresholded(0.4, 128), 0);
    assert.equal(thresholded(0.6, 128), 0.6);
    assert.equal(thresholded(0.1, 0), 0.1);
  });

  it("picks the ramp's lightest for no ink and its densest for full ink", () => {
    const ramp = Array.from(" .:#");
    assert.equal(rampCharacter(ramp, 0), " ");
    assert.equal(rampCharacter(ramp, 1), "#");
    assert.equal(rampCharacter(ramp, 0.5), ":");
    assert.equal(rampCharacter(ramp, 7), "#");
  });
});

describe("a mark's colour", () => {
  it("reads hex and rgb, light to dark, and nothing else", () => {
    assert.equal(colorLightness("#ffffff"), 1);
    assert.equal(colorLightness("#000"), 0);
    assert.equal(colorLightness("rgb(255, 255, 255)"), 1);
    assert.equal(colorLightness("rgba(0 0 0 / 0.5)"), 0);
    const ink = colorLightness("#dee0e2") ?? 0;
    const page = colorLightness("#0e0d0f") ?? 1;
    assert.ok(ink > page, "the dark theme's text is lighter than its page");
    for (const unreadable of ["red", "", "color(srgb 1 1 1)", "#12345"]) assert.equal(colorLightness(unreadable), null);
  });
});

describe("a slider's value", () => {
  it("shows as many decimals as its step, so its width holds while dragged", () => {
    assert.equal(backdropDecimals("strength"), 2);
    assert.equal(backdropDecimals("dotMin"), 1);
    assert.equal(backdropDecimals("dotStep"), 0);
  });
});

describe("a picture cut to cover home", () => {
  it("a wide picture loses its sides, a tall one its top and bottom, centered", () => {
    assert.deepEqual(coverCrop(2000, 1000, 100, 100), { sx: 500, sy: 0, sw: 1000, sh: 1000 });
    assert.deepEqual(coverCrop(1000, 2000, 100, 100), { sx: 0, sy: 500, sw: 1000, sh: 1000 });
  });
  it("a picture of the frame's shape is used whole", () => {
    assert.deepEqual(coverCrop(1600, 900, 800, 450), { sx: 0, sy: 0, sw: 1600, sh: 900 });
  });
});

describe("what home's background draws", () => {
  it("the whole window, whatever share of it home has, so showing or hiding the sidebar redraws nothing", () => {
    const window = { width: 1200, height: 800 };
    assert.deepEqual(homeView(window, 2), {
      frame: window,
      view: { x: 0, y: 0, width: 1200, height: 800 },
      scale: 2,
    });
  });
  it("past two pixels a point the marks look the same, so the density stops there", () => {
    assert.equal(homeView({ width: 100, height: 100 }, 3).scale, 2);
    assert.equal(homeView({ width: 100, height: 100 }, 1).scale, 1);
  });
  it("a preview is the window's drawing seen through home, at the preview's width", () => {
    const window = { width: 1200, height: 800 };
    const home = { x: 240, y: 0, width: 960, height: 800 };
    assert.deepEqual(previewView(window, home, 480, 2), { frame: window, view: home, scale: 1 });
  });
});

describe("choosing a bundled live background", () => {
  it("starts home on a bundled one, in one palette on either page", () => {
    assert.ok(SHADER_PRESETS.some((preset) => preset.id === DEFAULT_BACKDROP.shader));
    assert.equal(DEFAULT_BACKDROP.source, BackdropSource.Shader);
    for (const colors of [DEFAULT_BACKDROP.shaderColors, DEFAULT_BACKDROP.shaderAccents])
      assert.equal(colors.light, colors.dark);
    assert.deepEqual(DEFAULT_BACKDROP.colors, THEME_COLORS);
  });

  it("holds its glow to its range", () => {
    assert.equal(normalizeBackdrop({ glow: 0.4 }).glow, 0.4);
    assert.equal(normalizeBackdrop({ glow: 9 }).glow, BACKDROP_RANGES.glow.max);
    assert.equal(normalizeBackdrop({ glow: -1 }).glow, 0);
    assert.equal(normalizeBackdrop({ glow: "bright" }).glow, DEFAULT_BACKDROP.glow);
  });

  it("draws it in the default colours, keeping the strength, speed, size and glow set", () => {
    const tuned = { strength: 0.25, speed: 0.2, scale: 2, glow: 0.9 };
    const picked = { ...DEFAULT_BACKDROP, ...tuned, shaderColors: { light: "#ff00aa", dark: "#00ffaa" } };
    for (const preset of SHADER_PRESETS) {
      const chosen = withPreset(picked, preset);
      assert.equal(chosen.source, BackdropSource.Shader);
      assert.equal(chosen.shader, preset.id);
      assert.deepEqual(
        [chosen.shaderColors, chosen.shaderAccents],
        [DEFAULT_BACKDROP.shaderColors, DEFAULT_BACKDROP.shaderAccents],
      );
      assert.deepEqual([chosen.strength, chosen.speed, chosen.scale, chosen.glow], Object.values(tuned));
    }
  });

  it("keeps an effect drawn over a live background, and starts plain coming from a picture", () => {
    const [first, second] = SHADER_PRESETS;
    const overLive = withPreset({ ...withPreset(DEFAULT_BACKDROP, first), effect: BackdropEffect.Dots }, second);
    assert.equal(overLive.effect, BackdropEffect.Dots);
    const picture = { ...DEFAULT_BACKDROP, source: BackdropSource.Picture, effect: BackdropEffect.Lines };
    const fromPicture = withPreset(picture, second);
    assert.equal(fromPicture.effect, BackdropEffect.None);
  });
});

describe("a live background's colour on its page", () => {
  const close = (a: Rgba, b: Rgba): boolean => a.every((value, index) => Math.abs(value - (b[index] ?? 0)) < 1e-6);

  it("lifts a colour too dark to show on a dark page, keeping its hue", () => {
    const navy: Rgba = [0.04, 0.05, 0.2, 1];
    const lifted = readableColor(navy, true);
    assert.ok(lumaOf(lifted) >= 0.199);
    assert.equal(Math.max(...lifted.slice(0, 3)), lifted[2], "still bluest");
    assert.ok(lifted[0] < lifted[2] && lifted[1] < lifted[2]);
    assert.ok(lumaOf(readableColor([0, 0, 0, 1], true)) >= 0.199, "black becomes a grey that shows");
  });

  it("draws the theme's accent as it is", () => {
    const accent: Rgba = [0x47 / 255, 0x59 / 255, 0xc2 / 255, 1];
    assert.ok(close(readableColor(accent, true), accent));
  });

  it("darkens a colour too light to show on a light page", () => {
    assert.ok(lumaOf(readableColor([0.95, 0.95, 0.9, 1], false)) <= 0.551);
  });

  it("leaves a colour that already reads alone", () => {
    const ink: Rgba = [0.87, 0.88, 0.89, 1];
    assert.ok(close(readableColor(ink, true), ink));
    const dark: Rgba = [0.1, 0.1, 0.12, 1];
    assert.ok(close(readableColor(dark, false), dark));
  });
});

describe("choosing an effect", () => {
  it("puts its tuned look in place, which the sliders then move on", () => {
    for (const effect of [BackdropEffect.Lines, BackdropEffect.Dots, BackdropEffect.Ascii]) {
      const from = effect === BackdropEffect.Lines ? BackdropEffect.Dots : BackdropEffect.Lines;
      const chosen = withEffect({ ...DEFAULT_BACKDROP, effect: from }, effect);
      assert.equal(chosen.effect, effect);
      assert.deepEqual({ ...chosen, ...EFFECT_LOOKS[effect] }, chosen, effect);
    }
  });

  it("keeps what was set when it is already the effect, or when it is none", () => {
    const tuned = { ...DEFAULT_BACKDROP, effect: BackdropEffect.Dots, strength: 0.9, gamma: 2 };
    assert.deepEqual(withEffect(tuned, BackdropEffect.Dots), tuned);
    const plain = withEffect(tuned, BackdropEffect.None);
    assert.deepEqual([plain.effect, plain.strength, plain.gamma], [BackdropEffect.None, 0.9, 2]);
  });

  it("starts home in the default effect's own look", () => {
    const look = EFFECT_LOOKS[DEFAULT_BACKDROP.effect];
    assert.ok(look);
    assert.deepEqual({ ...DEFAULT_BACKDROP, ...look }, DEFAULT_BACKDROP);
  });

  it("holds every tuned look to the sliders' ranges", () => {
    for (const look of Object.values(EFFECT_LOOKS))
      if (look) assert.deepEqual(normalizeBackdrop({ ...DEFAULT_BACKDROP, ...look }), { ...DEFAULT_BACKDROP, ...look });
  });
});
