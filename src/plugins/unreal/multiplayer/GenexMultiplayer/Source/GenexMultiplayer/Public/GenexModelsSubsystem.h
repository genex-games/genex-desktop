// In-game model calls for an Unreal game: an NPC that answers in its own words, a judge that reads
// what the player typed. The PLAYER pays and approves, on a Genex surface the game cannot draw or
// skip. The calls are @genex-ai/embed-sdk's, under the same names and with the same result shapes
// (the bodies as JSON text), so what is written for a TypeScript game applies.
//
// The player approves the game's budget on the game's Genex page, before starting the game. Calls
// under that budget work here, over HTTPS with the player's own sign-in (UGenexIdentitySubsystem):
// GetActiveSpendGrant finds the budget, then Generate and GenerateStream with its `grantId`, Judge
// and the reads run under it. A native build has no approval window, so what needs one does not
// work: Generate without a `grantId` settles `native_unsupported`, and RequestSpendGrant asks the
// player nothing: it answers the budget they already approved, or `budget_not_approved`.
// GenerateStream's text arrives whole, as one OnDelta before OnSettled.
// The engine-free half is GenexCore/GenexModels.h and GenexCore/GenexModelsHttp.h.
//
//   UGenexModelsSubsystem* Models = GetGameInstance()->GetSubsystem<UGenexModelsSubsystem>();
//   Models->OnSettled.AddDynamic(this, &AInnkeeper::OnModelsSettled);
//   Models->Init(TEXT("my-game"));                        // signs the player in: the launcher's ticket, else a guest
//   const int32 Budget = Models->GetActiveSpendGrant();   // OnModelsSettled(Budget, "getActiveSpendGrant", "{\"id\":\"…\",…}") or "null"
//   const int32 Asked = Models->Generate(TEXT("{\"grantId\":\"…\",\"modelId\":\"…\",\"prompt\":\"…\",\"outputFormat\":\"text\",\"maxCredits\":5}"));
//   // OnModelsSettled(Asked, "generate", "{\"status\":\"succeeded\",\"output\":\"…\",…}"); when it failed,
//   // Models->GenerationErrorMessage(<its error>) is a sentence to show.
#pragma once

#include "Containers/Ticker.h"
#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GenexModelsSubsystem.generated.h"

namespace genex::models { class Models; }
class FGenexModelsHttp;

/** A call settled: `ResultJson` is what the JavaScript call resolves with, as JSON text. For Generate, GenerateStream,
 *  Judge, RequestSpendGrant and WaitForGeneration an object with `status` (and `error` when it failed); for a read,
 *  the view (`null` from GetActiveSpendGrant when there is no live budget). */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexModelsSettledSignature, int32, Request, const FString&, Call, const FString&, ResultJson);
/** A read the JavaScript call rejects (GetGenerationModels, GetGeneration, GetSpendGrant, GetActiveSpendGrant,
 *  StopSpendGrant, Init): `Error` is the code. */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexModelsRejectedSignature, int32, Request, const FString&, Call, const FString&, Error);
/** GenerateStream: `Text` arrived since the last frame, `SoFar` is all of it. A native build reads the answer whole,
 *  so this fires once, with all of the text, right before OnSettled. */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexModelsDeltaSignature, int32, Request, const FString&, Text, const FString&, SoFar);
/** GenerateStream with a JSON answer: the schema's first string property (`Name`) as far as written (`Text`). Only a
 *  page's bridge sends it; nothing fires it in a native build. */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexModelsPartialFieldSignature, int32, Request, const FString&, Name, const FString&, Text);
/** The call opens the Genex approval window and a browser needs a click, tap or key press for that: `bWaiting` is
 *  true while it waits for the player's next one, false once it has run or given up. A native build opens no window,
 *  so nothing fires it there. */
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexModelsGestureSignature, int32, Request, const FString&, Call, bool, bWaiting);

/** For C++ callers: one call's end. `bRejected` false: `Body` is the result as JSON text; true: `Body` is the code. */
DECLARE_MULTICAST_DELEGATE_FourParams(FGenexModelsEndedNative, int32 /*Request*/, const FString& /*Call*/, bool /*bRejected*/, const FString& /*Body*/);

UCLASS()
class GENEXMULTIPLAYER_API UGenexModelsSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Out of line, and the members are TSharedPtr (whose deleter is bound where it is made): their types are
	 *  complete only in the .cpp, never in UHT's generated file. */
	UGenexModelsSubsystem();
	virtual ~UGenexModelsSubsystem() override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** Whether model calls can work at all in this build: true. Calls under a budget the player approved on the
	 *  game's Genex page work; whether this player has one is GetActiveSpendGrant's answer (`null`: none), and that
	 *  is what decides whether to show the feature's entry point or play authored content. */
	UFUNCTION(BlueprintPure, Category = "Genex|Models")
	bool IsSupported() const;

	/** Wait for the player (guest or signed in); `GameId` is the game's slug. Signs the player in first when
	 *  nobody is (the launcher's ticket, else a guest), then resolves with `user`, `guest` and `shell` ("app").
	 *  Calls made while it settles wait for it. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 Init(const FString& GameId);
	/** The stand's models, featured first. Render a picker from this, never from a list in source. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 GetGenerationModels();
	/** One call (`OptionsJson`: the JavaScript options as a JSON object). With `grantId` the player's budget admits
	 *  it; without one it would open the Genex approval window, which a native build does not have: it settles
	 *  `native_unsupported`. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 Generate(const FString& OptionsJson);
	/** The same call under a budget. Its text arrives whole: one OnDelta with all of it, then OnSettled. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 GenerateStream(const FString& OptionsJson);
	/** The budget's classifier: typed questions about the game's own state. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 Judge(const FString& OptionsJson);
	/** The player's standing budget. A native build asks the player nothing: it settles `active` with the budget
	 *  they approved on the game's Genex page, or `failed` with `budget_not_approved` when there is none. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 RequestSpendGrant(const FString& OptionsJson);
	/** The budget's live state and counters: the one source for an in-game readout. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 GetSpendGrant(const FString& GrantId);
	/** The player's live budget in this game; resolves `null` when there is none. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 GetActiveSpendGrant();
	/** The game's own stop: no further calls are admitted, what is in flight settles. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 StopSpendGrant(const FString& GrantId);
	/** Re-attach to a call already started. `TimeoutMs` above 0 is how long to wait, never a cancellation. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 WaitForGeneration(const FString& GenerationId, float TimeoutMs = 0.0f);
	/** The call's view as the server holds it. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	int32 GetGeneration(const FString& GenerationId);

	/** Stop waiting for a GenerateStream that has not settled: it settles `pending` with `stream_aborted`, and the
	 *  call itself still finishes and is charged. False for anything else. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	bool Cancel(int32 Request);
	/** The platform's player-facing sentence for an error code (empty: none): show it, or an in-fiction line keyed
	 *  off the same code, never the raw code. */
	UFUNCTION(BlueprintPure, Category = "Genex|Models")
	FString GenerationErrorMessage(const FString& Code) const;
	/** Hands over what settled or arrived since the last call. Runs once per frame by itself. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Models")
	void Poll();

	UPROPERTY(BlueprintAssignable, Category = "Genex|Models")
	FGenexModelsSettledSignature OnSettled;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Models")
	FGenexModelsRejectedSignature OnRejected;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Models")
	FGenexModelsDeltaSignature OnDelta;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Models")
	FGenexModelsPartialFieldSignature OnPartialField;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Models")
	FGenexModelsGestureSignature OnGesture;
	/** OnSettled and OnRejected in one, for C++. */
	FGenexModelsEndedNative OnEndedNative;

private:
	bool OnTicker(float DeltaSeconds);

	/** The transport the bridge sends through (the identity subsystem's own); outlives Models. */
	TSharedPtr<FGenexModelsHttp> Http;
	TSharedPtr<genex::models::Models> Models;
	FTSTicker::FDelegateHandle TickerHandle;
};
