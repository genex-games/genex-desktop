/*
 * The header test of genex_physics.h: it compiles as C11 and C++17 with every warning an error,
 * holds the layouts a host's binding (C#, GDExtension, Unreal) copies with static_assert, takes the
 * address of every declared function (so the link fails if the library lacks one, and the
 * prototypes must match the definitions' types), then runs a short life of one world through it.
 * scripts/physics-capi.ts checks the other direction: every gxph_ symbol the library exports is
 * declared here.
 */
#include "../../include/genex_physics.h"

#include <stdio.h>
#include <string.h>

#ifdef __cplusplus
#define STATIC_ASSERT static_assert
#define ALIGNOF alignof
#else
#include <assert.h>
#include <stdalign.h>
#define STATIC_ASSERT _Static_assert
#define ALIGNOF _Alignof
#endif
#include <stddef.h>

STATIC_ASSERT(sizeof(gxph_result) == 4, "gxph_result is a 32-bit int");
STATIC_ASSERT(sizeof(gxph_bytes) == 2 * sizeof(void *), "gxph_bytes is a pointer and a size_t");
STATIC_ASSERT(sizeof(size_t) == sizeof(void *), "size_t is pointer-sized on every target");
STATIC_ASSERT(offsetof(gxph_bytes, ptr) == 0, "ptr first");
STATIC_ASSERT(offsetof(gxph_bytes, len) == sizeof(void *), "len second, no padding");
STATIC_ASSERT(ALIGNOF(gxph_bytes) == ALIGNOF(void *), "gxph_bytes aligns as a pointer");
STATIC_ASSERT(GXPH_ARG_BYTES_MAX == (size_t)1073741824, "1 GiB");
STATIC_ASSERT(GXPH_OK == 0 && GXPH_ERR_ARG == 9, "the result codes are fixed");

#define ENTRY(name) {#name, (void (*)(void))(name)}
static const struct {
  const char *name;
  void (*address)(void);
} DECLARED[] = {
    ENTRY(gxph_abi_version),
    ENTRY(gxph_build_id),
    ENTRY(gxph_buf_free),
    ENTRY(gxph_live_worlds),
    ENTRY(gxph_world_create),
    ENTRY(gxph_world_free),
    ENTRY(gxph_world_check),
    ENTRY(gxph_world_desc),
    ENTRY(gxph_world_tick),
    ENTRY(gxph_world_command),
    ENTRY(gxph_world_apply),
    ENTRY(gxph_world_add_static),
    ENTRY(gxph_world_step),
    ENTRY(gxph_world_record_step_ms),
    ENTRY(gxph_world_tick_frame),
    ENTRY(gxph_world_body),
    ENTRY(gxph_world_bodies),
    ENTRY(gxph_world_export_changed),
    ENTRY(gxph_world_export_changed_rest),
    ENTRY(gxph_world_export_body_state),
    ENTRY(gxph_world_export_body_state_rest),
    ENTRY(gxph_world_import_body_state),
    ENTRY(gxph_world_import_states),
    ENTRY(gxph_world_import_states_rest),
    ENTRY(gxph_world_import_wire),
    ENTRY(gxph_world_canonicalize),
    ENTRY(gxph_world_body_desc_canonical),
    ENTRY(gxph_world_joint_desc_canonical),
    ENTRY(gxph_world_query),
    ENTRY(gxph_world_query_many),
    ENTRY(gxph_world_snapshot),
    ENTRY(gxph_world_restore),
    ENTRY(gxph_world_state_hash),
    ENTRY(gxph_world_physics_hash),
    ENTRY(gxph_world_stats),
    ENTRY(gxph_world_memory_bytes),
    ENTRY(gxph_world_memory_is_measured),
};

static int failures = 0;

#define EXPECT(condition)                                              \
  do {                                                                 \
    if (!(condition)) {                                                \
      fprintf(stderr, "header_test: %d: %s\n", __LINE__, #condition); \
      failures++;                                                      \
    }                                                                  \
  } while (0)

static const char DESC[] =
    "{\"contract\":\"1.0\",\"dt\":0.016666668,\"substeps\":1,\"gravity\":[0,-9.81,0],\"upAxis\":\"y\",\"lengthUnit\":1}";
static const char CRATE[] =
    "[{\"spawn\":{\"key\":\"crate\",\"type\":\"dynamic\",\"pose\":{\"p\":[0,2,0],\"q\":[0,0,0,1]},\"colliders\":[{\"key\":"
    "\"c\",\"shape\":{\"kind\":\"box\",\"half\":[0.5,0.5,0.5]}}]}}]";

int main(void) {
  size_t count = sizeof DECLARED / sizeof *DECLARED;
  for (size_t i = 0; i < count; i++) {
    EXPECT(DECLARED[i].address != NULL);
    printf("declared %s\n", DECLARED[i].name);
  }
  EXPECT(gxph_abi_version() == GXPH_ABI_VERSION);

  gxph_world *world = NULL;
  gxph_bytes reply = GXPH_BYTES_EMPTY;
  EXPECT(gxph_world_create(DESC, sizeof DESC - 1, &world, &reply) == GXPH_OK);
  EXPECT(world != NULL);
  EXPECT(reply.len > 0 && memcmp(reply.ptr, "{\"ok\":true", 10) == 0);
  gxph_bytes stale = reply;
  EXPECT(gxph_buf_free(&reply) == GXPH_OK);
  EXPECT(reply.ptr == NULL && reply.len == 0);
  EXPECT(gxph_buf_free(&stale) == GXPH_ERR_NOT_OURS);

  EXPECT(gxph_world_apply(world, CRATE, sizeof CRATE - 1, GXPH_APPLY_ATOMIC, &reply) == GXPH_OK);
  EXPECT(reply.len == 11 && memcmp(reply.ptr, "{\"ok\":true}", 11) == 0);
  EXPECT(gxph_buf_free(&reply) == GXPH_OK);
  for (int i = 0; i < 30; i++) {
    EXPECT(gxph_world_step(world, &reply) == GXPH_OK);
    EXPECT(gxph_buf_free(&reply) == GXPH_OK);
  }
  uint64_t tick = 0;
  EXPECT(gxph_world_tick(world, &tick) == GXPH_OK && tick == 30);

  gxph_bytes keys = GXPH_BYTES_EMPTY, data = GXPH_BYTES_EMPTY;
  EXPECT(gxph_world_export_changed(world, 0, &keys, &data) == GXPH_OK);
  EXPECT(data.len == 14 * sizeof(float) && ((uintptr_t)data.ptr % ALIGNOF(float)) == 0);
  const float *row = (const float *)(const void *)data.ptr;
  EXPECT(row[1] < 2.0f); /* the crate fell */
  EXPECT(gxph_buf_free(&keys) == GXPH_OK && gxph_buf_free(&data) == GXPH_OK);

  /* Hostile rows at the C boundary: each is refused and writes nothing. */
  EXPECT(gxph_world_step(world, NULL) == GXPH_ERR_NULL);
  EXPECT(gxph_world_command(world, NULL, 4, &reply) == GXPH_ERR_NULL && reply.ptr == NULL);
  EXPECT(gxph_world_command(world, "{}", (size_t)-1, &reply) == GXPH_ERR_LENGTH && reply.ptr == NULL);
  float floats[16] = {0};
  EXPECT(gxph_world_import_wire(world, "[]", 2, (const float *)(const void *)((const char *)floats + 1), 15, &reply) ==
         GXPH_ERR_ALIGN);
  EXPECT(gxph_world_apply(world, "\xff", 1, GXPH_APPLY_EACH, &reply) == GXPH_ERR_UTF8);
  EXPECT(gxph_world_apply(world, "[]", 2, 7, &reply) == GXPH_ERR_ARG);
  EXPECT(gxph_world_export_changed(world, 0, &keys, &keys) == GXPH_ERR_ARG);
  EXPECT(gxph_world_tick(world, &tick) == GXPH_OK && tick == 30);

  EXPECT(gxph_world_free(world) == GXPH_OK);
  EXPECT(gxph_world_free(world) == GXPH_ERR_NO_WORLD);
  EXPECT(gxph_world_step(world, &reply) == GXPH_OK);
  char text[512] = {0};
  memcpy(text, reply.ptr, reply.len < sizeof text - 1 ? reply.len : sizeof text - 1);
  EXPECT(strstr(text, "\"code\":\"internal\"") != NULL);
  EXPECT(gxph_buf_free(&reply) == GXPH_OK);
  uint32_t live = 99;
  EXPECT(gxph_live_worlds(&live) == GXPH_OK && live == 0);

  if (failures) return 1;
  printf("header_test: %zu functions declared, every check held\n", count);
  return 0;
}
