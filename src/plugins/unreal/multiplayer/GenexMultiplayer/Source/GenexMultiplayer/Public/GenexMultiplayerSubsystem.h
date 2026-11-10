// Genex relay multiplayer (protocol 3, PROTOCOL.md) for one game instance: players, shared state,
// owned objects with confirmed control, the host, game events, chat and reconnection, over
// GenexCore's RelaySession. Each PIE client has its own game instance and so its own session; the
// plugin module pumps them all once per frame before any world ticks, and this subsystem fires its
// events right after its session's update, so game code sees this frame's state.
//
// Free-form state is JSON text (Blueprint has no JSON value); positions in the location helpers are
// Unreal units, converted with UGenexSettings::UnitsPerMeter (Genex x/y/z = Unreal X/Y/Z, yaw in
// degrees here, radians on the wire).
#pragma once

#include "CoreMinimal.h"
#include "GenexTypes.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GenexMultiplayerSubsystem.generated.h"

namespace genex { class Json; class RelaySession; struct RelayEvent; }
class FGenexRelayPumpHook;
struct FGenexRelayTokenSource;

/** C++: the join (and its session) of this Join generation ended without an event of its own. */
DECLARE_MULTICAST_DELEGATE_OneParam(FGenexJoinAbandoned, uint32 /*Generation*/);

/** Which room a join enters (PROTOCOL.md §3.5). */
UENUM(BlueprintType)
enum class EGenexRoomKind : uint8
{
	/** The game's plain relay room. */
	Play,
	/** Through the matchmaking queue into a match (untested against a real queue). */
	Queue,
	/** A new private lobby; its room id is the invite code (untested). */
	CreatePrivate,
	/** A friend's private lobby by invite code (untested). */
	JoinById,
};

USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexRoomOptions
{
	GENERATED_BODY()

	/** The game's slug; empty = the project's Genex slug (UGenexSettings). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString GameId;
	/** A display name (a signed-in player's own name wins). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString Name;
	/** Relay URLs; empty = the sign-in answer's, else the project's development RelayUrls. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") TArray<FString> RelayUrls;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") EGenexRoomKind Room = EGenexRoomKind::Play;
	/** The invite code for JoinById. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString JoinCode;
	/** The most player/object publishes per second (1-30); faster calls coalesce. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") float PublishHz = 30.f;
	/** Extra join options, a JSON object (the relay refuses its server-owned names). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString ExtraOptionsJson;
	/** Sign in as a guest (after the launcher's ticket, if any) when nobody is signed in. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") bool bSignInAutomatically = true;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexIdSignature, const FString&, Id);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexCodeMessageSignature, int32, Code, const FString&, Message);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexObjectChangedSignature, const FString&, Id, const FString&, Owner);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexMessageSignature, const FString&, Type, const FString&, DataJson);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexControlResultSignature, const FGenexControlResult&, Result);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexChatSignature, const FGenexChatMessage&, Message);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexCodeSignature, int32, Code);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FGenexVoidSignature);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexBoolSignature, bool, bValue);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexQueueSignature, int32, Position, int32, Size);

UCLASS()
class GENEXMULTIPLAYER_API UGenexMultiplayerSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Out of line, and the members are TSharedPtr (whose deleter is bound where it is made): their types
	 *  are complete only in the .cpp, never in UHT's generated file. */
	UGenexMultiplayerSubsystem();
	virtual ~UGenexMultiplayerSubsystem() override;
	virtual void Deinitialize() override;

	// ---- lifecycle ----
	/** Join a room. OnJoined (or OnJoinFailed) follows; a join while one is open leaves it first. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay")
	void Join(const FGenexRoomOptions& Options);
	/** Leave with consent (no reconnect). OnDisconnected follows, also for a Join still signing in
	 *  (which then joins nothing). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay")
	void Leave();
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool IsJoined() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool IsConnected() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") EGenexStatus GetStatus() const { return Status; }
	/** Why the last join failed or the session ended ("" while none did). */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") FString GetLastError() const { return LastError; }
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") FString GetSessionId() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") FString GetRoomId() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") FString GetHostId() const;
	/** Run host-only logic now: elected, connected, and past the post-reconnect sequence. */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool IsHost() const;

	// ---- players ----
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") TArray<FGenexPlayer> GetPlayers() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool GetPlayer(const FString& Id, FGenexPlayer& OutPlayer) const;
	/** A player's state as the game should draw it now (interpolated for others), JSON. */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") FString GetPlayerStateJson(const FString& Id) const;
	/** Publish your own state (a JSON object), rate-limited to PublishHz. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SetMyStateJson(const FString& StateJson);
	/** A deliberate discontinuity (teleport, respawn): receivers do not interpolate across it. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SnapMyStateJson(const FString& StateJson);
	/** SetMyState with {x, y, z, yaw, q} from an Unreal location and yaw (degrees), merged over
	 *  `ExtraJson` (whose keys of those names it replaces): `q` is the yaw as a quaternion about Z, which
	 *  receivers slerp the short way round where a plain yaw would sweep through the opposite facing. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SetMyLocation(FVector Location, float YawDegrees, const FString& ExtraJson);
	/** A player's drawn {x, y, z} and yaw (from `q` when it carries one, else `yaw`) as an Unreal
	 *  location and yaw (degrees); false when unknown. */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool GetPlayerLocation(const FString& Id, FVector& OutLocation, float& OutYawDegrees) const;

	// ---- shared ----
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SetShared(const FString& Key, const FString& ValueJson);
	/** The shared value as JSON ("null" when absent). */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") FString GetShared(const FString& Key) const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") TArray<FString> GetSharedKeys() const;

	// ---- objects ----
	/** Ask to own object `Id`; the answer is OnControlResult with the returned request id (or use the Claim Control node). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") FString Claim(const FString& Id, bool bAsHost = false);
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") FString Release(const FString& Id);
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") FString Destroy(const FString& Id);
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool Owns(const FString& Id) const;
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SetObjectJson(const FString& Id, const FString& StateJson);
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SnapObjectJson(const FString& Id, const FString& StateJson);
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") TArray<FGenexObject> GetObjects() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") bool GetObject(const FString& Id, FGenexObject& OutObject) const;

	// ---- events, input, chat ----
	/** A game event to every other client (not queued while disconnected). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SendEvent(const FString& Type, const FString& DataJson);
	/** An input to the current host (PROTOCOL.md §6.4). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SendInput(const FString& DataJson);
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SendChat(const FString& Text);
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") TArray<FGenexChatMessage> GetChatHistory() const;
	/** Host only: close or reopen the room to new matchmaking placements. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Relay") bool SetRoomOpen(bool bOpen);

	// ---- clock ----
	/** The relay's room clock (ms), or -1 when it publishes none. */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") double GetServerNow() const;
	/** Smoothed round trip (ms), or -1. */
	UFUNCTION(BlueprintPure, Category = "Genex|Relay") double GetRtt() const;

	// ---- events ----
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnJoined;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexCodeMessageSignature OnJoinFailed;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnPlayerJoined;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnPlayerLeft;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnHostChanged;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnSharedChanged;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexObjectChangedSignature OnObjectChanged;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnObjectRemoved;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexControlResultSignature OnControlResult;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexMessageSignature OnMessage;
	/** An input forwarded to you as host: the sender's id and its data. */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexMessageSignature OnInputReceived;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexChatSignature OnChat;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexCodeSignature OnReconnecting;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexVoidSignature OnReconnected;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexCodeMessageSignature OnDisconnected;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexBoolSignature OnRoomOpenChanged;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexVoidSignature OnServerRestart;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexQueueSignature OnQueueUpdate;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexCodeSignature OnMatchStarted;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexMessageSignature OnMatchEnded;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Relay") FGenexIdSignature OnWarning;

	/** GenexCore's session (C++ games may use it directly), or null. */
	genex::RelaySession* Core() const { return Session.Get(); }

	/** C++: bumped by every Join; the generation an event or a node belongs to. */
	uint32 GetJoinGeneration() const { return JoinGeneration; }
	/** C++: a Join's attempt or session was dropped with no event of its own to say so: a newer Join
	 *  replaced it, or the game instance ended. The async nodes end on it. */
	FGenexJoinAbandoned OnJoinAbandoned;

	/** C++: what the current session's next join would send (it asks right before every join it
	 *  starts, a matchmaking seat or a requeue included): true with the token, or false with why not. */
	bool PeekJoinToken(FString& OutToken, FString& OutError) const;

	/** C++: the player state SetMyLocation publishes ({x, y, z, yaw, q} over `ExtraJson`); false when
	 *  ExtraJson is not a JSON object. */
	static bool LocationState(const FVector& Location, float YawDegrees, const FString& ExtraJson, genex::Json& OutState);
	/** C++: the location and yaw (degrees) a drawn player state says; false without x. */
	static bool ReadLocation(const genex::Json& State, FVector& OutLocation, float& OutYawDegrees);

	/** Called by the pump hook right after the session's update. */
	void DispatchEvents();
	/** Called by the pump hook: keeps the token the next join of an open session sends valid. */
	void KeepTokenFresh();

private:
	void StartSession(const FGenexRoomOptions& Options, bool bLocalPlaceholder);
	void Dispatch(const genex::RelayEvent& Event);
	void Teardown();
	void FailJoin(int32 Code, const FString& Message);
	/** Join `Generation` is still waiting on a sign-in or a token: no Leave and no newer Join since. */
	bool IsPending(uint32 Generation) const;

	TSharedPtr<genex::RelaySession> Session;
	TSharedPtr<FGenexRelayPumpHook> Hook;
	TSharedPtr<FGenexRelayTokenSource> TokenSource;
	EGenexStatus Status = EGenexStatus::Idle;
	FString LastError;
	/** Bumped per Join, so a sign-in answer for an older Join starts nothing. */
	uint32 JoinGeneration = 0;
};
