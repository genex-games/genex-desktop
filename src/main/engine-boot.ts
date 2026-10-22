/**
 * The engines a window opens with. Checking every engine (its CLI's PATH, version and sign-in)
 * takes seconds, and the window's bootstrap used to wait for all of it before the prompt box
 * appeared. A launch now shows the list the last launch checked, starts the checks at once, and
 * tells the window when the checked list replaces the remembered one. A first launch, or one
 * after an app update, has nothing remembered and waits for the checks as before.
 */
import { readFile } from "node:fs/promises";
import type { EngineDescriptor } from "../shared/engine-descriptor.ts";
import { errorMessage } from "../shared/errors.ts";
import { atomicWriteJson } from "../substrate/fsx.ts";

/** What the engine boot needs from the app. */
export interface EngineBootDeps {
  /** Check every engine (`EngineRegistry.describe`). */
  describe(): Promise<EngineDescriptor[]>;
  /** Where the last checked list is kept between launches. */
  file: string;
  /** The app version: a list another version remembered may not match this one's shape. */
  build: string;
  /** Tell the window the engines changed (`UiEvent.EnginesChanged`). */
  changed(): void;
  log?(message: string): void;
}

/** The launch's engine checks and the list a window's bootstrap gets meanwhile. */
export interface EngineBoot {
  /** Start the checks; once per launch, as early as the core exists. */
  start(): void;
  /**
   * The list for a window's bootstrap: while the launch's checks run, the remembered one, or the
   * checks' own when nothing is remembered; once they are done, a fresh check, as a bootstrap always was.
   */
  bootstrap(): Promise<EngineDescriptor[]>;
  /** Keep a list for the next launch. */
  remember(list: EngineDescriptor[]): void;
  /** Settles when the launch's checks have ended, their list kept and announced. */
  checked(): Promise<void>;
  /** Settles when every list handed to `remember` so far is on disk. */
  saved(): Promise<void>;
}

/** The kept file: the version that wrote it and the engines it checked. */
interface Remembered {
  build: string;
  engines: EngineDescriptor[];
}

/** Whether a kept engine has what every reader of a descriptor relies on. */
function isDescriptor(value: unknown): value is EngineDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const engine = value as Partial<EngineDescriptor>;
  const hasStatus = typeof engine.status === "object" && engine.status !== null;
  return typeof engine.id === "string" && hasStatus && Array.isArray(engine.models);
}

/** The list a kept file holds for this version, or null when it holds none it can show. */
function readRemembered(text: string, build: string): EngineDescriptor[] | null {
  try {
    const kept = JSON.parse(text) as Partial<Remembered>;
    if (kept?.build !== build || !Array.isArray(kept.engines)) return null;
    return kept.engines.every(isDescriptor) ? kept.engines : null;
  } catch {
    return null;
  }
}

/** A descriptor as it is kept: plan usage is only true when it is read, so it is left out. */
function keepable({ usage: _usage, ...engine }: EngineDescriptor): EngineDescriptor {
  return engine;
}

/** The engine boot over `deps`; see the module comment. */
export function engineBoot(deps: EngineBootDeps): EngineBoot {
  let checks: Promise<EngineDescriptor[]> | null = null;
  let checkedList: EngineDescriptor[] | null = null;
  let announced: Promise<void> = Promise.resolve();
  let servedRemembered = false;
  let writes: Promise<void> = Promise.resolve();

  const remember = (list: EngineDescriptor[]): void => {
    const kept: Remembered = { build: deps.build, engines: list.map(keepable) };
    writes = writes
      .then(() => atomicWriteJson(deps.file, kept))
      .catch((error: unknown) => deps.log?.(`[engines] keeping the checked engines failed: ${errorMessage(error)}`));
  };

  const start = (): void => {
    if (checks) return;
    checks = deps.describe();
    announced = checks.then(
      (list) => {
        checkedList = list;
        remember(list);
        if (servedRemembered) deps.changed();
      },
      (error: unknown) => {
        // A failed check leaves nothing checked: the next bootstrap asks again.
        checks = null;
        deps.log?.(`[engines] the launch's engine checks failed: ${errorMessage(error)}`);
      },
    );
  };

  const remembered = async (): Promise<EngineDescriptor[] | null> => {
    const text = await readFile(deps.file, "utf8").catch(() => null);
    return text === null ? null : readRemembered(text, deps.build);
  };

  const bootstrap = async (): Promise<EngineDescriptor[]> => {
    const running = checks;
    if (checkedList || !running) return deps.describe();
    const kept = await remembered();
    if (checkedList) return checkedList;
    if (!kept) return running.catch(() => deps.describe());
    servedRemembered = true;
    return kept;
  };

  return {
    start,
    bootstrap,
    remember,
    checked: async () => {
      await announced;
      await writes;
    },
    saved: () => writes,
  };
}
