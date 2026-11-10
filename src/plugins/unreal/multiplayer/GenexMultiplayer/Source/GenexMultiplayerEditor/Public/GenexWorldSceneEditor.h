// A level through the shared fit: the walk writes the engine-neutral scene (packages/multiplayer/WORLD-SCENE.md), `genex
// world fit` turns it into a world from what a hull can reach, and the world lands as the same UGenexCollisionWorld asset and
// room module JSON as the direct bake (GenexCollisionBakeEditor.h), with one hash. Editor only.
//
//   console:     Genex.FitCollisionWorld     [options]   the open level, start to finish
//                Genex.ExportWorldScene      [options]   only the scene
//                Genex.ImportCollisionWorld  World=<file> Asset=/Game/...   a fit's world into its asset
//   commandlet:  UnrealEditor-Cmd <project> -run=GenexMultiplayerEditor.GenexFitCollision -Map=/Game/Maps/MyLevel [options]
//                                           -run=GenexMultiplayerEditor.GenexExportWorldScene -Map=/Game/Maps/MyLevel [options]
//                                           -run=GenexMultiplayerEditor.GenexImportCollisionWorld World=<file> Asset=/Game/...
//
//   options:     Channel=ECC_Pawn ShotChannel=ECC_Visibility Scene=<file> World=<file> Asset=/Game/... GenexCli=<path>
//                Hull=radius,height,crouchHeight,step,jump,leap Spawn=x,y,z+x,y,z FitArgs="..."
//                -AllowSkipped -ComplexWithoutSimple -NoShotTriangles
#pragma once

#include "Commandlets/Commandlet.h"
#include "CoreMinimal.h"
#include "Engine/EngineTypes.h"
#include "GenexWorldScene.h"

#include <vector>

#include "GenexWorldSceneEditor.generated.h"

class UWorld;

/** What to walk and where it goes. Empty paths default from the map's name. */
struct FGenexSceneRequest
{
	/** What stops a hull: the game's character channel. */
	ECollisionChannel MoveChannel = ECC_Pawn;
	/** What stops a bullet: the game's weapon trace channel. */
	ECollisionChannel ShotChannel = ECC_Visibility;
	/** Default <Project>/Saved/Genex/<Map>.scene.json. */
	FString ScenePath;
	/** Default <Project>/Saved/Genex/<Map>.world.json. */
	FString WorldPath;
	/** Long package name; default /Game/Genex/<Map>_CollisionWorld. */
	FString AssetPath;
	/** How to run the fit; default `genex` on the PATH. */
	FString GenexCli;
	/** More arguments for `genex world fit`. */
	FString FitArgs;
	/** Write the scene without what cannot go in it. */
	bool bAllowSkipped = false;
	/** A mesh with no simple collision stops a hull too. Unreal's own capsule walks through such a mesh, so by default only
	 *  a bullet stops on it. */
	bool bComplexWithoutSimple = false;
	/** Write each mesh's triangles for the shot world. Without them a bullet's surface is the simple collision. */
	bool bShotTriangles = true;
	/** The room's hull in room units. Unset, it is read from the level's default pawn. */
	bool bHasHull = false;
	genex::world_scene::HullSize Hull;
	/** More places to start, engine units, feet. A level's PlayerStarts are always spawns. */
	TArray<FVector> Spawns;

	/** Reads `Key=Value` and `-Flag` options from a console line or commandlet parameters. False, with Error, on a bad one. */
	static bool Parse(const FString& Line, FGenexSceneRequest& Out, FString& Error);
};

/** What the walk found: the scene's input, and what it could not read. */
struct FGenexSceneWalk
{
	genex::world_scene::SceneInput Input;
	/** Blocks a channel but cannot go in a scene (a level set, an unloaded sublevel): `Actor.Component (why)`. */
	TArray<FString> NotWritten;
	/** Blocks the move channel and Unreal's own capsule walks through it: named, written only for bullets. */
	TArray<FString> NoSimpleCollision;
	/** Where the hull came from, for the log. */
	FString HullFrom;
};

struct FGenexWorldSceneExporter
{
	static FGenexSceneWalk Walk(UWorld* World, const FGenexSceneRequest& Request);
	/** Walks, reports and writes the scene to OutPath. Nothing is written unless all of it held. */
	static bool ExportLevel(UWorld* World, const FGenexSceneRequest& Request, FString& OutPath, FString& Error);
	/** A world JSON (a fit's, or anyone's) into the asset, by the subsystem's own conversion. False, with Error, unless the
	 *  saved asset hashes to the JSON. OutHash is what the room's module will hash to. */
	static bool ImportWorld(const FString& WorldPath, const FString& AssetPath, uint32& OutHash, FString& Error);
	/** The whole way: the scene, `genex world fit`, the asset. On a refusal Error holds the fit's own words, which name actors. */
	static bool FitLevel(UWorld* World, const FGenexSceneRequest& Request, FString& Error);
};

UCLASS()
class UGenexExportWorldSceneCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGenexExportWorldSceneCommandlet();
	virtual int32 Main(const FString& Params) override;
};

UCLASS()
class UGenexImportCollisionWorldCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGenexImportCollisionWorldCommandlet();
	virtual int32 Main(const FString& Params) override;
};

UCLASS()
class UGenexFitCollisionCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGenexFitCollisionCommandlet();
	virtual int32 Main(const FString& Params) override;
};
