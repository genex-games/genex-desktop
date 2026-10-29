import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLOR_ROLES,
  type ColorRole,
  DEFAULT_CONTRAST,
  hex,
  PEOPLE_ROLES,
  PLAY_HUE_ROLES,
  PRESETS,
  Scheme,
  type ThemePreset,
  themeVariables,
} from "../../src/renderer/appearance/themes.ts";
import { channels, oklch, rgbHex } from "../../src/shared/oklch.ts";
import { MARK_FACE_INK, SHEET_INK } from "../../src/renderer/onboarding/art.ts";
import {
  applyKnobs,
  baked,
  changeCount,
  changedRoles,
  changedShadows,
  changesText,
  counterpart,
  drivenVariables,
  freshDraft,
  IDENTITY_KNOBS,
  LABEL_TYPE,
  LABEL_TYPE_KEYS,
  labelTypeText,
  LOGO_WIDTH,
  logoWidthText,
  pastedColors,
  presetCode,
  readability,
  ROLE_GROUPS,
  SHADOW_AUTO,
  shownColor,
  shownPalette,
  shownShadow,
  withColor,
  withColors,
  withShadow,
} from "../../src/renderer/appearance/tweaker/tweaker.ts";
import { normalizeMemory } from "../../src/renderer/appearance/tweaker/tweaker-memory.ts";

const preset = (id: string): ThemePreset => {
  const found = PRESETS.find((p) => p.id === id);
  assert.ok(found, id);
  return found;
};
const genexDark = preset("genex-dark");
const lightness = (color: string): number => oklch(color)[0];

test("knobs at identity leave every preset exactly as designed", () => {
  for (const p of PRESETS) assert.deepEqual(applyKnobs(p.colors, IDENTITY_KNOBS), p.colors, p.id);
});

test("lift moves the canvas and its layers together and leaves text, accent and statuses alone", () => {
  const out = applyKnobs(genexDark.colors, { ...IDENTITY_KNOBS, lift: 5 });
  for (const role of ["background", "surface", "sidebar", "popover", "field", "hover"] as const)
    assert.ok(Math.abs(lightness(out[role]) - lightness(genexDark.colors[role]) - 0.05) < 0.01, role);
  for (const role of ["foreground", "muted", "accent", "success", "warning", "danger"] as const)
    assert.equal(out[role], genexDark.colors[role], role);
});

test("depth scales each layer's lightness distance from the canvas and keeps the canvas", () => {
  const flat = applyKnobs(genexDark.colors, { ...IDENTITY_KNOBS, depth: 0 });
  assert.equal(flat.background, genexDark.colors.background);
  for (const role of ["surface", "sidebar", "hover", "border"] as const)
    assert.ok(Math.abs(lightness(flat[role]) - lightness(flat.background)) < 0.01, role);
  const deep = applyKnobs(genexDark.colors, { ...IDENTITY_KNOBS, depth: 200 });
  const gap = (p: typeof deep) => lightness(p.hover) - lightness(p.background);
  assert.ok(Math.abs(gap(deep) - 2 * gap(genexDark.colors)) < 0.01);
});

test("saturation 0 greys the neutrals and tint gives them the tint's hue", () => {
  const tokyo = preset("tokyo-dark");
  const grey = applyKnobs(tokyo.colors, { ...IDENTITY_KNOBS, saturation: 0 });
  for (const role of ["background", "surface", "foreground"] as const) assert.ok(oklch(grey[role])[1] < 0.005, role);
  assert.equal(grey.accent, tokyo.colors.accent);
  const warm = applyKnobs(genexDark.colors, { ...IDENTITY_KNOBS, saturation: 0, tint: 100, tintHue: 60 });
  const [, chroma, hue] = oklch(warm.surface);
  assert.ok(chroma > 0.02);
  assert.ok(Math.abs(hue * (180 / Math.PI) - 60) < 5);
});

test("setting a role bakes the knobs first, so the colours shown are the colours kept", () => {
  const draft = { ...freshDraft(genexDark), knobs: { ...IDENTITY_KNOBS, lift: 4 } };
  const next = withColor(draft, "accent", "#ff8800");
  assert.deepEqual(next.knobs, IDENTITY_KNOBS);
  assert.deepEqual(shownPalette(next), { ...shownPalette(draft), accent: "#ff8800" });
  assert.deepEqual(shownPalette(baked(draft)), shownPalette(draft));
  assert.deepEqual(changedRoles(genexDark, shownPalette(next)).includes("accent"), true);
});

test("the copied code is the preset's own entry with its roles in order, and pastes back", () => {
  // Only the core roles: a preset's details copy as a keyed tail, which another test covers.
  const core = Object.fromEntries(COLOR_ROLES.map((role) => [role, genexDark.colors[role]])) as Record<
    ColorRole,
    string
  >;
  const palette = { ...core, background: "#101012" };
  const code = presetCode(genexDark, palette);
  assert.match(code, /^ {2}preset\("genex", "Genex", Scheme\.Dark, \[\n/);
  assert.match(code, /\n {2}\]\),$/);
  assert.deepEqual(pastedColors(code), palette);
  assert.match(
    presetCode(preset("rose-light"), preset("rose-light").colors),
    /preset\("rose", "Rosé Pine", Scheme\.Light/,
  );
});

test("pasting keyed colours sets only those roles; stray text sets nothing", () => {
  assert.deepEqual(pastedColors('{ "accent": "#123456", controlBorder: #abc }'), {
    accent: "#123456",
    controlBorder: "#aabbcc",
  });
  assert.equal(pastedColors("#123456 #654321"), null);
  assert.equal(pastedColors("no colours here"), null);
});

test("the changes text lists each changed role from its designed colour", () => {
  const text = changesText(genexDark, { ...genexDark.colors, muted: "#999999" });
  assert.equal(text, "Genex · dark\n  Muted text (muted): #a8a9ac → #999999");
  assert.equal(changesText(genexDark, genexDark.colors), "Genex · dark\n  (unchanged)");
});

test("readability measures each role where it is drawn, against what AA asks of it", () => {
  const ok = readability(genexDark.colors, "foreground");
  assert.ok(ok && ok.ratio > 4.5 && ok.minimum === 4.5);
  const dim = readability({ ...genexDark.colors, muted: "#444444" }, "muted");
  assert.ok(dim && dim.ratio < dim.minimum);
  assert.equal(readability(genexDark.colors, "icon")?.minimum, 3);
  const label = readability({ ...genexDark.colors, accentFill: "#ffffff", accentText: "#ffffff" }, "accentText");
  assert.equal(label?.ratio, 1);
  assert.equal(readability(genexDark.colors, "surface"), null);
});

test("button and icon colours are auto until set, copy as a keyed tail and paste back", () => {
  // A preset that sets no details of its own.
  const plainDark = preset("tokyo-dark");
  const auto = shownColor(plainDark.colors, "accentFill");
  assert.ok(hex(auto));
  const set = withColor(freshDraft(plainDark), "icon", "#abcdef");
  assert.deepEqual(changedRoles(plainDark, shownPalette(set)), ["icon"]);
  assert.equal(withColor(set, "icon", undefined).colors.icon, undefined);
  const palette = { ...plainDark.colors, accentFill: "#123456", icon: "#abcdef" };
  const code = presetCode(plainDark, palette);
  assert.match(code, /\n {2}\], \{\n {4}accentFill: "#123456",\n {4}icon: "#abcdef",\n {2}\}\),$/);
  assert.deepEqual(pastedColors(code), palette);
  assert.match(changesText(plainDark, palette), /Icons \(icon\): auto → #abcdef/);
});

test("a role's driven variables are the ones it alone changes", () => {
  assert.ok(drivenVariables(genexDark.colors, "sidebar").includes("--sidebar"));
  assert.ok(!drivenVariables(genexDark.colors, "sidebar").includes("--background"));
  assert.ok(drivenVariables(genexDark.colors, "accent").includes("--accent-fill"));
});

test("switching scheme opens the same family's other side, else that scheme's Genex", () => {
  assert.equal(counterpart(preset("tokyo-dark"), Scheme.Light, PRESETS).id, "tokyo-light");
  const custom: ThemePreset = { ...genexDark, id: "custom-mine", name: "Mine" };
  assert.equal(counterpart(custom, Scheme.Light, [...PRESETS, custom]).id, "genex-light");
});

test("remembered drafts keep only complete palettes and clamp their knobs", () => {
  const memory = normalizeMemory({
    presetId: "genex-dark",
    x: 12.4,
    y: "far",
    collapsed: true,
    drafts: {
      "genex-dark": { colors: genexDark.colors, knobs: { depth: 9999, lift: "up" } },
      "tokyo-dark": { colors: { background: "#000000" } },
    },
  });
  assert.deepEqual(Object.keys(memory.drafts), ["genex-dark"]);
  assert.equal(memory.drafts["genex-dark"]?.knobs.depth, 250);
  assert.equal(memory.drafts["genex-dark"]?.knobs.lift, 0);
  assert.equal(memory.x, 12);
  assert.equal(memory.y, null);
  assert.equal(memory.collapsed, true);
  assert.deepEqual(normalizeMemory("junk").drafts, {});
  assert.equal(COLOR_ROLES.length, 14);
});

test("the picker's HSV keeps every preset colour exactly through a round trip", async () => {
  const { hexToHsv, hsvToHex } = await import("../../src/renderer/appearance/tweaker/hsv.ts");
  for (const p of PRESETS)
    for (const role of COLOR_ROLES) assert.equal(hsvToHex(hexToHsv(p.colors[role])), p.colors[role]);
  assert.deepEqual(hexToHsv("#ff0000"), { h: 0, s: 1, v: 1 });
  assert.equal(hsvToHex({ h: 120, s: 1, v: 1 }), "#00ff00");
  assert.equal(hsvToHex({ h: 240, s: 0, v: 0 }), "#000000");
});

test("chip and hover text are measured on their own fills", () => {
  const p = { ...genexDark.colors, controlHover: "#ffffff", controlTextHover: "#ffffff" };
  assert.equal(readability(p, "controlTextHover")?.ratio, 1);
  assert.equal(readability(p, "controlHover")?.ratio, 1);
  assert.ok((readability(genexDark.colors, "controlText")?.ratio ?? 0) > 1);
  assert.equal(shownColor(genexDark.colors, "controlHover"), genexDark.colors.hover);
});

test("the selector track and meters show their derived colours until set, and meters are measured on their track", () => {
  const well = shownColor(genexDark.colors, "well");
  assert.ok(hex(well));
  assert.ok(Math.abs(oklch(well)[0] - oklch(genexDark.colors.background)[0]) < 0.02);
  assert.equal(shownColor(genexDark.colors, "chipHover"), genexDark.colors.controlBorder);
  assert.equal(shownColor(genexDark.colors, "meterFill"), genexDark.colors.muted);
  const flat = readability({ ...genexDark.colors, meterTrack: "#777777", meterFill: "#777777" }, "meterTrack");
  assert.deepEqual(flat, { ratio: 1, minimum: 3 });
});

test("the selected segment shows chip hover until set, and its text is measured on it", () => {
  assert.equal(shownColor(genexDark.colors, "thumb"), genexDark.colors.controlBorder);
  assert.equal(shownColor({ ...genexDark.colors, chipHover: "#123456" }, "thumb"), "#123456");
  const flat = { ...genexDark.colors, thumb: "#808080", controlTextHover: "#808080" };
  assert.equal(readability(flat, "thumb")?.ratio, 1);
});

test("the sidebar's selected and hover rows show the fill the app mixes until set, then take their own", () => {
  const { sidebarSelected: _selected, sidebarHover: _hover, ...light } = preset("genex-light").colors;
  assert.deepEqual(
    [shownColor(light, "sidebarSelected"), shownColor(light, "sidebarHover")],
    ["#e6e7e6", "#eeefee"],
    "unset, a light sidebar's rows are the text mixed into it",
  );
  assert.ok(hex(shownColor(genexDark.colors, "sidebarSelected")), "a dark sidebar's too");
  const set = themeVariables({ ...light, sidebarSelected: "#dddddd", sidebarHover: "#eeeeee" }, DEFAULT_CONTRAST);
  assert.deepEqual([set["--sidebar-selected"], set["--sidebar-hover"]], ["#dddddd", "#eeeeee"]);
  assert.equal(readability({ ...light, sidebarSelected: light.foreground }, "sidebarSelected")?.ratio, 1);
  for (const role of ["sidebarSelected", "sidebarHover"] as const)
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `${role}: the panel offers it`,
    );
});

test("the prompt bar's chips wear the canvas chip fill until given their own", () => {
  const plain = { ...genexDark.colors, controlFill: "#202020" };
  assert.equal(themeVariables(plain, DEFAULT_CONTRAST)["--prompt-chip-fill"], undefined, "unset, it follows");
  assert.equal(shownColor(plain, "promptChipFill"), "#202020");
  const set = themeVariables({ ...plain, promptChipFill: "#fafafa" }, DEFAULT_CONTRAST);
  assert.equal(set["--prompt-chip-fill"], "#fafafa");
  assert.equal(set["--control-fill"], "#202020", "the canvas chip does not move");
  const flat = { ...plain, promptChipFill: "#808080", controlText: "#808080" };
  assert.equal(readability(flat, "promptChipFill")?.ratio, 1);
  assert.ok(
    ROLE_GROUPS.some((group) => group.roles.includes("promptChipFill")),
    "the panel offers it",
  );
});

test("shadows are the place's own until set, copy as a keyed tail and paste back", () => {
  const prompt = { y: 6, blur: 20, spread: -2, color: "#102030", alpha: 12 };
  const draft = withShadow(freshDraft(genexDark), "promptBar", prompt);
  assert.deepEqual(shownShadow(genexDark.colors, "promptBar"), SHADOW_AUTO.promptBar);
  assert.deepEqual(shownShadow(draft.colors, "promptBar"), prompt);
  assert.deepEqual(changedShadows(genexDark, draft.colors), ["promptBar"]);
  assert.equal(changeCount(genexDark, draft.colors), 1);
  const code = presetCode(genexDark, draft.colors);
  assert.match(
    code,
    /shadows: \{\n {6}promptBar: \{ y: 6, blur: 20, spread: -2, color: "#102030", alpha: 12 \},\n {4}\},/,
  );
  assert.deepEqual(pastedColors(code), draft.colors);
  assert.match(changesText(genexDark, draft.colors), /Prompt bar shadow \(shadows\.promptBar\): auto → y 6 · blur 20/);
  const cleared = withShadow(draft, "promptBar", undefined);
  assert.equal(cleared.colors.shadows, undefined);
  assert.equal(changeCount(genexDark, cleared.colors), 0);
});

test("a pasted shadow sets only its own place, and a half-written one sets nothing", () => {
  const thumb = { y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0 };
  const draft = withShadow(freshDraft(genexDark), "thumb", thumb);
  const pasted = pastedColors(
    'panel: { y: 12, blur: 40, spread: 0, color: "#000000", alpha: 20 }, promptBar: { y: 3 }',
  );
  assert.deepEqual(pasted, { shadows: { panel: { y: 12, blur: 40, spread: 0, color: "#000000", alpha: 20 } } });
  assert.deepEqual(Object.keys(withColors(draft, pasted ?? {}).colors.shadows ?? {}), ["thumb", "panel"]);
});

test("remembered drafts keep their shadows that read", () => {
  const thumb = { y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0 };
  const memory = normalizeMemory({
    drafts: { "genex-dark": { colors: { ...genexDark.colors, shadows: { thumb, panel: { y: "far" } } } } },
  });
  assert.deepEqual(memory.drafts["genex-dark"]?.colors.shadows, { thumb });
});

test("the logo is the text colour until set, read against the sidebar it sits on", () => {
  const { logo: _, ...plain } = genexDark.colors;
  assert.equal(shownColor(plain, "logo"), plain.foreground);
  const flat = { ...genexDark.colors, logo: genexDark.colors.sidebar };
  assert.deepEqual(readability(flat, "logo"), { ratio: 1, minimum: 3 });
});

test("the graph accent is the accent until set, read as the text it writes on the canvas and its nodes", () => {
  const { graph: _, ...plain } = genexDark.colors;
  assert.equal(shownColor(plain, "graph"), plain.accent);
  const flat = { ...genexDark.colors, graph: genexDark.colors.surface };
  assert.deepEqual(readability(flat, "graph")?.minimum, 4.5);
  assert.ok((readability(flat, "graph")?.ratio ?? 9) < 1.2);
});

test("a tried logo width is remembered within its range and copied as a line for theme.css", () => {
  assert.equal(normalizeMemory({ logoWidth: 9000 }).logoWidth, LOGO_WIDTH.max);
  assert.equal(normalizeMemory({ logoWidth: 96.4 }).logoWidth, 96);
  assert.equal(normalizeMemory({ logoWidth: "big" }).logoWidth, null);
  assert.equal(normalizeMemory({ logoWidth: LOGO_WIDTH.base }).logoWidth, null);
  assert.equal(logoWidthText(null), "");
  assert.match(logoWidthText(96), /--logo-width 80px → 96px/);
});

test("the onboarding art is the accent ink until set, and its own colour once set, read as graphics on the canvas", () => {
  const { art: _art, ...plain } = genexDark.colors;
  assert.equal(shownColor(plain, "art"), themeVariables(plain, DEFAULT_CONTRAST)["--accent-ink"]);
  assert.equal(themeVariables(plain, DEFAULT_CONTRAST)["--art"], undefined, "unset, the art keeps the accent");
  assert.equal(themeVariables({ ...plain, art: "#ff8800" }, DEFAULT_CONTRAST)["--art"], "#ff8800");
  assert.equal(
    themeVariables({ ...plain, art: "#ff8800" }, DEFAULT_CONTRAST)["--accent-ink"],
    themeVariables(plain, DEFAULT_CONTRAST)["--accent-ink"],
    "the accent itself does not move",
  );
  const flat = { ...plain, art: plain.background };
  assert.equal(readability(flat, "art")?.minimum, 3);
  assert.ok((readability(flat, "art")?.ratio ?? 9) < 1.2);
  assert.ok(
    ROLE_GROUPS.some((group) => group.roles.includes("art")),
    "the panel offers it",
  );
});

test("the plan sheet and the sign-in marks keep their faint ink until set, and draw in their own colour once set", () => {
  const { artPaper: _artPaper, artMark: _artMark, ...plain } = genexDark.colors;
  const faint = (alpha: number) =>
    rgbHex(
      channels(plain.background).map((ground, i) => ground + ((channels(plain.foreground)[i] ?? 0) - ground) * alpha),
    );
  assert.equal(shownColor(plain, "artPaper"), faint(SHEET_INK));
  assert.equal(shownColor(plain, "artMark"), faint(MARK_FACE_INK));
  for (const [role, variable] of [
    ["artPaper", "--art-paper"],
    ["artMark", "--art-mark"],
  ] as const) {
    assert.equal(themeVariables(plain, DEFAULT_CONTRAST)[variable], undefined, `${role} unset`);
    assert.equal(themeVariables({ ...plain, [role]: "#fafafa" }, DEFAULT_CONTRAST)[variable], "#fafafa");
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `the panel offers ${role}`,
    );
  }
});

test("the selected sidebar row's icon is the accent until set, and its own colour once set, read on the sidebar", () => {
  const { iconSelected: _iconSelected, ...plain } = genexDark.colors;
  assert.equal(shownColor(plain, "iconSelected"), plain.accent);
  assert.equal(themeVariables(plain, DEFAULT_CONTRAST)["--icon-selected"], undefined, "unset, it keeps the accent");
  const set = themeVariables({ ...plain, iconSelected: "#ff8800" }, DEFAULT_CONTRAST);
  assert.equal(set["--icon-selected"], "#ff8800");
  assert.equal(
    set["--accent-ink"],
    themeVariables(plain, DEFAULT_CONTRAST)["--accent-ink"],
    "the accent does not move",
  );
  const flat = { ...plain, iconSelected: plain.sidebar };
  assert.equal(readability(flat, "iconSelected")?.minimum, 3);
  assert.ok((readability(flat, "iconSelected")?.ratio ?? 9) < 1.3);
  assert.ok(
    ROLE_GROUPS.some((group) => group.roles.includes("iconSelected")),
    "the panel offers it",
  );
});

test("the onboarding buttons keep the accent tint until set, and fill with their own colour once set", () => {
  const plain = genexDark.colors;
  const tint = rgbHex(
    channels(plain.background).map((ground, i) => ground + ((channels(plain.accent)[i] ?? 0) - ground) * 0.12),
  );
  assert.equal(shownColor(plain, "artButton"), tint);
  assert.equal(themeVariables(plain, DEFAULT_CONTRAST)["--art-button"], undefined, "unset, the tint stays");
  const set = themeVariables({ ...plain, artButton: "#e4e6f7" }, DEFAULT_CONTRAST);
  assert.equal(set["--art-button"], "#e4e6f7");
  assert.ok(set["--art-button-hover"], "a set fill gets its own hover");
  assert.ok(
    ROLE_GROUPS.some((group) => group.roles.includes("artButton")),
    "the panel offers it",
  );
});

test("the prompt bar's edge, the empty-state cube and the Live / Assets switch take their own colours once set", () => {
  const { promptEdge: _promptEdge, ...plain } = genexDark.colors;
  const unset = themeVariables(plain, DEFAULT_CONTRAST);
  for (const variable of ["--prompt-edge", "--wire-art", "--switch-fill"])
    assert.equal(unset[variable], undefined, `${variable}: unset, the place keeps its own`);
  const set = themeVariables(
    { ...plain, promptEdge: "#aabbcc", wireArt: "#ff8800", viewSwitch: "#118844" },
    DEFAULT_CONTRAST,
  );
  assert.equal(set["--prompt-edge"], "#aabbcc");
  assert.equal(set["--wire-art"], "#ff8800");
  assert.equal(set["--switch-fill"], "#118844");
  assert.equal(set["--accent-fill"], unset["--accent-fill"], "the accent button does not move");
  assert.equal(set["--accent-ink"], unset["--accent-ink"], "the accent does not move");
  assert.equal(shownColor(plain, "wireArt"), unset["--accent-ink"]);
  assert.equal(shownColor(plain, "viewSwitch"), unset["--accent-fill"]);
  assert.match(shownColor(plain, "promptEdge"), /^#[\da-f]{6}$/);
  for (const role of ["promptEdge", "wireArt", "viewSwitch"] as const)
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `${role}: the panel offers it`,
    );
});

test("the Live / Assets switch is read as the button text on its fill, the cube as a graphic on the canvas", () => {
  const plain = genexDark.colors;
  assert.deepEqual(readability({ ...plain, accentText: "#ffffff", viewSwitch: "#ffffff" }, "viewSwitch"), {
    ratio: 1,
    minimum: 4.5,
  });
  assert.deepEqual(readability({ ...plain, wireArt: plain.background }, "wireArt"), { ratio: 1, minimum: 3 });
});

test("a logo shaded in its own colour is drawn solid, with no secondary ink and no fade", () => {
  const solid = themeVariables({ ...genexDark.colors, logo: "#183de3", logoShade: "#183de3" }, DEFAULT_CONTRAST);
  assert.equal(solid["--logo-2"], solid["--logo"], "the wordmark is one colour");
  assert.equal(solid["--logo-fade"], "1");
  const dark = themeVariables(genexDark.colors, DEFAULT_CONTRAST);
  assert.notEqual(dark["--logo-2"], dark["--logo"], "Genex dark keeps its gradient");
  assert.equal(dark["--logo-fade"], undefined);
  const shaded = themeVariables({ ...genexDark.colors, logoShade: "#123456" }, DEFAULT_CONTRAST);
  assert.equal(shaded["--logo-2"], "#123456");
  assert.equal(shaded["--logo-fade"], undefined);
  assert.match(shownColor(genexDark.colors, "logoShade"), /^#[\da-f]{6}$/);
  assert.ok(
    ROLE_GROUPS.some((group) => group.roles.includes("logoShade")),
    "the panel offers it",
  );
});

test("a tried label type is remembered within its ranges and copied as a line for theme.css", () => {
  const memory = normalizeMemory({
    labelType: { size: 99, tracking: -0.0237, weight: LABEL_TYPE.weight.base, leading: 18 },
  });
  assert.deepEqual(memory.labelType, { size: LABEL_TYPE.size.max, tracking: -0.025 });
  assert.deepEqual(normalizeMemory({ labelType: { size: 14.26 } }).labelType, { size: 14.5 });
  assert.deepEqual(normalizeMemory({ labelType: "big" }).labelType, {});
  assert.equal(labelTypeText({}), "");
  assert.match(
    labelTypeText({ size: 15, tracking: -0.01 }),
    /--label-size 14px → 15px.*--label-tracking -0.015em → -0.01em/,
  );
  assert.deepEqual(LABEL_TYPE_KEYS, ["size", "tracking", "weight"], "line height stays as designed");
});

test("the stage's stripes and their ground are the text's faint ink over the canvas until set", () => {
  const plain = genexDark.colors;
  const unset = themeVariables(plain, DEFAULT_CONTRAST);
  assert.equal(unset["--hatch-stripe"], undefined);
  assert.equal(unset["--hatch-ground"], undefined);
  const faint = rgbHex(
    channels(plain.background).map((ground, i) => ground + ((channels(plain.foreground)[i] ?? 0) - ground) * 0.04),
  );
  assert.equal(shownColor(plain, "hatch"), faint);
  assert.equal(shownColor(plain, "hatchGround"), plain.background);
  const set = themeVariables({ ...plain, hatch: "#202022", hatchGround: "#151517" }, DEFAULT_CONTRAST);
  assert.equal(set["--hatch-stripe"], "#202022");
  assert.equal(set["--hatch-ground"], "#151517");
  assert.equal(set["--stripe"], unset["--stripe"], "hover fills that share the faint ink do not move");
  for (const role of ["hatch", "hatchGround"] as const)
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `${role}: the panel offers it`,
    );
});

test("the selected Settings tab's text is the accent ink until set, read as text on the dialog", () => {
  const plain = genexDark.colors;
  const unset = themeVariables(plain, DEFAULT_CONTRAST);
  assert.equal(unset["--settings-tab"], undefined, "unset, the tab keeps the accent ink");
  assert.equal(shownColor(plain, "settingsTab"), unset["--accent-ink"]);
  const set = themeVariables({ ...plain, settingsTab: "#c0c4ff" }, DEFAULT_CONTRAST);
  assert.equal(set["--settings-tab"], "#c0c4ff");
  assert.equal(set["--accent-ink"], unset["--accent-ink"], "the accent does not move");
  assert.equal(readability({ ...plain, settingsTab: plain.popover }, "settingsTab")?.minimum, 4.5);
  assert.ok(
    ROLE_GROUPS.some((group) => group.roles.includes("settingsTab")),
    "the panel offers it",
  );
});

test("Play's switch and tabs take their blue, track, texts, edges and the unselected tabs' backing from the palette when given, Play's own until then", () => {
  // Genex's own presets set some of Play's colours: start from one that sets none.
  const plain = Object.fromEntries(
    Object.entries(genexDark.colors).filter(([role]) => !role.startsWith("play")),
  ) as typeof genexDark.colors;
  for (const [role, variable] of [
    ["playSelected", "--play-selected"],
    ["playSelectedEdge", "--play-selected-edge"],
    ["playTrack", "--play-switch-track"],
    ["playTrackEdge", "--play-switch-edge"],
    ["playSelectedText", "--play-selected-text"],
    ["playTab", "--play-tab-backing"],
    ["playTabEdge", "--play-tab-edge"],
    ["playTabText", "--play-tab-text"],
    ["playSearchFocus", "--play-search-focus"],
  ] as const) {
    assert.equal(themeVariables(plain, DEFAULT_CONTRAST)[variable], undefined, `${role} unset`);
    assert.equal(themeVariables({ ...plain, [role]: "#2f6bff" }, DEFAULT_CONTRAST)[variable], "#2f6bff");
    assert.ok(hex(shownColor(plain, role)), `${role}: the panel shows a colour while it is unset`);
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `the panel offers ${role}`,
    );
  }
});

/** A preset's colours with none of Play's people, stats or card colours set: the stylesheet's own show. */
const withoutPlayColours = (colors: ThemePreset["colors"]): ThemePreset["colors"] =>
  Object.fromEntries(
    Object.entries(colors).filter(
      ([role]) =>
        !role.startsWith("play") &&
        !(PEOPLE_ROLES as readonly string[]).includes(role) &&
        !(PLAY_HUE_ROLES as readonly string[]).includes(role),
    ),
  ) as ThemePreset["colors"];

test("Play's people, stats and credits colours are the stylesheet's own until set, then their own", () => {
  const dark = withoutPlayColours(genexDark.colors);
  const light = withoutPlayColours(preset("genex-light").colors);
  for (const [role, variable, onDark, onLight] of [
    ["peopleChipText", "--people-chip-ink", "#9fb0ff", "#3d58d8"],
    ["peopleChipNumber", "--people-chip-number", "#d3dbff", "#1e33b4"],
    ["playBlue", "--play-blue", "#4b60bf", "#4b60bf"],
    ["peoplePrimary", "--people-primary-top", "#4b60bf", "#4b60bf"],
    ["peoplePrimaryShade", "--people-primary-bottom", "#3f51a8", "#3f51a8"],
    ["peopleLive", "--people-live", "#22a55b", "#22a55b"],
    ["peopleLiveText", "--people-live-ink", "#5fd18b", "#16803f"],
    ["peoplePro", "--people-pro", "#8d9bff", "#4353d9"],
    ["peopleRequest", "--people-request", "#3f61f5", "#3f61f5"],
    ["statsLine", "--stats-line", "#7d8ff0", "#4b60bf"],
    ["statsUp", "--stats-up", "#5fd18b", "#16803f"],
    ["statsDown", "--stats-down", "#ff8a7a", "#b42318"],
    ["shardLight", "--shard-light", "#aeb7e2", "#aeb7e2"],
    ["shardMid", "--shard-mid", "#6b7fdc", "#4b60bf"],
    ["shardDark", "--shard-dark", "#4555a8", "#313e7c"],
  ] as const) {
    assert.equal(themeVariables(dark, DEFAULT_CONTRAST)[variable], undefined, `${role} unset`);
    assert.equal(themeVariables({ ...dark, [role]: "#2f6bff" }, DEFAULT_CONTRAST)[variable], "#2f6bff");
    assert.equal(shownColor(dark, role), onDark, `${role} on a dark canvas`);
    assert.equal(shownColor(light, role), onLight, `${role} on a light canvas`);
    assert.equal(shownColor({ ...dark, [role]: "#2f6bff" }, role), "#2f6bff");
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `the panel offers ${role}`,
    );
  }
});

test("Play's chips, tint buttons and cards wear the Play switch's selected blue until given their own hue", () => {
  const plain = withoutPlayColours(genexDark.colors);
  const blue = { ...plain, playSelected: "#2f6bff" };
  for (const [role, variable] of [
    ["peopleChip", "--people-chip-hue"],
    ["peopleTint", "--people-tint-hue"],
    ["creditsCard", "--credits-card-hue"],
    ["inviteCard", "--people-invite-hue"],
  ] as const) {
    assert.equal(themeVariables(blue, DEFAULT_CONTRAST)[variable], undefined, `${role} unset`);
    assert.equal(shownColor(plain, role), shownColor(plain, "playSelected"), `${role} shows Play's own blue`);
    assert.equal(shownColor(blue, role), "#2f6bff", `${role} follows the palette's Play blue`);
    assert.equal(themeVariables({ ...blue, [role]: "#ff7a00" }, DEFAULT_CONTRAST)[variable], "#ff7a00");
    assert.equal(shownColor({ ...blue, [role]: "#ff7a00" }, role), "#ff7a00");
    assert.ok(
      ROLE_GROUPS.some((group) => group.roles.includes(role)),
      `the panel offers ${role}`,
    );
  }
  // The credits card follows the chips' hue until it has its own.
  assert.equal(shownColor({ ...blue, peopleChip: "#ff7a00" }, "creditsCard"), "#ff7a00");
});
