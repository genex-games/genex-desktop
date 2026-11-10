#include "GenexAsyncActions.h"

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GenexIdentitySubsystem.h"

namespace GenexAsyncDetail
{
template <typename T>
T* Subsystem(UObject* WorldContext)
{
	UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(WorldContext, EGetWorldErrorMode::LogAndReturnNull) : nullptr;
	UGameInstance* Instance = World ? World->GetGameInstance() : nullptr;
	return Instance ? Instance->GetSubsystem<T>() : nullptr;
}
}

// ---- Join Genex Room / Match ----

UGenexJoinRoomAction* UGenexJoinRoomAction::JoinGenexRoom(UObject* WorldContext, const FGenexRoomOptions& Options)
{
	UGenexJoinRoomAction* Action = NewObject<UGenexJoinRoomAction>();
	Action->Subsystem = GenexAsyncDetail::Subsystem<UGenexMultiplayerSubsystem>(WorldContext);
	Action->Options = Options;
	Action->RegisterWithGameInstance(WorldContext);
	return Action;
}

UGenexJoinRoomAction* UGenexJoinRoomAction::JoinGenexMatch(UObject* WorldContext, const FGenexRoomOptions& Options)
{
	FGenexRoomOptions Match = Options;
	Match.Room = EGenexRoomKind::Queue;
	return JoinGenexRoom(WorldContext, Match);
}

void UGenexJoinRoomAction::Activate()
{
	if (!Subsystem)
	{
		Failed.Broadcast(0, TEXT("genex: no game instance"));
		SetReadyToDestroy();
		return;
	}
	// Join bumps the generation once, and everything this node hears must be about that join.
	Generation = Subsystem->GetJoinGeneration() + 1;
	Subsystem->OnJoined.AddDynamic(this, &UGenexJoinRoomAction::HandleJoined);
	Subsystem->OnJoinFailed.AddDynamic(this, &UGenexJoinRoomAction::HandleFailed);
	Subsystem->OnDisconnected.AddDynamic(this, &UGenexJoinRoomAction::HandleFailed);
	AbandonedHandle = Subsystem->OnJoinAbandoned.AddUObject(this, &UGenexJoinRoomAction::HandleAbandoned);
	Subsystem->Join(Options);
}

bool UGenexJoinRoomAction::IsMine() const { return Subsystem && Subsystem->GetJoinGeneration() == Generation; }

void UGenexJoinRoomAction::HandleJoined(const FString& SessionId)
{
	if (!IsMine()) return;
	Finish();
	Joined.Broadcast(SessionId);
}

void UGenexJoinRoomAction::HandleFailed(int32 Code, const FString& Message)
{
	if (!IsMine()) return;
	Finish();
	Failed.Broadcast(Code, Message);
}

void UGenexJoinRoomAction::HandleAbandoned(uint32 AbandonedGeneration)
{
	if (AbandonedGeneration != Generation) return;
	Finish();
	Failed.Broadcast(0, TEXT("genex: the join was dropped (a newer Join replaced it, or the game ended)"));
}

void UGenexJoinRoomAction::Finish()
{
	if (Subsystem)
	{
		Subsystem->OnJoined.RemoveDynamic(this, &UGenexJoinRoomAction::HandleJoined);
		Subsystem->OnJoinFailed.RemoveDynamic(this, &UGenexJoinRoomAction::HandleFailed);
		Subsystem->OnDisconnected.RemoveDynamic(this, &UGenexJoinRoomAction::HandleFailed);
		Subsystem->OnJoinAbandoned.Remove(AbandonedHandle);
	}
	SetReadyToDestroy();
}

// ---- Claim Control ----

UGenexClaimControlAction* UGenexClaimControlAction::ClaimControl(UObject* WorldContext, const FString& ObjectId, bool bAsHost)
{
	UGenexClaimControlAction* Action = NewObject<UGenexClaimControlAction>();
	Action->Subsystem = GenexAsyncDetail::Subsystem<UGenexMultiplayerSubsystem>(WorldContext);
	Action->ObjectId = ObjectId;
	Action->bAsHost = bAsHost;
	Action->RegisterWithGameInstance(WorldContext);
	return Action;
}

void UGenexClaimControlAction::Activate()
{
	RequestId = Subsystem ? Subsystem->Claim(ObjectId, bAsHost) : FString();
	if (RequestId.IsEmpty())
	{
		FGenexControlResult Result;
		Result.Operation = TEXT("claim");
		Result.Id = ObjectId;
		Result.Reason = TEXT("disconnected");
		Refused.Broadcast(Result);
		SetReadyToDestroy();
		return;
	}
	// The answer comes in a later pump frame, never inside Claim: binding after it misses nothing.
	Generation = Subsystem->GetJoinGeneration();
	Subsystem->OnControlResult.AddDynamic(this, &UGenexClaimControlAction::HandleResult);
	AbandonedHandle = Subsystem->OnJoinAbandoned.AddUObject(this, &UGenexClaimControlAction::HandleAbandoned);
}

void UGenexClaimControlAction::HandleResult(const FGenexControlResult& Result)
{
	if (Result.RequestId != RequestId) return;
	Finish(Result);
}

void UGenexClaimControlAction::HandleAbandoned(uint32 AbandonedGeneration)
{
	if (AbandonedGeneration != Generation) return;
	// As the session settles a pending control when it closes (RelaySession Close).
	FGenexControlResult Result;
	Result.RequestId = RequestId;
	Result.Operation = TEXT("claim");
	Result.Id = ObjectId;
	Result.Reason = TEXT("disconnected");
	Finish(Result);
}

void UGenexClaimControlAction::Finish(const FGenexControlResult& Result)
{
	Subsystem->OnControlResult.RemoveDynamic(this, &UGenexClaimControlAction::HandleResult);
	Subsystem->OnJoinAbandoned.Remove(AbandonedHandle);
	if (Result.bAccepted) Granted.Broadcast(Result);
	else Refused.Broadcast(Result);
	SetReadyToDestroy();
}

// ---- Sign in ----

namespace GenexAsyncDetail
{
UGenexSignInAction* MakeSignIn(UObject* WorldContext)
{
	UGenexSignInAction* Action = NewObject<UGenexSignInAction>();
	Action->RegisterWithGameInstance(WorldContext);
	return Action;
}
}

UGenexSignInAction* UGenexSignInAction::SignInAsGuest(UObject* WorldContext)
{
	UGenexSignInAction* Action = GenexAsyncDetail::MakeSignIn(WorldContext);
	Action->Identity = GenexAsyncDetail::Subsystem<UGenexIdentitySubsystem>(WorldContext);
	Action->Door = EDoor::Guest;
	return Action;
}

UGenexSignInAction* UGenexSignInAction::SignInFromLauncher(UObject* WorldContext)
{
	UGenexSignInAction* Action = SignInAsGuest(WorldContext);
	Action->Door = EDoor::Launcher;
	return Action;
}

UGenexSignInAction* UGenexSignInAction::SignInWithDeviceCode(UObject* WorldContext)
{
	UGenexSignInAction* Action = SignInAsGuest(WorldContext);
	Action->Door = EDoor::Device;
	return Action;
}

void UGenexSignInAction::Activate()
{
	if (!Identity)
	{
		Failed.Broadcast(0, TEXT("genex: no game instance"));
		SetReadyToDestroy();
		return;
	}
	// The node's own request and its own answer: the subsystem's OnSignedIn / OnSignInFailed also fire
	// for every other sign-in (a join's automatic one, another node's), which are not this node's.
	const FGenexSignInDone Done = FGenexSignInDone::CreateUObject(this, &UGenexSignInAction::HandleDone);
	switch (Door)
	{
	case EDoor::Launcher:
		Identity->SignInAutomatically(Done);
		break;
	case EDoor::Device:
	{
		TWeakObjectPtr<UGenexSignInAction> Weak(this);
		Identity->StartDeviceSignIn([Weak](const FGenexDeviceCode& Code) {
			if (Weak.IsValid()) Weak->ShowCode.Broadcast(Code);
		}, Done);
		break;
	}
	default:
		Identity->SignInAsGuest(Done);
		break;
	}
}

void UGenexSignInAction::HandleDone(bool bOk, int32 Status, const FString& Message)
{
	SetReadyToDestroy();
	if (bOk) SignedIn.Broadcast();
	else Failed.Broadcast(Status, Message);
}

// ---- Join Genex Authority ----

UGenexJoinAuthorityAction* UGenexJoinAuthorityAction::JoinGenexAuthority(UObject* WorldContext, const FGenexAuthorityOptions& Options)
{
	UGenexJoinAuthorityAction* Action = NewObject<UGenexJoinAuthorityAction>();
	Action->Subsystem = GenexAsyncDetail::Subsystem<UGenexAuthoritySubsystem>(WorldContext);
	Action->Options = Options;
	Action->RegisterWithGameInstance(WorldContext);
	return Action;
}

void UGenexJoinAuthorityAction::Activate()
{
	if (!Subsystem)
	{
		Refused.Broadcast(EGenexJoinRefusal::Other, 0, TEXT("genex: no game instance"));
		SetReadyToDestroy();
		return;
	}
	Generation = Subsystem->GetJoinGeneration() + 1;
	Subsystem->OnConnected.AddDynamic(this, &UGenexJoinAuthorityAction::HandleConnected);
	Subsystem->OnRefused.AddDynamic(this, &UGenexJoinAuthorityAction::HandleRefused);
	Subsystem->OnDisconnected.AddDynamic(this, &UGenexJoinAuthorityAction::HandleDisconnected);
	AbandonedHandle = Subsystem->OnJoinAbandoned.AddUObject(this, &UGenexJoinAuthorityAction::HandleAbandoned);
	Subsystem->Join(Options);
}

bool UGenexJoinAuthorityAction::IsMine() const { return Subsystem && Subsystem->GetJoinGeneration() == Generation; }

void UGenexJoinAuthorityAction::HandleConnected(const FString& SessionId)
{
	if (!IsMine()) return;
	Finish();
	Connected.Broadcast(SessionId);
}

void UGenexJoinAuthorityAction::HandleRefused(EGenexJoinRefusal Refusal, int32 Code, const FString& Message)
{
	if (!IsMine()) return;
	Finish();
	Refused.Broadcast(Refusal, Code, Message);
}

void UGenexJoinAuthorityAction::HandleDisconnected(int32 Code)
{
	if (!IsMine()) return;
	Finish();
	Refused.Broadcast(EGenexJoinRefusal::Other, Code, FString::Printf(TEXT("genex: disconnected (%d) before the room was ready"), Code));
}

void UGenexJoinAuthorityAction::HandleAbandoned(uint32 AbandonedGeneration)
{
	if (AbandonedGeneration != Generation) return;
	Finish();
	Refused.Broadcast(EGenexJoinRefusal::Other, 0, TEXT("genex: the join was dropped before the room was ready (Leave, a newer Join, or the game ended)"));
}

void UGenexJoinAuthorityAction::Finish()
{
	if (Subsystem)
	{
		Subsystem->OnConnected.RemoveDynamic(this, &UGenexJoinAuthorityAction::HandleConnected);
		Subsystem->OnRefused.RemoveDynamic(this, &UGenexJoinAuthorityAction::HandleRefused);
		Subsystem->OnDisconnected.RemoveDynamic(this, &UGenexJoinAuthorityAction::HandleDisconnected);
		Subsystem->OnJoinAbandoned.Remove(AbandonedHandle);
	}
	SetReadyToDestroy();
}
