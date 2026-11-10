// The scene walk on a real world: everything the audit found missing goes in with its channels, the moving goes in tagged,
// the direct bake still names what it cannot read, and the writer's file is one the shared reader's rules hold.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Engine/World.h"
#include "EngineUtils.h"
#include "GenexCollisionBakeEditor.h"
#include "GenexCollisionWorld.h"
#include "GenexFitTestLevel.h"
#include "GenexSettings.h"
#include "GenexWorldSceneEditor.h"
#include "Landscape.h"
#include "Tests/AutomationEditorCommon.h"

namespace GenexWorldSceneTest
{
using genex::world_scene::SceneActor;
using genex::world_scene::Surface;
using genex::world_scene::SurfaceKind;

const SceneActor* Find(const FGenexSceneWalk& Walked, const char* Name)
{
	for (const SceneActor& Actor : Walked.Input.actors)
	{
		if (Actor.name == Name) return &Actor;
	}
	return nullptr;
}

int32 CountKind(const SceneActor& Actor, SurfaceKind Kind)
{
	int32 Count = 0;
	for (const Surface& Each : Actor.surfaces) Count += Each.kind == Kind ? 1 : 0;
	return Count;
}
} // namespace GenexWorldSceneTest

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexWorldSceneWalkTest, "Genex.Multiplayer.WorldScene",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ProductFilter)

bool FGenexWorldSceneWalkTest::RunTest(const FString&)
{
	using namespace GenexWorldSceneTest;
	UWorld* World = FAutomationEditorCommonUtils::CreateNewMap();
	if (!TestNotNull(TEXT("a new map opens"), World)) return false;

	FGenexSceneRequest Parsed;
	FString ParseError;
	TestTrue(TEXT("the options read"), FGenexSceneRequest::Parse(TEXT("Channel=ECC_Pawn ShotChannel=ECC_Visibility Hull=0.4,1.84,1.16,0.45,1.4,6.9 Spawn=1,2,3+4,5,6 -NoShotTriangles"), Parsed, ParseError));
	TestTrue(TEXT("Hull= reaches the request"), Parsed.bHasHull && Parsed.Hull.height > 0.0);
	TestEqual(TEXT("Spawn= reaches the request"), Parsed.Spawns.Num(), 2);
	TestFalse(TEXT("-NoShotTriangles reaches the request"), Parsed.bShotTriangles);
	FGenexSceneRequest Refused;
	TestFalse(TEXT("a bad channel stops it"), FGenexSceneRequest::Parse(TEXT("ShotChannel=ECC_Nothing"), Refused, ParseError));
	TestFalse(TEXT("a short hull stops it"), FGenexSceneRequest::Parse(TEXT("Hull=1,2,3"), Refused, ParseError));
	TestFalse(TEXT("a bad spawn stops it"), FGenexSceneRequest::Parse(TEXT("Spawn=1,2"), Refused, ParseError));

	// A level with nothing in it: refused, and no spawn would change that.
	FGenexSceneRequest Request;
	const FGenexSceneWalk Empty = FGenexWorldSceneExporter::Walk(World, Request);
	const genex::world_scene::ExportResult EmptyResult = genex::world_scene::Export(Empty.Input, genex::world_scene::ExportOptions{});
	TestTrue(TEXT("an empty level is refused"), EmptyResult.report.status != genex::world_scene::ExportStatus::Ok && EmptyResult.text.empty());

	FGenexFitTestLevel::AddLandscape(World);
	const FGenexSceneWalk OnlyLandscape = FGenexWorldSceneExporter::Walk(World, Request);
	const SceneActor* Hills = Find(OnlyLandscape, "Hills");
	if (!TestNotNull(TEXT("the landscape is an actor by its label"), Hills)) return false;
	const int32 Components = FGenexFitTestLevel::ComponentsPerSide * FGenexFitTestLevel::ComponentsPerSide;
	TestEqual(TEXT("a heightfield per landscape component"), CountKind(*Hills, SurfaceKind::Heightfield), Components);
	const Surface& Field = Hills->surfaces.front();
	TestEqual(TEXT("its samples"), Field.cols, FGenexFitTestLevel::QuadsPerComponent + 1);
	TestEqual(TEXT("its cell is the landscape's scale"), Field.cellX, FGenexFitTestLevel::QuadCm);
	bool bHeightsRight = true;
	for (const Surface& Each : Hills->surfaces)
	{
		for (int32 Row = 0; Row < Each.rows; Row += 13)
		{
			for (int32 Col = 0; Col < Each.cols; Col += 13)
			{
				const double Want = FGenexFitTestLevel::GroundCm(Each.originX + Col * Each.cellX, Each.originY + Row * Each.cellY);
				const double Got = Each.heights[static_cast<std::size_t>(Row * Each.cols + Col)];
				// A landscape sample is 100/128 cm here.
				bHeightsRight = bHeightsRight && FMath::Abs(Want - Got) <= 1.0;
			}
		}
	}
	TestTrue(TEXT("its heights are the ground, in place, row by row"), bHeightsRight);
	const genex::world_scene::ExportResult NoStart = genex::world_scene::Export(OnlyLandscape.Input, genex::world_scene::ExportOptions{});
	TestTrue(TEXT("a level of only landscape and no spawn is refused for the spawn"), NoStart.report.status == genex::world_scene::ExportStatus::NoSpawns);
	genex::world_scene::SceneInput WithSpawn = OnlyLandscape.Input;
	WithSpawn.spawns.push_back(genex::world_scene::SceneSpawn{{0.0, 0.0, 0.0}, "Start", {}});
	TestTrue(TEXT("with a spawn it writes"), genex::world_scene::Export(WithSpawn, genex::world_scene::ExportOptions{}).report.status == genex::world_scene::ExportStatus::Ok);

	// A landscape turned off the world's axes is no heightfield: its quads go as triangles, in place.
	ALandscape* Landscape = nullptr;
	for (TActorIterator<ALandscape> It(World); It; ++It) Landscape = *It;
	if (!TestNotNull(TEXT("the landscape is there"), Landscape)) return false;
	Landscape->SetActorRotation(FRotator(0.f, 30.f, 0.f));
	const FGenexSceneWalk Turned = FGenexWorldSceneExporter::Walk(World, Request);
	const SceneActor* TurnedHills = Find(Turned, "Hills");
	if (TestNotNull(TEXT("the turned landscape is in the scene"), TurnedHills))
	{
		TestEqual(TEXT("a mesh per component"), CountKind(*TurnedHills, SurfaceKind::Mesh), Components);
		TestEqual(TEXT("and no heightfield"), CountKind(*TurnedHills, SurfaceKind::Heightfield), 0);
	}
	Landscape->SetActorRotation(FRotator::ZeroRotator);

	FGenexFitTestLevel::AddBsp(World);
	FGenexFitTestLevel::AddLevelActors(World);
	FGenexFitTestLevel::AddPlayerStarts(World);
	const FGenexSceneWalk Walked = FGenexWorldSceneExporter::Walk(World, Request);
	TestEqual(TEXT("nothing was left out: ") + FString::Join(Walked.NotWritten, TEXT(", ")), Walked.NotWritten.Num(), 0);

	// BSP: the level's model, under its brushes, with the door cut.
	int32 BspTriangles = 0;
	double DoorLow = 1e9;
	for (const SceneActor& Actor : Walked.Input.actors)
	{
		for (const Surface& Each : Actor.surfaces)
		{
			if (Each.kind != SurfaceKind::Mesh || !Each.channels.move) continue;
			BspTriangles += static_cast<int32>(Each.indices.size() / 3);
			for (const genex::world_scene::Point& Vertex : Each.points)
			{
				if (FMath::Abs(Vertex.y) <= 70.1 && FMath::Abs(Vertex.x - 620.0) <= 40.1 && Vertex.z > 200.0) DoorLow = FMath::Min(DoorLow, Vertex.z);
			}
		}
	}
	TestTrue(FString::Printf(TEXT("BSP's triangles stop a hull (%d)"), BspTriangles), BspTriangles > 12);
	TestTrue(FString::Printf(TEXT("and the door's lintel is at its height (%.1f)"), DoorLow), FMath::Abs(DoorLow - 220.0) < 0.5);

	TestNotNull(TEXT("the level's model is one actor, BSP"), Find(Walked, "BSP"));

	// A spline mesh: its hull follows the curve, nowhere near the cube at the origin.
	const SceneActor* Curved = Find(Walked, "CurvedWall");
	if (TestNotNull(TEXT("the spline wall is in the scene"), Curved))
	{
		TestTrue(TEXT("two bent segments"), CountKind(*Curved, SurfaceKind::Hull) + CountKind(*Curved, SurfaceKind::Box) == 2);
		double FarX = 0.0;
		for (const Surface& Each : Curved->surfaces)
		{
			for (const genex::world_scene::Point& P : Each.points) FarX = FMath::Min(FarX, P.x);
		}
		TestTrue(FString::Printf(TEXT("along the spline (reaches x %.0f)"), FarX), FarX < -1300.0);
	}

	// Instances: one surface each, at each instance.
	const SceneActor* Pillars = Find(Walked, "Pillars");
	if (TestNotNull(TEXT("the instanced pillars are in the scene"), Pillars))
	{
		TestEqual(TEXT("one simple surface an instance"), CountKind(*Pillars, SurfaceKind::Hull) + CountKind(*Pillars, SurfaceKind::Capsule) + CountKind(*Pillars, SurfaceKind::Box), 6);
	}

	// Channels: Pawn and Visibility are told apart.
	const SceneActor* Clip = Find(Walked, "ClipWall");
	const SceneActor* Screen = Find(Walked, "BulletScreen");
	const SceneActor* Platform = Find(Walked, "Bay_Platform");
	if (TestNotNull(TEXT("the clip wall"), Clip) && TestNotNull(TEXT("the screen"), Screen) && TestNotNull(TEXT("the platform"), Platform))
	{
		TestTrue(TEXT("the clip wall stops a hull, not a bullet"), Clip->surfaces.front().channels.move && !Clip->surfaces.front().channels.shot);
		bool bScreenMoves = false;
		bool bScreenShots = false;
		for (const Surface& Each : Screen->surfaces)
		{
			bScreenMoves = bScreenMoves || Each.channels.move;
			bScreenShots = bScreenShots || Each.channels.shot;
		}
		TestTrue(TEXT("the screen stops a bullet, not a hull"), !bScreenMoves && bScreenShots);
		TestTrue(TEXT("an exact wall is a box with no axes"), Platform->surfaces.front().kind == SurfaceKind::Box && !Platform->surfaces.front().hasAxes);
		TestTrue(TEXT("its simple collision stops a hull"), Platform->surfaces.front().channels.move);
		TestEqual(TEXT("its triangles answer a bullet"), CountKind(*Platform, SurfaceKind::Mesh), 1);
	}

	const SceneActor* Door = nullptr;
	const SceneActor* Volume = nullptr;
	for (const SceneActor& Actor : Walked.Input.actors)
	{
		if (Actor.name.rfind("SlidingDoor.", 0) == 0) Door = &Actor;
		if (Actor.name.rfind("BlockingVolume", 0) == 0) Volume = &Actor;
	}
	TestNotNull(TEXT("the blocking volume is in the scene"), Volume);
	if (TestNotNull(TEXT("the movable door is its own named part"), Door))
	{
		TestTrue(TEXT("tagged movable"), std::find(Door->tags.begin(), Door->tags.end(), "movable") != Door->tags.end());
	}
	const SceneActor* Crate = Find(Walked, "Crate_Turned");
	if (TestNotNull(TEXT("the turned crate"), Crate))
	{
		TestTrue(TEXT("a creator's Prop tag reads as the fit's"), std::find(Crate->tags.begin(), Crate->tags.end(), "prop") != Crate->tags.end());
		TestTrue(TEXT("and keeps its axes"), Crate->surfaces.front().hasAxes);
	}

	TestEqual(TEXT("three spawns"), static_cast<int32>(Walked.Input.spawns.size()), 3);
	bool bFeet = true;
	for (const genex::world_scene::SceneSpawn& Spawn : Walked.Input.spawns)
	{
		bFeet = bFeet && FMath::Abs(Spawn.at.z - FGenexFitTestLevel::GroundCm(Spawn.at.x, Spawn.at.y)) < 20.0;
	}
	TestTrue(TEXT("a spawn is where the feet are, not the capsule's middle"), bFeet);

	const genex::world_scene::ExportResult Result = genex::world_scene::Export(Walked.Input, genex::world_scene::ExportOptions{});
	TestTrue(FString::Printf(TEXT("the level writes: %s"), UTF8_TO_TCHAR(Result.report.detail.c_str())), Result.report.status == genex::world_scene::ExportStatus::Ok);
	TestEqual(TEXT("and names its door"), static_cast<int32>(Result.report.movable.size()), 1);

	// The direct bake is the compatible path: what it cannot read it still names, and it does not pretend.
	FGenexBakeRequest Direct;
	const FGenexLevelWalk Baked = FGenexCollisionBaker::Walk(World, Direct);
	const FString NotBaked = FString::Join(Baked.NotBaked, TEXT(", "));
	TestTrue(TEXT("the direct bake names the landscape: ") + NotBaked, NotBaked.Contains(TEXT("Hills")));
	TestTrue(TEXT("and the spline wall"), NotBaked.Contains(TEXT("CurvedWall")));
	TestTrue(TEXT("and the BSP"), NotBaked.Contains(TEXT("BSP")));
	return true;
}

#endif
