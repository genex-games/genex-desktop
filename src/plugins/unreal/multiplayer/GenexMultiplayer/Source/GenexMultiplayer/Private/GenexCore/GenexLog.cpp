#include "GenexCore/GenexLog.h"

#include <cstdio>
#include <utility>

namespace genex::log_detail {

struct LogState {
  LogSink sink;
  LogLevel threshold = LogLevel::Info;
};

LogState& State() {
  static LogState state;
  return state;
}

void DefaultSink(LogLevel level, const std::string& message) {
  std::fprintf(stderr, "[genex] %s: %s\n", LogLevelName(level), message.c_str());
  std::fflush(stderr);
}

}  // namespace genex::log_detail

namespace genex {

void Log(LogLevel level, const std::string& message) {
  log_detail::LogState& state = log_detail::State();
  if (static_cast<int>(level) < static_cast<int>(state.threshold)) return;
  if (state.sink) {
    state.sink(level, message);
  } else {
    log_detail::DefaultSink(level, message);
  }
}

void SetLogSink(LogSink sink) { log_detail::State().sink = std::move(sink); }

void SetLogLevel(LogLevel level) { log_detail::State().threshold = level; }

LogLevel GetLogLevel() { return log_detail::State().threshold; }

const char* LogLevelName(LogLevel level) {
  switch (level) {
    case LogLevel::Debug:
      return "debug";
    case LogLevel::Info:
      return "info";
    case LogLevel::Warning:
      return "warning";
    case LogLevel::Error:
      return "error";
  }
  return "unknown";
}

}  // namespace genex
