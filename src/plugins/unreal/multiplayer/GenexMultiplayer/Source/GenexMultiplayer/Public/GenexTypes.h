// The Blueprint-facing values of Genex multiplayer. Positions and velocities here are in Unreal
// units (centimetres by default): the subsystems convert from Genex world units (metres) with
// UGenexSettings::UnitsPerMeter, on Genex's x/y/z as Unreal's X/Y/Z (the authority presets move on
// the x/y plane, which is Unreal's ground), and yaw from radians to degrees. Free-form state
// (a player's data, shared keys, object state, event payloads) travels as JSON text.
#pragma once

#include "CoreMinimal.h"
#include "GenexTypes.generated.h"

/** Why a join was refused, as the server's JoinError code says (PROTOCOL.md §3.4, §17.1). */
UENUM(BlueprintType)
enum class EGenexJoinRefusal : uint8
{
	None = 0,
	/** 402: the game's owner is not entitled to server-authoritative rooms. Final. */
	NotEntitled,
	/** 424: no room module is published for this game. Final. */
	ModuleUnavailable,
	/** 429: the owner's room quota is used up. Final. */
	RoomQuota,
	/** 503: no capacity right now; already retried after 1, 2 and 4 s. */
	Capacity,
	/** 426: this client speaks a protocol the server does not. Update the plugin. */
	ProtocolMismatch,
	/** 401/403: the sign-in was refused. */
	Unauthorized,
	/** Anything else (network, a bad URL, a closed room). */
	Other,
};

/** How a pool join picks its authority region (PROTOCOL.md §17.1 *Finding players*). */
UENUM(BlueprintType)
enum class EGenexRegionRule : uint8
{
	/** The default: a room with players in any region in reach, nearest first; else a new room in the nearest region. */
	Players,
	/** The nearest region alone, whoever is elsewhere. */
	Nearest
};

/** How other entities' samples are timed in a predicting physics room (PROTOCOL.md §17.11 *Drawing other seats*). */
UENUM(BlueprintType)
enum class EGenexRemoteSamples : uint8
{
	/** By their keyframe's tick: the default. */
	Tick,
	/** By the patch's server stamp, as in a room that does not predict physics (kept for comparison). */
	Patch
};

/** How other seats are drawn with seat contacts (PROTOCOL.md §17.11 *Drawing other seats*). */
UENUM(BlueprintType)
enum class EGenexSeatDrawing : uint8
{
	/** The Rocket League model: every other car predicted on your clock under its held input, the room's contact pass
	 *  on every car in the prediction, corrections eased in; kept out of yours and out of each other. */
	Predicted,
	/** On the render timeline, moved out of your drawn car and taken round it, never across it. */
	Separate,
	/** On the render timeline only. */
	Timeline,
	/** The default: the room's, a declared contact policy's `drawing` (§17.11 *Contact policy*: a shooter's Separate,
	 *  a vehicle arena's Predicted), else Predicted. */
	Room
};

/** A connection's life (DRIVER.md snapshot `status`). */
UENUM(BlueprintType)
enum class EGenexStatus : uint8
{
	Idle,
	Connecting,
	Connected,
	Reconnecting,
	Closed,
};

/** One authority region as a region picker shows it (PROTOCOL.md §17.1 *Regrouping*): its name and its round trip. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexRegionPing
{
	GENERATED_BODY()

	/** The region's name in the sign-in answer's regions (a Urls entry is its own name). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Region;
	/** The probe's best round trip, ms; 0 when the region did not answer. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float PingMs = 0.f;
	/** The region answered the probe (false: no answer, or the only region, which is not probed). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bAnswered = false;
};

/** One seat in a relay room. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexPlayer
{
	GENERATED_BODY()

	/** The seat's session id (stable through an in-place reconnect). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Id;
	/** The player's account or guest id. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Uid;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Name;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Team = -1;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bConnected = false;
	/** The latest state the player published (raw, never smoothed), as JSON. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString DataJson;
};

/** One shared object in a relay room. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexObject
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Id;
	/** The owner's session id; empty when nobody owns it. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Owner;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Sequence = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Epoch = 0;
	/** The latest state, as JSON. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString DataJson;
};

/** The relay's answer to a claim, release or destroy (PROTOCOL.md §7.2). */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexControlResult
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString RequestId;
	/** claim, release or remove. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Operation;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Id;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bAccepted = false;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Owner;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Sequence = 0;
	/** Why it was refused: the relay's reason (held, …) or timeout, aborted, disconnected. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Reason;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float RetryAfterMs = 0.f;
};

/** One chat line (PROTOCOL.md §12). */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexChatMessage
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Id;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString From;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Name;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Text;
	/** Server time of the line, ms since the epoch. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") double At = 0.0;
};

/** The input an authority room's module steps with, sent once per fixed step (PROTOCOL.md §17.2).
 *  Axes are in [-1, 1], angles in radians; the server sanitizes whatever arrives. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexAuthorityInput
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") float MoveX = 0.f;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") float MoveY = 0.f;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") float MoveZ = 0.f;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") float Yaw = 0.f;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") float Pitch = 0.f;
	/** A bit per button, in [0, 2^24). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") int32 Buttons = 0;
};

/** One entity of an authority room as it is drawn this frame: your own predicted, the others
 *  100 ms behind on the server's rewind timeline (PROTOCOL.md §17.3), and a projectile (bProjectile)
 *  where its flight is at the server's present (§17.9), your own fired ones from the frame they fire. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexEntity
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Id;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Kind;
	/** The owning seat's session id; empty for a world entity. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Owner;
	/** Position in Unreal units. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FVector Location = FVector::ZeroVector;
	/** Velocity in Unreal units per second. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FVector Velocity = FVector::ZeroVector;
	/** Heading in degrees. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float Yaw = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float Hp = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Flags = 0;
	/** The entity's life: it increments on a respawn (a discontinuity, never interpolated across). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Epoch = 0;
	/** The module's free-form data, as JSON text. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString DataJson;
	/** Whether this is the entity your seat owns (predicted). Never true for a projectile. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bMine = false;
	/** A projectile (PROTOCOL.md §17.9): drawn from its closed-form flight, never interpolated. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bProjectile = false;
	/** A projectile's launch tick (0 = not a projectile): an integer once the server launched it, the
	 *  fractional tick you fired it at while it is still only your prediction. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") double LaunchTick = 0.0;
	/** A projectile's downward acceleration (along -Z), Unreal units per second squared. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float Gravity = 0.f;
	/** The seat that fired a projectile (its session id); empty for none. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Source;
	/** A firstperson body's aim pitch in degrees (positive looks up, as an FRotator's pitch): predicted
	 *  for yours, interpolated straight for others (a bounded angle: never along the short arc), held to
	 *  the room's pitchLimit. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Firstperson") float Pitch = 0.f;
	/** A firstperson body's duck amount, 0 standing to 1 fully ducked (derive the eye height from it). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Firstperson") float Duck = 0.f;
	/** A firstperson body's movement bits: 1 on the ground, 2 ducking, 4 jump held. Predicted for yours,
	 *  the server's latest for others. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Firstperson") int32 MoveState = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Firstperson") bool bOnGround = false;
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Firstperson") bool bDucking = false;
	/** A firstperson body's speed multiplier, as the room module last wrote it (a weapon's, a wound's);
	 *  a vehicle's top-speed multiplier. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Firstperson") float SpeedCap = 1.f;
	/** A vehicle body's yaw rate in degrees per second, positive turning toward +Yaw (as Yaw does): for
	 *  wheels and skid marks (the heading itself is Yaw). Predicted for yours, the server's latest for
	 *  others. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Vehicle") float Spin = 0.f;
	/** A vehicle body's boost tank, 0 empty to 1 full (3 s of boost by default). Predicted for yours, the
	 *  server's latest for others. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Vehicle") float Fuel = 0.f;

	/** A physics body (PROTOCOL.md §17.10): the server steps it and this client only draws it, at the
	 *  server's present (Location and BodyRotation), its corrections eased out over 100 ms. False for every
	 *  other entity. Velocity is the body's own linear velocity. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") bool bBody = false;
	/** A physics body's drawn orientation (the identity for any other entity, whose heading is Yaw). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") FRotator BodyRotation = FRotator::ZeroRotator;
	/** The server put this body to sleep: it is drawn where it is. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") bool bAsleep = false;
	/** Out of this client's view (the server sends the bodies nearest you at full rate): drawn where its
	 *  last state left it until it comes back. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") bool bHeld = false;
	/** Drawn by this client's physics prediction at your present (§17.11), not from the server's states; or another
	 *  seat drawn predicted on your clock (EGenexSeatDrawing::Predicted). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") bool bPredicted = false;
	/** Another seat drawn predicted: how far it is drawn from its predicted pose (Genex units), the correction still
	 *  being eased in plus any push out of another car. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") float SeatCorrection = 0.f;
	/** The body's descriptor: `dynamic`, `fixed` or `kinematic`; its physics kind ("" none); its colliders
	 *  as JSON text (the shapes the server's core accepted, in Genex units). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") FString BodyType;
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") FString BodyKind;
	UPROPERTY(BlueprintReadOnly, Category = "Genex|Physics") FString CollidersJson;
};

/** Which way a ramp of a firstperson collision world rises: along X or along Y. */
UENUM(BlueprintType)
enum class EGenexRampAxis : uint8
{
	X,
	Y
};

/** A box of a firstperson collision world (PROTOCOL.md §17.7), in Unreal units: Genex units times
 *  UGenexSettings::UnitsPerMeter, Genex x/y/z as Unreal X/Y/Z (both are z-up). Converted back by
 *  dividing by UnitsPerMeter and rounding to float32, which recovers every float32 Genex value exactly,
 *  so the world's hash is the room module's. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexWorldBox
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FVector Min = FVector::ZeroVector;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FVector Max = FVector::ZeroVector;
};

/** A ramp of a firstperson collision world: a box whose top is a plane rising along Axis, at height
 *  Low at that axis's Min end and High at its Max end (Max.Z must be the larger of the two). Unreal
 *  units, as FGenexWorldBox. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexWorldRamp
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FVector Min = FVector::ZeroVector;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FVector Max = FVector::ZeroVector;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") EGenexRampAxis Axis = EGenexRampAxis::X;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") double Low = 0.0;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") double High = 0.0;
};

/** Whether your own entity is predicted, and why not when it is not (UGenexAuthoritySubsystem::GetPredictionStatus). */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexPredictionStatus
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bPredicting = false;
	/** "" (predicting), "off" (bPredict false), "no_entity" (you own no entity yet), "no_preset" (the room
	 *  runs no preset this client knows) or "world_mismatch" (the room's firstperson world is not this
	 *  client's: Set World with the room module's world). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Reason;
	/** This client's collision world's hash (the empty world's, 2615243109, until Set World). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int64 World = 2615243109;
	/** The room's `params.world`, or -1 when its preset steps through no world. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int64 RoomWorld = -1;
};

/** A projectile your game fires, as it predicts it (UGenexAuthoritySubsystem::PredictProjectile): the
 *  launch the room module will write for it, in Unreal units (converted to Genex metres with
 *  UGenexSettings::UnitsPerMeter, on Genex's x/y/z as Unreal's X/Y/Z, +Z up). */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexProjectileLaunch
{
	GENERATED_BODY()

	/** The entity kind the module launches it as (projectile-arena.js: "bolt", "lob"). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FString Kind;
	/** Where it starts, Unreal units. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FVector Location = FVector::ZeroVector;
	/** Its velocity, Unreal units per second. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") FVector Velocity = FVector::ZeroVector;
	/** Downward acceleration along -Z, Unreal units per second squared (at most 1000 Genex units/s²). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex", meta = (ClampMin = "0")) float Gravity = 0.f;
};

/** One seat of an authority room. */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexAuthorityPlayer
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Id;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Uid;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Name;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString Team;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") bool bConnected = false;
};

/** The authority session's counters (what the bench's feel gates read). */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexAuthorityTelemetry
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 InputsSent = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 InputsDropped = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Reconciles = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 VisibleCorrections = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float PeakCorrection = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float PeakStateCorrection = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float LastCorrection = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 Reseeds = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 ReconnectKicks = 0;
	/** Projectiles you predicted, the server confirmed under the same id, and dropped unconfirmed. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 ProjectilesPredicted = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 ProjectilesConfirmed = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") int32 ProjectilesRejected = 0;
	/** The latest confirmation's input lead, ms: the server's launch instant minus the prediction's. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float LastProjectileLeadMs = 0.f;
};

/** A device sign-in in progress: show the code and the address (or a QR of the full one). */
USTRUCT(BlueprintType)
struct GENEXMULTIPLAYER_API FGenexDeviceCode
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString UserCode;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString VerificationUri;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") FString VerificationUriComplete;
	UPROPERTY(BlueprintReadOnly, Category = "Genex") float ExpiresInSeconds = 0.f;
};
