// The closed JSON-schema dialect Genex holds every answer to, made from a USTRUCT by reflection: an
// object lists every property as required, with additionalProperties false; an enum is a string
// enum of its names; meta=(GenexMaxItems=N) and meta=(GenexMaxLength=N) bound arrays and strings.
// Genex checks the schema again before any model sees it.
#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class UScriptStruct;

namespace GenexAiSchema
{
	/** The deepest a schema nests (Genex's dialect). */
	constexpr int32 MaxDepth = 5;

	/** The schema of `Struct` as JSON text; empty when the dialect cannot say it (Why says what). */
	GENEXAI_API FString For(const UScriptStruct* Struct, FString& Why);

	/** The schema of `Struct` as a JSON object; null when the dialect cannot say it. */
	GENEXAI_API TSharedPtr<FJsonObject> ObjectFor(const UScriptStruct* Struct, FString& Why);
}
