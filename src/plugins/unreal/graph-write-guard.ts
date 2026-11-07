/**
 * Genex's check around an agent's own Blueprint write through the editor bridge, Epic's
 * `BlueprintTools.write_graph_dsl`: Epic's writer can answer ok while the graph it built lost most
 * of the text (UE 5.8 kept two nodes of a function and the agent saved it). Before the write the
 * Genex editor helper's `check_graph` refuses a text too big for one write (big writes took minutes,
 * grew the editor by gigabytes and crashed it); after a write Unreal answered ok, it reads the graph
 * back and the call fails, naming what came back short, so the agent learns before it saves. The
 * rules are the helper's (`genex_loop/graph_write.py`), which also checks build scripts' writes and
 * the Loop's parts. An editor whose helper can't check (an older helper, a project whose build tools
 * didn't load) answers the write as Unreal does.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { helperAnswer } from "./editor-captures.ts";

/** Epic's Blueprint toolset and its writing tool, by their wire names. */
export const BLUEPRINT_TOOLSET = "editor_toolset.toolsets.blueprint.BlueprintTools";
export const WRITE_GRAPH_TOOL = "write_graph_dsl";
/** The Genex editor helper's check (in its build toolset). */
export const CHECK_GRAPH_TOOL = "check_graph";
/** The longest the check before a write may take: it only counts the text. */
export const CHECK_BEFORE_MS = 10 * SECOND_MS;
/** The longest the check after a write may take: it reads the graph back. */
export const CHECK_AFTER_MS = 30 * SECOND_MS;

/** One write an agent's call makes: the graph's path and the Blueprint text. */
export type GraphWrite = { graph: string; code: string };

type Part = { type: string; text?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A call's arguments as an object: Epic's schema takes an object, and some agents send its JSON text. */
function argumentsOf(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a call names Epic's write_graph_dsl, the way Unreal resolves it: case-insensitively, short or qualified. */
function namesWrite(toolset: unknown, tool: unknown): boolean {
  const name = String(tool ?? "").toLowerCase();
  const short = String(toolset ?? "").toLowerCase() === BLUEPRINT_TOOLSET.toLowerCase();
  return (short && name === WRITE_GRAPH_TOOL) || name === `${BLUEPRINT_TOOLSET}.${WRITE_GRAPH_TOOL}`.toLowerCase();
}

/** A graph argument's path: Epic takes `{refPath}`, and a plain path too. */
function graphPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return isRecord(value) && typeof value.refPath === "string" ? value.refPath : undefined;
}

/**
 * The graph and text a `call_tool` call's arguments write with Epic's write_graph_dsl, or undefined
 * for any other call (or one without a graph's path and a text, which Unreal itself refuses).
 */
export function graphWriteOf(callArguments: Record<string, unknown> | undefined): GraphWrite | undefined {
  if (!callArguments || !namesWrite(callArguments.toolset_name, callArguments.tool_name)) return undefined;
  const args = argumentsOf(callArguments.arguments);
  const graph = graphPath(args?.graph);
  const code = args?.code;
  return graph && typeof code === "string" ? { graph, code } : undefined;
}

/** The helper check's arguments: every one is passed, since Unreal's schema marks each required. */
export const checkArguments = (write: GraphWrite, written: boolean) => ({
  graph: write.graph,
  code: write.code,
  written,
});

/**
 * What the helper's check found wrong, in its words: before a write (`written` false) a text it
 * refused as too big (`refused`), after it a graph that came back short (`wrote` and `kept`).
 * Undefined when nothing is, and for any other error (a path it can't find, an editor failure): a
 * check that couldn't judge never fails the write.
 */
export function checkProblem(content: readonly Part[], written: boolean): string | undefined {
  const answer = helperAnswer([...content]);
  if (typeof answer?.error !== "string") return undefined;
  const judged = written
    ? typeof answer.wrote === "number" && typeof answer.kept === "number"
    : answer.refused === true;
  return judged ? answer.error : undefined;
}
