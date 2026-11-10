#include "GenexLocalAuthority.h"

#include "HAL/FileManager.h"
#include "HAL/PlatformFileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "SocketSubsystem.h"
#include "Sockets.h"
#include "IPAddress.h"

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
#include <windows.h>
#include "Windows/HideWindowsPlatformTypes.h"
#else
#include <sys/stat.h>
#endif

const TCHAR* FGenexLocalAuthority::UrlEnv = TEXT("GENEX_AUTHORITY_URL");
const TCHAR* FGenexLocalAuthority::HandoffFolder = TEXT(".studio");
const TCHAR* FGenexLocalAuthority::HandoffName = TEXT("authority.json");
const TCHAR* FGenexLocalAuthority::GameMarker = TEXT("studio.json");

void FGenexAuthorityUrlHandoff::Name(const FString& Url)
{
	// Only the first Name remembers: a second one would remember our own address as the developer's.
	if (!bNamed) Previous = FPlatformMisc::GetEnvironmentVariable(FGenexLocalAuthority::UrlEnv);
	FPlatformMisc::SetEnvironmentVar(FGenexLocalAuthority::UrlEnv, *Url);
	bNamed = true;
}

void FGenexAuthorityUrlHandoff::TakeBack()
{
	if (!bNamed) return;
	FPlatformMisc::SetEnvironmentVar(FGenexLocalAuthority::UrlEnv, *Previous);
	Previous.Reset();
	bNamed = false;
}

FString FGenexLocalAuthority::GameFolder(const FString& Project)
{
	FString Folder = FPaths::ConvertRelativePathToFull(Project);
	FPaths::NormalizeDirectoryName(Folder);
	for (int32 Level = 0; Level <= MaxLevels && !Folder.IsEmpty(); ++Level)
	{
		if (FPaths::FileExists(FPaths::Combine(Folder, GameMarker))) return Folder;
		const FString Parent = FPaths::GetPath(Folder);
		if (Parent == Folder) break;
		Folder = Parent;
	}
	return FString();
}

namespace GenexLocalAuthorityParse
{
// ASCII whitespace, as the handoff is written; .NET's \s also takes Unicode spaces, which a file
// Studio wrote never holds, so refusing them is only stricter.
bool IsSpace(TCHAR C) { return C == ' ' || C == '\t' || C == '\n' || C == '\r' || C == '\f' || C == '\v'; }
void SkipSpace(const FString& S, int32& I) { while (I < S.Len() && IsSpace(S[I])) ++I; }
bool Expect(const FString& S, int32& I, const TCHAR* Literal)
{
	const int32 N = FCString::Strlen(Literal);
	if (I + N > S.Len() || FCString::Strncmp(*S + I, Literal, N) != 0) return false;
	I += N;
	return true;
}
}

FString FGenexLocalAuthority::Parse(const FString& Text)
{
	// ^\s*\{\s*"url"\s*:\s*"(ws://127\.0\.0\.1:([1-9][0-9]{3,4}))"\s*\}\s*$, then the port range.
	using namespace GenexLocalAuthorityParse;
	int32 I = 0;
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("{"))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("\"url\""))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT(":"))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("\""))) return FString();
	const int32 UrlStart = I;
	if (!Expect(Text, I, TEXT("ws://127.0.0.1:"))) return FString();
	const int32 PortStart = I;
	while (I < Text.Len() && FChar::IsDigit(Text[I])) ++I;
	const int32 Digits = I - PortStart;
	if (Digits < 4 || Digits > 5 || Text[PortStart] == '0') return FString();
	const FString Url = Text.Mid(UrlStart, I - UrlStart);
	const int32 Port = FCString::Atoi(*Text.Mid(PortStart, Digits));
	if (!Expect(Text, I, TEXT("\""))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("}"))) return FString();
	SkipSpace(Text, I);
	if (I != Text.Len()) return FString();
	return Port >= MinPort && Port <= MaxPort ? Url : FString();
}

bool FGenexLocalAuthority::IsLink(const FString& Path)
{
#if PLATFORM_WINDOWS
	const DWORD Attributes = ::GetFileAttributesW(*Path);
	return Attributes != INVALID_FILE_ATTRIBUTES && (Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
#else
	struct stat Info;
	return ::lstat(TCHAR_TO_UTF8(*Path), &Info) == 0 && S_ISLNK(Info.st_mode);
#endif
}

namespace GenexLocalAuthorityRead
{
/** The handoff's text, when it is a small plain file in a plain folder of the game; empty otherwise. */
bool ReadHandoff(const FString& Game, FString& Out)
{
	const FString Folder = FPaths::Combine(Game, FGenexLocalAuthority::HandoffFolder);
	if (!FPaths::DirectoryExists(Folder) || FGenexLocalAuthority::IsLink(Folder)) return false;
	const FString File = FPaths::Combine(Folder, FGenexLocalAuthority::HandoffName);
	if (!FPaths::FileExists(File) || FGenexLocalAuthority::IsLink(File)) return false;
	const int64 Size = IFileManager::Get().FileSize(*File);
	if (Size < 0 || Size > FGenexLocalAuthority::MaxHandoffBytes) return false;
	return FFileHelper::LoadFileToString(Out, *File);
}
}

FString FGenexLocalAuthority::Find(const FString& Project, TFunction<bool(int32)> AnswersFn)
{
	const FString Game = GameFolder(Project);
	if (Game.IsEmpty()) return FString();
	FString Text;
	if (!GenexLocalAuthorityRead::ReadHandoff(Game, Text)) return FString();
	const FString Url = Parse(Text);
	if (Url.IsEmpty()) return FString();
	FString PortText;
	Url.Split(TEXT(":"), nullptr, &PortText, ESearchCase::CaseSensitive, ESearchDir::FromEnd);
	const int32 Port = FCString::Atoi(*PortText);
	const bool bAnswers = AnswersFn ? AnswersFn(Port) : Answers(Port);
	return bAnswers ? Url : FString();
}

bool FGenexLocalAuthority::Answers(int32 Port)
{
	ISocketSubsystem* Sockets = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
	if (!Sockets) return false;
	FSocket* Socket = Sockets->CreateSocket(NAME_Stream, TEXT("GenexLocalAuthorityProbe"), false);
	if (!Socket) return false;
	TSharedRef<FInternetAddr> Address = Sockets->CreateInternetAddr();
	bool bValid = false;
	Address->SetIp(TEXT("127.0.0.1"), bValid);
	Address->SetPort(Port);
	bool bConnected = false;
	if (bValid && Socket->SetNonBlocking(true))
	{
		Socket->Connect(*Address);
		// Writable within the probe window = the connection completed; an error state is a refusal.
		if (Socket->Wait(ESocketWaitConditions::WaitForWrite, FTimespan::FromMilliseconds(ProbeMs)))
		{
			bConnected = Socket->GetConnectionState() == SCS_Connected;
		}
	}
	Socket->Close();
	Sockets->DestroySocket(Socket);
	return bConnected;
}
