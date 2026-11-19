/**
 * The form that makes a funnel, without React: what is typed in it, what each step does to it and
 * what is wrong with it. Main refuses over-long or odd input instead of cutting it, so every field
 * is held to the contract's and the asks module's limits here first, and what is sent is exactly
 * what was typed (trimmed). A funnel has one to `FUNNEL_STEPS_MAX` steps, each an event from the
 * list with, optionally, one property and the value it must have: both or neither.
 */
import {
  EVENT_LIMITS,
  EVENT_NAME,
  type EventFunnelDraft,
  FUNNEL_DAYS_MAX,
  FUNNEL_STEPS_MAX,
} from "../../../shared/game-analytics.ts";
import { FUNNEL_NAME_MAX, PROPERTY_NAME_MAX } from "../../../shared/game-analytics-asks.ts";

/** What is wrong with a field. */
export const FormProblem = {
  Empty: "empty",
  TooLong: "too_long",
  Characters: "characters",
  NotWhole: "not_whole",
  OutOfRange: "out_of_range",
  Pair: "pair",
  UnknownEvent: "unknown_event",
} as const;
export type FormProblem = (typeof FormProblem)[keyof typeof FormProblem];

/** The fields of the form. */
export const FormField = {
  Name: "name",
  Days: "days",
  Event: "event",
  Property: "property",
  Value: "value",
} as const;
export type FormField = (typeof FormField)[keyof typeof FormField];

/** The days a new funnel starts with. */
export const DEFAULT_FUNNEL_DAYS = 7;

/** Control characters (C0, DEL, C1), the two line separators and the characters that turn text around: main refuses them. */
const HIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u;
const WHOLE_NUMBER = /^\d+$/;

/** One step as it is typed: `key` keeps it in place while steps come and go. */
export interface FormStep {
  key: number;
  event: string;
  property: string;
  value: string;
}

/** The form as it is typed; `days` is the text of the number field. */
export interface FunnelForm {
  name: string;
  days: string;
  steps: FormStep[];
  /** The key the next step gets. */
  nextKey: number;
}

/** A change to one step's fields. */
export type StepChange = Partial<Pick<FormStep, "event" | "property" | "value">>;

/** One thing wrong with the form: the field, the step it is in (null for the name and the days) and what. */
export interface FormIssue {
  field: FormField;
  step: number | null;
  problem: FormProblem;
}

/** The funnel to save, or what is wrong with the form. */
export type FunnelCheck = { draft: EventFunnelDraft } | { issues: FormIssue[] };

/** A form with one step on `event`, no name, and the default days. */
export function emptyFunnelForm(event: string): FunnelForm {
  return {
    name: "",
    days: String(DEFAULT_FUNNEL_DAYS),
    steps: [{ key: 0, event, property: "", value: "" }],
    nextKey: 1,
  };
}

/** Whether another step fits. */
export const canAddStep = (form: FunnelForm): boolean => form.steps.length < FUNNEL_STEPS_MAX;

/** Whether a step can go: a funnel keeps at least one. */
export const canRemoveStep = (form: FunnelForm): boolean => form.steps.length > 1;

/** The form with a step on `event` at the end; the form itself when it is full. */
export function addStep(form: FunnelForm, event: string): FunnelForm {
  if (!canAddStep(form)) return form;
  return {
    ...form,
    steps: [...form.steps, { key: form.nextKey, event, property: "", value: "" }],
    nextKey: form.nextKey + 1,
  };
}

/** The form without the step `key`; the form itself when that would leave none. */
export function removeStep(form: FunnelForm, key: number): FunnelForm {
  if (!canRemoveStep(form)) return form;
  return { ...form, steps: form.steps.filter((step) => step.key !== key) };
}

/** The form with step `key` changed. */
export function changeStep(form: FunnelForm, key: number, change: StepChange): FunnelForm {
  return { ...form, steps: form.steps.map((step) => (step.key === key ? { ...step, ...change } : step)) };
}

/** What is wrong with typed words held to `max` characters, or null: they are trimmed, so spaces alone are empty. */
function wordsProblem(typed: string, max: number): FormProblem | null {
  const text = typed.trim();
  if (text === "") return FormProblem.Empty;
  if (HIDDEN.test(text)) return FormProblem.Characters;
  return text.length > max ? FormProblem.TooLong : null;
}

/** What is wrong with the days: a whole number from one to the longest a funnel may run. */
function daysProblem(typed: string): FormProblem | null {
  const text = typed.trim();
  if (text === "") return FormProblem.Empty;
  if (!WHOLE_NUMBER.test(text)) return FormProblem.NotWhole;
  const days = Number(text);
  return Number.isSafeInteger(days) && days >= 1 && days <= FUNNEL_DAYS_MAX ? null : FormProblem.OutOfRange;
}

/** Whether an event is one main takes as a step: in the list, and shaped as a name. */
const isListed = (event: string, events: readonly string[]): boolean =>
  events.includes(event) && event.length <= EVENT_LIMITS.nameLength && EVENT_NAME.test(event);

/** What is wrong with one step: its event, and its property with its value (both or neither). */
function stepIssues(step: FormStep, index: number, events: readonly string[]): FormIssue[] {
  const issues: FormIssue[] = [];
  if (!isListed(step.event, events))
    issues.push({ field: FormField.Event, step: index, problem: FormProblem.UnknownEvent });
  const blankProperty = step.property.trim() === "";
  const blankValue = step.value.trim() === "";
  if (blankProperty && blankValue) return issues;
  const property = blankProperty ? FormProblem.Pair : wordsProblem(step.property, PROPERTY_NAME_MAX);
  const value = blankValue ? FormProblem.Pair : wordsProblem(step.value, EVENT_LIMITS.textLength);
  if (property) issues.push({ field: FormField.Property, step: index, problem: property });
  if (value) issues.push({ field: FormField.Value, step: index, problem: value });
  return issues;
}

/** Everything wrong with the form, in the order the fields are shown. */
export function funnelFormIssues(form: FunnelForm, events: readonly string[]): FormIssue[] {
  const name = wordsProblem(form.name, FUNNEL_NAME_MAX);
  const days = daysProblem(form.days);
  return [
    ...(name ? [{ field: FormField.Name, step: null, problem: name }] : []),
    ...(days ? [{ field: FormField.Days, step: null, problem: days }] : []),
    ...form.steps.flatMap((step, index) => stepIssues(step, index, events)),
  ];
}

/** The funnel the form writes, as main takes it; call it only for a form with no issue. */
function draftOf(form: FunnelForm): EventFunnelDraft {
  return {
    name: form.name.trim(),
    withinDays: Number(form.days.trim()),
    steps: form.steps.map((step) => {
      const bare = step.property.trim() === "";
      return {
        event: step.event,
        property: bare ? null : step.property.trim(),
        value: bare ? null : step.value.trim(),
      };
    }),
  };
}

/** The funnel to save, or everything wrong with the form. */
export function checkFunnelForm(form: FunnelForm, events: readonly string[]): FunnelCheck {
  const issues = funnelFormIssues(form, events);
  return issues.length > 0 ? { issues } : { draft: draftOf(form) };
}

/** The issues that are about `field` of step `step` (null for the name and the days). */
export const issueOf = (issues: readonly FormIssue[], field: FormField, step: number | null): FormIssue | null =>
  issues.find((issue) => issue.field === field && issue.step === step) ?? null;
