// Genex play-time AI for an Unreal game (docs/play-protocol.md in Genex, "Play-time AI"): the game
// asks a model for text, or for JSON that fits a USTRUCT, and Genex answers on the model the person
// chose.
//
//   UGenexAiSubsystem* Ai = GetGameInstance()->GetSubsystem<UGenexAiSubsystem>();
//   Ai->AskStruct(TEXT("turn.resolve"), Prompt, FVerdict::StaticStruct(), Options);
//   for (const FGenexAiResult& Result : Ai->Drain()) { /* clamp, then apply */ }
//
// A call answers its ticket at once. Its result enters the game only through Drain(), called once
// per fixed step (or through the Ask AI Blueprint node, which the subsystem completes on its tick):
// answers are data, so clamp them before they change the world. Never put player-typed text in a
// prompt: pass it in Options.Untrusted. Genex relays the calls while the game plays in this editor
// (UGenexAiRelayLibrary, pulled through the editor's port); a build shipped outside Genex answers
// ai_off at once and plays its fallbacks.
#pragma once

#include "CoreMinimal.h"
#include "GenexAiTypes.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Tickable.h"
#include "GenexAiSubsystem.generated.h"

class FJsonObject;
class FJsonValue;

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FGenexAiChanged);

/** The game's play-time AI, one per game instance. */
UCLASS()
class GENEXAI_API UGenexAiSubsystem : public UGameInstanceSubsystem, public FTickableGameObject
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** Whether the game requires AI ("ai") or works without it ("optional", the default). */
	UPROPERTY(BlueprintReadWrite, Category = "Genex AI")
	FString Requires = TEXT("optional");

	/** Fires when the game's AI turns on or off, or its grant changes. */
	UPROPERTY(BlueprintAssignable, Category = "Genex AI")
	FGenexAiChanged OnChanged;

	/** JSON that fits SchemaJson (Genex's closed dialect); answers the call's ticket. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	FString Ask(const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options);

	/** JSON that fits a USTRUCT (see GenexAiSchema.h); read the value with FJsonObjectConverter. */
	FString AskStruct(const FString& Site, const FString& Prompt, const UScriptStruct* Struct, const FGenexAiOptions& Options);

	/** Free text, streamed: Partial(ticket) holds what has arrived so far. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	FString Say(const FString& Site, const FString& Prompt, const FGenexAiOptions& Options);

	/** A classification of a state against fixed questions, as JSON that fits SchemaJson. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	FString Judge(const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options);

	/** One tool of a fixed set picked, as JSON that fits SchemaJson. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	FString Act(const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options);

	/** Stop waiting for a call; its result still arrives once. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	void Cancel(const FString& Ticket);

	/** The results that arrived since the last Drain, oldest first. Call it once per fixed step. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	TArray<FGenexAiResult> Drain();

	/** A streamed Say's text so far; empty before any arrives and once its result did. */
	UFUNCTION(BlueprintPure, Category = "Genex AI")
	FString Partial(const FString& Ticket) const;

	/** Start AI for this game from a player's action: Genex picks, and asks only before plan or credits. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	void StartAi(const TArray<FString>& Tiers);

	/** The game turns its own AI off. */
	UFUNCTION(BlueprintCallable, Category = "Genex AI")
	void StopAi();

	/** Whether Genex said AI runs for this game here. */
	UFUNCTION(BlueprintPure, Category = "Genex AI")
	bool IsOn() const;

	/** A ticket whose result goes to the Ask AI node that made it, never to Drain. */
	void Route(const FString& Ticket, TFunction<void(const FGenexAiResult&)> Done);

	// FTickableGameObject: completes the Ask AI nodes' calls on the game's tick.
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual bool IsTickable() const override;
	virtual ETickableTickType GetTickableTickType() const override { return ETickableTickType::Conditional; }

	/** The relay's pull: {playing, lines, echo} as JSON text (UGenexAiRelayLibrary). */
	static FString PullForStudio();

	/** The relay's push: Studio's answers, base64 of their JSON; false when none was taken in. */
	static bool PushFromStudio(const FString& Base64);

private:
	enum class EKind : uint8 { Call, Grant, Other };

	struct FPending
	{
		EKind Kind = EKind::Other;
		FString Ticket;
		FString Site;
		FString FallbackJson;
	};

	FString Call(const FString& Op, const FString& Site, const FString& Prompt, TSharedPtr<FJsonValue> Schema, const FGenexAiOptions& Options);
	FString Refused(const FString& Site, const FGenexAiOptions& Options, const TCHAR* Code);
	FPending NewCall(const FString& Site, const FGenexAiOptions& Options);
	void Send(const FString& Op, TSharedPtr<FJsonValue> Body, const FPending& Entry);
	void Settle(const FPending& Entry, const FString& Code);
	FGenexAiResult ResultOf(const FPending& Entry, const TSharedPtr<FJsonObject>& Answer);
	FGenexAiResult Failure(const FPending& Entry, const FString& Code) const;
	bool TakeStudioOp(const FString& Op, const TSharedPtr<FJsonObject>& Args);
	void EndWaiting(const TCHAR* Code);
	void SetOn(bool bValue);
	bool RelayFresh() const;
	FString GrantId() const;
	TArray<FGenexAiResult> TakeArrived();

	mutable FCriticalSection Gate;
	TMap<FString, FPending> Waiting;
	TArray<FString> WaitingOrder;
	TMap<FString, FString> Partials;
	TArray<FGenexAiResult> Arrived;
	TArray<FString> Queued;
	TArray<FString> Asked;
	TArray<FString> Answered;
	TMap<FString, TFunction<void(const FGenexAiResult&)>> Routed;
	TSharedPtr<FJsonObject> Grant;
	int32 Rids = 0;
	int32 Tickets = 0;
	bool bOn = false;
	bool bChanged = false;
};
