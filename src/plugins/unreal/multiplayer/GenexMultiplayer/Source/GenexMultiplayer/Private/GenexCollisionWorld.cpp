#include "GenexCollisionWorld.h"

#include "GenexAuthoritySubsystem.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexSettings.h"

bool UGenexCollisionWorld::SetFromWorldJson(const FString& Json, FString& Error)
{
	std::string Why;
	const genex::FirstpersonWorldPtr World = genex::FirstpersonWorld::FromJsonText(TCHAR_TO_UTF8(*Json), &Why);
	if (!World)
	{
		Error = UTF8_TO_TCHAR(Why.c_str());
		return false;
	}
	UGenexAuthoritySubsystem::ToUnrealSolids(*World, Boxes, Ramps);
	Error.Reset();
	return true;
}

void UGenexCollisionWorld::ImportWorldJson()
{
	Modify();
	FString Error;
	if (!SetFromWorldJson(WorldJson, Error)) UE_LOG(LogTemp, Error, TEXT("Genex collision world: %s"), *Error);
}

int64 UGenexCollisionWorld::GetWorldHash(FString& Error) const
{
	std::string Why;
	const genex::FirstpersonWorldPtr World = UGenexAuthoritySubsystem::FromUnrealSolids(Boxes, Ramps, &Why);
	if (!World)
	{
		Error = UTF8_TO_TCHAR(Why.c_str());
		return -1;
	}
	Error.Reset();
	return static_cast<int64>(World->Hash());
}

UGenexCollisionWorld* UGenexCollisionWorld::FromWorldJson(const FString& Json, FString& Error)
{
	UGenexCollisionWorld* Asset = NewObject<UGenexCollisionWorld>();
	if (!Asset->SetFromWorldJson(Json, Error)) return nullptr;
	return Asset;
}
