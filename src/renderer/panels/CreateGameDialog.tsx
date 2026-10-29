/**
 * Explicit game creation from Home: name, save location, stack and play destinations. Where
 * `stackOffer` offers Rust · wgpu (main's creation gate open, its toolchain installed or reachable,
 * where its lane runs) the person chooses Three.js or Rust · wgpu, starting on the one the
 * `stackDefault` switch names; elsewhere it makes a browser game. It never offers C++ · raylib,
 * whose creation is retired (M6.3).
 */
import { type JSX, type RefObject, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { folderNameFromTitle, slugFromName } from "../../shared/game-folder-name.ts";
import {
  ALL_BUILD_TARGETS,
  type BuildTarget,
  type CompiledStack,
  type CreatableStack,
  GameStack,
} from "../../shared/game-project.ts";
import { hostOf, TargetRefusal } from "../../shared/game-targets.ts";
import { setupTargets } from "../../shared/stack-setup.ts";
import type { ToolchainHost, ToolchainStatus } from "../../shared/toolchain.ts";
import {
  asksToolchains,
  browserOnlyRefusal,
  compiledChoice,
  createGameArgs,
  DEFAULT_DESTINATION_CHECKS,
  type DestinationChoice,
  destinationChoice,
  NOTHING_OFFERED,
  rustSetupReady,
  type SheetOffer,
  sheetOffer,
  type StackOffer,
  shownStack,
  stackOffer,
} from "../create-game-destinations.ts";
import { hostPlatform } from "../platform.ts";
import { useRustCreation, useStackDefaultSwitch } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import type { GameLocation, GameProject } from "../types.ts";
import { DESTINATION_WORDS, problemWords } from "../words.ts";
import { t } from "../../shared/i18n.ts";
import { ToolchainSheet } from "./ToolchainSheet.tsx";

/** The dialog's words. */
const MESSAGE = {
  title: t("New game"),
  rustTitle: t("New Rust game"),
  name: t("Game name"),
  untitled: t("Untitled game"),
  savedTo: t("Saved to"),
  change: t("Change…"),
  choosing: t("Choosing…"),
  cancel: t("Cancel"),
  create: t("Create game"),
  creating: t("Creating…"),
  noDestination: t("Choose at least one place to play."),
} as const;

/** The operation the dialog is waiting for. */
type Pending = "location" | "create" | null;

/** Where the new game is saved: the games folder by its slug, a chosen folder by its title. */
function folderFor(title: string, rootLabel: string, location: GameLocation | null): { parent: string; name: string } {
  const named = title.trim() || MESSAGE.untitled;
  if (!location) return { parent: rootLabel, name: slugFromName(named) };
  return { parent: location.pathLabel, name: folderNameFromTitle(named) };
}

/** One step at a time: a second press while the first is out does nothing. */
function useSteps() {
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState("");
  const waiting = useRef(false);
  async function run(step: Exclude<Pending, null>, work: () => Promise<void>) {
    if (waiting.current) return;
    waiting.current = true;
    setPending(step);
    setError("");
    try {
      await work();
    } catch (problem) {
      setError(problemWords(problem));
    } finally {
      waiting.current = false;
      setPending(null);
    }
  }
  return { pending, error, waiting, run };
}

/** A choice's frame: muted and without a pointer when it is refused. */
function choiceClass(refused: boolean): string {
  return `flex min-w-0 items-center gap-2 rounded-control border px-3 py-2.5 text-body-sm transition-colors duration-(--duration-quick) has-focus-visible:border-(--focus-edge) ${
    refused
      ? "cursor-default border-line text-ink-3"
      : "cursor-pointer border-line-strong text-ink hover:bg-control-hover"
  }`;
}

/** One destination's box, and the refusal or note beside it. */
function DestinationBox({
  target,
  choice,
  checked,
  noteId,
  disabled,
  onChange,
}: {
  target: BuildTarget;
  choice: DestinationChoice;
  checked: boolean;
  noteId: string;
  disabled: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  const refused = choice.disabled[target] !== null;
  const described = refused || (checked && choice.notes[target] !== null);
  return (
    <label className={choiceClass(refused)}>
      <input
        type="checkbox"
        data-create-game-destination={target}
        checked={checked && !refused}
        disabled={disabled || refused}
        aria-describedby={described ? noteId : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="truncate">{DESTINATION_WORDS.label[target]}</span>
    </label>
  );
}

/** A refusal's words; a box the chosen stack's lane does not build here yet says so for that stack. */
function refusalWords(choice: DestinationChoice, refusal: TargetRefusal): string {
  if (refusal === TargetRefusal.StackGated && choice.stack) return DESTINATION_WORDS.notYetForStack(choice.stack);
  if (refusal === TargetRefusal.NotADestination && !choice.stack) return DESTINATION_WORDS.browserOnly;
  return DESTINATION_WORDS.refusal[refusal];
}

/** The refusals and notes under the boxes: a refused box always says why; a note shows once its box is ticked. */
function DestinationNotes({
  choice,
  checked,
  noteId,
}: {
  choice: DestinationChoice;
  checked: readonly BuildTarget[];
  noteId: (target: BuildTarget) => string;
}): JSX.Element | null {
  const lines = ALL_BUILD_TARGETS.flatMap((target) => {
    const refusal = choice.disabled[target] ?? (checked.includes(target) ? choice.notes[target] : null);
    return refusal ? [{ target, refusal }] : [];
  });
  if (lines.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs leading-relaxed text-ink-3">
      {lines.map(({ target, refusal }) => (
        <li key={target} id={noteId(target)}>
          <span className="text-ink-2">{DESTINATION_WORDS.label[target]}</span> · {refusalWords(choice, refusal)}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Made in": the stacks this host offers, shown only when there is more than one to choose:
 * Three.js and Rust · wgpu where Rust is offered (C++ · raylib is retired, never listed).
 */
function StackChoice({
  offer,
  stack,
  disabled,
  onPick,
}: {
  offer: StackOffer;
  stack: CreatableStack | undefined;
  disabled: boolean;
  onPick: (stack: CreatableStack) => void;
}): JSX.Element | null {
  const name = useId();
  if (offer.stacks.length < 2) return null;
  return (
    <fieldset data-create-game-stacks className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-xs text-ink-2">{DESTINATION_WORDS.stackChoice}</legend>
      <div className="grid grid-cols-2 gap-2">
        {offer.stacks.map((option) => (
          <label key={option} className={choiceClass(false)}>
            <input
              type="radio"
              name={name}
              data-create-game-stack={option}
              checked={stack === option}
              disabled={disabled}
              onChange={() => onPick(option)}
            />
            <span className="truncate">{DESTINATION_WORDS.stackOption(option)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * "Where will people play?": every chosen destination uses the dialog's compiled runtime, including Browser.
 */
function Destinations({
  choice,
  checked,
  disabled,
  onCheck,
}: {
  choice: DestinationChoice;
  checked: readonly BuildTarget[];
  disabled: boolean;
  onCheck: (target: BuildTarget, on: boolean) => void;
}): JSX.Element {
  const id = useId();
  const noteId = (target: BuildTarget) => `${id}-note-${target}`;
  return (
    <fieldset data-create-game-platforms className="m-0 mt-3 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-xs text-ink-2">{DESTINATION_WORDS.question}</legend>
      <div className="grid grid-cols-3 gap-2">
        {ALL_BUILD_TARGETS.map((target) => (
          <DestinationBox
            key={target}
            target={target}
            choice={choice}
            checked={checked.includes(target)}
            noteId={noteId(target)}
            disabled={disabled}
            onChange={(on) => onCheck(target, on)}
          />
        ))}
      </div>
      <DestinationNotes choice={choice} checked={checked} noteId={noteId} />
      <p className="m-0 text-xs text-ink-3" aria-live="polite">
        {choice.targets.length > 0 ? DESTINATION_WORDS.stackLine(shownStack(choice)) : MESSAGE.noDestination}
      </p>
    </fieldset>
  );
}

/** Whether the computer is online, following the window's online and offline events. */
function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}

function subscribeOnline(change: () => void): () => void {
  window.addEventListener("online", change);
  window.addEventListener("offline", change);
  return () => {
    window.removeEventListener("online", change);
    window.removeEventListener("offline", change);
  };
}

/** What the store's answers told the dialog: its toolchain host, and whether Rust's setup is already here. */
interface StoreFacts {
  /** The store's toolchain host; undefined until it answers. */
  host: ToolchainHost | null | undefined;
  /** Whether the store holds Rust · wgpu's whole setup ({@link rustSetupReady}); undefined until it answers. */
  rustReady: boolean | undefined;
}

/**
 * The stacks this host offers and the one in use: the person's pick while it is still offered,
 * else the offer's starting stack (the `stackDefault` switch's). The toolchain host and Rust's
 * readiness come from the store's answers; `compiled` is the compiled stack the choice makes.
 */
function useStack(store: StoreFacts) {
  const [picked, setPicked] = useState<CreatableStack | null>(null);
  const rustCreation = useRustCreation();
  const online = useOnline();
  const offer = stackOffer({
    platform: hostOf(hostPlatform()),
    toolchainHost: store.host,
    rustCreation,
    online,
    ...(store.rustReady === undefined ? {} : { rustToolchainReady: store.rustReady }),
    stackDefault: useStackDefaultSwitch(),
  });
  const stack = picked && offer.stacks.includes(picked) ? picked : offer.initial;
  // Offline with Rust's creation gate open, the store says whether Rust's setup is already here.
  const asksReadiness = rustCreation && !online && store.rustReady === undefined;
  return { offer, stack, compiled: compiledChoice(stack), setPicked, asksReadiness };
}

/** What the Toolchain sheet is open for: its stack and the destinations it prepares. */
interface OpenSheet {
  stack: CompiledStack;
  targets: readonly BuildTarget[];
}

/**
 * The stack, the destination boxes and their setup offer, once per stack. The answer is weighed
 * against the latest choice; one offer covers every destination this host can prepare for that
 * stack (a Rust game's sheet lists its own components and Apple's two rows), while game targets
 * remain the person's selected boxes.
 */
function useDestinations() {
  const [checked, setChecked] = useState<readonly BuildTarget[]>(DEFAULT_DESTINATION_CHECKS);
  /** The stack and destinations the Toolchain sheet is open for; null while it is closed. */
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [store, setStore] = useState<StoreFacts>({ host: undefined, rustReady: undefined });
  const { offer, stack, compiled, setPicked, asksReadiness } = useStack(store);
  const unoffered = browserOnlyRefusal(offer);
  const host = hostOf(hostPlatform());
  /** The choice as it is now, for a store answer that arrives after the person changed it. */
  const latest = useRef<DestinationChoice>(destinationChoice(DEFAULT_DESTINATION_CHECKS, compiled, host, unoffered));
  /** Per stack, the destinations a store answer has been weighed for in this dialog. */
  const asked = useRef<Partial<Record<CompiledStack, readonly BuildTarget[]>>>({});
  /** Per stack, what the sheet has offered in this dialog. */
  const offered = useRef<Partial<Record<CompiledStack, SheetOffer>>>({});
  function weigh(status: ToolchainStatus) {
    setStore({ host: status.host, rustReady: rustSetupReady(status) });
    const now = latest.current;
    if (!now.stack || now.targets.length === 0) return;
    const prepared = setupTargets(now.stack, status.host);
    asked.current = { ...asked.current, [now.stack]: [...prepared] };
    const next = sheetOffer(status, now, offered.current[now.stack] ?? NOTHING_OFFERED);
    if (!next) return;
    offered.current = { ...offered.current, [now.stack]: next };
    setSheet({ stack: now.stack, targets: prepared });
  }
  function choose(nextChecked: readonly BuildTarget[], nextStack: CompiledStack | undefined = compiled) {
    setChecked(nextChecked);
    const next = destinationChoice(nextChecked, nextStack, host, unoffered);
    latest.current = next;
    if (!asksToolchains(next, next.stack ? (asked.current[next.stack] ?? []) : [])) return;
    void window.studio
      .toolchainStatus()
      .then(weigh)
      // The sheet is a head start: a build without its tools says so itself (`ToolchainMissing`).
      .catch(() => {});
  }
  // The compiled entry checks the default Browser build before a destination is changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: choose reads the latest choice through refs
  useEffect(() => choose(DEFAULT_DESTINATION_CHECKS), []);
  // Offline, Rust is offered only once the store says its setup is already here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: weigh reads the latest choice through refs
  useEffect(() => {
    if (!asksReadiness) return;
    void window.studio
      .toolchainStatus()
      .then(weigh)
      .catch(() => {});
  }, [asksReadiness]);
  return {
    checked,
    choice: destinationChoice(checked, compiled, host, unoffered),
    offer,
    stack,
    sheet,
    check: (target: BuildTarget, on: boolean) =>
      choose(on ? [...checked, target] : checked.filter((item) => item !== target)),
    pick: (next: CreatableStack) => {
      setPicked(next);
      choose(checked, compiledChoice(next));
    },
    closeSheet: () => setSheet(null),
  };
}

/** A fresh compiled game (Rust where offered, else a browser game); opening existing games remains Home's folder action. */
export function CreateCppGameDialog({
  rootLabel,
  initialLocation = null,
  onCreated,
  onDismiss,
}: {
  rootLabel: string;
  initialLocation?: GameLocation | null;
  onCreated: (game: GameProject) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState(initialLocation);
  const { pending, error, waiting, run } = useSteps();
  const input = useRef<HTMLInputElement>(null);
  const busy = pending !== null;
  const folder = folderFor(name, rootLabel, location);
  const destinations = useDestinations();
  const args = createGameArgs(name, destinations.choice, location?.dir);
  const chooseLocation = () =>
    run("location", async () => {
      const chosen = await window.studio.pickGameLocation();
      if (chosen) setLocation(chosen);
    });
  const create = () => {
    if (!args) return;
    return run("create", async () => {
      await onCreated(await window.studio.createGame(...args));
    });
  };
  return (
    <DialogSurface
      dismissible={!busy}
      title={destinations.stack === GameStack.RustWgpu ? MESSAGE.rustTitle : MESSAGE.title}
      size="xl"
      testId="create-game-dialog"
      initialFocus={input}
      onDismiss={() => {
        if (!waiting.current) onDismiss();
      }}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <CppNameField input={input} name={name} busy={busy} error={error} onName={setName} />
        <SavedTo folder={folder} busy={busy} choosing={pending === "location"} onChange={chooseLocation} />
        <StackChoice offer={destinations.offer} stack={destinations.stack} disabled={busy} onPick={destinations.pick} />
        <Destinations
          choice={destinations.choice}
          checked={destinations.checked}
          disabled={busy}
          onCheck={destinations.check}
        />
        {error && (
          <p role="alert" className="text-xs text-red">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="outline" disabled={busy} onClick={onDismiss}>
            {MESSAGE.cancel}
          </Button>
          <Button type="submit" variant="default" disabled={busy || !args}>
            {pending === "create" ? MESSAGE.creating : MESSAGE.create}
          </Button>
        </div>
      </form>
      <ToolchainSheet
        open={destinations.sheet !== null}
        targets={destinations.sheet?.targets ?? []}
        {...(destinations.sheet ? { stack: destinations.sheet.stack } : {})}
        onClose={destinations.closeSheet}
      />
    </DialogSurface>
  );
}

/** The name stays labeled while the studio checks tools or creates the folder. */
function CppNameField({
  input,
  name,
  busy,
  error,
  onName,
}: {
  input: RefObject<HTMLInputElement | null>;
  name: string;
  busy: boolean;
  error: string;
  onName: (name: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="create-game-name" className="text-xs text-ink-2">
        {MESSAGE.name}
      </label>
      <div className="game-name-field">
        <input
          ref={input}
          id="create-game-name"
          aria-label={MESSAGE.name}
          autoComplete="off"
          maxLength={80}
          placeholder={MESSAGE.untitled}
          value={name}
          disabled={busy}
          onChange={(event) => onName(event.target.value)}
          aria-invalid={Boolean(error)}
        />
      </div>
    </div>
  );
}

/** Saved to: the folder the new game gets, and a way to change where it goes. */
function SavedTo({
  folder,
  busy,
  choosing,
  onChange,
}: {
  folder: { parent: string; name: string };
  busy: boolean;
  choosing: boolean;
  onChange: () => Promise<void>;
}): JSX.Element {
  return (
    <div className="game-facts">
      <div className="game-saved-to" data-create-game-location>
        <span id="create-game-location" className="text-body-sm text-ink-3">
          {MESSAGE.savedTo}
        </span>
        <span className="game-saved-path font-mono text-body-sm text-ink-3" title={`${folder.parent}/${folder.name}`}>
          <span dir="ltr">
            {folder.parent}/<span className="text-ink">{folder.name}</span>
          </span>
        </span>
        <Button
          type="button"
          variant="outline"
          aria-describedby="create-game-location"
          disabled={busy}
          onClick={() => void onChange()}
        >
          {choosing ? MESSAGE.choosing : MESSAGE.change}
        </Button>
      </div>
    </div>
  );
}
