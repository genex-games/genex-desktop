/**
 * What the phone export sheet offers and sends, pure so conformance tests hold its rules without a
 * window: each phone's artifacts from the contract's tables (a Simulator app or an IPA, a
 * development APK or an AAB), which of them only the person makes, the fields each signing needs,
 * and the signing choice the sheet sends to `studio:export`. A release keystore's password is never
 * a field: the choice names an environment variable or a file the signer reads, so the password
 * never enters the window. A file the person picked shows by its name alone.
 */
import {
  ARTIFACT_SIGNINGS,
  ExportSigning,
  type ExportSigningChoice,
  HARNESS_MOBILE_ARTIFACTS,
  MOBILE_ARTIFACTS,
  type MobileArtifact,
  parseExportSigning,
} from "../../shared/game-export-contract.ts";
import type { MobileBuildTarget } from "../../shared/toolchain.ts";

/** A field the person fills in for a signing. Names of nothing on the wire. */
export const SigningField = {
  Identity: "identity",
  ProvisioningProfile: "provisioning-profile",
  Keystore: "keystore",
  Alias: "alias",
  Password: "password",
} as const;
export type SigningField = (typeof SigningField)[keyof typeof SigningField];

/** Where a release keystore's password comes from: never typed into the sheet. */
export const PasswordSource = {
  Env: "env",
  File: "file",
} as const;
export type PasswordSource = (typeof PasswordSource)[keyof typeof PasswordSource];

/** The signings a phone export takes, one per option. */
export type MobileExportSigning = (typeof ARTIFACT_SIGNINGS)[MobileArtifact][number];

/** The fields each signing needs before Export works. */
const FIELDS_OF = {
  [ExportSigning.AdHoc]: [],
  [ExportSigning.IosDevelopment]: [SigningField.Identity, SigningField.ProvisioningProfile],
  [ExportSigning.IosDistribution]: [SigningField.Identity, SigningField.ProvisioningProfile],
  [ExportSigning.AndroidDebug]: [],
  [ExportSigning.AndroidRelease]: [SigningField.Keystore, SigningField.Alias, SigningField.Password],
} as const satisfies Record<MobileExportSigning, readonly SigningField[]>;

/** One thing the sheet can make for a phone. */
export interface MobileExportOption {
  artifact: MobileArtifact;
  signing: MobileExportSigning;
  /** Signed with the person's own identity or keystore: the agent never makes it. */
  personOnly: boolean;
  /** What the person fills in first. */
  fields: readonly SigningField[];
}

/** What `target`'s sheet offers, in the contract's order: the default (what the agent may also make) first. */
export function mobileExportOptions(target: MobileBuildTarget): MobileExportOption[] {
  const artifacts: readonly MobileArtifact[] = MOBILE_ARTIFACTS[target];
  return artifacts.flatMap((artifact) => {
    const signings: readonly MobileExportSigning[] = ARTIFACT_SIGNINGS[artifact];
    return signings.map((signing) => ({
      artifact,
      signing,
      personOnly: !HARNESS_MOBILE_ARTIFACTS.includes(artifact),
      fields: FIELDS_OF[signing],
    }));
  });
}

/** What the person has filled in. No field holds a password. */
export interface MobileSigningForm {
  signing: MobileExportSigning;
  identity: string;
  /** The `.mobileprovision` file picked in the native dialog, or null. */
  provisioningProfile: string | null;
  /** The release keystore picked in the native dialog, or null. */
  keystore: string | null;
  alias: string;
  passwordFrom: PasswordSource;
  /** The environment variable the signer reads the password from. */
  passwordEnv: string;
  /** The file picked in the native dialog that the signer reads the password from, or null. */
  passwordFile: string | null;
}

/** A fresh form for `target`, on its first option. */
export function emptySigningForm(target: MobileBuildTarget): MobileSigningForm {
  const [first] = mobileExportOptions(target);
  return {
    signing: first?.signing ?? ExportSigning.AdHoc,
    identity: "",
    provisioningProfile: null,
    keystore: null,
    alias: "",
    passwordFrom: PasswordSource.Env,
    passwordEnv: "",
    passwordFile: null,
  };
}

/** The signing the form describes, before the shape check. */
function candidateOf(form: MobileSigningForm): Record<string, unknown> {
  switch (form.signing) {
    case ExportSigning.IosDevelopment:
    case ExportSigning.IosDistribution:
      return { kind: form.signing, identity: form.identity.trim(), provisioningProfile: form.provisioningProfile };
    case ExportSigning.AndroidRelease: {
      const fromFile = form.passwordFrom === PasswordSource.File;
      const password = fromFile ? { file: form.passwordFile } : { env: form.passwordEnv.trim() };
      return { kind: form.signing, keystore: form.keystore, alias: form.alias.trim(), password };
    }
    case ExportSigning.AdHoc:
    case ExportSigning.AndroidDebug:
      return { kind: form.signing };
  }
}

/**
 * The signing choice the sheet sends, checked by the same `parseExportSigning` main applies; null
 * while the form is incomplete or a field is outside its shape, so Export stays off.
 */
export function signingPayloadOf(form: MobileSigningForm): ExportSigningChoice | null {
  try {
    return parseExportSigning(candidateOf(form));
  } catch {
    return null;
  }
}

/** A picked file as the sheet shows it: its name alone, never the folders that name the person. */
export function referenceLabel(file: string | null): string | null {
  if (file === null) return null;
  return file.split(/[\\/]/).at(-1) ?? file;
}
