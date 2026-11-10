// Small JSON helpers for Blueprint, where Genex's free-form state (player data, shared values,
// object state, event payloads) travels as JSON text. Numbers are doubles (the wire's float64).
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "GenexJsonLibrary.generated.h"

UCLASS()
class GENEXMULTIPLAYER_API UGenexJsonLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** {"key": number, …} from a map. */
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static FString MakeNumbersJson(const TMap<FString, double>& Numbers);
	/** `Json` with `Key` set to `Value` ("{}" when `Json` is not an object). */
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static FString SetNumber(const FString& Json, const FString& Key, double Value);
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static FString SetString(const FString& Json, const FString& Key, const FString& Value);
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static double GetNumber(const FString& Json, const FString& Key, double Default = 0.0);
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static FString GetString(const FString& Json, const FString& Key);
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static bool GetBool(const FString& Json, const FString& Key, bool bDefault = false);
	/** A member's value as JSON text ("null" when absent). */
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static FString GetField(const FString& Json, const FString& Key);
	UFUNCTION(BlueprintPure, Category = "Genex|JSON")
	static bool IsValidJson(const FString& Json);
};
