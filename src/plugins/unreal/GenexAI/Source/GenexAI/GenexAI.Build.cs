// Genex play-time AI: the game-facing subsystem, its Blueprint node, and the relay Genex Studio pulls.
using UnrealBuildTool;

public class GenexAI : ModuleRules
{
	public GenexAI(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "Json", "JsonUtilities" });
	}
}
