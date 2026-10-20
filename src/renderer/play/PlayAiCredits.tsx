/**
 * Get credits (`V3-TopUp`), hung under the AI pill over the dimmed game: the same Genex credits the
 * person makes games with (1 credit = 1¢), genex.games' packs smallest first with 2,500 picked and
 * each price as checkout charges it, auto top-up's switch ("at most once a day", off until the person
 * turns it on), Buy and Cancel, and Genex Pro. Checkout opens in the browser; nothing here spends.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { JSX, KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import {
  type AiCreditPack,
  AiCreditProductKind,
  type AiCreditProduct,
  type GameAiSettingsView,
} from "../../shared/game-ai-views.ts";
import { Switch } from "../ui/switch.tsx";
import { RovingAxis, rovingTarget } from "../ui/roving-focus.ts";
import { PLAY_AI_WORDS } from "../words.ts";
import { AiLoad, autoTopUpPatch, defaultPack, packsShown } from "./ai-model.ts";
import type { BarApi } from "./PlayBarPage.tsx";

const WORDS = PLAY_AI_WORDS.topUp;

/** genex.games' packs and the person's settings, read when Get credits opens and on Try again. */
function useCreditsData(api: BarApi) {
  const [packs, setPacks] = useState<AiCreditPack[]>([]);
  const [status, setStatus] = useState<AiLoad>(AiLoad.Loading);
  const [settings, setSettings] = useState<GameAiSettingsView | null>(null);
  const [reads, setReads] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Try again reads them again.
  useEffect(() => {
    let live = true;
    setStatus(AiLoad.Loading);
    api.gameAiCredits().then(
      (read) => {
        if (!live) return;
        setPacks(packsShown(read));
        setStatus(AiLoad.Ready);
      },
      () => live && setStatus(AiLoad.Failed),
    );
    // Auto top-up's switch shows once its state is read; Get credits works without it.
    api.gameAiSettings().then(
      (read) => live && setSettings(read),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, reads]);
  return { packs, status, settings, setSettings, retry: () => setReads((count) => count + 1) };
}

/** Left/Right/Up/Down move the pick between packs, as a radio group does. */
function movePick(
  event: KeyboardEvent<HTMLDivElement>,
  packs: AiCreditPack[],
  picked: string | null,
  pick: (id: string) => void,
): void {
  const index = packs.findIndex((pack) => pack.id === picked);
  const next = rovingTarget(event.key, index, packs.length, RovingAxis.Both);
  const pack = next === null ? undefined : packs[next];
  if (!pack) return;
  event.preventDefault();
  pick(pack.id);
  event.currentTarget.querySelector<HTMLElement>(`[data-ai-pack="${pack.id}"]`)?.focus();
}

/** The packs, as a radio group. */
function Packs({
  packs,
  picked,
  onPick,
}: {
  packs: AiCreditPack[];
  picked: string | null;
  onPick: (id: string) => void;
}): JSX.Element {
  return (
    <div
      className="play-ai-packs"
      role="radiogroup"
      aria-label={WORDS.packs}
      onKeyDown={(event) => movePick(event, packs, picked, onPick)}
    >
      {packs.map((pack) => (
        <button
          key={pack.id}
          type="button"
          role="radio"
          aria-checked={pack.id === picked}
          tabIndex={pack.id === picked ? 0 : -1}
          className="play-ai-pack"
          data-ai-pack={pack.id}
          onClick={() => onPick(pack.id)}
        >
          {PLAY_AI_WORDS.credits(pack.credits)}
          <small>{WORDS.price(pack.priceCents)}</small>
        </button>
      ))}
    </div>
  );
}

/** Auto top-up's switch, saved on genex.games; a save that fails says so and leaves it as it was. */
function AutoTopUp({
  api,
  settings,
  onSaved,
}: {
  api: BarApi;
  settings: GameAiSettingsView;
  onSaved: (view: GameAiSettingsView) => void;
}): JSX.Element | null {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!settings.signedIn) return null;
  const patch = autoTopUpPatch(settings.autoTopUp, true).autoTopUp;
  const on = settings.autoTopUp?.on === true;
  const save = (next: boolean): void => {
    setSaving(true);
    setFailed(false);
    api
      .gameAiSettingsSave(autoTopUpPatch(settings.autoTopUp, next))
      .then(onSaved, () => setFailed(true))
      .finally(() => setSaving(false));
  };
  return (
    <>
      <div className="play-ai-credits-row">
        <span id="play-ai-auto-top-up">{WORDS.autoTopUp(patch?.underCredits ?? 0, patch?.addCredits ?? 0)}</span>
        <Switch
          checked={on}
          disabled={saving}
          onCheckedChange={save}
          aria-label={WORDS.autoTopUpLabel}
          aria-describedby="play-ai-auto-top-up"
          data-ai-auto-top-up
        />
      </div>
      {failed && (
        <p className="play-ai-problem" role="alert">
          {WORDS.saveFailed}
        </p>
      )}
    </>
  );
}

/** Get credits, at `place` under the pill. */
export function PlayAiCredits({
  api,
  place,
  onClose,
}: {
  api: BarApi;
  place: { top: number; right: number };
  onClose: () => void;
}): JSX.Element {
  const { packs, status, settings, setSettings, retry } = useCreditsData(api);
  const [picked, setPicked] = useState<string | null>(null);
  const [checkoutFailed, setCheckoutFailed] = useState(false);
  const pick = picked ?? defaultPack(packs);
  const pack = packs.find((shown) => shown.id === pick) ?? null;
  const checkout = (product: AiCreditProduct): void => {
    setCheckoutFailed(false);
    api.gameAiCheckout(product).then(onClose, () => setCheckoutFailed(true));
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="play-ai-scrim" />
        <Dialog.Content
          className="play-ai-card play-ai-credits"
          style={{ top: place.top, right: place.right }}
          aria-describedby="play-ai-credits-about"
          data-play-ai-credits
        >
          <Dialog.Title className="play-ai-credits-title">{WORDS.title}</Dialog.Title>
          <p id="play-ai-credits-about" className="play-ai-card-small">
            {WORDS.about}
          </p>
          {status === AiLoad.Ready && packs.length > 0 && <Packs packs={packs} picked={pick} onPick={setPicked} />}
          {status === AiLoad.Loading && (
            <p className="play-ai-card-small" aria-busy="true">
              {WORDS.loading}
            </p>
          )}
          {(status === AiLoad.Failed || (status === AiLoad.Ready && packs.length === 0)) && (
            <div className="play-ai-problem" role="alert">
              <span>{WORDS.failed}</span>{" "}
              <button type="button" className="play-ai-link" onClick={retry}>
                {WORDS.retry}
              </button>
            </div>
          )}
          {settings && <AutoTopUp api={api} settings={settings} onSaved={setSettings} />}
          {checkoutFailed && (
            <p className="play-ai-problem" role="alert">
              {WORDS.checkoutFailed}
            </p>
          )}
          <div className="play-ai-card-acts">
            <button
              type="button"
              className="play-ai-button"
              data-primary
              disabled={!pack}
              data-ai-buy
              onClick={() => pack && checkout({ kind: AiCreditProductKind.Pack, packId: pack.id })}
            >
              {WORDS.buy(pack?.credits ?? 0)}
            </button>
            <Dialog.Close className="play-ai-button">{WORDS.cancel}</Dialog.Close>
          </div>
          <p className="play-ai-card-small play-ai-credits-browser">{WORDS.browser}</p>
          {settings?.pro !== true && (
            <>
              <hr className="play-ai-sep" />
              <div className="play-ai-credits-row">
                <span className="play-ai-credits-pro">
                  <span>{WORDS.pro}</span>
                  <small>{WORDS.proAbout}</small>
                </span>
                <button
                  type="button"
                  className="play-ai-button"
                  data-ai-pro
                  onClick={() => checkout({ kind: AiCreditProductKind.Pro })}
                >
                  {WORDS.proPrice}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
