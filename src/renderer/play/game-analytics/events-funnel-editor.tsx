/**
 * The form that makes a funnel, drawn in place under the funnels' title: a name, the days every
 * step must happen within, and one to eight steps, each an event from the list with an optional
 * property and the value it must have. Every field is held to the limits main refuses by before
 * anything is sent (`events-funnel-form.ts`); what genex.games refuses is said beside the form,
 * and what was typed stays so it can be sent again.
 */
import type { FormEvent, JSX, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { EVENT_LIMITS, type EventFunnelDraft, FUNNEL_DAYS_MAX } from "../../../shared/game-analytics.ts";
import { FUNNEL_NAME_MAX, PROPERTY_NAME_MAX } from "../../../shared/game-analytics-asks.ts";
import { Icon } from "../../ui/icons.tsx";
import { Button } from "../../ui/Button.tsx";
import {
  addStep,
  canAddStep,
  canRemoveStep,
  changeStep,
  checkFunnelForm,
  emptyFunnelForm,
  FormField,
  type FormIssue,
  type FormStep,
  FormProblem,
  type FunnelForm,
  funnelFormIssues,
  issueOf,
  removeStep,
  type StepChange,
} from "./events-funnel-form.ts";
import { funnelRefusal } from "./events-view.ts";
import { EVENTS_WORDS as WORDS } from "./events-words.ts";
import { formatNumber } from "./kit/index.ts";

/** The problems that show as the field is typed in; the others wait for a first try to save. */
const LIVE_PROBLEMS: ReadonlySet<FormProblem> = new Set([
  FormProblem.TooLong,
  FormProblem.Characters,
  FormProblem.NotWhole,
  FormProblem.OutOfRange,
]);

/** The limit a field is held to, for the sentence that names it. */
const LIMIT = {
  [FormField.Name]: FUNNEL_NAME_MAX,
  [FormField.Days]: FUNNEL_DAYS_MAX,
  [FormField.Event]: EVENT_LIMITS.nameLength,
  [FormField.Property]: PROPERTY_NAME_MAX,
  [FormField.Value]: EVENT_LIMITS.textLength,
} as const satisfies Record<FormField, number>;

/** The name a field carries in `data-game-analytics-field`: the field, and the step it is in. */
export function fieldKey(field: FormField, step: number | null): string {
  return step === null ? field : `${field}-${step}`;
}

/** What a problem says about a field. */
function problemText(issue: FormIssue): string {
  const words = WORDS.form.problem;
  const max = LIMIT[issue.field];
  if (issue.problem === FormProblem.TooLong) return words[FormProblem.TooLong](max, formatNumber(max));
  if (issue.problem === FormProblem.OutOfRange) return words[FormProblem.OutOfRange](max, formatNumber(max));
  return words[issue.problem];
}

/** A labelled field with the problem under it, when there is one to show. */
function Field({
  id,
  label,
  issue,
  children,
}: {
  id: string;
  label: string;
  issue: FormIssue | null;
  children: (props: { id: string; invalid: boolean; describedBy: string | undefined }) => ReactNode;
}): JSX.Element {
  const messageId = `${id}-problem`;
  return (
    <div className="game-analytics-events-field" data-invalid={issue ? true : undefined}>
      <label className="game-analytics-events-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, invalid: issue !== null, describedBy: issue ? messageId : undefined })}
      {issue && (
        <p className="game-analytics-events-problem" id={messageId} data-game-analytics-problem={issue.problem}>
          {problemText(issue)}
        </p>
      )}
    </div>
  );
}

/** What `TextField` is given: its label, the problem to show, and the text with how it changes. */
interface TextFieldProps {
  id: string;
  label: string;
  issue: FormIssue | null;
  /** The name it carries in `data-game-analytics-field`. */
  field: string;
  value: string;
  onChange: (value: string) => void;
  /** A number of days: the number field with its range. */
  days?: boolean;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/** A line of typed words, or the days. What is typed is the creator's own: kept out of usage recordings. */
function TextField({
  id,
  label,
  issue,
  field,
  value,
  onChange,
  days,
  placeholder,
  inputRef,
}: TextFieldProps): JSX.Element {
  return (
    <Field id={id} label={label} issue={issue}>
      {(props) => (
        <input
          ref={inputRef}
          id={props.id}
          type={days ? "number" : "text"}
          inputMode={days ? "numeric" : undefined}
          min={days ? 1 : undefined}
          max={days ? FUNNEL_DAYS_MAX : undefined}
          step={days ? 1 : undefined}
          className="game-analytics-events-input"
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          data-game-analytics-field={field}
          data-analytics-mask={days ? undefined : true}
          onChange={(change) => onChange(change.target.value)}
        />
      )}
    </Field>
  );
}

/** What `StepRow` is given. */
interface StepRowProps {
  step: FormStep;
  index: number;
  /** Names the step's fields. */
  base: string;
  events: readonly string[];
  /** The problem to show on a field of this step, or null. */
  problem: (field: FormField) => FormIssue | null;
  removable: boolean;
  onChange: (change: StepChange) => void;
  onRemove: () => void;
}

/** One step: its event, its optional property and value, and the button that takes it out. */
function StepRow({ step, index, base, events, problem, removable, onChange, onRemove }: StepRowProps): JSX.Element {
  const id = `${base}-${step.key}`;
  return (
    <li className="game-analytics-events-step" data-game-analytics-form-step={index}>
      <span className="game-analytics-events-stepnumber">{WORDS.form.step(index + 1)}</span>
      <div className="game-analytics-events-stepfields">
        <Field id={`${id}-event`} label={WORDS.form.event} issue={problem(FormField.Event)}>
          {(field) => (
            <select
              id={field.id}
              className="game-analytics-events-input"
              value={step.event}
              aria-invalid={field.invalid}
              aria-describedby={field.describedBy}
              data-game-analytics-field={fieldKey(FormField.Event, index)}
              data-analytics-mask
              onChange={(change) => onChange({ event: change.target.value })}
            >
              {events.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <TextField
          id={`${id}-property`}
          label={WORDS.form.property}
          issue={problem(FormField.Property)}
          field={fieldKey(FormField.Property, index)}
          value={step.property}
          onChange={(property) => onChange({ property })}
        />
        <TextField
          id={`${id}-value`}
          label={WORDS.form.value}
          issue={problem(FormField.Value)}
          field={fieldKey(FormField.Value, index)}
          value={step.value}
          onChange={(value) => onChange({ value })}
        />
      </div>
      <button
        type="button"
        className="game-analytics-events-iconbutton"
        aria-label={WORDS.form.removeStep(index + 1)}
        disabled={!removable}
        data-game-analytics-remove-step={index}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}

/** What genex.games' refusal says, when it refused, then Save and Cancel. */
function EditorActions({
  busy,
  refusal,
  onCancel,
}: {
  busy: boolean;
  refusal: string | null;
  onCancel: () => void;
}): JSX.Element {
  return (
    <>
      {refusal !== null && (
        <p className="game-analytics-events-problem" role="alert" data-game-analytics-refused>
          {refusal}
        </p>
      )}
      <div className="game-analytics-events-actions">
        <Button type="submit" variant="default" busy={busy} data-game-analytics-save-funnel>
          {busy ? WORDS.form.saving : WORDS.form.save}
        </Button>
        <Button variant="ghost" disabled={busy} data-game-analytics-cancel-funnel onClick={onCancel}>
          {WORDS.form.cancel}
        </Button>
      </div>
    </>
  );
}

/** What `FunnelEditor` is given. */
export interface FunnelEditorProps {
  /** The names a step can be: the game's own events, then the ones Genex counts. */
  events: readonly string[];
  /** The event the first step starts on. */
  firstEvent: string;
  /** Save the funnel; rejects with genex.games' refusal. */
  onSave: (draft: EventFunnelDraft) => Promise<unknown>;
  /** The funnel was saved: the form is done. */
  onSaved: () => void;
  onCancel: () => void;
  /** The form as it starts; a new one when left out. */
  initial?: FunnelForm;
}

/** The form that makes a funnel. */
export function FunnelEditor({
  events,
  firstEvent,
  onSave,
  onSaved,
  onCancel,
  initial,
}: FunnelEditorProps): JSX.Element {
  const base = useId();
  const [form, setForm] = useState<FunnelForm>(() => initial ?? emptyFunnelForm(firstEvent));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => nameField.current?.focus(), []);

  const issues = funnelFormIssues(form, events);
  const shown = (field: FormField, step: number | null): FormIssue | null => {
    const issue = issueOf(issues, field, step);
    return issue && (attempted || LIVE_PROBLEMS.has(issue.problem)) ? issue : null;
  };

  const submit = async (submitted: FormEvent<HTMLFormElement>): Promise<void> => {
    submitted.preventDefault();
    if (busy) return;
    const check = checkFunnelForm(form, events);
    if ("issues" in check) {
      setAttempted(true);
      const first = check.issues[0];
      const key = first && fieldKey(first.field, first.step);
      submitted.currentTarget.querySelector<HTMLElement>(`[data-game-analytics-field="${key}"]`)?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await onSave(check.draft);
    } catch (error) {
      setBusy(false);
      setRefusal(funnelRefusal(error));
      return;
    }
    onSaved();
  };

  const leave = (pressed: KeyboardEvent<HTMLFormElement>): void => {
    if (pressed.key !== "Escape" || busy) return;
    pressed.stopPropagation();
    onCancel();
  };

  return (
    <form
      className="game-analytics-events-form"
      data-game-analytics-funnel-form
      aria-labelledby={`${base}-title`}
      noValidate
      onSubmit={submit}
      onKeyDown={leave}
    >
      <h3 id={`${base}-title`} className="game-analytics-events-subtitle">
        {WORDS.form.title}
      </h3>
      <div className="game-analytics-events-fields">
        <TextField
          id={`${base}-name`}
          label={WORDS.form.name}
          issue={shown(FormField.Name, null)}
          field={fieldKey(FormField.Name, null)}
          value={form.name}
          placeholder={WORDS.form.namePlaceholder}
          inputRef={nameField}
          onChange={(name) => setForm({ ...form, name })}
        />
        <TextField
          days
          id={`${base}-days`}
          label={WORDS.form.days}
          issue={shown(FormField.Days, null)}
          field={fieldKey(FormField.Days, null)}
          value={form.days}
          onChange={(days) => setForm({ ...form, days })}
        />
      </div>
      <fieldset className="game-analytics-events-steps">
        <legend className="game-analytics-events-label">{WORDS.form.steps}</legend>
        <p className="game-analytics-events-hint">{WORDS.form.stepsHint}</p>
        <ol className="game-analytics-events-steplist">
          {form.steps.map((step, index) => (
            <StepRow
              key={step.key}
              step={step}
              index={index}
              base={base}
              events={events}
              problem={(field) => shown(field, index)}
              removable={canRemoveStep(form)}
              onChange={(change) => setForm(changeStep(form, step.key, change))}
              onRemove={() => setForm(removeStep(form, step.key))}
            />
          ))}
        </ol>
        {canAddStep(form) && (
          <Button
            variant="ghost"
            className="game-analytics-events-addstep"
            data-game-analytics-add-step
            onClick={() => setForm(addStep(form, events[0] ?? firstEvent))}
          >
            <Icon name="plus" size={14} />
            {WORDS.form.addStep}
          </Button>
        )}
      </fieldset>
      <EditorActions busy={busy} refusal={refusal} onCancel={onCancel} />
    </form>
  );
}
