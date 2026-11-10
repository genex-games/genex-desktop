// Genex.Multiplayer.PIEProjectile: projectiles (PROTOCOL.md §17.9) through the Blueprint API, in two PIE
// clients of one editor process against a real authority room running authority-host's projectile arena
// (GENEX_TEST_AUTHORITY, GENEX_TEST_PROJECTILE_GAME: scripts/run-automation.sh boots it with
// sdks/unreal/test/servers.ts). The shooter fires bolts with UGenexAuthoritySubsystem::PredictProjectile
// (FireButtons = the arena's FIRE bit): each must be listed by GetEntities the same frame it fires, as a
// projectile of this seat, and be confirmed under the same id (an integer LaunchTick); the other client
// must draw it as a foreign projectile that moves at the bolt's speed (never frozen at its launch, never
// interpolated behind). Without the servers the test FAILS (a test that cannot run is not a pass).
#include "Editor.h"
#include "Engine/GameInstance.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexSettings.h"
#include "HAL/PlatformMisc.h"
#include "Misc/AutomationTest.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Tests/AutomationEditorCommon.h"

namespace GenexPIEProjectileTestDetail
{
/** projectile-arena.js: the bolt button and speed (Genex units per second). */
constexpr int32 Fire = 1;
constexpr double BoltSpeed = 18.0;
constexpr double TimeoutSeconds = 60.0;
/** Shots fired, one every this long (the arena's cooldown is 9 ticks, 0.3 s). */
constexpr int32 Shots = 4;
constexpr double ShotEverySeconds = 0.6;
/** How long after the last shot the frames keep being read. */
constexpr double TailSeconds = 1.2;

struct FShot
{
	FString Id;
	bool bDrawnAtOnce = false;
	bool bConfirmed = false;
	bool bSeenByOther = false;
	/** The other client's drawing of it: the farthest it saw it from the launch, Genex units. */
	double OtherTravelled = 0.0;
	FVector Origin = FVector::ZeroVector;
};

struct FState
{
	FString Authority, Game;
	double StartedAt = 0.0;
	double ReadyAt = -1.0;
	double LastShotAt = -1.0;
	TArray<TWeakObjectPtr<UGameInstance>> Instances;
	bool bJoinsStarted = false;
	bool bDone = false;
	FString Error;
	TArray<FShot> Fired;
	int32 SelfWrong = 0;
	/** The other client's frame-to-frame progress of the shooter's bolts against the bolt's speed. */
	double OtherWorstPace = 0.0;
	TMap<FString, TPair<double, FVector>> OtherLast;
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

double Scale() { return GetDefault<UGenexSettings>()->UnitsPerMeter; }
}

DEFINE_LATENT_AUTOMATION_COMMAND_ONE_PARAMETER(FGenexPIEProjectileDrive, TSharedPtr<GenexPIEProjectileTestDetail::FState>, State);
bool FGenexPIEProjectileDrive::Update()
{
	using namespace GenexPIEProjectileTestDetail;
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
	UGameInstance* ShooterGI = State->Instances[0].Get();
	UGameInstance* OtherGI = State->Instances[1].Get();
	if (!ShooterGI || !OtherGI)
	{
		State->Error = TEXT("a PIE game instance went away");
		return true;
	}
	UGenexAuthoritySubsystem* Shooter = ShooterGI->GetSubsystem<UGenexAuthoritySubsystem>();
	UGenexAuthoritySubsystem* Other = OtherGI->GetSubsystem<UGenexAuthoritySubsystem>();
	for (UGenexAuthoritySubsystem* A : {Shooter, Other})
	{
		if (A->GetStatus() == EGenexStatus::Closed)
		{
			State->Error = FString::Printf(TEXT("a join failed or closed: '%s'"), *A->GetLastError());
			return true;
		}
		if (!A->IsConnected()) return false;
	}
	FGenexEntity Me, Them;
	if (!Shooter->GetMe(Me) || !Other->GetMe(Them)) return false;
	if (Me.bProjectile || Them.bProjectile) State->SelfWrong += 1;
	if (State->ReadyAt < 0)
	{
		State->ReadyAt = Now; // let the clock settle before the first shot
		return false;
	}
	const FString ShooterId = Shooter->GetSessionId();
	// The other client's drawing of the shooter's bolts: foreign projectiles at the server's present.
	for (const FGenexEntity& E : Other->GetEntities())
	{
		if (!E.bProjectile || E.Source != ShooterId) continue;
		for (FShot& S : State->Fired)
		{
			if (S.Id != E.Id) continue;
			S.bSeenByOther = true;
			S.OtherTravelled = FMath::Max(S.OtherTravelled, FVector::Dist2D(E.Location, S.Origin) / Scale());
		}
		if (const TPair<double, FVector>* Last = State->OtherLast.Find(E.Id))
		{
			const double Moved = FVector::Dist2D(E.Location, Last->Value) / Scale();
			const double Expected = BoltSpeed * (Now - Last->Key);
			// Frames of one editor tick share an instant: judge only frames apart in time.
			if (Now - Last->Key > 0.005) State->OtherWorstPace = FMath::Max(State->OtherWorstPace, FMath::Abs(Moved - Expected));
		}
		State->OtherLast.Add(E.Id, TPair<double, FVector>(Now, E.Location));
	}
	// The shooter's own: confirmed under the same id once the server's arrives (an integer launch tick).
	for (FShot& S : State->Fired)
	{
		FGenexEntity Drawn;
		if (Shooter->GetEntity(S.Id, Drawn) && Drawn.bProjectile && Drawn.Source == ShooterId && Drawn.LaunchTick == FMath::FloorToDouble(Drawn.LaunchTick)) S.bConfirmed = true;
	}
	if (State->Fired.Num() < Shots)
	{
		if (State->LastShotAt >= 0 && Now - State->LastShotAt < ShotEverySeconds) return false;
		if (Now - State->ReadyAt < 1.0) return false;
		// Aim at the other player as drawn, and fire one bolt along it (projectile-arena.js `launch`).
		// A target closer than 4 units is not aimed at (a hit inside one patch interval is in no state patch,
		// so it could never be confirmed): the bolt goes the other way, and the other client still draws it.
		double Yaw = FMath::Atan2(Them.Location.Y - Me.Location.Y, Them.Location.X - Me.Location.X);
		if (FVector::Dist2D(Them.Location, Me.Location) / Scale() < 4.0) Yaw += Yaw > 0 ? -UE_DOUBLE_PI : UE_DOUBLE_PI;
		const float Aim = static_cast<float>(Yaw);
		FGenexAuthorityInput Input;
		Input.Yaw = Aim;
		Shooter->SetInput(Input);
		FGenexProjectileLaunch Launch;
		Launch.Kind = TEXT("bolt");
		Launch.Location = FVector(Me.Location.X, Me.Location.Y, 0.0);
		Launch.Velocity = FVector(FMath::Cos(static_cast<double>(Aim)), FMath::Sin(static_cast<double>(Aim)), 0.0) * BoltSpeed * Scale();
		FShot S;
		S.Id = Shooter->PredictProjectile(Launch, Fire);
		S.Origin = Launch.Location;
		FGenexEntity Drawn;
		S.bDrawnAtOnce = !S.Id.IsEmpty() && Shooter->GetEntity(S.Id, Drawn) && Drawn.bProjectile && !Drawn.bMine && Drawn.Source == ShooterId;
		State->Fired.Add(S);
		State->LastShotAt = Now;
		return false;
	}
	if (Now - State->LastShotAt < TailSeconds) return false;
	State->Telemetry = Shooter->GetTelemetry();
	State->bDone = true;
	return true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEProjectileJudge, TSharedPtr<GenexPIEProjectileTestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEProjectileJudge::Update()
{
	using namespace GenexPIEProjectileTestDetail;
	Test->TestTrue(FString::Printf(TEXT("both PIE clients joined the projectile arena and fired (%s)"), *State->Error), State->bDone && State->Error.IsEmpty());
	int32 AtOnce = 0, Confirmed = 0, Seen = 0;
	double LeastTravelled = TNumericLimits<double>::Max();
	for (const FShot& S : State->Fired)
	{
		AtOnce += S.bDrawnAtOnce ? 1 : 0;
		Confirmed += S.bConfirmed ? 1 : 0;
		Seen += S.bSeenByOther ? 1 : 0;
		if (S.bSeenByOther) LeastTravelled = FMath::Min(LeastTravelled, S.OtherTravelled);
		Test->AddInfo(FString::Printf(TEXT("%s: at once %d, confirmed %d, seen by the other %d (%.2f units)"), *S.Id, S.bDrawnAtOnce, S.bConfirmed, S.bSeenByOther, S.OtherTravelled));
	}
	Test->TestEqual(TEXT("every predicted shot is listed by GetEntities the frame it fires, as this seat's projectile"), AtOnce, Shots);
	Test->TestEqual(TEXT("every shot is confirmed under its id (the server's launch takes the prediction's place)"), Confirmed, Shots);
	Test->TestTrue(FString::Printf(TEXT("the other client draws the bolts (%d of %d), flying (least %.2f units from the launch)"), Seen, Shots, Seen > 0 ? LeastTravelled : 0.0), Seen >= Shots - 1 && Seen > 0 && LeastTravelled >= 1.0);
	Test->TestTrue(FString::Printf(TEXT("the other client's bolts keep the bolt's pace frame to frame (worst %.3f units)"), State->OtherWorstPace), State->OtherWorstPace <= 0.5);
	Test->TestEqual(TEXT("a projectile is never GetMe"), State->SelfWrong, 0);
	const FGenexAuthorityTelemetry& T = State->Telemetry;
	// On loopback the input lead is the wait for the next tick, give or take the client's clock estimate:
	// it was measured at -0.5 ms once (a fire just after a tick's nominal instant, the tick running late),
	// so it is held to (-1 tick, 250 ms) here (the send step, the tick and a patch, with room); the
	// latency runs (projectile-smoke.ts, projectile-rules.ts) require it positive.
	const double TickMs = 1000.0 / 30.0;
	Test->TestTrue(FString::Printf(TEXT("telemetry: %d predicted, %d confirmed, %d rejected, lead %.1f ms"), T.ProjectilesPredicted, T.ProjectilesConfirmed, T.ProjectilesRejected, T.LastProjectileLeadMs),
		T.ProjectilesPredicted == Shots && T.ProjectilesConfirmed + T.ProjectilesRejected == Shots && T.ProjectilesConfirmed >= Confirmed &&
		T.ProjectilesConfirmed > 0 && T.LastProjectileLeadMs > -TickMs && T.LastProjectileLeadMs < 250.0);
	for (const TWeakObjectPtr<UGameInstance>& GI : State->Instances)
	{
		if (GI.IsValid()) GI->GetSubsystem<UGenexAuthoritySubsystem>()->Leave();
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexPIEProjectileTest, "Genex.Multiplayer.PIEProjectile", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexPIEProjectileTest::RunTest(const FString&)
{
	TSharedPtr<GenexPIEProjectileTestDetail::FState> State = MakeShared<GenexPIEProjectileTestDetail::FState>();
	State->Authority = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_AUTHORITY"));
	State->Game = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_PROJECTILE_GAME"));
	if (State->Authority.IsEmpty() || State->Game.IsEmpty())
	{
		AddError(TEXT("set GENEX_TEST_AUTHORITY and GENEX_TEST_PROJECTILE_GAME (scripts/run-automation.sh boots the servers)"));
		return false;
	}
	ULevelEditorPlaySettings* Play = GetMutableDefault<ULevelEditorPlaySettings>();
	Play->SetPlayNumberOfClients(2);
	Play->SetPlayNetMode(EPlayNetMode::PIE_Standalone);
	Play->SetRunUnderOneProcess(true);
	ADD_LATENT_AUTOMATION_COMMAND(FEditorLoadMap(TEXT("/Engine/Maps/Entry")));
	ADD_LATENT_AUTOMATION_COMMAND(FStartPIECommand(false));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEProjectileDrive(State));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEProjectileJudge(State, this));
	ADD_LATENT_AUTOMATION_COMMAND(FEndPlayMapCommand());
	return true;
}
