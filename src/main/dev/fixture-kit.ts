/**
 * What every developer fixture is built from: the fixture names, the one deterministic frame and
 * the gradient stills that stand in for captures, run-scoped custom events, and a staged SkillOpt
 * suggestion. `fixtures.ts` and the per-fixture seed modules import these; nothing here writes.
 */
import path from "node:path";
import zlib from "node:zlib";
import {
  SandboxProblemCode,
  SandboxTool,
  StudioPlatform,
  linuxInstallCommands,
  type SandboxProblem,
} from "../../shared/boot.ts";
import type { CustomEventType } from "../../shared/custom-events.ts";
import { EventKind, type EventData } from "../../shared/event-log.ts";
import { applyEdits } from "../../shared/skill-edits.ts";
import { ShotKind, iterationDir } from "../core/run-shots.ts";

export const FIXTURE_VERSION = 1;

/**
 * What a development profile's agents run on: the scripted fixtures or the live providers. Values
 * are what `scripts/studio-dev` writes in the profile and reads back from `status`: never rename one.
 */
export const DevProviders = { Fixture: "fixture", Live: "live" } as const;
export type DevProviders = (typeof DevProviders)[keyof typeof DevProviders];

/** Every named fixture a developer profile can launch into. Values are CLI arguments: never rename one. */
export const FixtureName = {
  AppBasics: "app-basics",
  BuildHistory: "build-history",
  RunControls: "run-controls",
  GameSurface: "game-surface",
  Sentinel: "sentinel",
  Sidebar: "sidebar",
  ChatHistory: "chat-history",
  ChatQuestions: "chat-questions",
  StudioActivity: "studio-activity",
  ChatFeedback: "chat-feedback",
  FirstLaunch: "first-launch",
  Notifications: "notifications",
  BuildGraph: "build-graph",
  LargeBuildGraph: "large-build-graph",
  /** An Unreal lead's runs on the Builds graph: milestones, save points, sub-agents and the critic's advice. */
  LeadGraph: "lead-graph",
  SandboxSetup: "sandbox-setup",
  UpdateReady: "update-ready",
  UnrealGame: "unreal-game",
  UnrealChat: "unreal-chat",
  /**
   * Workers on the Builds graph and in the chat: a chat turn's two, and, written after the start,
   * a Loop's three with its lead's jobs, build-graph's web Loops and lead-graph's Unreal lead runs
   * with their workers' records.
   */
  ChatWorkers: "chat-workers",
} as const;
export type FixtureName = (typeof FixtureName)[keyof typeof FixtureName];

/** The one list of named fixtures; scripts/studio-dev.ts validates and lists from it. */
export const FIXTURE_NAMES: readonly FixtureName[] = Object.values(FixtureName);

/** Is `name` a fixture this build knows? */
export function isFixtureName(name: string): name is FixtureName {
  return (FIXTURE_NAMES as readonly string[]).includes(name);
}

/** The fixture that shows a long chat, with or without a question waiting in it. */
export function isChatFixture(name: string | null | undefined): boolean {
  return name === FixtureName.ChatHistory || name === FixtureName.ChatQuestions;
}

/**
 * What the sandbox-setup fixture shows before its first Retry: a Linux machine missing bubblewrap
 * and socat. The fixture's own sandbox is real and ready, so Retry opens the studio.
 */
export const FIXTURE_SANDBOX_PROBLEM: SandboxProblem = {
  code: SandboxProblemCode.MissingTools,
  platform: StudioPlatform.Linux,
  missingTools: [SandboxTool.Bubblewrap, SandboxTool.Socat],
  installCommands: linuxInstallCommands([SandboxTool.Bubblewrap, SandboxTool.Socat]),
  details: ["bubblewrap (bwrap) not installed", "socat not installed"],
};

/** The release the update-ready fixture says is downloaded, named as update.electronjs.org names one. */
export const FIXTURE_UPDATE_RELEASE = "Genex 0.2.0";

/** The model every fixture engine offers and every fixture run names. */
export const FIXTURE_MODEL = "fixture-v1";

/** The one deterministic frame every fixture capture is: a PNG, saved under the .jpg the loop writes. */
export const SHOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAABDUlEQVR4nO3dQQ2DQBBA0dIgoQ4qoAK4Ywct2MFFHaGhoYTw8959spP8zHmH13t60PW8egHOJXCcwHECxwkcJ3CcwHECxwkcJ3CcwHECxwkcJ3CcwHECxwkcJ3CcwHHjkeHPtvxrj5985/WSd+/IBccJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdw3ODvwjYXHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHLcDgfwEmZYXm78AAAAASUVORK5CYII=",
  "base64",
);

/** A colour of a gradient still. */
export type Rgb = readonly [number, number, number];

const GRADIENT_WIDTH = 160;
const GRADIENT_HEIGHT = 90;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A 160×90 still fading from one colour to another, so a fixture's rounds can be told apart. */
export function gradientShot(from: Rgb, to: Rgb): Buffer {
  const w = GRADIENT_WIDTH;
  const h = GRADIENT_HEIGHT;
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    const at = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const shade = 0.85 + 0.15 * Math.sin(x / 9);
      for (let c = 0; c < 3; c++) rows[at + 1 + x * 3 + c] = (from[c] + (to[c] - from[c]) * t) * shade;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
  return out;
}

/** The folder a facet's round keeps its captures in, the way the loop names it. */
export function roundShotDir(runsRoot: string, runId: string, facetId: string, iteration: number): string {
  return iterationDir(path.join(runsRoot, runId, `facet_${facetId}`, ShotKind.Self), iteration);
}

/** One fixture run's events: `scope` (its `runId`, often its `project`) merged into each payload. */
export function fixtureRun(scope: Record<string, unknown>) {
  return (name: CustomEventType, payload: Record<string, unknown> = {}): EventData => ({
    type: EventKind.Custom,
    event_type: name,
    payload: { ...scope, ...payload },
  });
}

/** A staged suggestion as SkillOpt writes one: the edits, and the file as they leave it. */
export function appendSuggestion(skill: string, currentText: string, text: string) {
  const edits = [{ op: "append", text }];
  return { skill, file: `skills/${skill}.md`, currentText, edits, proposedText: applyEdits(currentText, edits).text };
}
