/**
 * The microphone a game's page gets in Play. The Play view's preload (`play-mic.ts`) serializes
 * {@link installPlayMic} whole into the page before the game's own scripts run. A game asking for a
 * microphone gets a track the app owns, at once; the person's own microphone feeds it only while
 * main says so (the header's mic switch), and switching microphones changes what feeds the track,
 * so the game's voice chat never notices. A camera request goes on to the browser, which Play's
 * session refuses. Type-only imports: at runtime the function may use nothing from outside its body.
 */
import type { PlayMicCommand, PlayMicReport } from "../shared/play-mic.ts";

// biome-ignore lint/suspicious/noExplicitAny: the untrusted page's own objects
type Foreign = any;

/** What the preload drives: main's word, passed on to the page. */
export interface PlayMicControl {
  command(command: PlayMicCommand): void;
}

/**
 * Install the app's microphone in the page (`scope` is the page's global object). `report` hears
 * every change; the answer takes main's commands, or is null when the page has no media devices.
 */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: serialized into the game's page, so its helpers must live inside it
export function installPlayMic(
  report: (state: PlayMicReport) => void,
  scope: Foreign = globalThis,
): PlayMicControl | null {
  const media = scope.navigator?.mediaDevices;
  const Devices = scope.MediaDevices;
  const Context = scope.AudioContext;
  const Stream = scope.MediaStream;
  if (!media || !Devices || !Context || !Stream) return null;
  const proto = Devices.prototype;
  // The browser's own, kept before the game can replace them.
  const browserAsk = proto.getUserMedia;
  const browserList = proto.enumerateDevices;
  const apply = Reflect.apply;
  /** The browser's stand-ins for "whichever is the system's", not microphones of their own. */
  const STAND_INS = new Set(["default", "communications"]);
  /** Why an opening failed, by the browser's error name (PlayMicProblem's values). */
  const PROBLEM: Record<string, PlayMicReport["problem"]> = {
    NotAllowedError: "denied",
    SecurityError: "denied",
    NotFoundError: "missing",
    OverconstrainedError: "missing",
  };
  /** Tracks handed to the game, each a copy of the one the app owns. */
  const handed = new Set<Foreign>();
  let mixer: { context: Foreign; out: Foreign } | null = null;
  let source: { stream: Foreign; node: Foreign; device: string | null } | null = null;
  let devices: string[] = [];
  /** The game's own audio settings (echo cancellation…), from its latest ask. */
  let settings: Record<string, unknown> = {};
  /** Counted up by each opening and closing: an opening something overtook is dropped. */
  let turn = 0;

  const send = (problem: PlayMicReport["problem"] = null): void => {
    report({ asked: handed.size > 0, live: source !== null, problem, devices: devices.slice() });
  };
  const inputs = async (): Promise<Foreign[]> => {
    try {
      const all: Foreign[] = Array.from(await apply(browserList, media, []));
      return all.filter((device) => device.kind === "audioinput" && !STAND_INS.has(device.deviceId));
    } catch {
      return [];
    }
  };
  const readNames = async (): Promise<void> => {
    const names: string[] = [];
    for (const device of await inputs()) if (device.label && !names.includes(device.label)) names.push(device.label);
    devices = names;
  };
  const mix = (): { context: Foreign; out: Foreign } => {
    if (mixer) return mixer;
    const context = new Context();
    const out = context.createMediaStreamDestination();
    out.channelCount = 1;
    Promise.resolve(context.resume?.()).catch(() => undefined);
    mixer = { context, out };
    return mixer;
  };
  const stopAll = (stream: Foreign): void => {
    for (const track of stream.getTracks()) track.stop();
  };
  const shut = (): void => {
    turn += 1;
    if (!source) return;
    source.node.disconnect();
    stopAll(source.stream);
    source = null;
  };
  const lost = (stream: Foreign): void => {
    const held = source;
    if (!held || held.stream !== stream) return;
    held.node.disconnect();
    source = null;
    send("lost");
  };
  const feed = (stream: Foreign, device: string | null): void => {
    if (source) {
      source.node.disconnect();
      stopAll(source.stream);
    }
    const { context, out } = mix();
    const node = context.createMediaStreamSource(stream);
    node.connect(out);
    source = { stream, node, device };
    for (const track of stream.getAudioTracks()) track.addEventListener?.("ended", () => lost(stream));
  };
  const handOut = (): Foreign => {
    const track = mix().out.stream.getAudioTracks()[0].clone();
    const stop = track.stop;
    track.stop = () => {
      apply(stop, track, []);
      if (!handed.delete(track)) return;
      if (handed.size === 0) shut();
      send();
    };
    handed.add(track);
    return new Stream([track]);
  };
  const open = async (device: string | null): Promise<void> => {
    turn += 1;
    const mine = turn;
    try {
      const named = device ? (await inputs()).find((input) => input.label === device) : undefined;
      const audio = named ? { ...settings, deviceId: { exact: named.deviceId } } : { ...settings };
      const stream = await apply(browserAsk, media, [{ audio: Object.keys(audio).length > 0 ? audio : true }]);
      if (mine !== turn || handed.size === 0) {
        stopAll(stream);
        return;
      }
      feed(stream, device);
      await readNames();
      send();
    } catch (error) {
      if (mine !== turn) return;
      shut();
      send(PROBLEM[(error as Foreign)?.name] ?? "failed");
    }
  };
  /** The page's getUserMedia: a microphone alone is the app's; anything with a camera is the browser's. */
  function ask(this: Foreign, constraints: Foreign): Promise<Foreign> {
    const audio = constraints?.audio;
    if (!audio || constraints.video) return apply(browserAsk, this, [constraints]);
    const own: Record<string, unknown> = typeof audio === "object" ? { ...audio } : {};
    // The microphone is the person's choice in the header, not the game's.
    settings = Object.fromEntries(Object.entries(own).filter(([key]) => key !== "deviceId" && key !== "groupId"));
    const stream = handOut();
    send();
    return Promise.resolve(stream);
  }
  proto.getUserMedia = ask;
  const legacy = scope.Navigator?.prototype;
  for (const name of ["getUserMedia", "webkitGetUserMedia"]) {
    if (!legacy || !(name in legacy)) continue;
    legacy[name] = (constraints: Foreign, ok: Foreign, fail: Foreign) =>
      apply(ask, media, [constraints]).then(ok, fail);
  }
  const refresh = async (): Promise<void> => {
    await readNames();
    send();
  };
  media.addEventListener?.("devicechange", () => void refresh());
  void refresh();
  return {
    command(command: PlayMicCommand): void {
      const device = typeof command?.device === "string" ? command.device : null;
      if (command?.open !== true) {
        shut();
        send();
        return;
      }
      if (handed.size === 0 || source?.device === device) return;
      void open(device);
    },
  };
}
