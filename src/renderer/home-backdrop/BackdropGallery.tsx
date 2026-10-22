/**
 * The Background panel's gallery: Off, the picture, the live backgrounds as moving tiles (each
 * still until the pointer is on it), the ones a model made and Make your own; then the effects
 * drawn over whichever is chosen. A tile shows the look itself; choosing it puts it on home.
 */
import type { JSX, ReactNode } from "react";
import { useMemo, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { Scheme } from "../appearance/themes.ts";
import { Icon } from "../ui/icons.tsx";
import { BackdropPreview } from "./HomeBackdrop.tsx";
import { makingIn, useMakeState } from "./make-background.ts";
import { MAX_MADE_SHADERS, type MadeShader, removeMadeShader, useMadeShaders } from "./made-shaders.ts";
import { SHADER_PRESETS, type ShaderPreset, shaderFor, withPreset, withShader } from "./presets.ts";
import {
  BACKDROP_RANGES,
  BackdropEffect,
  type BackdropSettings,
  BackdropSource,
  DEFAULT_BACKDROP,
  DEFAULT_BACKDROP_SHADER,
  withEffect,
} from "./settings.ts";
import { ShaderCanvas, type ShaderCanvasMode } from "./ShaderCanvas.tsx";
import { PointerSource } from "./shader-stage.ts";
import { updateBackdrop } from "./store.ts";
import type { Rect, Size } from "./view.ts";

const MESSAGE = {
  backgrounds: t("Backgrounds"),
  effect: t("Effect"),
  off: t("Off"),
  picture: t("Picture"),
  make: t("Make your own"),
  making: t("Making…"),
  connect: t("Connect AI model"),
  full: t("{count, plural, other {# kept}}", { count: MAX_MADE_SHADERS }),
  remove: (name: string) => t("Remove {name}", { name }),
} as const;

/** The effects, as the gallery names them. */
const EFFECTS = [
  { effect: BackdropEffect.None, name: t("None") },
  { effect: BackdropEffect.Lines, name: t("Lines") },
  { effect: BackdropEffect.Dots, name: t("Dots") },
  { effect: BackdropEffect.Ascii, name: "ASCII" },
] as const;

/** A tile moves only under the pointer, at a modest rate; its pointer follows the pointer over it. */
const TILE_LIVE: ShaderCanvasMode = {
  fps: 30,
  maxDensity: 2,
  pointer: PointerSource.Canvas,
  stillTime: 6,
  darkStrength: 1,
};
/** A picture tile draws a small window's worth of the effect, so its marks stay visible at tile size. */
const TILE_WINDOW: Size = { width: 560, height: 350 };
const TILE_HOME: Rect = { x: 0, y: 0, ...TILE_WINDOW };
/** Marks in the theme's own ink in either theme. */
const THEME_INK = { [Scheme.Light]: null, [Scheme.Dark]: null };
/**
 * Home's fine marks (hundreds of columns) vanish below a pixel in a tile a tenth its width: a tile
 * draws a sixth as many columns and rows, and a picture tile, drawn at a window's size and shrunk,
 * dots that many times larger, so the pattern reads at tile size.
 */
const TILE_COARSEN = 6;

/** `settings` with marks coarse enough to read in a tile; `dotScale` grows dots drawn at a window's size. */
function tileMarks(settings: BackdropSettings, dotScale: number): BackdropSettings {
  const fewer = (key: "lineColumns" | "lineRows" | "asciiColumns"): number =>
    Math.max(BACKDROP_RANGES[key].min, Math.round(settings[key] / TILE_COARSEN));
  return {
    ...settings,
    lineColumns: fewer("lineColumns"),
    lineRows: fewer("lineRows"),
    asciiColumns: fewer("asciiColumns"),
    dotStep: settings.dotStep * dotScale,
    dotMin: settings.dotMin * dotScale,
    dotMax: settings.dotMax * dotScale,
    dotCorner: settings.dotCorner * dotScale,
  };
}

const change = (update: (previous: BackdropSettings) => BackdropSettings): void => updateBackdrop(update);

/** One tile: its art over its name, pressed while it is the look on home. */
function Tile({
  look,
  name,
  selected,
  onChoose,
  onRemove,
  onHover,
  children,
}: {
  look: string;
  name: string;
  selected: boolean;
  onChoose: () => void;
  onRemove?: () => void;
  onHover?: (hovered: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="backdrop-tile">
      <button
        type="button"
        className="backdrop-tile-choice"
        aria-pressed={selected}
        data-backdrop-look={look}
        onClick={onChoose}
        onPointerEnter={() => onHover?.(true)}
        onPointerLeave={() => onHover?.(false)}
        onFocus={() => onHover?.(true)}
        onBlur={() => onHover?.(false)}
      >
        <span className="backdrop-tile-art">{children}</span>
        <span className="backdrop-tile-name">{name}</span>
      </button>
      {onRemove && (
        <button type="button" className="backdrop-tile-remove" aria-label={MESSAGE.remove(name)} onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
    </div>
  );
}

/** A live tile: the shader drawn in `settings`, moving while hovered or focused. */
function LiveTile(props: {
  look: string;
  name: string;
  body: string;
  settings: BackdropSettings;
  selected: boolean;
  onChoose: () => void;
  onRemove?: () => void;
}): JSX.Element {
  const [hovered, setHovered] = useState(false);
  return (
    <Tile {...props} onHover={setHovered}>
      <ShaderCanvas
        body={props.body}
        settings={props.settings}
        moving={hovered}
        mode={TILE_LIVE}
        className="backdrop-tile-canvas"
      />
    </Tile>
  );
}

/** A bundled background as it ships, with no effect, over the picture home has (for the ones that draw it). */
function PresetTile({ preset, settings }: { preset: ShaderPreset; settings: BackdropSettings }): JSX.Element {
  const { image } = settings;
  const shown = useMemo(
    () => ({ ...withPreset({ ...DEFAULT_BACKDROP, image }, preset), effect: BackdropEffect.None, strength: 1 }),
    [image, preset],
  );
  return (
    <LiveTile
      look={preset.id}
      name={preset.name}
      body={preset.body}
      settings={shown}
      selected={settings.source === BackdropSource.Shader && settings.shader === preset.id}
      onChoose={() => change((previous) => withPreset(previous, preset))}
    />
  );
}

/** A made background in the colours set now, with no effect. */
function MadeTile({ made, settings }: { made: MadeShader; settings: BackdropSettings }): JSX.Element {
  const selected = settings.source === BackdropSource.Shader && settings.shader === made.id;
  const shown = useMemo(() => ({ ...settings, effect: BackdropEffect.None, strength: 1 }), [settings]);
  const remove = (): void => {
    if (selected) change((previous) => ({ ...previous, shader: DEFAULT_BACKDROP_SHADER }));
    removeMadeShader(made.id);
  };
  return (
    <LiveTile
      look={made.id}
      name={made.title}
      body={made.wgsl}
      settings={shown}
      selected={selected}
      onChoose={() => change((previous) => withShader(previous, made.id))}
      onRemove={remove}
    />
  );
}

/** Make your own: opens the form, or Settings when no model is connected. */
function MakeTile({ connected, full, onMake }: { connected: boolean; full: boolean; onMake: () => void }): JSX.Element {
  const { phase } = useMakeState();
  const busy = makingIn(phase);
  let caption: string | null = null;
  if (!connected) caption = MESSAGE.connect;
  else if (full) caption = MESSAGE.full;
  return (
    <div className="backdrop-tile">
      <button
        type="button"
        className="backdrop-tile-choice backdrop-make-tile"
        data-backdrop-make
        data-busy={busy || undefined}
        onClick={onMake}
      >
        <span className="backdrop-tile-art">
          <Icon name="sparkle" size={18} />
          {caption && <span className="backdrop-make-caption">{caption}</span>}
        </span>
        <span className="backdrop-tile-name">{busy ? MESSAGE.making : MESSAGE.make}</span>
      </button>
    </div>
  );
}

/** The picture drawn small through `effect`, marks in the theme's ink so the pattern reads at tile size. */
function PictureArt({ effect, image }: { effect: BackdropEffect; image: string }): JSX.Element {
  const shown = useMemo(
    () =>
      tileMarks(
        {
          ...withEffect({ ...DEFAULT_BACKDROP, source: BackdropSource.Picture, image, colors: THEME_INK }, effect),
          strength: 1,
        },
        TILE_COARSEN,
      ),
    [effect, image],
  );
  return <BackdropPreview settings={shown} window={TILE_WINDOW} home={TILE_HOME} />;
}

/** Off, then the picture as it is drawn now: the first choices, before the live ones. */
function StillTiles({ settings }: { settings: BackdropSettings }): JSX.Element {
  return (
    <>
      <Tile
        look={BackdropSource.Off}
        name={MESSAGE.off}
        selected={settings.source === BackdropSource.Off}
        onChoose={() => change((previous) => ({ ...previous, source: BackdropSource.Off }))}
      >
        <Icon name="close" size={14} />
      </Tile>
      <Tile
        look={BackdropSource.Picture}
        name={MESSAGE.picture}
        selected={settings.source === BackdropSource.Picture}
        onChoose={() => change((previous) => ({ ...previous, source: BackdropSource.Picture }))}
      >
        <PictureArt effect={settings.effect} image={settings.image} />
      </Tile>
    </>
  );
}

/** An effect over what is chosen: over the live background, moving under the pointer, or over the picture. */
function EffectTile({ effect, name, settings }: { effect: BackdropEffect; name: string; settings: BackdropSettings }) {
  const [hovered, setHovered] = useState(false);
  const made = useMadeShaders();
  // The tile shows the effect as choosing it would draw it: in its tuned look, at full strength.
  const shown = useMemo(() => tileMarks({ ...withEffect(settings, effect), strength: 1 }, 1), [settings, effect]);
  const choose = (): void =>
    change((previous) => ({
      ...withEffect(previous, effect),
      source: previous.source === BackdropSource.Off ? BackdropSource.Picture : previous.source,
    }));
  return (
    <Tile
      look={`effect:${effect}`}
      name={name}
      selected={settings.source !== BackdropSource.Off && settings.effect === effect}
      onChoose={choose}
      onHover={setHovered}
    >
      {settings.source === BackdropSource.Shader ? (
        <ShaderCanvas
          body={shaderFor(settings.shader, made).body}
          settings={shown}
          moving={hovered}
          mode={TILE_LIVE}
          className="backdrop-tile-canvas"
        />
      ) : (
        <PictureArt effect={effect} image={settings.image} />
      )}
    </Tile>
  );
}

/** A group of tiles, under its name when it shows one. */
function Section({
  title,
  kind,
  titled = true,
  children,
}: {
  title: string;
  kind: string;
  titled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="backdrop-section" aria-label={title}>
      {titled && <h3 className="backdrop-section-title">{title}</h3>}
      <div className="backdrop-gallery" data-kind={kind}>
        {children}
      </div>
    </section>
  );
}

/** Every look home's background can take, as tiles. */
export function BackdropGallery({
  settings,
  connected,
  onMake,
}: {
  settings: BackdropSettings;
  connected: boolean;
  onMake: () => void;
}): JSX.Element {
  const made = useMadeShaders();
  return (
    <>
      {/* The panel's own heading names this group. */}
      <Section title={MESSAGE.backgrounds} kind="backgrounds" titled={false}>
        <StillTiles settings={settings} />
        {SHADER_PRESETS.map((preset) => (
          <PresetTile key={preset.id} preset={preset} settings={settings} />
        ))}
        {made.map((entry) => (
          <MadeTile key={entry.id} made={entry} settings={settings} />
        ))}
        <MakeTile connected={connected} full={made.length >= MAX_MADE_SHADERS} onMake={onMake} />
      </Section>
      <Section title={MESSAGE.effect} kind="effect">
        {EFFECTS.map((entry) => (
          // A tile's canvas keeps one kind of art for its life: a new source is a new tile.
          <EffectTile
            key={`${entry.effect}-${settings.source}`}
            effect={entry.effect}
            name={entry.name}
            settings={settings}
          />
        ))}
      </Section>
    </>
  );
}
