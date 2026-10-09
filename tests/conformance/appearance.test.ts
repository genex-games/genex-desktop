import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLOR_ROLES,
  DEFAULT_APPEARANCE,
  PRESETS,
  accentFill,
  contrastRatio,
  exportTheme,
  hex,
  importTheme,
  normalizeAppearance,
  onColor,
  paletteFor,
  resolveScheme,
  shadowOf,
  shadowsOf,
  themeVariables,
} from "../../src/renderer/appearance/themes.ts";

/** Genex's own presets are tuned by hand in the colour tweaker; ported families keep full AA. */
const handTuned = (id: string): boolean => id.startsWith("genex-");

test("built-in palettes keep body text readable; ported families also keep secondary text, accents, statuses and buttons", () => {
  assert.equal(PRESETS.length, 10);
  // A first launch follows the system's light or dark; it was always dark.
  assert.equal(DEFAULT_APPEARANCE.mode, "system");
  assert.equal(DEFAULT_APPEARANCE.dark.preset, "genex-dark");
  for (const preset of PRESETS) {
    const p = preset.colors;
    const ported = !handTuned(preset.id);
    if (ported) assert.notEqual(p.sidebar, p.background, `${preset.id}: sidebar must have its own surface`);
    for (const role of COLOR_ROLES) assert.ok(hex(p[role]), `${preset.id} ${role}`);
    const tokens = ported
      ? ["--foreground", "--muted-foreground", "--accent-ink", "--green", "--orange", "--destructive"]
      : ["--foreground"];
    for (const strength of [0, 50, 100]) {
      const v = themeVariables(p, strength);
      for (const bg of ["background", "surface", "sidebar", "popover", "field", "hover"] as const)
        for (const token of tokens)
          assert.ok(contrastRatio(v[token]!, p[bg]) >= 4.5, `${preset.id}: ${token} on ${bg}`);
    }
    if (!ported) continue;
    const v = themeVariables(p);
    for (const token of ["--accent-fill", "--accent-hover"])
      assert.ok(contrastRatio(v[token]!, v["--accent-foreground"]!) >= 4.5, `${preset.id}: button label on ${token}`);
  }
});

test("filled accent controls keep white text readable for any accent, and keep dark accents as they are", () => {
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51)
      for (let b = 0; b <= 255; b += 51) {
        const c = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join(""),
          { fill, hover } = accentFill(c);
        assert.ok(contrastRatio(fill, "#ffffff") >= 4.9, `${c} fill ${fill}`);
        assert.ok(contrastRatio(hover, "#ffffff") >= 4.5, `${c} hover ${hover}`);
      }
  assert.equal(accentFill("#0969da").fill, "#0969da");
  assert.notEqual(accentFill("#8aa7cc").fill, "#8aa7cc");
});

test("configured borders stay literal at default contrast instead of being brightened", () => {
  const p = { ...PRESETS[0]!.colors, controlBorder: "#252830" };
  assert.equal(themeVariables(p, 50)["--input"], p.controlBorder);
  assert.notEqual(themeVariables(p, 100)["--input"], p.controlBorder);
});

test("every RGB gray and a spread of accent hues gets readable action text", () => {
  for (let r = 0; r <= 255; r += 15)
    for (let g = 0; g <= 255; g += 15)
      for (let b = 0; b <= 255; b += 15) {
        const c = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
        assert.ok(contrastRatio(c, onColor(c)) >= 4.5, c);
      }
});

test("independent palettes and system mode do not overwrite inactive choices", () => {
  const a = normalizeAppearance({
    ...DEFAULT_APPEARANCE,
    dark: { preset: "tokyo-dark", overrides: { accent: "#f00" }, contrast: 70 },
    light: { preset: "rose-light", overrides: {}, contrast: 50 },
  });
  assert.equal(paletteFor(a, "dark").accent, "#ff0000");
  assert.equal(paletteFor(a, "light").accent, "#735e91");
  assert.equal(resolveScheme("system", true), "dark");
  assert.equal(resolveScheme("system", false), "light");
  assert.equal(resolveScheme("light", true), "light");
  assert.equal(resolveScheme("dark", false), "dark");
});

test("persisted settings reject unknown data, clamp ranges, and never admit CSS", () => {
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ version: 2 }), DEFAULT_APPEARANCE);
  const a = normalizeAppearance({
    version: 1,
    mode: "wat",
    uiFont: "url(evil)",
    codeFont: "other",
    dark: {
      preset: "rose-light",
      contrast: Infinity,
      overrides: { background: "url(evil)", foreground: "#123", accent: "#11223344", __proto__: {} },
    },
    saved: [{ id: "bad", scheme: "dark", colors: PRESETS[0]!.colors }],
  });
  assert.equal(a.mode, "system", "an unknown mode falls back to the default, the system's");
  assert.equal(a.uiFont, "studio");
  assert.equal(a.dark.preset, "genex-dark");
  assert.equal(a.dark.contrast, 50);
  assert.deepEqual(a.dark.overrides, { foreground: "#112233" });
  assert.equal(a.saved.length, 0);
  assert.equal(normalizeAppearance({ ...DEFAULT_APPEARANCE, dark: { contrast: -20 } }).dark.contrast, 0);
  assert.equal(normalizeAppearance({ ...DEFAULT_APPEARANCE, dark: { contrast: 200 } }).dark.contrast, 100);
});

test("custom preset survives persistence including its name and contrast", () => {
  const colors = PRESETS[2]!.colors;
  const a = normalizeAppearance({
    ...DEFAULT_APPEARANCE,
    saved: [{ id: "custom-1", name: "My dusk", scheme: "dark", colors, contrast: 82 }],
    dark: { preset: "custom-1", overrides: {}, contrast: 82 },
  });
  assert.equal(a.saved[0]!.contrast, 82);
  assert.deepEqual(paletteFor(a, "dark"), colors);
  assert.deepEqual(normalizeAppearance(JSON.parse(JSON.stringify(a))), a);
});

test("DTCG exports round-trip every theme and do not trust an optional hex hint over components", () => {
  for (const p of PRESETS) {
    const a = normalizeAppearance({
      ...DEFAULT_APPEARANCE,
      [p.scheme]: { preset: p.id, overrides: { accent: "#ffe599" }, contrast: 81 },
    });
    const imported = importTheme(exportTheme(a, p.scheme), p.scheme);
    assert.deepEqual(imported.colors, paletteFor(a, p.scheme));
    assert.equal(imported.contrast, 81);
    assert.equal(imported.scheme, p.scheme);
  }
  const raw = JSON.parse(exportTheme(DEFAULT_APPEARANCE, "dark"));
  raw.colors.accent.$value.hex = "#ffffff";
  assert.equal(importTheme(JSON.stringify(raw), "dark").colors.accent, paletteFor(DEFAULT_APPEARANCE, "dark").accent);
});

test("VS Code JSONC maps UI colors, comments, trailing commas, alpha, and safe fallbacks", () => {
  const result = importTheme(
    `{// comment\n"name":"https://example.com/*name*/", "type":"dark", "colors":{"editor.background":"#000", "editor.foreground":"#fff", "button.background":"#00ff0080", "input.border":"#abc", /* comment */},}`,
    "light",
  );
  assert.equal(result.scheme, "dark");
  assert.equal(result.name, "https://example.com/*name*/");
  assert.equal(result.colors.accent, "#008000");
  assert.equal(result.colors.controlBorder, "#aabbcc");
  assert.equal(result.colors.background, "#000000");
  assert.equal(result.colors.popover, PRESETS[0]!.colors.popover);
});

test("JSONC keeps escaped quotes and comment marks inside strings, strips a BOM and rejects an unclosed comment", () => {
  const result = importTheme(
    `\uFEFF{"name":"a \\"quoted\\" // theme /* x */", /* block\n comment */ "colors":{"editor.background":"#111111",// end\n}}`,
    "dark",
  );
  assert.equal(result.name, 'a "quoted" // theme /* x */');
  assert.equal(result.colors.background, "#111111");
  assert.throws(() => importTheme('{"colors":{"editor.background":"#000"} /* open', "dark"), /valid JSON/);
});

test("imports fail explicitly for malformed, incompatible, oversized, include or syntax-only files", () => {
  for (const input of [
    "{",
    "null",
    '{"tokenColors":[]}',
    '{"include":"../theme.json","colors":{"editor.background":"#000"}}',
    '{"colors":{"button.background":"url(evil)"}}',
  ])
    assert.throws(() => importTheme(input, "dark"));
  assert.throws(() => importTheme(" ".repeat(131073), "dark"), /128 KB/);
  const raw = JSON.parse(exportTheme(DEFAULT_APPEARANCE, "dark"));
  raw.colors.accent.$value.components = [1, 0, NaN];
  assert.throws(() => importTheme(JSON.stringify(raw), "dark"), /sRGB/);
  raw.colors.accent.$value.components = [1, 0, 0];
  raw.colors.accent.$value.alpha = 0.5;
  assert.throws(() => importTheme(JSON.stringify(raw), "dark"), /opaque/);
  raw.$extensions["app.genex.studio"].version = 2;
  assert.throws(() => importTheme(JSON.stringify(raw), "dark"), /newer/);
});

test("every colour is drawn exactly as the palette sets it, however low its contrast", () => {
  const p = {
    ...PRESETS.find((x) => x.id === "genex-light")!.colors,
    muted: "#ffffff",
    accent: "#82a9ea",
    warning: "#ffee00",
  };
  const v = themeVariables(p);
  assert.equal(v["--muted-foreground"], "#ffffff");
  assert.equal(v["--accent-ink"], "#82a9ea");
  assert.equal(v["--orange"], "#ffee00");
  assert.equal(v["--foreground"], p.foreground);
});

test("raising contrast still lifts muted text above the contrast it was set at", () => {
  const p = PRESETS.find((x) => x.id === "genex-dark")!.colors;
  const at = (strength: number) => contrastRatio(themeVariables(p, strength)["--muted-foreground"]!, p.background);
  assert.equal(themeVariables(p, 0)["--muted-foreground"], p.muted);
  assert.ok(at(100) > at(50) + 1);
});

test("the accent button's fill, hover and text and the icon colour follow the palette when set, else are derived", () => {
  const base = PRESETS.find((x) => x.id === "tokyo-dark")!.colors;
  const derived = themeVariables(base);
  assert.equal(derived["--accent-fill"], accentFill(base.accent).fill);
  assert.equal(derived["--accent-hover"], accentFill(base.accent).hover);
  assert.equal(derived["--accent-foreground"], "#ffffff");
  assert.equal(derived["--icon"], undefined, "unset, icons keep each place's own quiet ink");
  const set = themeVariables({
    ...base,
    accentFill: "#123456",
    accentHover: "#234567",
    accentText: "#fefefe",
    icon: "#abcdef",
  });
  assert.deepEqual(
    [set["--accent-fill"], set["--accent-hover"], set["--accent-foreground"], set["--icon"]],
    ["#123456", "#234567", "#fefefe", "#abcdef"],
  );
  assert.notEqual(themeVariables({ ...base, accentFill: "#123456" })["--accent-hover"], derived["--accent-hover"]);
});

test("a settings accent override re-derives the preset's own button colours; detail roles round-trip", () => {
  const custom = {
    id: "custom-buttons",
    name: "Buttons",
    scheme: "light",
    colors: { ...PRESETS.find((x) => x.id === "genex-light")!.colors, accentFill: "#123456", icon: "#abcdef" },
  };
  const a = normalizeAppearance({
    ...DEFAULT_APPEARANCE,
    saved: [custom],
    light: { preset: custom.id, overrides: { accent: "#ff0000" }, contrast: 50 },
  });
  assert.equal(paletteFor(a, "light").accentFill, undefined);
  assert.equal(paletteFor(a, "light").icon, "#abcdef");
  const kept = normalizeAppearance({ ...a, light: { preset: custom.id, overrides: {}, contrast: 50 } });
  assert.equal(paletteFor(kept, "light").accentFill, "#123456");
  assert.deepEqual(importTheme(exportTheme(kept, "light"), "light").colors, paletteFor(kept, "light"));
  const vscode = importTheme('{"type":"light","colors":{"editor.background":"#ffffff"}}', "light");
  assert.equal(vscode.colors.accentFill, undefined, "an import never inherits Genex's own button colours");
});

test("chip fill, hover fill and their text follow the palette when set, and leave each place's own colours when not", () => {
  const base = PRESETS.find((x) => x.id === "genex-dark")!.colors;
  const unset = themeVariables(base);
  for (const key of ["--control-fill", "--control-hover", "--control-text", "--control-text-hover"])
    assert.equal(unset[key], undefined, key);
  const set = themeVariables({
    ...base,
    controlFill: "#111111",
    controlHover: "#222222",
    controlText: "#333333",
    controlTextHover: "#444444",
  });
  assert.deepEqual(
    [set["--control-fill"], set["--control-hover"], set["--control-text"], set["--control-text-hover"]],
    ["#111111", "#222222", "#333333", "#444444"],
  );
});

test("chip hover, the selector track and the meter colours follow the palette when set, else each place keeps its own", () => {
  const base = PRESETS.find((x) => x.id === "genex-dark")!.colors;
  const keys = ["--chip-hover", "--well", "--meter-track", "--meter-fill", "--meter-high", "--meter-full"];
  const unset = themeVariables(base);
  for (const key of keys) assert.equal(unset[key], undefined, key);
  const set = themeVariables({
    ...base,
    chipHover: "#010101",
    well: "#020202",
    meterTrack: "#030303",
    meterFill: "#040404",
    meterHigh: "#050505",
    meterFull: "#060606",
  });
  assert.deepEqual(
    keys.map((key) => set[key]),
    ["#010101", "#020202", "#030303", "#040404", "#050505", "#060606"],
  );
});

test("the selected segment and the menu, prompt bar and segment shadows follow the palette when set, else each place keeps its own", () => {
  const base = PRESETS.find((x) => x.id === "genex-dark")!.colors;
  const keys = ["--thumb", "--panel-shadow", "--prompt-shadow", "--thumb-shadow"];
  const unset = themeVariables(base);
  for (const key of keys) assert.equal(unset[key], undefined, key);
  const set = themeVariables({
    ...base,
    thumb: "#010101",
    shadows: {
      panel: { y: 16, blur: 48, spread: 0, color: "#000000", alpha: 15 },
      promptBar: { y: 8, blur: 24, spread: -4, color: "#000000", alpha: 0 },
      thumb: { y: 1, blur: 2, spread: 0, color: "#112233", alpha: 100 },
    },
  });
  assert.deepEqual(
    keys.map((key) => set[key]),
    ["#010101", "0 16px 48px 0px #00000026", "0 8px 24px -4px #00000000", "0 1px 2px 0px #112233ff"],
  );
});

test("a stored shadow is kept only whole, each measure within its range", () => {
  assert.deepEqual(shadowOf({ y: 500, blur: -4, spread: 2.4, color: "#ABC", alpha: 140 }), {
    y: 64,
    blur: 0,
    spread: 2,
    color: "#aabbcc",
    alpha: 100,
  });
  assert.equal(shadowOf({ y: 1, blur: 2, spread: 0, alpha: 20 }), undefined);
  assert.equal(shadowOf({ y: "1", blur: 2, spread: 0, color: "#000000", alpha: 20 }), undefined);
  const thumb = { y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0 };
  assert.deepEqual(shadowsOf({ thumb, panel: "none", stray: thumb }), { thumb });
  assert.equal(shadowsOf(null), undefined);
});

test("a palette's logo colours the wordmark and its gradient's secondary ink; unset, the wordmark keeps the text inks", () => {
  const { logo: _, logoShade: _shade, ...base } = PRESETS.find((x) => x.id === "genex-dark")!.colors;
  const unset = themeVariables(base);
  assert.equal(unset["--logo"], undefined);
  assert.equal(unset["--logo-2"], undefined);
  const set = themeVariables({ ...base, logo: "#3f61f5" });
  assert.equal(set["--logo"], "#3f61f5");
  assert.match(set["--logo-2"] ?? "", /#3f61f5 70%/);
});

test("a palette's graph accent colours the builds graph alone; unset, the graph keeps the app's accent", () => {
  const { graph: _, ...base } = PRESETS.find((x) => x.id === "genex-dark")!.colors;
  assert.equal(themeVariables(base)["--graph"], undefined);
  const set = themeVariables({ ...base, graph: "#7c5cff" });
  assert.equal(set["--graph"], "#7c5cff");
  assert.equal(set["--accent-primary"], base.accent);
});
