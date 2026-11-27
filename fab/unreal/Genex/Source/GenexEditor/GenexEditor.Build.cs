// Copyright Genex. All Rights Reserved.

using UnrealBuildTool;

public class GenexEditor : ModuleRules
{
	public GenexEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] { "Projects", "Slate", "SlateCore", "ToolMenus" });
	}
}
