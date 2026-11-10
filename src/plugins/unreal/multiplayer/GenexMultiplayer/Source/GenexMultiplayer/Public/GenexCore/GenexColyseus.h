// The ONLY include of the official Colyseus C core (colyseus/native-sdk v0.18.10, fetched and
// sha-pinned by sdks/unreal/scripts/fetch-colyseus.sh and core/cmake/FetchColyseus.cmake). Every
// GenexCore file that needs the C API includes this header, never <colyseus.h> itself, so the
// third-party warning wrapper is applied exactly once and in one place.
#pragma once

#include "GenexCore/GenexConfig.h"

GENEX_THIRD_PARTY_INCLUDES_START
#include <colyseus.h>
GENEX_THIRD_PARTY_INCLUDES_END
