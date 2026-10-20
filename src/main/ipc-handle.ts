import type { PerformanceRecorder } from "./performance.ts";
import { assertNativeActionAllowed } from "./dev/native-policy.ts";
import type {
  IpcResult,
  StudioInvokeChannel,
  StudioInvokePayload,
  StudioInvokeResult,
  StudioPushChannel,
  StudioPushPayload,
} from "../shared/ipc-channels.ts";
import { errorMessage } from "../shared/errors.ts";

/** Why an IPC call is refused before its handler runs. */
const MESSAGE = {
  studioUiOnly: "This action is restricted to Studio UI",
  playBarOnly: "This action is restricted to Studio UI and Play's bar",
  playBarPageOnly: "This action is restricted to Play's bar",
} as const;

export type { IpcResult } from "../shared/ipc-channels.ts";

/** Who sent an invoke: Electron's `IpcMainInvokeEvent`, reduced to what the guard compares. */
export interface IpcSender {
  sender: unknown;
  senderFrame: unknown;
}
/** The part of Electron's `ipcMain` registration needs; tests pass a recorder. */
export interface IpcRegistrar {
  handle(channel: string, listener: (event: IpcSender, payload: unknown) => Promise<IpcResult>): void;
}
/** A handler answers with its channel's `StudioApi` result, directly or as a promise. */
export type IpcHandler<C extends StudioInvokeChannel> = (
  payload: StudioInvokePayload<C>,
) => StudioInvokeResult<C> | Promise<StudioInvokeResult<C>>;

// Plugin panels, connectors and terminals may run arbitrary local programs, and a chat's permission
// mode and answers say what Claude may do on this Mac; a job's Stop ends a
// process and Open Privacy settings opens System Settings; Play's card menu unpublishes, deletes
// and changes published games on the Genex account. Only Studio's own main frame may reach them,
// never a plugin page or a game's frame.
const STUDIO_UI_ONLY = [
  "studio:plugins.",
  "studio:mcp.",
  "studio:terminal.",
  "studio:permissions.",
  "studio:jobs.",
  "studio:app-look.",
  // Save, Share and Add write into a game and publish to genex.games under the person's account.
  "studio:assets.",
  "studio:play.manage",
  "studio:play.cover",
];

// Writing and deleting comments as the Genex account: Studio's main frame or Play's bar layer only.
const PLAY_BAR_WRITES: ReadonlySet<string> = new Set(["studio:play.comment", "studio:play.uncomment"]);
// Paying for a game's purchase: the sheet lives only in Play's bar layer, so only its own page answers
// it, never Studio's main frame, a game's page or a frame inside the bar.
const PLAY_BAR_ONLY: ReadonlySet<string> = new Set(["studio:play.purchase"]);

/** Why `event`'s sender may not call `channel`, or null when it may. */
function senderRefusal(
  channel: string,
  event: IpcSender,
  options: { isStudioUi(event: IpcSender): boolean; isPlayBar?(event: IpcSender): boolean },
): string | null {
  const studio = options.isStudioUi(event);
  if (STUDIO_UI_ONLY.some((prefix) => channel.startsWith(prefix)) && !studio) return MESSAGE.studioUiOnly;
  if (PLAY_BAR_WRITES.has(channel) && !studio && options.isPlayBar?.(event) !== true) return MESSAGE.playBarOnly;
  if (PLAY_BAR_ONLY.has(channel) && options.isPlayBar?.(event) !== true) return MESSAGE.playBarPageOnly;
  return null;
}

/**
 * The `handle(channel, fn)` main registers every IPC channel through. Each call is refused unless a
 * UI-only channel comes from Studio's main frame, and in a fixture profile unless the channel is
 * fixture-safe. The channel, payload and result types come from `shared/ipc-channels.ts`, whose
 * every channel the native-policy table classifies: an unknown channel, or a handler that
 * disagrees with the preload about a payload or result, does not compile.
 */
export function createIpcHandle(
  ipc: IpcRegistrar,
  options: {
    fixture: boolean;
    isStudioUi(event: IpcSender): boolean;
    /**
     * Play's bar layer's own page (its main frame), which may also post and delete comments, and alone
     * answers a game's purchase sheet.
     */
    isPlayBar?(event: IpcSender): boolean;
    performance?: PerformanceRecorder;
  },
) {
  return <C extends StudioInvokeChannel>(channel: C, fn: IpcHandler<C>): void => {
    ipc.handle(channel, async (event, payload) => {
      const started = options.performance?.now() ?? 0;
      try {
        const refused = senderRefusal(channel, event, options);
        if (refused) throw new Error(refused);
        assertNativeActionAllowed(options.fixture, channel);
        // The one place a payload is typed: whatever the preload sent on this channel. Handlers
        // still check the fields they act on, because the sender is a browser.
        return { ok: true, value: await fn(payload as StudioInvokePayload<C>) };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      } finally {
        if (options.performance) options.performance.record(`invoke:${channel}`, options.performance.now() - started);
      }
    });
  };
}

/** Where main pushes: a window's `webContents`, reduced to its `send`. */
export interface PushTarget {
  send(channel: string, ...args: unknown[]): void;
}

/** Push one message to the renderer on a channel the preload subscribes to, typed by the channel map. */
export function pushToRenderer<C extends StudioPushChannel>(
  target: PushTarget,
  channel: C,
  payload: StudioPushPayload<C>,
): void {
  target.send(channel, payload);
}
