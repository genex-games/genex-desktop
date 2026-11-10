// What the Genex.Multiplayer.UObject.* tests bind the async nodes' output pins to (a pin is a dynamic
// delegate, so its listener must be a UObject with UFUNCTIONs): it counts each pin and keeps the
// last message.
#pragma once

#include "CoreMinimal.h"
#include "GenexTypes.h"
#include "UObject/Object.h"
#include "GenexTestListener.generated.h"

UCLASS()
class UGenexTestListener : public UObject
{
	GENERATED_BODY()

public:
	int32 Successes = 0;
	int32 Failures = 0;
	int32 Codes = 0;
	FString LastMessage;

	UFUNCTION() void OnId(const FString& Id) { ++Successes; LastMessage = Id; }
	UFUNCTION() void OnFailed(int32 Code, const FString& Message) { ++Failures; LastMessage = FString::Printf(TEXT("%d %s"), Code, *Message); }
	UFUNCTION() void OnRefused(EGenexJoinRefusal Refusal, int32 Code, const FString& Message) { ++Failures; LastMessage = FString::Printf(TEXT("%d %s"), Code, *Message); }
	UFUNCTION() void OnControl(const FGenexControlResult& Result) { (Result.bAccepted ? Successes : Failures)++; LastMessage = Result.Reason; }
	UFUNCTION() void OnSignedIn() { ++Successes; }
	UFUNCTION() void OnCode(const FGenexDeviceCode& Code) { ++Codes; LastMessage = Code.UserCode; }
};
