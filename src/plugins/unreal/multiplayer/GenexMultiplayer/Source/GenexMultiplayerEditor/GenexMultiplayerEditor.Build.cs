using UnrealBuildTool;

// Editor-only: Studio's local authority server for PIE (GenexLocalAuthority.cpp), the level
// collision bake (GenexCollisionBakeEditor.cpp), the world scene for the shared fit (GenexWorldSceneEditor.cpp) and the Genex.Multiplayer.* automation tests.
public class GenexMultiplayerEditor : ModuleRules
{
	public GenexMultiplayerEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "UnrealEd", "Json", "Projects", "GenexMultiplayer", "Sockets", "Networking", "AssetRegistry", "PhysicsCore", "Landscape", "EngineSettings" });
	}
}
