// GenexCore logging. The core never writes stdout (a tool's stdout may be a protocol, e.g. the
// conformance driver's); every message goes through Log() to one process-wide sink. The default
// sink writes `[genex] <level>: <message>` to stderr; the UE module installs a UE_LOG sink.
// Never log tokens, tickets or reconnection tokens.
//
// Single-threaded like the rest of GenexCore: set the sink and log from the pumping thread.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <functional>
#include <string>

namespace genex {

enum class LogLevel { Debug, Info, Warning, Error };

using LogSink = std::function<void(LogLevel, const std::string&)>;

/** Send `message` to the current sink, unless `level` is below the threshold (SetLogLevel). */
GENEX_CORE_API void Log(LogLevel level, const std::string& message);

/** Replace the sink. An empty function restores the default stderr sink. */
GENEX_CORE_API void SetLogSink(LogSink sink);

/** Messages below `level` are dropped before they reach any sink. Default: Info. */
GENEX_CORE_API void SetLogLevel(LogLevel level);
GENEX_CORE_API LogLevel GetLogLevel();

/** "debug", "info", "warning", "error". */
GENEX_CORE_API const char* LogLevelName(LogLevel level);

}  // namespace genex
