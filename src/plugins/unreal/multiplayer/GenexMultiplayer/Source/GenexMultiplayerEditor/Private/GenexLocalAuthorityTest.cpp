// Genex.Multiplayer.LocalAuthority: the rows of Studio's Unity test (genex-desktop
// tests/conformance/unity-authority-play.test.ts), on this port. Each row builds a game folder
// (studio.json) holding an Unreal project somewhere below it and a .studio/authority.json, and
// asks Find() for the project; one port has a listener, one is closed.
#include "GenexLocalAuthority.h"

#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "IPAddress.h"
#include "Misc/AutomationTest.h"
#include "Misc/FileHelper.h"
#include "Misc/Guid.h"
#include "Misc/Paths.h"
#include "SocketSubsystem.h"
#include "Sockets.h"

#if !PLATFORM_WINDOWS
#include <unistd.h>
#endif

namespace GenexLocalAuthorityTest
{
struct FListener
{
	FSocket* Socket = nullptr;
	int32 Port = 0;
	FListener()
	{
		ISocketSubsystem* Sockets = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
		Socket = Sockets->CreateSocket(NAME_Stream, TEXT("GenexLocalAuthorityTest"), false);
		TSharedRef<FInternetAddr> Address = Sockets->CreateInternetAddr();
		bool bValid = false;
		Address->SetIp(TEXT("127.0.0.1"), bValid);
		Address->SetPort(0);
		Socket->Bind(*Address);
		Socket->Listen(8);
		Port = Socket->GetPortNo();
	}
	~FListener()
	{
		Socket->Close();
		ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(Socket);
	}
};

/** A free port nothing listens on (bound, read, released). */
int32 ClosedPort()
{
	FListener Probe;
	return Probe.Port;
}

/** A game folder `Name` under `Base` with studio.json, the Unreal project at `ProjectSub`, and the handoff text (none when unset). */
FString GameWith(const FString& Base, const FString& Name, const TOptional<FString>& Handoff, const FString& ProjectSub = TEXT("unreal"))
{
	const FString Game = FPaths::Combine(Base, Name);
	IFileManager::Get().MakeDirectory(*Game, true);
	FFileHelper::SaveStringToFile(TEXT("{}"), *FPaths::Combine(Game, TEXT("studio.json")));
	const FString Project = ProjectSub == TEXT(".") ? Game : FPaths::Combine(Game, ProjectSub);
	IFileManager::Get().MakeDirectory(*Project, true);
	if (Handoff.IsSet())
	{
		IFileManager::Get().MakeDirectory(*FPaths::Combine(Game, TEXT(".studio")), true);
		FFileHelper::SaveStringToFile(Handoff.GetValue(), *FPaths::Combine(Game, TEXT(".studio"), TEXT("authority.json")), FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
	}
	return Project;
}

bool MakeLink(const FString& Target, const FString& Link)
{
#if PLATFORM_WINDOWS
	return false; // symlinks need a privilege on Windows; the link rows run on Mac/Linux.
#else
	return ::symlink(TCHAR_TO_UTF8(*Target), TCHAR_TO_UTF8(*Link)) == 0;
#endif
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexLocalAuthorityTest, "Genex.Multiplayer.LocalAuthority",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexLocalAuthorityTest::RunTest(const FString&)
{
	using namespace GenexLocalAuthorityTest;
	const FString Base = FPaths::Combine(FPaths::AutomationTransientDir(), TEXT("GenexLocalAuthority"), FGuid::NewGuid().ToString());
	FListener Open;
	const int32 Closed = ClosedPort();
	const FString Url = FString::Printf(TEXT("ws://127.0.0.1:%d"), Open.Port);
	const FString Named = FString::Printf(TEXT("{\"url\":\"%s\"}"), *Url);
	auto Json = [](const FString& U) { return FString::Printf(TEXT("{\"url\":\"%s\"}"), *U); };
	const FString Outside = FPaths::Combine(Base, TEXT("outside"));
	IFileManager::Get().MakeDirectory(*Outside, true);
	FFileHelper::SaveStringToFile(Named, *FPaths::Combine(Outside, TEXT("authority.json")));

	struct FRow { FString Name; FString Project; FString Want; };
	TArray<FRow> Rows = {
		{ TEXT("the game's running server, project in unreal/"), GameWith(Base, TEXT("running"), Named + TEXT("\n")), Url },
		{ TEXT("a project at the game's root"), GameWith(Base, TEXT("root"), Named, TEXT(".")), Url },
		{ TEXT("a project three folders down"), GameWith(Base, TEXT("deep"), Named, TEXT("a/b/unreal")), Url },
		{ TEXT("a project four folders down"), GameWith(Base, TEXT("deeper"), Named, TEXT("a/b/c/unreal")), FString() },
		{ TEXT("no server named"), GameWith(Base, TEXT("none"), TOptional<FString>()), FString() },
		{ TEXT("a port nothing listens on"), GameWith(Base, TEXT("closed"), Json(FString::Printf(TEXT("ws://127.0.0.1:%d"), Closed))), FString() },
		{ TEXT("localhost by name"), GameWith(Base, TEXT("localhost"), Json(FString::Printf(TEXT("ws://localhost:%d"), Open.Port))), FString() },
		{ TEXT("another host"), GameWith(Base, TEXT("host"), Json(FString::Printf(TEXT("ws://10.0.0.7:%d"), Open.Port))), FString() },
		{ TEXT("TLS"), GameWith(Base, TEXT("tls"), Json(FString::Printf(TEXT("wss://127.0.0.1:%d"), Open.Port))), FString() },
		{ TEXT("a path"), GameWith(Base, TEXT("path"), Json(Url + TEXT("/room"))), FString() },
		{ TEXT("a privileged port"), GameWith(Base, TEXT("low"), Json(TEXT("ws://127.0.0.1:80"))), FString() },
		{ TEXT("a port past the last"), GameWith(Base, TEXT("high"), Json(TEXT("ws://127.0.0.1:70000"))), FString() },
		{ TEXT("another key beside it"), GameWith(Base, TEXT("extra"), FString::Printf(TEXT("{\"url\":\"%s\",\"more\":1}"), *Url)), FString() },
		{ TEXT("two addresses"), GameWith(Base, TEXT("two"), Named + Named), FString() },
		{ TEXT("not JSON"), GameWith(Base, TEXT("text"), Url), FString() },
		{ TEXT("an oversized file"), GameWith(Base, TEXT("big"), Named + FString::ChrN(2048, ' ')), FString() },
	};
#if !PLATFORM_WINDOWS
	const FString LinkedFolder = GameWith(Base, TEXT("linked-folder"), TOptional<FString>());
	TestTrue(TEXT("made the linked .studio/"), MakeLink(Outside, FPaths::Combine(FPaths::GetPath(LinkedFolder), TEXT(".studio"))));
	Rows.Add({ TEXT("a linked .studio/"), LinkedFolder, FString() });
	const FString LinkedFile = GameWith(Base, TEXT("linked-file"), TOptional<FString>());
	IFileManager::Get().MakeDirectory(*FPaths::Combine(FPaths::GetPath(LinkedFile), TEXT(".studio")), true);
	TestTrue(TEXT("made the linked authority.json"), MakeLink(FPaths::Combine(Outside, TEXT("authority.json")), FPaths::Combine(FPaths::GetPath(LinkedFile), TEXT(".studio"), TEXT("authority.json"))));
	Rows.Add({ TEXT("a linked authority.json"), LinkedFile, FString() });
#endif
	const FString NotGame = FPaths::Combine(Base, TEXT("not-a-game"), TEXT("unreal"));
	IFileManager::Get().MakeDirectory(*NotGame, true);
	Rows.Add({ TEXT("no game"), NotGame, FString() });

	for (const FRow& Row : Rows) TestEqual(Row.Name, FGenexLocalAuthority::Find(Row.Project), Row.Want);

	// Parse alone: the shapes Studio writes and the near misses.
	TestEqual(TEXT("parse: spaces around"), FGenexLocalAuthority::Parse(TEXT("  { \"url\" : \"ws://127.0.0.1:2567\" }  \n")), FString(TEXT("ws://127.0.0.1:2567")));
	TestEqual(TEXT("parse: leading zero port"), FGenexLocalAuthority::Parse(TEXT("{\"url\":\"ws://127.0.0.1:02567\"}")), FString());
	TestEqual(TEXT("parse: three digits"), FGenexLocalAuthority::Parse(TEXT("{\"url\":\"ws://127.0.0.1:999\"}")), FString());
	TestEqual(TEXT("parse: six digits"), FGenexLocalAuthority::Parse(TEXT("{\"url\":\"ws://127.0.0.1:100000\"}")), FString());
	TestEqual(TEXT("parse: userinfo"), FGenexLocalAuthority::Parse(TEXT("{\"url\":\"ws://x@127.0.0.1:2567\"}")), FString());
	TestEqual(TEXT("parse: empty"), FGenexLocalAuthority::Parse(FString()), FString());
	IFileManager::Get().DeleteDirectory(*Base, false, true);
	return true;
}
