#include "GenexAiAskAction.h"

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GenexAiSubsystem.h"

UGenexAiAskAction* UGenexAiAskAction::AskAi(UObject* WorldContext, const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options)
{
	UGenexAiAskAction* Action = NewObject<UGenexAiAskAction>();
	Action->Context = WorldContext;
	Action->Site = Site;
	Action->Prompt = Prompt;
	Action->SchemaJson = SchemaJson;
	Action->Options = Options;
	Action->RegisterWithGameInstance(WorldContext);
	return Action;
}

void UGenexAiAskAction::Activate()
{
	const UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(Context.Get(), EGetWorldErrorMode::ReturnNull) : nullptr;
	UGameInstance* Game = World ? World->GetGameInstance() : nullptr;
	UGenexAiSubsystem* Ai = Game ? Game->GetSubsystem<UGenexAiSubsystem>() : nullptr;
	if (!Ai)
	{
		FGenexAiResult Off;
		Off.Site = Site;
		Off.Code = GenexAiWords::CodeOff;
		Off.ValueJson = Options.FallbackJson;
		Off.bUsedFallback = !Options.FallbackJson.IsEmpty();
		Finish(Off);
		return;
	}
	const FString Ticket = SchemaJson.IsEmpty() ? Ai->Say(Site, Prompt, Options) : Ai->Ask(Site, Prompt, SchemaJson, Options);
	TWeakObjectPtr<UGenexAiAskAction> Self(this);
	Ai->Route(Ticket, [Self](const FGenexAiResult& Result) {
		if (UGenexAiAskAction* Action = Self.Get())
		{
			Action->Finish(Result);
		}
	});
}

void UGenexAiAskAction::Finish(const FGenexAiResult& Result)
{
	if (Result.bOk)
	{
		Answered.Broadcast(Result);
	}
	else
	{
		Failed.Broadcast(Result);
	}
	SetReadyToDestroy();
}
