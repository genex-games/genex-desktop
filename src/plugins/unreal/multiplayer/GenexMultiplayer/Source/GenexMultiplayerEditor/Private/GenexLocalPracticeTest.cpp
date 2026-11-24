// Genex.Multiplayer.LocalPractice: the handoff of a game's practice helper to a play in the editor.
// Each row builds a game folder (studio.json) holding an Unreal project below it and a
// .studio/llm-practice.json, and asks Find() for the project with the port's answer supplied.
#include "GenexLocalPractice.h"

#include "GenexLocalAuthority.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"

#if !PLATFORM_WINDOWS
#include <unistd.h>
#endif

namespace GenexLocalPracticeTest
{
/** A symbolic link, where the platform lets a test make one. */
bool MakeLink(const FString& Target, const FString& Link)
{
#if PLATFORM_WINDOWS
	return false; // symlinks need a privilege on Windows; the link rows run on Mac/Linux.
#else
	return ::symlink(TCHAR_TO_UTF8(*Target), TCHAR_TO_UTF8(*Link)) == 0;
#endif
}

const TCHAR* const Token = TEXT("0123456789abcdef0123456789abcdef");

/** A game folder with an Unreal project in `unreal/`, removed when it goes out of scope. */
struct FGame
{
	FString Root;
	FString Project;
	FGame()
	{
		Root = FPaths::Combine(FPaths::ProjectIntermediateDir(), TEXT("GenexLocalPracticeTest"), FGuid::NewGuid().ToString());
		Project = FPaths::Combine(Root, TEXT("unreal"));
		IFileManager::Get().MakeDirectory(*FPaths::Combine(Root, TEXT(".studio")), true);
		IFileManager::Get().MakeDirectory(*Project, true);
		FFileHelper::SaveStringToFile(TEXT("{}"), *FPaths::Combine(Root, TEXT("studio.json")));
	}
	~FGame() { IFileManager::Get().DeleteDirectory(*Root, false, true); }
	void Handoff(const FString& Text) const
	{
		FFileHelper::SaveStringToFile(Text, *FPaths::Combine(Root, TEXT(".studio"), FGenexLocalPractice::HandoffName));
	}
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexLocalPracticeTest, "Genex.Multiplayer.LocalPractice",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FGenexLocalPracticeTest::RunTest(const FString& Parameters)
{
	using namespace GenexLocalPracticeTest;
	const FString Key = FString::Printf(TEXT("43117.%s"), Token);
	const auto Up = [](int32) { return true; };
	const auto Down = [](int32) { return false; };

	// The key is the handoff's whole content, and only a port on this computer with its token.
	TestEqual(TEXT("a key reads back"), FGenexLocalPractice::Parse(FString::Printf(TEXT("{\"key\":\"%s\"}"), *Key)), Key);
	TestEqual(TEXT("with spaces around it"), FGenexLocalPractice::Parse(FString::Printf(TEXT(" {\n  \"key\" : \"%s\"\n}\n"), *Key)), Key);
	const TArray<FString> Hostile = {
		TEXT(""), TEXT("{}"), TEXT("[]"), TEXT("null"), Key, FString::Printf(TEXT("\"%s\""), *Key),
		FString::Printf(TEXT("{\"key\":\"%s\",\"url\":\"http://evil.example\"}"), *Key),
		FString::Printf(TEXT("{\"url\":\"%s\"}"), *Key),
		FString::Printf(TEXT("{\"key\":\"%s\"} trailing"), *Key),
		FString::Printf(TEXT("{\"key\":\"80.%s\"}"), Token),
		FString::Printf(TEXT("{\"key\":\"65536.%s\"}"), Token),
		FString::Printf(TEXT("{\"key\":\"043117.%s\"}"), Token),
		FString::Printf(TEXT("{\"key\":\"evil.example:80.%s\"}"), Token),
		FString::Printf(TEXT("{\"key\":\"http://127.0.0.1:43117.%s\"}"), Token),
		TEXT("{\"key\":\"43117.0123456789ABCDEF0123456789ABCDEF\"}"),
		TEXT("{\"key\":\"43117.0123456789abcdef\"}"),
		FString::Printf(TEXT("{\"key\":\"43117.%s\\u0000\"}"), Token),
		FString::Printf(TEXT("{\"key\":\"43117.%s \"}"), Token),
		FString::Printf(TEXT("{\"key\":43117.%s}"), Token),
	};
	for (const FString& Text : Hostile) TestTrue(FString::Printf(TEXT("no key: %s"), *Text), FGenexLocalPractice::Parse(Text).IsEmpty());

	// Found only in the game's own folder, as a small plain file, while its port answers.
	{
		FGame Game;
		TestTrue(TEXT("no handoff: nothing"), FGenexLocalPractice::Find(Game.Project, Up).IsEmpty());
		Game.Handoff(FString::Printf(TEXT("{\"key\":\"%s\"}"), *Key));
		TestEqual(TEXT("a handoff whose port answers is found"), FGenexLocalPractice::Find(Game.Project, Up), Key);
		TestTrue(TEXT("a helper that is gone is not named"), FGenexLocalPractice::Find(Game.Project, Down).IsEmpty());
		int32 Asked = 0;
		FGenexLocalPractice::Find(Game.Project, [&Asked](int32 Port) { Asked = Port; return true; });
		TestEqual(TEXT("the key's own port is the one probed"), Asked, 43117);
		Game.Handoff(FString::ChrN(2000, 'x'));
		TestTrue(TEXT("a file too large to be a handoff is not read"), FGenexLocalPractice::Find(Game.Project, Up).IsEmpty());
		Game.Handoff(TEXT("{\"key\":\"http://evil.example\"}"));
		TestTrue(TEXT("a handoff that names anything else is nothing"), FGenexLocalPractice::Find(Game.Project, Up).IsEmpty());
	}
#if !PLATFORM_WINDOWS
	// A link is never followed: neither a .studio folder nor a handoff that points out of the game.
	{
		FGame Outside;
		Outside.Handoff(FString::Printf(TEXT("{\"key\":\"%s\"}"), *Key));
		const FString OutsideFolder = FPaths::Combine(Outside.Root, TEXT(".studio"));
		FGame LinkedFolder;
		IFileManager::Get().DeleteDirectory(*FPaths::Combine(LinkedFolder.Root, TEXT(".studio")), false, true);
		TestTrue(TEXT("made the linked .studio/"), MakeLink(OutsideFolder, FPaths::Combine(LinkedFolder.Root, TEXT(".studio"))));
		TestTrue(TEXT("a linked .studio/ is not read"), FGenexLocalPractice::Find(LinkedFolder.Project, Up).IsEmpty());
		FGame LinkedFile;
		TestTrue(TEXT("made the linked handoff"),
			MakeLink(FPaths::Combine(OutsideFolder, FGenexLocalPractice::HandoffName), FPaths::Combine(LinkedFile.Root, TEXT(".studio"), FGenexLocalPractice::HandoffName)));
		TestTrue(TEXT("a linked handoff is not read"), FGenexLocalPractice::Find(LinkedFile.Project, Up).IsEmpty());
		TestEqual(TEXT("while the real one beside them still is"), FGenexLocalPractice::Find(Outside.Project, Up), Key);
	}
#endif
	// A project that is in no Genex game folder is never handed one.
	{
		const FString Lone = FPaths::Combine(FPaths::ProjectIntermediateDir(), TEXT("GenexLocalPracticeTest"), FGuid::NewGuid().ToString());
		IFileManager::Get().MakeDirectory(*FPaths::Combine(Lone, TEXT(".studio")), true);
		FFileHelper::SaveStringToFile(FString::Printf(TEXT("{\"key\":\"%s\"}"), *Key), *FPaths::Combine(Lone, TEXT(".studio"), FGenexLocalPractice::HandoffName));
		TestTrue(TEXT("no studio.json above the project: nothing"), FGenexLocalPractice::Find(Lone, Up).IsEmpty());
		IFileManager::Get().DeleteDirectory(*Lone, false, true);
	}
	// Hand puts the key where the play's model calls take it from, and an empty key takes it away.
	{
		const FString Saved = FPlatformMisc::GetEnvironmentVariable(FGenexLocalPractice::KeyEnv);
		FGenexLocalPractice::Hand(Key);
		TestEqual(TEXT("the key is handed in GENEX_LLM_PRACTICE"), FPlatformMisc::GetEnvironmentVariable(FGenexLocalPractice::KeyEnv), Key);
		FGenexLocalPractice::Hand(FString());
		TestTrue(TEXT("and taken away again"), FPlatformMisc::GetEnvironmentVariable(FGenexLocalPractice::KeyEnv).IsEmpty());
		FPlatformMisc::SetEnvironmentVar(FGenexLocalPractice::KeyEnv, *Saved);
	}
	return true;
}
