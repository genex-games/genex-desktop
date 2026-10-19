/**
 * The closed JSON-schema dialect a game's `ask`, `judge` and `act` answers are held to, and the
 * readers that check a schema, check a value against one and turn a model's text into a value.
 *
 * It is genex.games' dialect exactly (genex-demo `apps/api/src/runtime-generation/validation.ts`:
 * `validateSchema`, `matches`, `validateJsonValue`, `validateOutput`, `canonical`), so a game that
 * passes here passes on the web: no `$ref`, `pattern`, `anyOf` or `format`; `additionalProperties:
 * false` on every object; depth at most 5, at most 32 properties, enums of 1–32 scalars; the two
 * annotations `description` (≤500) and `title` (≤100). `tests/conformance/game-ai-schema.test.ts`
 * holds the parity table. Browser-safe; nothing here throws.
 */
import { AI_MAX_OUTPUT_BYTES, isPlainRecord, readMember, utf8Bytes } from "./game-ai.ts";

/** The deepest a schema nests (genex.games `validateSchema`). */
export const AI_SCHEMA_MAX_DEPTH = 5;
/** The most properties one object schema lists. */
export const AI_SCHEMA_MAX_PROPERTIES = 32;
/** The most values one enum lists. */
export const AI_SCHEMA_MAX_ENUM = 32;
/** The longest property name. */
export const AI_SCHEMA_MAX_KEY_CHARS = 80;
/** The longest `description` annotation. */
export const AI_SCHEMA_MAX_DESCRIPTION = 500;
/** The longest `title` annotation. */
export const AI_SCHEMA_MAX_TITLE = 100;
/** The most items an array bound may name. */
export const AI_SCHEMA_MAX_ITEMS_BOUND = 65_536;
/** The most nodes an answer may hold (genex.games `RUNTIME_MAX_JSON_NODES`). */
export const AI_MAX_JSON_NODES = 32_768;
/** The deepest an answer may nest (genex.games `RUNTIME_MAX_JSON_DEPTH`). */
export const AI_MAX_JSON_DEPTH = 32;
/** The most items an array answer holds when its schema names no `maxItems` (`RUNTIME_MAX_JSON_ARRAY_ITEMS`). */
export const AI_MAX_JSON_ARRAY_ITEMS = 256;
/** The longest string a schema may bound, or an answer's string may reach when its schema names none. */
export const AI_SCHEMA_MAX_STRING = Math.max(65_536, AI_MAX_OUTPUT_BYTES);

/** The value types of the dialect. Wire values: never rename one. */
export const AiSchemaType = {
  Object: "object",
  Array: "array",
  String: "string",
  Number: "number",
  Integer: "integer",
  Boolean: "boolean",
  Null: "null",
} as const;
export type AiSchemaType = (typeof AiSchemaType)[keyof typeof AiSchemaType];

/** A schema of the dialect, once `checkSchema` passed it. */
export interface AiOutputSchema {
  type: AiSchemaType;
  description?: string;
  title?: string;
  properties?: Record<string, AiOutputSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: AiOutputSchema;
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** Why a schema is refused: a code the builder agent's feedback and the tests read. Never rename one. */
export const AiSchemaProblem = {
  NotObject: "not-object",
  TooDeep: "too-deep",
  UnknownType: "unknown-type",
  UnknownKeyword: "unknown-keyword",
  BadAnnotation: "bad-annotation",
  BadEnum: "bad-enum",
  ObjectShape: "object-shape",
  BadPropertyName: "bad-property-name",
  BadRequired: "bad-required",
  MisplacedKeyword: "misplaced-keyword",
  BadBound: "bad-bound",
} as const;
export type AiSchemaProblem = (typeof AiSchemaProblem)[keyof typeof AiSchemaProblem];

const KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "description",
  "title",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
const FORBIDDEN_PROPERTY_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** How a pair of bounds applies: to which types, and how large an integer bound may be. */
const BOUNDS = [
  { min: "minimum", max: "maximum", types: [AiSchemaType.Number, AiSchemaType.Integer], integerCap: null },
  { min: "minLength", max: "maxLength", types: [AiSchemaType.String], integerCap: AI_SCHEMA_MAX_STRING },
  { min: "minItems", max: "maxItems", types: [AiSchemaType.Array], integerCap: AI_SCHEMA_MAX_ITEMS_BOUND },
] as const;

/** One enum value of the dialect: a scalar, finite when a number. */
const isEnumValue = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function annotationProblem(s: Record<string, unknown>): AiSchemaProblem | null {
  const { description, title } = s;
  const badDescription =
    description !== undefined && (typeof description !== "string" || description.length > AI_SCHEMA_MAX_DESCRIPTION);
  const badTitle = title !== undefined && (typeof title !== "string" || title.length > AI_SCHEMA_MAX_TITLE);
  return badDescription || badTitle ? AiSchemaProblem.BadAnnotation : null;
}

function enumProblem(values: unknown): AiSchemaProblem | null {
  if (values === undefined) return null;
  const fits = Array.isArray(values) && values.length > 0 && values.length <= AI_SCHEMA_MAX_ENUM;
  return fits && values.every(isEnumValue) ? null : AiSchemaProblem.BadEnum;
}

function objectProblem(s: Record<string, unknown>, depth: number): AiSchemaProblem | null {
  const { properties, required } = s;
  if (!isPlainRecord(properties) || s.additionalProperties !== false) return AiSchemaProblem.ObjectShape;
  const entries = Object.entries(properties);
  if (entries.length > AI_SCHEMA_MAX_PROPERTIES) return AiSchemaProblem.ObjectShape;
  for (const [key, child] of entries) {
    if (key.length > AI_SCHEMA_MAX_KEY_CHARS || FORBIDDEN_PROPERTY_NAMES.has(key))
      return AiSchemaProblem.BadPropertyName;
    const problem = schemaProblem(child, depth + 1);
    if (problem) return problem;
  }
  if (required === undefined) return null;
  const known = Array.isArray(required) && required.every((k) => typeof k === "string" && Object.hasOwn(properties, k));
  return known ? null : AiSchemaProblem.BadRequired;
}

/** One bound's value is a finite number, and a whole one within its cap where the bound counts. */
function boundFits(value: unknown, integerCap: number | null): boolean {
  if (value === undefined) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return integerCap === null || (Number.isInteger(value) && value >= 0 && value <= integerCap);
}

/** Why one pair of bounds is refused on a schema of `type`, or null. */
function pairProblem(
  s: Record<string, unknown>,
  type: AiSchemaType,
  bound: (typeof BOUNDS)[number],
): AiSchemaProblem | null {
  const lo = s[bound.min];
  const hi = s[bound.max];
  if (lo === undefined && hi === undefined) return null;
  const types: readonly AiSchemaType[] = bound.types;
  if (!types.includes(type)) return AiSchemaProblem.MisplacedKeyword;
  if (!boundFits(lo, bound.integerCap) || !boundFits(hi, bound.integerCap)) return AiSchemaProblem.BadBound;
  return typeof lo === "number" && typeof hi === "number" && lo > hi ? AiSchemaProblem.BadBound : null;
}

function boundsProblem(s: Record<string, unknown>, type: AiSchemaType): AiSchemaProblem | null {
  for (const bound of BOUNDS) {
    const problem = pairProblem(s, type, bound);
    if (problem) return problem;
  }
  return null;
}

/** The keywords only one type takes, used on another. */
function placementProblem(s: Record<string, unknown>, type: AiSchemaType, depth: number): AiSchemaProblem | null {
  if (type === AiSchemaType.Object) return objectProblem(s, depth);
  const objectOnly = s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined;
  if (objectOnly) return AiSchemaProblem.MisplacedKeyword;
  if (type === AiSchemaType.Array) return schemaProblem(s.items, depth + 1);
  return s.items === undefined ? null : AiSchemaProblem.MisplacedKeyword;
}

/** Why `value` is not a schema of the dialect at `depth`, or null when it is one. */
function schemaProblem(value: unknown, depth: number): AiSchemaProblem | null {
  if (depth > AI_SCHEMA_MAX_DEPTH) return AiSchemaProblem.TooDeep;
  if (!isPlainRecord(value)) return AiSchemaProblem.NotObject;
  const type = readMember(AiSchemaType, value.type);
  if (!type) return AiSchemaProblem.UnknownType;
  if (Object.keys(value).some((key) => !KEYWORDS.has(key))) return AiSchemaProblem.UnknownKeyword;
  return (
    annotationProblem(value) ??
    enumProblem(value.enum) ??
    placementProblem(value, type, depth) ??
    boundsProblem(value, type)
  );
}

/** Why a game's schema is refused, as a code for the builder agent, or null when the dialect takes it. */
export function checkSchema(schema: unknown): AiSchemaProblem | null {
  return schemaProblem(schema, 0);
}

/** Whether a value is a schema of the dialect. */
export const isAiOutputSchema = (schema: unknown): schema is AiOutputSchema => checkSchema(schema) === null;

/** Code points, as genex.games counts a string's length (`[...value].length`). */
const codePoints = (text: string): number => [...text].length;

function matchesObject(value: unknown, schema: AiOutputSchema): boolean {
  if (!isPlainRecord(value)) return false;
  const properties = schema.properties ?? {};
  if (!(schema.required ?? []).every((key) => Object.hasOwn(value, key))) return false;
  return Object.entries(value).every(([key, child]) => {
    const inner = Object.hasOwn(properties, key) ? properties[key] : undefined;
    return inner !== undefined && matches(child, inner);
  });
}

function matchesArray(value: unknown, schema: AiOutputSchema): boolean {
  if (!Array.isArray(value)) return false;
  const items = schema.items;
  const within = value.length <= (schema.maxItems ?? AI_MAX_JSON_ARRAY_ITEMS) && value.length >= (schema.minItems ?? 0);
  return within && items !== undefined && value.every((item) => matches(item, items));
}

function matchesScalar(value: unknown, schema: AiOutputSchema): boolean {
  const min = schema.minimum ?? Number.NEGATIVE_INFINITY;
  const max = schema.maximum ?? Number.POSITIVE_INFINITY;
  switch (schema.type) {
    case AiSchemaType.Null:
      return value === null;
    case AiSchemaType.String:
      return (
        typeof value === "string" &&
        codePoints(value) >= (schema.minLength ?? 0) &&
        codePoints(value) <= (schema.maxLength ?? AI_SCHEMA_MAX_STRING)
      );
    case AiSchemaType.Number:
      return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
    case AiSchemaType.Integer:
      return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
    case AiSchemaType.Boolean:
      return typeof value === "boolean";
    default:
      return false;
  }
}

/** genex.games' `matches`: the value fits the schema (enum, type, bounds, exact object keys). */
function matches(value: unknown, schema: AiOutputSchema): boolean {
  if (schema.enum && !schema.enum.some((member) => member === value)) return false;
  if (schema.type === AiSchemaType.Object) return matchesObject(value, schema);
  if (schema.type === AiSchemaType.Array) return matchesArray(value, schema);
  return matchesScalar(value, schema);
}

/**
 * Whether an answer is plain JSON inside the node and depth bounds, every number finite and every
 * object plain (genex.games `validateJsonValue`). Iterative, so hostile nesting cannot overflow.
 */
export function isAnswerJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  for (let next = pending.pop(); next; next = pending.pop()) {
    nodes += 1;
    if (nodes > AI_MAX_JSON_NODES || next.depth > AI_MAX_JSON_DEPTH) return false;
    const item = next.value;
    const leaf = leafVerdict(item);
    if (leaf === false) return false;
    if (leaf === true) continue;
    if (typeof item !== "object" || item === null || seen.has(item)) return false;
    seen.add(item);
    for (const child of Object.values(item)) pending.push({ value: child, depth: next.depth + 1 });
  }
  return true;
}

/** A JSON leaf's verdict (true fine, false refused), or null for a container to walk into. */
function leafVerdict(item: unknown): boolean | null {
  if (item === null || typeof item === "string" || typeof item === "boolean") return true;
  if (typeof item === "number") return Number.isFinite(item);
  if (Array.isArray(item) || isPlainRecord(item)) return null;
  return false;
}

/** Whether a value is a valid answer for `schema` (null: a text answer). Never throws. */
export function validateValue(schema: unknown, value: unknown): boolean {
  if (!isAnswerJson(value)) return false;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || utf8Bytes(encoded) > AI_MAX_OUTPUT_BYTES) return false;
  if (schema === null) return typeof value === "string" && value.trim().length > 0;
  return isAiOutputSchema(schema) && matches(value, schema);
}

/** Why a model's text gave no usable answer: what the one repair is told. Never rename one. */
export const AiOutputProblem = {
  Empty: "empty",
  NotJson: "not-json",
  TooLarge: "too-large",
  Shape: "shape",
} as const;
export type AiOutputProblem = (typeof AiOutputProblem)[keyof typeof AiOutputProblem];

/** A model's text, read into an answer. */
export type AiParsedOutput = { ok: true; value: unknown } | { ok: false; problem: AiOutputProblem };

/** A whole-answer Markdown fence (```json … ```), which models add however they are asked. */
const FENCE = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?```$/;

/** The text inside one fence that wraps the whole answer, else the text itself, trimmed. */
export function withoutFence(text: string): string {
  const trimmed = text.trim();
  const fenced = FENCE.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * A model's text as an answer for `schema` (null: free text). A JSON answer loses one wrapping
 * fence and must parse, stay inside the answer bounds and fit the schema. Never throws.
 */
export function parseOutput(schema: unknown, text: string): AiParsedOutput {
  if (utf8Bytes(text) > AI_MAX_OUTPUT_BYTES * 2) return { ok: false, problem: AiOutputProblem.TooLarge };
  if (schema === null) {
    const said = text.trim();
    if (!said) return { ok: false, problem: AiOutputProblem.Empty };
    return validateValue(null, said) ? { ok: true, value: said } : { ok: false, problem: AiOutputProblem.TooLarge };
  }
  const body = withoutFence(text);
  if (!body) return { ok: false, problem: AiOutputProblem.Empty };
  const parsed = parseJson(body);
  if (!parsed.ok) return { ok: false, problem: AiOutputProblem.NotJson };
  if (!isAnswerJson(parsed.value)) return { ok: false, problem: AiOutputProblem.Shape };
  const encoded = JSON.stringify(parsed.value);
  if (utf8Bytes(encoded) > AI_MAX_OUTPUT_BYTES) return { ok: false, problem: AiOutputProblem.TooLarge };
  return validateValue(schema, parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, problem: AiOutputProblem.Shape };
}

/**
 * The canonical JSON of a value: keys sorted, `undefined` fields left out, so the same request
 * hashes the same whatever order its keys were written in. Like genex.games `canonical`, except that
 * keys sort by code unit rather than `localeCompare`, so a hash never depends on the machine's locale.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

// ── the worst answers a schema allows (`ai.replay` with `answers: "edge"`) ──────────────────

/** Which end of its bounds an edge answer takes. Wire values: never rename one. */
export const AiEdge = { Max: "max", Min: "min" } as const;
export type AiEdge = (typeof AiEdge)[keyof typeof AiEdge];

/** The longest string an edge answer writes, however long its schema lets it be. */
export const AI_EDGE_MAX_CHARS = 2000;
/** The most items an edge list holds, however many its schema allows. */
export const AI_EDGE_MAX_ITEMS = 64;
/** The character an edge string is written in: a wide one, the worst for a layout. */
const EDGE_CHAR = "W";

/** The edge a replay seed plays: odd seeds the largest answers, even seeds the smallest. */
export const edgeOfSeed = (seed: number): AiEdge => (Math.abs(seed) % 2 === 1 ? AiEdge.Max : AiEdge.Min);

/** A number's edge: its bound on that side, or the largest safe integer when it names none. */
function edgeNumber(schema: AiOutputSchema, edge: AiEdge): number {
  const integer = schema.type === AiSchemaType.Integer;
  if (edge === AiEdge.Max) {
    const max = schema.maximum ?? Number.MAX_SAFE_INTEGER;
    return integer ? Math.floor(max) : max;
  }
  const min = schema.minimum ?? -Number.MAX_SAFE_INTEGER;
  return integer ? Math.ceil(min) : min;
}

/** How long an edge string is, or how many items an edge list holds: its bound, within the edge's own cap. */
function edgeCount(min: number | undefined, max: number | undefined, cap: number, edge: AiEdge): number {
  if (edge === AiEdge.Min) return min ?? 0;
  return Math.max(min ?? 0, Math.min(max ?? cap, cap));
}

/** The edge of a schema the dialect admits. */
function edgeOf(schema: AiOutputSchema, edge: AiEdge): unknown {
  if (schema.enum) return edge === AiEdge.Max ? schema.enum.at(-1) : schema.enum[0];
  switch (schema.type) {
    case AiSchemaType.Object:
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, child]) => [key, edgeOf(child, edge)]),
      );
    case AiSchemaType.Array: {
      const items = schema.items;
      const count = edgeCount(schema.minItems, schema.maxItems, AI_EDGE_MAX_ITEMS, edge);
      return items ? Array.from({ length: count }, () => edgeOf(items, edge)) : [];
    }
    case AiSchemaType.String:
      return EDGE_CHAR.repeat(edgeCount(schema.minLength, schema.maxLength, AI_EDGE_MAX_CHARS, edge));
    case AiSchemaType.Number:
    case AiSchemaType.Integer:
      return edgeNumber(schema, edge);
    case AiSchemaType.Boolean:
      return edge === AiEdge.Max;
    default:
      return null;
  }
}

/**
 * The worst answer `schema` admits on one side of its bounds: on `max`, the largest numbers, the
 * longest strings, the fullest lists and every enum's last word; on `min`, the smallest, the
 * shortest, the emptiest and the first word. A string or a list its schema leaves unbounded stops at
 * `AI_EDGE_MAX_CHARS` or `AI_EDGE_MAX_ITEMS`. `undefined` for a schema the dialect refuses. Pure.
 */
export function edgeAnswer(schema: unknown, edge: AiEdge): unknown {
  return isAiOutputSchema(schema) ? edgeOf(schema, edge) : undefined;
}
