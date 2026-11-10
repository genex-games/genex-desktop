// Bakes the open Unreal level into a firstperson collision world (PROTOCOL.md §17.7). Editor only: the walk reads
// what blocks the game's chosen collision channel (static meshes and their instances through their simple collision,
// or their triangles when they use complex as simple, and blocking volumes), the engine-free core
// (GenexCollisionBake.h) turns that into boxes and ramps inside MaxErrorCm, and the result lands as a
// UGenexCollisionWorld asset for the client and a world JSON for the room module, with one hash.
//
//   console:     Genex.BakeCollisionWorld [Channel=ECC_Pawn] [MaxErrorCm=5] [Asset=/Game/...] [Json=<file>]
//                                         [MaxBoxesPerActor=1024] [MaxRampsPerActor=128] [BoundsActors=Prop+Wreck:2]
//                                         [-AllowSkipped] [-ComplexWithoutSimple]
//   commandlet:  UnrealEditor-Cmd <project> -run=GenexMultiplayerEditor.GenexBakeCollision -Map=/Game/Maps/MyLevel [the same options]
#pragma once

#include "Commandlets/Commandlet.h"
#include "CoreMinimal.h"
#include "Engine/EngineTypes.h"
#include "GenexCollisionBake.h"

#include <vector>

#include "GenexCollisionBakeEditor.generated.h"

class UGenexCollisionWorld;
class UWorld;

/** What to bake and where it goes. Empty paths default from the map's name. */
struct FGenexBakeRequest
{
	ECollisionChannel Channel = ECC_Pawn;
	double MaxErrorCm = 5.0;
	int32 MaxBoxesPerActor = 1024;
	int32 MaxRampsPerActor = 128;
	/** Actors that become boxes around each element, past MaxErrorCm on purpose: GenexCollisionBake.h's BoundsRule. */
	std::vector<genex::collision_bake::BoundsRule> BoundsActors;
	/** Long package name of the asset; default /Game/Genex/<Map>_CollisionWorld. */
	FString AssetPath;
	/** Default <Project>/Saved/Genex/<Map>.world.json. */
	FString JsonPath;
	/** Write the result even though something that blocks the channel is not in it. */
	bool bAllowSkipped = false;
	/** Bake a mesh's triangles when it has no simple collision. Unreal's own capsule walks through such a mesh, so by
	 *  default it is listed, not baked. */
	bool bComplexWithoutSimple = false;

	/** Reads `Key=Value` and `-Flag` options from a console line or commandlet parameters. False, with Error, on a bad one. */
	static bool Parse(const FString& Line, FGenexBakeRequest& Out, FString& Error);
};

/** What the walk found. */
struct FGenexLevelWalk
{
	std::vector<genex::collision_bake::ActorGeometry> Actors;
	/** Blocks the channel but the core cannot take it (landscape, a spline mesh, BSP, a level set): `Actor.Component (why)`. */
	TArray<FString> NotBaked;
	/** Movable and blocking, so not part of a static world: doors and the like belong to the room module. */
	TArray<FString> Moving;
};

struct FGenexCollisionBaker
{
	static FGenexLevelWalk Walk(UWorld* World, const FGenexBakeRequest& Request);
	/** Fills the asset by the subsystem's own conversion. False, with Error, unless it then hashes to the world. */
	static bool FillAsset(UGenexCollisionWorld& Asset, const genex::FirstpersonWorld& World, FString& Error);
	/** Walks, bakes, logs the report and writes the asset and the JSON. Nothing is written unless all of it held. */
	static bool BakeLevel(UWorld* World, const FGenexBakeRequest& Request, FString& Error);
	/** Creates or loads the asset at this long package name, fills it from `World` and saves it. */
	static bool SaveWorldAsset(const FString& PackageName, const genex::FirstpersonWorld& World, FString& Error);
	/** The level a commandlet's -Map= names, or null with Error: a map that did not load is never the empty start level. */
	static UWorld* LoadLevelForBake(const FString& Params, FString& Error);
};

UCLASS()
class UGenexBakeCollisionCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGenexBakeCollisionCommandlet();
	virtual int32 Main(const FString& Params) override;
};
