import { DevMethod, operationSchema, type Operation } from "../../src/main/dev/protocol.ts";
export const USAGE =
  "Usage: studio:dev -- fixtures | start|status|stop|restart|clean|shell|capture|snapshot|logs|runs|ui|diagnostics --profile SLUG; start --providers live --fresh-machine meets the app as a new Mac account, shell opens that account's terminal; ui/diagnostics take --request FILE, --request - (stdin) or --json '{\"method\":...}'";
export const COMMANDS = [
  "fixtures",
  "start",
  "status",
  "stop",
  "restart",
  "clean",
  "shell",
  "capture",
  "snapshot",
  "logs",
  "runs",
  "ui",
  "diagnostics",
] as const;
export type StudioDevCommand = (typeof COMMANDS)[number];
/** Parsed CLI. An inline operation is already validated; `requestFile` ('-' = stdin) is read by the caller. */
export type StudioDevArgs = {
  command: StudioDevCommand;
  profile: string;
  reuse: boolean;
  providers?: string;
  fixture?: string;
  /** `start --fresh-machine`: an empty home, the system PATH and no sign-in to borrow. */
  freshMachine?: true;
  operation?: Operation;
  requestFile?: string;
};
/** Parse and validate the operation text of a request file, stdin or --json. */
export function parseOperation(text: string): Operation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`request is not JSON: ${(e as Error).message}`);
  }
  return operationSchema.parse(value);
}
/** The `--key value` flags of one command line. */
interface Flags {
  get(key: string): string | undefined;
  int(key: string): number | undefined;
}

function flagsOf(args: string[]): Flags {
  const get = (key: string) => {
    const i = args.indexOf(`--${key}`);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || (v.startsWith("--") && v !== "-")) throw new Error(`--${key} needs a value`);
    return v;
  };
  const int = (key: string) => {
    const v = get(key);
    return v === undefined ? undefined : Number(v);
  };
  return { get, int };
}

/** `{ [key]: value }` when the flag was given, else nothing. */
const given = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value });

/** The operation each inline command sends, from its flags. */
const INLINE_OPERATIONS: Partial<Record<StudioDevCommand, (flags: Flags, now: number) => Operation>> = {
  capture: (flags, now) =>
    operationSchema.parse({
      method: "capture",
      params: { surface: flags.get("surface") ?? "desktop", name: flags.get("name") ?? `capture-${now}` },
    }),
  snapshot: (flags) =>
    operationSchema.parse({
      method: "snapshot",
      params: { surface: "desktop", ...given("scope", flags.get("scope")), ...given("limit", flags.int("limit")) },
    }),
  runs: () => operationSchema.parse({ method: DevMethod.Runs, params: {} }),
  logs: (flags) =>
    operationSchema.parse({
      method: "logs",
      params: {
        surface: flags.get("surface") ?? "desktop",
        ...given("cursor", flags.int("cursor")),
        ...given("limit", flags.int("limit")),
      },
    }),
};

/** A ui/diagnostics request: inline `--json`, or a file (or `-` for stdin) the caller reads. */
function requestOf(flags: Flags): Pick<StudioDevArgs, "operation" | "requestFile"> {
  const file = flags.get("request");
  const json = flags.get("json");
  if (file !== undefined && json !== undefined) throw new Error("use one of --request or --json");
  if (json !== undefined) return { operation: parseOperation(json) };
  if (file === undefined) throw new Error("--request FILE, --request - or --json is required");
  return { requestFile: file };
}

export function parseStudioDevArgs(args: string[], now = Date.now()): StudioDevArgs {
  const command = args[0] as StudioDevCommand;
  const flags = flagsOf(args);
  if (command === "fixtures") return { command, profile: "", reuse: false };
  const profile = flags.get("profile");
  if (!profile) throw new Error(USAGE);
  if (!(COMMANDS as readonly string[]).includes(command)) throw new Error(`unknown command ${command}`);
  const base = { command, profile, reuse: args.includes("--reuse") };
  if (command === "start")
    return {
      ...base,
      providers: flags.get("providers"),
      fixture: flags.get("fixture"),
      ...(args.includes("--fresh-machine") ? { freshMachine: true as const } : {}),
    };
  const inline = INLINE_OPERATIONS[command];
  if (inline) return { ...base, operation: inline(flags, now) };
  if (command === "ui" || command === "diagnostics") return { ...base, ...requestOf(flags) };
  return base;
}
