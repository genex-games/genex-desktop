// The Ask AI Blueprint node: asks once and fires Answered or Failed on the game's tick, with the
// result's JSON. A Failed result carries the fallback the options named, so the game plays on.
#pragma once

#include "CoreMinimal.h"
#include "GenexAiTypes.h"
#include "Kismet/BlueprintAsyncActionBase.h"
#include "GenexAiAskAction.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexAiAskDone, const FGenexAiResult&, Result);

UCLASS()
class GENEXAI_API UGenexAiAskAction : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	/** Ask a model for JSON that fits SchemaJson (an empty schema asks for streamed text, as Say). */
	UFUNCTION(BlueprintCallable, Category = "Genex AI", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Ask AI"))
	static UGenexAiAskAction* AskAi(UObject* WorldContext, const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options);

	UPROPERTY(BlueprintAssignable)
	FGenexAiAskDone Answered;

	UPROPERTY(BlueprintAssignable)
	FGenexAiAskDone Failed;

	virtual void Activate() override;

private:
	void Finish(const FGenexAiResult& Result);

	TWeakObjectPtr<UObject> Context;
	FString Site;
	FString Prompt;
	FString SchemaJson;
	FGenexAiOptions Options;
};
