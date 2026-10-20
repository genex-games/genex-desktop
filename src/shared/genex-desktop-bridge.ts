/**
 * The desktop path of `@genex-ai/embed-sdk` 0.34 (owner decision D3): inside Genex Desktop's Play,
 * the SDK never opens a popup to approve a spend. It finds `window.__genexDesktop` and asks the
 * app to confirm instead, and the app draws Genex's own card on its trusted Play bar.
 *
 * How it runs:
 *  1. The SDK creates the grant or generation on genex.games as it always does and gets its id.
 *  2. Where `genexDesktopBridgeOf(window)` finds a bridge, it calls `bridge.confirm({ kind, id })`
 *     instead of `window.open(<dashboard>/play/<kind>/<id>)`.
 *  3. The app reads that grant's or generation's terms from genex.games by id with the account Play
 *     is signed in as (it never trusts the page for a term), shows the card, and approves or
 *     declines on genex.games itself.
 *  4. `confirm` resolves `{ approved }`; the SDK carries on exactly as after its popup closed.
 *
 * The page cannot forge the card (it is drawn over the game by the app, not in the page), and the
 * bridge has no other method: no balance, no account, no approval without the person's tap.
 *
 * MIRROR: everything from `GENEX_DESKTOP_BRIDGE_VERSION` to the end of this file is copied byte for
 * byte into genex-demo `packages/embed-sdk/src/desktop-bridge.ts` (the SDK's side), with no
 * imports, so the two can be diffed. Change both together, and bump the version for any change a
 * released SDK would read differently.
 */

/** The bridge's version; an SDK that finds another version falls back to its popup. */
export const GENEX_DESKTOP_BRIDGE_VERSION = 1;

/** The global the app installs in a Play page's main world. */
export const GENEX_DESKTOP_GLOBAL = "__genexDesktop";

/** What is being confirmed: a standing grant or one generation (the SDK's `/play/grant` and `/play/generate`). */
export const GenexConfirmKind = { Grant: "grant", Generate: "generate" } as const;
export type GenexConfirmKind = (typeof GenexConfirmKind)[keyof typeof GenexConfirmKind];

/** A grant's or a generation's id on genex.games, as the SDK names it. */
export const GENEX_CONFIRM_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** What the SDK asks the app to confirm: the kind and genex.games' id, nothing else. */
export interface GenexDesktopConfirmRequest {
  kind: GenexConfirmKind;
  id: string;
}

/** The person's answer: approved on genex.games, or not (declined, dismissed, or the game left). */
export interface GenexDesktopConfirmAnswer {
  approved: boolean;
}

/** `window.__genexDesktop` as the SDK sees it. */
export interface GenexDesktopBridge {
  readonly version: typeof GENEX_DESKTOP_BRIDGE_VERSION;
  confirm(request: GenexDesktopConfirmRequest): Promise<GenexDesktopConfirmAnswer>;
}

/** A plain object's fields: `{}` or `Object.create(null)`, never an array or a class instance. */
function plainFields(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? { ...value } : null;
}

/** A confirm request from the page as the app accepts it: exactly `kind` and `id`, or null. */
export function readGenexConfirmRequest(raw: unknown): GenexDesktopConfirmRequest | null {
  const fields = plainFields(raw);
  if (!fields || Object.keys(fields).length !== 2) return null;
  const { kind, id } = fields;
  const known = kind === GenexConfirmKind.Grant || kind === GenexConfirmKind.Generate;
  if (!known || typeof id !== "string" || !GENEX_CONFIRM_ID_RE.test(id)) return null;
  return { kind, id };
}

/** The app's answer as the SDK accepts it: approved only when it says exactly `true`. */
export function readGenexConfirmAnswer(raw: unknown): GenexDesktopConfirmAnswer {
  return { approved: plainFields(raw)?.approved === true };
}

/** The desktop bridge on `scope` (the page's `window`), or null outside Genex Desktop or on another version. */
export function genexDesktopBridgeOf(scope: unknown): GenexDesktopBridge | null {
  if (typeof scope !== "object" || scope === null) return null;
  const bridge: unknown = Reflect.get(scope, GENEX_DESKTOP_GLOBAL);
  if (typeof bridge !== "object" || bridge === null) return null;
  const version: unknown = Reflect.get(bridge, "version");
  const confirm: unknown = Reflect.get(bridge, "confirm");
  if (version !== GENEX_DESKTOP_BRIDGE_VERSION || typeof confirm !== "function") return null;
  return {
    version: GENEX_DESKTOP_BRIDGE_VERSION,
    confirm: async (request) => readGenexConfirmAnswer(await Reflect.apply(confirm, bridge, [request])),
  };
}
