/*
 * A panic inside the library never unwinds into C: the call answers GXPH_ERR_PANIC, this process
 * carries on, and the library is poisoned (every later call answers the same). Needs the test
 * build's gxph_test_panic (feature test-panic), so it is declared here, never in the header.
 */
#include "../../include/genex_physics.h"

#include <stdio.h>

gxph_result gxph_test_panic(void);

int main(void) {
  uint32_t live = 99;
  if (gxph_live_worlds(&live) != GXPH_OK) return 1;
  if (gxph_test_panic() != GXPH_ERR_PANIC) return 2;
  if (gxph_live_worlds(&live) != GXPH_ERR_PANIC) return 3;
  gxph_bytes out = GXPH_BYTES_EMPTY;
  if (gxph_build_id(&out) != GXPH_ERR_PANIC || out.ptr != NULL) return 4;
  if (gxph_abi_version() != GXPH_ABI_VERSION) return 5;
  printf("panic_test: the panic was caught at the boundary and the library is poisoned\n");
  return 0;
}
