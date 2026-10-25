/**
 * A message's @ tags after it is sent: the send gives the agent each tag (a read root, the lines
 * after the words) and records the results; the chat shows them as one card under the message;
 * Try again and Remove tag update that card, and only a tag that now arrived tells the agent.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { MentionSources } from "../../src/main/core/mention-tags.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import {
  MENTION_CONTEXT_HEADING,
  MentionKind,
  MentionMiss,
  type MentionOutcome,
  MentionOrigin,
  type MentionRef,
  MentionResult,
  MentionRetry,
  mergeMentionResults,
  refOf,
  retriable,
} from "../../src/shared/prompt-mention.ts";
import { DispatchActionType, MessageOrigin, type DispatchAction } from "../../src/shared/protocol.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const neon: MentionRef = {
  handle: "neon-rush",
  kind: MentionKind.Game,
  origin: MentionOrigin.Genex,
  title: "Neon Rush",
  slug: "neon-rush",
  coverUrl: "https://cdn.genex.technology/covers/neon.webp",
};
const other: MentionRef = {
  handle: "other-game",
  kind: MentionKind.Game,
  origin: MentionOrigin.Local,
  title: "Other game",
  game: "other-game",
};
const tree: MentionRef = {
  handle: "giant-mushroom-tree",
  kind: MentionKind.Asset,
  origin: MentionOrigin.Library,
  title: "Giant mushroom tree",
  generation: "gen-mushroom-01",
};

describe("sending and retrying @ tags", () => {
  let lite: CoreLite;
  let core: StudioCore;
  let threadId: string;
  const sent: DispatchAction[] = [];
  let cloneWorks = false;
  let libraryWorks = false;
  const libraryCalls: string[][] = [];

  before(async () => {
    const sources: MentionSources = {
      world: async () => ({
        title: "Neon Rush",
        remixable: true,
        cloneUrl: "https://git.genex.games/a/neon-rush.git",
        authorId: "a",
      }),
      me: async () => null,
      clone: async (_url, dest) => {
        if (!cloneWorks) throw new Error("offline");
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, "main.ts"), "// neon\n");
      },
      assetManifest: () => Promise.reject(new Error("offline")),
      addFromLibrary: async (project, generationId) => {
        libraryCalls.push([project, generationId]);
        if (!libraryWorks) throw new Error("offline");
        return [`assets/library/job-1/${generationId}.glb`];
      },
    };
    lite = await coreLite({ executionPolicy: { runBackgroundImprovement: false }, mentionSources: sources });
    core = lite.core;
    core.host.dispatch = async (action) => {
      sent.push(action);
      return undefined;
    };
    await core.games.scaffold("racer");
    await core.games.scaffold("other-game");
    threadId = await core.createGameThread("racer");
  });
  after(() => lite.close());

  const tagged = async (): Promise<MentionOutcome[][]> =>
    (await core.store.listEvents(threadId)).flatMap((event) =>
      event.data.type === "custom" && event.data.event_type === CustomEvent.MentionTagged
        ? [(event.data.payload as { tags: MentionOutcome[] }).tags]
        : [],
    );
  const userMessages = () => sent.filter((action) => action.type === DispatchActionType.UserMessage);

  it("a send gives the agent each tag after the words, and a local game as a read root", async () => {
    await core.sendUserMessage("mix @other-game with @neon-rush", {
      thread: threadId,
      clientId: "q-1",
      mentions: [other, neon],
    });
    const [action] = userMessages();
    assert.ok(action && action.type === DispatchActionType.UserMessage);
    assert.ok(action.text.startsWith(`mix @other-game with @neon-rush${MENTION_CONTEXT_HEADING}`));
    assert.ok(action.extraReads?.includes(core.games.dirFor("other-game")));
    const [results] = await tagged();
    assert.deepEqual(
      results?.map((tag) => [tag.handle, tag.result, tag.miss]),
      [
        ["other-game", MentionResult.Read, undefined],
        ["neon-rush", MentionResult.Unavailable, MentionMiss.NotDownloaded],
      ],
    );
  });

  it("Try again records the new result and tells the agent in a line the chat leaves out", async () => {
    cloneWorks = true;
    const before = userMessages().length;
    await core.retryMention(threadId, "q-1", neon, MentionRetry.Again);
    const latest = (await tagged()).at(-1);
    assert.equal(latest?.[0]?.result, MentionResult.Copied);
    const told = userMessages().slice(before);
    assert.equal(told.length, 1);
    assert.equal(told[0]?.type === DispatchActionType.UserMessage && told[0].origin, MessageOrigin.TagRetry);
  });

  it("Remove tag records the tag as removed and tells the agent nothing", async () => {
    const before = userMessages().length;
    await core.retryMention(threadId, "q-1", other, MentionRetry.Remove);
    assert.equal((await tagged()).at(-1)?.[0]?.result, MentionResult.Removed);
    assert.equal(userMessages().length, before);
  });

  it("a retry outside a game's chat is refused", async () => {
    await assert.rejects(core.retryMention(core.mainThread, "q-1", neon, MentionRetry.Again));
  });

  it("a library tag is added to the game through the library, and Try again carries its generation", async () => {
    await core.sendUserMessage("put @giant-mushroom-tree by the lake", {
      thread: threadId,
      clientId: "q-2",
      mentions: [tree],
    });
    const failed = (await tagged()).at(-1)?.[0];
    assert.equal(failed?.result, MentionResult.Unavailable);
    assert.equal(failed?.miss, MentionMiss.NotDownloaded);
    assert.ok(failed && retriable(failed));
    libraryWorks = true;
    await core.retryMention(threadId, "q-2", refOf(failed), MentionRetry.Again);
    const added = (await tagged()).at(-1)?.[0];
    assert.equal(added?.result, MentionResult.Added);
    assert.equal(added?.path, "assets/library/job-1/gen-mushroom-01.glb");
    assert.deepEqual(libraryCalls, [
      ["racer", "gen-mushroom-01"],
      ["racer", "gen-mushroom-01"],
    ]);
  });
});

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const outcome = (ref: MentionRef, result: MentionOutcome["result"], miss?: MentionOutcome["miss"]): MentionOutcome => ({
  ...refOf({ ...ref, result }),
  result,
  ...(miss ? { miss } : {}),
});
const record = (id: number, tags: MentionOutcome[]) =>
  event(id, { type: "custom", event_type: CustomEvent.MentionTagged, payload: { messageId: "q-1", tags } });

const queued = (id: number, messageId: string) =>
  event(id, { type: "custom", event_type: CustomEvent.CoordinatorMessageQueued, payload: { messageId } });
const said = (id: number, role: "user" | "assistant", content: string) =>
  event(id, { type: "messages", messages: [{ role, content }] });

describe("the result card in the chat", () => {
  const words = "mix @other-game with @neon-rush";
  const results = [
    outcome(other, MentionResult.Read),
    outcome(neon, MentionResult.Unavailable, MentionMiss.NotDownloaded),
  ];
  const events = [
    said(1, "user", "an earlier message"),
    queued(2, "q-0"),
    said(3, "user", `${words}${MENTION_CONTEXT_HEADING}- lines`),
    queued(4, "q-1"),
    said(5, "assistant", "On it."),
    record(6, results),
  ];

  const cardUnder = (entries: ReturnType<typeof toEntries>, text: string) => {
    const at = entries.findIndex((entry) => entry.kind === EntryKind.User && entry.text === text);
    return { user: entries[at], card: entries[at + 1] };
  };

  it("sits right under its message, which shows only the words with its tags", () => {
    const { user, card } = cardUnder(toEntries(events), words);
    assert.ok(user?.kind === EntryKind.User);
    assert.deepEqual(user.tags, ["other-game", "neon-rush"]);
    assert.ok(card?.kind === EntryKind.Mentions);
    assert.equal(card.messageId, "q-1");
  });

  it("waits for its message when the tags were recorded before the queue wrote it", () => {
    const early = [
      said(1, "user", "an earlier message"),
      queued(2, "q-0"),
      record(3, results),
      said(4, "user", words),
      queued(5, "q-1"),
    ];
    const entries = toEntries(early);
    assert.equal(cardUnder(entries, "an earlier message").card?.kind, EntryKind.User);
    assert.equal(cardUnder(entries, words).card?.kind, EntryKind.Mentions);
  });

  it("finds its message by the queue's id when delivery order moved the message after it", () => {
    // A message typed during work is shown where it was read, after its tags were recorded.
    const moved = [
      said(1, "user", "an earlier message"),
      record(2, results),
      said(3, "assistant", "Done."),
      said(4, "user", words),
    ];
    const entries = toEntries(moved, new Map([[event(4, { type: "messages", messages: [] }).id, "q-1"]]));
    assert.equal(cardUnder(entries, "an earlier message").card?.kind, EntryKind.Assistant);
    assert.equal(cardUnder(entries, words).card?.kind, EntryKind.Mentions);
  });

  it("a later record for the same message replaces each tag's result in place", () => {
    const entries = toEntries([...events, record(7, [outcome(neon, MentionResult.Copied)])]);
    const cards = entries.filter((entry) => entry.kind === EntryKind.Mentions);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0]?.kind === EntryKind.Mentions && cards[0].tags.map((tag) => [tag.handle, tag.result]), [
      ["other-game", MentionResult.Read],
      ["neon-rush", MentionResult.Copied],
    ]);
  });

  it("offers Try again only where fetching again can help", () => {
    assert.equal(retriable(outcome(neon, MentionResult.Unavailable, MentionMiss.NotDownloaded)), true);
    assert.equal(retriable(outcome(neon, MentionResult.Unavailable, MentionMiss.NotTakeable)), false);
    assert.equal(retriable(outcome(neon, MentionResult.Copied)), false);
  });

  it("merging keeps the first order and takes the newest result", () => {
    const merged = mergeMentionResults(
      [outcome(other, MentionResult.Read), outcome(neon, MentionResult.Unavailable)],
      [outcome(neon, MentionResult.Copied)],
    );
    assert.deepEqual(
      merged.map((tag) => [tag.handle, tag.result]),
      [
        ["other-game", MentionResult.Read],
        ["neon-rush", MentionResult.Copied],
      ],
    );
    assert.deepEqual(refOf(outcome(neon, MentionResult.Copied)), neon);
  });
});
