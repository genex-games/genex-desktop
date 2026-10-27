// @genex-ai/physics: the hand-written wrapper over the generated WASM glue (`./wasm/`), giving
// exactly the API of `index.d.ts` (contract 1.0; § numbers are CONTRACT.md's). The entries
// `index.js` (browsers, bundlers) and `node.js` (Node 24, loads itself) re-export it.
//
// - Errors are values (§1.5, §14): no method throws on any input. A contract error is
//   `{ ok: false, code, index?, detail }`; a read with no error channel returns its empty form.
// - Numbers become f32 here, as `Math.fround`, before they cross (§4.1), so the JSON text the core
//   reads names that f32 exactly. NaN and ±Infinity cross as ±1e39, which the core rounds to an
//   infinite f32 and refuses with `non-finite`, as it does a finite number too big for f32.
// - §11.3: if the instance traps (a WebAssembly.RuntimeError, or anything else thrown from inside
//   a WASM call) it is poisoned: every later call on every world answers `internal`, and its reads
//   their empty forms. `init()` then makes a new instance; worlds of the old one stay `internal`.
// - A `World` runs over a binding: the module's one WASM instance (`World.create`), or another wire
//   with the glue's exports, handed in through `bindWire` (internal: `@genex-ai/physics-native`'s
//   sidecar process). Both get exactly this file's encoding, budgets and result forms, and a wire
//   that throws is poisoned as a trapped instance is.
// - `createBinding()` gives a caller a WebAssembly instance of its own (a new glue from
//   `createGlue()`, instantiated from the module the package compiled once): its worlds live in
//   that instance alone, so a trap poisons that binding only, never the package's own instance or
//   another binding.
import { createGlue } from "./wasm/genex_physics_wasm.js";

/** The package's own glue: its one WebAssembly instance, made again after a trap. */
const glue = createGlue();

/** The error vocabulary (§14). */
export const PhysicsError = Object.freeze({
  InvalidKey: "invalid-key",
  DuplicateKey: "duplicate-key",
  UnknownKey: "unknown-key",
  NonFinite: "non-finite",
  OutOfRange: "out-of-range",
  BadShape: "bad-shape",
  DynamicMesh: "dynamic-mesh",
  WrongBodyType: "wrong-body-type",
  BadCommand: "bad-command",
  LimitBodies: "limit-bodies",
  LimitColliders: "limit-colliders",
  LimitHullVertices: "limit-hull-vertices",
  LimitTriangles: "limit-triangles",
  LimitJoints: "limit-joints",
  LimitCcd: "limit-ccd",
  LimitQueries: "limit-queries",
  LimitStatic: "limit-static",
  LimitMemory: "limit-memory",
  BadSnapshot: "bad-snapshot",
  BuildMismatch: "build-mismatch",
  ContractMismatch: "contract-mismatch",
  Internal: "internal",
});

/** The `apply` modes (§7.1). */
const ApplyMode = Object.freeze({ Atomic: "atomic", Each: "each" });

/** Nesting deeper than any contract shape (a body's collider's shape's points is 5). */
const MAX_DEPTH = 32;
/**
 * The per-call input budget (§11.1, §11.3). The binding parses a call's JSON text whole before the
 * core sees it, at a cost in linear memory no world is charged for and that WebAssembly never gives
 * back, so an input over its budget is refused here with `out-of-range` before it crosses. A call
 * may carry `BASE_VALUES` JSON values (every number, string, boolean, null, array and object counts
 * one) and `BASE_CHARS` UTF-16 units of text, plus, for a world, one heightfield or trimesh as large
 * as its own limits admit: `geometryValues(limits)` more values of at most `NUMBER_CHARS_MAX`
 * characters each. At the default limits that is 1,572,864 values and 32 Mi characters.
 */
const BASE_VALUES = 524_288;
const BASE_CHARS = 8 * 1024 * 1024;
/** The longest text a number crosses as (`-1.1754943508222875e-38`) with its comma. */
const NUMBER_CHARS_MAX = 24;
/** The JSON values one trimesh triangle can take: an index triple and up to three vertices of its own. */
const TRIMESH_VALUES_PER_TRIANGLE = 16;
/** Any character outside ASCII, and what each such string's characters count toward the budget. */
const NON_ASCII = /[^\u0000-\u007f]/;
const NON_ASCII_WEIGHT = 3;
/** The most commands one `apply` carries; a longer batch is refused whole with `out-of-range`. */
const BATCH_COMMANDS_MAX = 16_384;
/** The most entries one bulk call (`importStates`, `queryMany`; §19) carries, as an `apply` batch. */
const BULK_ITEMS_MAX = BATCH_COMMANDS_MAX;
/** The largest snapshot `restore` hands over: above any world the 4x memory ceiling admits. */
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
/** §17.7's caps on the static world, refused here with the core's code before flattening. */
const STATIC_BOXES_MAX = 4096;
const STATIC_RAMPS_MAX = 512;
/** One more than a static row's longest valid length (a ramp's 9): longer rows are the core's to refuse. */
const STATIC_ROW_PASS = 10;
/**
 * A key longer than 64 UTF-16 units is over 64 bytes and refused `invalid-key` whatever it holds,
 * so a read hands over at most this much of it: the core's answer is the same and a huge string
 * never crosses.
 */
const KEY_PASS_CHARS = 65;
/** What NaN and ±Infinity cross as: finite as f64, infinite as f32 (§4.1). */
const NOT_FINITE_TEXT = "1e39";
const NEGATIVE_INFINITE_TEXT = "-1e39";
/** `-0` as JSON text the core reads as an f64 `-0.0` (`-0` alone reads as the integer 0). */
const NEGATIVE_ZERO_TEXT = "-0.0";
/** `bodies()` with no `changedSinceTick`. */
const NO_TICK = -1;
/** The numbers per body of `exportChanged` with the sleep timer (contract 1.1 draft, §20.3). */
const EXPORT_STRIDE_REST = 15;
/** The numbers per body of an `importWire` row (§20.2). */
const WIRE_STRIDE = 15;

/**
 * Whether options ask for the sleep timer: `{ rest: true }` as an own data property (a getter is
 * never called); any other shape, or a Proxy whose trap throws, is no.
 */
function restOption(options) {
  try {
    if (options === null || typeof options !== "object" || Array.isArray(options)) return false;
    const descriptor = Reflect.getOwnPropertyDescriptor(options, "rest");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === true;
  } catch {
    return false;
  }
}

/** The numbers per body of `exportChanged` (§9.1). */
const EXPORT_STRIDE = 14;

const Detail = Object.freeze({
  NotReady: "init() has not finished: await init() first (§15)",
  BindingPoisoned:
    "this binding's WebAssembly instance trapped and is unusable (§11.3): make a new binding and new worlds",
  Instantiate: "the WebAssembly module could not be instantiated for a new binding",
  Poisoned: "the WebAssembly instance trapped and is unusable (§11.3): await init() for a new one and make new worlds",
  Stale: "this world belongs to an instance that trapped (§11.3)",
  NotWorld: "not a World",
  BadTick: "a tick is { batches?: Command[][], step?: boolean, exportSince?: number, queries?: Query[] }",
  Freed: "this world was freed",
  TooLarge: "the input is over this call's budget (values and characters of JSON; see README)",
  BigBatch: "the batch holds more than 16,384 commands",
  BigBulk: "the call carries more than 16,384 entries",
  BadKeys: "keys is an array of strings",
  BadData: "data is a Float32Array or an array of numbers, 14 per key",
  BadQueries: "queries is an array of queries",
  TooDeep: "the input nests deeper than any contract shape",
  BigInt: "a BigInt is not a number",
  Unreadable: "the input could not be read",
  NotSnapshot: "a snapshot is a Uint8Array",
  BigSnapshot: "the snapshot is larger than any world this build writes",
  BadMode: 'mode is "atomic" or "each"',
  BadOptions: "setPose options are an object of resetVelocity and wake",
  BadStatic: "a static world is { boxes: number[][], ramps: number[][] }",
  StaticCaps: "more than 4096 boxes or 512 ramps",
});

/**
 * A binding: the wire its worlds' calls cross (the glue's exports, or a wire of the same names)
 * and its health. `detail` names its failures. A binding whose wire threw is poisoned for good,
 * until (WASM only) `init()` makes a new instance and bumps `generation`.
 */
function newBinding(wire, detail) {
  return { wire, ready: false, generation: 0, poisoned: false, buildId: "", detail };
}

/** The module's own binding: the one WASM instance, its generation bumped per instance. */
const instance = newBinding(glue, { poisoned: Detail.Poisoned, stale: Detail.Stale });

/** Each `createBinding()` handle's binding (for this package's tests). */
const bindings = new WeakMap();

/** A contract error as a value. */
function failure(code, detail) {
  return { ok: false, code, detail };
}

/** Why calls on `binding` cannot run now, or `undefined` when they can. */
function unavailable(binding) {
  if (!binding.ready) return failure(PhysicsError.Internal, Detail.NotReady);
  if (binding.poisoned) return failure(PhysicsError.Internal, binding.detail.poisoned);
  return undefined;
}

/** Runs `fn` against `binding`'s wire; anything thrown inside it poisons the binding (§11.3). */
function guarded(binding, fallback, fn) {
  if (unavailable(binding) !== undefined) return fallback();
  try {
    return fn(binding.wire);
  } catch {
    binding.poisoned = true;
    binding.detail.onPoison?.();
    return fallback();
  }
}

/** Takes the glue's current instance as the live one. */
function adopt() {
  instance.ready = true;
  instance.generation += 1;
  instance.poisoned = false;
  instance.buildId = glue.build_id();
}

/**
 * A new instance after a trap (§11.3): the glue's own reset (wasm-bindgen's
 * `--experimental-reset-state-function`) instantiates the module it loaded again, with a fresh
 * linear memory, synchronously.
 */
function renew() {
  glue.__wbg_reset_state();
  adopt();
}

/**
 * Loads the module synchronously from `source` (a WebAssembly.Module or its bytes). `node.js`
 * calls it on import; a later call is the same as `init()`.
 */
export function loadSync(source) {
  if (instance.ready) {
    if (instance.poisoned) renew();
    return;
  }
  const module = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
  glue.initSync({ module });
  adopt();
}

/** Loads the WASM module once; later calls resolve at once, or make a new instance after a trap (§15, §11.3). */
export async function init(input) {
  if (instance.ready) {
    if (instance.poisoned) renew();
    return;
  }
  const source = input?.module;
  if (source !== undefined) {
    loadSync(source);
    return;
  }
  await glue.default();
  adopt();
}

/**
 * A binding of its own (§11.3, additive to 1.0): a new WebAssembly instance, with its own linear
 * memory, of the module the package already compiled (`init()` or the Node entry's load), so it costs
 * an instantiation and no compile. `binding.World.create(desc)` makes worlds in that instance alone,
 * each this package's own `World`. If the instance traps, the binding is poisoned for good: its
 * worlds answer `internal`, their reads give their empty forms, and it makes no more worlds; the
 * package's own instance and every other binding never notice. Make a new binding instead.
 * Never throws: `{ ok: true, binding }`, or `internal` before the package loaded or when the
 * instance cannot be made.
 */
export function createBinding() {
  const module = instance.ready ? glue.__genex_module() : undefined;
  if (module === undefined) return failure(PhysicsError.Internal, Detail.NotReady);
  const binding = newBinding(undefined, { poisoned: Detail.BindingPoisoned, stale: Detail.Stale });
  try {
    binding.wire = createGlue();
    binding.wire.initSync({ module });
    binding.buildId = binding.wire.build_id();
  } catch {
    return failure(PhysicsError.Internal, Detail.Instantiate);
  }
  binding.ready = true;
  binding.generation = 1;
  const handle = Object.freeze({
    buildId: () => binding.buildId,
    poisoned: () => binding.poisoned,
    PhysicsError,
    World: Object.freeze({ create: (desc) => createWorld(binding, desc) }),
  });
  bindings.set(handle, binding);
  return { ok: true, binding: handle };
}

/** This build's identity (§2). */
export function buildId() {
  return instance.buildId;
}

// ---------------------------------------------------------------------------------------------
// Encoding what crosses.

/** Thrown inside the encoder only; `encode` turns it into a failure value. */
class Refusal {
  constructor(code, detail) {
    this.code = code;
    this.detail = detail;
  }
}

/** The values of one heightfield or trimesh as large as `limits` admit. */
function geometryValues(limits) {
  return Math.max(limits.heightfieldSamples, TRIMESH_VALUES_PER_TRIANGLE * limits.triangles);
}

/** What one call may carry (see `BASE_VALUES`): the base budget, or a world's from its resolved limits. */
function inputBudget(limits) {
  const geometry = limits === undefined ? 0 : geometryValues(limits);
  return { values: BASE_VALUES + geometry, chars: BASE_CHARS + geometry * NUMBER_CHARS_MAX };
}

function numberText(value) {
  const rounded = Math.fround(value);
  if (Number.isNaN(rounded) || rounded === Number.POSITIVE_INFINITY) return NOT_FINITE_TEXT;
  if (rounded === Number.NEGATIVE_INFINITY) return NEGATIVE_INFINITE_TEXT;
  if (Object.is(rounded, -0)) return NEGATIVE_ZERO_TEXT;
  return String(rounded);
}

/** Whether a value is left out of an object, as JSON.stringify leaves it out. */
function omitted(value) {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Appends `text` to the output, refusing once the text passes the call's budget. */
function emit(out, text) {
  out.size += text.length;
  if (out.size > out.budget.chars) throw new Refusal(PhysicsError.OutOfRange, Detail.TooLarge);
  out.parts.push(text);
}

/**
 * A string as JSON text, refused before it is escaped when it alone passes the budget. Text that is
 * not all ASCII counts `NON_ASCII_WEIGHT` per character: the glue reserves three bytes of linear
 * memory for each UTF-16 unit of such text when it crosses.
 */
function stringText(value, out) {
  const weight = NON_ASCII.test(value) ? NON_ASCII_WEIGHT : 1;
  if (out.size + value.length * weight > out.budget.chars) {
    throw new Refusal(PhysicsError.OutOfRange, Detail.TooLarge);
  }
  const text = JSON.stringify(value);
  out.size += text.length * (weight - 1);
  return text;
}

/** Writes `value` as JSON into `out`, every number as its f32 (§4.1), counting it against the budget. */
function write(value, out, depth) {
  if (depth > MAX_DEPTH) throw new Refusal(PhysicsError.BadCommand, Detail.TooDeep);
  out.values += 1;
  if (out.values > out.budget.values) throw new Refusal(PhysicsError.OutOfRange, Detail.TooLarge);
  const text = scalarText(value, out);
  if (text !== undefined) {
    emit(out, text);
    return;
  }
  if (Array.isArray(value)) {
    writeArray(value, out, depth);
    return;
  }
  writeObject(value, out, depth);
}

/** A scalar's JSON text, or `undefined` for an array or object. */
function scalarText(value, out) {
  if (value === null || omitted(value)) return "null";
  switch (typeof value) {
    case "number":
      return numberText(value);
    case "string":
      return stringText(value, out);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new Refusal(PhysicsError.BadCommand, Detail.BigInt);
    default:
      return undefined;
  }
}

function writeArray(items, out, depth) {
  emit(out, "[");
  const length = items.length;
  for (let index = 0; index < length; index += 1) {
    if (index > 0) emit(out, ",");
    write(items[index], out, depth + 1);
  }
  emit(out, "]");
}

function writeObject(object, out, depth) {
  emit(out, "{");
  let first = true;
  for (const name of Object.keys(object)) {
    const item = object[name];
    if (omitted(item)) continue;
    if (!first) emit(out, ",");
    emit(out, stringText(name, out));
    emit(out, ":");
    first = false;
    write(item, out, depth + 1);
  }
  emit(out, "}");
}

/**
 * `value` as JSON text with f32 numbers, or a failure value for one that cannot cross: over
 * `budget` (`inputBudget`) it is `out-of-range`; anything thrown while reading it (a getter, a
 * Proxy trap, a revoked Proxy) is `bad-command`. Nothing of `value` is read outside this function.
 */
function encode(value, budget) {
  const out = { parts: [], size: 0, values: 0, budget };
  try {
    write(value, out, 0);
    return { text: out.parts.join(""), size: out.size, values: out.values };
  } catch (error) {
    if (error instanceof Refusal) return failure(error.code, error.detail);
    if (error instanceof RangeError) return failure(PhysicsError.OutOfRange, Detail.TooLarge);
    return failure(PhysicsError.BadCommand, Detail.Unreadable);
  }
}

/** A batch's command count when it is over `BATCH_COMMANDS_MAX`, read without running its code. */
function batchTooLong(commands) {
  try {
    return Array.isArray(commands) && commands.length > BATCH_COMMANDS_MAX;
  } catch {
    return false;
  }
}

/**
 * The static world's flat form (§6.5), every value as given (§17.7 checks float32s exactly). Each
 * field and element is read once; anything thrown while reading (a getter, a Proxy) is `bad-command`.
 */
function flattenStatic(world) {
  try {
    return flattenStaticFields(world);
  } catch {
    return failure(PhysicsError.BadCommand, Detail.BadStatic);
  }
}

function flattenStaticFields(world) {
  if (world === null || typeof world !== "object") return failure(PhysicsError.BadCommand, Detail.BadStatic);
  if (Object.keys(world).some((name) => name !== "boxes" && name !== "ramps")) {
    return failure(PhysicsError.BadCommand, Detail.BadStatic);
  }
  const { boxes, ramps } = world;
  if (!Array.isArray(boxes) || !Array.isArray(ramps)) return failure(PhysicsError.BadCommand, Detail.BadStatic);
  if (boxes.length > STATIC_BOXES_MAX || ramps.length > STATIC_RAMPS_MAX) {
    return failure(PhysicsError.OutOfRange, Detail.StaticCaps);
  }
  const flatBoxes = flattenRows(boxes);
  const flatRamps = flattenRows(ramps);
  if (flatBoxes === undefined || flatRamps === undefined) return failure(PhysicsError.BadCommand, Detail.BadStatic);
  return { boxes: flatBoxes, ramps: flatRamps };
}

/**
 * Rows of numbers as lengths and values; `undefined` when a row is not an array of numbers. A row
 * longer than `STATIC_ROW_PASS` hands over only its first values (the core refuses it by length).
 */
function flattenRows(rows) {
  const count = rows.length;
  const lengths = new Uint32Array(count);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) return undefined;
    const length = row.length;
    for (let at = 0; at < length; at += 1) {
      const value = row[at];
      if (typeof value !== "number") return undefined;
      if (at < STATIC_ROW_PASS) values.push(value);
    }
    lengths[index] = Math.min(length, STATIC_ROW_PASS);
  }
  return { lengths, values: Float64Array.from(values) };
}

/** `setPose`'s command, or a failure for options that are not a plain object of its own fields. */
function setPoseCommand(key, pose, options) {
  if (options === undefined) return { command: { setPose: { key, pose } } };
  try {
    const optionsOk = options !== null && typeof options === "object" && !Array.isArray(options);
    if (!optionsOk || Object.hasOwn(options, "key") || Object.hasOwn(options, "pose")) {
      return { refused: failure(PhysicsError.BadCommand, Detail.BadOptions) };
    }
    return { command: { setPose: { ...options, key, pose } } };
  } catch {
    return { refused: failure(PhysicsError.BadCommand, Detail.BadOptions) };
  }
}

/** The %TypedArray% accessors, called on a value to read its internal slots: no getter, own property or Proxy trap of it runs. */
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag).get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer").get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset").get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength").get;

/**
 * A snapshot's bytes as a plain view of the caller's buffer, read from the Uint8Array's internal
 * slots only, or a failure: what crosses is never an object the caller can make throw.
 */
function snapshotBytes(bytes) {
  try {
    if (typedArrayName.call(bytes) !== "Uint8Array")
      return { refused: failure(PhysicsError.BadSnapshot, Detail.NotSnapshot) };
    const length = typedArrayLength.call(bytes);
    if (length > MAX_SNAPSHOT_BYTES) return { refused: failure(PhysicsError.BadSnapshot, Detail.BigSnapshot) };
    return { view: new Uint8Array(typedArrayBuffer.call(bytes), typedArrayOffset.call(bytes), length) };
  } catch {
    return { refused: failure(PhysicsError.BadSnapshot, Detail.NotSnapshot) };
  }
}

/**
 * `importStates`' arguments (§19.1) as they cross: the keys, each cut as a read cuts one, and 14
 * numbers per key as a Float32Array, or a failure for a call of the wrong shape (`bad-command`, or
 * `out-of-range` past `BULK_ITEMS_MAX` keys). Anything thrown while reading (a getter, a Proxy) is
 * `bad-command`.
 */
function bulkImport(keys, data, stride = EXPORT_STRIDE) {
  try {
    return bulkImportFields(keys, data, stride);
  } catch {
    return { refused: failure(PhysicsError.BadCommand, Detail.Unreadable) };
  }
}

function bulkImportFields(keys, data, stride) {
  if (!Array.isArray(keys)) return { refused: failure(PhysicsError.BadCommand, Detail.BadKeys) };
  const count = keys.length;
  if (count > BULK_ITEMS_MAX) return { refused: failure(PhysicsError.OutOfRange, Detail.BigBulk) };
  const passed = [];
  for (let index = 0; index < count; index += 1) {
    const key = passedKey(keys[index]);
    if (key === undefined) return { refused: failure(PhysicsError.BadCommand, Detail.BadKeys) };
    passed.push(key);
  }
  const numbers = flatNumbers(data, count * stride);
  if (numbers === undefined) return { refused: failure(PhysicsError.BadCommand, Detail.BadData) };
  return { keys: passed, data: numbers };
}

/** `data` as a Float32Array of exactly `length` numbers, or `undefined` for any other shape. */
function flatNumbers(data, length) {
  if (Array.isArray(data)) return numberArray(data, length);
  return float32View(data, length);
}

/**
 * A Float32Array's numbers as a plain view of the caller's buffer, read from its internal slots
 * only (no getter, own property or Proxy trap of it runs), so the values cross bit for bit.
 */
function float32View(data, length) {
  if (typedArrayName.call(data) !== "Float32Array") return undefined;
  if (typedArrayLength.call(data) !== length * Float32Array.BYTES_PER_ELEMENT) return undefined;
  return new Float32Array(typedArrayBuffer.call(data), typedArrayOffset.call(data), length);
}

/** An array of numbers as f32s, as `Math.fround` rounds them (§4.1); NaN and ±Infinity stay so for the core to refuse. */
function numberArray(data, length) {
  if (data.length !== length) return undefined;
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = data[index];
    if (typeof value !== "number") return undefined;
    out[index] = value;
  }
  return out;
}

/**
 * `queryMany`'s queries (§19.2), each read once, or a failure for a call that is not an array
 * (`bad-command`, also for one that throws while read) or longer than `BULK_ITEMS_MAX`.
 */
function queryList(queries) {
  try {
    if (!Array.isArray(queries)) return { refused: failure(PhysicsError.BadCommand, Detail.BadQueries) };
    const count = queries.length;
    if (count > BULK_ITEMS_MAX) return { refused: failure(PhysicsError.OutOfRange, Detail.BigBulk) };
    const items = [];
    for (let index = 0; index < count; index += 1) items.push(queries[index]);
    return { items };
  } catch {
    return { refused: failure(PhysicsError.BadCommand, Detail.Unreadable) };
  }
}

/**
 * Each query encoded as `query()` encodes it alone, so an item that cannot cross keeps that refusal
 * as its own value; the rest cross as one text, which must fit the call's budget together, or the
 * call is one `out-of-range`. It stops at the first item that passes that budget.
 */
function encodeEach(items, budget) {
  const encoded = [];
  const texts = [];
  let size = 0;
  let values = 0;
  for (const item of items) {
    const one = encode(item, budget);
    encoded.push(one);
    if (one.text === undefined) continue;
    size += one.size + 1;
    values += one.values;
    if (size > budget.chars || values > budget.values) {
      return { refused: failure(PhysicsError.OutOfRange, Detail.TooLarge) };
    }
    texts.push(one.text);
  }
  return { encoded, text: `[${texts.join(",")}]` };
}

/** Every item's result in order: its own refusal where it could not cross, else the module's next answer. */
function mergeAnswers(encoded, answers) {
  let next = 0;
  return encoded.map((one) => {
    if (one.text === undefined) return one;
    next += 1;
    return answers[next - 1];
  });
}

/** A key a read hands over: a string cut to at most `KEY_PASS_CHARS`, or `undefined` for a non-string. */
function passedKey(key) {
  if (typeof key !== "string") return undefined;
  return key.length > KEY_PASS_CHARS ? key.slice(0, KEY_PASS_CHARS) : key;
}

function isWholeTick(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------------------------
// Worlds.

const constructing = Symbol("World.create");
const emptyStats = () => ({
  tick: 0,
  bodies: 0,
  awake: 0,
  colliders: 0,
  joints: 0,
  contactPairs: 0,
  queriesThisStep: 0,
  stepMs: 0,
  memoryBytes: 0,
});
const emptyExport = () => ({ keys: [], data: new Float32Array(0) });
const ids = new WeakMap();

/** Frees a world its owner dropped without `free()`, when its binding is still the live one. */
const finalizer = new FinalizationRegistry(({ binding, id, generation }) => {
  if (generation !== binding.generation) return;
  guarded(
    binding,
    () => false,
    (wire) => wire.world_free(id),
  );
});

/** Makes a world on `binding` from `desc` (§4); a failure creates nothing. */
function createWorld(binding, desc) {
  const refused = unavailable(binding);
  if (refused !== undefined) return refused;
  const encoded = encode(desc, inputBudget(undefined));
  if (encoded.text === undefined) return encoded;
  return guarded(
    binding,
    () => failure(PhysicsError.Internal, binding.detail.poisoned),
    (wire) => {
      const made = JSON.parse(wire.world_create(encoded.text));
      if (!made.ok) return made;
      const resolved = JSON.parse(wire.world_desc(made.id));
      return { ok: true, world: new World(constructing, binding, made.id, resolved) };
    },
  );
}

/** `tickWorld`'s body, bound to the class's private members in its static block. */
let tickOf;

/** One physics world (§15). Make it with `World.create`; release it with `free()`. */
export class World {
  #binding;
  #id;
  #generation;
  #freed = false;
  #desc;

  static {
    tickOf = (world, input) => {
      if (!(#id in Object(world))) return failure(PhysicsError.BadCommand, Detail.NotWorld);
      return world.#tick(input);
    };
  }

  constructor(token, binding, id, desc) {
    if (token !== constructing) throw new TypeError("use World.create(desc)");
    this.#binding = binding;
    this.#id = id;
    this.#generation = binding.generation;
    this.#desc = desc;
    ids.set(this, id);
    finalizer.register(this, { binding, id, generation: this.#generation }, this);
  }

  /** Validates `desc` and makes a world (§4); a failure creates nothing. */
  static create(desc) {
    return createWorld(instance, desc);
  }

  /** Why this world cannot run a call, or `undefined`. */
  #unusable() {
    if (this.#freed) return failure(PhysicsError.Internal, Detail.Freed);
    const refused = unavailable(this.#binding);
    if (refused !== undefined) return refused;
    if (this.#generation !== this.#binding.generation) {
      return failure(PhysicsError.Internal, this.#binding.detail.stale);
    }
    return undefined;
  }

  /** A call with a result: `internal` when unusable or if the wire fails in it. */
  #result(fn) {
    const refused = this.#unusable();
    if (refused !== undefined) return refused;
    return guarded(
      this.#binding,
      () => failure(PhysicsError.Internal, this.#binding.detail.poisoned),
      (wire) => fn(wire, this.#id),
    );
  }

  /** A read with no error channel: `empty()` when unusable or if the wire fails in it. */
  #read(empty, fn) {
    if (this.#unusable() !== undefined) return empty();
    return guarded(this.#binding, empty, (wire) => fn(wire, this.#id));
  }

  /** A call whose JSON text result is returned parsed. */
  #json(fn) {
    return this.#result((wasm, id) => JSON.parse(fn(wasm, id)));
  }

  /** What one call on this world may carry (`inputBudget`), from its resolved limits. */
  #budget() {
    return inputBudget(this.#desc.limits);
  }

  /** One command in its JSON form (§7.3). */
  #command(command) {
    const encoded = encode(command, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_command(id, encoded.text));
  }

  /** One query in its JSON form (§13). */
  #query(query) {
    const encoded = encode(query, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_query(id, encoded.text));
  }

  /** `internal` when this world failed or cannot run calls, else `{ ok: true }` (§11.3). */
  check() {
    return this.#json((wasm, id) => wasm.world_check(id));
  }

  /** The resolved description, every default filled (§4); readable on a failed world too. */
  desc() {
    return structuredClone(this.#desc);
  }

  /** The tick counter: 0 until the first step. */
  get tick() {
    return this.#read(
      () => 0,
      (wasm, id) => wasm.world_tick(id),
    );
  }

  addStaticWorld(world) {
    const flat = flattenStatic(world);
    if (flat.boxes === undefined) return flat;
    const { boxes, ramps } = flat;
    return this.#json((wasm, id) =>
      wasm.world_add_static(id, boxes.lengths, boxes.values, ramps.lengths, ramps.values),
    );
  }

  spawn(desc) {
    return this.#command({ spawn: desc });
  }

  remove(key) {
    return this.#command({ remove: { key } });
  }

  addJoint(desc) {
    return this.#command({ addJoint: desc });
  }

  removeJoint(key) {
    return this.#command({ removeJoint: { key } });
  }

  impulse(key, j, at) {
    return this.#command({ impulse: { key, j, at } });
  }

  setVelocity(key, linvel, angvel) {
    return this.#command({ setVelocity: { key, linvel, angvel } });
  }

  setPose(key, pose, options) {
    const { command, refused } = setPoseCommand(key, pose, options);
    if (refused !== undefined) return refused;
    return this.#command(command);
  }

  setNextKinematicPose(key, pose) {
    return this.#command({ setNextKinematicPose: { key, pose } });
  }

  areaPush(center, radius, strength, falloff, groups) {
    return this.#command({ areaPush: { center, radius, strength, falloff, groups } });
  }

  setMotor(jointKey, motor) {
    return this.#command({ setMotor: { key: jointKey, motor } });
  }

  wake(key) {
    return this.#command({ wake: { key } });
  }

  sleep(key) {
    return this.#command({ sleep: { key } });
  }

  /**
   * Applies commands in order (§7.1): `"atomic"` all or none, `"each"` one result per command. A
   * failure of the whole batch (not a list, over the budget or `BATCH_COMMANDS_MAX`, `internal`) is
   * one failure value in either mode.
   */
  apply(commands, mode) {
    if (mode !== ApplyMode.Atomic && mode !== ApplyMode.Each) return failure(PhysicsError.BadCommand, Detail.BadMode);
    if (batchTooLong(commands)) return failure(PhysicsError.OutOfRange, Detail.BigBatch);
    const encoded = encode(commands, this.#budget());
    if (encoded.text === undefined) return encoded;
    const result = this.#json((wasm, id) => wasm.world_apply(id, encoded.text, mode === ApplyMode.Atomic));
    if (mode === ApplyMode.Each && result.ok) return result.results;
    return result;
  }

  /** Advances `dt` in `substeps` inner steps (§8); records its wall time for `stats().stepMs` (§11.4). */
  step() {
    return this.#result((wasm, id) => {
      const start = performance.now();
      const result = JSON.parse(wasm.world_step(id));
      if (result.ok) wasm.world_record_step_ms(id, performance.now() - start);
      return result;
    });
  }

  body(key) {
    const passed = passedKey(key);
    if (passed === undefined) return null;
    return this.#read(
      () => null,
      (wasm, id) => JSON.parse(wasm.world_body(id, passed)),
    );
  }

  bodies(filter) {
    const read = bodyFilter(filter);
    if (read === undefined) return [];
    const kinds = read.kinds === undefined ? undefined : encode(read.kinds, this.#budget()).text;
    if (read.kinds !== undefined && kinds === undefined) return [];
    return this.#read(
      () => [],
      (wasm, id) => JSON.parse(wasm.world_bodies(id, kinds, read.awakeOnly, read.since)),
    );
  }

  /**
   * The bodies changed after `sinceTick`, flat (§9.1). With `{ rest: true }` (contract 1.1 draft,
   * §20.3) each body has a 15th number, its sleep timer, and every awake body is listed besides
   * the changed ones. Options of any other shape read as none.
   */
  exportChanged(sinceTick, options) {
    if (!isWholeTick(sinceTick)) return emptyExport();
    const rest = restOption(options);
    const stride = rest ? EXPORT_STRIDE_REST : EXPORT_STRIDE;
    return this.#read(emptyExport, (wasm, id) => {
      const listed = rest ? wasm.world_export_changed_rest(id, sinceTick) : wasm.world_export_changed(id, sinceTick);
      const keys = JSON.parse(listed);
      const data = wasm.take_changed_data();
      if (data.length !== keys.length * stride) return emptyExport();
      return { keys, data };
    });
  }

  /** A body's replicated fields (§9.2); with `{ rest: true }` its sleep timer too (§20.3). */
  exportBodyState(key, options) {
    const passed = passedKey(key);
    if (passed === undefined) return null;
    const rest = restOption(options);
    return this.#read(
      () => null,
      (wasm, id) =>
        JSON.parse(rest ? wasm.world_export_body_state_rest(id, passed) : wasm.world_export_body_state(id, passed)),
    );
  }

  /**
   * Puts the world into its canonical state (contract 1.1 draft, §20.1): rebuilt in key order from
   * each body's state alone, so a world holding the same bodies in the same states, canonicalized,
   * steps on bit for bit with this one. `{ quantize: true }` first snaps every simulated body onto
   * its wire row (§20.2). Options of any other shape are `bad-command`.
   */
  canonicalize(options) {
    const encoded = encode(options === undefined ? {} : options, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_canonicalize(id, encoded.text));
  }

  /**
   * Imports wire rows (§20.2): 15 numbers per key, p(3) as float32, q(4), lv(3) and av(3) as the
   * 16-bit integers the wire sends, sleep (0 or 1) and rest in whole inner steps. All or none, a
   * refusal naming its index; a fixed body takes the pose only.
   */
  importWire(keys, rows) {
    const read = bulkImport(keys, rows, WIRE_STRIDE);
    if (read.refused !== undefined) return read.refused;
    const encoded = encode(read.keys, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_import_wire(id, encoded.text, read.data));
  }

  /** A body descriptor's canonical JSON (§20.5): `{ ok: true, desc }`, or `spawn`'s own refusal. */
  bodyDescCanonical(desc) {
    const encoded = encode(desc, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_body_desc_canonical(id, encoded.text));
  }

  /** A joint descriptor's canonical JSON (§20.5): `{ ok: true, desc }`, or `addJoint`'s own refusal. */
  jointDescCanonical(desc) {
    const encoded = encode(desc, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_joint_desc_canonical(id, encoded.text));
  }

  /**
   * Imports many bodies' replicated fields in one call (§19.1, additive to 1.0): `keys[i]` takes
   * `data[14·i … 14·i + 13]`, `exportChanged`'s layout. All or none, a refusal naming its index;
   * when all pass the world ends exactly as one `importBodyState` per key in order leaves it.
   */
  importStates(keys, data, options) {
    const rest = restOption(options);
    const read = bulkImport(keys, data, rest ? EXPORT_STRIDE_REST : EXPORT_STRIDE);
    if (read.refused !== undefined) return read.refused;
    const encoded = encode(read.keys, this.#budget());
    if (encoded.text === undefined) return encoded;
    if (rest) return this.#json((wasm, id) => wasm.world_import_states_rest(id, encoded.text, read.data));
    return this.#json((wasm, id) => wasm.world_import_states(id, encoded.text, read.data));
  }

  importBodyState(key, state) {
    const passed = passedKey(key);
    if (passed === undefined) return failure(PhysicsError.InvalidKey, "a key is a string");
    const encoded = encode(state, this.#budget());
    if (encoded.text === undefined) return encoded;
    return this.#json((wasm, id) => wasm.world_import_body_state(id, passed, encoded.text));
  }

  ray(origin, dir, maxDist, filter) {
    return this.#query({ ray: { origin, dir, maxDist, filter } });
  }

  shapeCast(shape, pose, dir, maxDist, filter) {
    return this.#query({ shapeCast: { shape, pose, dir, maxDist, filter } });
  }

  overlap(shape, pose, filter) {
    return this.#query({ overlap: { shape, pose, filter } });
  }

  /** Runs one query in its JSON form (§13). */
  query(query) {
    return this.#query(query);
  }

  /**
   * Runs many queries in one crossing (§19.2, additive to 1.0): one result per query, in order,
   * each exactly what `query()` gives for it, `queriesPerStep` counted the same. A failure of the
   * whole call (not a list, over the call's budget or 16,384 queries, `internal`) is one failure.
   */
  queryMany(queries) {
    const read = queryList(queries);
    if (read.refused !== undefined) return read.refused;
    const sent = encodeEach(read.items, this.#budget());
    if (sent.refused !== undefined) return sent.refused;
    const result = this.#json((wasm, id) => wasm.world_query_many(id, sent.text));
    if (!result.ok) return result;
    return mergeAnswers(sent.encoded, result.results);
  }

  /**
   * One room tick (`tickWorld`): each batch as `apply(batch, "each")`, then `step()`, then
   * `exportChanged(exportSince)`, then `queryMany(queries)`, in one crossing where the wire has one
   * (`world_tick_frame`, the binary tick of crates/genex-physics-binding/src/tick.rs) and as those
   * calls otherwise. Each part's result is exactly that call's.
   */
  #tick(input) {
    const read = tickInput(input);
    if (read.refused !== undefined) return read.refused;
    const budget = this.#budget();
    const framed = this.#binding.wire.world_tick_frame === undefined ? undefined : encodeTick(read, budget);
    return this.#result((wire, id) => {
      const reply = framed === undefined ? undefined : wire.world_tick_frame(id, framed.bytes);
      if (reply !== undefined) return readTick(reply, framed.sent, this.#keys, wire.tick_cpu_ns?.() ?? 0);
      return composedTick(wire, id, read, budget);
    });
  }

  /** The last export's keys and their bytes, kept to reuse its strings (`readKeys`). */
  #keys = { bytes: new Uint8Array(0), starts: new Int32Array(0), lengths: new Int32Array(0), keys: [] };
  /** The opaque snapshot (§9.4); empty when the world failed. */
  snapshot() {
    return this.#read(
      () => new Uint8Array(0),
      (wasm, id) => wasm.world_snapshot(id) ?? new Uint8Array(0),
    );
  }

  /** Replaces the whole world from a snapshot of the same build (§9.4). */
  restore(bytes) {
    const { view, refused } = snapshotBytes(bytes);
    if (refused !== undefined) return refused;
    const result = this.#json((wasm, id) => wasm.world_restore(id, view));
    if (result.ok) {
      this.#desc =
        this.#read(
          () => undefined,
          (wasm, id) => JSON.parse(wasm.world_desc(id)),
        ) ?? this.#desc;
    }
    return result;
  }

  /** 16 lowercase hex digits (§10.1); empty when the world failed. */
  stateHash() {
    return this.#read(
      () => "",
      (wasm, id) => wasm.world_state_hash(id),
    );
  }

  /** 16 lowercase hex digits (§10.2); empty when the world failed. */
  physicsHash() {
    return this.#read(
      () => "",
      (wasm, id) => wasm.world_physics_hash(id),
    );
  }

  /** The world's counters (§11); zeros when the world failed. */
  stats() {
    return this.#read(emptyStats, (wasm, id) => JSON.parse(wasm.world_stats(id)) ?? emptyStats());
  }

  /** Releases the world's memory. Every later call on it fails with `internal`. */
  free() {
    if (this.#freed) return;
    this.#freed = true;
    finalizer.unregister(this);
    if (this.#generation !== this.#binding.generation) return;
    guarded(
      this.#binding,
      () => false,
      (wire) => wire.world_free(this.#id),
    );
  }
}

/**
 * A `bodies()` filter (§9.1), its `kinds` still to encode, or `undefined` for a malformed one, including
 * one that throws while it is read (a getter, a Proxy).
 */
function bodyFilter(filter) {
  try {
    return bodyFilterFields(filter);
  } catch {
    return undefined;
  }
}

function bodyFilterFields(filter) {
  if (filter === undefined) return { kinds: undefined, awakeOnly: false, since: NO_TICK };
  if (filter === null || typeof filter !== "object") return undefined;
  const known = Object.keys(filter).every((name) => ["kinds", "awakeOnly", "changedSinceTick"].includes(name));
  const { kinds, awakeOnly = false, changedSinceTick } = filter;
  const kindsOk = kinds === undefined || (Array.isArray(kinds) && kinds.every((kind) => typeof kind === "string"));
  const tickOk = changedSinceTick === undefined || isWholeTick(changedSinceTick);
  if (!(known && kindsOk && tickOk && typeof awakeOnly === "boolean")) return undefined;
  const since = changedSinceTick ?? NO_TICK;
  return { kinds, awakeOnly, since };
}

/** The fields a tick may name (`tickWorld`). */
const TICK_FIELDS = ["batches", "step", "exportSince", "queries"];
/** The most command batches one tick carries: a room's tick applies a handful. */
const TICK_BATCHES_MAX = 64;

/** A tick's fields, each read once, or `{ refused }` for any other shape (also one that throws while read). */
function tickInput(input) {
  try {
    return tickInputFields(input);
  } catch {
    return { refused: failure(PhysicsError.BadCommand, Detail.BadTick) };
  }
}

function tickInputFields(input) {
  const refused = { refused: failure(PhysicsError.BadCommand, Detail.BadTick) };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return refused;
  if (!Object.keys(input).every((name) => TICK_FIELDS.includes(name))) return refused;
  const { batches = [], step = false, exportSince, queries } = input;
  const exportOk = exportSince === undefined || typeof exportSince === "number";
  if (!Array.isArray(batches) || typeof step !== "boolean" || !exportOk) return refused;
  if (batches.length > TICK_BATCHES_MAX) return refused;
  const items = [];
  for (let index = 0; index < batches.length; index += 1) items.push(batches[index]);
  return { batches: items, step, exportSince, queries };
}

/** One batch as `apply(batch, "each")` sends it: `{ text }`, or the failure it gives without crossing. */
function encodeBatch(commands, budget) {
  if (batchTooLong(commands)) return failure(PhysicsError.OutOfRange, Detail.BigBatch);
  return encode(commands, budget);
}

/** Queries as `queryMany` sends them: `{ encoded, text }`, or `{ refused }` without crossing. */
function encodeQueries(queries, budget) {
  const read = queryList(queries);
  if (read.refused !== undefined) return read;
  return encodeEach(read.items, budget);
}

/**
 * A tick as the separate calls it stands for, each crossing its JSON text: for a wire with no
 * `world_tick_frame`, or a tick too large for one frame (the native wire then answers `undefined`).
 * Its inputs are encoded again from `read` here, so a tick reaching this read them twice.
 */
function composedTick(wire, id, read, budget) {
  const batches = read.batches.map((commands) => encodeBatch(commands, budget));
  const queries = read.queries === undefined ? undefined : encodeQueries(read.queries, budget);
  const exporting = isExporting(read);
  const ask = {
    batches: batches.flatMap((batch) => (batch.text === undefined ? [] : [batch.text])),
    step: read.step,
    since: exporting ? read.exportSince : NO_TICK,
    queries: queries?.text,
  };
  const raw = composeTick(wire, id, ask);
  return tickResult(raw, { batches, queries, step: read.step, exporting, exportAsked: read.exportSince !== undefined });
}

/** Whether a tick exports: its `exportSince` is a whole tick (any other export answers empty). */
function isExporting(read) {
  return read.exportSince !== undefined && isWholeTick(read.exportSince);
}

/** The separate calls of a tick, in their order; the raw texts `tickResult` reads. */
/** A tick's result from its raw texts: each part exactly what its own call returns. */
function tickResult(raw, sent) {
  let next = 0;
  const results = sent.batches.map((batch) => {
    if (batch.text === undefined) return batch;
    const result = JSON.parse(raw.results[next]);
    next += 1;
    return result.ok ? result.results : result;
  });
  const out = { ok: true, tick: raw.tick, results };
  if (sent.step) out.step = JSON.parse(raw.step);
  if (sent.exportAsked) out.exported = sent.exporting ? changedExport(JSON.parse(raw.keys), raw.data) : emptyExport();
  if (sent.queries !== undefined) out.answers = tickAnswers(raw.answers, sent.queries);
  out.cpuNs = raw.cpuNs;
  out.memoryBytes = raw.memoryBytes;
  return out;
}

/** An export's keys and data, or the empty export when they do not match. */
function changedExport(keys, data) {
  if (data === undefined || data.length !== keys.length * EXPORT_STRIDE) return emptyExport();
  return { keys, data };
}

/** `queryMany`'s result from its sent form and the wire's answer text. */
function tickAnswers(text, sent) {
  if (sent.refused !== undefined) return sent.refused;
  const result = JSON.parse(text);
  if (!result.ok) return result;
  return mergeAnswers(sent.encoded, result.results);
}

// ---------------------------------------------------------------------------------------------
// A room tick in one crossing: the binary form of crates/genex-physics-binding/src/tick.rs, which
// both wires take (the WASM glue's `world_tick_frame`, the native process's `Tick` frame). A tick's
// commands and queries cross as the value trees their JSON text parses to, numbers as the f64 of
// their f32, with no number text; the reply is read with no `JSON.parse`, into the very objects the
// separate calls' JSON text gives. Every refusal is the separate calls' own: an input is walked in
// `write`'s order with its checks (depth, values, a BigInt, anything thrown while read), and one
// whose JSON text could pass its character budget is judged from that text instead (`encode`), so
// such an input (about a sixth of the budget or more) is read twice.

/** An item's form, a value's tag, and the reply's forms (tick.rs). */
const ItemForm = Object.freeze({ Value: 0, Text: 1, NoText: 2 });
const ValueTag = Object.freeze({ Null: 0, False: 1, True: 2, Number: 3, String: 4, Array: 5, Object: 6 });
const StepForm = Object.freeze({ None: 0, Failure: 1, Done: 2 });
const BatchForm = Object.freeze({ Failure: 0, Results: 1 });
const AnswersForm = Object.freeze({ None: 0, Failure: 1, Done: 2 });
const AnswerForm = Object.freeze({ Failure: 0, NoHit: 1, Hit: 2, Keys: 3 });
const EventKind = Object.freeze(["contactBegin", "contactEnd", "triggerEnter", "triggerExit"]);
const CONTACT_BEGIN = 0;
/** What NaN and ±Infinity cross as (their text's `1e39`, `NOT_FINITE_TEXT`). */
const NOT_FINITE_NUMBER = 1e39;
/** The most characters a number's text and its comma take (`NUMBER_CHARS_MAX`). */
const NUMBER_TEXT_BOUND = NUMBER_CHARS_MAX;
/** The most characters one UTF-16 unit's JSON text takes (`\\u00XX`), and a string's quotes. */
const ESCAPED_CHARS_MAX = 6;
const QUOTES = 2;
/** `null`, `true`, `false` with a comma: at most six characters. */
const WORD_TEXT_BOUND = 6;
/** The scratch a request is written into, and the most of it kept between ticks. */
const TICK_SCRATCH_BYTES = 4096;
const TICK_SCRATCH_KEPT = 1024 * 1024;
/** Strings this short are decoded by hand when ASCII; longer ones by `TextDecoder`. */
const SHORT_TEXT = 32;
const ASCII_END = 0x80;
const CONTROL_END = 0x20;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
/** `\b \t \n \f \r`: escaped in two characters, other control characters in six. */
const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** Thrown by the walk when an input's text could pass its budget: `encode` judges it instead. */
const OVER_BOUND = Symbol("over the character bound");
/** An item that crossed (an entry of `sent`, beside the refusals of those that did not). */
const CROSSED = Object.freeze({ crossed: true });

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** A growable little-endian byte buffer: the request, written in one pass. */
class ByteWriter {
  constructor() {
    this.busy = false;
    this.reset();
  }

  /** Empties it, giving back a scratch that a large tick grew past `TICK_SCRATCH_KEPT`. */
  reset() {
    if (this.bytes === undefined || this.bytes.length > TICK_SCRATCH_KEPT) {
      this.bytes = new Uint8Array(TICK_SCRATCH_BYTES);
      this.view = new DataView(this.bytes.buffer);
    }
    this.at = 0;
  }

  room(count) {
    const needed = this.at + count;
    if (needed <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
    grown.set(this.bytes.subarray(0, this.at));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value) {
    this.room(1);
    this.bytes[this.at] = value;
    this.at += 1;
  }

  u32(value) {
    this.room(4);
    this.view.setUint32(this.at, value, true);
    this.at += 4;
  }

  f64(value) {
    this.room(8);
    this.view.setFloat64(this.at, value, true);
    this.at += 8;
  }

  /** A string's UTF-8 with its length first (a lone surrogate as U+FFFD: its item has no text). */
  str(text) {
    const length = text.length;
    this.room(4 + length * 3);
    const start = this.at + 4;
    let at = start;
    for (let index = 0; index < length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= ASCII_END) {
        at = start + textEncoder.encodeInto(text, this.bytes.subarray(start)).written;
        break;
      }
      this.bytes[at] = unit;
      at += 1;
    }
    this.view.setUint32(this.at, at - start, true);
    this.at = at;
  }

  /** The request's bytes (a view of the scratch, valid until the next tick). */
  done() {
    return this.bytes.subarray(0, this.at);
  }
}

/** The request scratch; a tick encoded while another is (a getter calling `tickWorld`) gets its own. */
let scratch = new ByteWriter();

/**
 * The characters a string's JSON text counts toward the budget at most: `stringText` counts its
 * escaped text, three per character when any is not ASCII. Exact for ASCII; for other text, six
 * per unit (a lone surrogate's `\\udXXX`), times three.
 */
function stringBound(text) {
  const length = text.length;
  let chars = QUOTES;
  for (let index = 0; index < length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= ASCII_END) return (ESCAPED_CHARS_MAX * length + QUOTES) * NON_ASCII_WEIGHT;
    chars += escapedWidth(unit);
  }
  return chars;
}

/** One ASCII unit's JSON text length. */
function escapedWidth(unit) {
  if (unit === QUOTE || unit === BACKSLASH) return 2;
  if (unit >= CONTROL_END) return 1;
  return SHORT_ESCAPES.has(unit) ? 2 : ESCAPED_CHARS_MAX;
}

/** Whether a string has a JSON text the core can parse (no lone surrogate). */
function hasText(text) {
  return text.isWellFormed();
}

/** Adds `chars` to a walk's bound, stopping it once its text could pass the budget. */
function bound(walk, chars) {
  walk.bound += chars;
  if (walk.bound > walk.budget.chars) throw OVER_BOUND;
}

/** Writes `value` as a value tree, in `write`'s order with `write`'s checks (see the section). */
function writeValue(value, walk, depth) {
  if (depth > MAX_DEPTH) throw new Refusal(PhysicsError.BadCommand, Detail.TooDeep);
  walk.values += 1;
  if (walk.values > walk.budget.values) throw new Refusal(PhysicsError.OutOfRange, Detail.TooLarge);
  if (value === null || omitted(value)) {
    bound(walk, WORD_TEXT_BOUND);
    scratch.u8(ValueTag.Null);
    return;
  }
  switch (typeof value) {
    case "number":
      writeNumber(value, walk);
      return;
    case "string":
      writeString(value, walk);
      return;
    case "boolean":
      bound(walk, WORD_TEXT_BOUND);
      scratch.u8(value ? ValueTag.True : ValueTag.False);
      return;
    case "bigint":
      throw new Refusal(PhysicsError.BadCommand, Detail.BigInt);
    default:
      break;
  }
  if (Array.isArray(value)) {
    writeArrayValue(value, walk, depth);
    return;
  }
  writeObjectValue(value, walk, depth);
}

/** A number as the f64 of its f32 (§4.1); NaN and ±Infinity as ±1e39, as their text. */
function writeNumber(value, walk) {
  bound(walk, NUMBER_TEXT_BOUND);
  const rounded = Math.fround(value);
  scratch.u8(ValueTag.Number);
  if (Number.isNaN(rounded) || rounded === Number.POSITIVE_INFINITY) scratch.f64(NOT_FINITE_NUMBER);
  else if (rounded === Number.NEGATIVE_INFINITY) scratch.f64(-NOT_FINITE_NUMBER);
  else scratch.f64(rounded);
}

function writeString(value, walk) {
  bound(walk, stringBound(value) + 1);
  if (!hasText(value)) walk.noText = true;
  scratch.u8(ValueTag.String);
  scratch.str(value);
}

function writeArrayValue(items, walk, depth) {
  const length = items.length;
  bound(walk, QUOTES + 1);
  scratch.u8(ValueTag.Array);
  scratch.u32(length);
  for (let index = 0; index < length; index += 1) writeValue(items[index], walk, depth + 1);
}

function writeObjectValue(object, walk, depth) {
  bound(walk, QUOTES + 1);
  scratch.u8(ValueTag.Object);
  const countAt = scratch.at;
  scratch.u32(0);
  let count = 0;
  for (const name of Object.keys(object)) {
    const item = object[name];
    if (omitted(item)) continue;
    bound(walk, stringBound(name) + 1);
    if (!hasText(name)) walk.noText = true;
    scratch.str(name);
    writeValue(item, walk, depth + 1);
    count += 1;
  }
  scratch.view.setUint32(countAt, count, true);
}

/** A new walk of one input against `budget`. */
function newWalk(budget) {
  return { values: 0, bound: 0, noText: false, budget };
}

/** What a walk that threw gives: `OVER_BOUND` for the text to judge, else `encode`'s refusal for it. */
function walkRefusal(error) {
  if (error === OVER_BOUND) return OVER_BOUND;
  if (error instanceof Refusal) return failure(error.code, error.detail);
  if (error instanceof RangeError) return failure(PhysicsError.OutOfRange, Detail.TooLarge);
  return failure(PhysicsError.BadCommand, Detail.Unreadable);
}

/** An item as JSON text, as the separate call would send it, or that call's refusal. */
function writeTextItem(value, budget) {
  const encoded = encode(value, budget);
  if (encoded.text === undefined) return encoded;
  scratch.u8(ItemForm.Text);
  scratch.str(encoded.text);
  return CROSSED;
}

/** One input as an item (`CROSSED`), or the refusal its separate call gives, writing nothing. */
function writeItem(value, budget) {
  const at = scratch.at;
  scratch.u8(ItemForm.Value);
  const walk = newWalk(budget);
  try {
    writeValue(value, walk, 0);
  } catch (error) {
    scratch.at = at;
    const refused = walkRefusal(error);
    return refused === OVER_BOUND ? writeTextItem(value, budget) : refused;
  }
  if (walk.noText) scratch.bytes[at] = ItemForm.NoText;
  return CROSSED;
}

/** A batch as `apply(batch, "each")` sends it: `CROSSED`, or its refusal. */
function writeBatch(commands, budget) {
  if (batchTooLong(commands)) return failure(PhysicsError.OutOfRange, Detail.BigBatch);
  return writeItem(commands, budget);
}

/**
 * Queries as `queryMany` sends them (`encodeEach`): each walked alone, keeping its own refusal; the
 * rest cross as one array that must fit the call's budget together. `{ encoded }` per query
 * (`CROSSED` or its refusal), or `{ refused }` for the whole call, writing nothing.
 */
function writeQueries(queries, budget) {
  const read = queryList(queries);
  if (read.refused !== undefined) return read;
  const at = scratch.at;
  scratch.u8(ItemForm.Value);
  scratch.u8(ValueTag.Array);
  const countAt = scratch.at;
  scratch.u32(0);
  const together = { values: 0, bound: QUOTES, noText: false };
  const encoded = [];
  for (const item of read.items) {
    const one = writeQuery(item, budget, together);
    if (one === OVER_BOUND) {
      scratch.at = at;
      return writeQueriesText(read.items, budget);
    }
    if (one.refused !== undefined) {
      scratch.at = at;
      return one;
    }
    encoded.push(one);
  }
  const crossed = encoded.filter((one) => one === CROSSED).length;
  scratch.view.setUint32(countAt, crossed, true);
  if (together.noText) scratch.bytes[at] = ItemForm.NoText;
  return { encoded };
}

/** One query of `writeQueries`: `CROSSED`, its own refusal, `{ refused }` for the call, or `OVER_BOUND`. */
function writeQuery(item, budget, together) {
  const itemAt = scratch.at;
  const walk = newWalk(budget);
  try {
    writeValue(item, walk, 0);
  } catch (error) {
    scratch.at = itemAt;
    return walkRefusal(error);
  }
  together.bound += walk.bound + 1;
  together.values += walk.values;
  if (together.bound > budget.chars) return OVER_BOUND;
  if (together.values > budget.values) return { refused: failure(PhysicsError.OutOfRange, Detail.TooLarge) };
  together.noText ||= walk.noText;
  return CROSSED;
}

/** The queries as `queryMany`'s JSON text, judged by `encodeEach`. */
function writeQueriesText(items, budget) {
  const sent = encodeEach(items, budget);
  if (sent.refused !== undefined) return sent;
  scratch.u8(ItemForm.Text);
  scratch.str(sent.text);
  return { encoded: sent.encoded };
}

/**
 * A tick's request bytes (tick.rs) and what each part sent: `batches` (`CROSSED` or the refusal
 * each gives without crossing, as `apply` gives it), `queries` (`writeQueries`' form, or
 * `undefined` when the tick has none), `step`, `exporting` and `exportAsked`.
 */
function encodeTick(read, budget) {
  if (scratch.busy) return withOwnScratch(() => encodeTick(read, budget));
  scratch.busy = true;
  try {
    return encodeTickInto(read, budget);
  } finally {
    scratch.busy = false;
  }
}

/** Runs `fn` with a scratch of its own, the shared one kept for the tick it interrupted. */
function withOwnScratch(fn) {
  const shared = scratch;
  scratch = new ByteWriter();
  try {
    return fn();
  } finally {
    scratch = shared;
  }
}

function encodeTickInto(read, budget) {
  scratch.reset();
  scratch.u32(0);
  const batches = [];
  let crossed = 0;
  for (const commands of read.batches) {
    const one = writeBatch(commands, budget);
    batches.push(one);
    if (one === CROSSED) crossed += 1;
  }
  scratch.view.setUint32(0, crossed, true);
  const exporting = isExporting(read);
  scratch.u8(read.step ? 1 : 0);
  scratch.f64(exporting ? read.exportSince : NO_TICK);
  const flagAt = scratch.at;
  scratch.u8(1);
  const queries = read.queries === undefined ? undefined : writeQueries(read.queries, budget);
  if (queries === undefined || queries.refused !== undefined) {
    scratch.at = flagAt;
    scratch.u8(0);
  }
  const sent = { batches, queries, step: read.step, exporting, exportAsked: read.exportSince !== undefined };
  return { bytes: scratch.done(), sent };
}

/** A cursor over a tick reply; anything it cannot read whole throws (the binding is then poisoned). */
class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }

  need(count) {
    const at = this.at;
    if (at + count > this.bytes.length) throw new RangeError("a tick reply ran short");
    this.at = at + count;
    return at;
  }

  u8() {
    return this.bytes[this.need(1)];
  }

  flag() {
    const value = this.u8();
    if (value > 1) throw new RangeError("a tick reply flag is not 0 or 1");
    return value === 1;
  }

  u32() {
    return this.view.getUint32(this.need(4), true);
  }

  /** A reply number: the f64 its JSON text names, a non-finite one standing for that text's `null`. */
  number() {
    const value = this.view.getFloat64(this.need(8), true);
    return Number.isFinite(value) ? value : null;
  }

  vec3() {
    return [this.number(), this.number(), this.number()];
  }

  str() {
    const length = this.u32();
    const start = this.need(length);
    return textOf(this.bytes, start, length);
  }

  strs() {
    const count = this.u32();
    const out = new Array(count);
    for (let index = 0; index < count; index += 1) out[index] = this.str();
    return out;
  }

  /** `{ ok: false, code, index?, detail }`, its members in the order the JSON text holds them. */
  failure() {
    const code = this.str();
    const out = { ok: false, code };
    if (this.flag()) out.index = this.number();
    out.detail = this.str();
    return out;
  }

  done() {
    if (this.at !== this.bytes.length) throw new RangeError("a tick reply has bytes left over");
  }
}

/** UTF-8 bytes as a string: short ASCII by hand, anything else by `TextDecoder`. */
function textOf(bytes, start, length) {
  if (length > SHORT_TEXT) return textDecoder.decode(bytes.subarray(start, start + length));
  let text = "";
  for (let at = start; at < start + length; at += 1) {
    const byte = bytes[at];
    if (byte >= ASCII_END) return textDecoder.decode(bytes.subarray(start, start + length));
    text += String.fromCharCode(byte);
  }
  return text;
}

/**
 * A tick's result from its reply (tick.rs): each part exactly what its own call returns, every
 * object with its JSON text's members in order. `keys` keeps the last export's keys, whose strings an
 * export of the same keys reuses (`readKeys`). `cpuNs` is the wire's own
 * CPU for the tick (a sidecar's; 0 in WASM).
 */
function readTick(bytes, sent, keys, cpuNs) {
  const reply = new ByteReader(bytes);
  const count = reply.u32();
  const crossing = sent.batches.filter((batch) => batch === CROSSED).length;
  if (count !== crossing) throw new RangeError("a tick answered another number of batches");
  const results = sent.batches.map((batch) => (batch === CROSSED ? readBatch(reply) : batch));
  const step = readStep(reply);
  const exported = reply.flag() ? readExport(reply, keys) : undefined;
  const answers = readAnswers(reply);
  const tick = reply.number();
  const memoryBytes = reply.number();
  reply.done();
  const out = { ok: true, tick, results };
  if (sent.step) out.step = step;
  if (sent.exportAsked) out.exported = sent.exporting && exported !== undefined ? exported : emptyExport();
  if (sent.queries !== undefined) out.answers = sent.queries.refused ?? mergeTickAnswers(sent.queries.encoded, answers);
  out.cpuNs = cpuNs;
  out.memoryBytes = memoryBytes;
  return out;
}

/** One batch's `apply(batch, "each")` result: its results, or its failure. */
function readBatch(reply) {
  if (reply.u8() === BatchForm.Failure) return reply.failure();
  const count = reply.u32();
  const results = new Array(count);
  for (let index = 0; index < count; index += 1) {
    results[index] = reply.u8() === 0 ? { ok: true } : { ok: false, code: reply.str() };
  }
  return results;
}

/** `step()`'s result, or `undefined` when the tick did not step. */
function readStep(reply) {
  const form = reply.u8();
  if (form === StepForm.None) return undefined;
  if (form === StepForm.Failure) return reply.failure();
  const tick = reply.number();
  const count = reply.u32();
  const events = new Array(count);
  for (let index = 0; index < count; index += 1) events[index] = readEvent(reply);
  const overflowed = reply.flag();
  const escaped = reply.strs();
  return { ok: true, tick, events, overflowed, escaped, memoryExceeded: reply.flag() };
}

/** One event in its §8.1 form, members in its JSON text's order. */
function readEvent(reply) {
  const kindAt = reply.u8();
  const kind = EventKind[kindAt];
  if (kind === undefined) throw new RangeError("a tick reply names no event kind");
  const contact = kindAt <= 1;
  const names = contact ? ["a", "b", "ca", "cb"] : ["sensor", "sc", "other", "oc"];
  const tags = contact ? ["ka", "kb"] : ["ks", "ko"];
  const out = { kind };
  for (const name of names) out[name] = reply.str();
  for (const tag of tags) {
    if (reply.flag()) out[tag] = reply.str();
  }
  if (kindAt !== CONTACT_BEGIN) return out;
  out.impulse = reply.number();
  out.point = reply.vec3();
  out.normal = reply.vec3();
  return out;
}

/** `exportChanged`'s keys and data; a key the last export also held reuses its string (`readKeys`). */
function readExport(reply, last) {
  const keys = readKeys(reply, last);
  const length = reply.u32();
  const at = reply.need(length * Float32Array.BYTES_PER_ELEMENT);
  const data = new Float32Array(length);
  new Uint8Array(data.buffer).set(reply.bytes.subarray(at, at + data.byteLength));
  if (data.length !== keys.length * EXPORT_STRIDE) return emptyExport();
  return { keys, data };
}

/**
 * An export's keys. Both exports are in key order (byte order), so the last export's keys are
 * walked beside these: a key whose bytes equal the last's at the walk's place reuses that string,
 * any other is decoded. Reuse is only ever on equal bytes, so the keys are right in any order; the
 * order only makes the reuse likely. `last` then holds these keys and a copy of their bytes.
 */
function readKeys(reply, last) {
  const count = reply.u32();
  const regionAt = reply.at;
  const keys = new Array(count);
  const starts = new Int32Array(count);
  const lengths = new Int32Array(count);
  let next = 0;
  for (let index = 0; index < count; index += 1) {
    const length = reply.u32();
    const at = reply.need(length);
    starts[index] = at - regionAt;
    lengths[index] = length;
    while (next < last.keys.length) {
      const order = compareBytes(reply.bytes, at, length, last.bytes, last.starts[next], last.lengths[next]);
      if (order > 0) {
        next += 1;
        continue;
      }
      if (order === 0) {
        keys[index] = last.keys[next];
        next += 1;
      }
      break;
    }
    keys[index] ??= textOf(reply.bytes, at, length);
  }
  // A copy: the reply may be a view of a buffer the wire reuses (a Node Buffer, whose slice() is a view).
  last.bytes = new Uint8Array(reply.bytes.subarray(regionAt, reply.at));
  last.starts = starts;
  last.lengths = lengths;
  last.keys = keys.slice();
  return keys;
}

/** Byte order of `one[oneAt, +oneLength)` against `other[otherAt, +otherLength)`: negative, 0 or positive. */
function compareBytes(one, oneAt, oneLength, other, otherAt, otherLength) {
  const shared = Math.min(oneLength, otherLength);
  for (let index = 0; index < shared; index += 1) {
    const difference = one[oneAt + index] - other[otherAt + index];
    if (difference !== 0) return difference;
  }
  return oneLength - otherLength;
}

/** `queryMany`'s raw result: its failure, or one answer per crossed query; `undefined` for none. */
function readAnswers(reply) {
  const form = reply.u8();
  if (form === AnswersForm.None) return undefined;
  if (form === AnswersForm.Failure) return reply.failure();
  const count = reply.u32();
  const answers = new Array(count);
  for (let index = 0; index < count; index += 1) answers[index] = readAnswer(reply);
  return answers;
}

/** One query's result as `query()` gives it. */
function readAnswer(reply) {
  const form = reply.u8();
  if (form === AnswerForm.Failure) return reply.failure();
  if (form === AnswerForm.NoHit) return { ok: true, hit: null };
  if (form === AnswerForm.Keys) return { ok: true, keys: reply.strs() };
  if (form !== AnswerForm.Hit) throw new RangeError("a tick reply names no answer form");
  const body = reply.str();
  const collider = reply.str();
  return { ok: true, hit: { body, collider, dist: reply.number(), point: reply.vec3(), normal: reply.vec3() } };
}

/** `queryMany`'s result: a failure of the whole call, or each query's own refusal or its answer. */
function mergeTickAnswers(encoded, answers) {
  if (answers === undefined) throw new RangeError("a tick reply has no answers for its queries");
  if (!Array.isArray(answers)) return answers;
  let next = 0;
  const out = encoded.map((one) => {
    if (one.ok === false) return one;
    next += 1;
    return answers[next - 1];
  });
  if (next !== answers.length) throw new RangeError("a tick answered another number of queries");
  return out;
}

/**
 * Internal (`@genex-ai/physics-native` and authority servers): one room tick on `world` in one crossing: `input` is
 * `{ batches?, step?, exportSince?, queries? }`, and the result `{ ok: true, tick, results, step?,
 * exported?, answers?, cpuNs, memoryBytes }` holds exactly what `apply(batch, "each")` per batch,
 * `step()`, `exportChanged(exportSince)` and `queryMany(queries)` return, in that order; `cpuNs` is
 * a sidecar's own CPU time for the tick (0 in WASM). A failure value for a malformed tick or an
 * unusable world.
 */
export function tickWorld(world, input) {
  return tickOf(world, input);
}

/**
 * Internal (`@genex-ai/physics-native`): worlds over `wire`, an object with the glue's exports
 * (`world_tick_frame(id, request)` optional: the binary tick's reply bytes, or `undefined` to have
 * the tick made as separate calls; `tick_cpu_ns()` optional: the wire's own CPU for the last
 * tick), each this file's `World` with its encoding,
 * budgets and result forms. `detail` names the binding's failures (`{ poisoned, stale }`) and may
 * hold `onPoison()`, called once anything thrown in a call poisons it (a reply that does not
 * parse included). A poisoned wire stays so: its worlds answer `internal`, its reads their empty forms.
 * `undefined` when `wire.build_id()` throws.
 */
export function bindWire(wire, detail) {
  const binding = newBinding(wire, detail);
  try {
    binding.buildId = wire.build_id();
  } catch {
    return undefined;
  }
  binding.ready = true;
  binding.generation = 1;
  return {
    buildId: () => binding.buildId,
    createWorld: (desc) => createWorld(binding, desc),
    poisoned: () => binding.poisoned,
  };
}

/** Internal, for this package's own tests: a world's id in the instance. */
export function worldId(world) {
  return ids.get(world);
}

/** Internal, for this package's own tests: the live instance's health. */
export function instanceState() {
  return { ready: instance.ready, generation: instance.generation, poisoned: instance.poisoned };
}

/** Internal, for this package's own tests: runs `fn` on the glue under the trap guard. */
export function guardedForTests(fallback, fn) {
  return guarded(instance, fallback, fn);
}

/** Internal, for this package's own tests: runs `fn` on a `createBinding()` handle's glue under its trap guard. */
export function guardedBindingForTests(handle, fallback, fn) {
  const binding = bindings.get(handle);
  if (binding === undefined) return fallback();
  return guarded(binding, fallback, fn);
}
