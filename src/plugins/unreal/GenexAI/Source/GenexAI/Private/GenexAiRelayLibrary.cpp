#include "GenexAiRelayLibrary.h"

#include "GenexAiSubsystem.h"

FString UGenexAiRelayLibrary::Pull()
{
	return UGenexAiSubsystem::PullForStudio();
}

bool UGenexAiRelayLibrary::Push(const FString& Base64)
{
	return UGenexAiSubsystem::PushFromStudio(Base64);
}
