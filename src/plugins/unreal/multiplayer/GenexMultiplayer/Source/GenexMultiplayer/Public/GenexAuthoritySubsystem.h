// Genex server-authoritative rooms (protocol 4, PROTOCOL.md §17) for one game instance, over
// GenexCore's AuthoritySession: the server runs the game's room module; this client sends one
// input per fixed step (SetInput stages it) and draws what the server decided — your own entity
// predicted with the room's movement preset, every other one 100 ms behind on the timeline the
// server's lag compensation rewinds to. Separate from the relay subsystem, so relay games are
// untouched.
//
// Which server: Options.Url, else Options.Urls (the sign-in answer's authorityUrls when empty),
// else GENEX_AUTHORITY_URL (the editor module sets it for PIE from Genex Studio's local server),
// else the project's development AuthorityUrl. A join that would carry the player's token signs in
// first (when nobody is and bSignInAutomatically) and picks the server after, so the answer's
// authorityUrls take their place in that order. A single server on this machine gets the local test
// placeholder token and never the player's (no sign-in for it); any other gets the signed-in player's.
#pragma once

#include "CoreMinimal.h"
#include "GenexMultiplayerSubsystem.h"
#include "GenexTypes.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GenexCore/GenexPhysicsPredictor.h"
#include "GenexCore/GenexSeatContacts.h"
#include "GenexCore/GenexSeatPredict.h"

#include <memory>
#include <string>

#include "GenexAuthoritySubsystem.generated.h"

namespace genex { class AuthoritySession; class AuthorityRegionMeter; class FirstpersonWorld; }
class FGenexAuthorityPumpHook;
class UGenexCollisionWorld;

USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexAuthorityOptions
{
	GENERATED_BODY()

	/** The game's slug; empty = the project's Genex slug. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString GameId;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString Name;
	/** A pool of the game's rooms: only seats asking for the same key share one (§17.1); empty is the default pool. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString MatchKey;
	/** One authority server (wins over Urls). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString Url;
	/** The authority cluster; empty = the sign-in answer's authorityUrls. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") TArray<FString> Urls;
	/** How the join picks its region (PROTOCOL.md §17.1 *Finding players*). Players (default): the regions in reach
	 *  (MaxPingMs) are asked for a room that already has players, nearest first, then the ones that did not answer the
	 *  probe, and a room is opened in the nearest one only when none has, so players in different regions meet.
	 *  Nearest: the nearest region, whoever is elsewhere. Url always joins that one server. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Regions") EGenexRegionRule RegionRule = EGenexRegionRule::Players;
	/** The farthest region asked for players, as a probe's round trip in ms; anything but a finite number >= 0 is 350. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Regions", meta = (ClampMin = "0")) float MaxPingMs = 350.f;
	/** The one region to play in, by its name in the sign-in answer's regions (a player's own choice; a Urls entry is
	 *  its own name): no other is joined or created in. Empty, or a name the cluster does not have, is no pin. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Regions") FString Region;
	/** The player's home region (PROTOCOL.md §17.1 *Regions*), asked for players and created in first, whatever the
	 *  probe measured; Region wins over it. Empty: the sign-in answer's (colyseus.authorityHome, the player's region by
	 *  geography) when the join uses the sign-in answer's servers. Empty, or a name the cluster does not have, is no home. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Regions") FString Home;
	/** Regrouping (PROTOCOL.md §17.1 *Regrouping*), on by default: while the player is alone in a pool room, the regions
	 *  listed before the seat's own (in reach, or silent) are asked after 2, 4, 9, 15 and then every 30 s for a room that has
	 *  players, and the seat moves there: On Rejoined fires (Was Moved true inside it) and the old room is left. Two players who
	 *  started at the same moment in two regions meet this way. A private room, a join by code, Url, a pinned Region
	 *  and the rule Nearest never regroup. False keeps the player where they are. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Regions") bool bRegroup = true;
	/** Predict your own entity with the room's preset (off: draw it from the server's state). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") bool bPredict = true;
	/** Predict a predicting physics room's bodies near you with the plugin's physics core (PROTOCOL.md
	 *  §17.11): drawn at your present instead of the server's. False is the client's kill switch. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Physics") bool bPredictPhysics = true;
	/** The fast channel (PROTOCOL.md §17.12), on by default: in a room that offers it, your inputs and the room's
	 *  motion go by UDP datagram beside the WebSocket, and the seat falls back to the WebSocket by itself when
	 *  UDP is blocked or stalls. A room that does not offer it seats you on the WebSocket. One LogGenex line per
	 *  join names the transport and any fallback (GetTransportLine). False keeps the seat on the WebSocket. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") bool bFastChannel = true;
	/** How far behind the server others are drawn (ms); the server rewinds shots to the same instant. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex", meta = (ClampMin = "0")) float RenderDelayMs = 100.f;
	/** The output spring on other entities (ms; 0 = off). Never across a respawn. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex", meta = (ClampMin = "0")) float RemoteSmoothMs = 25.f;
	/** How other entities' samples are timed in a predicting physics room (§17.11 *Drawing other seats*): by their
	 *  keyframe's tick (default) or by the patch's server stamp (for comparison). Other rooms always use the stamp. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Physics") EGenexRemoteSamples RemoteSamples = EGenexRemoteSamples::Tick;
	/** How other seats are drawn with seat contacts (§17.11 *Drawing other seats*): the room's (default: a declared
	 *  contact policy's drawing, else predicted on your clock, the Rocket League model), predicted, moved out of your car
	 *  on the render timeline, or on the render timeline only. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Physics") EGenexSeatDrawing SeatDrawing = EGenexSeatDrawing::Room;
	/** A replay budget (ms) that overrides the device's (4 desktop, 5 mobile) when over 0 (§17.11 *Budgets*); 0 keeps
	 *  the device's. For benches that hold every engine to one budget. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex|Physics", meta = (ClampMin = "0")) float PhysicsBudgetMs = 0.f;
	/** Sign in (launcher ticket, else guest) when nobody is signed in and the server is not on this machine. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") bool bSignInAutomatically = true;
	/** A `firstperson` or `vehicle` room's collision world, the one its room module exports (PROTOCOL.md §17.7): your
	 *  own entity is predicted only while its hash is the room's `params.world`. None keeps the world the
	 *  last Set World gave (the empty world until then). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") TObjectPtr<UGenexCollisionWorld> World = nullptr;
};

/**
 * C++ only: the room module's rules a predicting physics room's client runs (PROTOCOL.md §17.11), each the module's
 * very function ported to C++ (std::function, so not a Blueprint type). Set them with
 * UGenexAuthoritySubsystem::SetPredictionRules before Join; kept across joins. Any left empty: what the module does
 * arrives as a correction instead.
 */
struct GENEXMULTIPLAYER_API FGenexPredictionRules
{
	/** *Seat contacts*: what the module does to two seats' entities after each tick (a car-to-car bump), run in your
	 *  own entity's prediction after each input against every other seat. */
	genex::ContactRule Contacts;
	/** *Seat contacts*, the whole pass: what the module does to every seat's entity after each tick (car-ball's pairs,
	 *  pile passes and world passes), run on every seat in the predicted drawing; empty: Contacts once on every pair. */
	genex::SeatPassRule ContactPass;
	/** *Body rules*: what the module does to its bodies' velocities each tick (a scripted hit on a ball), run before
	 *  every step of the client world. */
	genex::physics::BodyRule BodyRule;
	/** *Seat rules*: what the module does to a seat's own entity at a tick it announced (a kickoff release), run on
	 *  your entity before each predicted input and on other seats' inputDecay steps. */
	genex::physics::SeatRule SeatRule;
	/** *Kinematic rules*: where the module poses its kinematic bodies (a gate, a moving floor) at each tick, run in
	 *  the client world before every step. */
	genex::physics::KinematicRule KinematicRule;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexAuthorityConnectedSignature, const FString&, SessionId);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FGenexAuthorityRefusedSignature, EGenexJoinRefusal, Refusal, int32, Code, const FString&, Message);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexAuthorityErrorSignature, int32, Code, const FString&, Message);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexAuthorityReconnectingSignature, int32, Attempt, int32, Code);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FGenexAuthorityVoidSignature);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexAuthorityDrainingSignature, float, ClosesInSeconds);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexAuthorityRejoinedSignature, const FString&, SessionId);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexAuthorityCodeSignature, int32, Code);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexAuthorityEventSignature, const FString&, Type, const FString&, DataJson);

UCLASS()
class GENEXMULTIPLAYER_API UGenexAuthoritySubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Out of line, members TSharedPtr: their types are complete only in the .cpp. */
	UGenexAuthoritySubsystem();
	virtual ~UGenexAuthoritySubsystem() override;
	virtual void Deinitialize() override;

	/** Join the game's authority room. OnConnected once the room is ready to draw, or OnRefused. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority")
	void Join(const FGenexAuthorityOptions& Options);
	/** Leave (no reconnect, no OnDisconnected); a Join still signing in then joins nothing. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority")
	void Leave();

	/** The input sent on every fixed step from now on (sanitized as the server will). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority")
	void SetInput(const FGenexAuthorityInput& Input);
	UFUNCTION(BlueprintPure, Category = "Genex|Authority")
	FGenexAuthorityInput GetInput() const { return Staged; }

	UFUNCTION(BlueprintPure, Category = "Genex|Authority") EGenexStatus GetStatus() const { return Status; }
	/** Why the last join was refused or the session ended ("" while none did). */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") FString GetLastError() const { return LastError; }
	/** Seated and ready to draw (the clock's first round trip is in). */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") bool IsConnected() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") FString GetSessionId() const;
	/** The server's simulation tick. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") int32 GetTick() const;
	/** Your own entity as drawn this frame (predicted); false when the room gives you none. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") bool GetMe(FGenexEntity& OutEntity) const;
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") bool GetEntity(const FString& Id, FGenexEntity& OutEntity) const;
	/** Every entity as drawn this frame, your predicted projectiles included. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") TArray<FGenexEntity> GetEntities() const;

	/**
	 * Predict a projectile you fire (PROTOCOL.md §17.9). Call it in the frame you fire, with the launch
	 * the room module will write for it (the same origin, velocity and gravity). `FireButtons` (the
	 * module's fire bit, e.g. 1) is added to the staged input's Buttons for exactly the next input sent,
	 * the one this prediction is keyed on; 0 leaves the staged input alone (stage the button yourself and
	 * clear it after the frame). The projectile is drawn at once (GetEntity(Id) and GetEntities() list it
	 * this frame), keeps its id when the server's arrives, and is dropped if the server never launches it.
	 * Returns its id, `<seat>.<seq>.<n>`, or "" before the room is ready or while reconnecting (no input
	 * staged then is sent).
	 */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority")
	FString PredictProjectile(const FGenexProjectileLaunch& Launch, int32 FireButtons = 0);
	/** Draw every projectile again at this instant (their flight is closed-form): call it right before
	 *  rendering for the exact present. Entities are otherwise drawn once per frame, before the world ticks. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority")
	void DrawProjectiles();
	/** The room's tick at the server's present as this client estimates it (fractional; the clock
	 *  projectiles are drawn by), or -1 before the first timed state. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") double GetServerTick() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") TArray<FGenexAuthorityPlayer> GetPlayers() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") FGenexAuthorityTelemetry GetTelemetry() const;
	/** Smoothed round trip (ms), or -1 before the first. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") double GetRtt() const;
	/** Read it inside an On Rejoined handler: true while On Rejoined is raised for a move (PROTOCOL.md §17.1
	 *  *Regrouping*: no room was lost; the player was alone and now sits in a room that has players), false for a lost
	 *  room's rejoin and at any other time. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") bool WasMoved() const { return bRaisingMove; }
	/** The region the seat is in (PROTOCOL.md §17.1 *Regrouping*): the name of the region whose urls hold the seat's
	 *  server url (a Urls entry is its own name); "" before a server is picked or for a server no region lists. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") FString GetRegion() const;
	/** The newest transport line: names the transport (`udp`, `websocket`) and why (PROTOCOL.md §17.12). Empty until it is known. */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority") FString GetTransportLine() const;

	// ---- firstperson (PROTOCOL.md §17.7) ----

	/**
	 * The `firstperson` or `vehicle` collision world, the boxes and ramps the room module exports, in Unreal units
	 * (Genex units × UnitsPerMeter, Genex x/y/z as X/Y/Z, +Z up; converted back exactly). Validated and
	 * hashed by §17.7's rules: false, with Error, when refused (nothing changes). Your own entity is
	 * predicted while the hash (Hash) equals the room's `params.world`, and drawn from the server's
	 * state, unpredicted, while it does not (Get Prediction Status says `world_mismatch`). Valid any
	 * time, before Join too, and kept across joins; a different world re-seeds the prediction.
	 */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority|Firstperson")
	bool SetWorld(const TArray<FGenexWorldBox>& Boxes, const TArray<FGenexWorldRamp>& Ramps, int64& Hash, FString& Error);
	/** Set World from a collision world asset. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority|Firstperson")
	bool SetWorldFromAsset(const UGenexCollisionWorld* WorldAsset, int64& Hash, FString& Error);
	/** Set World from the room module's world as JSON (`{ boxes, ramps }`, Genex units, exactly as it exports it). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Authority|Firstperson")
	bool SetWorldFromJson(const FString& WorldJson, int64& Hash, FString& Error);
	/** The hash of the world this client predicts through (2615243109, the empty world's, until Set World). */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority|Firstperson") int64 GetWorldHash() const;
	/** Whether your own entity is predicted, and why not (`world_mismatch`: Set World with the room's). */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority|Firstperson") FGenexPredictionStatus GetPredictionStatus() const;
	/**
	 * A firstperson input from camera-relative keys: Forward and Right (each in [-1, 1]) turned by the
	 * view's yaw into WORLD axes (the preset uses no trigonometry, §17.7), scaled to at most length 1,
	 * with the view's yaw and pitch in radians (Unreal's yaw turns X toward Y and a positive pitch looks
	 * up, as Genex's do) and the buttons (the arena's jump 1, duck 2, walk 4 are the preset's defaults).
	 * A NaN or infinite Forward or Right is 0, as the server reads a non-finite axis.
	 */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority|Firstperson")
	static FGenexAuthorityInput MakeFirstpersonInput(float Forward, float Right, const FRotator& View, int32 Buttons);

	// ---- vehicle (PROTOCOL.md §17.7 `vehicle`; the same Set World and Get Prediction Status) ----

	/**
	 * A vehicle input: Throttle in [-1, 1] (below 0 brakes, then reverses) and Steer in [-1, 1] as the
	 * Unreal screen shows it (+1 turns RIGHT, toward +Yaw), with the buttons (the preset's defaults are
	 * jump 1, boost 2, drift 4). §17.7's steer is right-handed (its +moveX turns toward −yaw), and the
	 * views draw Genex yaw as Unreal Yaw, so this sends moveX = −Steer, moveY = Throttle; yaw and pitch
	 * are unused (the heading is the car's own state). A NaN or infinite Throttle or Steer is 0, as the
	 * server reads a non-finite axis.
	 */
	UFUNCTION(BlueprintPure, Category = "Genex|Authority|Vehicle")
	static FGenexAuthorityInput MakeVehicleInput(float Throttle, float Steer, int32 Buttons);

	/** C++: hand the session a validated world (null: the empty world); the same as Set World. */
	void SetCoreWorld(std::shared_ptr<const genex::FirstpersonWorld> InWorld);
	/** C++: Unreal-unit solids as a validated world (null, with `Error`, when §17.7 refuses them). */
	static std::shared_ptr<const genex::FirstpersonWorld> FromUnrealSolids(const TArray<FGenexWorldBox>& Boxes,
		const TArray<FGenexWorldRamp>& Ramps, std::string* Error = nullptr);
	/** C++: a world's solids in Unreal units. */
	static void ToUnrealSolids(const genex::FirstpersonWorld& InWorld, TArray<FGenexWorldBox>& OutBoxes, TArray<FGenexWorldRamp>& OutRamps);

	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityConnectedSignature OnConnected;
	/** The join was refused: 402/424/429 are final, 503 was retried after 1, 2 and 4 s. */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityRefusedSignature OnRefused;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityErrorSignature OnError;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityReconnectingSignature OnReconnecting;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityVoidSignature OnReconnected;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityCodeSignature OnDisconnected;
	/** The server closes this room soon, for a deploy (negative: an older server does not say when). Play on: the seat moves by itself. */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityDrainingSignature OnDraining;
	/** The room is gone and the seat is on its way back. Say so; there is nothing to do. */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityReconnectingSignature OnRejoining;
	/** Back in play: a new seat in a new room. Read Was Moved inside the handler to tell a move (§17.1 *Regrouping*)
	 *  from a lost room's rejoin. */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityRejoinedSignature OnRejoined;
	/** An event the room module emitted (server:restart included). */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Authority") FGenexAuthorityEventSignature OnEvent;

	/**
	 * C++: what a region picker shows (PROTOCOL.md §17.1 *Regrouping*), with no join: the regions a Join would use
	 * (Urls, each its own region; empty, the sign-in answer's regions) probed as a join probes them, and Done called
	 * once, from a later frame, with each region's latency in list order. Nobody signed in and no Urls: Done with
	 * none. The answer comes only while the returned meter is held.
	 */
	TSharedPtr<genex::AuthorityRegionMeter> MeasureRegions(const TArray<FString>& Urls, TFunction<void(const TArray<FGenexRegionPing>&)> Done) const;

	/** C++: the room module's rules for the next Join (and every one after it, until set again). */
	void SetPredictionRules(FGenexPredictionRules Rules) { PredictionRules = MoveTemp(Rules); }
	const FGenexPredictionRules& GetPredictionRules() const { return PredictionRules; }

	/** GenexCore's session (C++ games may use it directly), or null. */
	genex::AuthoritySession* Core() const { return Session.Get(); }

	/** C++: bumped by every Join; the generation an event or a node belongs to. */
	uint32 GetJoinGeneration() const { return JoinGeneration; }
	/** C++: a Join's attempt or session was dropped with no event of its own to say so: Leave, a newer
	 *  Join, or the game instance ending. The async nodes end on it. */
	FGenexJoinAbandoned OnJoinAbandoned;

	/** C++: whether a join to `Url` / `Urls` carries the signed-in player's token. A single server on
	 *  this machine never does (it gets the local test placeholder); any other server does. */
	static bool SendsPlayerToken(const FString& Url, const TArray<FString>& Urls);

	/** Called by the pump hook right after the session's update. */
	void DispatchEvents();
	/** Called by the pump hook right after the session's Frame: a PredictProjectile's FireButtons go out
	 *  on the first input sent after it, and only on that one. */
	void AfterFrame(int32 Sent);

	/** EGenexJoinRefusal for a JoinError code. */
	static EGenexJoinRefusal RefusalFor(int32 Code);

private:
	void StartSession(const FGenexAuthorityOptions& Options);
	void Teardown();
	void Refuse(EGenexJoinRefusal Refusal, int32 Code, const FString& Message);
	/** Join `Generation` is still signing in: no Leave and no newer Join since. */
	bool IsPending(uint32 Generation) const;

	TSharedPtr<genex::AuthoritySession> Session;
	/** The collision world Set World gave (null: the empty world), kept across joins. */
	std::shared_ptr<const genex::FirstpersonWorld> CollisionWorld;
	TSharedPtr<FGenexAuthorityPumpHook> Hook;
	/** The module's rules SetPredictionRules gave, kept across joins. */
	FGenexPredictionRules PredictionRules;
	FGenexAuthorityInput Staged;
	/** A PredictProjectile's FireButtons wait for the next input sent. */
	bool bFirePending = false;
	/** On Rejoined is being raised for a move (WasMoved). */
	bool bRaisingMove = false;
	EGenexStatus Status = EGenexStatus::Idle;
	FString LastError;
	uint32 JoinGeneration = 0;
};
