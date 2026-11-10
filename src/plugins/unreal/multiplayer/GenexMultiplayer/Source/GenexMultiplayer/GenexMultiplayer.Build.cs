using UnrealBuildTool;

// GenexMultiplayer: GenexCore (Public/GenexCore, Private/GenexCore: engine-free C++17, also built by
// sdks/unreal/core/CMakeLists.txt) and the UObject layer on top of it (subsystems, Blueprint nodes).
public class GenexMultiplayer : ModuleRules
{
	public GenexMultiplayer(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		// GenexCore's switch to UE's third-party include macros and its export macro (GenexConfig.h).
		PublicDefinitions.Add("GENEX_WITH_UE=1");
		// The preset step must equal the server's bit for bit (core/DESIGN.md): never imprecise FP.
		FPSemantics = FPSemanticsMode.Precise;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "DeveloperSettings" });
		// GenexPhysicsNative: the physics core's C ABI header and its staged library (loaded at run time,
		// GenexMultiplayerModule.cpp), for predicting a predicting physics room's bodies (§17.11).
		PrivateDependencyModuleNames.AddRange(new string[] { "ColyseusNative", "GenexPhysicsNative", "HTTP", "Projects", "Sockets" });
	}
}
