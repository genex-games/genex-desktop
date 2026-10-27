/*
 * The §16 conformance vectors replayed through the C ABI (genex_physics.h), the C twin of
 * genex-physics' tests/vectors.rs and js/conformance.js, reading §16's open details as they do
 * (vectors/README.md): repeat defaults to 1 and may be 0; events and escaped are the last step's;
 * a number under events is a count; refused is [[index, code], ...]; a query answer is {hit},
 * {keys} or {error}; numbers compare as f32; no mode is "each"; in "each" mode a failure of the
 * whole batch is one [null, code].
 *
 *   conformance <vector.json>...
 *
 * Prints one JSON line per vector: {"name", "problems": [...], "checks", "stateHash",
 * "physicsHash", "stepHashes": [stateHash after every step, in order]}. The step hashes are what
 * tests/conformance/physics-capi.test.ts holds equal, bit for bit, to the WASM and native packages
 * stepping the same vector. Exits 1 when any vector has a problem, 2 on a usage or I/O error.
 */
#include <stdarg.h>

#include "../../include/genex_physics.h"
#include "json.h"

/* A growable text buffer. */
typedef struct {
  char *text;
  size_t len, cap;
} buffer;

static void put(buffer *b, const char *text, size_t len) {
  if (b->len + len + 1 > b->cap) {
    b->cap = (b->len + len + 1) * 2;
    b->text = realloc(b->text, b->cap);
    if (!b->text) abort();
  }
  memcpy(b->text + b->len, text, len);
  b->len += len;
  b->text[b->len] = '\0';
}

static void puts_(buffer *b, const char *text) { put(b, text, strlen(text)); }

static void printf_(buffer *b, const char *format, ...) {
  char line[4096];
  va_list args;
  va_start(args, format);
  int n = vsnprintf(line, sizeof line, format, args);
  va_end(args);
  if (n > 0) put(b, line, (size_t)n < sizeof line ? (size_t)n : sizeof line - 1);
}

/* A JSON string literal of `text` (escaping quotes, backslashes and controls). */
static void put_string(buffer *b, const char *text, size_t len) {
  puts_(b, "\"");
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)text[i];
    if (c == '"' || c == '\\') {
      char escaped[2] = {'\\', (char)c};
      put(b, escaped, 2);
    } else if (c < 0x20) {
      printf_(b, "\\u%04x", c);
    } else {
      put(b, (const char *)&c, 1);
    }
  }
  puts_(b, "\"");
}

/* A failed ABI call ends the run: the vectors never pass a bad argument. */
static void must(gxph_result result, const char *call) {
  if (result == GXPH_OK) return;
  fprintf(stderr, "conformance: %s answered gxph_result %d\n", call, (int)result);
  exit(2);
}

/* Takes a reply as a NUL-terminated copy and gives the buffer back. */
static char *take(gxph_bytes *reply, size_t *len) {
  char *text = json_alloc(reply->len + 1);
  if (reply->len) memcpy(text, reply->ptr, reply->len);
  text[reply->len] = '\0';
  if (len) *len = reply->len;
  must(gxph_buf_free(reply), "gxph_buf_free");
  if (reply->ptr != NULL || reply->len != 0) {
    fprintf(stderr, "conformance: gxph_buf_free left the buffer set\n");
    exit(2);
  }
  return text;
}

static json parse_reply(gxph_bytes *reply) {
  size_t len;
  char *text = take(reply, &len);
  json value;
  const char *error;
  if (!json_parse(text, len, &value, &error)) {
    fprintf(stderr, "conformance: a reply is not JSON (%s): %s\n", error, text);
    exit(2);
  }
  return value;
}

static int is_ok(const json *reply) {
  const json *ok = json_get(reply, "ok");
  return ok && ok->kind == JSON_BOOL && ok->boolean;
}

static const char *code_of(const json *reply) {
  const json *code = json_get(reply, "code");
  return code && code->kind == JSON_STRING ? code->string : "?";
}

/* The state of one vector's run. */
typedef struct {
  const json *vector;
  gxph_world *world;
  buffer problems; /* JSON array items, comma-separated */
  size_t problem_count;
  size_t checks;
  buffer step_hashes;
  size_t steps;
} run;

static void problem(run *r, const char *format, ...) {
  char line[8192];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof line, format, args);
  va_end(args);
  if (r->problem_count++) puts_(&r->problems, ",");
  put_string(&r->problems, line, strlen(line));
}

static char *hash(gxph_world *world, int physics) {
  gxph_bytes out = GXPH_BYTES_EMPTY;
  must(physics ? gxph_world_physics_hash(world, &out) : gxph_world_state_hash(world, &out), "hash");
  return take(&out, NULL);
}

/* The flat static world: each list's row lengths and values. */
static void flatten(const json *rows, uint32_t **lengths, double **values, size_t *rows_n, size_t *values_n) {
  size_t total = 0;
  size_t n = rows ? rows->count : 0;
  for (size_t i = 0; i < n; i++) total += rows->items[i].count;
  *lengths = json_alloc((n ? n : 1) * sizeof(uint32_t));
  *values = json_alloc((total ? total : 1) * sizeof(double));
  size_t at = 0;
  for (size_t i = 0; i < n; i++) {
    (*lengths)[i] = (uint32_t)rows->items[i].count;
    for (size_t j = 0; j < rows->items[i].count; j++) (*values)[at++] = rows->items[i].items[j].number;
  }
  *rows_n = n;
  *values_n = total;
}

/* Opens the vector's world with its static world; NULL with a problem when it could not. */
static gxph_world *open_world(run *r) {
  const json *desc = json_get(r->vector, "world");
  gxph_world *world = NULL;
  gxph_bytes reply = GXPH_BYTES_EMPTY;
  must(gxph_world_create(desc->raw, desc->raw_len, &world, &reply), "gxph_world_create");
  json made = parse_reply(&reply);
  if (!world) {
    problem(r, "World.create: %s", code_of(&made));
    return NULL;
  }
  const json *statics = json_get(r->vector, "static");
  uint32_t *box_lengths, *ramp_lengths;
  double *boxes, *ramps;
  size_t box_rows, box_values, ramp_rows, ramp_values;
  flatten(json_get(statics, "boxes"), &box_lengths, &boxes, &box_rows, &box_values);
  flatten(json_get(statics, "ramps"), &ramp_lengths, &ramps, &ramp_rows, &ramp_values);
  if (box_rows + ramp_rows == 0) return world;
  must(gxph_world_add_static(world, box_lengths, box_rows, boxes, box_values, ramp_lengths, ramp_rows, ramps,
                             ramp_values, &reply),
       "gxph_world_add_static");
  json added = parse_reply(&reply);
  if (is_ok(&added)) return world;
  problem(r, "addStaticWorld: %s", code_of(&added));
  must(gxph_world_free(world), "gxph_world_free");
  return NULL;
}

/* Replaces the world by a fresh one restored from its snapshot (§9.4). */
static int snapshot_restore(run *r, size_t index) {
  gxph_world *fresh = open_world(r);
  if (!fresh) return 0;
  gxph_bytes snapshot = GXPH_BYTES_EMPTY;
  must(gxph_world_snapshot(r->world, &snapshot), "gxph_world_snapshot");
  gxph_bytes reply = GXPH_BYTES_EMPTY;
  must(gxph_world_restore(fresh, snapshot.ptr, snapshot.len, &reply), "gxph_world_restore");
  must(gxph_buf_free(&snapshot), "gxph_buf_free");
  json restored = parse_reply(&reply);
  must(gxph_world_free(r->world), "gxph_world_free");
  r->world = fresh;
  if (is_ok(&restored)) return 1;
  problem(r, "step %zu: restore: %s", index, code_of(&restored));
  return 0;
}

/* The refusals of one apply, as JSON text [[index, code], ...]. */
static void refusals(run *r, const json *commands, int atomic, buffer *out) {
  gxph_bytes reply = GXPH_BYTES_EMPTY;
  must(gxph_world_apply(r->world, commands->raw, commands->raw_len, atomic ? GXPH_APPLY_ATOMIC : GXPH_APPLY_EACH,
                        &reply),
       "gxph_world_apply");
  json applied = parse_reply(&reply);
  puts_(out, "[");
  if (!is_ok(&applied)) {
    const json *index = json_get(&applied, "index");
    if (index && index->kind == JSON_NUMBER && atomic) printf_(out, "[%.17g,", index->number);
    else puts_(out, "[null,");
    put_string(out, code_of(&applied), strlen(code_of(&applied)));
    puts_(out, "]");
  } else if (!atomic) {
    const json *results = json_get(&applied, "results");
    int first = 1;
    for (size_t i = 0; results && i < results->count; i++) {
      if (is_ok(&results->items[i])) continue;
      printf_(out, "%s[%zu,", first ? "" : ",", i);
      put_string(out, code_of(&results->items[i]), strlen(code_of(&results->items[i])));
      puts_(out, "]");
      first = 0;
    }
  }
  puts_(out, "]");
}

/* One query's answer as JSON text: {"hit": ...}, {"keys": [...]} or {"error": code}. */
static void answer(run *r, const json *query, buffer *out) {
  gxph_bytes reply = GXPH_BYTES_EMPTY;
  must(gxph_world_query(r->world, query->raw, query->raw_len, &reply), "gxph_world_query");
  json answered = parse_reply(&reply);
  if (!is_ok(&answered)) {
    puts_(out, "{\"error\":");
    put_string(out, code_of(&answered), strlen(code_of(&answered)));
    puts_(out, "}");
    return;
  }
  const json *keys = json_get(&answered, "keys");
  const json *hit = json_get(&answered, "hit");
  const json *chosen = keys ? keys : hit;
  puts_(out, keys ? "{\"keys\":" : "{\"hit\":");
  if (chosen) put(out, chosen->raw, chosen->raw_len);
  else puts_(out, "null");
  puts_(out, "}");
}

/* Steps `repeat` times, recording the stateHash after each; the last step's reply or none. */
static int step_repeatedly(run *r, size_t index, double repeat, json *last, int *stepped) {
  *stepped = 0;
  for (double i = 0; i < repeat; i++) {
    gxph_bytes reply = GXPH_BYTES_EMPTY;
    must(gxph_world_step(r->world, &reply), "gxph_world_step");
    *last = parse_reply(&reply);
    *stepped = 1;
    if (!is_ok(last)) {
      problem(r, "step %zu: step(): %s", index, code_of(last));
      return 0;
    }
    char *state = hash(r->world, 0);
    if (r->steps++) puts_(&r->step_hashes, ",");
    put_string(&r->step_hashes, state, strlen(state));
    free(state);
  }
  return 1;
}

/* Compares one pinned field against what this run observed (`observed` is JSON text). */
static void check(run *r, size_t index, const char *field, const json *pinned, const char *observed) {
  r->checks++;
  json got;
  const char *error;
  if (!json_parse(observed, strlen(observed), &got, &error)) {
    problem(r, "step %zu: %s: the runner built no JSON (%s)", index, field, error);
    return;
  }
  if (!json_same(&got, pinned)) {
    problem(r, "step %zu: %s: pinned %.*s, got %s", index, field, (int)pinned->raw_len, pinned->raw, observed);
  }
}

static const char *const EXPECT_FIELDS[] = {"stateHash", "physicsHash", "refused", "queries", "escaped", "events"};

static int known_field(const char *field) {
  for (size_t i = 0; i < sizeof EXPECT_FIELDS / sizeof *EXPECT_FIELDS; i++) {
    if (strcmp(field, EXPECT_FIELDS[i]) == 0) return 1;
  }
  return 0;
}

/* The observed value of one expect field as JSON text. */
static void observe(run *r, const char *field, const json *pinned, const json *last, int stepped, const char *refused,
                    const char *queries, buffer *out) {
  if (strcmp(field, "stateHash") == 0 || strcmp(field, "physicsHash") == 0) {
    char *value = hash(r->world, field[0] == 'p');
    put_string(out, value, strlen(value));
    free(value);
    return;
  }
  if (strcmp(field, "refused") == 0 || strcmp(field, "queries") == 0) {
    puts_(out, field[0] == 'r' ? refused : queries);
    return;
  }
  const json *list = stepped ? json_get(last, field) : NULL;
  if (strcmp(field, "events") == 0 && pinned->kind == JSON_NUMBER) {
    printf_(out, "%zu", list ? list->count : 0);
    return;
  }
  if (list) put(out, list->raw, list->raw_len);
  else puts_(out, "[]");
}

/* Runs one entry: restore, apply, queries, steps, then its expectations. */
static void run_entry(run *r, const json *entry, size_t index) {
  const json *restore = json_get(entry, "snapshotRestore");
  if (restore && restore->kind == JSON_BOOL && restore->boolean && !snapshot_restore(r, index)) return;
  const json *mode = json_get(r->vector, "mode");
  int atomic = mode && strcmp(mode->string, "atomic") == 0;
  buffer refused = {0};
  const json *apply = json_get(entry, "apply");
  if (apply) refusals(r, apply, atomic, &refused);
  else puts_(&refused, "[]");
  buffer queries = {0};
  puts_(&queries, "[");
  const json *query = json_get(entry, "query");
  for (size_t i = 0; query && i < query->count; i++) {
    if (i) puts_(&queries, ",");
    answer(r, &query->items[i], &queries);
  }
  puts_(&queries, "]");
  const json *repeat = json_get(entry, "repeat");
  json last;
  int stepped;
  if (!step_repeatedly(r, index, repeat ? repeat->number : 1, &last, &stepped)) return;
  const json *expect = json_get(entry, "expect");
  for (size_t i = 0; expect && expect->kind == JSON_OBJECT && i < expect->count; i++) {
    const char *field = expect->keys[i];
    if (!known_field(field)) {
      r->checks++;
      problem(r, "step %zu: %s: not a field this runner knows", index, field);
      continue;
    }
    buffer observed = {0};
    observe(r, field, &expect->items[i], &last, stepped, refused.text, queries.text, &observed);
    check(r, index, field, &expect->items[i], observed.text);
  }
}

/* The build a vector is pinned on: this library's buildId without its `+<target>`. */
static char *pinned_build(void) {
  gxph_bytes out = GXPH_BYTES_EMPTY;
  must(gxph_build_id(&out), "gxph_build_id");
  char *id = take(&out, NULL);
  char *cut = strrchr(id, '+');
  if (cut) *cut = '\0';
  return id;
}

static char *read_file(const char *file, size_t *len) {
  FILE *f = fopen(file, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *text = json_alloc((size_t)size + 1);
  *len = fread(text, 1, (size_t)size, f);
  fclose(f);
  return text;
}

/* Runs one vector file and prints its line; 1 when it had a problem. */
static int run_vector(const char *file, const char *build) {
  size_t len;
  char *text = read_file(file, &len);
  json vector;
  const char *error;
  if (!text || !json_parse(text, len, &vector, &error)) {
    fprintf(stderr, "conformance: cannot read %s\n", file);
    exit(2);
  }
  run r = {.vector = &vector};
  const json *name = json_get(&vector, "name");
  const json *pinned = json_get(&vector, "build");
  const json *contract = json_get(&vector, "contract");
  if (!pinned || pinned->kind != JSON_STRING || strcmp(pinned->string, build) != 0) {
    problem(&r, "build: the vector is pinned on another build than %s", build);
  } else if (!contract || contract->kind != JSON_STRING || strcmp(contract->string, "1.0") != 0) {
    problem(&r, "contract: this runner reads 1.0");
  } else {
    r.world = open_world(&r);
  }
  const json *steps = json_get(&vector, "steps");
  for (size_t i = 0; r.world && steps && i < steps->count; i++) run_entry(&r, &steps->items[i], i);
  buffer line = {0};
  puts_(&line, "{\"name\":");
  put_string(&line, name ? name->string : file, strlen(name ? name->string : file));
  puts_(&line, ",\"problems\":[");
  if (r.problem_count) puts_(&line, r.problems.text);
  printf_(&line, "],\"checks\":%zu", r.checks);
  if (r.world) {
    char *state = hash(r.world, 0);
    char *physics = hash(r.world, 1);
    puts_(&line, ",\"stateHash\":");
    put_string(&line, state, strlen(state));
    puts_(&line, ",\"physicsHash\":");
    put_string(&line, physics, strlen(physics));
    must(gxph_world_free(r.world), "gxph_world_free");
  }
  puts_(&line, ",\"stepHashes\":[");
  if (r.steps) puts_(&line, r.step_hashes.text);
  puts_(&line, "]}");
  printf("%s\n", line.text);
  return r.problem_count > 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: conformance <vector.json>...\n");
    return 2;
  }
  if (gxph_abi_version() != GXPH_ABI_VERSION) {
    fprintf(stderr, "conformance: the library is ABI %u, this header %u\n", gxph_abi_version(), GXPH_ABI_VERSION);
    return 2;
  }
  char *build = pinned_build();
  int failed = 0;
  for (int i = 1; i < argc; i++) failed |= run_vector(argv[i], build);
  uint32_t live = 1;
  must(gxph_live_worlds(&live), "gxph_live_worlds");
  if (live != 0) {
    fprintf(stderr, "conformance: %u worlds left alive\n", live);
    return 2;
  }
  return failed;
}
