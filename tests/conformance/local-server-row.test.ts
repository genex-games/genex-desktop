/**
 * The local server's row in Settings → Model Providers: which face it shows for each status of a
 * saved server, how it names the server and its models, and where it says a server keeps its key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addressHint,
  LocalServerRowState,
  localServerRowState,
  modelDetails,
  rowProblem,
  savedKeyHint,
  serverLine,
} from "../../src/renderer/panels/local-server-row.ts";
import { LOCAL_SERVER_WORDS } from "../../src/renderer/words.ts";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { LocalServerProblem } from "../../src/shared/local-server.ts";

const TABBY = { url: "http://127.0.0.1:5000/v1", kind: "tabbyapi", hasKey: true } as const;

describe("the local server row's state", () => {
  it("follows the saved server's status, and says Connecting while it connects", () => {
    const rows: Array<[EngineStatusCode, LocalServerRowState]> = [
      [EngineStatusCode.Ready, LocalServerRowState.Connected],
      [EngineStatusCode.NotRunning, LocalServerRowState.NotRunning],
      [EngineStatusCode.NeedsLogin, LocalServerRowState.NeedsKey],
      [EngineStatusCode.NotInstalled, LocalServerRowState.NoModels],
      [EngineStatusCode.Error, LocalServerRowState.Unreachable],
    ];
    for (const [code, state] of rows)
      assert.equal(localServerRowState({ status: { code }, server: TABBY }, { connecting: false }), state, code);
    assert.equal(
      localServerRowState({ status: { code: EngineStatusCode.NotInstalled }, server: null }, { connecting: false }),
      LocalServerRowState.NotSetUp,
      "no saved server is not set up, whatever the status",
    );
    assert.equal(
      localServerRowState({ status: { code: EngineStatusCode.Ready }, server: TABBY }, { connecting: true }),
      LocalServerRowState.Connecting,
    );
  });
});

describe("the local server row's words", () => {
  it("names the server by its software and address, or the address alone", () => {
    assert.equal(serverLine(TABBY), "TabbyAPI at 127.0.0.1:5000");
    assert.equal(serverLine({ url: "http://192.168.1.20:1234/v1", kind: null }), "192.168.1.20:1234");
  });

  it("says each model's context, sight and tool calling", () => {
    const model = { id: "m", label: "m", contextWindow: 131_072, supportsTools: true, supportsVision: true };
    assert.equal(modelDetails(model), "131k context · sees images");
    assert.equal(
      modelDetails({ ...model, supportsVision: false, supportsTools: false, note: "Context size not reported" }),
      "Context size not reported · can't call tools, so it can't build",
    );
  });

  it("says where TabbyAPI keeps its key once a server asks for one, and nothing for others", () => {
    const asked = { ok: false as const, problem: LocalServerProblem.NeedsKey, kind: "tabbyapi" as const };
    assert.equal(addressHint(asked), LOCAL_SERVER_WORDS.tabbyKeyHint);
    assert.equal(addressHint({ ...asked, kind: "lm-studio" }), null);
    assert.equal(addressHint({ ok: false, problem: LocalServerProblem.NotAnswering }), null);
    assert.equal(addressHint(null), null);
    assert.equal(savedKeyHint(null, TABBY), LOCAL_SERVER_WORDS.tabbyKeyHint, "a saved TabbyAPI that asks for its key");
  });

  it("has words for every reason a connection saves nothing", () => {
    for (const problem of Object.values(LocalServerProblem)) {
      const said = rowProblem(null, { ok: false, problem });
      assert.ok(said && said.length > 10, problem);
    }
    assert.equal(
      rowProblem("Broke.", { ok: false, problem: LocalServerProblem.Empty }),
      "Broke.",
      "an action's own error first",
    );
    assert.equal(rowProblem(null, null), null);
  });
});
