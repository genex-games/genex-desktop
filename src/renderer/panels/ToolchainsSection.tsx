/**
 * Settings → Toolchains: the C++ toolchain versions installed on this computer, the store's disk
 * use, and "Remove old versions", which keeps every version the current lock or any game's lock
 * names (`ToolchainService.prune`). Installing starts from the Toolchain sheet, never here. The
 * parts this computer's own games need that Genex has not published yet (ANGLE for Mac) are listed
 * as not available, with why. A developer run, where Rust · wgpu games can be made, adds their
 * setup: Apple's Command Line Tools and Xcode as separate rows, each phone's parts with Android's
 * SDK licence (`PhoneSetup.tsx`), the harness parts a Rust night refuses, each with its re-take, and
 * the crates Rust games asked for, each decided here (`CrateRequests.tsx`), with what Genex's checks
 * found in an approved one.
 */
import { type JSX, useState } from "react";
import { GameStack } from "../../shared/game-project.ts";
import { hostOf } from "../../shared/game-targets.ts";
import {
  isInstallRunning,
  type ToolchainInstallJob,
  type ToolchainPruneResult,
  type ToolchainStatus,
} from "../../shared/toolchain.ts";
import { hostPlatform } from "../platform.ts";
import { useDeveloperRun } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Pending } from "../ui/Pending.tsx";
import { problemWords, TOOLCHAIN_WORDS } from "../words.ts";
import { CrateRequests } from "./CrateRequests.tsx";
import { PhoneSetup } from "./PhoneSetup.tsx";
import { SeedRetake } from "./SeedRetake.tsx";
import { useToolchainStatus } from "./ToolchainSheet.tsx";
import { prerequisiteRows, prerequisiteWords, unhostedHere } from "./toolchain-view.ts";

/** The section's own words. */
const MESSAGE = {
  loading: "Loading…",
  removing: "Removing…",
} as const;

/** What the line under the button says after a prune: what it removed, or why it removed nothing. */
function prunedWords(answer: ToolchainPruneResult): string {
  const { settings } = TOOLCHAIN_WORDS;
  return answer.refused ? settings.kept[answer.refused] : settings.pruned(answer.removed, answer.bytes);
}

/** This computer's parts with no download yet, each saying why: nothing when there are none. */
function UnhostedRows({ status }: { status: ToolchainStatus }): JSX.Element | null {
  const rows = unhostedHere(status, hostOf(hostPlatform()));
  if (rows.length === 0) return null;
  return (
    <ul className="m-0 mt-1 flex list-none flex-col p-0">
      {rows.map(({ id, reason }) => (
        <li key={id} data-toolchain-unavailable="" data-toolchain-unhosted={reason} className="appearance-row min-h-10">
          <span className="flex min-w-0 flex-col">
            <span className="text-ink">{TOOLCHAIN_WORDS.component[id]}</span>
            <span className="text-ink-3">{TOOLCHAIN_WORDS.unhosted[reason]}</span>
          </span>
          <span className="shrink-0 font-mono text-ink-3">{TOOLCHAIN_WORDS.unavailable}</span>
        </li>
      ))}
    </ul>
  );
}

/** Rust · wgpu's setup beyond its components: Apple's two rows, the harness parts a Rust night refuses, and crate requests. */
function RustSetup({
  status,
  job,
  onRetaken,
}: {
  status: ToolchainStatus;
  job: ToolchainInstallJob | null;
  onRetaken: () => void;
}): JSX.Element {
  const stack = GameStack.RustWgpu;
  const words = TOOLCHAIN_WORDS.rust;
  return (
    <section data-settings-rust-setup className="mt-3 flex flex-col">
      <span className="text-ink">{TOOLCHAIN_WORDS.rust.settingsTitle}</span>
      <ul className="m-0 mt-1 flex list-none flex-col p-0">
        {prerequisiteRows(status, stack).map((row) => {
          const { name, detail } = prerequisiteWords(row, stack);
          return (
            <li
              key={row.prerequisite}
              data-toolchain-prerequisite={row.prerequisite}
              data-toolchain-present={row.present ? "" : undefined}
              className="appearance-row min-h-10"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-ink">{name}</span>
                <span className="text-ink-3">{detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3">
        <PhoneSetup status={status} job={job} onChanged={onRetaken} />
      </div>
      <div className="mt-2">
        <SeedRetake
          title={words.keptTitle}
          intro={words.keptIntro}
          modules={status.keptPreRust ?? []}
          onRetaken={onRetaken}
        />
      </div>
      <div className="mt-3">
        <CrateRequests />
      </div>
    </section>
  );
}

/** Settings → Toolchains: the installed versions, the store's disk use, Remove old versions, and what is not available yet. */
export function ToolchainsSection(): JSX.Element {
  const { status, job, error: loadError, reload } = useToolchainStatus(true);
  const developer = useDeveloperRun();
  const [pruning, setPruning] = useState(false);
  const [pruned, setPruned] = useState<string | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const words = TOOLCHAIN_WORDS.settings;
  const prune = async () => {
    setPruning(true);
    setPruned(null);
    setPruneError(null);
    try {
      const answer = await window.studio.toolchainPrune();
      setPruned(prunedWords(answer));
      await reload();
    } catch (cause) {
      setPruneError(problemWords(cause));
    } finally {
      setPruning(false);
    }
  };
  const error = pruneError ?? loadError;
  if (!status)
    return error ? (
      <p role="alert" className="text-red">
        {error}
      </p>
    ) : (
      <Pending label={MESSAGE.loading} />
    );
  const installed = [...status.installed].sort(
    (a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version, undefined, { numeric: true }),
  );
  const pruneDisabled = pruning || installed.length === 0 || isInstallRunning(job);
  return (
    <div data-settings-toolchains className="appearance-section">
      <div className="appearance-row">
        <span className="flex min-w-0 flex-col">
          <span className="text-ink">{words.versions}</span>
          <span data-toolchain-store-bytes className="font-mono text-ink-2 tabular-nums">
            {words.disk(status.storeBytes)}
          </span>
        </span>
        <Button data-toolchain-prune disabled={pruneDisabled} onClick={() => void prune()}>
          {pruning ? MESSAGE.removing : words.prune}
        </Button>
      </div>
      {installed.length === 0 ? (
        <p className="mt-2 text-ink-3">{words.empty}</p>
      ) : (
        <ul className="m-0 mt-1 flex list-none flex-col p-0">
          {installed.map((item) => (
            <li
              key={`${item.id}/${item.version}-${item.sha12}`}
              data-toolchain-version={`${item.id}/${item.version}`}
              className="appearance-row min-h-10"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="text-ink">{TOOLCHAIN_WORDS.component[item.id]}</span>
                <span className="font-mono text-ink-2">{item.version}</span>
              </span>
              <span className="shrink-0 font-mono text-ink-3 tabular-nums">{TOOLCHAIN_WORDS.size(item.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      <UnhostedRows status={status} />
      {developer && <RustSetup status={status} job={job} onRetaken={() => void reload()} />}
      {pruned && (
        <p role="status" data-toolchain-pruned className="mt-2 text-ink-3">
          {pruned}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-red">
          {error}
        </p>
      )}
    </div>
  );
}
