/**
 * The unreal-chat fixture: the fixture game's chat holds a short synthetic Unreal chat
 * (`tests/fixtures/unreal-chat/sample-chat.json`), its connector records in the shape the host
 * writes, and a stand-in picture for each capture they list in the game's `.studio/captures/`. It
 * shows the chat's Unreal work: rows in words, "Worked in Unreal" headings, failures, play views
 * and a delivery under the work that made it. Nothing runs: every call in it has ended.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customPayload, customRecord } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { CONNECTOR_CAPTURES_DIR } from "../../shared/mcp.ts";
import type { StudioCore } from "../studio-core.ts";
import { gradientShot, type Rgb } from "./fixture-kit.ts";

/** The checkout a developer build was made from, as the build defines it; a test runs from it. */
declare const __STUDIO_DEV_BUILD__: { checkout: string } | null | undefined;

/** Where the log lives in the checkout. */
const FIXTURE_DIR = path.join("tests", "fixtures", "unreal-chat");
const LOG_FILE = "sample-chat.json";

/** The stand-in pictures' colors, one after the other: the valley's fog, then a lamp's glow. */
const FOG: readonly [Rgb, Rgb] = [
  [150, 160, 172],
  [46, 52, 60],
];
const GLOW: readonly [Rgb, Rgb] = [
  [196, 120, 64],
  [48, 40, 36],
];

/** The log, as the fixture file holds it: each event's data, oldest first. */
export interface UnrealChatLog {
  events: Array<{ at: number; data: EventData }>;
}

function checkout(): string {
  const build = typeof __STUDIO_DEV_BUILD__ === "object" ? __STUDIO_DEV_BUILD__ : null;
  return build?.checkout ?? process.cwd();
}

/** The synthetic chat's log. */
export async function unrealChatLog(root = checkout()): Promise<UnrealChatLog> {
  return JSON.parse(await readFile(path.join(root, FIXTURE_DIR, LOG_FILE), "utf8")) as UnrealChatLog;
}

/** Writes the log into the game's chat, a stand-in for each capture and for its delivery's picture. */
export async function seedUnrealChat(core: StudioCore, project: { name: string; dir: string }, threadId: string) {
  const log = await unrealChatLog(checkout());
  const captures = path.join(project.dir, CONNECTOR_CAPTURES_DIR);
  await mkdir(captures, { recursive: true });
  for (const [i, file] of chatCaptures(log).entries()) {
    const [from, to] = i % 2 === 0 ? FOG : GLOW;
    await writeFile(path.join(captures, path.basename(file)), gradientShot(from, to));
  }
  for (const file of deliveredPictures(log)) {
    await mkdir(path.dirname(path.join(project.dir, file)), { recursive: true });
    await writeFile(path.join(project.dir, file), gradientShot(...GLOW));
  }
  await core.append(
    log.events.map((event) => inGame(event.data, project.name)),
    threadId,
  );
}

/** The pictures the log's connector calls kept, as game-relative paths: the fixture draws each one. */
export function chatCaptures(log: UnrealChatLog): string[] {
  return log.events.flatMap(({ data }) => customPayload(data, CustomEvent.ConnectorTool)?.captures ?? []);
}

/** A record of the log, moved into the fixture game: a delivery names the game it landed in. */
function inGame(data: EventData, game: string): EventData {
  const custom = customRecord(data);
  if (custom?.event_type !== CustomEvent.AssetDelivered) return data;
  return { type: EventKind.Custom, event_type: custom.event_type, payload: { ...custom.payload, project: game } };
}

/** The pictures the log's deliveries name: the fixture shows a stand-in for each. */
function deliveredPictures(log: UnrealChatLog): string[] {
  return log.events.flatMap(({ data }) =>
    (customPayload(data, CustomEvent.AssetDelivered)?.files ?? []).flatMap((f) =>
      f.kind === "image" && typeof f.file === "string" ? [f.file] : [],
    ),
  );
}
