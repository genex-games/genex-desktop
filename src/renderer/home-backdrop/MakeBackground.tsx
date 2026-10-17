/**
 * Make your own, in the Background panel: a filter over the picture or a scene of its own, a
 * description (or one of a few ideas), the model it goes to, and the making's progress or its
 * problem. A made background goes behind home at once; the form closes once the model, shown how
 * it looks, has made it better.
 */
import type { FormEvent, JSX, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { BackdropShaderKind, SHADER_PROMPT_MAX_CHARS } from "../../shared/backdrop-shader.ts";
import { useAppearance } from "../appearance/store.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { StatusOrb } from "../ui/StatusOrb.tsx";
import { ViewSwitcher } from "../ui/view-switcher.tsx";
import type { GenerationModel } from "./generation-model.ts";
import { MAX_MADE_SHADERS } from "./made-shaders.ts";
import { clearMakeProblem, MakePhase, MakeProblem, makeBackground, makingIn, useMakeState } from "./make-background.ts";
import type { BackdropSettings } from "./settings.ts";
import type { LookInputs } from "./shader-look.ts";
import { useBackdrop } from "./store.ts";
import { themeReading } from "./theme-reading.ts";

const MESSAGE = {
  label: "Describe your background",
  kind: "Kind",
  kinds: [
    { key: BackdropShaderKind.Filter, label: "Filter the picture" },
    { key: BackdropShaderKind.Scene, label: "Its own scene" },
  ],
  placeholders: {
    [BackdropShaderKind.Filter]: "A night-vision security camera, its timestamp burned in",
    [BackdropShaderKind.Scene]: "Koi drifting through a neon night market, seen from above",
  } satisfies Record<BackdropShaderKind, string>,
  ideas: "Ideas",
  ideasFor: {
    [BackdropShaderKind.Filter]: [
      "Melting VHS tape with tracking errors",
      "Infrared satellite scan sweeping across",
      "Newspaper halftone, the ink bleeding",
      "Sonar returns painting the scene in sweeps",
    ],
    [BackdropShaderKind.Scene]: [
      "Wireframe terrain flying by at dusk",
      "Radar sweep over a sleeping city grid",
      "A dead terminal's cursor leaving trails",
      "Particles orbiting a faint signal",
    ],
  } satisfies Record<BackdropShaderKind, readonly string[]>,
  make: "Make it",
  cancel: "Cancel",
  model: (name: string) => `Made by ${name}`,
  connect: "Connect AI model",
  writing: "Writing your background…",
  fixing: "Fixing a shader error…",
  refining: "Looking at it and making it better…",
  problems: {
    [MakeProblem.NoModel]: "Connect an AI model to make a background.",
    [MakeProblem.NoReply]: "The model didn't answer. Try again.",
    [MakeProblem.Refused]: "The model's shader couldn't run. Try again, or describe it another way.",
    [MakeProblem.Broken]: "The model's shader didn't compile. Try again, or describe it another way.",
    [MakeProblem.NoGpu]: "This Mac can't draw live backgrounds.",
    [MakeProblem.Full]: `You have ${MAX_MADE_SHADERS} backgrounds. Remove one to make another.`,
  } satisfies Record<MakeProblem, string>,
} as const;

/** The progress line for a making in progress. */
const PROGRESS: Partial<Record<MakePhase, string>> = {
  [MakePhase.Writing]: MESSAGE.writing,
  [MakePhase.Fixing]: MESSAGE.fixing,
  [MakePhase.Refining]: MESSAGE.refining,
};

/** What a made background's look is drawn in: the picture, and the colours and glow home shows it in. */
function lookInputs(settings: BackdropSettings, scheme: keyof BackdropSettings["shaderColors"]): LookInputs {
  const theme = themeReading();
  return {
    picture: settings.image,
    ink: settings.shaderColors[scheme] ?? theme.ink,
    accent: settings.shaderAccents[scheme] ?? theme.accent,
    page: theme.page,
    glow: settings.glow,
  };
}

/** A few descriptions to start from: choosing one puts it in the field. They stay while typing, so the form keeps its height. */
function Ideas({ kind, onPick }: { kind: BackdropShaderKind; onPick: (idea: string) => void }): JSX.Element {
  return (
    <fieldset className="backdrop-make-ideas" aria-label={MESSAGE.ideas}>
      {MESSAGE.ideasFor[kind].map((idea) => (
        <button
          key={idea}
          type="button"
          className="backdrop-make-idea"
          data-backdrop-make-idea
          onClick={() => onPick(idea)}
        >
          {idea}
        </button>
      ))}
    </fieldset>
  );
}

/** The form; `onClose` hides it, which a finished making does too. */
export function MakeBackground({ model, onClose }: { model: GenerationModel; onClose: () => void }): JSX.Element {
  const { phase, problem } = useMakeState();
  const settings = useBackdrop();
  const { scheme } = useAppearance();
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<BackdropShaderKind>(BackdropShaderKind.Filter);
  const field = useRef<HTMLTextAreaElement>(null);
  const busy = makingIn(phase);
  const wasBusy = useRef(busy);
  useEffect(() => {
    field.current?.focus();
    return clearMakeProblem;
  }, []);
  // A making that ends with no problem has put its background behind home: the form's work is done.
  useEffect(() => {
    if (wasBusy.current && phase === MakePhase.Idle) onClose();
    wasBusy.current = busy;
  }, [phase, busy, onClose]);
  const make = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!busy && prompt.trim())
      void makeBackground({ prompt, modelKey: model.key, kind, look: lookInputs(settings, scheme) });
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) make(event);
  };
  return (
    <form className="backdrop-make" data-backdrop-make-form onSubmit={make}>
      <ViewSwitcher
        items={MESSAGE.kinds}
        active={kind}
        onSelect={(next) => !busy && setKind(next)}
        label={MESSAGE.kind}
        sans
      />
      <label htmlFor="backdrop-make-prompt" className="backdrop-section-title">
        {MESSAGE.label}
      </label>
      <textarea
        ref={field}
        id="backdrop-make-prompt"
        className="backdrop-make-prompt"
        data-backdrop-make-prompt
        rows={3}
        maxLength={SHADER_PROMPT_MAX_CHARS}
        placeholder={MESSAGE.placeholders[kind]}
        value={prompt}
        readOnly={busy}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={keys}
      />
      {!busy && (
        <Ideas
          kind={kind}
          onPick={(idea) => {
            setPrompt(idea);
            field.current?.focus();
          }}
        />
      )}
      {busy && (
        <div className="backdrop-make-status">
          <StatusOrb />
          <span role="status" data-shimmer className="chat-status-shimmer">
            {PROGRESS[phase] ?? MESSAGE.writing}
          </span>
        </div>
      )}
      {problem && (
        <p className="appearance-error backdrop-make-problem" role="alert">
          {MESSAGE.problems[problem]}
        </p>
      )}
      <div className="backdrop-make-actions">
        <span className="backdrop-make-model">{MESSAGE.model(model.name)}</span>
        {problem === MakeProblem.NoModel ? (
          <Button variant="ghost" onClick={() => openSettings(SettingsSection.Providers)}>
            {MESSAGE.connect}
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            {MESSAGE.cancel}
          </Button>
        )}
        <Button type="submit" variant="default" disabled={busy || !prompt.trim()} data-backdrop-make-send>
          <Icon name="sparkle" size={14} />
          {MESSAGE.make}
        </Button>
      </div>
    </form>
  );
}
