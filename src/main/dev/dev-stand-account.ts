/**
 * The app's Genex account in a development profile that points Play at another copy of genex.games
 * (`play/origins.ts`): signed in on that copy's own device sign-in, since the Genex plugin's account
 * belongs to genex.games itself and the copy would refuse its token. The browser opens the copy's
 * website to approve it, polls follow the interval it asks for, and the token lives for the launch
 * only: it is never written anywhere, and signing out forgets it. Electron-free: the request and
 * the clock come in as deps.
 */
import { DeviceStatus, GenexRoute, MIN_POLL_INTERVAL_S } from "../../plugins/genex/http.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { PluginAccountState } from "../../shared/plugins.ts";
import type { GenexAccountPort } from "../core/genex-account.ts";
import { type GalleryRequest, isRecord } from "../play/gallery.ts";
import { onWebsite } from "../play/origins.ts";

/** What the approval page calls this sign-in. */
const DEVICE_LABEL = "Genex development profile";
/** The fastest the copy is polled, whatever it asks: genex.games' own floor. */
const MIN_POLL_MS = MIN_POLL_INTERVAL_S * SECOND_MS;
/** How long a sign-in waits for the browser when the copy names no lifetime. */
const DEFAULT_SIGN_IN_MS = 10 * MINUTE_MS;

const MESSAGE = {
  BadStart: "The development genex.games did not start a sign-in on the website Play links to",
} as const;

/** What the development sign-in needs: the copy's API, the clock and the website it approves on. */
export interface DevStandDeps {
  request: GalleryRequest;
  now(): number;
  /** The website Play links to: the approval page must be one of its pages. */
  web: string;
}

/** A sign-in waiting for the browser. */
interface Pending {
  deviceCode: string;
  expiresAt: number;
  nextPoll: number;
  interval: number;
}

/** A started sign-in as the copy answered it, or null when the answer is not one the app follows. */
function started(body: unknown, deps: DevStandDeps): { pending: Pending; userCode: string; verifyUrl: string } | null {
  if (!isRecord(body)) return null;
  const { deviceCode, userCode, verifyUrl, expiresIn, interval } = body;
  const named = typeof deviceCode === "string" && deviceCode !== "" && typeof userCode === "string" && userCode !== "";
  if (!named || typeof verifyUrl !== "string" || !onWebsite(verifyUrl, deps.web)) return null;
  const lasts = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * SECOND_MS : DEFAULT_SIGN_IN_MS;
  const every = typeof interval === "number" && interval > 0 ? interval * SECOND_MS : MIN_POLL_MS;
  const pending = {
    deviceCode,
    expiresAt: deps.now() + lasts,
    nextPoll: deps.now() + Math.max(MIN_POLL_MS, every),
    interval: Math.max(MIN_POLL_MS, every),
  };
  return { pending, userCode, verifyUrl };
}

/** The development profile's account on the copy of genex.games at `deps`. */
export function devStandAccountPort(deps: DevStandDeps): GenexAccountPort {
  let token: string | null = null;
  let pending: Pending | null = null;
  let polling: Promise<void> | null = null;

  /** Ask the copy once whether the browser approved, when the interval is due. */
  const poll = async (): Promise<void> => {
    const asked = pending;
    if (!asked) return;
    if (deps.now() > asked.expiresAt) {
      pending = null;
      return;
    }
    if (deps.now() < asked.nextPoll) return;
    asked.nextPoll = deps.now() + asked.interval;
    const answer = await deps
      .request(GenexRoute.DevicePoll, { method: "POST", body: { deviceCode: asked.deviceCode } })
      .catch(() => null);
    // A sign-in cancelled or replaced meanwhile takes nothing from this answer.
    if (pending !== asked || !answer || !isRecord(answer.body)) return;
    const { status, token: minted } = answer.body;
    if (status === DeviceStatus.Approved && typeof minted === "string" && minted) {
      token = minted;
      pending = null;
    } else if (status === DeviceStatus.Denied || status === DeviceStatus.Expired) pending = null;
  };
  /** One poll at a time, however many reads of the account wait on it. */
  const settle = (): Promise<void> => {
    polling ??= poll().finally(() => {
      polling = null;
    });
    return polling;
  };

  return {
    state: async () => {
      await settle();
      if (pending) return PluginAccountState.Authorizing;
      return token ? PluginAccountState.Unlocked : PluginAccountState.NotConnected;
    },
    token: async () => token ?? undefined,
    connect: async () => {
      if (token) return {};
      const answer = await deps.request(GenexRoute.DeviceStart, { method: "POST", body: { label: DEVICE_LABEL } });
      const sign = started(answer.body, deps);
      if (!sign) throw new Error(MESSAGE.BadStart);
      pending = sign.pending;
      return { userCode: sign.userCode, verifyUrl: sign.verifyUrl };
    },
    cancel: async () => {
      pending = null;
    },
    disconnect: async () => {
      pending = null;
      token = null;
    },
    // The copy's account rides on nothing else: there is no plugin to turn on for it.
    signedIn: async () => {},
  };
}
