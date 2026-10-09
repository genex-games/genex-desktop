/**
 * Why Studio's secret store is locked. Main refuses to keep a secret it cannot encrypt with the
 * operating system's own key store; the renderer turns the code into words (`renderer/words.ts`).
 * Browser-safe.
 */
export const SecretStorageIssue = {
  /** `STUDIO_DISABLE_OS_CREDENTIALS=1`: this process may not touch the OS key store at all. */
  OsCredentialsDisabled: "os-credentials-disabled",
  /** The OS offers no encryption to this process (a headless run, no Electron). */
  EncryptionUnavailable: "encryption-unavailable",
  /** Linux with no keyring or wallet: Electron would fall back to a fixed, public key. */
  NoKeyring: "no-keyring",
} as const;
export type SecretStorageIssue = (typeof SecretStorageIssue)[keyof typeof SecretStorageIssue];

/**
 * The issue an error carries, or null for any other failure. It reads the `issue` field and checks it
 * against the vocabulary, so code that must not import the secret store (the plugin backend bundles
 * `SessionCredentials`) can still tell a locked store from an ordinary failure.
 */
export function secretStorageIssueOf(error: unknown): SecretStorageIssue | null {
  const carried = error instanceof Error ? Reflect.get(error, "issue") : undefined;
  return Object.values(SecretStorageIssue).find((issue) => issue === carried) ?? null;
}
