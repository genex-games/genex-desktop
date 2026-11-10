// Genex.Multiplayer.PIEVehicle: the vehicle preset (PROTOCOL.md §17.7 `vehicle`) and its ball (§17.9's
// "A ball" note) through the Blueprint API, in two PIE clients of one editor process against a real
// authority room running authority-host's car arena at its 60 Hz (GENEX_TEST_AUTHORITY,
// GENEX_TEST_CAR_GAME, and its collision world as the module exports it in the file GENEX_TEST_CAR_WORLD
// names: scripts/run-automation.sh boots them with sdks/unreal/test/servers.ts). The driver joins
// WITHOUT a world: Get Prediction Status must say `world_mismatch` with the room's hash; then it hands
// the world over as JSON (Set World From Json), whose hash must be the room's, and is predicted from
// then on. It drives with Make Vehicle Input: full throttle with boost, then steering RIGHT as the
// Unreal screen shows it (+Yaw, the views' Yaw growing), then a jump: its own view must show the boost
// burning fuel, a positive yaw rate (Spin) while it turns right, its Yaw turned toward +Yaw, and the
// jump (off the ground); the other client must draw its Spin and its burned Fuel; both must see the ball
// as a projectile (the server projectile `ball`, never interpolated, never their own entity); and the
// prediction must never be corrected (the step is the server's, bit for bit). Without the servers the
// test FAILS (a test that cannot run is not a pass).
#include "Editor.h"
#include "Engine/GameInstance.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexSettings.h"
#include "HAL/PlatformMisc.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Tests/AutomationEditorCommon.h"

namespace GenexPIEVehicleTestDetail
{
constexpr double TimeoutSeconds = 60.0;
/** The arena's buttons (the preset's defaults): jump 1, boost 2. */
constexpr int32 Jump = 1;
constexpr int32 Boost = 2;
/** The phases, seconds from the world's hand-over. */
constexpr double BoostUntil = 0.5;
constexpr double TurnUntil = 1.6;
constexpr double JumpUntil = 1.75;
constexpr double DoneAt = 3.0;

struct FState
{
	FString Authority, Game, WorldJson;
	double StartedAt = 0.0;
	double WorldAt = -1.0;
	TArray<TWeakObjectPtr<UGameInstance>> Instances;
	bool bJoinsStarted = false;
	bool bDone = false;
	FString Error;
	FGenexPredictionStatus Before;
	FGenexPredictionStatus After;
	int64 SetHash = -1;
	FString SetError;
	float StartYaw = 0.f;
	/** The fuel the module spawned the car with (car-arena.js's KICKOFF_FUEL). */
	float StartFuel = 0.f;
	float TurnedBy = 0.f;
	float MaxSpin = 0.f;
	float MinFuel = 1.f;
	bool bAirborneSeen = false;
	float OtherMaxSpin = 0.f;
	float OtherMinFuel = 1.f;
	bool bBallSeenByDriver = false;
	bool bBallSeenByOther = false;
	bool bBallMine = false;
	FGenexAuthorityTelemetry Telemetry;
};

TArray<UGameInstance*> PieInstances()
{
	TArray<UGameInstance*> Out;
	if (!GEditor) return Out;
	for (const FWorldContext& Context : GEditor->GetWorldContexts())
	{
		if (Context.WorldType == EWorldType::PIE && Context.OwningGameInstance) Out.Add(Context.OwningGameInstance);
	}
	return Out;
}

/** Whether `Authority` draws the ball as a projectile this frame (and whether it was ever its own). */
bool SeesBall(const UGenexAuthoritySubsystem* Authority, bool& bMine)
{
	FGenexEntity Ball;
	if (!Authority->GetEntity(TEXT("ball"), Ball)) return false;
	bMine = bMine || Ball.bMine;
	return Ball.bProjectile && Ball.LaunchTick > 0.0;
}
}

DEFINE_LATENT_AUTOMATION_COMMAND_ONE_PARAMETER(FGenexPIEVehicleDrive, TSharedPtr<GenexPIEVehicleTestDetail::FState>, State);
bool FGenexPIEVehicleDrive::Update()
{
	using namespace GenexPIEVehicleTestDetail;
	const double Now = FPlatformTime::Seconds();
	if (State->StartedAt == 0.0) State->StartedAt = Now;
	if (Now - State->StartedAt > TimeoutSeconds)
	{
		State->Error = TEXT("timed out");
		return true;
	}
	if (!State->bJoinsStarted)
	{
		TArray<UGameInstance*> Instances = PieInstances();
		if (Instances.Num() < 2) return false;
		for (UGameInstance* GI : Instances)
		{
			State->Instances.Add(GI);
			FGenexAuthorityOptions Options;
			Options.Url = State->Authority;
			Options.GameId = State->Game;
			GI->GetSubsystem<UGenexAuthoritySubsystem>()->Join(Options);
		}
		State->bJoinsStarted = true;
		return false;
	}
	UGameInstance* DriverGI = State->Instances[0].Get();
	UGameInstance* OtherGI = State->Instances[1].Get();
	if (!DriverGI || !OtherGI)
	{
		State->Error = TEXT("a PIE game instance went away");
		return true;
	}
	UGenexAuthoritySubsystem* Driver = DriverGI->GetSubsystem<UGenexAuthoritySubsystem>();
	UGenexAuthoritySubsystem* Other = OtherGI->GetSubsystem<UGenexAuthoritySubsystem>();
	for (UGenexAuthoritySubsystem* A : {Driver, Other})
	{
		if (A->GetStatus() == EGenexStatus::Closed)
		{
			State->Error = FString::Printf(TEXT("a join failed or closed: '%s'"), *A->GetLastError());
			return true;
		}
		if (!A->IsConnected()) return false;
	}
	FGenexEntity Me;
	if (!Driver->GetMe(Me)) return false;
	if (State->WorldAt < 0)
	{
		// Joined without a world: not the room's, so unpredicted. Then the room module's world, as JSON.
		State->Before = Driver->GetPredictionStatus();
		if (!Driver->SetWorldFromJson(State->WorldJson, State->SetHash, State->SetError))
		{
			State->Error = TEXT("the arena's world was refused: ") + State->SetError;
			return true;
		}
		State->WorldAt = Now;
		State->StartYaw = Me.Yaw;
		State->StartFuel = Me.Fuel;
		return false;
	}
	const double In = Now - State->WorldAt;
	// Full throttle and boost, then a right turn as the screen shows it, then a jump.
	const float Steer = In >= BoostUntil && In < TurnUntil ? 1.f : 0.f;
	const int32 Buttons = (In < BoostUntil ? Boost : 0) | (In >= TurnUntil && In < JumpUntil ? Jump : 0);
	Driver->SetInput(UGenexAuthoritySubsystem::MakeVehicleInput(In < DoneAt - 0.5 ? 1.f : 0.f, Steer, Buttons));
	if (In >= BoostUntil && In < TurnUntil) State->MaxSpin = FMath::Max(State->MaxSpin, Me.Spin);
	if (In < TurnUntil + 0.1) State->TurnedBy = FMath::FindDeltaAngleDegrees(State->StartYaw, Me.Yaw);
	State->MinFuel = FMath::Min(State->MinFuel, Me.Fuel);
	State->bAirborneSeen = State->bAirborneSeen || (In > TurnUntil && !Me.bOnGround);
	State->bBallSeenByDriver = SeesBall(Driver, State->bBallMine) || State->bBallSeenByDriver;
	State->bBallSeenByOther = SeesBall(Other, State->bBallMine) || State->bBallSeenByOther;
	const FString DriverId = Driver->GetSessionId();
	for (const FGenexEntity& E : Other->GetEntities())
	{
		if (E.Owner != DriverId || E.bProjectile) continue;
		State->OtherMaxSpin = FMath::Max(State->OtherMaxSpin, E.Spin);
		State->OtherMinFuel = FMath::Min(State->OtherMinFuel, E.Fuel);
	}
	if (In < DoneAt) return false;
	State->After = Driver->GetPredictionStatus();
	State->Telemetry = Driver->GetTelemetry();
	State->bDone = true;
	return true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEVehicleJudge, TSharedPtr<GenexPIEVehicleTestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEVehicleJudge::Update()
{
	using namespace GenexPIEVehicleTestDetail;
	Test->TestTrue(FString::Printf(TEXT("both PIE clients joined the car arena (%s)"), *State->Error), State->bDone && State->Error.IsEmpty());
	const FGenexPredictionStatus& B = State->Before;
	const FGenexPredictionStatus& A = State->After;
	Test->TestTrue(FString::Printf(TEXT("joined without a world: not predicted, world_mismatch (reason '%s', world %lld, room %lld)"), *B.Reason, B.World, B.RoomWorld),
		!B.bPredicting && B.Reason == TEXT("world_mismatch") && B.World == 2615243109 && B.RoomWorld > 0);
	Test->TestTrue(FString::Printf(TEXT("Set World From Json answers the room's world: %lld (%s)"), State->SetHash, *State->SetError), State->SetHash == B.RoomWorld);
	Test->TestTrue(FString::Printf(TEXT("then predicted (reason '%s', world %lld)"), *A.Reason, A.World), A.bPredicting && A.Reason.IsEmpty() && A.World == B.RoomWorld);
	Test->TestTrue(FString::Printf(TEXT("boost burned fuel from the spawn's %.3f (min %.3f)"), State->StartFuel, State->MinFuel), State->StartFuel > 0.2f && State->MinFuel < State->StartFuel - 0.1f);
	Test->TestTrue(FString::Printf(TEXT("Make Vehicle Input's Steer +1 turned it right on screen: Spin up to %.1f deg/s, Yaw turned by %.1f degrees"), State->MaxSpin, State->TurnedBy),
		State->MaxSpin > 30.f && State->TurnedBy > 30.f);
	Test->TestTrue(TEXT("its view left the ground on the jump"), State->bAirborneSeen);
	Test->TestTrue(FString::Printf(TEXT("the other client drew its Spin (%.1f deg/s) and burned Fuel (%.3f)"), State->OtherMaxSpin, State->OtherMinFuel),
		State->OtherMaxSpin > 30.f && State->OtherMinFuel < State->StartFuel - 0.1f);
	Test->TestTrue(TEXT("both clients drew the ball as a projectile, and neither as its own entity"), State->bBallSeenByDriver && State->bBallSeenByOther && !State->bBallMine);
	const FGenexAuthorityTelemetry& T = State->Telemetry;
	Test->TestTrue(FString::Printf(TEXT("predicted and never corrected: %d reconciles, %d visible corrections, peak %g"), T.Reconciles, T.VisibleCorrections, T.PeakCorrection),
		T.Reconciles > 0 && T.VisibleCorrections == 0 && T.PeakCorrection <= 1e-6f);
	for (const TWeakObjectPtr<UGameInstance>& GI : State->Instances)
	{
		if (GI.IsValid()) GI->GetSubsystem<UGenexAuthoritySubsystem>()->Leave();
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexPIEVehicleTest, "Genex.Multiplayer.PIEVehicle", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexPIEVehicleTest::RunTest(const FString&)
{
	TSharedPtr<GenexPIEVehicleTestDetail::FState> State = MakeShared<GenexPIEVehicleTestDetail::FState>();
	State->Authority = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_AUTHORITY"));
	State->Game = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_CAR_GAME"));
	const FString WorldFile = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_CAR_WORLD"));
	if (State->Authority.IsEmpty() || State->Game.IsEmpty() || WorldFile.IsEmpty())
	{
		AddError(TEXT("set GENEX_TEST_AUTHORITY, GENEX_TEST_CAR_GAME and GENEX_TEST_CAR_WORLD (scripts/run-automation.sh boots the servers)"));
		return false;
	}
	if (!FFileHelper::LoadFileToString(State->WorldJson, *WorldFile))
	{
		AddError(FString::Printf(TEXT("cannot read the arena's world: %s"), *WorldFile));
		return false;
	}
	ULevelEditorPlaySettings* Play = GetMutableDefault<ULevelEditorPlaySettings>();
	Play->SetPlayNumberOfClients(2);
	Play->SetPlayNetMode(EPlayNetMode::PIE_Standalone);
	Play->SetRunUnderOneProcess(true);
	ADD_LATENT_AUTOMATION_COMMAND(FEditorLoadMap(TEXT("/Engine/Maps/Entry")));
	ADD_LATENT_AUTOMATION_COMMAND(FStartPIECommand(false));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEVehicleDrive(State));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEVehicleJudge(State, this));
	ADD_LATENT_AUTOMATION_COMMAND(FEndPlayMapCommand());
	return true;
}
