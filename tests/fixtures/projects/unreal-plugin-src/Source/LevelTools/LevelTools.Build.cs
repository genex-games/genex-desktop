using UnrealBuildTool;

public class LevelTools : ModuleRules
{
	public LevelTools(ReadOnlyTargetRules Target) : base(Target)
	{
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "UnrealEd" });
	}
}
