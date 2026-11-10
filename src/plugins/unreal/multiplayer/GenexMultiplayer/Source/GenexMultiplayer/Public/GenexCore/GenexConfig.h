// GenexCore build configuration: the one place that knows whether this tree is compiled by
// Unreal Build Tool (the GenexMultiplayer module) or by CMake (sdks/unreal/core/). Rules:
// sdks/unreal/core/DESIGN.md. Every GenexCore header includes this file first.
#pragma once

// ---- GENEX_WITH_UE ----
// Defined (to 1) by GenexMultiplayer.Build.cs through PublicDefinitions; never defined by the CMake
// build. Test it with `#ifdef` / `defined()` only: a bare `#if GENEX_WITH_UE` trips -Wundef in CMake.

// ---- GENEX_CORE_API ----
// The export macro for GenexCore's classes and non-inline functions. Under UE it is the module's own
// GENEXMULTIPLAYER_API (UBT defines it as DLLEXPORT/DLLIMPORT in modular builds, empty in monolithic
// ones), so the UObject layer and games can link GenexCore across module boundaries. Empty in CMake.
#if defined(GENEX_WITH_UE) && defined(GENEXMULTIPLAYER_API)
#define GENEX_CORE_API GENEXMULTIPLAYER_API
#else
#define GENEX_CORE_API
#endif

// ---- GENEX_THIRD_PARTY_INCLUDES_START / _END ----
// Wrap third-party headers (only GenexCore/GenexColyseus.h uses them). Under UE: UE's own
// THIRD_PARTY_INCLUDES_START/END when the including translation unit already sees them (they come
// from HAL/Platform.h, which GenexCore deliberately never includes); otherwise an equivalent
// "silence everything" push/pop so the C core's headers can never fail UE's warnings-as-errors.
// In CMake: nothing (the imported colyseus::core target's include dir is a SYSTEM include there).
#if defined(GENEX_WITH_UE) && defined(THIRD_PARTY_INCLUDES_START) && defined(THIRD_PARTY_INCLUDES_END)
#define GENEX_THIRD_PARTY_INCLUDES_START THIRD_PARTY_INCLUDES_START
#define GENEX_THIRD_PARTY_INCLUDES_END THIRD_PARTY_INCLUDES_END
#elif defined(GENEX_WITH_UE) && defined(__clang__)
#define GENEX_THIRD_PARTY_INCLUDES_START \
  _Pragma("clang diagnostic push") _Pragma("clang diagnostic ignored \"-Weverything\"")
#define GENEX_THIRD_PARTY_INCLUDES_END _Pragma("clang diagnostic pop")
#elif defined(GENEX_WITH_UE) && defined(_MSC_VER)
#define GENEX_THIRD_PARTY_INCLUDES_START __pragma(warning(push, 0))
#define GENEX_THIRD_PARTY_INCLUDES_END __pragma(warning(pop))
#else
#define GENEX_THIRD_PARTY_INCLUDES_START
#define GENEX_THIRD_PARTY_INCLUDES_END
#endif

// ---- GENEX_FP_STRICT_BEGIN / _END ----
// Turn off floating-point contraction (a*b+c fused into one FMA) between BEGIN and END, so preset
// arithmetic rounds exactly like the JS server. Put BEGIN after the includes of a .cpp and END at the
// end of it, at namespace (file) scope, never inside a function body.
//
// - clang (Apple clang 21, UE's clang toolchains, clang-cl): `float_control(push)` saves the FP
//   state, `clang fp contract(off)` applies from that point to the end of the enclosing scope, and
//   `float_control(pop)` restores it, so a unity build's next file is untouched. Verified on Apple
//   clang 21 at -O2 for arm64: `a*b+c` emits fmul+fadd inside the region and fmadd after END.
//   A bare `#pragma clang fp contract(off)` (no push) would leak into every later file of a unity blob.
//   The pragma beats clang's default `-ffp-contract=on`, but NOT `-ffp-contract=fast` (which
//   -ffast-math and UBT's FPSemanticsMode.Imprecise imply): clang ignores the pragma there
//   (measured: still fused). That is why fast math must never reach this module.
// - MSVC: `fp_contract(off)` (file scope only; MSVC has no scoped form). END is empty: off is already
//   the /fp:precise default since VS 2022, so leaving it off for the rest of the blob changes nothing.
// - GCC: `push_options` / `optimize("fp-contract=off")` / `pop_options`, scoped like clang's. GCC
//   contracts by default in C++ (its ISO-mode -ffp-contract=off default applies to C only): measured
//   with g++ 12.2 on aarch64, -std=c++17 -O2 and no -ffp-contract flag, StepTopdown emitted 2 fmadd and
//   the fp_strict / presets_unfused offline rows failed; with this pragma, fmul+fadd and they pass.
//   The CMake build compiles the preset files and the fp_strict probe at the compiler's contracting
//   default, so it checks the pragma, not a flag.
#if defined(__clang__)
// Older clang (measured: Debian clang 14 on aarch64 Linux) rejects float_control on non-x86
// targets ("not supported on this target - ignored", an error under -Werror). There the
// -Wignored-pragmas silencing below lets the push/pop drop out and `fp contract(off)` stays in
// force to the end of the translation unit: a unity blob's later files are then unfused too, which
// is only stricter, never wrong.
#define GENEX_FP_STRICT_BEGIN                                                              \
  _Pragma("clang diagnostic push") _Pragma("clang diagnostic ignored \"-Wignored-pragmas\"") \
      _Pragma("float_control(push)") _Pragma("clang diagnostic pop") _Pragma("clang fp contract(off)")
#define GENEX_FP_STRICT_END                                                                \
  _Pragma("clang diagnostic push") _Pragma("clang diagnostic ignored \"-Wignored-pragmas\"") \
      _Pragma("float_control(pop)") _Pragma("clang diagnostic pop")
#elif defined(_MSC_VER)
#define GENEX_FP_STRICT_BEGIN __pragma(fp_contract(off))
#define GENEX_FP_STRICT_END
#elif defined(__GNUC__)
#define GENEX_FP_STRICT_BEGIN _Pragma("GCC push_options") _Pragma("GCC optimize(\"fp-contract=off\")")
#define GENEX_FP_STRICT_END _Pragma("GCC pop_options")
#else
#define GENEX_FP_STRICT_BEGIN
#define GENEX_FP_STRICT_END
#endif
