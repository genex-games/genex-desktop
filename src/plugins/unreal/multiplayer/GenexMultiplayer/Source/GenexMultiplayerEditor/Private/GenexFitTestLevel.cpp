#include "GenexFitTestLevel.h"

#include "Builders/CubeBuilder.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/SplineMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "Engine/CollisionProfile.h"
#include "Engine/DirectionalLight.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "FileHelpers.h"
#include "GameFramework/PlayerStart.h"
#include "Landscape.h"
#include "LandscapeInfo.h"
#include "LandscapeLayerInfoObject.h"
#include "LandscapeProxy.h"
#include "Misc/Parse.h"

DEFINE_LOG_CATEGORY_STATIC(LogGenexFitLevel, Log, All);

namespace GenexFitTestLevelDetail
{
constexpr double FlatRadiusCm = 1600.0;
constexpr double BlendCm = 600.0;
/** Hills of about 3 m on 30 m: walkable everywhere, so reach is the whole map unless a wall says otherwise. */
constexpr double HillCm = 300.0;
constexpr double WaveCm = 3000.0;
constexpr double TwoPi = 6.283185307179586;
/** A landscape height of 1 local unit (1/128 of a sample's range) is one metre at this z scale. */
constexpr double LandscapeZScale = 100.0;

UStaticMesh* Shape(const TCHAR* Path) { return LoadObject<UStaticMesh>(nullptr, Path); }

AStaticMeshActor* AddMesh(UWorld* World, const TCHAR* Label, UStaticMesh* Mesh, const FTransform& Transform, EComponentMobility::Type Mobility = EComponentMobility::Static)
{
	AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), Transform);
	Actor->SetActorLabel(Label);
	UStaticMeshComponent* Component = Actor->GetStaticMeshComponent();
	Component->SetMobility(EComponentMobility::Movable);
	Component->SetStaticMesh(Mesh);
	Component->SetMobility(Mobility);
	return Actor;
}

/** A cube mesh from its low corner and its size in centimetres, flat on nothing: the cube is 100 on a side, centred. */
FTransform BoxAt(const FVector& Low, const FVector& Size)
{
	return FTransform(FQuat::Identity, Low + Size * 0.5, Size / 100.0);
}

void AddSplineWall(UWorld* World, UStaticMesh* Cube)
{
	AActor* Holder = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity);
	Holder->SetActorLabel(TEXT("CurvedWall"));
	const FVector Points[] = {FVector(-400, 700, 150), FVector(-1100, 800, 150), FVector(-1500, 300, 150)};
	const FVector Tangents[] = {FVector(-700, 200, 0), FVector(-600, -300, 0), FVector(-100, -700, 0)};
	USceneComponent* Root = nullptr;
	for (int32 I = 0; I < 2; ++I)
	{
		USplineMeshComponent* Spline = NewObject<USplineMeshComponent>(Holder, *FString::Printf(TEXT("Segment_%d"), I));
		Spline->SetMobility(EComponentMobility::Static);
		Spline->SetStaticMesh(Cube);
		Spline->SetCollisionProfileName(UCollisionProfile::BlockAll_ProfileName);
		Spline->SetForwardAxis(ESplineMeshAxis::X, false);
		Spline->SetStartAndEnd(Points[I], Tangents[I], Points[I + 1], Tangents[I + 1], false);
		Spline->SetStartScale(FVector2D(0.3, 3.0), false);
		Spline->SetEndScale(FVector2D(0.3, 3.0), false);
		Holder->AddInstanceComponent(Spline);
		if (Root == nullptr)
		{
			Holder->SetRootComponent(Spline);
			Root = Spline;
		}
		else
		{
			Spline->SetupAttachment(Root);
		}
		Spline->RegisterComponent();
		Spline->UpdateMesh();
		Spline->RecreateCollision();
	}
}

void AddPillars(UWorld* World, UStaticMesh* Cylinder)
{
	AActor* Holder = World->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity);
	Holder->SetActorLabel(TEXT("Pillars"));
	UInstancedStaticMeshComponent* Instances = NewObject<UInstancedStaticMeshComponent>(Holder, TEXT("Row"));
	Instances->SetMobility(EComponentMobility::Static);
	Instances->SetStaticMesh(Cylinder);
	Holder->AddInstanceComponent(Instances);
	Holder->SetRootComponent(Instances);
	Instances->RegisterComponent();
	for (int32 I = 0; I < 6; ++I)
	{
		Instances->AddInstance(FTransform(FQuat::Identity, FVector(-1200.0 + I * 240.0, -1000.0, 150.0), FVector(0.6, 0.6, 3.0)), true);
	}
}
} // namespace GenexFitTestLevelDetail

double FGenexFitTestLevel::GroundCm(double X, double Y)
{
	using namespace GenexFitTestLevelDetail;
	const double Away = FMath::Clamp((FMath::Sqrt(X * X + Y * Y) - FlatRadiusCm) / BlendCm, 0.0, 1.0);
	const double Blend = Away * Away * (3.0 - 2.0 * Away);
	const double Hills = FMath::Sin(X * TwoPi / WaveCm) * FMath::Cos(Y * TwoPi / (WaveCm * 1.4)) + 0.5 * FMath::Sin((X + Y) * TwoPi / (WaveCm * 2.3));
	return HillCm * Blend * Hills;
}

void FGenexFitTestLevel::AddLandscape(UWorld* World)
{
	using namespace GenexFitTestLevelDetail;
	const int32 Quads = ComponentsPerSide * QuadsPerComponent;
	const int32 Verts = Quads + 1;
	const double Half = Quads * QuadCm * 0.5;
	FActorSpawnParameters Params;
	ALandscape* Landscape = World->SpawnActor<ALandscape>(FVector(-Half, -Half, 0.0), FRotator::ZeroRotator, Params);
	Landscape->SetActorLabel(TEXT("Hills"));
	Landscape->SetActorRelativeScale3D(FVector(QuadCm, QuadCm, LandscapeZScale));
	TArray<uint16> Heights;
	Heights.SetNumUninitialized(Verts * Verts);
	for (int32 Row = 0; Row < Verts; ++Row)
	{
		for (int32 Col = 0; Col < Verts; ++Col)
		{
			const double Cm = GroundCm(Col * QuadCm - Half, Row * QuadCm - Half);
			Heights[Row * Verts + Col] = static_cast<uint16>(FMath::Clamp(FMath::RoundToInt(32768.0 + Cm / LandscapeZScale * 128.0), 0, 65535));
		}
	}
	TMap<FGuid, TArray<uint16>> HeightsPerLayer;
	HeightsPerLayer.Add(FGuid(), MoveTemp(Heights));
	TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialsPerLayer;
	MaterialsPerLayer.Add(FGuid(), TArray<FLandscapeImportLayerInfo>());
	Landscape->Import(FGuid::NewGuid(), 0, 0, Quads, Quads, 1, QuadsPerComponent, HeightsPerLayer, nullptr, MaterialsPerLayer, ELandscapeImportAlphamapType::Additive, MakeArrayView<const FLandscapeLayer>({}));
	Landscape->CreateLandscapeInfo();
}

void FGenexFitTestLevel::AddLevelActors(UWorld* World)
{
	using namespace GenexFitTestLevelDetail;
	UStaticMesh* Cube = Shape(TEXT("/Engine/BasicShapes/Cube.Cube"));
	UStaticMesh* Cylinder = Shape(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	const double Half = ComponentsPerSide * QuadsPerComponent * QuadCm * 0.5;

	// The rim: nothing walks off the map.
	const double Rim = Half + 20.0;
	AddMesh(World, TEXT("Rim_North"), Cube, BoxAt(FVector(-Rim, Half, -400), FVector(Rim * 2, 40, 1200)));
	AddMesh(World, TEXT("Rim_South"), Cube, BoxAt(FVector(-Rim, -Rim, -400), FVector(Rim * 2, 40, 1200)));
	AddMesh(World, TEXT("Rim_East"), Cube, BoxAt(FVector(Half, -Rim, -400), FVector(40, Rim * 2, 1200)));
	AddMesh(World, TEXT("Rim_West"), Cube, BoxAt(FVector(-Rim, -Rim, -400), FVector(40, Rim * 2, 1200)));

	// A loading bay: a platform, a ramp up to it and steps down from it.
	AddMesh(World, TEXT("Bay_Platform"), Cube, BoxAt(FVector(200, -1400, 0), FVector(500, 400, 120)));
	const double RampDegrees = 20.0;
	AddMesh(World, TEXT("Bay_Ramp"), Cube, FTransform(FQuat(FVector::RightVector, FMath::DegreesToRadians(RampDegrees)), FVector(40, -1200, 45), FVector(3.6, 2.0, 0.2)));
	for (int32 Step = 0; Step < 5; ++Step)
	{
		AddMesh(World, *FString::Printf(TEXT("Bay_Step_%d"), Step), Cube, BoxAt(FVector(700.0 + Step * 40.0, -1400, 0), FVector(40, 200, 96.0 - Step * 16.0)));
	}

	// Turned props: a crate at 30 degrees and one on a corner, which the fit has to cover without a door closing.
	AddMesh(World, TEXT("Crate_Turned"), Cube, FTransform(FQuat(FVector::UpVector, FMath::DegreesToRadians(30.0)), FVector(-300, -300, 60), FVector(1.2)))->Tags.Add(TEXT("Prop"));
	AddMesh(World, TEXT("Crate_Tipped"), Cube, FTransform(FQuat(FVector(1, 1, 0).GetSafeNormal(), FMath::DegreesToRadians(35.0)), FVector(-500, -520, 70), FVector(0.9)))->Tags.Add(TEXT("Prop"));

	// A clip wall a hull stops at and a bullet passes, and a screen a bullet stops at and a hull passes.
	AStaticMeshActor* Clip = AddMesh(World, TEXT("ClipWall"), Cube, BoxAt(FVector(-800, 1100, 0), FVector(800, 20, 300)));
	Clip->GetStaticMeshComponent()->SetCollisionResponseToChannel(ECC_Visibility, ECR_Ignore);
	AStaticMeshActor* Screen = AddMesh(World, TEXT("BulletScreen"), Cube, BoxAt(FVector(200, 1100, 0), FVector(600, 10, 300)));
	Screen->GetStaticMeshComponent()->SetCollisionResponseToChannel(ECC_Pawn, ECR_Ignore);

	// A door the room's module owns.
	AddMesh(World, TEXT("SlidingDoor"), Cube, BoxAt(FVector(-100, -30, 0), FVector(20, 200, 220)), EComponentMobility::Movable);

	AddSplineWall(World, Cube);
	AddPillars(World, Cylinder);

	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 3000), FRotator(-50, 40, 0));
	Sun->SetActorLabel(TEXT("Sun"));
	Sun->SetMobility(EComponentMobility::Movable);
	ASkyLight* Sky = World->SpawnActor<ASkyLight>(FVector(0, 0, 2500), FRotator::ZeroRotator);
	Sky->SetActorLabel(TEXT("Sky"));
	Sky->GetLightComponent()->SetMobility(EComponentMobility::Movable);
	Sky->GetLightComponent()->SourceType = SLS_SpecifiedCubemap;
	Sky->GetLightComponent()->Intensity = 1.5f;
}

void FGenexFitTestLevel::AddPlayerStarts(UWorld* World)
{
	const FVector Places[] = {FVector(-200, 100, 0), FVector(500, -500, 0), FVector(2100, 2100, 0)};
	int32 Index = 0;
	for (const FVector& Place : Places)
	{
		const double Ground = GroundCm(Place.X, Place.Y);
		APlayerStart* Start = World->SpawnActor<APlayerStart>(APlayerStart::StaticClass(), FVector(Place.X, Place.Y, Ground + 100.0), FRotator::ZeroRotator);
		if (Start != nullptr) Start->SetActorLabel(*FString::Printf(TEXT("Start_%d"), Index));
		Index += 1;
	}
}

void FGenexFitTestLevel::AddBsp(UWorld* World)
{
	if (GEditor == nullptr) return;
	UCubeBuilder* Builder = Cast<UCubeBuilder>(GEditor->FindBrushBuilder(UCubeBuilder::StaticClass()));
	const auto Brush = [World, Builder](const TCHAR* Verb, const FVector& Center, const FVector& Size) {
		Builder->X = Size.X;
		Builder->Y = Size.Y;
		Builder->Z = Size.Z;
		Builder->Build(World);
		GEditor->Exec(World, *FString::Printf(TEXT("BRUSH MOVETO X=%f Y=%f Z=%f"), Center.X, Center.Y, Center.Z));
		GEditor->Exec(World, Verb);
	};
	// A hut: walls 40 thick, a door of 140 by 220 in its -x wall. The door is where a coarse cover would close it.
	Brush(TEXT("BRUSH ADD"), FVector(1000, 0, 175), FVector(800, 600, 350));
	Brush(TEXT("BRUSH SUBTRACT"), FVector(1000, 0, 155), FVector(720, 520, 310));
	Brush(TEXT("BRUSH SUBTRACT"), FVector(620, 0, 110), FVector(60, 140, 220));
	GEditor->Exec(World, TEXT("MAP REBUILD"));
	// A blocking volume across the bay, from the same builder.
	Builder->X = 100;
	Builder->Y = 600;
	Builder->Z = 300;
	Builder->Build(World);
	GEditor->Exec(World, TEXT("BRUSH MOVETO X=-1400 Y=-300 Z=150"));
	GEditor->Exec(World, TEXT("BRUSH ADDVOLUME CLASS=BlockingVolume"));
}

UGenexMakeFitTestLevelCommandlet::UGenexMakeFitTestLevelCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UGenexMakeFitTestLevelCommandlet::Main(const FString& Params)
{
	FString Map;
	FString Only;
	FParse::Value(*Params, TEXT("Only="), Only);
	if (!FParse::Value(*Params, TEXT("Map="), Map))
	{
		UE_LOG(LogGenexFitLevel, Error, TEXT("-Map=/Game/GenexFitLab/Hillside is required"));
		return 1;
	}
	UWorld* World = UEditorLoadingAndSavingUtils::NewBlankMap(false);
	if (World == nullptr)
	{
		UE_LOG(LogGenexFitLevel, Error, TEXT("could not make a blank map"));
		return 1;
	}
	if (Only != TEXT("Empty")) FGenexFitTestLevel::AddLandscape(World);
	if (Only == TEXT("Huge"))
	{
		// A hostile row for the writer: a cube at a scale past what a room's numbers can hold. A refusal names it.
		GenexFitTestLevelDetail::AddMesh(World, TEXT("HugeCube"), GenexFitTestLevelDetail::Shape(TEXT("/Engine/BasicShapes/Cube.Cube")), FTransform(FQuat::Identity, FVector::ZeroVector, FVector(1e10)));
		FGenexFitTestLevel::AddPlayerStarts(World);
	}
	if (Only.IsEmpty())
	{
		FGenexFitTestLevel::AddBsp(World);
		FGenexFitTestLevel::AddLevelActors(World);
		FGenexFitTestLevel::AddPlayerStarts(World);
	}
	if (!UEditorLoadingAndSavingUtils::SaveMap(World, Map))
	{
		UE_LOG(LogGenexFitLevel, Error, TEXT("could not save %s"), *Map);
		return 1;
	}
	UE_LOG(LogGenexFitLevel, Display, TEXT("saved %s"), *Map);
	return 0;
}
