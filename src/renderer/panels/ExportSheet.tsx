/**
 * The phone export sheet: what to make for an iPhone (a Simulator app, or an IPA for the person's
 * own device or for distribution) or for Android (a development APK, or a Play bundle signed with
 * the person's release keystore), and the signing each needs. Options signed with the person's own
 * identity or keystore say only they make them. Files come from the native dialog
 * (`exportSigningReference`) and show by name only; the keystore password is never typed here, only
 * where the signer reads it from (an environment variable or a file). A refusal shows with any
 * credential shape redacted. Rules live in `export-sheet-view.ts`. The chat header opens it for a
 * Rust game's iPhone or Android export (`ChatPanelHeader`).
 */
import type { JSX } from "react";
import { useId, useState } from "react";
import { SigningReference } from "../../shared/game-export-contract.ts";
import type { ExportResult } from "../../shared/game-project.ts";
import { redactSecrets } from "../../shared/redact.ts";
import type { MobileBuildTarget } from "../../shared/toolchain.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Input } from "../ui/input.tsx";
import { DESTINATION_WORDS, EXPORT_WORDS, problemWords } from "../words.ts";
import {
  emptySigningForm,
  type MobileExportOption,
  type MobileSigningForm,
  mobileExportOptions,
  PasswordSource,
  referenceLabel,
  SigningField,
  signingPayloadOf,
} from "./export-sheet-view.ts";

const WORDS = EXPORT_WORDS.mobile;

/** The form's field each picked file fills. */
const REFERENCE_FIELD = {
  [SigningReference.Keystore]: "keystore",
  [SigningReference.ProvisioningProfile]: "provisioningProfile",
  [SigningReference.PasswordFile]: "passwordFile",
} as const satisfies Record<SigningReference, keyof MobileSigningForm>;

type Patch = (change: Partial<MobileSigningForm>) => void;

/** One option of the list: its name, what it makes, and whether only the person makes it. */
function OptionRow({
  option,
  chosen,
  onChoose,
}: {
  option: MobileExportOption;
  chosen: boolean;
  onChoose: () => void;
}): JSX.Element {
  const words = WORDS.option[option.signing];
  return (
    <label
      data-export-option={option.signing}
      data-export-chosen={chosen ? "" : undefined}
      className={`flex w-full cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 transition-colors motion-reduce:transition-none ${
        chosen ? "bg-accent-primary/12" : "hover:bg-hover"
      }`}
    >
      <input
        type="radio"
        name="export-option"
        value={option.signing}
        checked={chosen}
        onChange={onChoose}
        className="mt-1 shrink-0"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="text-body-sm font-medium text-ink">{words.name}</span>
          {option.personOnly && (
            <span
              data-export-person-only
              className="rounded-sm bg-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-2"
            >
              {WORDS.personOnly}
            </span>
          )}
        </span>
        <span className="text-xs leading-snug text-pretty text-ink-3">{words.detail}</span>
      </span>
    </label>
  );
}

/** A file the person picks in the native dialog: its name once chosen, and the button that opens the dialog. */
function FileField({
  label,
  kind,
  file,
  onPick,
}: {
  label: string;
  kind: SigningReference;
  file: string | null;
  onPick: (kind: SigningReference) => void;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-medium text-ink-2">{label}</span>
        <span data-export-picked={kind} className="truncate font-mono text-xs text-ink-3">
          {referenceLabel(file) ?? WORDS.field.none}
        </span>
      </span>
      <Button data-export-pick={kind} variant="secondary" onClick={() => onPick(kind)}>
        {WORDS.field.choose}
      </Button>
    </div>
  );
}

/** A text field with its label above it. */
function TextField({
  field,
  label,
  value,
  placeholder,
  onChange,
}: {
  field: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <Input
        id={id}
        data-export-field={field}
        className="text-ink"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** Where the keystore password comes from: a variable's name or a picked file, never the password. */
function PasswordFields({
  form,
  patch,
  onPick,
}: {
  form: MobileSigningForm;
  patch: Patch;
  onPick: (kind: SigningReference) => void;
}): JSX.Element {
  const sources = [
    [PasswordSource.Env, WORDS.field.passwordFromEnv],
    [PasswordSource.File, WORDS.field.passwordFromFile],
  ] as const;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-ink-2">{WORDS.field.password}</span>
      <div role="radiogroup" aria-label={WORDS.field.password} className="flex gap-1">
        {sources.map(([source, label]) => (
          <Button
            key={source}
            role="radio"
            aria-checked={form.passwordFrom === source}
            data-export-password-from={source}
            variant={form.passwordFrom === source ? "accent-outline" : "ghost"}
            onClick={() => patch({ passwordFrom: source })}
          >
            {label}
          </Button>
        ))}
      </div>
      {form.passwordFrom === PasswordSource.Env ? (
        <Input
          data-export-field="password-env"
          className="font-mono text-ink"
          aria-label={WORDS.field.passwordFromEnv}
          value={form.passwordEnv}
          placeholder={WORDS.field.passwordEnvPlaceholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => patch({ passwordEnv: event.target.value })}
        />
      ) : (
        <FileField
          label={WORDS.field.passwordFromFile}
          kind={SigningReference.PasswordFile}
          file={form.passwordFile}
          onPick={onPick}
        />
      )}
      <p className="text-xs leading-snug text-pretty text-ink-3">{WORDS.field.passwordNote}</p>
    </div>
  );
}

/** The fields the chosen option needs, in its own order. */
function SigningFields({
  option,
  form,
  patch,
  onPick,
}: {
  option: MobileExportOption;
  form: MobileSigningForm;
  patch: Patch;
  onPick: (kind: SigningReference) => void;
}): JSX.Element | null {
  if (option.fields.length === 0) return null;
  const field = {
    [SigningField.Identity]: (
      <TextField
        field={SigningField.Identity}
        label={WORDS.field.identity}
        value={form.identity}
        placeholder={WORDS.field.identityPlaceholder(option.signing)}
        onChange={(identity) => patch({ identity })}
      />
    ),
    [SigningField.ProvisioningProfile]: (
      <FileField
        label={WORDS.field.provisioningProfile}
        kind={SigningReference.ProvisioningProfile}
        file={form.provisioningProfile}
        onPick={onPick}
      />
    ),
    [SigningField.Keystore]: (
      <FileField label={WORDS.field.keystore} kind={SigningReference.Keystore} file={form.keystore} onPick={onPick} />
    ),
    [SigningField.Alias]: (
      <TextField
        field={SigningField.Alias}
        label={WORDS.field.alias}
        value={form.alias}
        onChange={(alias) => patch({ alias })}
      />
    ),
    [SigningField.Password]: <PasswordFields form={form} patch={patch} onPick={onPick} />,
  } satisfies Record<SigningField, JSX.Element>;
  return (
    <div data-export-fields className="flex flex-col gap-3 border-t border-line pt-3">
      {option.fields.map((name) => (
        <div key={name}>{field[name]}</div>
      ))}
    </div>
  );
}

/** The sheet's form, its picks and its export: state and actions apart from the layout. */
function useExportSheet(project: string, destination: MobileBuildTarget, onExported: (result: ExportResult) => void) {
  const [form, setForm] = useState<MobileSigningForm>(() => emptySigningForm(destination));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch: Patch = (change) => setForm((current) => ({ ...current, ...change }));
  const fail = (cause: unknown) => setError(redactSecrets(problemWords(cause)));
  const pick = (kind: SigningReference) => {
    setError(null);
    void window.studio
      .exportSigningReference(kind)
      .then((file) => {
        if (file !== null) patch({ [REFERENCE_FIELD[kind]]: file });
      })
      .catch(fail);
  };
  const signing = signingPayloadOf(form);
  const run = () => {
    if (!signing || busy) return;
    setBusy(true);
    setError(null);
    void window.studio
      .exportGame(project, { destination, signing })
      .then(onExported)
      .catch(fail)
      .finally(() => setBusy(false));
  };
  return { form, patch, pick, run, busy, error, ready: signing !== null };
}

/**
 * The phone export sheet for `project` to `destination`; `onExported` with the receipt once the
 * export is made, `onClose` when the person leaves without one.
 */
export function ExportSheet({
  project,
  destination,
  onClose,
  onExported,
}: {
  project: string;
  destination: MobileBuildTarget;
  onClose: () => void;
  onExported: (result: ExportResult) => void;
}): JSX.Element {
  const options = mobileExportOptions(destination);
  const { form, patch, pick, run, busy, error, ready } = useExportSheet(project, destination, onExported);
  const chosen = options.find((option) => option.signing === form.signing) ?? options[0];
  return (
    <DialogSurface
      title={WORDS.title(DESTINATION_WORDS.label[destination])}
      description={WORDS.intro}
      size="lg"
      testId="export-sheet"
      onDismiss={onClose}
    >
      <div data-export-sheet={destination} className="flex min-h-0 flex-col gap-3">
        <fieldset aria-label={WORDS.choose} className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          {options.map((option) => (
            <OptionRow
              key={option.signing}
              option={option}
              chosen={option.signing === form.signing}
              onChoose={() => patch({ signing: option.signing })}
            />
          ))}
        </fieldset>
        {chosen && <SigningFields option={chosen} form={form} patch={patch} onPick={pick} />}
        {error && (
          <p role="alert" data-export-error className="text-xs leading-relaxed text-red">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {WORDS.cancel}
        </Button>
        <Button data-export-submit variant="default" disabled={!ready || busy} onClick={run}>
          {busy ? WORDS.exporting : WORDS.export}
        </Button>
      </div>
    </DialogSurface>
  );
}
