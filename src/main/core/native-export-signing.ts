/** Destination signing defaults and caller authority, shared by Mac and cross exports. */
import {
  ExportError,
  ExportRefusal,
  ExportSigning,
  type ExportSigningChoice,
  parseExportSigning,
} from "../../shared/game-export-contract.ts";
import { BuildTarget } from "../../shared/game-project.ts";
const MESSAGE = {
  webUnsigned: "a browser folder is not signed",
  signingFor: (kind: string, destination: string) => `a ${destination} export is not signed with ${kind}`,
  harnessMayNotSign:
    "only the person signs an export with their own identity or certificate; the harness exports unsigned or ad hoc",
};

/** Who asked for an export. Names of nothing on the wire. */
export const ExportCaller = {
  /** The person, in the studio's window (`studio:export`). */
  Person: "person",
  /** The agent-editable harness (`game.export`): never signs with an identity. */
  Harness: "harness",
} as const;
export type ExportCaller = (typeof ExportCaller)[keyof typeof ExportCaller];

/**
 * The signings each destination takes: the browser folder and Linux unsigned, a Mac app ad hoc or
 * with Developer ID, Windows unsigned or with the person's own certificate, an iOS app ad hoc (the
 * Simulator) or with the person's Apple Development or Distribution identity, and an Android build
 * with Studio's per-profile debug key or the person's release keystore.
 */
const SIGNINGS_FOR: Readonly<Record<BuildTarget, readonly ExportSigning[]>> = {
  [BuildTarget.Web]: [ExportSigning.None],
  [BuildTarget.Mac]: [ExportSigning.AdHoc, ExportSigning.DeveloperId],
  [BuildTarget.Windows]: [ExportSigning.None, ExportSigning.OwnCertificate],
  [BuildTarget.Linux]: [ExportSigning.None],
  [BuildTarget.Ios]: [ExportSigning.AdHoc, ExportSigning.IosDevelopment, ExportSigning.IosDistribution],
  [BuildTarget.Android]: [ExportSigning.AndroidDebug, ExportSigning.AndroidRelease],
};

/** The signings an export may take without the person naming one: none, ad hoc, or Studio's own Android debug key. */
type DefaultSigning = typeof ExportSigning.None | typeof ExportSigning.AdHoc | typeof ExportSigning.AndroidDebug;

/**
 * The signing an export request that names none gets: a Mac or iOS app ad hoc, an Android build
 * with Studio's debug key, every other destination unsigned.
 */
const DEFAULT_SIGNING = {
  [BuildTarget.Web]: ExportSigning.None,
  [BuildTarget.Mac]: ExportSigning.AdHoc,
  [BuildTarget.Windows]: ExportSigning.None,
  [BuildTarget.Linux]: ExportSigning.None,
  [BuildTarget.Ios]: ExportSigning.AdHoc,
  [BuildTarget.Android]: ExportSigning.AndroidDebug,
} as const satisfies Record<BuildTarget, DefaultSigning>;

/**
 * The signings that use a person's own identity, certificate or keystore: the harness never asks
 * for one. Studio's own Android debug key is not one of them.
 */
const PERSON_ONLY: ReadonlySet<ExportSigning> = new Set([
  ExportSigning.DeveloperId,
  ExportSigning.OwnCertificate,
  ExportSigning.IosDevelopment,
  ExportSigning.IosDistribution,
  ExportSigning.AndroidRelease,
]);
/**
 * The checked signing an export of `destination` runs with. Absent is the destination's own: a Mac
 * app ad hoc, everything else unsigned. Anything else passes `parseExportSigning` and must be one
 * the destination takes (`signing-invalid`): the browser folder and Linux unsigned, a Mac app ad hoc
 * or Developer ID, Windows unsigned or the person's own certificate. The harness never signs with
 * an identity or a certificate (`harness-may-not-sign`).
 */
export function exportSigningFor(destination: BuildTarget, value: unknown, caller: ExportCaller): ExportSigningChoice {
  if (value === undefined) return { kind: DEFAULT_SIGNING[destination] };
  const signing = parseExportSigning(value);
  if (!SIGNINGS_FOR[destination].includes(signing.kind)) {
    const why = destination === BuildTarget.Web ? MESSAGE.webUnsigned : MESSAGE.signingFor(signing.kind, destination);
    throw new ExportError(ExportRefusal.SigningInvalid, why);
  }
  if (caller === ExportCaller.Harness && PERSON_ONLY.has(signing.kind)) {
    throw new ExportError(ExportRefusal.HarnessMayNotSign, MESSAGE.harnessMayNotSign);
  }
  return signing;
}
