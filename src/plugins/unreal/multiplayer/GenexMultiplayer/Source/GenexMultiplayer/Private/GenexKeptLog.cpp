#include "GenexKeptLog.h"

#include "HAL/FileManager.h"
#include "Misc/DateTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Misc/ScopeLock.h"

FGenexKeptLog::FGenexKeptLog(FString InPath, int64 InMaxBytes) : Path(MoveTemp(InPath)), MaxBytes(InMaxBytes) {}

FString FGenexKeptLog::DefaultPath() { return FPaths::Combine(FPaths::ProjectLogDir(), TEXT("Genex.log")); }

bool FGenexKeptLog::Append(const TCHAR* Level, const FString& Text)
{
	FScopeLock Scope(&Lock);
	if (bClosed) return false;
	FString OneLine = Text;
	OneLine.ReplaceInline(TEXT("\r"), TEXT(" "));
	OneLine.ReplaceInline(TEXT("\n"), TEXT(" "));
	const FString Line = FString::Printf(TEXT("%s %s %s\n"), *FDateTime::UtcNow().ToIso8601(), Level, *OneLine);
	const int64 Size = static_cast<int64>(FTCHARToUTF8(*Line).Length());
	if (Written + Size > MaxBytes)
	{
		// Full: nothing more this run, not even a shorter line, so the file reads as an unbroken beginning.
		bClosed = true;
		return false;
	}
	// The first line of a run replaces the last run's file; every later one is added to it.
	const uint32 Flags = bStarted ? FILEWRITE_Append : FILEWRITE_None;
	if (!FFileHelper::SaveStringToFile(Line, *Path, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM, &IFileManager::Get(), Flags))
	{
		// A folder this build may not write (a read-only install, a sandbox): give up quietly.
		bClosed = true;
		return false;
	}
	bStarted = true;
	Written += Size;
	return true;
}
