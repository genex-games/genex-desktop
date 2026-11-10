#include "GenexSettings.h"

#include "HAL/PlatformMisc.h"

UGenexSettings::UGenexSettings() = default;

FString UGenexSettings::EffectiveApiUrl() const
{
	const FString Launcher = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_API_URL")).TrimStartAndEnd();
	return Launcher.IsEmpty() ? ApiUrl : Launcher;
}
