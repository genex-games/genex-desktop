/**
 * Taking credentials out of text a person or a log will read. Two ways, and callers use both
 * when they can:
 *  - **By value** (`redactValues`): the exact secrets Studio holds (a connector's stored key, an
 *    OAuth token). Precise, and the only way to catch a secret with no recognisable shape.
 *  - **By shape** (`redactSecrets`): what a credential looks like when nobody told us its value —
 *    an API key (`sk-…`, a Genex `genex_sk_v1_…`), a JWT, a bearer header, or a `field=value`
 *    whose field names one. `redactTokens` is the unmistakable part of that (bearer values,
 *    `sk-…`, Genex keys, GitHub tokens, JWTs) for text that is kept for good and read back as
 *    context, where the field patterns would rewrite a user's prose and code.
 *
 * One pattern set for the sign-in lines, the sign-in terminal and the dev control's logs, which
 * used to keep three that disagreed; each now redacts at least what it did before.
 *
 * `secretRedactor` puts values and shapes together for text Studio keeps or hands on — the event
 * log and MCP tool results with `redactTokens`, the dev control's logs with `redactSecrets` — and
 * `redactDeep` applies it to every string of a record.
 */

/** What a redacted credential reads as. */
export const REDACTED = "[redacted]";

/** Field names whose value is a credential wherever it is written `name=value` or `name: value`. */
export const SECRET_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
  "authorization",
  "api_key",
  "capability",
] as const;
/**
 * Fields whose value is a credential after any run of quotes, `=`, `:` or spaces (log records).
 * `capability` is not among them: it is an ordinary word, so only `capability=` or `capability:` counts.
 */
const LOOSE_FIELDS = ["access_token", "refresh_token", "api_key"] as const;

/**
 * A bare credential, in any case: an API key (`sk-…`), a Genex API key (`genex_sk_v1_…`, the eval
 * ingest key among them), a GitHub token (`ghp_…`, `github_pat_…`) or a JWT (`eyJ….….…`). A Genex
 * key's body is base64url (`_` and `-` included, 43 characters when minted); sixteen or more are
 * needed, so the bare prefix a document names (`genex_sk_v1_…`) stays readable.
 */
export const SECRET_TOKEN =
  /\b(?:sk-[\w-]+|genex_sk_v1_[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/i;
const SECRET_TOKENS = new RegExp(SECRET_TOKEN.source, "gi");
/** A bearer header: the scheme stays, its value goes. */
const BEARER = /(\bBearer\s+)[^\s",}]+/gi;
/**
 * A credential field and its value, up to the next space. The name has to start a word
 * (`incapability=` is not one) but may end a longer one (`my_api_key=`).
 */
const FIELD_VALUE = new RegExp(
  `((?<![a-z0-9])(?:(?:${SECRET_FIELDS.join("|")})["']?\\s*[:=]\\s*|(?:${LOOSE_FIELDS.join("|")})["'=:\\s]+))\\S+`,
  "gi",
);
/** An environment variable that holds a credential, by the last word of its name. */
const CREDENTIAL_ENV_NAME = /^[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)$/;
/** An env variable or header a person named for a credential (`WEATHER_API_KEY`, `X-Api-Key`, `Authorization`). */
const CREDENTIAL_NAME = /(?:token|key|secret|password|passwd|credentials?|auth|authorization|cookie|(?:^|[_-])pat)$/i;
/** `NAME=value` where the name is a credential variable (`GENEX_TOKEN=…`, `CLAUDE_CODE_OAUTH_TOKEN=…`). */
const ENV_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD)=)[^\s"',;&]+/g;
/** An OAuth authorization code in a callback URL. */
const CALLBACK_CODE = /([?&]code=)[^\s&#"']+/g;
/** A word that is a credential field's name alone, its value in the next word (`authorization:`). */
export const SECRET_FIELD_NAME = new RegExp(`^(?:${SECRET_FIELDS.join("|")})["']?[:=]?$`, "i");

/** `text` with every credential-shaped part replaced by `[redacted]`; field names are kept. */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER, `$1${REDACTED}`)
    .replace(SECRET_TOKENS, REDACTED)
    .replace(FIELD_VALUE, `$1${REDACTED}`)
    .replace(ENV_ASSIGNMENT, `$1${REDACTED}`)
    .replace(CALLBACK_CODE, `$1${REDACTED}`);
}

/**
 * `text` with only the unmistakable credential shapes replaced: a bearer header's value, an API
 * key (`sk-…`, `genex_sk_v1_…`), a GitHub token and a JWT. For text kept for good and read back
 * as context (the event log, connector results): `redactSecrets`'s field, env-assignment and
 * callback-code patterns also rewrite ordinary prose and game code (`the api_key field`,
 * `SPRITE_KEY=hero`, `?code=level2`), which a log file can live with and a user's own words cannot.
 */
export function redactTokens(text: string): string {
  return text.replace(BEARER, `$1${REDACTED}`).replace(SECRET_TOKENS, REDACTED);
}

/** Does this text hold something credential-shaped (the test `redactSecrets` would act on)? */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * An email address: a local part, an `@` and a dotted domain. A match starts only where a run of
 * local-part characters starts, so a long run with no `@` is read once, not once per character.
 */
const EMAIL = /(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
/**
 * A phone number: an optional `+` and country code, then at least nine digits in groups split by
 * spaces, dots, dashes or brackets. Shorter runs (a score, a year, a time) stay readable.
 */
const PHONE = /(?<![\w+])\+?\(?\d{1,4}\)?(?:[ .-]?\(?\d{2,4}\)?){2,4}(?![\w])/g;
/** Digits in a phone-shaped match: fewer than nine is a number in a sentence, not a phone. */
const PHONE_MIN_DIGITS = 9;

/**
 * `text` with email addresses and phone numbers replaced by `[redacted]`: for what a person typed
 * that leaves this Mac in a report (`shared/game-ai-report.ts`), beside `redactSecrets`.
 */
export function redactContacts(text: string): string {
  return text
    .replace(EMAIL, REDACTED)
    .replace(PHONE, (match) => (match.replace(/\D/g, "").length >= PHONE_MIN_DIGITS ? REDACTED : match));
}

/**
 * `text` with each of these exact values replaced by `[redacted]`. Values shorter than
 * `minLength` are skipped: redacting them would eat ordinary words.
 */
export function redactValues(text: string, values: Iterable<string>, minLength = 1): string {
  let out = text;
  for (const value of values) if (value.length >= minLength) out = out.split(value).join(REDACTED);
  return out;
}

/** Held values shorter than this are not redacted by `secretRedactor`: they would eat ordinary words. */
export const MIN_SECRET_LENGTH = 8;

/**
 * The redactor for text Studio persists or hands to another agent: every value `held()` answers
 * (read on each call, so a value unlocked or rotated later is covered), longest first so a value
 * that contains another goes whole, then the credential shapes `shapes` takes out: everything
 * credential-shaped (`redactSecrets`, the default) for logs and diagnostics, or only the
 * unmistakable tokens (`redactTokens`) for the event log, which keeps a user's words as written.
 */
export function secretRedactor(
  held: () => Iterable<string>,
  shapes: (text: string) => string = redactSecrets,
): (text: string) => string {
  return (text) => {
    const values = [...new Set(held())]
      .filter((value) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length);
    return shapes(redactValues(text, values));
  };
}

/**
 * `value` with `redact` applied to every string in it, at any depth. Keys, numbers, booleans and
 * the shape stay as they were, and the input is not changed: a copy comes back.
 */
export function redactDeep<T>(value: T, redact: (text: string) => string): T {
  return walk(value, redact) as T;
}

function walk(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, redact));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, redact);
    return out;
  }
  return value;
}

/**
 * The credential values in an environment: variables whose name ends in TOKEN, KEY, SECRET or
 * PASSWORD (`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`), long enough to
 * be one. Takes the record rather than reading `process.env`, so browser code can import it.
 */
export function credentialEnvValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env))
    if (value && value.length >= MIN_SECRET_LENGTH && CREDENTIAL_ENV_NAME.test(name)) values.push(value);
  return values;
}

/**
 * Is this connector env variable or header named for a credential (`WEATHER_API_KEY`,
 * `X-Api-Key`, `Authorization`), rather than for configuration (`BASE_URL`, `ALLOWED_DIR`)?
 * A connector keeps both kinds in the secret store; only the first kind is a secret Studio
 * redacts from its log and refuses to publish. A doubtful name counts as a credential.
 */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name);
}
