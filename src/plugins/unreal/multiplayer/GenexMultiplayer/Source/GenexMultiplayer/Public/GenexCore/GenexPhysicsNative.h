// Genex Physics' C ABI (ThirdParty/GenexPhysicsNative: genex_physics.h, abiVersion 1, built from
// genex-desktop ae524c44, the core the TypeScript SDK runs as WebAssembly) behind the predictor's
// core interface (GenexPhysicsPredictor.h's PredictCore / PredictWorld).
//
// Nothing links against the library: its gxph_* calls are resolved by name through a SymbolLookup the
// host hands over (dlopen/dlsym in the CMake tools, FPlatformProcess::GetDllHandle/GetDllExport in the
// UE module), so a build without the library still runs and never predicts. Bind() refuses a library
// whose abi version is not this header's, that lacks any call this layer makes, or whose buildId is not
// the pinned core's (kPinnedBuildPrefix: the build physics-predict.json was printed on).
//
// Every call goes the way the WASM package's wrapper (@genex-ai/physics core.js) makes it: arguments as
// JSON text with every number as its float32 (`EncodeF32`, NaN and infinities as 1e39 / -1e39, -0 as
// -0.0, so the core refuses them as non-finite), bulk rows as float32, replies parsed from the core's
// JSON text, the export's float32 data widened. So both cores see the same bytes and answer the same.
// Any result other than GXPH_OK is a refusal at the boundary (`CoreResult::code` names it, nothing
// changed); a panic (GXPH_ERR_PANIC) poisons the library for this process and every later call is
// refused without crossing.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPhysicsPredictor.h"

#include <functional>
#include <memory>
#include <string>

namespace genex::physics {

/** Finds a gxph_* call by name in the loaded library, or nullptr. */
using SymbolLookup = std::function<void*(const char* name)>;

/** The refusal codes the boundary itself gives (the core's own codes are its contract's §14). */
namespace boundary {
inline constexpr const char* kNoWorld = "boundary-no-world";
inline constexpr const char* kNull = "boundary-null";
inline constexpr const char* kLength = "boundary-length";
inline constexpr const char* kAlign = "boundary-align";
inline constexpr const char* kUtf8 = "boundary-utf8";
inline constexpr const char* kOutInUse = "boundary-out-in-use";
inline constexpr const char* kNotOurs = "boundary-not-ours";
inline constexpr const char* kPanic = "boundary-panic";
inline constexpr const char* kArg = "boundary-arg";
inline constexpr const char* kUnknown = "boundary-unknown";
/** The library answered GXPH_OK with text that is not the reply's JSON. */
inline constexpr const char* kBadReply = "boundary-bad-reply";
/** A call refused before crossing: rows not 15 numbers per key, a world already freed. */
inline constexpr const char* kBadCommand = "bad-command";
}  // namespace boundary

/** The pinned core's buildId up to its target (`+aarch64-macos`, `+x86_64-windows`, …): a library of
 *  another build is refused (its stateHashes are not the room's). PROVENANCE.json names it. */
inline constexpr const char* kPinnedBuildPrefix = "genex-physics/0.1.0+contract-1.0+rapier-0.36.0+det+";

/** The calls this layer makes, by name: Bind() needs every one. */
GENEX_CORE_API const char* const* NativeSymbolNames(std::size_t* count);

/** JSON text of `value` with every number as its float32, as @genex-ai/physics's encode writes it:
 *  ECMAScript's shortest digits of the float32, -0 as `-0.0`, NaN and +Infinity as `1e39` and
 *  -Infinity as `-1e39` (which the core refuses as non-finite). */
GENEX_CORE_API std::string EncodeF32(const Json& value);

struct NativeApi;

/** The C ABI bound to a loaded library: a PredictCore. Thread use: the library serializes calls. */
class GENEX_CORE_API NativeCore final : public PredictCore {
 public:
  /** Binds every call by name and checks gxph_abi_version() is 1 and gxph_build_id() starts with
   *  kPinnedBuildPrefix; nullptr (and `error`) otherwise. */
  static std::shared_ptr<NativeCore> Bind(const SymbolLookup& lookup, std::string* error = nullptr);

  ~NativeCore() override;
  NativeCore(const NativeCore&) = delete;
  NativeCore& operator=(const NativeCore&) = delete;

  std::string BuildId() override;
  std::unique_ptr<PredictWorld> CreateWorld(const Json& desc, CoreResult* refused) override;
  /** Whether the library panicked (now poisoned: every call is refused without crossing). */
  bool Poisoned() const;

  /** Bind() only. */
  explicit NativeCore(std::shared_ptr<NativeApi> api);

 private:
  std::shared_ptr<NativeApi> api_;
};

}  // namespace genex::physics
