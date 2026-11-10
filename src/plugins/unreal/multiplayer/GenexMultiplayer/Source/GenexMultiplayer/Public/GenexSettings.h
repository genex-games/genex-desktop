// Project settings for Genex multiplayer (Project Settings > Plugins > Genex Multiplayer), stored
// in Config/DefaultGame.ini under [/Script/GenexMultiplayer.GenexSettings]. A launcher's
// environment wins over them: GENEX_API_URL replaces ApiUrl, GENEX_AUTHORITY_URL names a local
// authority server when the game names none (Studio sets it for PIE), GENEX_EMBED_TICKET signs
// the player in (read once, then removed).
//
// QUOTE URLs in the ini: `ApiUrl="https://api.genex.games"`. Unreal's config parser cuts an unquoted
// value at "//" (ApiUrl=http://127.0.0.1:9 reads as "http:"); the editor's settings panel quotes them.
#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "GenexSettings.generated.h"

UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "Genex Multiplayer"))
class GENEXMULTIPLAYER_API UGenexSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UGenexSettings();

	/** The game's Genex slug (gameId): the room key every player of this game meets in. */
	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Genex")
	FString Slug;

	/** The Genex API the sign-in doors talk to. GENEX_API_URL replaces it when a launcher sets it. */
	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Genex")
	FString ApiUrl = TEXT("https://api.genex.games");

	/** Relay URLs to use when no sign-in answer named any (development against a local relay). */
	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Genex|Development")
	TArray<FString> RelayUrls;

	/** An authority server to use when no sign-in answer and no GENEX_AUTHORITY_URL named one. */
	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Genex|Development")
	FString AuthorityUrl;

	/** Unreal units per Genex world unit. Genex rooms measure in metres; Unreal in centimetres. */
	UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Genex", meta = (ClampMin = "0.0001"))
	float UnitsPerMeter = 100.f;

	/** The API base to use now: GENEX_API_URL when a launcher set it, else ApiUrl. */
	FString EffectiveApiUrl() const;

	virtual FName GetCategoryName() const override { return TEXT("Plugins"); }
};
