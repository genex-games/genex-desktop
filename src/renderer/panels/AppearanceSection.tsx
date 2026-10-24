import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import {
  APPEARANCE_MODES,
  CONTRAST_MAX,
  CUSTOM_PRESET_PREFIX,
  DEFAULT_APPEARANCE,
  DEFAULT_CONTRAST,
  MAX_SAVED_PRESETS,
  PRESET_NAME_MAX,
  PRESETS,
  COLOR_ROLES,
  THEME_FILE_MAX_BYTES,
  WCAG_AA_TEXT,
  contrastRatio,
  defaultPresetId,
  onColor,
  exportTheme,
  hex,
  importTheme,
  paletteFor,
  selectedPreset,
  themeVariables,
  type Appearance,
  AppearanceMode,
  type ColorRole,
  type Palette,
  Scheme,
  type ThemeSelection,
} from "../appearance/themes.ts";
import { useAppearance } from "../appearance/store.ts";
import { HomeBackdropSection } from "./HomeBackdropSection.tsx";
import { t } from "../../shared/i18n.ts";
import { isLanguageChoice, LOCALE_NAMES, LOCALES, SYSTEM_LANGUAGE } from "../../shared/locale.ts";
import { languageChoice, switchLanguage, windowLanguage } from "../language.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Input } from "../ui/input.tsx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../ui/dropdown-menu.tsx";

const LABELS: Record<ColorRole, string> = {
  background: t("Background"),
  foreground: t("Text"),
  accent: t("Accent"),
  surface: t("Surfaces"),
  sidebar: t("Sidebar"),
  popover: t("Menus"),
  field: t("Inputs"),
  hover: t("Hover"),
  muted: t("Secondary text"),
  border: t("Dividers"),
  controlBorder: t("Control borders"),
  success: t("Success"),
  warning: t("Warning"),
  danger: t("Error"),
};
/** The colours every theme shows up front; the rest wait under "Customize theme". */
const MAIN_ROLES: readonly ColorRole[] = ["accent", "background", "foreground"];
const MORE_ROLES = COLOR_ROLES.filter((role) => !MAIN_ROLES.includes(role));
/** The surfaces a theme's text has to stay readable on. */
const TEXT_SURFACES: readonly ColorRole[] = ["background", "surface", "sidebar", "popover", "field", "hover"];
const MODE_LABEL: Record<AppearanceMode, string> = { system: t("System"), light: t("Light"), dark: t("Dark") };
const UI_FONT_OPTIONS = [
  { value: "studio", label: t("Studio default") },
  { value: "system", label: t("System") },
];
const CONTENT_FONT_OPTIONS = [
  { value: "inherit", label: t("Same as interface") },
  { value: "system", label: t("System") },
  { value: "serif", label: "Georgia" },
  { value: "mono", label: "Geist Mono" },
];
const CODE_FONT_OPTIONS = [
  { value: "geist", label: "Geist Mono" },
  { value: "system", label: t("System mono") },
];
function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; swatch?: Palette }[];
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="appearance-choice" aria-label={label}>
          {selected?.swatch && (
            <span
              className="theme-swatch"
              aria-hidden
              style={{ background: selected.swatch.background, color: selected.swatch.accent }}
            >
              Aa
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label ?? value}</span>
          <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="appearance-menu">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2 py-2">
              <span className="flex min-w-0 items-center gap-2">
                {option.swatch && (
                  <span
                    aria-hidden
                    className="theme-swatch"
                    style={{ background: option.swatch.background, color: option.swatch.accent }}
                  >
                    Aa
                  </span>
                )}
                <span className="min-w-0 break-words">{option.label}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function SettingRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="appearance-row">
      <span>{label}</span>
      <div className="appearance-value">{children}</div>
    </div>
  );
}
function ColorField({
  role,
  value,
  scheme,
  onChange,
}: {
  role: ColorRole;
  value: string;
  scheme: Scheme;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  useEffect(() => setDraft(value), [value]);
  const invalid = !hex(draft);
  const commit = () => {
    const color = hex(draft);
    if (color) {
      onChange(color);
      setDraft(color);
    }
  };
  return (
    <div className="color-control-group">
      <div className="color-control" data-invalid={invalid}>
        <input
          type="color"
          value={value}
          aria-label={t("{scheme, select, light {light} other {dark}} {color} color", { scheme, color: LABELS[role] })}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          aria-label={t("{scheme, select, light {light} other {dark}} {color} hex", { scheme, color: LABELS[role] })}
          aria-invalid={invalid}
          aria-describedby={invalid ? id : undefined}
          value={draft}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </div>
      {invalid && (
        <span id={id} className="text-red text-xs">
          {t("Use #RGB or #RRGGBB.")}
        </span>
      )}
    </div>
  );
}
function ThemePreview({ colors }: { colors: Palette }) {
  return (
    <span
      className="appearance-mini"
      aria-hidden
      style={
        {
          "--preview-bg": colors.background,
          "--preview-side": colors.sidebar,
          "--preview-surface": colors.surface,
          "--preview-line": colors.border,
          "--preview-text": colors.foreground,
          "--preview-accent": colors.accent,
        } as CSSProperties
      }
    >
      <span className="mini-sidebar">
        <i />
        <i />
        <i />
      </span>
      <span className="mini-content">
        <i />
        <i />
        <span className="mini-composer">
          <i />
        </span>
      </span>
    </span>
  );
}
/** The editing state and actions one scheme's theme editor shares with its parts. */
function useThemeEditor(scheme: Scheme) {
  const { appearance, scheme: active, update } = useAppearance();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selection = appearance[scheme];
  const change = (next: Partial<ThemeSelection>) =>
    update((prev) => ({ ...prev, [scheme]: { ...prev[scheme], ...next } }));
  const adjust = (role: ColorRole, value: string) => change({ overrides: { ...selection.overrides, [role]: value } });
  const save = (themeName: string, colors: Palette, contrast: number) => {
    if (appearance.saved.length >= MAX_SAVED_PRESETS) {
      setError(
        t("You have {count, plural, one {# saved preset} other {# saved presets}}. Remove one before saving another.", {
          count: MAX_SAVED_PRESETS,
        }),
      );
      return false;
    }
    const id = `${CUSTOM_PRESET_PREFIX}${crypto.randomUUID()}`;
    const name = themeName.trim().slice(0, PRESET_NAME_MAX) || t("Custom theme");
    update((prev) => ({
      ...prev,
      saved: [...prev.saved, { id, name, scheme, colors, contrast }],
      [scheme]: { preset: id, overrides: {}, contrast },
    }));
    return true;
  };
  return {
    scheme,
    appearance,
    active,
    update,
    selection,
    preset: selectedPreset(appearance, scheme),
    palette: paletteFor(appearance, scheme),
    custom: Object.keys(selection.overrides).length > 0,
    change,
    adjust,
    save,
    error,
    setError,
    notice,
    setNotice,
  };
}
type ThemeEditorModel = ReturnType<typeof useThemeEditor>;

/** How readable a palette's text is once its contrast setting is applied. */
type Readability = { ratio: number; corrected: boolean; mixedSurfaces: boolean };
function readability(palette: Palette, contrast: number): Readability {
  const resolved = themeVariables(palette, contrast)["--foreground"];
  const text = resolved ?? palette.foreground;
  return {
    ratio: contrastRatio(palette.foreground, palette.background),
    corrected: resolved !== palette.foreground,
    mixedSurfaces: TEXT_SURFACES.some((role) => contrastRatio(text, palette[role]) < WCAG_AA_TEXT),
  };
}
function readabilityHint({ ratio, corrected, mixedSurfaces }: Readability): string {
  if (mixedSurfaces) return t("Some surfaces cannot share readable text. Choose backgrounds with similar brightness.");
  if (corrected) return t("Text adjusted for readability.");
  return t("Text on background: {ratio}:1.", { ratio: ratio.toFixed(2) });
}

function ColorRow({ editor, role }: { editor: ThemeEditorModel; role: ColorRole }) {
  return (
    <SettingRow label={LABELS[role]}>
      <ColorField
        role={role}
        scheme={editor.scheme}
        value={editor.palette[role]}
        onChange={(color) => editor.adjust(role, color)}
      />
    </SettingRow>
  );
}
function ThemeHeading({ editor, mixedSurfaces }: { editor: ThemeEditorModel; mixedSurfaces: boolean }) {
  const { scheme, palette } = editor;
  const reset = () => {
    editor.change({ ...DEFAULT_APPEARANCE[scheme], overrides: {} });
    editor.setNotice(t("Theme reset to Genex."));
    editor.setError("");
  };
  return (
    <div className="appearance-theme-heading">
      <h3>{scheme === Scheme.Light ? t("Light theme") : t("Dark theme")}</h3>
      {editor.active === scheme && <span className="appearance-active">{t("Active")}</span>}
      <Button
        variant={mixedSurfaces ? "default" : "ghost"}
        className="ms-auto"
        style={mixedSurfaces ? { background: palette.accent, color: onColor(palette.accent) } : undefined}
        aria-label={t("Reset {scheme, select, light {light} other {dark}} theme", { scheme })}
        onClick={reset}
      >
        {t("Reset")}
      </Button>
    </div>
  );
}
function PresetRow({ editor }: { editor: ThemeEditorModel }) {
  const { scheme, appearance } = editor;
  const choose = (id: string) => {
    const contrast = appearance.saved.find((p) => p.id === id)?.contrast ?? DEFAULT_CONTRAST;
    editor.change({ preset: id, overrides: {}, contrast });
    editor.setError("");
    editor.setNotice("");
  };
  return (
    <SettingRow label={t("Preset")}>
      <Choice
        label={t("{scheme, select, light {light} other {dark}} theme preset", { scheme })}
        value={editor.selection.preset}
        options={[...PRESETS, ...appearance.saved]
          .filter((p) => p.scheme === scheme)
          .map((p) => ({ value: p.id, label: p.name, swatch: p.colors }))}
        onChange={choose}
      />
    </SettingRow>
  );
}
function PresetActions({ editor }: { editor: ThemeEditorModel }) {
  const { scheme, preset, palette } = editor;
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const startSaving = () => {
    setSaving(!saving);
    setName(editor.custom ? t("{name} custom", { name: preset.name }) : preset.name);
    editor.setError("");
  };
  const remove = () =>
    editor.update((prev) => ({
      ...prev,
      saved: prev.saved.filter((p) => p.id !== preset.id),
      [scheme]: { ...prev[scheme], preset: defaultPresetId(scheme), overrides: palette },
    }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editor.save(name, palette, editor.selection.contrast)) return;
    setSaving(false);
    editor.setNotice(t("Preset saved."));
  };
  return (
    <>
      <div className="appearance-actions">
        <Button variant="secondary" onClick={startSaving}>
          {t("Save as preset…")}
        </Button>
        {preset.id.startsWith(CUSTOM_PRESET_PREFIX) && (
          <Button variant="ghost" onClick={remove}>
            {t("Remove preset")}
          </Button>
        )}
      </div>
      {saving && (
        <form className="appearance-save" onSubmit={submit}>
          <Input
            autoFocus
            aria-label={t("{scheme, select, light {light} other {dark}} preset name", { scheme })}
            placeholder={t("Preset name")}
            value={name}
            maxLength={PRESET_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={!name.trim()}>
            {t("Save")}
          </Button>
        </form>
      )}
    </>
  );
}
function ThemeCustomize({ editor, check }: { editor: ThemeEditorModel; check: Readability }) {
  const { scheme, selection } = editor;
  return (
    <details className="appearance-details">
      <summary>
        {t("Customize theme")}
        {editor.custom ? <span className="text-muted-foreground font-normal">{t("Edited")}</span> : null}
      </summary>
      <div className="appearance-customize">
        {MORE_ROLES.map((role) => (
          <ColorRow key={role} editor={editor} role={role} />
        ))}
        <SettingRow label={<label htmlFor={`${scheme}-contrast`}>{t("Contrast")}</label>}>
          <input
            id={`${scheme}-contrast`}
            type="range"
            min={0}
            max={CONTRAST_MAX}
            step={1}
            value={selection.contrast}
            onChange={(e) => editor.change({ contrast: Number(e.target.value) })}
          />
          <output htmlFor={`${scheme}-contrast`}>{selection.contrast}</output>
        </SettingRow>
        <p className="appearance-hint">
          {readabilityHint(check)} {t("Action labels adjust to the accent.")}
        </p>
        <PresetActions editor={editor} />
      </div>
    </details>
  );
}

/** Whether the theme JSON panel takes a pasted import or shows an export to copy by hand. */
/** Which way the theme JSON box is open: pasting a theme in, or copying this one out. */
const ShareMode = {
  Import: "import",
  Export: "export",
} as const;
type ShareMode = (typeof ShareMode)[keyof typeof ShareMode];

/** Reads a chosen theme file into the import box, refusing one over the import limit. */
async function readThemeFile(
  input: HTMLInputElement,
  setSource: (text: string) => void,
  setError: (message: string) => void,
): Promise<void> {
  const selected = input.files?.[0];
  input.value = "";
  if (!selected) return;
  if (selected.size > THEME_FILE_MAX_BYTES) {
    setError(t("Choose a theme smaller than 128 KB."));
    return;
  }
  try {
    setSource(await selected.text());
    setError("");
  } catch {
    setError(t("Could not read the file. Choose another theme."));
  }
}
function ImportControls({
  editor,
  source,
  setSource,
  onImport,
  onCancel,
}: {
  editor: ThemeEditorModel;
  source: string;
  setSource: (text: string) => void;
  onImport: () => void;
  onCancel: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <p className="appearance-hint">
        {t("Genex tokens or VS Code JSON/JSONC. UI colors only; missing colors use Genex defaults.")}
      </p>
      <div className="appearance-actions">
        <Button variant="default" disabled={!source.trim()} onClick={onImport}>
          {t("Import theme")}
        </Button>
        <Button onClick={() => file.current?.click()}>{t("Choose file…")}</Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
      <input
        ref={file}
        type="file"
        accept=".json,.jsonc,.tokens,application/json"
        className="hidden"
        aria-label={t("Choose {scheme, select, light {light} other {dark}} theme file", { scheme: editor.scheme })}
        onChange={(event) => void readThemeFile(event.target, setSource, editor.setError)}
      />
    </>
  );
}
function ThemeShare({ editor }: { editor: ThemeEditorModel }) {
  const { scheme, setError, setNotice } = editor;
  const [share, setShare] = useState<ShareMode | null>(null);
  const [source, setSource] = useState("");
  const toggleImport = () => {
    setShare(share === ShareMode.Import ? null : ShareMode.Import);
    setSource("");
    setError("");
    setNotice("");
  };
  const copy = async () => {
    const text = exportTheme(editor.appearance, scheme);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t("Theme copied."));
      setShare(null);
    } catch {
      setSource(text);
      setShare(ShareMode.Export);
      setNotice(t("Select and copy the theme below."));
    }
  };
  const applyImport = () => {
    try {
      const imported = importTheme(source, scheme);
      if (imported.scheme !== scheme)
        throw new Error(
          imported.scheme === Scheme.Light
            ? t("This is a light theme. Import it in the light theme section.")
            : t("This is a dark theme. Import it in the dark theme section."),
        );
      if (!editor.save(imported.name, imported.colors, imported.contrast)) return;
      setShare(null);
      setSource("");
      setError("");
      setNotice(t("Imported {name}.", { name: imported.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Could not import this theme."));
    }
  };
  const cancel = () => {
    setShare(null);
    setError("");
  };
  return (
    <>
      <div className="appearance-actions appearance-share">
        <Button variant="ghost" onClick={toggleImport} aria-expanded={share === ShareMode.Import}>
          {t("Import…")}
        </Button>
        <Button variant="ghost" onClick={() => void copy()}>
          {t("Copy theme")}
        </Button>
        <span className="appearance-hint" role="status">
          {editor.notice}
        </span>
      </div>
      {share && (
        <div className="appearance-import">
          <label htmlFor={`${scheme}-theme-json`}>
            {share === ShareMode.Import ? t("Paste theme JSON") : t("Theme JSON")}
          </label>
          <textarea
            id={`${scheme}-theme-json`}
            spellCheck={false}
            value={source}
            readOnly={share === ShareMode.Export}
            onChange={(event) => {
              setSource(event.target.value);
              setError("");
            }}
            placeholder={t("Genex color tokens or VS Code UI colors")}
          />
          {share === ShareMode.Import && (
            <ImportControls
              editor={editor}
              source={source}
              setSource={setSource}
              onImport={applyImport}
              onCancel={cancel}
            />
          )}
        </div>
      )}
    </>
  );
}
function ThemeEditor({ scheme }: { scheme: Scheme }) {
  const editor = useThemeEditor(scheme);
  const { palette } = editor;
  const check = readability(palette, editor.selection.contrast);
  return (
    <section
      className="appearance-theme"
      aria-label={t("{scheme, select, light {light} other {dark}} theme", { scheme })}
    >
      <ThemeHeading editor={editor} mixedSurfaces={check.mixedSurfaces} />
      <PresetRow editor={editor} />
      {MAIN_ROLES.map((role) => (
        <ColorRow key={role} editor={editor} role={role} />
      ))}
      {check.mixedSurfaces && (
        <p
          role="alert"
          className="rounded-control p-2 text-xs"
          style={{ background: palette.background, color: onColor(palette.background) }}
        >
          {t("These surfaces need different text colors. Use similar background brightness, or reset this theme.")}
        </p>
      )}
      <ThemeCustomize editor={editor} check={check} />
      <ThemeShare editor={editor} />
      {editor.error && (
        <p className="appearance-error" role="alert">
          {editor.error}
        </p>
      )}
    </section>
  );
}

function ModeOption({ mode, light, dark }: { mode: AppearanceMode; light: Palette; dark: Palette }) {
  const { appearance, update } = useAppearance();
  return (
    <label className="appearance-mode">
      <input
        type="radio"
        name="appearance-mode"
        value={mode}
        checked={appearance.mode === mode}
        onChange={() => update((prev) => ({ ...prev, mode }))}
      />
      <span className="appearance-mode-art">
        {mode === AppearanceMode.System ? (
          <>
            <ThemePreview colors={light} />
            <span className="appearance-mode-half">
              <ThemePreview colors={dark} />
            </span>
          </>
        ) : (
          <ThemePreview colors={mode === AppearanceMode.Light ? light : dark} />
        )}
      </span>
      <span>{MODE_LABEL[mode]}</span>
    </label>
  );
}
function TypographySection() {
  const { appearance, update } = useAppearance();
  return (
    <section className="appearance-typography" aria-label={t("Typography")}>
      <h3>{t("Typography")}</h3>
      <SettingRow label={t("Interface font")}>
        <Choice
          label={t("Interface font")}
          value={appearance.uiFont}
          options={UI_FONT_OPTIONS}
          onChange={(uiFont) => update((prev) => ({ ...prev, uiFont: uiFont as Appearance["uiFont"] }))}
        />
      </SettingRow>
      <SettingRow label={t("Content font")}>
        <Choice
          label={t("Content font")}
          value={appearance.contentFont}
          options={CONTENT_FONT_OPTIONS}
          onChange={(contentFont) =>
            update((prev) => ({ ...prev, contentFont: contentFont as Appearance["contentFont"] }))
          }
        />
      </SettingRow>
      <SettingRow label={t("Code font")}>
        <Choice
          label={t("Code font")}
          value={appearance.codeFont}
          options={CODE_FONT_OPTIONS}
          onChange={(codeFont) => update((prev) => ({ ...prev, codeFont: codeFont as Appearance["codeFont"] }))}
        />
      </SettingRow>
    </section>
  );
}
/** The app's language: the Mac's (named) first, then each language in its own name. */
function LanguageSection() {
  const choice = languageChoice();
  const options = [
    {
      value: SYSTEM_LANGUAGE,
      label: t("System ({language})", { language: LOCALE_NAMES[windowLanguage(SYSTEM_LANGUAGE)] }),
    },
    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
  ];
  const choose = (next: string): void => {
    if (next !== choice && isLanguageChoice(next)) void switchLanguage(window.studio, next);
  };
  return (
    <section className="appearance-typography" aria-label={t("Language")} data-language-setting>
      <h3>{t("Language")}</h3>
      <SettingRow label={t("App language")}>
        <Choice label={t("App language")} value={choice} options={options} onChange={choose} />
      </SettingRow>
      <p className="appearance-hint">{t("Genex reloads its window to switch.")}</p>
    </section>
  );
}
/** The mode hint while the theme follows the Mac: which of its two themes shows now. */
function followsMacHint(scheme: Scheme): string {
  return scheme === Scheme.Light
    ? t("Follows your Mac. Light theme is active.")
    : t("Follows your Mac. Dark theme is active.");
}
export function AppearanceSection() {
  const { appearance, scheme, error, update } = useAppearance();
  const light = paletteFor(appearance, Scheme.Light);
  const dark = paletteFor(appearance, Scheme.Dark);
  return (
    <div data-appearance className="appearance-section">
      <LanguageSection />
      <fieldset className="appearance-modes">
        <legend>{t("Theme")}</legend>
        <div className="appearance-mode-options">
          {APPEARANCE_MODES.map((mode) => (
            <ModeOption key={mode} mode={mode} light={light} dark={dark} />
          ))}
        </div>
      </fieldset>
      <p className="appearance-hint appearance-mode-hint">
        {appearance.mode === AppearanceMode.System
          ? followsMacHint(scheme)
          : t("Changes apply immediately and save on this Mac.")}
      </p>
      <HomeBackdropSection />
      <ThemeEditor scheme={Scheme.Light} />
      <ThemeEditor scheme={Scheme.Dark} />
      <TypographySection />
      {error && (
        <p role="alert" className="appearance-error">
          {error}
        </p>
      )}
      <Button
        variant="ghost"
        onClick={() => update((prev) => ({ ...structuredClone(DEFAULT_APPEARANCE), saved: prev.saved }))}
      >
        {t("Restore default appearance")}
      </Button>
    </div>
  );
}
