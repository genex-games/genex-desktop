// Copyright Genex. All Rights Reserved.

#include "GenexChatLibrary.h"

#include "HAL/PlatformProcess.h"
#include "Misc/Base64.h"
#include "Misc/Paths.h"

#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#include "Windows/WindowsPlatformMisc.h"
#endif

namespace
{
	/** The start of the link the Genex app answers for an editor's project. */
	const TCHAR* const GenexLinkStart = TEXT("genex://editor/");
	/** Where a person without Genex is sent; the tag tells the site the visit came from this plugin. */
	const TCHAR* const GetGenexPage = TEXT("https://genex.games/unreal-engine?s=fab-plugin");
}

FString UGenexChatLibrary::ProjectLink()
{
	FString Folder = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	FPaths::NormalizeDirectoryName(Folder);

	const FTCHARToUTF8 Bytes(*Folder);
	FString Code = FBase64::Encode(reinterpret_cast<const uint8*>(Bytes.Get()), Bytes.Length());
	// base64url without padding: the form a link can carry as one path part.
	Code.ReplaceInline(TEXT("+"), TEXT("-"));
	Code.ReplaceInline(TEXT("/"), TEXT("_"));
	Code.ReplaceInline(TEXT("="), TEXT(""));
	return FString(GenexLinkStart) + Code;
}

bool UGenexChatLibrary::IsGenexInstalled()
{
#if PLATFORM_WINDOWS
	FString Command;
	const bool bFound = FWindowsPlatformMisc::QueryRegKey(HKEY_CLASSES_ROOT, TEXT("genex\\shell\\open\\command"), TEXT(""), Command);
	return bFound && !Command.IsEmpty();
#elif PLATFORM_MAC
	SCOPED_AUTORELEASE_POOL;
	NSURL* Link = [NSURL URLWithString:@"genex://editor/"];
	return [[NSWorkspace sharedWorkspace] URLForApplicationToOpenURL:Link] != nil;
#elif PLATFORM_LINUX
	int32 ExitCode = -1;
	FString Handler;
	FString Errors;
	const bool bRan = FPlatformProcess::ExecProcess(TEXT("/usr/bin/xdg-mime"), TEXT("query default x-scheme-handler/genex"), &ExitCode, &Handler, &Errors);
	return bRan && ExitCode == 0 && !Handler.TrimStartAndEnd().IsEmpty();
#else
	return true;
#endif
}

void UGenexChatLibrary::OpenChat()
{
	const FString Link = IsGenexInstalled() ? ProjectLink() : FString(GetGenexPage);
	FPlatformProcess::LaunchURL(*Link, nullptr, nullptr);
}
