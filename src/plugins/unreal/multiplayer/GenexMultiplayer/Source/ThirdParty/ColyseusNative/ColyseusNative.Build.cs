using System.IO;
using UnrealBuildTool;

// The official Colyseus native core v0.18.10, never committed: include/ and lib/ are placed by
// sdks/unreal/scripts/fetch-colyseus.sh (sha256-pinned) and shipped inside the prebuilt plugin zip.
//   Mac:   lib/Mac/libcolyseus.a, the release xcframework's universal (arm64 + x86_64) archive.
//   Win64: lib/Win64/colyseus.dll + its import library colyseus.lib, built from the pinned source
//          by scripts/build-colyseus-win64.sh (SPIKE.md, path W3: the release has no MSVC asset).
//   Linux: lib/Linux/lib*.a, the release's per-lib archives (x86_64 only, `fetch-colyseus.sh linux-x86_64`).
public class ColyseusNative : ModuleRules
{
	public ColyseusNative(ReadOnlyTargetRules Target) : base(Target)
	{
		Type = ModuleType.External;
		PublicSystemIncludePaths.Add(Path.Combine(ModuleDirectory, "include"));
		string Lib = Path.Combine(ModuleDirectory, "lib");
		if (Target.Platform == UnrealTargetPlatform.Mac)
		{
			PublicAdditionalLibraries.Add(Path.Combine(Lib, "Mac", "libcolyseus.a"));
			PublicFrameworks.AddRange(new string[] { "CoreFoundation", "Security" });
		}
		else if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			PublicAdditionalLibraries.Add(Path.Combine(Lib, "Win64", "colyseus.lib"));
			// Loaded by the runtime module at startup from the plugin's own Binaries (GenexMultiplayerModule.cpp).
			PublicDelayLoadDLLs.Add("colyseus.dll");
			RuntimeDependencies.Add("$(PluginDir)/Binaries/ThirdParty/ColyseusNative/Win64/colyseus.dll", Path.Combine(Lib, "Win64", "colyseus.dll"));
			PublicDefinitions.Add("GENEX_COLYSEUS_DLL=1");
		}
		else if (Target.Platform == UnrealTargetPlatform.Linux)
		{
			// Link order: each archive needs only what follows it.
			foreach (string Archive in new string[] { "colyseus", "http_zig", "strutil_zig", "system_certs_zig", "msgpack_builder", "msgpack_reader", "wslay", "mbedtls", "mbedx509", "mbedcrypto" })
			{
				PublicAdditionalLibraries.Add(Path.Combine(Lib, "Linux", "lib" + Archive + ".a"));
			}
			// The Rocky 8 sysroot's glibc (2.28) keeps these apart from libc.
			PublicSystemLibraries.AddRange(new string[] { "dl", "pthread", "m" });
		}
	}
}
