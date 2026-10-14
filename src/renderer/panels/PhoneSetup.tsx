/**
 * A Rust · wgpu game's phones in the Toolchain sheet and Settings → Toolchains: each phone's parts
 * (the store's Rust libraries, bundletool and Java runtime with their sizes; Android's SDK platform,
 * Build-Tools and NDK the person installs with Android's own SDK manager), the iPhone's Xcode line,
 * and Android's SDK licence, which only the person accepts here (`toolchainAcceptAndroidLicence`);
 * no harness surface reaches it. A phone's Install (`toolchainInstallMobile`) shows only once
 * nothing blocks it, and says why otherwise. Rules live in `toolchain-view.ts` (`phoneViews`).
 */
import type { JSX } from "react";
import { useState } from "react";
import { GameStack } from "../../shared/game-project.ts";
import {
  AndroidLicence,
  type ToolchainInstallJob,
  type ToolchainStatus,
  UserSideState,
} from "../../shared/toolchain.ts";
import { Button } from "../ui/Button.tsx";
import { DESTINATION_WORDS, problemWords, TOOLCHAIN_WORDS } from "../words.ts";
import { type PhoneView, phoneBlockWords, phoneRowWords, phoneViews } from "./toolchain-view.ts";

const WORDS = TOOLCHAIN_WORDS.phones;

/** Android's SDK licence: the link to read it and the person's own Accept, or that they accepted it. */
function LicenceControl({
  view,
  busy,
  onAccept,
}: {
  view: PhoneView;
  busy: boolean;
  onAccept: () => void;
}): JSX.Element | null {
  if (view.licence.accepted)
    return (
      <p data-toolchain-licence="accepted" className="text-xs leading-snug text-ink-3">
        {WORDS.licence.accepted}
      </p>
    );
  if (!view.licence.offered) return null;
  return (
    <div data-toolchain-licence="offered" className="flex flex-col gap-2 rounded-md bg-hover/60 px-3 py-2.5">
      <span className="text-body-sm font-medium text-ink">{WORDS.licence.title}</span>
      <p className="text-xs leading-snug text-pretty text-ink-2">{WORDS.licence.intro}</p>
      <div className="flex items-center justify-end gap-2">
        <Button
          data-toolchain-licence-read
          variant="link"
          onClick={() => void window.studio.openUrl(WORDS.licence.url)}
        >
          {WORDS.licence.read}
        </Button>
        <Button data-toolchain-licence-accept variant="secondary" disabled={busy} onClick={onAccept}>
          {WORDS.licence.accept}
        </Button>
      </div>
    </div>
  );
}

/** One phone: its parts, why it cannot install yet, the licence for Android, and its Install. */
function PhoneSection({
  view,
  busy,
  onAccept,
  onInstall,
}: {
  view: PhoneView;
  busy: boolean;
  onAccept: () => void;
  onInstall: () => void;
}): JSX.Element {
  const phone = DESTINATION_WORDS.label[view.target];
  const blocked = phoneBlockWords(view);
  return (
    <section
      data-toolchain-phone={view.target}
      data-toolchain-phone-ready={view.ready ? "" : undefined}
      data-toolchain-phone-block={view.block ?? undefined}
      className="flex flex-col gap-2"
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-body-sm font-medium text-ink">{phone}</span>
        {view.ready && <span className="font-mono text-xs text-ink-3">{WORDS.ready}</span>}
      </span>
      <ul className="m-0 flex list-none flex-col p-0">
        {view.rows.map((row) => {
          const { name, detail } = phoneRowWords(row);
          return (
            <li
              key={row.id}
              data-toolchain-phone-part={row.id}
              data-toolchain-person-side={row.personSide ? "" : undefined}
              data-toolchain-part-state={row.state}
              className="flex items-baseline justify-between gap-4 py-1"
            >
              <span className="shrink-0 text-body-sm text-ink">{name}</span>
              <span
                className={`min-w-0 text-right text-xs leading-snug text-pretty ${
                  row.state === UserSideState.Ready ? "text-ink-3" : "text-ink-2"
                }`}
              >
                {detail}
              </span>
            </li>
          );
        })}
      </ul>
      {blocked && (
        <p data-toolchain-phone-why className="text-xs leading-snug text-pretty text-ink-3">
          {blocked}
        </p>
      )}
      <LicenceControl view={view} busy={busy} onAccept={onAccept} />
      {view.canInstall && (
        <div className="flex justify-end">
          <Button data-toolchain-phone-install={view.target} variant="secondary" disabled={busy} onClick={onInstall}>
            {WORDS.install(phone)}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The phones a Rust game's sheet lists on this computer (none for a C++ game); `onChanged` after
 * the person accepted the licence or started an install, so the opener reads the status again.
 */
export function PhoneSetup({
  status,
  job,
  onChanged,
}: {
  status: ToolchainStatus;
  job: ToolchainInstallJob | null;
  onChanged: () => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const views = phoneViews({ ...status, job: job ?? status.job }, GameStack.RustWgpu);
  if (views.length === 0) return null;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(problemWords(cause));
    } finally {
      setBusy(false);
    }
  };
  const accept = () => act(() => window.studio.toolchainAcceptAndroidLicence(AndroidLicence.Sdk));
  return (
    <div data-toolchain-phones className="flex flex-col gap-4 border-t border-line pt-3">
      {views.map((view) => (
        <PhoneSection
          key={view.target}
          view={view}
          busy={busy}
          onAccept={() => void accept()}
          onInstall={() => void act(() => window.studio.toolchainInstallMobile(view.target))}
        />
      ))}
      {error && (
        <p role="alert" data-toolchain-phone-error className="text-xs leading-relaxed text-red">
          {error}
        </p>
      )}
    </div>
  );
}
