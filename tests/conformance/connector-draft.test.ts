import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpConnectorView } from "../../src/shared/mcp.ts";
import { parseMcpInput } from "../../src/shared/mcp-import.ts";
import {
  blankDraft,
  connectorIdFor,
  connectorToSave,
  type Draft,
  DraftProblem,
  draftFrom,
  draftFromImport,
  draftProblem,
  secretsToSave,
  withTransport,
} from "../../src/renderer/panels/connectors/draft.ts";

const filled = (change: Partial<Draft>): Draft => ({ ...blankDraft(), ...change });

const savedView = (connector: McpConnectorView["connector"]): McpConnectorView =>
  ({ connector, secrets: [] }) as unknown as McpConnectorView;

test("a new server's id comes from its name and steps aside for ids already taken", () => {
  const cases: Array<[string, string[], string]> = [
    ["GitHub", [], "github"],
    ["My Notes (local)", [], "my-notes-local"],
    ["GitHub", ["github"], "github-2"],
    ["GitHub", ["github", "github-2"], "github-3"],
    ["日本語", [], "server"],
    ["9 lives", [], "server-9-lives"],
    ["a".repeat(40), ["a".repeat(32)], `${"a".repeat(30)}-2`],
  ];
  for (const [name, taken, id] of cases) assert.equal(connectorIdFor(name, new Set(taken)), id, name);
});

test("a command line saves as the exact program and arguments, and secrets as names with their values apart", () => {
  const draft = filled({
    connector: { ...blankDraft().connector, name: "Notes" },
    commandLine: "node '/Users/me/My Notes/index.js' --root ''",
    secretRows: [
      { name: "NOTES_TOKEN", value: "t0ken" },
      { name: "LOG_LEVEL", value: "" },
    ],
  });
  const saved = connectorToSave(draft, new Set(["notes"]));
  assert.equal(saved.id, "notes-2");
  assert.equal(saved.transport, "stdio");
  assert.equal(saved.command, "node");
  assert.deepEqual(saved.args, ["/Users/me/My Notes/index.js", "--root", ""]);
  assert.deepEqual(saved.env, ["NOTES_TOKEN", "LOG_LEVEL"]);
  assert.equal(saved.url, undefined);
  assert.equal(saved.authentication, undefined);
  assert.equal(JSON.stringify(saved).includes("t0ken"), false);
  assert.deepEqual(secretsToSave(draft), { "env.NOTES_TOKEN": "t0ken" });
});

test("a URL server keeps its browser sign-in, and a key header takes its place", () => {
  const remote = (rows: Draft["secretRows"], authentication?: "oauth"): Draft =>
    filled({
      connector: {
        ...blankDraft().connector,
        name: "Linear",
        transport: "http",
        url: " https://mcp.linear.app/mcp ",
        ...(authentication ? { authentication } : {}),
      },
      commandLine: "npx stale",
      secretRows: rows,
    });
  const fresh = connectorToSave(remote([]), new Set());
  assert.equal(fresh.authentication, undefined, "the host turns sign-in on when the server asks");
  assert.equal(fresh.url, "https://mcp.linear.app/mcp");
  assert.equal(fresh.command, undefined);
  assert.equal(fresh.args, undefined);
  assert.equal(fresh.headers, undefined);
  assert.equal(connectorToSave(remote([], "oauth"), new Set()).authentication, "oauth");
  const keyed = connectorToSave(remote([{ name: "authorization", value: "Bearer x" }], "oauth"), new Set());
  assert.equal(keyed.authentication, undefined);
  assert.deepEqual(keyed.headers, ["authorization"]);
  assert.deepEqual(secretsToSave(remote([{ name: "X-Team", value: "games" }])), { "header.X-Team": "games" });
});

test("a saved server opens with its command quoted back, keeps its id, and saves unchanged", () => {
  const connector = {
    id: "notes",
    name: "Notes",
    transport: "stdio" as const,
    command: "/Applications/My App/bin/notes",
    args: ["--dir", "/tmp/a b", "", "it's"],
    cwd: "/tmp",
    env: ["NOTES_TOKEN"],
    enabled: true,
    scope: "global" as const,
    toolPolicy: { deny: ["delete"] },
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const draft = draftFrom(savedView(connector));
  assert.deepEqual(draft.secretRows, [{ name: "NOTES_TOKEN", value: "" }]);
  const saved = connectorToSave({ ...draft, connector: { ...draft.connector, name: "Renamed" } }, new Set(["notes"]));
  assert.equal(saved.id, "notes", "a saved server's tools are named after its id; renaming never moves it");
  assert.equal(saved.command, connector.command);
  assert.deepEqual(saved.args, connector.args);
  assert.equal(saved.cwd, "/tmp");
  assert.deepEqual(saved.toolPolicy, { deny: ["delete"] });
  assert.equal(saved.createdAt, connector.createdAt);
  assert.deepEqual(secretsToSave(draft), {}, "an untouched stored value is left alone");
});

test("an old SSE server stays SSE; switching it to this Mac drops the address", () => {
  const view = savedView({
    id: "feed",
    name: "Feed",
    transport: "sse",
    url: "https://feed.example/sse",
    headers: ["X-Key"],
    enabled: true,
    scope: "global",
    toolPolicy: {},
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  const draft = draftFrom(view);
  assert.deepEqual(draft.secretRows, [{ name: "X-Key", value: "" }]);
  assert.equal(connectorToSave(draft, new Set()).transport, "sse");
  const local = connectorToSave(
    { ...draft, connector: { ...draft.connector, transport: "stdio" }, commandLine: "feed-server", secretRows: [] },
    new Set(),
  );
  assert.equal(local.transport, "stdio");
  assert.equal(local.url, undefined);
  assert.equal(local.headers, undefined);
  assert.equal(local.authentication, undefined);
});

test("a pasted server fills the form, its secret values included", () => {
  const imported = parseMcpInput("GITHUB_TOKEN=ghp_abc npx -y @modelcontextprotocol/server-github").drafts[0]!;
  const draft = draftFromImport(imported);
  assert.equal(draft.commandLine, "npx -y @modelcontextprotocol/server-github");
  assert.deepEqual(draft.secretRows, [{ name: "GITHUB_TOKEN", value: "ghp_abc" }]);
  assert.deepEqual(secretsToSave(draft), { "env.GITHUB_TOKEN": "ghp_abc" });
});

test("the form says what is missing before it can connect", () => {
  const base = blankDraft();
  const named = { ...base.connector, name: "X" };
  const cases: Array<[Draft, DraftProblem | null]> = [
    [base, DraftProblem.NoName],
    [filled({ connector: named }), DraftProblem.NoCommand],
    [filled({ connector: named, commandLine: "node 'x" }), DraftProblem.UnfinishedCommand],
    [filled({ connector: { ...named, transport: "http" } }), DraftProblem.NoUrl],
    [
      filled({ connector: named, commandLine: "run", secretRows: [{ name: "BAD NAME", value: "" }] }),
      DraftProblem.BadSecretName,
    ],
    [
      filled({
        connector: { ...named, transport: "http", url: "https://x" },
        secretRows: [{ name: "Bad:Header", value: "" }],
      }),
      DraftProblem.BadSecretName,
    ],
    [filled({ connector: named, commandLine: "run", secretRows: [{ name: "", value: "" }] }), null],
    [filled({ connector: named, commandLine: "run" }), null],
  ];
  for (const [draft, problem] of cases) assert.equal(draftProblem(draft), problem);
});

test("moving a server between this Mac and a URL never carries a secret to the other side", () => {
  const local = filled({
    connector: { ...blankDraft().connector, name: "Notes" },
    commandLine: "node server.js",
    secretRows: [{ name: "NOTES_TOKEN", value: "t0ken" }],
  });
  const moved = withTransport(local, "http");
  const remote = { ...moved, connector: { ...moved.connector, url: "https://elsewhere.example/mcp" } };
  assert.deepEqual(remote.secretRows, [], "the variable's row stays behind");
  assert.deepEqual(secretsToSave(remote), {}, "no value goes to the URL");
  const saved = connectorToSave(remote, new Set());
  assert.equal(saved.headers, undefined, "no header is named after the variable");
  assert.equal(JSON.stringify(saved).includes("t0ken"), false);

  const keyed = filled({
    connector: { ...blankDraft().connector, name: "Docs", transport: "http", url: "https://docs.example/mcp" },
    secretRows: [{ name: "X-API-Key", value: "k3y" }],
  });
  const back = withTransport(keyed, "stdio");
  assert.deepEqual(back.secretRows, [], "a header's row stays behind too");
  assert.deepEqual(secretsToSave(back), {});

  const sse = withTransport(keyed, "sse");
  assert.deepEqual(sse.secretRows, keyed.secretRows, "HTTP to SSE is the same place: the headers stay");
  assert.equal(sse.connector.transport, "sse");
});
