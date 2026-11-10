// Genex.Multiplayer.PIE: two PIE clients in one editor process, each with its own game instance and
// so its own relay and authority sessions, all pumped by the plugin's one module-owned pump. Both
// join a bench relay room and a real authority room (GENEX_TEST_RELAY, GENEX_TEST_AUTHORITY,
// GENEX_TEST_GAME: scripts/run-automation.sh boots them with sdks/unreal/test/servers.ts); the first
// client walks, and the second must draw it moving. Without the servers the test FAILS (a test that
// cannot run is not a pass).
#include "Editor.h"
#include "Engine/GameInstance.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexMultiplayerSubsystem.h"
#include "HAL/PlatformMisc.h"
#include "Misc/AutomationTest.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Tests/AutomationEditorCommon.h"

namespace GenexPIETestDetail
{
struct FState
{
	FString Relay, Authority, Game;
	double StartedAt = 0.0;
	double WalkFrom = -1.0;
	FVector WalkStart = FVector::ZeroVector;
	FString WalkerId;
	TArray<TWeakObjectPtr<UGameInstance>> Instances;
	bool bJoinsStarted = false;
	bool bDone = false;
	FString Error;
	float Walked = 0.f;
	float SeenWalked = 0.f;
	int32 RelayPlayers = 0;
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

constexpr double TimeoutSeconds = 60.0;
constexpr double WalkSeconds = 1.5;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEDrive, TSharedPtr<GenexPIETestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEDrive::Update()
{
	using namespace GenexPIETestDetail;
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
			FGenexRoomOptions Room;
			Room.GameId = TEXT("unreal-pie");
			Room.RelayUrls.Add(State->Relay);
			Room.bSignInAutomatically = false; // a loopback relay takes the local placeholder; never call the real API from a test
			GI->GetSubsystem<UGenexMultiplayerSubsystem>()->Join(Room);
			FGenexAuthorityOptions Options;
			Options.Url = State->Authority;
			Options.GameId = State->Game;
			GI->GetSubsystem<UGenexAuthoritySubsystem>()->Join(Options);
		}
		State->bJoinsStarted = true;
		return false;
	}
	UGameInstance* Walker = State->Instances[0].Get();
	UGameInstance* Watcher = State->Instances[1].Get();
	if (!Walker || !Watcher)
	{
		State->Error = TEXT("a PIE game instance went away");
		return true;
	}
	for (const TWeakObjectPtr<UGameInstance>& GI : State->Instances)
	{
		UGenexMultiplayerSubsystem* Relay = GI->GetSubsystem<UGenexMultiplayerSubsystem>();
		UGenexAuthoritySubsystem* Authority = GI->GetSubsystem<UGenexAuthoritySubsystem>();
		if (Relay->GetStatus() == EGenexStatus::Closed || Authority->GetStatus() == EGenexStatus::Closed)
		{
			State->Error = FString::Printf(TEXT("a join failed or closed: relay %d '%s', authority %d '%s'"), int32(Relay->GetStatus()), *Relay->GetLastError(), int32(Authority->GetStatus()), *Authority->GetLastError());
			return true;
		}
		if (!Relay->IsConnected() || !Authority->IsConnected()) return false;
	}
	UGenexAuthoritySubsystem* WalkerAuthority = Walker->GetSubsystem<UGenexAuthoritySubsystem>();
	UGenexAuthoritySubsystem* WatcherAuthority = Watcher->GetSubsystem<UGenexAuthoritySubsystem>();
	FGenexEntity Me;
	if (!WalkerAuthority->GetMe(Me)) return false;
	State->RelayPlayers = Watcher->GetSubsystem<UGenexMultiplayerSubsystem>()->GetPlayers().Num();
	if (State->WalkFrom < 0)
	{
		State->WalkFrom = Now;
		State->WalkStart = Me.Location;
		State->WalkerId = Me.Id;
		FGenexAuthorityInput Input;
		Input.MoveX = 1.f;
		WalkerAuthority->SetInput(Input);
		return false;
	}
	if (Now - State->WalkFrom < WalkSeconds) return false;
	WalkerAuthority->SetInput(FGenexAuthorityInput());
	State->Walked = (Me.Location.X - State->WalkStart.X) / 100.f;
	FGenexEntity Seen;
	if (WatcherAuthority->GetEntity(State->WalkerId, Seen)) State->SeenWalked = (Seen.Location.X - State->WalkStart.X) / 100.f;
	State->bDone = true;
	return true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEJudge, TSharedPtr<GenexPIETestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEJudge::Update()
{
	Test->TestTrue(FString::Printf(TEXT("both PIE clients joined, walked and watched (%s)"), *State->Error), State->bDone && State->Error.IsEmpty());
	Test->TestTrue(FString::Printf(TEXT("the walker's own entity moved >= 4 units in 1.5 s (%.2f)"), State->Walked), State->Walked >= 4.f);
	Test->TestTrue(FString::Printf(TEXT("the other client drew it moving, 100 ms behind (%.2f)"), State->SeenWalked), State->SeenWalked >= 2.f);
	Test->TestTrue(FString::Printf(TEXT("the relay room seated both clients (%d)"), State->RelayPlayers), State->RelayPlayers >= 2);
	for (const TWeakObjectPtr<UGameInstance>& GI : State->Instances)
	{
		if (!GI.IsValid()) continue;
		GI->GetSubsystem<UGenexMultiplayerSubsystem>()->Leave();
		GI->GetSubsystem<UGenexAuthoritySubsystem>()->Leave();
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexPIETest, "Genex.Multiplayer.PIE", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexPIETest::RunTest(const FString&)
{
	TSharedPtr<GenexPIETestDetail::FState> State = MakeShared<GenexPIETestDetail::FState>();
	State->Relay = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_RELAY"));
	State->Authority = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_AUTHORITY"));
	State->Game = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_GAME"));
	if (State->Relay.IsEmpty() || State->Authority.IsEmpty() || State->Game.IsEmpty())
	{
		AddError(TEXT("set GENEX_TEST_RELAY, GENEX_TEST_AUTHORITY and GENEX_TEST_GAME (scripts/run-automation.sh boots the servers)"));
		return false;
	}
	ULevelEditorPlaySettings* Play = GetMutableDefault<ULevelEditorPlaySettings>();
	Play->SetPlayNumberOfClients(2);
	Play->SetPlayNetMode(EPlayNetMode::PIE_Standalone);
	Play->SetRunUnderOneProcess(true);
	ADD_LATENT_AUTOMATION_COMMAND(FEditorLoadMap(TEXT("/Engine/Maps/Entry")));
	ADD_LATENT_AUTOMATION_COMMAND(FStartPIECommand(false));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEDrive(State, this));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEJudge(State, this));
	ADD_LATENT_AUTOMATION_COMMAND(FEndPlayMapCommand());
	return true;
}
