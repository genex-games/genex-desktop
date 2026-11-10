// A firstperson collision world as an asset (PROTOCOL.md §17.7): the boxes and ramps the room module
// exports beside its config, laid out in Unreal units so a level designer can author them, handed to
// UGenexAuthoritySubsystem::SetWorldFromAsset (or FGenexAuthorityOptions::World). Your own entity is
// predicted only while this world's hash is the room's `params.world`, so it must hold the module's
// world value for value: Unreal units here are Genex units times UGenexSettings::UnitsPerMeter (Genex
// x/y/z as Unreal X/Y/Z, both z-up), and converting back divides and rounds to float32, which recovers
// every float32 Genex value exactly. Create one from the module's JSON with FromWorldJson (or the
// asset's Import World Json button in the editor).
#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "GenexTypes.h"
#include "GenexCollisionWorld.generated.h"

UCLASS(BlueprintType)
class GENEXMULTIPLAYER_API UGenexCollisionWorld : public UDataAsset
{
	GENERATED_BODY()

public:
	/** Solids are indexed boxes first, then ramps, in this order: the order is part of the hash. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") TArray<FGenexWorldBox> Boxes;
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Genex") TArray<FGenexWorldRamp> Ramps;
	/** A room module's world as JSON (`{ boxes: [[6 numbers]…], ramps: [[9 numbers]…] }`, Genex units):
	 *  ImportWorldJson fills Boxes and Ramps from it. */
	UPROPERTY(EditAnywhere, Category = "Genex", meta = (MultiLine = "true")) FString WorldJson;

	/** Fill Boxes and Ramps from `Json` (a room module's world, Genex units). False, with Error, when
	 *  §17.7 refuses it (nothing changes). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Firstperson")
	bool SetFromWorldJson(const FString& Json, FString& Error);
	/** Fill Boxes and Ramps from the WorldJson property. */
	UFUNCTION(CallInEditor, Category = "Genex")
	void ImportWorldJson();
	/** The world's §17.7 hash, or -1 (with Error) when it is refused. */
	UFUNCTION(BlueprintPure, Category = "Genex|Firstperson")
	int64 GetWorldHash(FString& Error) const;
	/** A transient asset holding `Json` (Genex units), or null when §17.7 refuses it. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Firstperson")
	static UGenexCollisionWorld* FromWorldJson(const FString& Json, FString& Error);
};
