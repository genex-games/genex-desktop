// The level walk on a real world: a straight wall stays one exact box, a turned wall becomes a stair inside the
// error, a movable wall stays out and is named, and the asset the bake fills hashes to the bake's world.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "GenexCollisionBakeEditor.h"
#include "GenexCollisionWorld.h"
#include "GenexSettings.h"

namespace GenexCollisionBakeTest
{
AStaticMeshActor* AddWall(UWorld* World, UStaticMesh* Cube, const FTransform& Transform, EComponentMobility::Type Mobility)
{
	AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), Transform);
	Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
	Actor->GetStaticMeshComponent()->SetStaticMesh(Cube);
	Actor->GetStaticMeshComponent()->SetMobility(Mobility);
	return Actor;
}
} // namespace GenexCollisionBakeTest

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexCollisionBakeWalkTest, "Genex.Multiplayer.CollisionBake",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ProductFilter)

bool FGenexCollisionBakeWalkTest::RunTest(const FString&)
{
	using namespace GenexCollisionBakeTest;
	UStaticMesh* Cube = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	if (!TestNotNull(TEXT("the engine's cube loads"), Cube)) return false;
	UWorld* World = UWorld::CreateWorld(EWorldType::Game, false);
	// The cube is 100 units on a side, centred: this wall spans 400 x 20 x 300 from (0, 0, 0).
	AddWall(World, Cube, FTransform(FQuat::Identity, FVector(200, 10, 150), FVector(4, 0.2, 3)), EComponentMobility::Static);
	AddWall(World, Cube, FTransform(FQuat(FVector::UpVector, UE_DOUBLE_PI / 4), FVector(0, 2000, 150), FVector(8, 0.2, 3)), EComponentMobility::Static);
	AddWall(World, Cube, FTransform(FQuat::Identity, FVector(0, -2000, 150), FVector(4, 0.2, 3)), EComponentMobility::Movable);

	FGenexBakeRequest Parsed;
	FString ParseError;
	TestTrue(TEXT("the budget and the rules read"), FGenexBakeRequest::Parse(TEXT("-Map=/Game/M MaxRampsPerActor=7 BoundsActors=Prop+Wreck:2"), Parsed, ParseError));
	TestEqual(TEXT("MaxRampsPerActor reaches the request"), Parsed.MaxRampsPerActor, 7);
	TestEqual(TEXT("both rules reach the request"), static_cast<int32>(Parsed.BoundsActors.size()), 2);
	FGenexBakeRequest Refused;
	TestFalse(TEXT("a bad rule stops the bake"), FGenexBakeRequest::Parse(TEXT("BoundsActors=Wreck:0"), Refused, ParseError));
	TestFalse(TEXT("and says why"), ParseError.IsEmpty());

	FGenexBakeRequest Request;
	const FGenexLevelWalk Walked = FGenexCollisionBaker::Walk(World, Request);
	TestEqual(TEXT("two static walls walked"), static_cast<int32>(Walked.Actors.size()), 2);
	TestEqual(TEXT("the movable wall is named"), Walked.Moving.Num(), 1);
	TestEqual(TEXT("nothing blocking was left out: ") + FString::Join(Walked.NotBaked, TEXT(", ")), Walked.NotBaked.Num(), 0);

	genex::collision_bake::BakeOptions Options;
	Options.unitsPerGenex = GetDefault<UGenexSettings>()->UnitsPerMeter;
	const genex::collision_bake::BakeResult Result = genex::collision_bake::Bake(Walked.Actors, Options);
	World->DestroyWorld(false);
	if (!TestNotNull(TEXT("the bake gives a world"), Result.world.get())) return false;
	TestTrue(TEXT("the turned wall is a stair of many boxes"), Result.report.boxes > 20);
	TestTrue(TEXT("inside the stated error"), Result.report.worstErrorCm <= Options.maxErrorCm);
	const double Scale = Options.unitsPerGenex;
	bool bExactWall = false;
	for (const genex::FirstpersonWorld::Box& Box : Result.world->Boxes())
	{
		bExactWall = bExactWall || (Box[0] == 0.0 && Box[1] == 0.0 && Box[2] == 0.0 && Box[3] * Scale == 400.0 && FMath::IsNearlyEqual(Box[4] * Scale, 20.0, 1e-4) && Box[5] * Scale == 300.0);
	}
	TestTrue(TEXT("the straight wall stays one exact box"), bExactWall);

	UGenexCollisionWorld* Asset = NewObject<UGenexCollisionWorld>();
	FString Error;
	TestTrue(TEXT("the asset hashes to the bake's world: ") + Error, FGenexCollisionBaker::FillAsset(*Asset, *Result.world, Error));
	return true;
}

#endif
