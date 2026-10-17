/**
 * The live backgrounds Genex ships, each a shader body. Choosing one puts the default colours back
 * and keeps everything else set (strength, speed, size, glow, the effect over it, the picture), so
 * a quiet look stays quiet.
 */
import { readsPicture } from "../../shared/backdrop-shader.ts";
import type { MadeShader } from "./made-shaders.ts";
import {
  BackdropEffect,
  type BackdropSettings,
  BackdropSource,
  DEFAULT_BACKDROP,
  DEFAULT_BACKDROP_SHADER,
} from "./settings.ts";
import { DATAMOSH_SHADER } from "../../shared/backdrop-shaders/datamosh.ts";
import { FLARE_SHADER } from "../../shared/backdrop-shaders/flare.ts";
import { PHOSPHOR_SHADER } from "../../shared/backdrop-shaders/phosphor.ts";
import { PIXEL_SORT_SHADER } from "../../shared/backdrop-shaders/pixel-sort.ts";
import { THERMAL_SHADER } from "../../shared/backdrop-shaders/thermal.ts";
import { VHS_SHADER } from "../../shared/backdrop-shaders/vhs.ts";

/** A bundled live background. */
export interface ShaderPreset {
  id: string;
  name: string;
  body: string;
  /** Whether it draws the chosen picture, so the picture picker applies to it. */
  readsPicture: boolean;
}

function preset(id: string, name: string, body: string): ShaderPreset {
  return { id: `preset:${id}`, name, body, readsPicture: readsPicture(body) };
}

/** The bundled live backgrounds, in the gallery's order. */
export const SHADER_PRESETS: readonly ShaderPreset[] = [
  preset("thermal", "Thermal", THERMAL_SHADER),
  preset("datamosh", "Datamosh", DATAMOSH_SHADER),
  preset("phosphor", "Phosphor", PHOSPHOR_SHADER),
  preset("vhs", "VHS", VHS_SHADER),
  preset("flare", "Flare", FLARE_SHADER),
  preset("pixel-sort", "Pixel sort", PIXEL_SORT_SHADER),
];

/** The bundled background `id` names, if it is one. */
export function shaderPreset(id: string): ShaderPreset | undefined {
  return SHADER_PRESETS.find((candidate) => candidate.id === id);
}

/** The default bundled background, drawn when a chosen one is gone. */
const FALLBACK_PRESET: ShaderPreset = shaderPreset(DEFAULT_BACKDROP_SHADER) ?? SHADER_PRESETS[0];

/** The body and name of the shader `id` names, bundled or made; the default when it is gone. */
export function shaderFor(
  id: string,
  made: readonly MadeShader[],
): { body: string; name: string; readsPicture: boolean } {
  const bundled = shaderPreset(id);
  if (bundled) return bundled;
  const own = made.find((entry) => entry.id === id);
  if (own) return { body: own.wgsl, name: own.title, readsPicture: readsPicture(own.wgsl) };
  return FALLBACK_PRESET;
}

/**
 * Settings showing a live background: an effect already over a live one stays over the new one;
 * coming from a picture, it starts with none.
 */
export function withShader(previous: BackdropSettings, shader: string): BackdropSettings {
  const effect = previous.source === BackdropSource.Shader ? previous.effect : BackdropEffect.None;
  return { ...previous, source: BackdropSource.Shader, effect, shader };
}

/** Settings showing a bundled background in the default colours, everything else as it was set. */
export function withPreset(previous: BackdropSettings, chosen: ShaderPreset): BackdropSettings {
  const { shaderColors, shaderAccents } = DEFAULT_BACKDROP;
  return { ...withShader(previous, chosen.id), shaderColors, shaderAccents };
}
