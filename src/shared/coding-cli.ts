export type CodingProvider = "codex" | "claude-code" | "opencode" | "grok" | "cursor" | "antigravity";
export interface CodingCliStatus {
  provider: CodingProvider;
  state: "ready" | "missing" | "invalid_path" | "missing_runtime" | "incompatible";
  selection: "automatic" | "manual";
  path?: string;
  version?: string;
  detail: string;
  guidanceUrl: string;
}

/** Where an external coding CLI stands (`CodingCliStatus.state`). Shown in Settings: never rename a value. */
export const CodingCliState = {
  Ready: "ready",
  Missing: "missing",
  InvalidPath: "invalid_path",
  MissingRuntime: "missing_runtime",
  Incompatible: "incompatible",
} as const satisfies Record<string, CodingCliStatus["state"]>;
export type CodingCliState = (typeof CodingCliState)[keyof typeof CodingCliState];

/**
 * The coding CLI a caller needs is not ready, with where it stands beside the words: a sign-in
 * tells a CLI to install (`Missing`) from one that is there but cannot run.
 */
export class CodingCliUnavailable extends Error {
  readonly state: CodingCliState;
  constructor(state: CodingCliState, message: string) {
    super(message);
    this.state = state;
  }
}

/** Was this thrown because the coding CLI is not installed at all? */
export function isCodingCliMissing(error: unknown): boolean {
  return error instanceof CodingCliUnavailable && error.state === CodingCliState.Missing;
}
