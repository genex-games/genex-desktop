// Genex.Multiplayer.PIEFirstperson: the firstperson preset (PROTOCOL.md §17.7) through the Blueprint API,
// in two PIE clients of one editor process against a real authority room running authority-host's
// first-person arena (GENEX_TEST_AUTHORITY, GENEX_TEST_FPS_GAME, and its collision world as the module
// exports it in the file GENEX_TEST_FPS_WORLD names: scripts/run-automation.sh boots them with
// sdks/unreal/test/servers.ts). The walker joins WITHOUT a world: Get Prediction Status must say
// `world_mismatch` with the room's hash; then it hands the world over as a collision world asset in
// Unreal units (UGenexCollisionWorld::FromWorldJson, Set World From Asset), whose hash must be the room's,
// and is predicted from then on. It walks with Make Firstperson Input (camera-relative keys turned by the
// view's yaw) out from its spawn, looks up 20 degrees, ducks and jumps: its own view must show the duck, the jump (off the
// ground) and the pitch, the other client must draw its pitch and duck, and its prediction must never be
// corrected (the step is the server's, bit for bit). Without the servers the test FAILS (a test that cannot
// run is not a pass).
#include "Editor.h"
#include "Engine/GameInstance.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexCollisionWorld.h"
#include "GenexSettings.h"
#include "HAL/PlatformMisc.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Tests/AutomationEditorCommon.h"

namespace GenexPIEFirstpersonTestDetail
{
constexpr double TimeoutSeconds = 60.0;
/** The arena's buttons (the preset's defaults): jump 1, duck 2. */
constexpr int32 Jump = 1;
constexpr int32 Duck = 2;
constexpr float LookUpDegrees = 20.f;
/** The phases, seconds from the world's hand-over. */
constexpr double WalkUntil = 1.5;
constexpr double DuckUntil = 2.3;
constexpr double JumpUntil = 3.3;
constexpr double DoneAt = 4.0;

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
	int64 RoomHash = -1;
	int64 SetHash = -1;
	FString SetError;
	FVector Start = FVector::ZeroVector;
	FVector End = FVector::ZeroVector;
	float MaxDuck = 0.f;
	bool bDuckingSeen = false;
	bool bAirborneSeen = false;
	float MaxPitch = 0.f;
	float OtherMaxPitch = 0.f;
	float OtherMaxDuck = 0.f;
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
}

DEFINE_LATENT_AUTOMATION_COMMAND_ONE_PARAMETER(FGenexPIEFirstpersonDrive, TSharedPtr<GenexPIEFirstpersonTestDetail::FState>, State);
bool FGenexPIEFirstpersonDrive::Update()
{
	using namespace GenexPIEFirstpersonTestDetail;
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
	UGameInstance* WalkerGI = State->Instances[0].Get();
	UGameInstance* OtherGI = State->Instances[1].Get();
	if (!WalkerGI || !OtherGI)
	{
		State->Error = TEXT("a PIE game instance went away");
		return true;
	}
	UGenexAuthoritySubsystem* Walker = WalkerGI->GetSubsystem<UGenexAuthoritySubsystem>();
	UGenexAuthoritySubsystem* Other = OtherGI->GetSubsystem<UGenexAuthoritySubsystem>();
	for (UGenexAuthoritySubsystem* A : {Walker, Other})
	{
		if (A->GetStatus() == EGenexStatus::Closed)
		{
			State->Error = FString::Printf(TEXT("a join failed or closed: '%s'"), *A->GetLastError());
			return true;
		}
		if (!A->IsConnected()) return false;
	}
	FGenexEntity Me;
	if (!Walker->GetMe(Me)) return false;
	if (State->WorldAt < 0)
	{
		// Joined without a world: not the room's, so unpredicted. Then the room module's world, as an asset.
		State->Before = Walker->GetPredictionStatus();
		UGenexCollisionWorld* Asset = UGenexCollisionWorld::FromWorldJson(State->WorldJson, State->SetError);
		if (!Asset)
		{
			State->Error = TEXT("the arena's world was refused: ") + State->SetError;
			return true;
		}
		FString HashError;
		State->RoomHash = Asset->GetWorldHash(HashError);
		Walker->SetWorldFromAsset(Asset, State->SetHash, State->SetError);
		State->WorldAt = Now;
		State->Start = Me.Location;
		return false;
	}
	const double In = Now - State->WorldAt;
	// Walk with the camera-relative keys, looking up: toward the room's centre, or north from a side spawn
	// (the tunnel and the platform are between those and the centre: netcode-bench's openDirection);
	// then duck; then jump.
	const double Scale = GetDefault<UGenexSettings>()->UnitsPerMeter;
	const bool bSide = FMath::Abs(State->Start.Y / Scale) < 1.0;
	const float Facing = bSide ? 90.f : static_cast<float>(FMath::RadiansToDegrees(FMath::Atan2(-State->Start.Y, -State->Start.X)));
	const FRotator View(LookUpDegrees, Facing, 0.f);
	const int32 Buttons = In < WalkUntil ? 0 : In < DuckUntil ? Duck : In < JumpUntil ? Jump : 0;
	Walker->SetInput(UGenexAuthoritySubsystem::MakeFirstpersonInput(In < WalkUntil ? 1.f : 0.f, 0.f, View, Buttons));
	State->MaxDuck = FMath::Max(State->MaxDuck, Me.Duck);
	State->bDuckingSeen = State->bDuckingSeen || Me.bDucking;
	State->bAirborneSeen = State->bAirborneSeen || (In > DuckUntil && !Me.bOnGround);
	State->MaxPitch = FMath::Max(State->MaxPitch, Me.Pitch);
	const FString WalkerId = Walker->GetSessionId();
	for (const FGenexEntity& E : Other->GetEntities())
	{
		if (E.Owner != WalkerId || E.bProjectile) continue;
		State->OtherMaxPitch = FMath::Max(State->OtherMaxPitch, E.Pitch);
		State->OtherMaxDuck = FMath::Max(State->OtherMaxDuck, E.Duck);
	}
	if (In < WalkUntil) State->End = Me.Location;
	if (In < DoneAt) return false;
	State->After = Walker->GetPredictionStatus();
	State->Telemetry = Walker->GetTelemetry();
	State->bDone = true;
	return true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEFirstpersonJudge, TSharedPtr<GenexPIEFirstpersonTestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEFirstpersonJudge::Update()
{
	using namespace GenexPIEFirstpersonTestDetail;
	Test->TestTrue(FString::Printf(TEXT("both PIE clients joined the first-person arena (%s)"), *State->Error), State->bDone && State->Error.IsEmpty());
	const FGenexPredictionStatus& B = State->Before;
	const FGenexPredictionStatus& A = State->After;
	Test->TestTrue(FString::Printf(TEXT("joined without a world: not predicted, world_mismatch (reason '%s', world %lld, room %lld)"), *B.Reason, B.World, B.RoomWorld),
		!B.bPredicting && B.Reason == TEXT("world_mismatch") && B.World == 2615243109 && B.RoomWorld == State->RoomHash && State->RoomHash > 0);
	Test->TestTrue(FString::Printf(TEXT("the asset (Unreal units) hashes to the room's world: Set World answered %lld (%s)"), State->SetHash, *State->SetError), State->SetHash == State->RoomHash);
	Test->TestTrue(FString::Printf(TEXT("then predicted (reason '%s', world %lld)"), *A.Reason, A.World), A.bPredicting && A.Reason.IsEmpty() && A.World == State->RoomHash);
	const double Walked = FVector::Dist2D(State->Start, State->End) / GetDefault<UGenexSettings>()->UnitsPerMeter;
	Test->TestTrue(FString::Printf(TEXT("Make Firstperson Input walked it toward the centre (%.1f Genex units)"), Walked), Walked > 150.0);
	Test->TestTrue(FString::Printf(TEXT("its view ducked (max %.2f) and showed the ducking bit"), State->MaxDuck), State->MaxDuck >= 0.9f && State->bDuckingSeen);
	Test->TestTrue(TEXT("its view left the ground on the jump"), State->bAirborneSeen);
	Test->TestTrue(FString::Printf(TEXT("its view looked up %.2f degrees"), State->MaxPitch), FMath::Abs(State->MaxPitch - LookUpDegrees) < 0.01f);
	Test->TestTrue(FString::Printf(TEXT("the other client drew its pitch (%.2f degrees) and duck (%.2f)"), State->OtherMaxPitch, State->OtherMaxDuck),
		FMath::Abs(State->OtherMaxPitch - LookUpDegrees) < 0.5f && State->OtherMaxDuck >= 0.9f);
	const FGenexAuthorityTelemetry& T = State->Telemetry;
	Test->TestTrue(FString::Printf(TEXT("predicted and never corrected: %d reconciles, %d visible corrections, peak %g"), T.Reconciles, T.VisibleCorrections, T.PeakCorrection),
		T.Reconciles > 0 && T.VisibleCorrections == 0 && T.PeakCorrection <= 1e-6f);
	for (const TWeakObjectPtr<UGameInstance>& GI : State->Instances)
	{
		if (GI.IsValid()) GI->GetSubsystem<UGenexAuthoritySubsystem>()->Leave();
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexPIEFirstpersonTest, "Genex.Multiplayer.PIEFirstperson", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexPIEFirstpersonTest::RunTest(const FString&)
{
	TSharedPtr<GenexPIEFirstpersonTestDetail::FState> State = MakeShared<GenexPIEFirstpersonTestDetail::FState>();
	State->Authority = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_AUTHORITY"));
	State->Game = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_FPS_GAME"));
	const FString WorldFile = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_FPS_WORLD"));
	if (State->Authority.IsEmpty() || State->Game.IsEmpty() || WorldFile.IsEmpty())
	{
		AddError(TEXT("set GENEX_TEST_AUTHORITY, GENEX_TEST_FPS_GAME and GENEX_TEST_FPS_WORLD (scripts/run-automation.sh boots the servers)"));
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
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEFirstpersonDrive(State));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEFirstpersonJudge(State, this));
	ADD_LATENT_AUTOMATION_COMMAND(FEndPlayMapCommand());
	return true;
}
