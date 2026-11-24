// Genex.Multiplayer.PIEPractice: a real play in the editor asks a real practice helper. The test
// makes the project a game with a handoff (studio.json and .studio/llm-practice.json holding
// GENEX_TEST_PRACTICE_KEY, the key of the helper scripts/run-automation.sh boots with
// sdks/unreal/test/servers.ts), starts PIE, and the play's own UGenexModelsSubsystem asks for a
// budget and makes one call over Unreal's HTTP. Nothing here names the helper to the play: only the
// editor module's handoff does. Without the helper the test FAILS (a test that cannot run is not a pass).
#include "Editor.h"
#include "Engine/GameInstance.h"
#include "GenexLocalAuthority.h"
#include "GenexLocalPractice.h"
#include "GenexModelsSubsystem.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Tests/AutomationEditorCommon.h"

namespace GenexPIEPracticeTestDetail
{
struct FState
{
	FString Marker, Folder, Handoff;
	bool bMadeMarker = false;
	bool bMadeFolder = false;
	double StartedAt = 0.0;
	TWeakObjectPtr<UGameInstance> Instance;
	FDelegateHandle Ended;
	int32 Budget = 0;
	int32 Call = 0;
	FString BudgetBody, CallBody, Error;
	bool bDone = false;
};

UGameInstance* PieInstance()
{
	if (!GEditor) return nullptr;
	for (const FWorldContext& Context : GEditor->GetWorldContexts())
	{
		if (Context.WorldType == EWorldType::PIE && Context.OwningGameInstance) return Context.OwningGameInstance;
	}
	return nullptr;
}

/** The value of `"grantId":"…"` in a settled budget, or empty. */
FString GrantIdOf(const FString& Body)
{
	const FString Field = TEXT("\"grantId\":\"");
	const int32 At = Body.Find(Field, ESearchCase::CaseSensitive);
	if (At == INDEX_NONE) return FString();
	const int32 From = At + Field.Len();
	const int32 To = Body.Find(TEXT("\""), ESearchCase::CaseSensitive, ESearchDir::FromStart, From);
	return To == INDEX_NONE ? FString() : Body.Mid(From, To - From);
}

void RemoveHandoff(const FState& State)
{
	IFileManager& Files = IFileManager::Get();
	Files.Delete(*State.Handoff, false, true, true);
	if (State.bMadeFolder) Files.DeleteDirectory(*State.Folder, false, true);
	if (State.bMadeMarker) Files.Delete(*State.Marker, false, true, true);
}

constexpr double TimeoutSeconds = 30.0;
}

DEFINE_LATENT_AUTOMATION_COMMAND_ONE_PARAMETER(FGenexPIEPracticeDrive, TSharedPtr<GenexPIEPracticeTestDetail::FState>, State);
bool FGenexPIEPracticeDrive::Update()
{
	using namespace GenexPIEPracticeTestDetail;
	const double Now = FPlatformTime::Seconds();
	if (State->StartedAt == 0.0) State->StartedAt = Now;
	if (Now - State->StartedAt > TimeoutSeconds) State->Error = TEXT("timed out");
	if (!State->Error.IsEmpty()) return true;
	if (!State->Instance.IsValid())
	{
		UGameInstance* Instance = PieInstance();
		if (!Instance) return false;
		UGenexModelsSubsystem* Models = Instance->GetSubsystem<UGenexModelsSubsystem>();
		if (!Models)
		{
			State->Error = TEXT("the play has no models subsystem");
			return true;
		}
		State->Instance = Instance;
		TWeakPtr<FState> Weak = State;
		State->Ended = Models->OnEndedNative.AddLambda([Weak](int32 Request, const FString& Call, bool bRejected, const FString& Body) {
			const TSharedPtr<FState> S = Weak.Pin();
			if (!S) return;
			if (bRejected) S->Error = FString::Printf(TEXT("%s was rejected: %s"), *Call, *Body);
			else if (Request == S->Budget) S->BudgetBody = Body;
			else if (Request == S->Call) S->CallBody = Body;
		});
		State->Budget = Models->RequestSpendGrant(TEXT("{\"models\":[\"practice/echo\"],\"perCallMaxCredits\":2,")
			TEXT("\"disclosure\":{\"periodLabel\":\"session\",\"estimatedCallsPerPeriod\":5,\"estimatedCreditsPerPeriod\":5}}"));
		return false;
	}
	if (State->BudgetBody.IsEmpty()) return false;
	UGenexModelsSubsystem* Models = State->Instance->GetSubsystem<UGenexModelsSubsystem>();
	if (State->Call == 0)
	{
		const FString Grant = GrantIdOf(State->BudgetBody);
		if (Grant.IsEmpty())
		{
			State->Error = FString::Printf(TEXT("no budget came back: %s"), *State->BudgetBody);
			return true;
		}
		State->Call = Models->Generate(FString::Printf(
			TEXT("{\"grantId\":\"%s\",\"modelId\":\"practice/echo\",\"prompt\":\"Greet the traveller.\",\"outputFormat\":\"text\",\"maxCredits\":2}"), *Grant));
		return false;
	}
	if (State->CallBody.IsEmpty()) return false;
	State->bDone = true;
	return true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEPracticeJudge, TSharedPtr<GenexPIEPracticeTestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEPracticeJudge::Update()
{
	Test->TestTrue(FString::Printf(TEXT("the play asked for a budget and made a call (%s)"), *State->Error), State->bDone && State->Error.IsEmpty());
	Test->TestTrue(FString::Printf(TEXT("the helper approved the budget at once (%s)"), *State->BudgetBody), State->BudgetBody.Contains(TEXT("\"status\":\"active\"")));
	Test->TestTrue(FString::Printf(TEXT("the call was answered (%s)"), *State->CallBody), State->CallBody.Contains(TEXT("\"status\":\"succeeded\"")));
	Test->TestTrue(TEXT("by the practice helper, whose answers are marked"), State->CallBody.Contains(TEXT("[practice]")) && State->CallBody.Contains(TEXT("\"source\":\"practice\"")));
	if (State->Instance.IsValid())
	{
		if (UGenexModelsSubsystem* Models = State->Instance->GetSubsystem<UGenexModelsSubsystem>()) Models->OnEndedNative.Remove(State->Ended);
	}
	return true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_TWO_PARAMETER(FGenexPIEPracticeAfter, TSharedPtr<GenexPIEPracticeTestDetail::FState>, State, FAutomationTestBase*, Test);
bool FGenexPIEPracticeAfter::Update()
{
	if (GEditor && GEditor->IsPlaySessionInProgress()) return false;
	Test->TestTrue(TEXT("once the play ended, no key is left in the editor's environment"), FPlatformMisc::GetEnvironmentVariable(FGenexLocalPractice::KeyEnv).IsEmpty());
	GenexPIEPracticeTestDetail::RemoveHandoff(*State);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexPIEPracticeTest, "Genex.Multiplayer.PIEPractice", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexPIEPracticeTest::RunTest(const FString&)
{
	using namespace GenexPIEPracticeTestDetail;
	const FString Key = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_TEST_PRACTICE_KEY"));
	if (Key.IsEmpty())
	{
		AddError(TEXT("set GENEX_TEST_PRACTICE_KEY (scripts/run-automation.sh boots the practice helper)"));
		return false;
	}
	// The project becomes a game with a handoff, as Genex Studio leaves one; what this made is removed after.
	TSharedPtr<FState> State = MakeShared<FState>();
	const FString Game = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	State->Marker = FPaths::Combine(Game, FGenexLocalAuthority::GameMarker);
	State->Folder = FPaths::Combine(Game, FGenexLocalAuthority::HandoffFolder);
	State->Handoff = FPaths::Combine(State->Folder, FGenexLocalPractice::HandoffName);
	State->bMadeMarker = !FPaths::FileExists(State->Marker);
	State->bMadeFolder = !FPaths::DirectoryExists(State->Folder);
	if (State->bMadeMarker) FFileHelper::SaveStringToFile(TEXT("{}"), *State->Marker);
	IFileManager::Get().MakeDirectory(*State->Folder, true);
	FFileHelper::SaveStringToFile(FString::Printf(TEXT("{\"key\":\"%s\"}"), *Key), *State->Handoff);
	if (!TestEqual(TEXT("the handoff reads back as the helper's key, and the helper answers"), FGenexLocalPractice::Find(FPaths::ProjectDir()), Key))
	{
		RemoveHandoff(*State);
		return false;
	}
	ULevelEditorPlaySettings* Play = GetMutableDefault<ULevelEditorPlaySettings>();
	Play->SetPlayNumberOfClients(1);
	Play->SetPlayNetMode(EPlayNetMode::PIE_Standalone);
	Play->SetRunUnderOneProcess(true);
	ADD_LATENT_AUTOMATION_COMMAND(FEditorLoadMap(TEXT("/Engine/Maps/Entry")));
	ADD_LATENT_AUTOMATION_COMMAND(FStartPIECommand(false));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEPracticeDrive(State));
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEPracticeJudge(State, this));
	ADD_LATENT_AUTOMATION_COMMAND(FEndPlayMapCommand());
	ADD_LATENT_AUTOMATION_COMMAND(FGenexPIEPracticeAfter(State, this));
	return true;
}
