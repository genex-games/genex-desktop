// Genex Physics' C ABI behind the predictor's core interface: see GenexPhysicsNative.h. The calls are
// made as packages/authority-host/vendor's @genex-ai/physics wrapper (core.js) makes them over its
// WebAssembly wire, which the header promises answers byte for byte as this library does.
#include "GenexCore/GenexPhysicsNative.h"

GENEX_THIRD_PARTY_INCLUDES_START
#include "genex_physics.h"
GENEX_THIRD_PARTY_INCLUDES_END

#include <cmath>
#include <cstring>
#include <optional>
#include <utility>

namespace genex::physics {

/** Every gxph_* call this layer makes, resolved by name, and whether the library has panicked. */
struct NativeApi {
  uint32_t (*abi_version)(void) = nullptr;
  gxph_result (*build_id)(gxph_bytes*) = nullptr;
  gxph_result (*buf_free)(gxph_bytes*) = nullptr;
  gxph_result (*world_create)(const char*, size_t, gxph_world**, gxph_bytes*) = nullptr;
  gxph_result (*world_free)(gxph_world*) = nullptr;
  gxph_result (*world_tick)(const gxph_world*, uint64_t*) = nullptr;
  gxph_result (*world_command)(const gxph_world*, const char*, size_t, gxph_bytes*) = nullptr;
  gxph_result (*world_add_static)(const gxph_world*, const uint32_t*, size_t, const double*, size_t, const uint32_t*,
                                  size_t, const double*, size_t, gxph_bytes*) = nullptr;
  gxph_result (*world_step)(const gxph_world*, gxph_bytes*) = nullptr;
  gxph_result (*world_export_changed_rest)(const gxph_world*, double, gxph_bytes*, gxph_bytes*) = nullptr;
  gxph_result (*world_export_body_state_rest)(const gxph_world*, const char*, size_t, gxph_bytes*) = nullptr;
  gxph_result (*world_import_wire)(const gxph_world*, const char*, size_t, const float*, size_t, gxph_bytes*) = nullptr;
  gxph_result (*world_canonicalize)(const gxph_world*, const char*, size_t, gxph_bytes*) = nullptr;
  gxph_result (*world_state_hash)(const gxph_world*, gxph_bytes*) = nullptr;
  gxph_result (*world_physics_hash)(const gxph_world*, gxph_bytes*) = nullptr;
  bool poisoned = false;
};

}  // namespace genex::physics

namespace genex::physics_native_detail {

using genex::Json;
using genex::physics::CoreResult;
using genex::physics::NativeApi;

constexpr const char* kSymbols[] = {
    "gxph_abi_version",
    "gxph_build_id",
    "gxph_buf_free",
    "gxph_world_create",
    "gxph_world_free",
    "gxph_world_tick",
    "gxph_world_command",
    "gxph_world_add_static",
    "gxph_world_step",
    "gxph_world_export_changed_rest",
    "gxph_world_export_body_state_rest",
    "gxph_world_import_wire",
    "gxph_world_canonicalize",
    "gxph_world_state_hash",
    "gxph_world_physics_hash",
};
constexpr std::size_t kSymbolCount = sizeof(kSymbols) / sizeof(kSymbols[0]);
constexpr std::size_t kRowStride = genex::physics::kWireRowStride;
/** The wrapper's text for a non-finite float32 (the core reads 1e39 as out of float32: NonFinite). */
constexpr const char* kNotFiniteText = "1e39";
constexpr const char* kNegativeInfiniteText = "-1e39";
/** −0 as text the core reads as f64 −0.0 (`-0` alone reads as the integer 0). */
constexpr const char* kNegativeZeroText = "-0.0";
/** Replies are parsed with room for a step's events and a large world's keys. */
const genex::JsonLimits& ReplyLimits() {
  static const genex::JsonLimits limits = [] {
    genex::JsonLimits l;
    l.maxNodes = 4u * 1024u * 1024u;
    l.maxBytes = 256u * 1024u * 1024u;
    return l;
  }();
  return limits;
}

/** The boundary's code for a result other than GXPH_OK. */
const char* BoundaryCode(gxph_result r) {
  switch (r) {
    case GXPH_ERR_NULL:
      return genex::physics::boundary::kNull;
    case GXPH_ERR_LENGTH:
      return genex::physics::boundary::kLength;
    case GXPH_ERR_ALIGN:
      return genex::physics::boundary::kAlign;
    case GXPH_ERR_UTF8:
      return genex::physics::boundary::kUtf8;
    case GXPH_ERR_OUT_IN_USE:
      return genex::physics::boundary::kOutInUse;
    case GXPH_ERR_NO_WORLD:
      return genex::physics::boundary::kNoWorld;
    case GXPH_ERR_NOT_OURS:
      return genex::physics::boundary::kNotOurs;
    case GXPH_ERR_PANIC:
      return genex::physics::boundary::kPanic;
    case GXPH_ERR_ARG:
      return genex::physics::boundary::kArg;
    default:
      return genex::physics::boundary::kUnknown;
  }
}

/** One crossing's result and the reply text it handed out (always given back before returning). */
struct Crossing {
  gxph_result result = GXPH_OK;
  std::string text;
};

/** Gives a reply buffer back; a library that refuses to take its own buffer is noted, not trusted. */
void Release(NativeApi& api, gxph_bytes& bytes) {
  if (bytes.ptr == nullptr && bytes.len == 0) return;
  if (api.buf_free(&bytes) == GXPH_ERR_PANIC) api.poisoned = true;
}

/** Copies a reply into text and gives the buffer back. A reply whose pointer is null but whose length
 *  is not is read as empty. */
std::string Take(NativeApi& api, gxph_bytes& bytes) {
  std::string text;
  if (bytes.ptr != nullptr && bytes.len != 0) text.assign(reinterpret_cast<const char*>(bytes.ptr), bytes.len);
  Release(api, bytes);
  return text;
}

template <typename Fn>
Crossing CrossText(NativeApi& api, Fn&& call) {
  Crossing c;
  if (api.poisoned) {
    c.result = GXPH_ERR_PANIC;
    return c;
  }
  gxph_bytes out = GXPH_BYTES_EMPTY;
  c.result = call(&out);
  c.text = Take(api, out);
  if (c.result == GXPH_ERR_PANIC) api.poisoned = true;
  return c;
}

/** `{ ok: true, … }` or `{ ok: false, code, detail? }` as a CoreResult (and the parsed reply). */
CoreResult ResultOf(const Crossing& c, std::optional<Json>* parsed = nullptr) {
  if (c.result != GXPH_OK) return CoreResult::Refused(BoundaryCode(c.result));
  std::optional<Json> reply = Json::Parse(c.text, nullptr, ReplyLimits());
  const Json* ok = reply && reply->IsObject() ? reply->Find("ok") : nullptr;
  if (ok == nullptr || !ok->IsBool()) return CoreResult::Refused(genex::physics::boundary::kBadReply);
  CoreResult r;
  if (ok->AsBool()) {
    r = CoreResult::Ok();
  } else {
    const Json* code = reply->Find("code");
    const Json* detail = reply->Find("detail");
    r = CoreResult::Refused(code != nullptr && code->IsString() ? code->AsString() : std::string(genex::physics::boundary::kBadReply),
                            detail != nullptr && detail->IsString() ? detail->AsString() : std::string());
  }
  if (parsed != nullptr) *parsed = std::move(reply);
  return r;
}

void EncodeNumber(std::string& out, double value) {
  const double rounded = genex::physics::Fround(value);
  if (std::isnan(rounded) || rounded == INFINITY) {
    out.append(kNotFiniteText);
  } else if (rounded == -INFINITY) {
    out.append(kNegativeInfiniteText);
  } else if (rounded == 0.0 && std::signbit(rounded)) {
    out.append(kNegativeZeroText);
  } else {
    genex::AppendJsonNumber(out, rounded);
  }
}

void Encode(const Json& value, std::string& out) {
  switch (value.GetType()) {
    case Json::Type::Null:
      out.append("null");
      return;
    case Json::Type::Bool:
      out.append(value.AsBool() ? "true" : "false");
      return;
    case Json::Type::Number:
      EncodeNumber(out, value.AsNumber());
      return;
    case Json::Type::String:
      genex::AppendJsonString(out, value.AsString());
      return;
    case Json::Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const Json& item : value.Items()) {
        if (!first) out.push_back(',');
        first = false;
        Encode(item, out);
      }
      out.push_back(']');
      return;
    }
    case Json::Type::Object: {
      out.push_back('{');
      bool first = true;
      for (const genex::JsonMember& m : value.Members()) {
        if (!first) out.push_back(',');
        first = false;
        genex::AppendJsonString(out, m.key);
        out.push_back(':');
        Encode(m.value, out);
      }
      out.push_back('}');
      return;
    }
  }
}

Json Vec(const double* v, std::size_t n) {
  Json a = Json::MakeArray();
  for (std::size_t i = 0; i < n; ++i) a.Push(v[i]);
  return a;
}

Json KeysJson(const std::vector<std::string>& keys) {
  Json a = Json::MakeArray();
  for (const std::string& k : keys) a.Push(k);
  return a;
}

/** A 3- or 4-number array of the reply into `out`; false for any other shape. */
bool ReadNumbers(const Json* v, double* out, std::size_t n) {
  if (v == nullptr || !v->IsArray() || v->Size() != n) return false;
  for (std::size_t i = 0; i < n; ++i) {
    if (!v->At(i).IsNumber()) return false;
    out[i] = v->At(i).AsNumber();
  }
  return true;
}

/** One world of the library: its handle, freed once. */
class NativeWorld final : public genex::physics::PredictWorld {
 public:
  NativeWorld(std::shared_ptr<NativeApi> api, gxph_world* handle) : api_(std::move(api)), handle_(handle) {}
  ~NativeWorld() override {
    if (handle_ != nullptr && !api_->poisoned && api_->world_free(handle_) == GXPH_ERR_PANIC) api_->poisoned = true;
  }
  NativeWorld(const NativeWorld&) = delete;
  NativeWorld& operator=(const NativeWorld&) = delete;

  double Tick() override {
    if (api_->poisoned) return 0.0;
    uint64_t tick = 0;
    const gxph_result r = api_->world_tick(handle_, &tick);
    if (r == GXPH_ERR_PANIC) api_->poisoned = true;
    return r == GXPH_OK ? static_cast<double>(tick) : 0.0;
  }

  CoreResult AddStaticWorld(const genex::physics::StaticWorld& world) override {
    std::vector<uint32_t> boxLengths;
    std::vector<double> boxes;
    std::vector<uint32_t> rampLengths;
    std::vector<double> ramps;
    for (const auto& row : world.boxes) {
      boxLengths.push_back(static_cast<uint32_t>(row.size()));
      boxes.insert(boxes.end(), row.begin(), row.end());
    }
    for (const auto& row : world.ramps) {
      rampLengths.push_back(static_cast<uint32_t>(row.size()));
      ramps.insert(ramps.end(), row.begin(), row.end());
    }
    const Crossing c = CrossText(*api_, [&](gxph_bytes* out) {
      return api_->world_add_static(handle_, boxLengths.empty() ? nullptr : boxLengths.data(), boxLengths.size(),
                                    boxes.empty() ? nullptr : boxes.data(), boxes.size(),
                                    rampLengths.empty() ? nullptr : rampLengths.data(), rampLengths.size(),
                                    ramps.empty() ? nullptr : ramps.data(), ramps.size(), out);
    });
    return ResultOf(c);
  }

  CoreResult Spawn(const Json& desc) override { return Command("spawn", desc); }

  CoreResult Remove(const std::string& key) override { return Command("remove", KeyArgs(key)); }

  CoreResult AddJoint(const Json& desc) override { return Command("addJoint", desc); }

  CoreResult RemoveJoint(const std::string& key) override { return Command("removeJoint", KeyArgs(key)); }

  CoreResult SetMotor(const std::string& key, const Json& motor) override {
    Json args = KeyArgs(key);
    args.Set("motor", motor);
    return Command("setMotor", args);
  }

  CoreResult SetVelocity(const std::string& key, const double linvel[3], const double angvel[3]) override {
    Json args = KeyArgs(key);
    args.Set("linvel", Vec(linvel, 3));
    args.Set("angvel", Vec(angvel, 3));
    return Command("setVelocity", args);
  }

  CoreResult SetNextKinematicPose(const std::string& key, const double p[3], const double q[4]) override {
    Json pose = Json::MakeObject();
    pose.Set("p", Vec(p, 3));
    pose.Set("q", Vec(q, 4));
    Json args = KeyArgs(key);
    args.Set("pose", std::move(pose));
    return Command("setNextKinematicPose", args);
  }

  CoreResult ImportWire(const std::vector<std::string>& keys, const std::vector<float>& rows) override {
    if (rows.size() != keys.size() * kRowStride) {
      return CoreResult::Refused(genex::physics::boundary::kBadCommand, "rows are not 15 numbers per key");
    }
    const std::string text = genex::physics::EncodeF32(KeysJson(keys));
    const Crossing c = CrossText(*api_, [&](gxph_bytes* out) {
      return api_->world_import_wire(handle_, text.data(), text.size(), rows.empty() ? nullptr : rows.data(), rows.size(), out);
    });
    return ResultOf(c);
  }

  CoreResult Canonicalize(bool quantize) override {
    const std::string options = quantize ? "{\"quantize\":true}" : "{}";
    const Crossing c = CrossText(*api_, [&](gxph_bytes* out) {
      return api_->world_canonicalize(handle_, options.data(), options.size(), out);
    });
    return ResultOf(c);
  }

  genex::physics::StepResult Step() override {
    genex::physics::StepResult step;
    const Crossing c = CrossText(*api_, [&](gxph_bytes* out) { return api_->world_step(handle_, out); });
    std::optional<Json> reply;
    step.result = ResultOf(c, &reply);
    if (!step.result.ok) return step;
    const Json* escaped = reply->Find("escaped");
    if (escaped != nullptr && escaped->IsArray()) {
      for (const Json& key : escaped->Items()) {
        if (key.IsString()) step.escaped.push_back(key.AsString());
      }
    }
    return step;
  }

  genex::physics::ExportRows ExportChangedRest(double sinceTick) override {
    genex::physics::ExportRows rows;
    // The wrapper's isWholeTick: anything else is the empty export, never a crossing.
    if (!(sinceTick >= 0.0) || sinceTick != std::floor(sinceTick) || sinceTick > 9007199254740991.0) return rows;
    if (api_->poisoned) return rows;
    gxph_bytes keys = GXPH_BYTES_EMPTY;
    gxph_bytes data = GXPH_BYTES_EMPTY;
    const gxph_result r = api_->world_export_changed_rest(handle_, sinceTick, &keys, &data);
    if (r == GXPH_ERR_PANIC) api_->poisoned = true;
    const std::string keyText = Take(*api_, keys);
    std::vector<float> values;
    if (data.ptr != nullptr && data.len % sizeof(float) == 0) {
      values.resize(data.len / sizeof(float));
      if (!values.empty()) std::memcpy(values.data(), data.ptr, data.len);
    }
    const bool dataBroken = data.ptr == nullptr && data.len != 0;
    Release(*api_, data);
    if (r != GXPH_OK || dataBroken) return rows;
    const std::optional<Json> parsed = Json::Parse(keyText, nullptr, ReplyLimits());
    if (!parsed || !parsed->IsArray()) return rows;
    std::vector<std::string> list;
    for (const Json& k : parsed->Items()) {
      if (!k.IsString()) return rows;
      list.push_back(k.AsString());
    }
    // A reply that does not hold 15 numbers per key is the empty export, as the wrapper reads it.
    if (values.size() != list.size() * kRowStride) return rows;
    rows.keys = std::move(list);
    rows.data = std::move(values);
    return rows;
  }

  std::optional<genex::physics::NetStateRest> ExportBodyStateRest(const std::string& key) override {
    const Crossing c = CrossText(*api_, [&](gxph_bytes* out) {
      return api_->world_export_body_state_rest(handle_, key.data(), key.size(), out);
    });
    if (c.result != GXPH_OK) return std::nullopt;
    const std::optional<Json> reply = Json::Parse(c.text, nullptr, ReplyLimits());
    if (!reply || !reply->IsObject()) return std::nullopt;
    genex::physics::NetStateRest st;
    const Json* sleeping = reply->Find("sleeping");
    const Json* rest = reply->Find("rest");
    const bool whole = ReadNumbers(reply->Find("p"), st.p, 3) && ReadNumbers(reply->Find("q"), st.q, 4) &&
                       ReadNumbers(reply->Find("v"), st.v, 3) && ReadNumbers(reply->Find("w"), st.w, 3) &&
                       sleeping != nullptr && sleeping->IsBool();
    if (!whole) return std::nullopt;
    st.sleeping = sleeping->AsBool();
    st.rest = rest != nullptr && rest->IsNumber() ? rest->AsNumber() : 0.0;
    return st;
  }

  std::string StateHash() override {
    return CrossText(*api_, [&](gxph_bytes* out) { return api_->world_state_hash(handle_, out); }).text;
  }

  std::string PhysicsHash() override {
    return CrossText(*api_, [&](gxph_bytes* out) { return api_->world_physics_hash(handle_, out); }).text;
  }

 private:
  static Json KeyArgs(const std::string& key) {
    Json args = Json::MakeObject();
    args.Set("key", key);
    return args;
  }

  CoreResult Command(const char* verb, const Json& args) {
    Json command = Json::MakeObject();
    command.Set(verb, args);
    const std::string text = genex::physics::EncodeF32(command);
    const Crossing c = CrossText(*api_, [&](gxph_bytes* out) {
      return api_->world_command(handle_, text.data(), text.size(), out);
    });
    return ResultOf(c);
  }

  std::shared_ptr<NativeApi> api_;
  gxph_world* handle_ = nullptr;
};

/** A looked-up symbol as the function pointer it is. */
template <typename Fn>
bool Resolve(const genex::physics::SymbolLookup& lookup, const char* name, Fn& out) {
  void* symbol = lookup(name);
  if (symbol == nullptr) return false;
  out = reinterpret_cast<Fn>(symbol);
  return true;
}

}  // namespace genex::physics_native_detail

namespace genex::physics {

namespace nd = ::genex::physics_native_detail;

const char* const* NativeSymbolNames(std::size_t* count) {
  if (count != nullptr) *count = nd::kSymbolCount;
  return nd::kSymbols;
}

std::string EncodeF32(const Json& value) {
  std::string out;
  nd::Encode(value, out);
  return out;
}

NativeCore::NativeCore(std::shared_ptr<NativeApi> api) : api_(std::move(api)) {}

NativeCore::~NativeCore() = default;

std::shared_ptr<NativeCore> NativeCore::Bind(const SymbolLookup& lookup, std::string* error) {
  const auto fail = [error](const std::string& why) {
    if (error != nullptr) *error = why;
    return std::shared_ptr<NativeCore>();
  };
  if (!lookup) return fail("no symbol lookup");
  auto api = std::make_shared<NativeApi>();
  const bool all = nd::Resolve(lookup, "gxph_abi_version", api->abi_version) &&
                   nd::Resolve(lookup, "gxph_build_id", api->build_id) &&
                   nd::Resolve(lookup, "gxph_buf_free", api->buf_free) &&
                   nd::Resolve(lookup, "gxph_world_create", api->world_create) &&
                   nd::Resolve(lookup, "gxph_world_free", api->world_free) &&
                   nd::Resolve(lookup, "gxph_world_tick", api->world_tick) &&
                   nd::Resolve(lookup, "gxph_world_command", api->world_command) &&
                   nd::Resolve(lookup, "gxph_world_add_static", api->world_add_static) &&
                   nd::Resolve(lookup, "gxph_world_step", api->world_step) &&
                   nd::Resolve(lookup, "gxph_world_export_changed_rest", api->world_export_changed_rest) &&
                   nd::Resolve(lookup, "gxph_world_export_body_state_rest", api->world_export_body_state_rest) &&
                   nd::Resolve(lookup, "gxph_world_import_wire", api->world_import_wire) &&
                   nd::Resolve(lookup, "gxph_world_canonicalize", api->world_canonicalize) &&
                   nd::Resolve(lookup, "gxph_world_state_hash", api->world_state_hash) &&
                   nd::Resolve(lookup, "gxph_world_physics_hash", api->world_physics_hash);
  if (!all) {
    for (const char* name : nd::kSymbols) {
      if (lookup(name) == nullptr) return fail(std::string("the library has no ") + name);
    }
    return fail("the library is missing a call");
  }
  const uint32_t abi = api->abi_version();
  if (abi != GXPH_ABI_VERSION) {
    return fail("abi version " + std::to_string(abi) + ", expected " + std::to_string(GXPH_ABI_VERSION));
  }
  auto core = std::make_shared<NativeCore>(std::move(api));
  const std::string build = core->BuildId();
  if (build.rfind(kPinnedBuildPrefix, 0) != 0) {
    return fail("build \"" + build + "\" is not the pinned " + kPinnedBuildPrefix + "*");
  }
  return core;
}

bool NativeCore::Poisoned() const { return api_->poisoned; }

std::string NativeCore::BuildId() {
  return nd::CrossText(*api_, [this](gxph_bytes* out) { return api_->build_id(out); }).text;
}

std::unique_ptr<PredictWorld> NativeCore::CreateWorld(const Json& desc, CoreResult* refused) {
  const std::string text = EncodeF32(desc);
  gxph_world* handle = nullptr;
  const nd::Crossing c = nd::CrossText(*api_, [&](gxph_bytes* out) {
    return api_->world_create(text.data(), text.size(), &handle, out);
  });
  const CoreResult r = nd::ResultOf(c);
  if (r.ok && handle != nullptr) return std::make_unique<nd::NativeWorld>(api_, handle);
  if (handle != nullptr && !api_->poisoned) api_->world_free(handle);
  if (refused != nullptr) *refused = r.ok ? CoreResult::Refused(boundary::kNoWorld) : r;
  return nullptr;
}

}  // namespace genex::physics
