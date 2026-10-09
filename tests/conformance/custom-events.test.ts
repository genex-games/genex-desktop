/**
 * The custom event registry (`src/shared/custom-events.ts`) is the contract of the durable
 * `{ type: "custom", event_type, payload }` records. The type half is enforced by
 * `npm run typecheck` (the `@ts-expect-error` lines below fail the typecheck if a mismatch ever
 * compiles). These tests pin the runtime half: the registry names exactly the event names the
 * studio's code uses, and the readers tolerate whatever a harness or an old log wrote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";
import {
  CUSTOM_EVENT_TYPES,
  DELEGATED_PREFIX,
  customEvent,
  customPayload,
  customRecord,
  delegatedPayload,
  isCustomEventType,
  type CustomEventData,
} from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { stringVocabularies, vocabularyValues } from "../helpers/vocabulary-scan.ts";

const SRC = path.resolve(import.meta.dirname, "../../src");
// Code shipped into the games themselves: its records are the game's, not the studio's.
const NOT_STUDIO = new Set(["game-template", "page", "node_modules"]);

async function studioSources(): Promise<string[]> {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        /\.(?:ts|tsx|mjs|js)$/.test(e.name) &&
        !path
          .relative(SRC, e.parentPath)
          .split(path.sep)
          .some((part) => NOT_STUDIO.has(part)),
    )
    .map((e) => path.join(e.parentPath, e.name));
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The shared readers of `shared/custom-events.ts`; their second argument names the events read. */
const READERS = new Set(["customPayload", "customEvent"]);
/** The shared writer of `shared/custom-events.ts`; its first argument names the event written. */
const WRITERS = new Set(["customEventData"]);

/**
 * Every literal event name in the studio's sources, parsed as data. A name counts where it is
 * written (`event_type: "name"`, or passed to a local helper whose parameter becomes the
 * `event_type`) and where it is read (compared with an `event_type`/`eventType` value, a
 * `switch` case over one, listed in an array or Set that one is looked up in, or named to one of
 * the shared readers `customPayload`/`customEvent`, alone or in an array). Values that
 * came from an `event_type` are followed through local variables and helper parameters.
 * A name is a string literal or a vocabulary member (`CustomEvent.RunFinished`, the seed's
 * `RunEvent.RunFinished`), and `customEventData(name, …)` writes one.
 * A template literal (`delegated.${engine}`) is recorded as its fixed head followed by `*`.
 */
/** The seed's shared event writers whose third argument is the event name, by the module that exports each. */
const SHARED_WRITERS: ReadonlyArray<[writer: string, module: string]> = [
  ["appendRun", "/run-events.ts"],
  ["appendCustom", "/compaction-log.ts"],
];

async function eventNamesInSource(): Promise<Map<string, string[]>> {
  const files = await studioSources();
  const program = ts.createProgram(files, {
    allowJs: true,
    noResolve: true,
    noLib: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    jsx: ts.JsxEmit.Preserve,
  });
  const checker = program.getTypeChecker();
  const vocabularies = stringVocabularies(program.getSourceFiles());
  const names = new Map<string, string[]>();
  const declOf = (node: ts.Node): ts.Declaration | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  };
  // The top-level string constants of every file, so an imported one resolves without `noResolve`.
  const constants = new Map<string, Map<string, string>>();
  for (const sourceFile of program.getSourceFiles()) {
    const own = new Map<string, string>();
    for (const statement of sourceFile.statements)
      if (ts.isVariableStatement(statement))
        for (const decl of statement.declarationList.declarations)
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isStringLiteralLike(decl.initializer))
            own.set(decl.name.text, decl.initializer.text);
    constants.set(path.resolve(sourceFile.fileName), own);
  }
  /** A string constant's value: `const DELEGATED_PREFIX = "delegated."`, here or imported. */
  const constantText = (node: ts.Expression): string | undefined => {
    const decl = declOf(node);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isStringLiteralLike(decl.initializer))
      return decl.initializer.text;
    if (!decl || !ts.isImportSpecifier(decl)) return undefined;
    const from = decl.parent.parent.parent.moduleSpecifier;
    if (!ts.isStringLiteral(from) || !from.text.startsWith(".")) return undefined;
    const module = path.resolve(path.dirname(decl.getSourceFile().fileName), from.text);
    return constants.get(module)?.get((decl.propertyName ?? decl.name).text);
  };
  /** A template's fixed head, including leading string constants (`${DELEGATED_PREFIX}${engine}`). */
  const templateHead = (node: ts.TemplateExpression): string => {
    let head = node.head.text;
    for (const span of node.templateSpans) {
      const text = constantText(span.expression);
      if (text === undefined) break;
      head += text + span.literal.text;
    }
    return head;
  };
  const literals = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) return [`${templateHead(node)}*`];
    if (ts.isPropertyAccessExpression(node)) return [...vocabularyValues(vocabularies, node)];
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literals(node.expression);
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    return [];
  };
  for (const file of files) {
    const source = program.getSourceFile(file);
    assert.ok(source, file);
    const where = path.relative(SRC, file).split(path.sep).join("/");
    const addText = (name: string) => names.set(name, [...(names.get(name) ?? []), where]);
    const add = (node: ts.Expression) => {
      for (const name of literals(node)) addText(name);
    };
    // Local variables that hold an event name: `const type = data.event_type`, `{ event_type: type }`.
    const bound = new Set<ts.Declaration>();
    const isName = (node: ts.Expression): boolean => {
      const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
      if (ts.isPropertyAccessExpression(inner))
        return inner.name.text === "event_type" || inner.name.text === "eventType";
      if (ts.isIdentifier(inner)) {
        const decl = declOf(inner);
        return decl !== undefined && bound.has(decl);
      }
      return false;
    };
    const bind = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isName(node.initializer))
        bound.add(node);
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        (node.propertyName ?? node.name).getText(source) === "event_type"
      )
        bound.add(node);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        isName(node.right)
      ) {
        const decl = declOf(node.left);
        if (decl) bound.add(decl);
      }
      ts.forEachChild(node, bind);
    };
    bind(source);
    // Helpers whose parameter is an event name: named `event_type`, or compared with one.
    const carriers = new Map<ts.Node, number>();
    const carrier = (param: ts.Declaration | undefined) => {
      if (param && ts.isParameter(param) && ts.isFunctionLike(param.parent))
        carriers.set(param.parent, param.parent.parameters.indexOf(param));
    };
    const findCarriers = (node: ts.Node) => {
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "event_type") carrier(node);
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === "event_type" &&
        ts.isIdentifier(node.initializer)
      )
        carrier(declOf(node.initializer));
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        if (isName(node.left) && ts.isIdentifier(node.right)) carrier(declOf(node.right));
        if (isName(node.right) && ts.isIdentifier(node.left)) carrier(declOf(node.left));
      }
      ts.forEachChild(node, findCarriers);
    };
    findCarriers(source);
    const helperOf = (callee: ts.Expression): ts.Node | undefined => {
      const decl = declOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      return decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isFunctionLike(decl.initializer)
        ? decl.initializer
        : decl;
    };
    // The harness's shared writers, which the scan cannot follow into (it resolves no imports):
    // `loop/run-events.ts` `appendRun(ctx, threadId, "name", …)` and `loop/compaction-log.ts`
    // `appendCustom(ctx, threadId, "name", …)`, imported under any name, and the director run's
    // own `appendRun("name", …)` (`loop/director/loop-run.ts`, reached through the run object,
    // which `bindLoopRun` calls with the run as its first argument).
    const writerIndex = (callee: ts.Expression): number | undefined => {
      const id = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      if (!ts.isIdentifier(id)) return undefined;
      const decl = declOf(id);
      if (decl && ts.isImportSpecifier(decl)) {
        const from = decl.parent.parent.parent.moduleSpecifier;
        const imported = (decl.propertyName ?? decl.name).text;
        const shared = SHARED_WRITERS.some(
          ([writer, module]) => imported === writer && ts.isStringLiteral(from) && from.text.endsWith(module),
        );
        return shared ? 2 : undefined;
      }
      if (id.text !== "appendRun") return undefined;
      return ts.isPropertyAccessExpression(callee) || (decl !== undefined && ts.isBindingElement(decl)) ? 0 : undefined;
    };
    const collection = (node: ts.Expression): ts.Expression[] => {
      // `[...STARTS, ...PAUSES, "run_finished"]`: a spread brings its own collection's names.
      if (ts.isArrayLiteralExpression(node))
        return node.elements.flatMap((element) =>
          ts.isSpreadElement(element) ? collection(element.expression) : [element],
        );
      if (ts.isNewExpression(node) && node.arguments?.[0]) return collection(node.arguments[0]);
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
        return collection(node.expression);
      if (ts.isIdentifier(node)) {
        const decl = declOf(node);
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return collection(decl.initializer);
      }
      return [];
    };
    // `TABLE[name]`: a table looked up by an event name reads every name it is keyed by.
    const tableKeys = (node: ts.Expression): Array<ts.Expression | string> => {
      if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))
        return tableKeys(node.expression);
      if (ts.isIdentifier(node)) {
        const decl = declOf(node);
        return decl && ts.isVariableDeclaration(decl) && decl.initializer ? tableKeys(decl.initializer) : [];
      }
      if (!ts.isObjectLiteralExpression(node)) return [];
      return node.properties.flatMap((property): Array<ts.Expression | string> => {
        const name = property.name;
        if (name && ts.isComputedPropertyName(name)) return [name.expression];
        if (name && (ts.isStringLiteral(name) || ts.isIdentifier(name))) return [name.text];
        return [];
      });
    };
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "event_type") add(node.initializer);
      if (ts.isElementAccessExpression(node) && isName(node.argumentExpression))
        for (const key of tableKeys(node.expression)) {
          if (typeof key === "string") addText(key);
          else add(key);
        }
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        if (isName(node.left)) add(node.right);
        if (isName(node.right)) add(node.left);
      }
      if (ts.isSwitchStatement(node) && isName(node.expression))
        for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause)) add(clause.expression);
      if (ts.isCallExpression(node)) {
        const [first] = node.arguments;
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === "includes" || node.expression.name.text === "has") &&
          first &&
          isName(first)
        ) {
          for (const element of collection(node.expression.expression)) add(element);
        }
        // The shared readers, whichever file imports them: `customPayload(data, "name" | [names])`.
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ts.isIdentifier(node.expression)
            ? node.expression.text
            : "";
        const named = node.arguments[1];
        if (READERS.has(callee) && named) for (const element of [named, ...collection(named)]) add(element);
        if (WRITERS.has(callee) && first) add(first);
        const helper = helperOf(node.expression);
        const index = (helper ? carriers.get(helper) : undefined) ?? writerIndex(node.expression);
        if (index !== undefined && node.arguments[index]) add(node.arguments[index]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

test("contract: every custom event name the studio writes or reads is in CUSTOM_EVENT_TYPES, and every registered name is still used", async () => {
  const found = await eventNamesInSource();
  // A scan that found nothing would pass vacuously; the studio uses over a hundred names.
  assert.ok(found.size >= 100, `only ${found.size} names found — has the scan stopped matching?`);
  // One name from each kind of use: the harness seed, the core, a helper in the dev fixtures,
  // a switch in the Builds graph, a Set lookup in the activity feed, and the shared readers
  // named alone and in an array.
  const expected: Array<[string, string]> = [
    ["facet_lessons", "harness-seed/loop/facet-loop.ts"],
    ["game_archived", "main/studio-core.ts"],
    ["fixture_noise", "main/dev/fixtures.ts"],
    ["integration_ledger", "renderer/run-graph.ts"],
    ["skillopt_lessons_staged", "shared/studio-activity.ts"],
    ["skillopt_accepted", "renderer/chat-entries.ts"],
    ["coordinator_message_requeued", "renderer/chat-entries.ts"],
  ];
  for (const [name, file] of expected) assert.ok(found.get(name)?.includes(file), `${name} in ${file}`);
  const families = [...found.keys()].filter((name) => name.endsWith("*"));
  assert.deepEqual(families, [`${DELEGATED_PREFIX}*`], "a template event name outside the delegated family");
  const unknown = [...found]
    .filter(([name]) => !name.endsWith("*") && !isCustomEventType(name))
    .map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(unknown, [], "the code uses a custom event name the registry does not list");
  const stale = CUSTOM_EVENT_TYPES.filter((name) => !found.has(name));
  assert.deepEqual(stale, [], "the registry lists a name no code writes or reads");
});

test("the registry: each name once, and the delegated family by prefix", () => {
  assert.equal(new Set(CUSTOM_EVENT_TYPES).size, CUSTOM_EVENT_TYPES.length);
  assert.equal(isCustomEventType("run_started"), true);
  assert.equal(isCustomEventType("delegated.codex"), true);
  assert.equal(isCustomEventType("delegated."), false);
  assert.equal(isCustomEventType("run_invented"), false);
  assert.equal(isCustomEventType("toString"), false);
  assert.equal(isCustomEventType(7), false);
});

const custom = (event_type: string, payload?: unknown): CustomEventData => ({ type: "custom", event_type, payload });

test("customPayload hands back the payload of a named record and nothing for any other", () => {
  const payload = { runId: "run-1", action: "finish" };
  assert.equal(customPayload(custom("run_control", payload), "run_control"), payload);
  assert.equal(customPayload(custom("run_control", payload), "run_finished"), null);
  assert.equal(customPayload(custom("run_control", payload), ["run_finished", "run_control"]), payload);
  assert.equal(customPayload({ type: "messages" }, "run_control"), null);
  assert.equal(customPayload({ type: "custom", event_type: 7, payload }, "run_control"), null);
  const envelope: EventEnvelope = {
    id: "e1",
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    data: { type: "custom", event_type: "run_control", payload },
  };
  assert.equal(customEvent(envelope, "run_control"), payload);
});

test("a payload that is missing or is not an object reads as an empty one", () => {
  for (const payload of [undefined, null, "text", 7, true, ["run-1"]]) {
    assert.deepEqual(customPayload(custom("run_control", payload), "run_control"), {}, String(payload));
    assert.deepEqual(customRecord(custom("run_control", payload)), { event_type: "run_control", payload: {} });
  }
  assert.equal(customRecord({ type: "turn_started" }), null);
});

test("a delegated record carries the engine it came from", () => {
  const payload = { kind: "assistant", data: { parts: [] } };
  assert.deepEqual(delegatedPayload(custom("delegated.claude-code", payload)), { engineId: "claude-code", payload });
  assert.equal(delegatedPayload(custom("delegation_incomplete", payload)), null);
  assert.equal(customPayload(custom("delegated.codex", payload), `${DELEGATED_PREFIX}codex`), payload);
});

test("the chat reads records written without a payload instead of failing", () => {
  const names = [
    "plan_review",
    "interview_question",
    "run_started",
    "facet_iteration",
    "run_finished",
    "plugin_tool",
    "plugin_tool_started",
    "plugin_consent",
    "autopilot_plan_review",
    "asset_delivered",
    "delegated.codex",
    "coordinator_message_queued",
  ];
  const events: EventEnvelope[] = names.map((event_type, i) => ({
    id: `e${i}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    data: { type: "custom", event_type },
  }));
  const entries = toEntries(events);
  // An asset delivery that lists no files has nothing to show, so it adds no card.
  assert.equal(
    entries.some((entry) => entry.kind === "assets"),
    false,
  );
  assert.ok(entries.some((entry) => entry.kind === "morning"));
  assert.ok(entries.some((entry) => entry.kind === "action" && entry.action === "consent"));
});

// Never called: these lines are checked by the typecheck only.
function typecheckOnly(data: CustomEventData): void {
  const control = customPayload(data, "run_control");
  const action: string | undefined = control?.action;
  void action;
  // @ts-expect-error a name the map has no payload for
  customPayload(data, "run_invented");
  // @ts-expect-error a field the payload does not have
  void control?.victory;
  // @ts-expect-error every field is optional: a writer may leave it out
  const runId: string = customPayload(data, "run_finished")?.runId ?? null;
  void runId;
  // Several names: a field only some of them carry reads as possibly undefined.
  const plugin = customPayload(data, ["plugin_tool_started", "plugin_tool"]);
  const ok: boolean | undefined = plugin?.ok;
  void ok;
  const delegated = customPayload(data, "delegated.codex");
  const subtype: string | undefined = delegated?.data?.subtype;
  void subtype;
}
void typecheckOnly;
