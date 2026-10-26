// The §16 conformance-vector runner for @genex-ai/physics, the JS twin of the native runner in
// `tests/vectors.rs`. It runs wherever the package runs (Node 24, a browser page, a container): no
// Node modules and no assert; it returns what differs instead of throwing. Not packed (package.json
// `files`); the repo's tests and the headless Chromium rows load it from here.
//
// How it reads §16's open details is the native runner's (see `../vectors/README.md`): `repeat`
// defaults to 1 and may be 0; `events` and `escaped` are the last step's; a number under `events`
// is a count; `refused` is `[[index, code], …]` (atomic: the failing index, or none); a query
// answer is `{ hit }`, `{ keys }` or `{ error }`; numbers compare as f32.

/** The vector format's contract (§16). */
export const VECTOR_CONTRACT = "1.0";

/** The modes a vector applies its commands in (§7.1). */
const Mode = Object.freeze({ Each: "each", Atomic: "atomic" });

/** The fields an `expect` may pin. */
const EXPECT_FIELDS = new Set(["stateHash", "physicsHash", "refused", "queries", "escaped", "events"]);

/** The build a vector must be pinned on: a buildId without its `+<target>` (§2, §16). */
export function buildWithoutTarget(buildId) {
  const cut = buildId.lastIndexOf("+");
  return cut < 0 ? buildId : buildId.slice(0, cut);
}

/** Every number rounded to f32, as the native runner compares (§16's numbers are f32 values). */
function asF32(value) {
  if (typeof value === "number") return Math.fround(value);
  if (Array.isArray(value)) return value.map(asF32);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, asF32(inner)]));
  }
  return value;
}

/** Structural equality of two JSON values (numbers by `Object.is`, so -0 is not 0). */
function same(a, b) {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why `vector` cannot be run on a build named `ours`, or undefined when it can. */
function refusal(vector, ours) {
  if (!isObject(vector)) return "format: a vector is a JSON object";
  if (vector.build !== ours) {
    return `build: the vector is pinned on ${JSON.stringify(vector.build)}, this package is ${ours}; vectors are per build (§16)`;
  }
  if (vector.contract !== VECTOR_CONTRACT) {
    return `contract: the vector is for ${JSON.stringify(vector.contract)}, this runner reads ${VECTOR_CONTRACT}`;
  }
  if (!isObject(vector.world)) return "format: `world` is a WorldDesc object";
  if (!isObject(vector.static)) return "format: `static` is a StaticWorld object";
  if (!Object.values(Mode).includes(vector.mode))
    return `format: \`mode\` is "each" or "atomic", not ${JSON.stringify(vector.mode)}`;
  if (!Array.isArray(vector.steps) || !vector.steps.every(isObject)) return "format: `steps` is a list of objects";
  return undefined;
}

/** Opens the vector's world with its static world, or names why it could not. */
function openWorld(physics, vector) {
  const made = physics.World.create(vector.world);
  if (!made.ok) return { problem: `World.create: ${made.code} ${made.detail}` };
  const { boxes = [], ramps = [] } = vector.static;
  if (boxes.length + ramps.length === 0) return { world: made.world };
  const added = made.world.addStaticWorld(vector.static);
  if (added.ok) return { world: made.world };
  made.world.free();
  return { problem: `addStaticWorld: ${added.code} ${added.detail}` };
}

function refusals(world, commands, atomic) {
  if (atomic) {
    const result = world.apply(commands, Mode.Atomic);
    return result.ok ? [] : [[result.index ?? null, result.code]];
  }
  const results = world.apply(commands, Mode.Each);
  return results.flatMap((result, index) => (result.ok ? [] : [[index, result.code]]));
}

function answer(result) {
  if (!result.ok) return { error: result.code };
  return "keys" in result ? { keys: result.keys } : { hit: result.hit };
}

/** What one entry observed, by the names an `expect` uses. */
function observed(world, refused, queries, last, expected) {
  const events = last?.events ?? [];
  return {
    stateHash: world.stateHash(),
    physicsHash: world.physicsHash(),
    refused,
    queries,
    escaped: last?.escaped ?? [],
    events: typeof expected.events === "number" ? events.length : events,
  };
}

/** Replaces `state.world` by a fresh world restored from its snapshot (§9.4); a problem or undefined. */
function snapshotRestore(physics, vector, state) {
  const fresh = openWorld(physics, vector);
  if (fresh.problem) return `snapshotRestore: ${fresh.problem}`;
  const restored = fresh.world.restore(state.world.snapshot());
  state.world.free();
  state.world = fresh.world;
  return restored.ok ? undefined : `restore: ${restored.code} ${restored.detail}`;
}

/** Steps `repeat` times; the last step's result, or a problem. */
function stepRepeatedly(world, repeat) {
  let last;
  for (let i = 0; i < repeat; i += 1) {
    last = world.step();
    if (!last.ok) return { problem: `step(): ${last.code} ${last.detail}` };
  }
  return { last };
}

/** One problem per pinned value of `expected` that `actual` does not give. */
function compare(expected, actual, index, state) {
  const problems = [];
  for (const [field, pinned] of Object.entries(expected)) {
    state.checks += 1;
    if (!EXPECT_FIELDS.has(field)) {
      problems.push(`step ${index}: ${field}: not a field this runner knows`);
      continue;
    }
    const got = asF32(actual[field]);
    if (!same(got, asF32(pinned))) {
      problems.push(`step ${index}: ${field}: pinned ${JSON.stringify(pinned)}, got ${JSON.stringify(got)}`);
    }
  }
  return problems;
}

/** Runs one entry on `state.world`: restore, apply, queries, steps, then its expectations. */
function runEntry(physics, vector, state, entry, index) {
  const restoreProblem = entry.snapshotRestore ? snapshotRestore(physics, vector, state) : undefined;
  if (restoreProblem) return [`step ${index}: ${restoreProblem}`];
  const refused = entry.apply ? refusals(state.world, entry.apply, vector.mode === Mode.Atomic) : [];
  const queries = (entry.query ?? []).map((query) => answer(state.world.query(query)));
  const stepped = stepRepeatedly(state.world, entry.repeat ?? 1);
  if (stepped.problem) return [`step ${index}: ${stepped.problem}`];
  const expected = isObject(entry.expect) ? entry.expect : {};
  return compare(expected, observed(state.world, refused, queries, stepped.last, expected), index, state);
}

/**
 * Runs one §16 vector on `physics` (the package's exports, after `init()` in a browser) and
 * answers `{ problems, checks, stateHash }`: every pinned value that differs, how many were
 * compared, and the world's last stateHash. A vector pinned on another build or contract, or
 * malformed, is one problem and opens no world. Never throws on a vector.
 */
export function runVector(physics, vector) {
  const reason = refusal(vector, buildWithoutTarget(physics.buildId()));
  if (reason) return { problems: [reason], checks: 0, stateHash: "" };
  const opened = openWorld(physics, vector);
  if (opened.problem) return { problems: [opened.problem], checks: 0, stateHash: "" };
  const state = { world: opened.world, checks: 0 };
  const problems = [];
  try {
    for (const [index, entry] of vector.steps.entries()) {
      problems.push(...runEntry(physics, vector, state, entry, index));
    }
    return { problems, checks: state.checks, stateHash: state.world.stateHash() };
  } finally {
    state.world.free();
  }
}
