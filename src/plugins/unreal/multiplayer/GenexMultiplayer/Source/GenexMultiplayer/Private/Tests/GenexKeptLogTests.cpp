// Genex.Multiplayer.KeptLog: the file a build without Unreal's logging keeps the plugin's warnings in
// (GenexKeptLog.h). A line is written with its time and level, a run starts the file over, the file stops at its
// cap and stays whole, a text's line breaks cannot forge a second line, and a folder that cannot be written drops
// the line without an error.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "GenexKeptLog.h"
#include "HAL/FileManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexKeptLogTest, "Genex.Multiplayer.KeptLog", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexKeptLogTest::RunTest(const FString&)
{
	const FString Folder = FPaths::Combine(FPaths::ProjectIntermediateDir(), TEXT("GenexKeptLogTest"), FGuid::NewGuid().ToString());
	const FString Path = FPaths::Combine(Folder, TEXT("Genex.log"));
	const auto Lines = [&Path]() {
		TArray<FString> Out;
		FFileHelper::LoadFileToStringArray(Out, *Path);
		return Out;
	};
	const FString Refusal = TEXT("genex models: generate failed: invalid_schema (HTTP 400): schema: an object needs additionalProperties set to false");
	{
		FGenexKeptLog Log(Path);
		TestTrue(TEXT("a first line is written, and its folder made"), Log.Append(TEXT("Warning"), Refusal));
		TestTrue(TEXT("a second line is added"), Log.Append(TEXT("Error"), TEXT("second")));
		const TArray<FString> Read = Lines();
		if (TestEqual(TEXT("two lines"), Read.Num(), 2))
		{
			TestTrue(TEXT("the line holds its level and text"), Read[0].EndsWith(FString(TEXT(" Warning ")) + Refusal));
			TestTrue(TEXT("and starts with the UTC time"), Read[0].Left(2) == TEXT("20") && Read[0].Contains(TEXT("T")));
			TestTrue(TEXT("the second line is the second"), Read[1].EndsWith(TEXT(" Error second")));
		}
	}
	{
		// A new run of the game starts the file over.
		FGenexKeptLog Log(Path);
		TestTrue(TEXT("the next run writes"), Log.Append(TEXT("Warning"), TEXT("a new run")));
		const TArray<FString> Read = Lines();
		TestTrue(TEXT("and the last run's lines are gone"), Read.Num() == 1 && Read[0].EndsWith(TEXT(" Warning a new run")));
	}
	{
		// Line breaks in a text cannot forge a line of their own.
		FGenexKeptLog Log(Path);
		Log.Append(TEXT("Warning"), TEXT("one\r\ntwo\n2026-01-01T00:00:00.000Z Error forged"));
		TestEqual(TEXT("one line however the text breaks"), Lines().Num(), 1);
	}
	{
		// The cap: the file never passes it, the line that would is dropped whole, and nothing follows it.
		FGenexKeptLog Log(Path, 200);
		const FString Sixty = FString::ChrN(60, TEXT('a'));
		TestTrue(TEXT("under the cap"), Log.Append(TEXT("Warning"), Sixty));
		TestTrue(TEXT("still under"), Log.Append(TEXT("Warning"), Sixty));
		TestFalse(TEXT("the line that would pass the cap is not written"), Log.Append(TEXT("Warning"), Sixty));
		TestFalse(TEXT("nor a short one after it"), Log.Append(TEXT("Warning"), TEXT("x")));
		TestTrue(TEXT("the file is within the cap"), IFileManager::Get().FileSize(*Path) <= 200);
		TestEqual(TEXT("and holds whole lines only"), Lines().Num(), 2);
	}
	{
		// A place that cannot be written: a file stands where the folder should be.
		const FString Blocker = FPaths::Combine(Folder, TEXT("blocker"));
		FFileHelper::SaveStringToFile(TEXT("x"), *Blocker);
		FGenexKeptLog Log(FPaths::Combine(Blocker, TEXT("Genex.log")));
		TestFalse(TEXT("a line that cannot be written is dropped"), Log.Append(TEXT("Warning"), Refusal));
		TestFalse(TEXT("and the log stays closed"), Log.Append(TEXT("Warning"), Refusal));
	}
	TestTrue(TEXT("the default file is Genex.log in the game's log folder"), FGenexKeptLog::DefaultPath() == FPaths::Combine(FPaths::ProjectLogDir(), TEXT("Genex.log")));
	IFileManager::Get().DeleteDirectory(*Folder, false, true);
	return true;
}

#endif  // WITH_DEV_AUTOMATION_TESTS
