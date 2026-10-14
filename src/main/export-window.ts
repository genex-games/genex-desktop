/**
 * The studio window's side of an export: the native file dialog a person picks a release
 * keystore, a provisioning profile or a password file in (`studio:export.signingReference`),
 * which answers the file's path and never reads it; and `studio:export` with its refusal redacted
 * before it reaches the window, so a signing password a signer echoed (named by a variable or a
 * file, or typed for a Windows certificate) or a secret Studio holds never does.
 */
import path from "node:path";
import type { OpenDialogOptions } from "electron";
import {
  ExportError,
  ExportSigning,
  type ExportSigningChoice,
  ExportRefusal,
  parseExportSigning,
  parseSigningReference,
  SigningReference,
} from "../shared/game-export-contract.ts";
import type { ExportResult } from "../shared/game-project.ts";
import { MIN_SECRET_LENGTH, redactSecrets, redactValues } from "../shared/redact.ts";
import { errorMessage } from "../shared/errors.ts";
import { type ExportingCore, type ExportReveal, exportForPerson } from "./core/native-export-run.ts";

/** The longest path a signing reference may be: the signing parser's own limit. */
const REFERENCE_MAX_CHARS = 1024;
/** The shortest signing password redacted by value: a shorter one would blank ordinary words. */
const SIGNING_SECRET_MIN_CHARS = 4;
/** Any control character, C1 included. */
const ANY_CONTROL = /\p{Cc}/u;

const MESSAGE = {
  pickedRefused: "The chosen file can't be used for signing.",
} as const;

/** Each kind's dialog: its words, and the file types it offers. */
const PICKER = {
  [SigningReference.Keystore]: {
    title: "Choose your release keystore",
    buttonLabel: "Choose",
    message: "Genex hands this keystore to the signer when you export. It is never copied into a game.",
    filters: [{ name: "Keystore", extensions: ["jks", "keystore", "p12", "pfx"] }],
  },
  [SigningReference.ProvisioningProfile]: {
    title: "Choose a provisioning profile",
    buttonLabel: "Choose",
    message: "The profile must match the signing identity and list the devices the app installs on.",
    filters: [{ name: "Provisioning profile", extensions: ["mobileprovision"] }],
  },
  [SigningReference.PasswordFile]: {
    title: "Choose the file that holds your keystore password",
    buttonLabel: "Choose",
    message: "Genex never reads the password into its window: the signer reads this file when it signs.",
    filters: [],
  },
} as const satisfies Record<SigningReference, OpenDialogOptions>;

/** The native dialog for `kind`: one file, of the kind's types. */
export function signingReferencePickerOptions(kind: SigningReference): OpenDialogOptions {
  const { filters, ...words } = PICKER[kind];
  return { ...words, ...(filters.length > 0 ? { filters: [...filters] } : {}), properties: ["openFile"] };
}

/** What a dialog answers: Electron's `dialog.showOpenDialog`, a recorder in a test. */
export type SigningPicker = (options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;

/** Whether `file` is a path a signing may carry for `kind`: absolute, plain, and a profile's own suffix. */
function isReferencePath(kind: SigningReference, file: string): boolean {
  const plain = file.length <= REFERENCE_MAX_CHARS && !ANY_CONTROL.test(file) && path.isAbsolute(file);
  if (!plain) return false;
  return kind !== SigningReference.ProvisioningProfile || file.endsWith(".mobileprovision");
}

/**
 * `studio:export.signingReference {kind}`: the kind is checked before any dialog opens, then the
 * person picks one file. Answers its absolute path, or null when they cancel; the file is never
 * read here. A path a signing could not carry is refused `signing-invalid`.
 */
export async function pickSigningReference(payload: unknown, pick: SigningPicker): Promise<string | null> {
  const kind = parseSigningReference(payload);
  const result = await pick(signingReferencePickerOptions(kind));
  const [file] = result.filePaths;
  if (result.canceled || file === undefined) return null;
  if (!isReferencePath(kind, file)) throw new ExportError(ExportRefusal.SigningInvalid, MESSAGE.pickedRefused);
  return file;
}

/** What an export's refusal is redacted with. */
export interface ExportRedaction {
  /** Where a password named by a variable is read (`process.env`). */
  env: Readonly<Record<string, string | undefined>>;
  /** Values Studio holds that no text may show (`StudioCore.knownSecretValues`). */
  secretValues(): string[];
  /**
   * A release keystore's password file, read only as its signer would read it
   * (`signerPasswordFile`): null for a file the signer refuses (a protected or forbidden root,
   * `~/.android`, not a regular file).
   */
  passwordFile(file: string): Promise<string | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The request's signing as the export would take it, or null for one it refuses (nothing is read for it). */
function parsedSigning(signing: unknown): ExportSigningChoice | null {
  try {
    return parseExportSigning(signing);
  } catch {
    return null;
  }
}

/**
 * The signing secrets a valid request names: a Windows certificate's typed password, or the value
 * an Android release keystore's reference points at. A signing the export refuses names none, so
 * no file or variable the renderer chose is read for it.
 */
async function signingSecrets(signing: unknown, redaction: ExportRedaction): Promise<string[]> {
  const choice = parsedSigning(signing);
  if (choice?.kind === ExportSigning.OwnCertificate) return choice.password ? [choice.password] : [];
  if (choice?.kind !== ExportSigning.AndroidRelease) return [];
  const { password } = choice;
  const value = "env" in password ? redaction.env[password.env] : await redaction.passwordFile(password.file);
  return value ? [value] : [];
}

/**
 * `error` as it may cross to the window: a refusal keeps its typed code, gate refusal and file,
 * with words that hold no signing password the request names (typed for a Windows certificate, or
 * the value its variable or file holds) and no secret Studio holds, by value and by shape.
 */
export async function redactedExportRefusal(
  error: unknown,
  payload: unknown,
  redaction: ExportRedaction,
): Promise<Error> {
  const signing = isRecord(payload) ? payload.signing : undefined;
  const signingValues = await signingSecrets(signing, redaction);
  const byValue = redactValues(errorMessage(error), signingValues, SIGNING_SECRET_MIN_CHARS);
  const said = redactSecrets(redactValues(byValue, redaction.secretValues(), MIN_SECRET_LENGTH));
  if (error instanceof ExportError)
    return new ExportError(error.code, said, { refusal: error.refusal, file: error.file });
  return new Error(said);
}

/**
 * `studio:export` from the studio window ({@link exportForPerson}), its refusal redacted before it
 * crosses to the window ({@link redactedExportRefusal}).
 */
export async function exportForWindow(
  core: ExportingCore,
  payload: unknown,
  reveal: ExportReveal,
  redaction: ExportRedaction,
): Promise<ExportResult> {
  try {
    return await exportForPerson(core, payload, reveal);
  } catch (error) {
    throw await redactedExportRefusal(error, payload, redaction);
  }
}
