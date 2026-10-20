// The words and shapes of Genex play-time AI as an Unreal game sees them. The string values are the
// wire's own (docs/play-protocol.md in Genex): never rename one.
#pragma once

#include "CoreMinimal.h"
#include "GenexAiTypes.generated.h"

/** The wire's words, by name. */
namespace GenexAiWords
{
	inline const TCHAR* Fast = TEXT("fast");
	inline const TCHAR* Smart = TEXT("smart");
	inline const TCHAR* Local = TEXT("local");
	inline const TCHAR* Shared = TEXT("shared");
	inline const TCHAR* RequiresAi = TEXT("ai");
	inline const TCHAR* RequiresOptional = TEXT("optional");
	inline const TCHAR* CodeOff = TEXT("ai_off");
	inline const TCHAR* CodeConcurrency = TEXT("grant_concurrency");
	inline const TCHAR* CodeInvalidSchema = TEXT("invalid_schema");
	inline const TCHAR* CodeProvider = TEXT("provider");
}

/** What a call may say besides its site, prompt and shape. */
USTRUCT(BlueprintType)
struct GENEXAI_API FGenexAiOptions
{
	GENERATED_BODY()

	/** Static, cacheable text: the world, the rules, a persona. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	FString System;

	/** Player-typed text by name; every model sees it fenced as player text, never as instructions. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	TMap<FString, FString> Untrusted;

	/** What the game remembers for this call, as text. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	FString Memory;

	/** "fast" or "smart". */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	FString Tier = TEXT("fast");

	/** "local" (this player) or "shared" (every player: a leaderboard, shared state). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	FString Authority = TEXT("local");

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	int32 MaxOutputTokens = 512;

	/** What a failed result carries as its value (JSON), so the game plays on; empty for none. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex AI")
	FString FallbackJson;
};

/** One call's result, as Drain() hands it to the game. */
USTRUCT(BlueprintType)
struct GENEXAI_API FGenexAiResult
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	FString Ticket;

	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	FString Site;

	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	bool bOk = false;

	/** The answer as JSON; on a failure, the call's fallback (or empty). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	FString ValueJson;

	/** Empty on an answer; else why there is none ("ai_off", "grant_concurrency", the host's own codes). */
	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	FString Code;

	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	FString Source;

	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	FString Provenance;

	/** The value is the call's fallback. */
	UPROPERTY(BlueprintReadOnly, Category = "Genex AI")
	bool bUsedFallback = false;
};
