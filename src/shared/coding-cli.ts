export type CodingProvider = "codex" | "claude-code" | "opencode";
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
