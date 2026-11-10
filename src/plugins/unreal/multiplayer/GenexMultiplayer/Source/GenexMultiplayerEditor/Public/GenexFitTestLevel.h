// A small original level with a bit of everything a level's collision can be made of, built by code so the repository holds
// no map: a Landscape, BSP with a door, a spline mesh wall, instanced pillars, turned and ramped static meshes, a blocking
// volume, a clip wall, a screen only bullets stop on, a movable door, and PlayerStarts. Genex.Multiplayer.WorldScene walks
// it; sdks/unreal/Tests/WorldFitLab saves it as a map and plays it through the fit. Editor only.
#pragma once

#include "Commandlets/Commandlet.h"
#include "CoreMinimal.h"

#include "GenexFitTestLevel.generated.h"

class UWorld;

struct FGenexFitTestLevel
{
	/** Landscape components on a side, and quads a component. */
	static constexpr int32 ComponentsPerSide = 2;
	static constexpr int32 QuadsPerComponent = 63;
	/** Centimetres a quad. */
	static constexpr double QuadCm = 40.0;

	/** The ground's height at a point, centimetres: flat around the middle, rolling hills beyond it. */
	static double GroundCm(double X, double Y);
	/** Adds just the landscape. */
	static void AddLandscape(UWorld* World);
	/** Adds everything else. BSP needs the editor's current world. */
	static void AddLevelActors(UWorld* World);
	static void AddPlayerStarts(UWorld* World);
	/** Builds the level's BSP from its brushes: the world must be the editor's. */
	static void AddBsp(UWorld* World);
};

/** -run=GenexMultiplayerEditor.GenexMakeFitTestLevel -Map=/Game/GenexFitLab/Hillside [-Only=Landscape|Empty|Huge] */
UCLASS()
class UGenexMakeFitTestLevelCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UGenexMakeFitTestLevelCommandlet();
	virtual int32 Main(const FString& Params) override;
};
