using System.IO;
using UnrealBuildTool;

// Genex Physics' C ABI (PROVENANCE.json: genex-desktop ae524c44, sha256 per file), the core a
// predicting physics room's client world runs on (PROTOCOL.md §17.11). Nothing links against it:
// GenexCore resolves its gxph_* calls at run time (GenexCore/GenexPhysicsNative.h) through the symbol
// lookup the module hands it (FPlatformProcess::GetDllHandle / GetDllExport), so a build without the
// library still loads and simply never predicts (status `unavailable`).
//   Mac:   lib/Mac/libgenex_physics_capi.dylib (universal x86_64 + arm64)
//   Win64: lib/Win64/genex_physics_capi.dll (gnullvm, UCRT imports only)
//   Linux: lib/Linux/libgenex_physics_capi.so (x86_64)
// Each is staged beside the plugin's binaries, where GenexMultiplayerModule.cpp loads it from.
public class GenexPhysicsNative : ModuleRules
{
	public GenexPhysicsNative(ReadOnlyTargetRules Target) : base(Target)
	{
		Type = ModuleType.External;
		PublicSystemIncludePaths.Add(Path.Combine(ModuleDirectory, "include"));
		string Lib = Path.Combine(ModuleDirectory, "lib");
		if (Target.Platform == UnrealTargetPlatform.Mac)
		{
			RuntimeDependencies.Add("$(PluginDir)/Binaries/ThirdParty/GenexPhysicsNative/Mac/libgenex_physics_capi.dylib", Path.Combine(Lib, "Mac", "libgenex_physics_capi.dylib"));
			PublicDefinitions.Add("GENEX_PHYSICS_NATIVE_LIBRARY=\"Binaries/ThirdParty/GenexPhysicsNative/Mac/libgenex_physics_capi.dylib\"");
		}
		else if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			RuntimeDependencies.Add("$(PluginDir)/Binaries/ThirdParty/GenexPhysicsNative/Win64/genex_physics_capi.dll", Path.Combine(Lib, "Win64", "genex_physics_capi.dll"));
			PublicDefinitions.Add("GENEX_PHYSICS_NATIVE_LIBRARY=\"Binaries/ThirdParty/GenexPhysicsNative/Win64/genex_physics_capi.dll\"");
		}
		else if (Target.Platform == UnrealTargetPlatform.Linux)
		{
			RuntimeDependencies.Add("$(PluginDir)/Binaries/ThirdParty/GenexPhysicsNative/Linux/libgenex_physics_capi.so", Path.Combine(Lib, "Linux", "libgenex_physics_capi.so"));
			PublicDefinitions.Add("GENEX_PHYSICS_NATIVE_LIBRARY=\"Binaries/ThirdParty/GenexPhysicsNative/Linux/libgenex_physics_capi.so\"");
		}
	}
}
