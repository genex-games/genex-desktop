/**
 * The home background's controls: a gallery of looks (live backgrounds, the ones a model made,
 * Make your own, and the picture effects), then the chosen look's own settings: its picture, its
 * colours and its sliders. Settings → Appearance shows them under a preview; home's own Background
 * button shows them over home itself, where the change is seen as it is made.
 */
import type { ChangeEvent, CSSProperties, JSX, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import {
  addBackdropUpload,
  type BackdropPicture,
  BUNDLED_BACKDROPS,
  listBackdropUploads,
  MAX_BACKDROP_UPLOADS,
  removeBackdropUpload,
  subscribeBackdropUploads,
  UploadProblem,
} from "./images.ts";
import {
  ASCII_RAMP_MAX,
  BACKDROP_RANGES,
  BackdropEffect,
  type BackdropColors,
  type BackdropNumber,
  type BackdropSettings,
  BackdropSource,
  backdropDecimals,
  DEFAULT_BACKDROP,
  EFFECT_LOOKS,
  DEFAULT_BACKDROP_IMAGE,
  DotGrid,
} from "./settings.ts";
import { useAppearance } from "../appearance/store.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { BackdropGallery } from "./BackdropGallery.tsx";
import type { GenerationModel } from "./generation-model.ts";
import { MakeBackground } from "./MakeBackground.tsx";
import { useMadeShaders } from "./made-shaders.ts";
import { shaderFor } from "./presets.ts";
import { updateBackdrop } from "./store.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Input } from "../ui/input.tsx";
import { ViewSwitcher } from "../ui/view-switcher.tsx";

const MESSAGE = {
  settings: t("Settings"),
  picture: t("Picture"),
  upload: t("Upload"),
  addedPicture: (number: number) => t("Added picture {number}", { number }),
  remove: (name: string) => t("Remove {name}", { name }),
  color: t("Color"),
  colors: t("Colors"),
  main: t("Main color"),
  accent: t("Accent color"),
  useTheme: t("Use theme"),
  grid: t("Grid"),
  characters: t("Characters"),
  problems: {
    [UploadProblem.TooLarge]: t("Choose a picture smaller than 40 MB."),
    [UploadProblem.Unreadable]: t("That file could not be read as a picture. Choose a JPG, PNG or WebP."),
    [UploadProblem.Full]: t(
      "You have {count, plural, one {# picture} other {# pictures}}. Remove one to add another.",
      {
        count: MAX_BACKDROP_UPLOADS,
      },
    ),
    [UploadProblem.Unsaved]: t("The picture could not be saved. Free some disk space and try again."),
  } satisfies Record<UploadProblem, string>,
} as const;

const GRIDS = [
  { key: DotGrid.Regular, label: t("Regular") },
  { key: DotGrid.Benday, label: t("Ben-Day") },
] as const;

/** Each slider's name. */
const LABELS: Record<BackdropNumber, string> = {
  strength: t("Strength"),
  blur: t("Blur"),
  grain: t("Grain"),
  gamma: t("Gamma"),
  blackPoint: t("Black point"),
  whitePoint: t("White point"),
  lineColumns: t("Columns"),
  lineRows: t("Rows"),
  dotStep: t("Grid size"),
  dotMin: t("Smallest dot"),
  dotMax: t("Largest dot"),
  dotAngle: t("Angle"),
  dotCorner: t("Corner radius"),
  dotNoise: t("Noise"),
  threshold: t("Threshold"),
  asciiColumns: t("Columns"),
  speed: t("Speed"),
  scale: t("Size"),
  glow: t("Glow"),
};
/** A live background's own sliders. */
const LIVE_SLIDERS: readonly BackdropNumber[] = ["speed", "scale", "glow"];
/** Each effect's sliders, all shown, before the image's preparation. */
const EFFECT_SLIDERS: Record<BackdropEffect, readonly BackdropNumber[]> = {
  [BackdropEffect.None]: [],
  [BackdropEffect.Lines]: ["lineColumns", "lineRows", "threshold"],
  [BackdropEffect.Dots]: ["dotStep", "dotMin", "dotMax", "dotAngle", "threshold", "dotCorner", "dotNoise"],
  [BackdropEffect.Ascii]: ["asciiColumns", "threshold"],
};
const TONE: readonly BackdropNumber[] = ["grain", "gamma", "blackPoint", "whitePoint"];
/** Blur softens a still picture before its marks are drawn; a live scene is already soft at its size. */
const PICTURE_TONE: readonly BackdropNumber[] = ["blur", ...TONE];

/** The image's preparation an effect reads: none without one, no blur over a live scene. */
function toneFor(settings: BackdropSettings): readonly BackdropNumber[] {
  if (settings.effect === BackdropEffect.None) return [];
  return settings.source === BackdropSource.Shader ? TONE : PICTURE_TONE;
}
const PICTURE_TYPES = "image/png,image/jpeg,image/webp,image/gif";
const HEX = /^#[0-9a-f]{6}$/i;
/** The colour shown when the theme's cannot be read as hex. */
const FALLBACK_INK = "#000000";

/** A theme colour as `#rrggbb`, what a swatch shows until a colour is chosen. */
function themeHex(name: string): string {
  const color = getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
  return HEX.test(color) ? color : FALLBACK_INK;
}

const change = (patch: Partial<BackdropSettings>): void => updateBackdrop((previous) => ({ ...previous, ...patch }));

/** A titled group of settings. */
function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="backdrop-group">
      <h3 className="backdrop-section-title">{title}</h3>
      {children}
    </div>
  );
}

/**
 * A number as a thick bar: its name inside at the start, its value inside at the end, the filled
 * share showing where it sits. The whole bar is the handle; arrow keys step it.
 */
function Slider({ name, value }: { name: BackdropNumber; value: number }): JSX.Element {
  const { min, max, step } = BACKDROP_RANGES[name];
  const id = `backdrop-${name}`;
  const fill = (value - min) / (max - min);
  return (
    <div className="backdrop-slider" style={{ "--fill": fill } as CSSProperties}>
      <input
        id={id}
        type="range"
        aria-label={LABELS[name]}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => change({ [name]: Number(event.target.value) })}
      />
      <span className="backdrop-slider-fill" aria-hidden="true" />
      <span className="backdrop-slider-label" aria-hidden="true">
        {LABELS[name]}
      </span>
      <output htmlFor={id} className="backdrop-slider-value">
        {value.toFixed(backdropDecimals(name))}
      </output>
    </div>
  );
}

function Sliders({ names, settings }: { names: readonly BackdropNumber[]; settings: BackdropSettings }) {
  return (
    <div className="backdrop-sliders">
      {names.map((name) => (
        <Slider key={name} name={name} value={settings[name]} />
      ))}
    </div>
  );
}

/** The bundled pictures and the added ones, with thumbnails that live as long as the list. */
function usePictures(): BackdropPicture[] {
  const [added, setAdded] = useState<BackdropPicture[]>([]);
  useEffect(() => {
    let urls: string[] = [];
    let live = true;
    const load = async (): Promise<void> => {
      const uploads = await listBackdropUploads();
      if (!live) return;
      for (const url of urls) URL.revokeObjectURL(url);
      urls = uploads.map(({ blob }) => URL.createObjectURL(blob));
      setAdded(
        uploads.map(({ id }, index) => ({
          id,
          label: MESSAGE.addedPicture(index + 1),
          url: urls[index] ?? "",
          added: true,
        })),
      );
    };
    void load();
    const stop = subscribeBackdropUploads(() => void load());
    return () => {
      live = false;
      stop();
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);
  return [...BUNDLED_BACKDROPS, ...added];
}

function PictureChoice({
  picture,
  selected,
  onRemove,
}: {
  picture: BackdropPicture;
  selected: boolean;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="backdrop-picture">
      <button
        type="button"
        className="backdrop-picture-choice"
        aria-pressed={selected}
        aria-label={picture.label}
        data-backdrop-picture={picture.id}
        onClick={() => change({ image: picture.id })}
      >
        <img src={picture.url} alt="" draggable={false} />
      </button>
      {picture.added && (
        <button
          type="button"
          className="backdrop-picture-remove"
          aria-label={MESSAGE.remove(picture.label)}
          onClick={onRemove}
        >
          <Icon name="close" size={10} />
        </button>
      )}
    </div>
  );
}

function PicturePicker({ selected }: { selected: string }): JSX.Element {
  const pictures = usePictures();
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");
  const add = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const chosen = event.target.files?.[0];
    event.target.value = "";
    if (!chosen) return;
    const added = await addBackdropUpload(chosen);
    if ("problem" in added) {
      setProblem(MESSAGE.problems[added.problem]);
      return;
    }
    setProblem("");
    change({ image: added.id });
  };
  const remove = (picture: BackdropPicture): void => {
    if (picture.id === selected) change({ image: DEFAULT_BACKDROP_IMAGE });
    void removeBackdropUpload(picture.id);
  };
  const full = pictures.filter((picture) => picture.added).length >= MAX_BACKDROP_UPLOADS;
  return (
    <Group title={MESSAGE.picture}>
      <div className="backdrop-pictures" role="group" aria-label={MESSAGE.picture}>
        {pictures.map((picture) => (
          <PictureChoice
            key={picture.id}
            picture={picture}
            selected={picture.id === selected}
            onRemove={() => remove(picture)}
          />
        ))}
        {!full && (
          <button
            type="button"
            className="backdrop-picture-add"
            data-backdrop-upload
            onClick={() => file.current?.click()}
          >
            <Icon name="plus" size={14} />
            {MESSAGE.upload}
          </button>
        )}
        <input
          ref={file}
          type="file"
          accept={PICTURE_TYPES}
          className="hidden"
          aria-label={MESSAGE.upload}
          onChange={(event) => void add(event)}
        />
      </div>
      {problem && (
        <p className="appearance-error backdrop-problem" role="alert">
          {problem}
        </p>
      )}
    </Group>
  );
}

/** One colour as a swatch chip: the colour and its hex, the system picker under it. */
function Swatch({
  label,
  color,
  onPick,
  data,
}: {
  label: string;
  color: string;
  onPick: (color: string) => void;
  data?: string;
}): JSX.Element {
  return (
    <label className="backdrop-swatch" data-backdrop-color={data}>
      <span className="backdrop-swatch-dot" style={{ background: color }} />
      <span className="backdrop-swatch-hex">{color}</span>
      <input type="color" aria-label={label} value={color} onChange={(event) => onPick(event.target.value)} />
    </label>
  );
}

/**
 * The look's colours in the theme on screen: a live background's two, or a picture's marks' one,
 * each the theme's until picked, with the way back to it. The other theme keeps its own.
 */
function ColorGroup({ settings }: { settings: BackdropSettings }): JSX.Element {
  const { scheme } = useAppearance();
  const live = settings.source === BackdropSource.Shader;
  const main = live ? "shaderColors" : "colors";
  const mains: BackdropColors = live ? settings.shaderColors : settings.colors;
  const accents = settings.shaderAccents;
  const set = (key: "colors" | "shaderColors" | "shaderAccents", next: string | null): void =>
    updateBackdrop((previous) => ({ ...previous, [key]: { ...previous[key], [scheme]: next } }));
  const picked = mains[scheme] !== null || (live && accents[scheme] !== null);
  const useTheme = (): void => {
    set(main, null);
    if (live) set("shaderAccents", null);
  };
  return (
    <Group title={live ? MESSAGE.colors : MESSAGE.color}>
      <div className="backdrop-swatches">
        <Swatch
          label={live ? MESSAGE.main : MESSAGE.color}
          color={mains[scheme] ?? themeHex("--ink")}
          onPick={(color) => set(main, color)}
          data="main"
        />
        {live && (
          <Swatch
            label={MESSAGE.accent}
            color={accents[scheme] ?? themeHex("--accent-ink")}
            onPick={(color) => set("shaderAccents", color)}
            data="accent"
          />
        )}
        {picked && (
          <Button
            variant="ghost"
            className="ms-auto bg-foreground/[0.07] hover:bg-foreground/[0.12]"
            onClick={useTheme}
          >
            {MESSAGE.useTheme}
          </Button>
        )}
      </div>
    </Group>
  );
}

/** The ramp field: what is typed shows at once; a ramp too short to draw with waits. */
function CharactersField({ value }: { value: string }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Group title={MESSAGE.characters}>
      <Input
        id="backdrop-characters"
        aria-label={MESSAGE.characters}
        className="backdrop-characters"
        value={draft}
        maxLength={ASCII_RAMP_MAX}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          if (Array.from(event.target.value).length >= 2) change({ asciiCharacters: event.target.value });
        }}
        onBlur={() => setDraft(value)}
      />
    </Group>
  );
}

/** An effect's own choices beyond its sliders: the dot grid, or the characters. */
function EffectChoices({ settings }: { settings: BackdropSettings }): JSX.Element | null {
  if (settings.effect === BackdropEffect.Ascii) return <CharactersField value={settings.asciiCharacters} />;
  if (settings.effect !== BackdropEffect.Dots) return null;
  return (
    <Group title={MESSAGE.grid}>
      <ViewSwitcher
        items={GRIDS}
        active={settings.dotGrid}
        onSelect={(dotGrid) => change({ dotGrid })}
        label={MESSAGE.grid}
        sans
      />
    </Group>
  );
}

/** The chosen look's settings: its picture, its colours, then every slider it has, and its effect's grid or characters. */
function LookSettings({ settings }: { settings: BackdropSettings }): JSX.Element {
  const made = useMadeShaders();
  const live = settings.source === BackdropSource.Shader;
  const plain = settings.effect === BackdropEffect.None;
  const showsPicture = !live || shaderFor(settings.shader, made).readsPicture;
  // A picture with no effect is drawn in its own colours: there are no marks to colour.
  const coloured = live || !plain;
  const sliders: BackdropNumber[] = [
    "strength",
    ...(live ? LIVE_SLIDERS : []),
    ...EFFECT_SLIDERS[settings.effect],
    ...toneFor(settings),
  ];
  return (
    <div className="backdrop-look-settings" data-backdrop-look-settings>
      {showsPicture && <PicturePicker selected={settings.image} />}
      {coloured && <ColorGroup settings={settings} />}
      <Group title={MESSAGE.settings}>
        <Sliders names={sliders} settings={settings} />
      </Group>
      <EffectChoices settings={settings} />
    </div>
  );
}

/** Everything that sets the background, below whatever heading its place gives it. */
export function BackdropControls({
  settings,
  model,
}: {
  settings: BackdropSettings;
  /** The model Make your own writes with; null when none is connected. */
  model: GenerationModel | null;
}): JSX.Element {
  const [making, setMaking] = useState(false);
  const make = (): void => {
    if (model) setMaking(true);
    else openSettings(SettingsSection.Providers);
  };
  return (
    <div className="backdrop-controls">
      <BackdropGallery settings={settings} connected={model !== null} onMake={make} />
      {making && model && <MakeBackground model={model} onClose={() => setMaking(false)} />}
      {!making && settings.source !== BackdropSource.Off && <LookSettings settings={settings} />}
    </div>
  );
}

/** Back to the defaults and the effect's tuned look, keeping the source, the effect, the picture and the shader. */
export function resetBackdrop(): void {
  updateBackdrop(({ source, effect, image, shader }) => ({
    ...DEFAULT_BACKDROP,
    ...EFFECT_LOOKS[effect],
    source,
    effect,
    image,
    shader,
  }));
}
