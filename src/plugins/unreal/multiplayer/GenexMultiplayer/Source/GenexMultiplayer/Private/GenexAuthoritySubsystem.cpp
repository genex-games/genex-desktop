#include "GenexAuthoritySubsystem.h"

#include "Engine/GameInstance.h"
#include "GenexCore/GenexAuthoritySession.h"
#include "GenexCollisionWorld.h"
#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexPump.h"
#include "GenexCore/GenexUrl.h"
#include "GenexIdentitySubsystem.h"
#include "GenexMultiplayerModule.h"
#include "GenexSettings.h"
#include "GenexUnrealJson.h"
#include "GenexUnrealUdp.h"
#include "HAL/PlatformMisc.h"

/** Registered with genex::Pump after the session: once per frame, after the session's Update and
 *  before any world ticks, it runs the session's Frame (the due inputs, prediction, interpolation)
 *  and then fires the subsystem's events, so game code reads this frame's drawing. */
class FGenexAuthorityPumpHook final : public genex::IPumped
{
public:
	explicit FGenexAuthorityPumpHook(UGenexAuthoritySubsystem* InOwner) : Owner(InOwner) { genex::Pump::Register(this); }
	virtual ~FGenexAuthorityPumpHook() override { genex::Pump::Unregister(this); }
	virtual void Update(double NowMs) override
	{
		UGenexAuthoritySubsystem* Subsystem = Owner.Get();
		if (!Subsystem) return;
		if (genex::AuthoritySession* Session = Subsystem->Core()) Subsystem->AfterFrame(Session->Frame(NowMs));
		Subsystem->DispatchEvents();
	}

private:
	TWeakObjectPtr<UGenexAuthoritySubsystem> Owner;
};

namespace GenexAuthorityDetail
{
FString Str(const std::string& S) { return UTF8_TO_TCHAR(S.c_str()); }

FGenexEntity ToEntity(const genex::AuthorityEntityView& E)
{
	const double Scale = GetDefault<UGenexSettings>()->UnitsPerMeter;
	FGenexEntity Out;
	Out.Id = Str(E.id);
	Out.Kind = Str(E.kind);
	Out.Owner = Str(E.owner);
	Out.Location = FVector(E.x * Scale, E.y * Scale, E.z * Scale);
	Out.Velocity = FVector(E.vx * Scale, E.vy * Scale, E.vz * Scale);
	Out.Yaw = static_cast<float>(FMath::RadiansToDegrees(E.yaw));
	Out.Hp = static_cast<float>(E.hp);
	Out.Flags = static_cast<int32>(E.flags);
	Out.Epoch = static_cast<int32>(E.epoch);
	Out.DataJson = Str(E.data);
	Out.bMine = E.isMine;
	Out.bProjectile = E.IsProjectile();
	Out.LaunchTick = E.t0;
	Out.Gravity = static_cast<float>(E.g * Scale);
	Out.Source = Str(E.src);
	Out.Pitch = static_cast<float>(FMath::RadiansToDegrees(E.pitch));
	Out.Duck = static_cast<float>(E.duck);
	Out.MoveState = static_cast<int32>(E.mstate);
	Out.bOnGround = (Out.MoveState & 1) != 0;
	Out.bDucking = (Out.MoveState & 2) != 0;
	Out.SpeedCap = static_cast<float>(E.cap);
	Out.Spin = static_cast<float>(FMath::RadiansToDegrees(E.spin));
	Out.Fuel = static_cast<float>(E.fuel);
	Out.bBody = E.isBody;
	if (E.seatPredicted)
	{
		Out.bPredicted = true;
		Out.SeatCorrection = static_cast<float>(E.correction);
	}
	if (E.isBody)
	{
		Out.BodyRotation = FQuat(E.qx, E.qy, E.qz, E.qw).Rotator();
		Out.bAsleep = E.sleep;
		Out.bHeld = E.held;
		Out.bPredicted = E.predicted;
		Out.BodyType = Str(E.bodyType);
		Out.BodyKind = Str(E.bodyKind);
		Out.CollidersJson = Str(E.colliders);
	}
	return Out;
}

/** An Unreal-unit value as the Genex float32 it stands for: divided by UnitsPerMeter and rounded to
 *  float32, which gives back exactly the float32 a Genex value times the scale came from. */
double ToGenex(double V, double Scale)
{
	return static_cast<double>(static_cast<float>(Scale > 0 ? V / Scale : V));
}

/** Why a world was refused, or "" once a world was set; the hash out-parameter. */
bool Answer(const std::shared_ptr<const genex::FirstpersonWorld>& World, const std::string& Why, int64& Hash, FString& Error)
{
	if (!World)
	{
		Hash = -1;
		Error = Str(Why);
		return false;
	}
	Hash = static_cast<int64>(World->Hash());
	Error.Reset();
	return true;
}

/** The server(s) a join goes to, by the precedence the header states; both empty = none. */
struct FTarget
{
	FString Url;
	TArray<FString> Urls;
	bool IsEmpty() const { return Url.IsEmpty() && Urls.Num() == 0; }
};

FTarget PickTarget(const FGenexAuthorityOptions& Options, const UGenexIdentitySubsystem* Identity)
{
	FTarget Target;
	if (!Options.Url.IsEmpty())
	{
		Target.Url = Options.Url;
		return Target;
	}
	Target.Urls = Options.Urls;
	if (Target.Urls.Num() == 0 && Identity) Target.Urls = Identity->GetAuthorityUrls();
	if (Target.Urls.Num() > 0) return Target;
	Target.Url = FPlatformMisc::GetEnvironmentVariable(UTF8_TO_TCHAR(genex::kAuthorityUrlEnv));
	if (Target.Url.IsEmpty()) Target.Url = GetDefault<UGenexSettings>()->AuthorityUrl;
	return Target;
}
}

UGenexAuthoritySubsystem::UGenexAuthoritySubsystem() = default;
UGenexAuthoritySubsystem::~UGenexAuthoritySubsystem() = default;

void UGenexAuthoritySubsystem::Deinitialize()
{
	Teardown();
	Super::Deinitialize();
}

void UGenexAuthoritySubsystem::Teardown()
{
	const bool bInFlight = Session.IsValid() || Status == EGenexStatus::Connecting;
	Hook.Reset();
	if (Session && !Session->IsClosed()) Session->Leave();
	Session.Reset();
	bFirePending = false;
	Status = EGenexStatus::Idle;
	// Destroyed without an event: a Join Genex Authority node waiting on it hears it here.
	if (bInFlight) OnJoinAbandoned.Broadcast(JoinGeneration);
}

bool UGenexAuthoritySubsystem::IsPending(uint32 Generation) const
{
	return JoinGeneration == Generation && Status == EGenexStatus::Connecting && !Session;
}

void UGenexAuthoritySubsystem::Refuse(EGenexJoinRefusal Refusal, int32 Code, const FString& Message)
{
	Status = EGenexStatus::Closed;
	LastError = Message;
	OnRefused.Broadcast(Refusal, Code, Message);
}

bool UGenexAuthoritySubsystem::SendsPlayerToken(const FString& Url, const TArray<FString>& Urls)
{
	// Url wins over Urls (FGenexAuthorityOptions); a server on this machine (Studio's, genex-authority-dev)
	// takes the placeholder and ignores tokens, so the player's never goes to whatever listens there.
	if (!Url.IsEmpty()) return !genex::IsLoopbackUrl(TCHAR_TO_UTF8(*Url));
	return Urls.Num() > 0;
}

EGenexJoinRefusal UGenexAuthoritySubsystem::RefusalFor(int32 Code)
{
	switch (Code)
	{
	case 402: return EGenexJoinRefusal::NotEntitled;
	case 424: return EGenexJoinRefusal::ModuleUnavailable;
	case 429: return EGenexJoinRefusal::RoomQuota;
	case 503: return EGenexJoinRefusal::Capacity;
	case 426: return EGenexJoinRefusal::ProtocolMismatch;
	case 401: case 403: return EGenexJoinRefusal::Unauthorized;
	default: return EGenexJoinRefusal::Other;
	}
}

void UGenexAuthoritySubsystem::Join(const FGenexAuthorityOptions& Options)
{
	Teardown();
	const uint32 Generation = ++JoinGeneration;
	Status = EGenexStatus::Connecting;
	LastError.Reset();
	if (!FGenexMultiplayerModule::IsAvailable())
	{
		Refuse(EGenexJoinRefusal::Other, 0, TEXT("genex: multiplayer is unavailable (the Colyseus core did not load)"));
		return;
	}
	UGenexIdentitySubsystem* Identity = GetGameInstance()->GetSubsystem<UGenexIdentitySubsystem>();
	// Sign in FIRST when the join would carry the player's token (anything but one server on this
	// machine, nothing named included): the sign-in answer's authorityUrls are where a published game's
	// cluster comes from, and they outrank GENEX_AUTHORITY_URL and the development AuthorityUrl, so the
	// server is picked only after it (StartSession).
	const GenexAuthorityDetail::FTarget Before = GenexAuthorityDetail::PickTarget(Options, Identity);
	const bool bSignIn = Identity && !Identity->IsSignedIn() && Options.bSignInAutomatically && (Before.IsEmpty() || SendsPlayerToken(Before.Url, Before.Urls));
	if (!bSignIn)
	{
		StartSession(Options);
		return;
	}
	TWeakObjectPtr<UGenexAuthoritySubsystem> Weak(this);
	Identity->SignInAutomatically(FGenexSignInDone::CreateLambda([Weak, Generation, Options](bool bOk, int32, const FString& Error) {
		// A Leave, or a newer Join, while it signed in: this join starts nothing.
		if (!Weak.IsValid() || !Weak->IsPending(Generation)) return;
		if (!bOk)
		{
			Weak->Refuse(EGenexJoinRefusal::Unauthorized, 401, FString::Printf(TEXT("genex: could not sign in (%s)"), *Error));
			return;
		}
		Weak->StartSession(Options);
	}));
}

void UGenexAuthoritySubsystem::StartSession(const FGenexAuthorityOptions& Options)
{
	using GenexUnrealJson::Utf8;
	const UGenexSettings* Settings = GetDefault<UGenexSettings>();
	UGenexIdentitySubsystem* Identity = GetGameInstance()->GetSubsystem<UGenexIdentitySubsystem>();
	const GenexAuthorityDetail::FTarget Target = GenexAuthorityDetail::PickTarget(Options, Identity);
	if (Target.IsEmpty())
	{
		Refuse(EGenexJoinRefusal::Other, 0, TEXT("genex: no authority server (pass Url or Urls, sign in on a stand with authority rooms, or run Genex Studio's local server)"));
		return;
	}
	genex::AuthorityOptions Core;
	Core.url = Utf8(Target.Url);
	for (const FString& U : Target.Urls) Core.urls.push_back(Utf8(U));
	// PROTOCOL.md §17.1 *Regions*: the sign-in answer's urls come with its regions (the nearest is joined).
	const bool bIdentityUrls = Target.Url.IsEmpty() && Options.Urls.Num() == 0;
	if (bIdentityUrls && Identity && Identity->Core()) Core.regions = Identity->Core()->AuthorityRegions();
	Core.gameId = Utf8(Options.GameId.IsEmpty() ? Settings->Slug : Options.GameId);
	Core.matchKey = Utf8(Options.MatchKey);
	Core.name = Utf8(Options.Name);
	Core.predict = Options.bPredict;
	Core.renderDelayMs = Options.RenderDelayMs;
	Core.remoteSmoothMs = Options.RemoteSmoothMs;
	// §17.11: the plugin's physics core, loaded when a room first sends keyframes (FGenexMultiplayerModule::PhysicsCore).
	Core.physicsCoreLoader = [] { return FGenexMultiplayerModule::PhysicsCore(); };
	Core.predictPhysics = Options.bPredictPhysics;
	// §17.12: the fast channel over the platform's UDP sockets (GenexUnrealUdp).
	if (Options.bFastChannel) Core.fast = [](const std::string& Url) { return GenexOpenUnrealUdp(Url); };
	Core.fastLog = [](const std::string& Line) { UE_LOG(LogGenex, Display, TEXT("%s"), UTF8_TO_TCHAR(Line.c_str())); };
	// §17.11 *Budgets*: the device's replay budget, and a join's override when over 0.
#if PLATFORM_IOS || PLATFORM_ANDROID
	Core.physicsResimBudgetMs = genex::physics::kResimBudgetMobileMs;
#endif
	if (Options.PhysicsBudgetMs > 0.f && FMath::IsFinite(Options.PhysicsBudgetMs)) Core.physicsBudgetMs = static_cast<double>(Options.PhysicsBudgetMs);
	// §17.11 *Drawing other seats*, *Seat contacts*, *Body rules*, *Seat rules*.
	Core.remoteSamples = Options.RemoteSamples == EGenexRemoteSamples::Patch ? genex::RemoteSamples::Patch : genex::RemoteSamples::Tick;
	switch (Options.SeatDrawing)
	{
	case EGenexSeatDrawing::Predicted:
		Core.seatDrawing = genex::SeatDrawing::Predicted;
		break;
	case EGenexSeatDrawing::Separate:
		Core.seatDrawing = genex::SeatDrawing::Separate;
		break;
	case EGenexSeatDrawing::Timeline:
		Core.seatDrawing = genex::SeatDrawing::Timeline;
		break;
	case EGenexSeatDrawing::Room:
		break;
	}
	Core.contacts = PredictionRules.Contacts;
	Core.contactPass = PredictionRules.ContactPass;
	Core.bodyRule = PredictionRules.BodyRule;
	Core.seatRule = PredictionRules.SeatRule;
	Core.kinematicRule = PredictionRules.KinematicRule;
	if (Options.World)
	{
		std::string Why;
		std::shared_ptr<const genex::FirstpersonWorld> FromAsset = FromUnrealSolids(Options.World->Boxes, Options.World->Ramps, &Why);
		if (FromAsset) CollisionWorld = FromAsset;
		else OnError.Broadcast(0, FString::Printf(TEXT("genex: the join's collision world was refused (%s); keeping the last one"), *GenexAuthorityDetail::Str(Why)));
	}
	Core.world = CollisionWorld;
	// A fresh token per join attempt (the session asks before each one, the 503 retries included);
	// none for a server on this machine, which gets the local placeholder.
	if (SendsPlayerToken(Target.Url, Target.Urls) && Identity && Identity->IsSignedIn() && Identity->Core())
	{
		Core.tokenProvider = Identity->Core()->Provider();
	}
	Session = MakeShared<genex::AuthoritySession>(std::move(Core));
	Hook = MakeShared<FGenexAuthorityPumpHook>(this);
	SetInput(Staged);
}

void UGenexAuthoritySubsystem::Leave()
{
	const bool bInFlight = Session.IsValid() || Status == EGenexStatus::Connecting;
	if (Session) Session->Leave();
	// A Join still signing in starts nothing now (IsPending).
	Status = EGenexStatus::Closed;
	// No event follows a Leave (the header's contract), so a node waiting on this join hears it here.
	if (bInFlight) OnJoinAbandoned.Broadcast(JoinGeneration);
}

void UGenexAuthoritySubsystem::SetInput(const FGenexAuthorityInput& Input)
{
	Staged = Input;
	if (!Session) return;
	Session->input.moveX = Input.MoveX;
	Session->input.moveY = Input.MoveY;
	Session->input.moveZ = Input.MoveZ;
	Session->input.yaw = Input.Yaw;
	Session->input.pitch = Input.Pitch;
	// A fire still waiting for its input keeps its button on that one input.
	if (!bFirePending) Session->input.buttons = Input.Buttons;
}

FString UGenexAuthoritySubsystem::PredictProjectile(const FGenexProjectileLaunch& Launch, int32 FireButtons)
{
	if (!Session || !Session->IsReady()) return FString();
	const double Scale = GetDefault<UGenexSettings>()->UnitsPerMeter;
	const double ToMetres = Scale > 0 ? 1.0 / Scale : 0.0;
	genex::ProjectilePrediction P;
	P.kind = GenexUnrealJson::Utf8(Launch.Kind);
	P.x = Launch.Location.X * ToMetres;
	P.y = Launch.Location.Y * ToMetres;
	P.z = Launch.Location.Z * ToMetres;
	P.vx = Launch.Velocity.X * ToMetres;
	P.vy = Launch.Velocity.Y * ToMetres;
	P.vz = Launch.Velocity.Z * ToMetres;
	P.g = Launch.Gravity * ToMetres;
	// Staged first: the prediction is keyed on the input being staged, the next one sent.
	if (FireButtons != 0)
	{
		Session->input.buttons = static_cast<double>(Staged.Buttons | FireButtons);
		bFirePending = true;
	}
	const std::string Id = Session->PredictProjectile(P);
	if (Id.empty() && bFirePending)
	{
		Session->input.buttons = Staged.Buttons;
		bFirePending = false;
	}
	return GenexAuthorityDetail::Str(Id);
}

void UGenexAuthoritySubsystem::AfterFrame(int32 Sent)
{
	if (!bFirePending || Sent <= 0 || !Session) return;
	Session->input.buttons = Staged.Buttons;
	bFirePending = false;
}

void UGenexAuthoritySubsystem::DrawProjectiles()
{
	if (Session) Session->DrawProjectiles();
}

double UGenexAuthoritySubsystem::GetServerTick() const
{
	const std::optional<genex::AuthorityServerClock> Clock = Session ? Session->ServerClock() : std::nullopt;
	return Clock ? Clock->serverTick : -1.0;
}

void UGenexAuthoritySubsystem::DispatchEvents()
{
	if (!Session) return;
	using T = genex::AuthorityEventType;
	std::vector<genex::AuthorityEvent> Events = Session->DrainEvents();
	const uint32 Generation = JoinGeneration;
	for (const genex::AuthorityEvent& E : Events)
	{
		switch (E.type)
		{
		case T::Ready: Status = EGenexStatus::Connected; OnConnected.Broadcast(GenexAuthorityDetail::Str(E.message)); break;
		case T::JoinFailed: Status = EGenexStatus::Closed; LastError = FString::Printf(TEXT("refused (%d): %s"), E.code, *GenexAuthorityDetail::Str(E.message)); OnRefused.Broadcast(RefusalFor(E.code), E.code, GenexAuthorityDetail::Str(E.message)); break;
		case T::Reconnecting: Status = EGenexStatus::Reconnecting; OnReconnecting.Broadcast(E.attempt, E.code); break;
		case T::Reconnected: Status = EGenexStatus::Connected; OnReconnected.Broadcast(); break;
		case T::Disconnected: Status = EGenexStatus::Closed; LastError = FString::Printf(TEXT("disconnected (%d)"), E.code); OnDisconnected.Broadcast(E.code); break;
		case T::ServerRestart: break; // also delivered as a Message (server:restart)
		case T::Draining: OnDraining.Broadcast(E.ms < 0.0 ? -1.0f : static_cast<float>(E.ms / 1000.0)); break;
		case T::Rejoining: Status = EGenexStatus::Reconnecting; OnRejoining.Broadcast(E.attempt, E.code); break;
		case T::Rejoined: Status = EGenexStatus::Connected; OnRejoined.Broadcast(GenexAuthorityDetail::Str(Session->SessionId())); break;
		case T::Message: OnEvent.Broadcast(GenexAuthorityDetail::Str(E.name), GenexUnrealJson::ToText(E.data)); break;
		case T::Warning: OnError.Broadcast(E.code, GenexAuthorityDetail::Str(E.message)); break;
		default: break;
		}
		if (JoinGeneration != Generation) return;
	}
}

bool UGenexAuthoritySubsystem::IsConnected() const { return Session && Session->IsConnected() && Session->IsReady(); }
FString UGenexAuthoritySubsystem::GetSessionId() const { return Session ? GenexAuthorityDetail::Str(Session->SessionId()) : FString(); }
int32 UGenexAuthoritySubsystem::GetTick() const { return Session ? static_cast<int32>(Session->Tick()) : 0; }
double UGenexAuthoritySubsystem::GetRtt() const { return Session && Session->Rtt() > 0 ? Session->Rtt() : -1.0; }

FString UGenexAuthoritySubsystem::GetTransportLine() const { return Session ? FString(UTF8_TO_TCHAR(Session->TransportLine().c_str())) : FString(); }

bool UGenexAuthoritySubsystem::GetMe(FGenexEntity& OutEntity) const
{
	const genex::AuthorityEntityView* Me = Session ? Session->Me() : nullptr;
	if (!Me) return false;
	OutEntity = GenexAuthorityDetail::ToEntity(*Me);
	return true;
}

bool UGenexAuthoritySubsystem::GetEntity(const FString& Id, FGenexEntity& OutEntity) const
{
	const genex::AuthorityEntityView* E = Session ? Session->Entity(GenexUnrealJson::Utf8(Id)) : nullptr;
	if (!E) return false;
	OutEntity = GenexAuthorityDetail::ToEntity(*E);
	return true;
}

TArray<FGenexEntity> UGenexAuthoritySubsystem::GetEntities() const
{
	TArray<FGenexEntity> Out;
	if (Session) for (const auto& Pair : Session->Entities()) Out.Add(GenexAuthorityDetail::ToEntity(Pair.second));
	return Out;
}

TArray<FGenexAuthorityPlayer> UGenexAuthoritySubsystem::GetPlayers() const
{
	TArray<FGenexAuthorityPlayer> Out;
	if (!Session) return Out;
	for (const auto& Pair : Session->Players())
	{
		FGenexAuthorityPlayer P;
		P.Id = GenexAuthorityDetail::Str(Pair.second.id);
		P.Uid = GenexAuthorityDetail::Str(Pair.second.uid);
		P.Name = GenexAuthorityDetail::Str(Pair.second.name);
		P.Team = GenexAuthorityDetail::Str(Pair.second.team);
		P.bConnected = Pair.second.connected;
		Out.Add(P);
	}
	return Out;
}

FGenexAuthorityTelemetry UGenexAuthoritySubsystem::GetTelemetry() const
{
	FGenexAuthorityTelemetry Out;
	if (!Session) return Out;
	const genex::AuthorityTelemetry T = Session->Telemetry();
	Out.InputsSent = T.inputsSent;
	Out.InputsDropped = T.inputsDropped;
	Out.Reconciles = T.reconciles;
	Out.VisibleCorrections = T.visibleCorrections;
	Out.PeakCorrection = static_cast<float>(T.peakCorrection);
	Out.PeakStateCorrection = static_cast<float>(T.peakStateCorrection);
	Out.LastCorrection = static_cast<float>(T.lastCorrection);
	Out.Reseeds = T.reseeds;
	Out.ReconnectKicks = T.reconnectKicks;
	Out.ProjectilesPredicted = T.projectilesPredicted;
	Out.ProjectilesConfirmed = T.projectilesConfirmed;
	Out.ProjectilesRejected = T.projectilesRejected;
	Out.LastProjectileLeadMs = static_cast<float>(T.lastProjectileLeadMs);
	return Out;
}

// ---- firstperson ----

std::shared_ptr<const genex::FirstpersonWorld> UGenexAuthoritySubsystem::FromUnrealSolids(const TArray<FGenexWorldBox>& Boxes,
	const TArray<FGenexWorldRamp>& Ramps, std::string* Error)
{
	const double Scale = GetDefault<UGenexSettings>()->UnitsPerMeter;
	using GenexAuthorityDetail::ToGenex;
	std::vector<genex::FirstpersonWorld::Box> B;
	std::vector<genex::FirstpersonWorld::Ramp> R;
	B.reserve(Boxes.Num());
	R.reserve(Ramps.Num());
	for (const FGenexWorldBox& Box : Boxes)
	{
		B.push_back({ToGenex(Box.Min.X, Scale), ToGenex(Box.Min.Y, Scale), ToGenex(Box.Min.Z, Scale),
			ToGenex(Box.Max.X, Scale), ToGenex(Box.Max.Y, Scale), ToGenex(Box.Max.Z, Scale)});
	}
	for (const FGenexWorldRamp& Ramp : Ramps)
	{
		R.push_back({ToGenex(Ramp.Min.X, Scale), ToGenex(Ramp.Min.Y, Scale), ToGenex(Ramp.Min.Z, Scale),
			ToGenex(Ramp.Max.X, Scale), ToGenex(Ramp.Max.Y, Scale), ToGenex(Ramp.Max.Z, Scale),
			Ramp.Axis == EGenexRampAxis::X ? 0.0 : 1.0, ToGenex(Ramp.Low, Scale), ToGenex(Ramp.High, Scale)});
	}
	return genex::FirstpersonWorld::FromSolids(B, R, Error);
}

void UGenexAuthoritySubsystem::ToUnrealSolids(const genex::FirstpersonWorld& InWorld, TArray<FGenexWorldBox>& OutBoxes, TArray<FGenexWorldRamp>& OutRamps)
{
	const double Scale = GetDefault<UGenexSettings>()->UnitsPerMeter;
	OutBoxes.Reset();
	OutRamps.Reset();
	for (const genex::FirstpersonWorld::Box& B : InWorld.Boxes())
	{
		FGenexWorldBox Box;
		Box.Min = FVector(B[0], B[1], B[2]) * Scale;
		Box.Max = FVector(B[3], B[4], B[5]) * Scale;
		OutBoxes.Add(Box);
	}
	for (const genex::FirstpersonWorld::Ramp& R : InWorld.Ramps())
	{
		FGenexWorldRamp Ramp;
		Ramp.Min = FVector(R[0], R[1], R[2]) * Scale;
		Ramp.Max = FVector(R[3], R[4], R[5]) * Scale;
		Ramp.Axis = R[6] == 0.0 ? EGenexRampAxis::X : EGenexRampAxis::Y;
		Ramp.Low = R[7] * Scale;
		Ramp.High = R[8] * Scale;
		OutRamps.Add(Ramp);
	}
}

void UGenexAuthoritySubsystem::SetCoreWorld(std::shared_ptr<const genex::FirstpersonWorld> InWorld)
{
	CollisionWorld = std::move(InWorld);
	if (Session) Session->SetWorld(CollisionWorld);
}

bool UGenexAuthoritySubsystem::SetWorld(const TArray<FGenexWorldBox>& Boxes, const TArray<FGenexWorldRamp>& Ramps, int64& Hash, FString& Error)
{
	std::string Why;
	std::shared_ptr<const genex::FirstpersonWorld> Checked = FromUnrealSolids(Boxes, Ramps, &Why);
	if (Checked) SetCoreWorld(Checked);
	return GenexAuthorityDetail::Answer(Checked, Why, Hash, Error);
}

bool UGenexAuthoritySubsystem::SetWorldFromAsset(const UGenexCollisionWorld* WorldAsset, int64& Hash, FString& Error)
{
	if (!WorldAsset)
	{
		Hash = -1;
		Error = TEXT("genex: no collision world asset");
		return false;
	}
	return SetWorld(WorldAsset->Boxes, WorldAsset->Ramps, Hash, Error);
}

bool UGenexAuthoritySubsystem::SetWorldFromJson(const FString& WorldJson, int64& Hash, FString& Error)
{
	std::string Why;
	std::shared_ptr<const genex::FirstpersonWorld> Checked = genex::FirstpersonWorld::FromJsonText(GenexUnrealJson::Utf8(WorldJson), &Why);
	if (Checked) SetCoreWorld(Checked);
	return GenexAuthorityDetail::Answer(Checked, Why, Hash, Error);
}

int64 UGenexAuthoritySubsystem::GetWorldHash() const
{
	return static_cast<int64>(CollisionWorld ? CollisionWorld->Hash() : genex::FirstpersonWorld::kEmptyHash);
}

FGenexPredictionStatus UGenexAuthoritySubsystem::GetPredictionStatus() const
{
	FGenexPredictionStatus Out;
	Out.World = GetWorldHash();
	if (!Session)
	{
		Out.Reason = TEXT("no_entity");
		return Out;
	}
	const genex::AuthorityPredictionStatus S = Session->PredictionStatus();
	Out.bPredicting = S.predicting;
	Out.Reason = GenexAuthorityDetail::Str(S.reason);
	Out.World = static_cast<int64>(S.world);
	Out.RoomWorld = S.roomWorld ? static_cast<int64>(*S.roomWorld) : -1;
	return Out;
}

namespace GenexAuthorityDetail
{
	/** An input axis as the server's sanitizeInput reads it: non-finite is 0, else clamped to [-1, 1].
	 *  (FMath::Clamp alone turns a NaN into its upper bound: a full input.) */
	static double Axis(double V)
	{
		return FMath::IsFinite(V) ? FMath::Clamp(V, -1.0, 1.0) : 0.0;
	}
}

FGenexAuthorityInput UGenexAuthoritySubsystem::MakeVehicleInput(float Throttle, float Steer, int32 Buttons)
{
	FGenexAuthorityInput Input;
	Input.MoveY = static_cast<float>(GenexAuthorityDetail::Axis(Throttle));
	// Unreal's +Yaw (a turn to the right on screen) is §17.7's +yaw, which its NEGATIVE moveX steers toward.
	Input.MoveX = static_cast<float>(-GenexAuthorityDetail::Axis(Steer));
	if (Input.MoveX == 0.f) Input.MoveX = 0.f;  // no -0 on the wire
	Input.Buttons = Buttons;
	return Input;
}

FGenexAuthorityInput UGenexAuthoritySubsystem::MakeFirstpersonInput(float Forward, float Right, const FRotator& View, int32 Buttons)
{
	const double Yaw = FMath::DegreesToRadians(static_cast<double>(View.Yaw));
	const double F = GenexAuthorityDetail::Axis(Forward);
	const double R = GenexAuthorityDetail::Axis(Right);
	// Unreal's forward at a yaw is (cos, sin) and its right (-sin, cos): X forward, Y right, Z up.
	double X = F * FMath::Cos(Yaw) - R * FMath::Sin(Yaw);
	double Y = F * FMath::Sin(Yaw) + R * FMath::Cos(Yaw);
	const double Length = FMath::Sqrt(X * X + Y * Y);
	if (Length > 1.0)
	{
		X /= Length;
		Y /= Length;
	}
	FGenexAuthorityInput Input;
	Input.MoveX = static_cast<float>(X);
	Input.MoveY = static_cast<float>(Y);
	Input.Yaw = static_cast<float>(Yaw);
	Input.Pitch = static_cast<float>(FMath::DegreesToRadians(static_cast<double>(View.Pitch)));
	Input.Buttons = Buttons;
	return Input;
}
