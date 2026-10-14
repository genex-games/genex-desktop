// genex-frames.node: the receive-only frames addon for Electron main (N-API 8, ABI-stable).
//
//   const ch = addon.open(runId, onEvent, { maxFps, burst, pid });
//   ch.serviceName                 // "games.genex.frames.<runId>", for the game profile
//   ch.setPeer(pid)                // the only process allowed to send
//   ch.expectRing({ generation, width, height, slots })
//   ch.release(generation, slot, seq)  // after Electron's allReferencesReleased
//   ch.stats(); ch.close();
//
// onEvent gets { type: "frame", generation, slot, seq, ts, receivedAt, width, height,
// pixelFormat: "bgra", surfaceId, ioSurface } where ioSurface is the 8-byte IOSurfaceRef that
// sharedTexture.importSharedTexture expects, valid until release(generation, slot, seq) or
// close() (and at least until the callback returns: each queued event holds its own reference).
// A refused message gives one { type: "error", code, fatal: true, generation?, slot? } and the
// run delivers nothing more: the host kills the game. A background thread receives; events
// reach JavaScript through a thread-safe function.
#define NAPI_VERSION 8
#include <node_api.h>

#include <atomic>
#include <cstring>
#include <memory>
#include <string>
#include <thread>

#include "gxf_channel.h"

namespace {

constexpr size_t kEventQueueLimit = 16;
constexpr uint32_t kAbiVersion = 1;
constexpr size_t kRunIdBuffer = 80;
constexpr napi_type_tag kRunTag = {0x67656e6578667261ull, 0x6d65732d72756e31ull};

struct Run {
  gxf::Channel channel;
  std::thread receiver;
  napi_threadsafe_function tsfn = nullptr;
  bool closed = false;  // JavaScript thread only
  int refs = 2;         // the wrapper object and the thread-safe function; JavaScript thread only
};

#define CHECK_NAPI(call)                   \
  do {                                     \
    if ((call) != napi_ok) return nullptr; \
  } while (0)

napi_value Throw(napi_env env, const char* code, const char* message) {
  napi_value js_code = nullptr;
  napi_value js_message = nullptr;
  napi_value error = nullptr;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &js_code);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &js_message);
  napi_create_error(env, js_code, js_message, &error);
  napi_throw(env, error);
  return nullptr;
}

void SetNumber(napi_env env, napi_value object, const char* key, double value) {
  napi_value number = nullptr;
  napi_create_double(env, value, &number);
  napi_set_named_property(env, object, key, number);
}

void SetString(napi_env env, napi_value object, const char* key, const char* value) {
  napi_value string = nullptr;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &string);
  napi_set_named_property(env, object, key, string);
}

void SetBool(napi_env env, napi_value object, const char* key, bool value) {
  napi_value boolean = nullptr;
  napi_get_boolean(env, value, &boolean);
  napi_set_named_property(env, object, key, boolean);
}

napi_value FrameValue(napi_env env, const gxf::Frame& frame) {
  napi_value object = nullptr;
  CHECK_NAPI(napi_create_object(env, &object));
  SetString(env, object, "type", "frame");
  SetNumber(env, object, "generation", frame.generation);
  SetNumber(env, object, "slot", frame.slot);
  SetNumber(env, object, "seq", static_cast<double>(frame.seq));
  SetNumber(env, object, "ts", static_cast<double>(frame.ts_us));
  SetNumber(env, object, "receivedAt", static_cast<double>(frame.received_us));
  SetNumber(env, object, "width", frame.width);
  SetNumber(env, object, "height", frame.height);
  SetString(env, object, "pixelFormat", "bgra");
  SetNumber(env, object, "surfaceId", frame.surface_id);
  // Electron reads `handle.ioSurface` as a Buffer holding the IOSurfaceRef pointer value.
  napi_value buffer = nullptr;
  void* unused = nullptr;
  CHECK_NAPI(napi_create_buffer_copy(env, sizeof frame.surface, &frame.surface, &unused, &buffer));
  napi_set_named_property(env, object, "ioSurface", buffer);
  return object;
}

napi_value ErrorValue(napi_env env, const gxf::Event& event) {
  napi_value object = nullptr;
  CHECK_NAPI(napi_create_object(env, &object));
  SetString(env, object, "type", "error");
  SetString(env, object, "code", gxf_code_name(event.code));
  SetBool(env, object, "fatal", gxf_code_is_fatal(event.code) != 0);
  if (event.has_slot) {
    SetNumber(env, object, "generation", event.generation);
    SetNumber(env, object, "slot", event.slot);
  }
  return object;
}

// A queued frame event owns one reference to its surface, so a release() that races ahead of the
// event (a JavaScript bug) cannot leave the event's ioSurface pointer dangling.
struct EventDeleter {
  void operator()(gxf::Event* event) const {
    if (event->kind == gxf::Event::Kind::kFrame && event->frame.surface != nullptr) CFRelease(event->frame.surface);
    delete event;
  }
};
using EventPtr = std::unique_ptr<gxf::Event, EventDeleter>;

void CallJs(napi_env env, napi_value callback, void* context, void* data) {
  EventPtr event(static_cast<gxf::Event*>(data));
  if (env == nullptr || callback == nullptr) return;
  auto* run = static_cast<Run*>(context);
  if (run->closed) return;
  napi_value value = event->kind == gxf::Event::Kind::kFrame ? FrameValue(env, event->frame) : ErrorValue(env, *event);
  if (value == nullptr) return;
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  napi_call_function(env, undefined, callback, 1, &value, nullptr);
}

// The receiving thread. Blocking posts: frames are bounded by the ring, so a slow JavaScript
// thread back-pressures the game instead of growing a queue. close() aborts the function first,
// which wakes a blocked post.
void ReceiveLoop(Run* run, napi_threadsafe_function tsfn) {
  for (;;) {
    gxf::Event event = run->channel.ReceiveOne(MACH_MSG_TIMEOUT_NONE);
    if (event.kind == gxf::Event::Kind::kWoken || event.kind == gxf::Event::Kind::kTimeout) return;
    if (event.kind == gxf::Event::Kind::kDropped) continue;
    if (event.kind == gxf::Event::Kind::kFrame) CFRetain(event.frame.surface);
    auto* item = new gxf::Event(event);
    if (napi_call_threadsafe_function(tsfn, item, napi_tsfn_blocking) != napi_ok) {
      EventPtr dropped(item);
      return;
    }
    if (event.code == GXF_E_RECEIVE_FAILED) return;
  }
}

void StopReceiver(Run* run) {
  run->channel.Wake();
  if (run->receiver.joinable()) run->receiver.join();
  run->channel.Close();
}

void CloseRun(Run* run) {
  if (run->closed) return;
  run->closed = true;
  if (run->tsfn != nullptr) {
    napi_release_threadsafe_function(run->tsfn, napi_tsfn_abort);
    run->tsfn = nullptr;
  }
  StopReceiver(run);
}

void ReleaseRef(Run* run) {
  if (--run->refs == 0) delete run;
}

// Runs when the function closes: after close(), or at environment teardown without one.
void TsfnFinalize(napi_env, void* data, void*) {
  auto* run = static_cast<Run*>(data);
  run->tsfn = nullptr;
  if (!run->closed) {
    run->closed = true;
    StopReceiver(run);
  }
  ReleaseRef(run);
}

void WrapperFinalize(napi_env, void* data, void*) {
  auto* run = static_cast<Run*>(data);
  CloseRun(run);
  ReleaseRef(run);
}

Run* UnwrapRun(napi_env env, napi_callback_info info, size_t* argc, napi_value* argv) {
  napi_value self = nullptr;
  if (napi_get_cb_info(env, info, argc, argv, &self, nullptr) != napi_ok) return nullptr;
  bool tagged = false;
  if (napi_check_object_type_tag(env, self, &kRunTag, &tagged) != napi_ok || !tagged) {
    napi_throw_type_error(env, "invalid-receiver", "not a frames channel");
    return nullptr;
  }
  void* data = nullptr;
  if (napi_unwrap(env, self, &data) != napi_ok || data == nullptr) {
    napi_throw_type_error(env, "invalid-receiver", "not a frames channel");
    return nullptr;
  }
  return static_cast<Run*>(data);
}

bool GetUint32(napi_env env, napi_value value, uint32_t* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok) return false;
  if (!(number >= 0 && number <= 4294967295.0) || number != static_cast<double>(static_cast<uint32_t>(number)))
    return false;
  *out = static_cast<uint32_t>(number);
  return true;
}

bool GetOptionalUint32(napi_env env, napi_value object, const char* key, uint32_t* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object) return true;
  bool has = false;
  if (napi_has_named_property(env, object, key, &has) != napi_ok || !has) return true;
  napi_value value = nullptr;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return false;
  napi_valuetype value_type = napi_undefined;
  napi_typeof(env, value, &value_type);
  if (value_type == napi_undefined) return true;
  return GetUint32(env, value, out);
}

bool ReadRunId(napi_env env, napi_value value, std::string* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  char buffer[kRunIdBuffer] = {};
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, buffer, sizeof buffer, &length) != napi_ok) return false;
  if (length >= sizeof buffer - 1) return false;
  out->assign(buffer, length);
  return gxf::ValidRunId(*out);
}

struct OpenOptions {
  uint32_t max_fps = GXF_DEFAULT_MAX_FPS;
  uint32_t burst = GXF_DEFAULT_BURST;
  uint32_t pid = 0;
};

bool ReadOpenOptions(napi_env env, napi_value options, OpenOptions* out) {
  return GetOptionalUint32(env, options, "maxFps", &out->max_fps) &&
         GetOptionalUint32(env, options, "burst", &out->burst) && GetOptionalUint32(env, options, "pid", &out->pid);
}

napi_value DefineServiceName(napi_env env, napi_value self, const std::string& name) {
  napi_value value = nullptr;
  CHECK_NAPI(napi_create_string_utf8(env, name.c_str(), name.size(), &value));
  napi_property_descriptor property = {"serviceName", nullptr, nullptr,         nullptr,
                                       nullptr,       value,   napi_enumerable, nullptr};
  CHECK_NAPI(napi_define_properties(env, self, 1, &property));
  return self;
}

// new FramesChannel(runId, onEvent, options?)
napi_value Construct(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  napi_value self = nullptr;
  CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, &self, nullptr));
  napi_value new_target = nullptr;
  CHECK_NAPI(napi_get_new_target(env, info, &new_target));
  if (new_target == nullptr) return Throw(env, "invalid-receiver", "use open() or new FramesChannel()");
  std::string run_id;
  if (argc < 2 || !ReadRunId(env, argv[0], &run_id))
    return Throw(env, "invalid-run-id", "runId must match [A-Za-z0-9-]{8,64}");
  napi_valuetype callback_type = napi_undefined;
  napi_typeof(env, argv[1], &callback_type);
  if (callback_type != napi_function) return Throw(env, "invalid-callback", "onEvent must be a function");
  OpenOptions options;
  if (argc > 2 && !ReadOpenOptions(env, argv[2], &options))
    return Throw(env, "invalid-options", "maxFps, burst and pid must be uint32");
  auto run = std::make_unique<Run>();
  kern_return_t kr = run->channel.Open(run_id, options.max_fps, options.burst);
  if (kr != KERN_SUCCESS) {
    std::string message = "bootstrap_check_in failed: kern_return " + std::to_string(kr);
    return Throw(env, "check-in-failed", message.c_str());
  }
  if (options.pid != 0 && !run->channel.SetPeer(static_cast<pid_t>(options.pid)))
    return Throw(env, "invalid-options", "pid");
  napi_value resource = nullptr;
  CHECK_NAPI(napi_create_string_utf8(env, "genex-frames", NAPI_AUTO_LENGTH, &resource));
  Run* raw = run.get();
  if (napi_create_threadsafe_function(env, argv[1], nullptr, resource, kEventQueueLimit, 1, raw, TsfnFinalize, raw,
                                      CallJs, &raw->tsfn) != napi_ok) {
    return Throw(env, "internal", "thread-safe function");
  }
  run.release();
  if (napi_wrap(env, self, raw, WrapperFinalize, nullptr, nullptr) != napi_ok ||
      napi_type_tag_object(env, self, &kRunTag) != napi_ok) {
    raw->refs = 1;  // only the function's finalizer remains
    CloseRun(raw);
    return Throw(env, "internal", "wrap");
  }
  raw->receiver = std::thread(ReceiveLoop, raw, raw->tsfn);
  return DefineServiceName(env, self, raw->channel.service_name());
}

napi_value SetPeer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  Run* run = UnwrapRun(env, info, &argc, argv);
  if (run == nullptr) return nullptr;
  if (run->closed) return Throw(env, "closed", "channel is closed");
  uint32_t pid = 0;
  if (argc < 1 || !GetUint32(env, argv[0], &pid) || pid == 0 || pid > INT32_MAX)
    return Throw(env, "invalid-pid", "pid");
  napi_value result = nullptr;
  napi_get_boolean(env, run->channel.SetPeer(static_cast<pid_t>(pid)), &result);
  return result;
}

napi_value ExpectRing(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  Run* run = UnwrapRun(env, info, &argc, argv);
  if (run == nullptr) return nullptr;
  if (run->closed) return Throw(env, "closed", "channel is closed");
  napi_valuetype type = napi_undefined;
  if (argc < 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_object)
    return Throw(env, "invalid-ring-size", "expectRing({generation, width, height, slots})");
  uint32_t fields[4] = {0, 0, 0, 0};
  const char* keys[4] = {"generation", "width", "height", "slots"};
  for (int i = 0; i < 4; i++) {
    napi_value value = nullptr;
    if (napi_get_named_property(env, argv[0], keys[i], &value) != napi_ok || !GetUint32(env, value, &fields[i]))
      return Throw(env, "invalid-ring-size", keys[i]);
  }
  gxf_ring_error error = run->channel.ExpectRing(fields[0], fields[1], fields[2], fields[3]);
  if (error != GXF_RING_OK) return Throw(env, gxf_ring_error_name(error), "ring refused");
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  return undefined;
}

napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  Run* run = UnwrapRun(env, info, &argc, argv);
  if (run == nullptr) return nullptr;
  uint32_t generation = 0;
  uint32_t slot = 0;
  double seq = -1;
  napi_valuetype seq_type = napi_undefined;
  if (argc < 3 || !GetUint32(env, argv[0], &generation) || !GetUint32(env, argv[1], &slot) ||
      napi_typeof(env, argv[2], &seq_type) != napi_ok || seq_type != napi_number ||
      napi_get_value_double(env, argv[2], &seq) != napi_ok || !(seq >= 0 && seq <= static_cast<double>(GXF_MAX_SEQ)) ||
      seq != static_cast<double>(static_cast<uint64_t>(seq)))
    return Throw(env, "invalid-slot", "release(generation, slot, seq)");
  bool released =
      slot < GXF_MAX_SLOTS && run->channel.Release(generation, static_cast<uint16_t>(slot), static_cast<uint64_t>(seq));
  napi_value result = nullptr;
  napi_get_boolean(env, released, &result);
  return result;
}

napi_value Stats(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  Run* run = UnwrapRun(env, info, &argc, nullptr);
  if (run == nullptr) return nullptr;
  gxf::Stats stats = run->channel.GetStats();
  napi_value object = nullptr;
  CHECK_NAPI(napi_create_object(env, &object));
  SetNumber(env, object, "received", static_cast<double>(stats.counters.received));
  SetNumber(env, object, "accepted", static_cast<double>(stats.counters.accepted));
  SetNumber(env, object, "refused", static_cast<double>(stats.counters.refused));
  SetNumber(env, object, "dropped", static_cast<double>(stats.counters.dropped));
  SetNumber(env, object, "released", static_cast<double>(stats.counters.released));
  SetNumber(env, object, "generation", stats.generation);
  SetNumber(env, object, "heldMask", stats.held_mask);
  SetNumber(env, object, "retiredHeld", static_cast<double>(stats.retired_held));
  SetNumber(env, object, "peer", stats.peer);
  SetBool(env, object, "open", stats.open && !run->closed);
  if (stats.fault != GXF_OK) {
    SetString(env, object, "fault", gxf_code_name(stats.fault));
  } else {
    napi_value null_value = nullptr;
    napi_get_null(env, &null_value);
    napi_set_named_property(env, object, "fault", null_value);
  }
  return object;
}

napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  Run* run = UnwrapRun(env, info, &argc, nullptr);
  if (run == nullptr) return nullptr;
  CloseRun(run);
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  return undefined;
}

void DeleteConstructorRef(napi_env env, void* data, void*) { napi_delete_reference(env, static_cast<napi_ref>(data)); }

// open(runId, onEvent, options?) = new FramesChannel(...)
napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  CHECK_NAPI(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  void* data = nullptr;
  CHECK_NAPI(napi_get_instance_data(env, &data));
  napi_value constructor = nullptr;
  CHECK_NAPI(napi_get_reference_value(env, static_cast<napi_ref>(data), &constructor));
  napi_value instance = nullptr;
  napi_new_instance(env, constructor, argc, argv, &instance);
  return instance;
}

napi_value ErrorCodes(napi_env env) {
  napi_value object = nullptr;
  CHECK_NAPI(napi_create_object(env, &object));
  for (int code = GXF_OK + 1; code < GXF_E_COUNT; code++) {
    const gxf_code typed = static_cast<gxf_code>(code);
    SetBool(env, object, gxf_code_name(typed), gxf_code_is_fatal(typed) != 0);
  }
  return object;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
      {"setPeer", nullptr, SetPeer, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"expectRing", nullptr, ExpectRing, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_value constructor = nullptr;
  CHECK_NAPI(napi_define_class(env, "FramesChannel", NAPI_AUTO_LENGTH, Construct, nullptr,
                               sizeof methods / sizeof methods[0], methods, &constructor));
  napi_ref constructor_ref = nullptr;
  CHECK_NAPI(napi_create_reference(env, constructor, 1, &constructor_ref));
  CHECK_NAPI(napi_set_instance_data(env, constructor_ref, DeleteConstructorRef, nullptr));
  napi_value open = nullptr;
  CHECK_NAPI(napi_create_function(env, "open", NAPI_AUTO_LENGTH, Open, nullptr, &open));
  napi_set_named_property(env, exports, "FramesChannel", constructor);
  napi_set_named_property(env, exports, "open", open);
  napi_set_named_property(env, exports, "errorCodes", ErrorCodes(env));
  SetNumber(env, exports, "abiVersion", kAbiVersion);
  SetNumber(env, exports, "wireVersion", GXF_WIRE_VERSION);
  SetNumber(env, exports, "maxSlots", GXF_MAX_SLOTS);
  SetString(env, exports, "servicePrefix", GXF_SERVICE_PREFIX);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
