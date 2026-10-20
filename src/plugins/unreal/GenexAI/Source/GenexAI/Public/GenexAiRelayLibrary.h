// Genex's side of the relay: the Genex editor helper's relay tools call these through the editor's
// own port while the game plays in the editor (Studio's `ai-relay.ts`), so no port or token is added.
// Pull hands Studio the lines the game queued; Push hands the game Studio's answers, as base64 of
// their JSON so nothing in them is ever code. A game calls neither.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "GenexAiRelayLibrary.generated.h"

UCLASS()
class GENEXAI_API UGenexAiRelayLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** {playing, lines, echo} as JSON text: whether a game plays, and each line it queued since. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI|Relay")
	static FString Pull();

	/** Studio's answers ([{op, args}] as base64 of JSON); false when none was taken in. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI|Relay")
	static bool Push(const FString& Base64);
};
