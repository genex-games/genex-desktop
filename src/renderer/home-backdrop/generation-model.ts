/**
 * The model Make your own writes with: the one picked in home's composer, else the last one picked
 * in any game chat, else the first the picker would choose; none when no model is connected.
 */
import { useMemo } from "react";
import { resolveChoice, toChoices } from "../model-choices.ts";
import { useEngines } from "../state/hooks.ts";
import { readText, STORAGE_KEYS } from "../storage.ts";

/** A model that can write a background: its picker key and its name. */
export interface GenerationModel {
  key: string;
  name: string;
}

/** The model for Make your own; null when none is connected. `picked` is home's composer pick, if shown. */
export function useGenerationModel(picked?: string | null): GenerationModel | null {
  const engines = useEngines((s) => s.list);
  return useMemo(() => {
    const usable = toChoices(engines).filter((choice) => !choice.disabled);
    if (!usable.length) return null;
    const wanted = resolveChoice(usable, picked ?? readText(STORAGE_KEYS.lastModel));
    const choice = wanted && !wanted.disabled ? wanted : resolveChoice(usable, null);
    return choice && !choice.disabled ? { key: choice.key, name: choice.name } : null;
  }, [engines, picked]);
}
