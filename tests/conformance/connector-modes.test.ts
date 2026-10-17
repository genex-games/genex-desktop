/**
 * A connector's card in each of the chat's modes: a plugin connector's tools its manifest says only
 * read run with no card in any mode, as a file read does; in Auto a plugin connector's other tools
 * run with no card too, while Manual and Accept edits ask; the person's own connector asks in Auto,
 * since it may reach services beyond this Mac; Bypass asks for none. Plan, saved grants and a local
 * plugin's server keep their own rules (`plan-mode-actions`, `connector-always-allow`,
 * `local-plugin-consent`). Real core, the echo server as the connector.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import type { McpConnector } from "../../src/shared/mcp.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");
/** The Unreal plugin's editor connector, answering as the echo server does; `picture` only reads. */
const EDITOR = { id: "editor", name: "Unreal Engine · editor", command: "ignored", args: [], reads: ["picture"] };
const LAUNCH = { execPath: process.execPath, extraArgs: [SERVER] };
const ACTS = "unreal-editor__echo";
const READS = "unreal-editor__picture";
const OWN = "echo__echo";
/** How long a card nobody answers waits here, and how often a test looks for one. */
const CONSENT_TIMEOUT_MS = 20_000;
const LOOK_STEP_MS = 20;
const LOOK_TRIES = 250;

type Api = Record<string, (input: unknown) => Promise<unknown>>;
type Card = { consentId: string; tool: string; state: string };

/** The person's own connector: the echo server, trusted on this Mac. */
const own = (): McpConnector =>
  ({
    id: "echo",
    name: "Echo",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    enabled: true,
    scope: "global",
    toolPolicy: {},
    createdAt: new Date().toISOString(),
  }) as McpConnector;

describe("a connector's card in each mode", () => {
  let lite: CoreLite;
  let api: Api;
  let threadId = "";
  const project = "modes";

  before(async () => {
    lite = await coreLite({ consentTimeoutMs: CONSENT_TIMEOUT_MS });
    await lite.core.games.scaffold(project);
    threadId = await lite.core.createGameThread(project);
    await lite.core.mcp.save(own(), {}, { trust: true });
    await lite.core.mcp.registerPluginServer("unreal", EDITOR, LAUNCH);
    await lite.core.mcp.toolsFor(project);
    api = lite.api() as unknown as Api;
  });

  after(async () => {
    await lite.core.mcp.close();
    await lite.close();
  });

  const cards = async (): Promise<Card[]> =>
    (await lite.core.listAllEvents()).flatMap((event) =>
      event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginConsent
        ? [event.data.payload as Card]
        : [],
    );
  let calls = 0;
  /** Each call its own arguments: a declined call with the same ones is not asked again in a run. */
  const call = (name: string) =>
    api["mcp.invoke"]!({ project, threadId, name, args: name === READS ? {} : { text: `${name} ${++calls}` } });

  /** A call that must ask: its card shows, the person says no, and nothing ran. */
  async function asks(name: string): Promise<void> {
    const known = new Set((await cards()).map((card) => card.consentId));
    const calling = call(name);
    // Its no lands while the test still looks for the card's row: caught now, checked below.
    const outcome = calling.then(
      () => null,
      (error: unknown) => error,
    );
    let card: Card | undefined;
    for (let tries = 0; tries < LOOK_TRIES && !card; tries++) {
      card = (await cards()).find((c) => c.state === "pending" && !known.has(c.consentId));
      if (!card) await sleep(LOOK_STEP_MS);
    }
    assert.ok(card, `${name} asks`);
    assert.equal(lite.core.resolveConsent(card.consentId, false), true);
    assert.match(String(await outcome), /declin/i, `a no runs nothing for ${name}`);
  }

  /** A call that runs with no card. */
  async function runsUnasked(name: string): Promise<void> {
    const before = (await cards()).length;
    assert.ok(await call(name), `${name} runs`);
    assert.equal((await cards()).length, before, `${name} runs with no card`);
  }

  it("a tool the plugin says only reads never asks, in any mode", async () => {
    for (const mode of [PermissionMode.Manual, PermissionMode.AcceptEdits, PermissionMode.Auto]) {
      await lite.core.setPermissionMode(threadId, mode);
      await runsUnasked(READS);
    }
  });

  it("Manual and Accept edits ask before a plugin connector acts", async () => {
    for (const mode of [PermissionMode.Manual, PermissionMode.AcceptEdits]) {
      await lite.core.setPermissionMode(threadId, mode);
      await asks(ACTS);
    }
  });

  it("Auto runs a plugin connector's tools with no card, and still asks for the person's own connector", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    await runsUnasked(ACTS);
    await asks(OWN);
  });

  it("Bypass asks for no connector", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    await runsUnasked(ACTS);
    await runsUnasked(OWN);
  });
});
