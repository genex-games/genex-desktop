/*
 * A small JSON reader for the C tests of genex_physics.h (no dependency): a tree of values, each
 * keeping its raw span in the source text, so a vector's commands and queries reach the library as
 * the file spelled them. Objects keep their members in order; strings are decoded to UTF-8.
 * Header-only, for test programs: allocation failure aborts, and nothing is freed.
 */
#ifndef GXPH_TEST_JSON_H
#define GXPH_TEST_JSON_H

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef enum { JSON_NULL, JSON_BOOL, JSON_NUMBER, JSON_STRING, JSON_ARRAY, JSON_OBJECT } json_kind;

typedef struct json {
  json_kind kind;
  const char *raw; /* the value's own text in the source */
  size_t raw_len;
  int boolean;
  double number;
  char *string; /* decoded, NUL-terminated (strings) */
  struct json *items; /* array items or object values */
  char **keys;        /* object keys, decoded */
  size_t count;
} json;

typedef struct {
  const char *at;
  const char *end;
  const char *error;
} json_reader;

static void *json_alloc(size_t bytes) {
  void *memory = calloc(1, bytes ? bytes : 1);
  if (!memory) abort();
  return memory;
}

static void json_space(json_reader *r) {
  while (r->at < r->end && (*r->at == ' ' || *r->at == '\n' || *r->at == '\r' || *r->at == '\t')) r->at++;
}

static int json_value(json_reader *r, json *out, int depth);

static void json_put_utf8(char **cursor, uint32_t code) {
  char *c = *cursor;
  if (code < 0x80) {
    *c++ = (char)code;
  } else if (code < 0x800) {
    *c++ = (char)(0xC0 | (code >> 6));
    *c++ = (char)(0x80 | (code & 0x3F));
  } else if (code < 0x10000) {
    *c++ = (char)(0xE0 | (code >> 12));
    *c++ = (char)(0x80 | ((code >> 6) & 0x3F));
    *c++ = (char)(0x80 | (code & 0x3F));
  } else {
    *c++ = (char)(0xF0 | (code >> 18));
    *c++ = (char)(0x80 | ((code >> 12) & 0x3F));
    *c++ = (char)(0x80 | ((code >> 6) & 0x3F));
    *c++ = (char)(0x80 | (code & 0x3F));
  }
  *cursor = c;
}

static int json_hex4(json_reader *r, uint32_t *out) {
  if (r->end - r->at < 4) return 0;
  uint32_t value = 0;
  for (int i = 0; i < 4; i++) {
    char h = r->at[i];
    value <<= 4;
    if (h >= '0' && h <= '9') value |= (uint32_t)(h - '0');
    else if (h >= 'a' && h <= 'f') value |= (uint32_t)(h - 'a' + 10);
    else if (h >= 'A' && h <= 'F') value |= (uint32_t)(h - 'A' + 10);
    else return 0;
  }
  r->at += 4;
  *out = value;
  return 1;
}

/* Reads a string after its opening quote into a fresh decoded buffer. */
static char *json_string_body(json_reader *r) {
  const char *start = r->at;
  char *decoded = json_alloc((size_t)(r->end - start) + 1);
  char *c = decoded;
  while (r->at < r->end && *r->at != '"') {
    if (*r->at != '\\') {
      *c++ = *r->at++;
      continue;
    }
    r->at++;
    if (r->at >= r->end) break;
    char e = *r->at++;
    switch (e) {
      case '"': *c++ = '"'; break;
      case '\\': *c++ = '\\'; break;
      case '/': *c++ = '/'; break;
      case 'b': *c++ = '\b'; break;
      case 'f': *c++ = '\f'; break;
      case 'n': *c++ = '\n'; break;
      case 'r': *c++ = '\r'; break;
      case 't': *c++ = '\t'; break;
      case 'u': {
        uint32_t code;
        if (!json_hex4(r, &code)) return NULL;
        if (code >= 0xD800 && code < 0xDC00 && r->end - r->at >= 6 && r->at[0] == '\\' && r->at[1] == 'u') {
          uint32_t low;
          r->at += 2;
          if (!json_hex4(r, &low)) return NULL;
          code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        }
        json_put_utf8(&c, code);
        break;
      }
      default: return NULL;
    }
  }
  if (r->at >= r->end) return NULL;
  r->at++; /* the closing quote */
  *c = '\0';
  return decoded;
}

static int json_fail(json_reader *r, const char *why) {
  if (!r->error) r->error = why;
  return 0;
}

static int json_list(json_reader *r, json *out, int depth, int object) {
  size_t capacity = 8;
  out->items = json_alloc(capacity * sizeof(json));
  if (object) out->keys = json_alloc(capacity * sizeof(char *));
  char close = object ? '}' : ']';
  json_space(r);
  if (r->at < r->end && *r->at == close) {
    r->at++;
    return 1;
  }
  for (;;) {
    if (out->count == capacity) {
      capacity *= 2;
      out->items = realloc(out->items, capacity * sizeof(json));
      if (!out->items) abort();
      if (object) {
        out->keys = realloc(out->keys, capacity * sizeof(char *));
        if (!out->keys) abort();
      }
    }
    json_space(r);
    if (object) {
      if (r->at >= r->end || *r->at != '"') return json_fail(r, "an object key");
      r->at++;
      out->keys[out->count] = json_string_body(r);
      if (!out->keys[out->count]) return json_fail(r, "a key string");
      json_space(r);
      if (r->at >= r->end || *r->at != ':') return json_fail(r, "a colon");
      r->at++;
    }
    memset(&out->items[out->count], 0, sizeof(json));
    if (!json_value(r, &out->items[out->count], depth + 1)) return 0;
    out->count++;
    json_space(r);
    if (r->at < r->end && *r->at == ',') {
      r->at++;
      continue;
    }
    if (r->at < r->end && *r->at == close) {
      r->at++;
      return 1;
    }
    return json_fail(r, "a comma or a close");
  }
}

static int json_value(json_reader *r, json *out, int depth) {
  if (depth > 256) return json_fail(r, "nesting too deep");
  json_space(r);
  if (r->at >= r->end) return json_fail(r, "a value");
  const char *start = r->at;
  char c = *r->at;
  int ok = 1;
  if (c == '{' || c == '[') {
    r->at++;
    out->kind = c == '{' ? JSON_OBJECT : JSON_ARRAY;
    ok = json_list(r, out, depth, c == '{');
  } else if (c == '"') {
    r->at++;
    out->kind = JSON_STRING;
    out->string = json_string_body(r);
    ok = out->string != NULL || json_fail(r, "a string");
  } else if (r->end - r->at >= 4 && strncmp(r->at, "true", 4) == 0) {
    out->kind = JSON_BOOL, out->boolean = 1, r->at += 4;
  } else if (r->end - r->at >= 5 && strncmp(r->at, "false", 5) == 0) {
    out->kind = JSON_BOOL, out->boolean = 0, r->at += 5;
  } else if (r->end - r->at >= 4 && strncmp(r->at, "null", 4) == 0) {
    out->kind = JSON_NULL, r->at += 4;
  } else {
    const char *n = r->at;
    while (n < r->end && strchr("+-0123456789.eE", *n)) n++;
    if (n == r->at) return json_fail(r, "a number");
    char buffer[64];
    size_t len = (size_t)(n - r->at);
    if (len >= sizeof buffer) return json_fail(r, "a number too long");
    memcpy(buffer, r->at, len);
    buffer[len] = '\0';
    out->kind = JSON_NUMBER;
    out->number = strtod(buffer, NULL);
    r->at = n;
  }
  out->raw = start;
  out->raw_len = (size_t)(r->at - start);
  return ok;
}

/* Parses `len` bytes of `text` into `out`; 0 with a reason on failure. */
static int json_parse(const char *text, size_t len, json *out, const char **error) {
  json_reader r = {text, text + len, NULL};
  memset(out, 0, sizeof *out);
  int ok = json_value(&r, out, 0);
  json_space(&r);
  if (ok && r.at != r.end) ok = json_fail(&r, "trailing text");
  if (error) *error = r.error;
  return ok;
}

/* The member `key` of an object, or NULL. */
static const json *json_get(const json *object, const char *key) {
  if (!object || object->kind != JSON_OBJECT) return NULL;
  for (size_t i = 0; i < object->count; i++) {
    if (strcmp(object->keys[i], key) == 0) return &object->items[i];
  }
  return NULL;
}

/* Two numbers as f32, compared as JS's Object.is on Math.fround (so -0 is not 0). */
static int json_same_f32(double a, double b) {
  float fa = (float)a, fb = (float)b;
  if (isnan(fa) && isnan(fb)) return 1;
  uint32_t ba, bb;
  memcpy(&ba, &fa, 4);
  memcpy(&bb, &fb, 4);
  return ba == bb;
}

/* Structural equality of two values, numbers compared as f32, object members in any order. */
static int json_same(const json *a, const json *b) {
  if (a->kind != b->kind) return 0;
  switch (a->kind) {
    case JSON_NULL: return 1;
    case JSON_BOOL: return a->boolean == b->boolean;
    case JSON_NUMBER: return json_same_f32(a->number, b->number);
    case JSON_STRING: return strcmp(a->string, b->string) == 0;
    case JSON_ARRAY:
      if (a->count != b->count) return 0;
      for (size_t i = 0; i < a->count; i++) {
        if (!json_same(&a->items[i], &b->items[i])) return 0;
      }
      return 1;
    case JSON_OBJECT:
      if (a->count != b->count) return 0;
      for (size_t i = 0; i < a->count; i++) {
        const json *other = json_get(b, a->keys[i]);
        if (!other || !json_same(&a->items[i], other)) return 0;
      }
      return 1;
  }
  return 0;
}

#endif /* GXPH_TEST_JSON_H */
