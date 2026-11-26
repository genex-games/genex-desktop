#pragma once

#include "CoreMinimal.h"
#include "HAL/CriticalSection.h"

/**
 * The plugin's warnings and errors, kept in a file of the plugin's own.
 *
 * A Shipping build compiles UE_LOG out unless the game's target turns logging on (`bUseLoggingInShipping`), so in the
 * build players get, nothing the plugin logs is kept anywhere: a model call that Genex refused left its code only in
 * the game's own result, and a game that showed a sentence had to be rebuilt to learn the code (2026-11-25). In such
 * a build the module sends every Warning and Error here as well.
 *
 * The file is `Genex.log` in the game's log folder (FPaths::ProjectLogDir()). It starts empty with each run of the
 * game and stops growing at MaxBytes, so it never fills a player's disk. A folder that cannot be written is not an
 * error: the line is dropped. The lines are the plugin's own: no token, no prompt and no answer is ever in one.
 */
class FGenexKeptLog
{
public:
	/** The most the file may hold: enough for thousands of lines. */
	static constexpr int64 DefaultMaxBytes = 256 * 1024;

	explicit FGenexKeptLog(FString InPath, int64 InMaxBytes = DefaultMaxBytes);

	/** `<game's log folder>/Genex.log`. */
	static FString DefaultPath();

	/** Write one line: the UTC time, the level, the text (its line breaks written as spaces). False when it was not
	 *  written: the file is full, or cannot be written. */
	bool Append(const TCHAR* Level, const FString& Text);

private:
	FString Path;
	int64 MaxBytes;
	int64 Written = 0;
	bool bStarted = false;
	bool bClosed = false;
	FCriticalSection Lock;
};
