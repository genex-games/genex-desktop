// Blueprint async nodes over the Genex subsystems: each fires one output pin once, then ends. A node
// answers only for its own request: a join node for the Join it started (a Leave, a newer Join or the
// game ending fails it rather than leaving it waiting), a sign-in node for its own sign-in.
#pragma once

#include "CoreMinimal.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexMultiplayerSubsystem.h"
#include "GenexTypes.h"
#include "Kismet/BlueprintAsyncActionBase.h"
#include "GenexAsyncActions.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexJoinedPin, const FString&, SessionId);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexFailedPin, int32, Code, const FString&, Message);

/** Join Genex Room / Join Genex Match: Joined with your session id, or Failed with the code. */
UCLASS()
class GENEXMULTIPLAYER_API UGenexJoinRoomAction : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	/** Join the game's relay room (signs in as a guest first when nobody is signed in). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Join Genex Room"))
	static UGenexJoinRoomAction* JoinGenexRoom(UObject* WorldContext, const FGenexRoomOptions& Options);

	/** Search through the matchmaking queue and take the match seat it reserves (PROTOCOL.md §9). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Join Genex Match"))
	static UGenexJoinRoomAction* JoinGenexMatch(UObject* WorldContext, const FGenexRoomOptions& Options);

	UPROPERTY(BlueprintAssignable) FGenexJoinedPin Joined;
	UPROPERTY(BlueprintAssignable) FGenexFailedPin Failed;

	virtual void Activate() override;

private:
	UFUNCTION() void HandleJoined(const FString& SessionId);
	/** OnJoinFailed, and OnDisconnected before the join completed (a Leave while it connected). */
	UFUNCTION() void HandleFailed(int32 Code, const FString& Message);
	void HandleAbandoned(uint32 AbandonedGeneration);
	bool IsMine() const;
	void Finish();

	UPROPERTY() TObjectPtr<UGenexMultiplayerSubsystem> Subsystem;
	FGenexRoomOptions Options;
	/** The subsystem's join generation this node's Join runs as. */
	uint32 Generation = 0;
	FDelegateHandle AbandonedHandle;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexControlPin, const FGenexControlResult&, Result);

/** Claim Control: ask to own a shared object; Granted or Refused with the relay's answer. */
UCLASS()
class GENEXMULTIPLAYER_API UGenexClaimControlAction : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Claim Control"))
	static UGenexClaimControlAction* ClaimControl(UObject* WorldContext, const FString& ObjectId, bool bAsHost = false);

	UPROPERTY(BlueprintAssignable) FGenexControlPin Granted;
	UPROPERTY(BlueprintAssignable) FGenexControlPin Refused;

	virtual void Activate() override;

private:
	UFUNCTION() void HandleResult(const FGenexControlResult& Result);
	/** The session the claim was sent on was replaced or ended without settling it. */
	void HandleAbandoned(uint32 AbandonedGeneration);
	void Finish(const FGenexControlResult& Result);

	UPROPERTY() TObjectPtr<UGenexMultiplayerSubsystem> Subsystem;
	FString ObjectId;
	FString RequestId;
	bool bAsHost = false;
	uint32 Generation = 0;
	FDelegateHandle AbandonedHandle;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FGenexSignedInPin);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexDeviceCodePin, const FGenexDeviceCode&, Code);

/** The sign-in doors (CLI_INTEGRATION.md §6b) as nodes: Signed In, or Failed. */
UCLASS()
class GENEXMULTIPLAYER_API UGenexSignInAction : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	/** Door 1: a guest of a published game. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Sign In As Guest"))
	static UGenexSignInAction* SignInAsGuest(UObject* WorldContext);
	/** Door 2, then door 1: the Genex launcher's ticket when the game was started by one, else a guest. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Sign In From Launcher"))
	static UGenexSignInAction* SignInFromLauncher(UObject* WorldContext);
	/** Door 3: Show Code fires with what to display; Signed In once the player approves it. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Sign In With Device Code"))
	static UGenexSignInAction* SignInWithDeviceCode(UObject* WorldContext);

	UPROPERTY(BlueprintAssignable) FGenexSignedInPin SignedIn;
	UPROPERTY(BlueprintAssignable) FGenexDeviceCodePin ShowCode;
	UPROPERTY(BlueprintAssignable) FGenexFailedPin Failed;

	virtual void Activate() override;

private:
	/** This node's own sign-in answered (never another caller's). */
	void HandleDone(bool bOk, int32 Status, const FString& Message);

	enum class EDoor : uint8 { Guest, Launcher, Device };
	UPROPERTY() TObjectPtr<class UGenexIdentitySubsystem> Identity;
	EDoor Door = EDoor::Guest;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexRefusedPin, EGenexJoinRefusal, Refusal, int32, Code, const FString&, Message);

/** Join Genex Authority: Connected once the authority room is ready to draw, or Refused with a
 *  typed reason (402 not entitled, 424 no module, 429 quota, 503 capacity after 1/2/4 s, …). */
UCLASS()
class GENEXMULTIPLAYER_API UGenexJoinAuthorityAction : public UBlueprintAsyncActionBase
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContext", DisplayName = "Join Genex Authority"))
	static UGenexJoinAuthorityAction* JoinGenexAuthority(UObject* WorldContext, const FGenexAuthorityOptions& Options);

	UPROPERTY(BlueprintAssignable) FGenexJoinedPin Connected;
	UPROPERTY(BlueprintAssignable) FGenexRefusedPin Refused;

	virtual void Activate() override;

private:
	UFUNCTION() void HandleConnected(const FString& SessionId);
	UFUNCTION() void HandleRefused(EGenexJoinRefusal Refusal, int32 Code, const FString& Message);
	/** The session ended after the seat but before the room was ready. */
	UFUNCTION() void HandleDisconnected(int32 Code);
	/** Leave, a newer Join or the game ending, before the room was ready. */
	void HandleAbandoned(uint32 AbandonedGeneration);
	bool IsMine() const;
	void Finish();

	UPROPERTY() TObjectPtr<UGenexAuthoritySubsystem> Subsystem;
	FGenexAuthorityOptions Options;
	uint32 Generation = 0;
	FDelegateHandle AbandonedHandle;
};
