#include "GenexCollisionBakeEditor.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/BrushComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/ModelComponent.h"
#include "Components/SplineMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/Level.h"
#include "Model.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "FileHelpers.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexCollisionWorld.h"
#include "GenexSettings.h"
#include "HAL/IConsoleManager.h"
#include "Interface_CollisionDataProviderCore.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "PhysicsEngine/AggregateGeom.h"
#include "PhysicsEngine/BodySetup.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "WorldPartition/WorldPartition.h"

DEFINE_LOG_CATEGORY_STATIC(LogGenexBake, Log, All);

namespace GenexCollisionBakeDetail
{
using genex::collision_bake::ActorGeometry;
using genex::collision_bake::ConvexHull;
using genex::collision_bake::TriangleMesh;
using genex::collision_bake::Vec3;

/** A round element as a hull: fine enough that it sits within a percent or two of the radius. */
constexpr int32 RoundSides = 16;
constexpr int32 RoundRings = 8;

Vec3 ToVec(const FVector& V) { return Vec3{V.X, V.Y, V.Z}; }

/** The ring points of a sphere of `Radius` at `Center` (one hemisphere each way when `bTop` picks a side). */
void AddRound(TArray<FVector>& Points, const FVector& Center, double Radius, int32 FirstRing, int32 LastRing)
{
	for (int32 Ring = FirstRing; Ring <= LastRing; ++Ring)
	{
		const double Polar = UE_DOUBLE_PI * Ring / RoundRings;
		const double RingRadius = Radius * FMath::Sin(Polar);
		const double Z = Radius * FMath::Cos(Polar);
		if (Ring == 0 || Ring == RoundRings)
		{
			Points.Add(Center + FVector(0, 0, Z));
			continue;
		}
		for (int32 Side = 0; Side < RoundSides; ++Side)
		{
			const double Around = 2.0 * UE_DOUBLE_PI * Side / RoundSides;
			Points.Add(Center + FVector(RingRadius * FMath::Cos(Around), RingRadius * FMath::Sin(Around), Z));
		}
	}
}

void AddHull(ActorGeometry& Actor, const TArray<FVector>& Local, const FTransform& ToWorld)
{
	ConvexHull Hull;
	Hull.points.reserve(Local.Num());
	for (const FVector& Point : Local) Hull.points.push_back(ToVec(ToWorld.TransformPosition(Point)));
	Actor.hulls.push_back(std::move(Hull));
}

/** Simple collision as hulls: a box goes through as its corners, so any scale on any rotation stays exact. */
void AddSimple(ActorGeometry& Actor, const FKAggregateGeom& Geom, const FTransform& ToWorld, TArray<FString>& NotBaked, const FString& Name)
{
	for (const FKBoxElem& Box : Geom.BoxElems)
	{
		const FVector Half(Box.X * 0.5, Box.Y * 0.5, Box.Z * 0.5);
		TArray<FVector> Corners;
		for (int32 I = 0; I < 8; ++I)
		{
			const FVector Corner((I & 1) ? Half.X : -Half.X, (I & 2) ? Half.Y : -Half.Y, (I & 4) ? Half.Z : -Half.Z);
			Corners.Add(Box.GetTransform().TransformPosition(Corner));
		}
		AddHull(Actor, Corners, ToWorld);
	}
	for (const FKConvexElem& Convex : Geom.ConvexElems)
	{
		TArray<FVector> Points;
		for (const FVector& Point : Convex.VertexData) Points.Add(Convex.GetTransform().TransformPosition(Point));
		AddHull(Actor, Points, ToWorld);
	}
	for (const FKSphereElem& Sphere : Geom.SphereElems)
	{
		TArray<FVector> Points;
		AddRound(Points, Sphere.Center, Sphere.Radius, 0, RoundRings);
		AddHull(Actor, Points, ToWorld);
	}
	for (const FKSphylElem& Capsule : Geom.SphylElems)
	{
		TArray<FVector> Points;
		AddRound(Points, FVector(0, 0, Capsule.Length * 0.5), Capsule.Radius, 0, RoundRings / 2);
		AddRound(Points, FVector(0, 0, -Capsule.Length * 0.5), Capsule.Radius, RoundRings / 2, RoundRings);
		for (FVector& Point : Points) Point = Capsule.GetTransform().TransformPosition(Point);
		AddHull(Actor, Points, ToWorld);
	}
	const int32 Other = Geom.TaperedCapsuleElems.Num() + Geom.LevelSetElems.Num() + Geom.SkinnedLevelSetElems.Num() + Geom.MLLevelSetElems.Num() + Geom.SkinnedTriangleMeshElems.Num();
	if (Other > 0) NotBaked.Add(FString::Printf(TEXT("%s (%d tapered capsule or level set elements)"), *Name, Other));
}

bool AddTriangles(ActorGeometry& Actor, UStaticMesh* Mesh, const FTransform& ToWorld)
{
	FTriMeshCollisionData Data;
	if (Mesh == nullptr || !Mesh->GetPhysicsTriMeshData(&Data, true)) return false;
	TriangleMesh Triangles;
	Triangles.vertices.reserve(Data.Vertices.Num());
	for (const FVector3f& Vertex : Data.Vertices) Triangles.vertices.push_back(ToVec(ToWorld.TransformPosition(FVector(Vertex))));
	// A mirrored transform turns a mesh inside out, and inside out means a room to the core.
	const bool bFlip = (ToWorld.GetDeterminant() < 0.0) != static_cast<bool>(Data.bFlipNormals);
	Triangles.indices.reserve(Data.Indices.Num() * 3);
	for (const FTriIndices& Face : Data.Indices)
	{
		Triangles.indices.push_back(static_cast<std::int32_t>(Face.v0));
		Triangles.indices.push_back(static_cast<std::int32_t>(bFlip ? Face.v2 : Face.v1));
		Triangles.indices.push_back(static_cast<std::int32_t>(bFlip ? Face.v1 : Face.v2));
	}
	Actor.meshes.push_back(std::move(Triangles));
	return true;
}

/** One body at one transform, by the rule Unreal's own sweeps use: simple collision, or triangles for complex as simple. */
void AddBody(ActorGeometry& Actor, UBodySetup* Body, UStaticMesh* Mesh, const FTransform& ToWorld, const FGenexBakeRequest& Request, FGenexLevelWalk& Walk, const FString& Name)
{
	// No body is nothing to collide with: a mesh component with no mesh, a brush never built.
	if (Body == nullptr) return;
	const bool bHasSimple = Body->AggGeom.GetElementCount() > 0;
	const bool bComplexAsSimple = Body->GetCollisionTraceFlag() == CTF_UseComplexAsSimple;
	if (bHasSimple && !bComplexAsSimple)
	{
		AddSimple(Actor, Body->AggGeom, ToWorld, Walk.NotBaked, Name);
		return;
	}
	if (bComplexAsSimple || Request.bComplexWithoutSimple)
	{
		if (!AddTriangles(Actor, Mesh, ToWorld)) Walk.NotBaked.Add(Name + TEXT(" (no triangle data)"));
		return;
	}
	Walk.NotBaked.Add(Name + TEXT(" (no simple collision: a capsule walks through it; -ComplexWithoutSimple bakes its triangles)"));
}

void AddComponent(ActorGeometry& Actor, UPrimitiveComponent* Component, const FGenexBakeRequest& Request, FGenexLevelWalk& Walk)
{
	if (Component->IsEditorOnly() || !Component->IsCollisionEnabled()) return;
	if (Component->GetCollisionResponseToChannel(Request.Channel) != ECR_Block) return;
	const FString Name = Component->GetOwner()->GetActorNameOrLabel() + TEXT(".") + Component->GetName();
	if (Component->Mobility == EComponentMobility::Movable)
	{
		// A primitive with no body stops nothing, whatever its responses say (a subsystem's rendering actor, in any project).
		if (Component->GetBodySetup() != nullptr) Walk.Moving.Add(Name);
		return;
	}
	if (Cast<USplineMeshComponent>(Component) != nullptr)
	{
		Walk.NotBaked.Add(Name + TEXT(" (spline mesh)"));
		return;
	}
	if (UInstancedStaticMeshComponent* Instanced = Cast<UInstancedStaticMeshComponent>(Component))
	{
		for (int32 Index = 0; Index < Instanced->GetInstanceCount(); ++Index)
		{
			FTransform Instance;
			if (Instanced->GetInstanceTransform(Index, Instance, true)) AddBody(Actor, Instanced->GetBodySetup(), Instanced->GetStaticMesh(), Instance, Request, Walk, Name);
		}
		return;
	}
	if (UStaticMeshComponent* Mesh = Cast<UStaticMeshComponent>(Component))
	{
		AddBody(Actor, Mesh->GetBodySetup(), Mesh->GetStaticMesh(), Mesh->GetComponentTransform(), Request, Walk, Name);
		return;
	}
	if (UBrushComponent* Brush = Cast<UBrushComponent>(Component))
	{
		AddBody(Actor, Brush->GetBodySetup(), nullptr, Brush->GetComponentTransform(), Request, Walk, Name);
		return;
	}
	Walk.NotBaked.Add(Name + TEXT(" (") + Component->GetClass()->GetName() + TEXT(")"));
}

FString MapNameOf(UWorld* World)
{
	return FPackageName::GetShortName(World->GetOutermost()->GetName());
}

bool SaveAsset(const FString& PackageName, const genex::FirstpersonWorld& World, FString& Error)
{
	// An asset from an earlier run must load first: saving over a package only created here stops the editor with "cannot
	// be saved as it has only been partially loaded".
	UPackage* Package = FPackageName::DoesPackageExist(PackageName) ? LoadPackage(nullptr, *PackageName, LOAD_None) : CreatePackage(*PackageName);
	if (Package == nullptr)
	{
		Error = TEXT("could not load the existing ") + PackageName;
		return false;
	}
	Package->FullyLoad();
	const FString AssetName = FPackageName::GetShortName(PackageName);
	UGenexCollisionWorld* Asset = FindObject<UGenexCollisionWorld>(Package, *AssetName);
	const bool bCreated = Asset == nullptr;
	if (bCreated) Asset = NewObject<UGenexCollisionWorld>(Package, *AssetName, RF_Public | RF_Standalone);
	if (!FGenexCollisionBaker::FillAsset(*Asset, World, Error)) return false;
	if (bCreated) FAssetRegistryModule::AssetCreated(Asset);
	Package->MarkPackageDirty();
	FSavePackageArgs Args;
	Args.TopLevelFlags = RF_Public | RF_Standalone;
	const FString File = FPackageName::LongPackageNameToFilename(PackageName, FPackageName::GetAssetPackageExtension());
	if (!UPackage::SavePackage(Package, Asset, *File, Args))
	{
		Error = TEXT("could not save ") + File;
		return false;
	}
	return true;
}
} // namespace GenexCollisionBakeDetail

bool FGenexBakeRequest::Parse(const FString& Line, FGenexBakeRequest& Out, FString& Error)
{
	FString Channel;
	if (FParse::Value(*Line, TEXT("Channel="), Channel))
	{
		const int64 Value = StaticEnum<ECollisionChannel>()->GetValueByNameString(Channel);
		if (Value == INDEX_NONE)
		{
			Error = TEXT("unknown collision channel ") + Channel + TEXT(": use an ECollisionChannel name such as ECC_Pawn or ECC_GameTraceChannel1");
			return false;
		}
		Out.Channel = static_cast<ECollisionChannel>(Value);
	}
	FString Number;
	if (FParse::Value(*Line, TEXT("MaxErrorCm="), Number)) Out.MaxErrorCm = FCString::Atod(*Number);
	if (FParse::Value(*Line, TEXT("MaxBoxesPerActor="), Number)) Out.MaxBoxesPerActor = FCString::Atoi(*Number);
	if (FParse::Value(*Line, TEXT("MaxRampsPerActor="), Number)) Out.MaxRampsPerActor = FCString::Atoi(*Number);
	FString Bounds;
	if (FParse::Value(*Line, TEXT("BoundsActors="), Bounds))
	{
		std::string Why;
		if (!genex::collision_bake::ParseBoundsRules(TCHAR_TO_UTF8(*Bounds), Out.BoundsActors, Why))
		{
			Error = UTF8_TO_TCHAR(Why.c_str());
			return false;
		}
	}
	FParse::Value(*Line, TEXT("Asset="), Out.AssetPath);
	FParse::Value(*Line, TEXT("Json="), Out.JsonPath);
	Out.bAllowSkipped = FParse::Param(*Line, TEXT("AllowSkipped"));
	Out.bComplexWithoutSimple = FParse::Param(*Line, TEXT("ComplexWithoutSimple"));
	return true;
}

FGenexLevelWalk FGenexCollisionBaker::Walk(UWorld* World, const FGenexBakeRequest& Request)
{
	using namespace GenexCollisionBakeDetail;
	FGenexLevelWalk Walk;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		ActorGeometry Geometry;
		Geometry.name = TCHAR_TO_UTF8(*Actor->GetActorNameOrLabel());
		Actor->ForEachComponent<UPrimitiveComponent>(true, [&](UPrimitiveComponent* Component) { AddComponent(Geometry, Component, Request, Walk); });
		const bool bHasGeometry = !Geometry.hulls.empty() || !Geometry.meshes.empty() || !Geometry.boxes.empty();
		if (bHasGeometry) Walk.Actors.push_back(std::move(Geometry));
	}
	for (ULevel* Level : World->GetLevels())
	{
		// Every level has model components; only one with BSP nodes has anything in them.
		if (Level == nullptr || Level->Model == nullptr || Level->Model->Nodes.Num() == 0) continue;
		for (const UModelComponent* Model : Level->ModelComponents)
		{
			const bool bBlocks = Model != nullptr && Model->GetCollisionResponseToChannel(Request.Channel) == ECR_Block && Model->IsCollisionEnabled();
			if (bBlocks) Walk.NotBaked.Add(Model->GetName() + TEXT(" (BSP: convert it to a static mesh or cover it with blocking volumes)"));
		}
	}
	return Walk;
}

bool FGenexCollisionBaker::FillAsset(UGenexCollisionWorld& Asset, const genex::FirstpersonWorld& World, FString& Error)
{
	Asset.Modify();
	UGenexAuthoritySubsystem::ToUnrealSolids(World, Asset.Boxes, Asset.Ramps);
	const int64 Hash = Asset.GetWorldHash(Error);
	if (Hash == static_cast<int64>(World.Hash())) return true;
	Error = FString::Printf(TEXT("the asset hashes to %lld, the bake to %u: %s"), Hash, World.Hash(), *Error);
	return false;
}

bool FGenexCollisionBaker::SaveWorldAsset(const FString& PackageName, const genex::FirstpersonWorld& World, FString& Error)
{
	return GenexCollisionBakeDetail::SaveAsset(PackageName, World, Error);
}

UWorld* FGenexCollisionBaker::LoadLevelForBake(const FString& Params, FString& Error)
{
	FString Map;
	if (!FParse::Value(*Params, TEXT("Map="), Map))
	{
		Error = TEXT("-Map=/Game/Maps/MyLevel is required");
		return nullptr;
	}
	UWorld* World = UEditorLoadingAndSavingUtils::LoadMap(Map);
	// A map that did not load leaves the editor's empty start level open, and baking that reads as a clean empty world.
	if (World != nullptr && World->GetOutermost()->GetName() == Map) return World;
	Error = TEXT("could not load -Map=") + Map;
	return nullptr;
}

bool FGenexCollisionBaker::BakeLevel(UWorld* World, const FGenexBakeRequest& Request, FString& Error)
{
	using namespace GenexCollisionBakeDetail;
	if (World == nullptr)
	{
		Error = TEXT("no level is open");
		return false;
	}
	if (World->GetWorldPartition() != nullptr) UE_LOG(LogGenexBake, Warning, TEXT("World Partition: only the actors loaded now are baked; load the whole map first"));
	const FGenexLevelWalk Walked = Walk(World, Request);
	genex::collision_bake::BakeOptions Options;
	Options.maxErrorCm = Request.MaxErrorCm;
	Options.maxBoxesPerActor = Request.MaxBoxesPerActor;
	Options.maxRampsPerActor = Request.MaxRampsPerActor;
	Options.boundsActors = Request.BoundsActors;
	Options.unitsPerGenex = GetDefault<UGenexSettings>()->UnitsPerMeter;
	const genex::collision_bake::BakeResult Result = genex::collision_bake::Bake(Walked.Actors, Options);
	for (const std::string& Line : genex::collision_bake::ReportLines(Result.report)) UE_LOG(LogGenexBake, Display, TEXT("%s"), UTF8_TO_TCHAR(Line.c_str()));
	for (const FString& Name : Walked.Moving) UE_LOG(LogGenexBake, Display, TEXT("  MOVING, not baked: %s"), *Name);
	for (const FString& Name : Walked.NotBaked) UE_LOG(LogGenexBake, Warning, TEXT("  NOT BAKED: %s"), *Name);
	if (Result.world == nullptr)
	{
		Error = FString::Printf(TEXT("bake failed: %s %s"), UTF8_TO_TCHAR(genex::collision_bake::BakeStatusName(Result.report.status)), UTF8_TO_TCHAR(Result.report.detail.c_str()));
		return false;
	}
	const int32 Missing = Walked.NotBaked.Num() + static_cast<int32>(Result.report.skipped.size());
	if (Missing > 0 && !Request.bAllowSkipped)
	{
		Error = FString::Printf(TEXT("%d blocking things are not in the world (listed above): fix them, or pass -AllowSkipped"), Missing);
		return false;
	}
	if (Missing > 0) UE_LOG(LogGenexBake, Warning, TEXT("-AllowSkipped: this world leaves out %d blocking things, so a player passes through them"), Missing);
	const FString Map = MapNameOf(World);
	const FString AssetPath = Request.AssetPath.IsEmpty() ? TEXT("/Game/Genex/") + Map + TEXT("_CollisionWorld") : Request.AssetPath;
	const FString JsonPath = Request.JsonPath.IsEmpty() ? FPaths::ProjectSavedDir() / TEXT("Genex") / Map + TEXT(".world.json") : Request.JsonPath;
	if (!SaveAsset(AssetPath, *Result.world, Error)) return false;
	const FString Json = UTF8_TO_TCHAR(genex::collision_bake::WorldJson(*Result.world).c_str());
	if (!FFileHelper::SaveStringToFile(Json, *JsonPath, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM))
	{
		Error = TEXT("could not write ") + JsonPath;
		return false;
	}
	UE_LOG(LogGenexBake, Display, TEXT("world hash %u: asset %s, room module world %s"), Result.world->Hash(), *AssetPath, *JsonPath);
	return true;
}

UGenexBakeCollisionCommandlet::UGenexBakeCollisionCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UGenexBakeCollisionCommandlet::Main(const FString& Params)
{
	FGenexBakeRequest Request;
	FString Error;
	UWorld* World = FGenexBakeRequest::Parse(Params, Request, Error) ? FGenexCollisionBaker::LoadLevelForBake(Params, Error) : nullptr;
	if (World != nullptr && FGenexCollisionBaker::BakeLevel(World, Request, Error)) return 0;
	UE_LOG(LogGenexBake, Error, TEXT("%s"), *Error);
	return 1;
}

static FAutoConsoleCommand GenexBakeCollisionWorldCommand(
	TEXT("Genex.BakeCollisionWorld"),
	TEXT("Bakes the open level into a firstperson collision world: an asset and a room module JSON. Channel=ECC_Pawn MaxErrorCm=5 Asset=/Game/... Json=<file> MaxBoxesPerActor=1024 MaxRampsPerActor=128 BoundsActors=Prop+Wreck:2 -AllowSkipped -ComplexWithoutSimple"),
	FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
	{
		FGenexBakeRequest Request;
		FString Error;
		const FString Line = FString::Join(Args, TEXT(" "));
		UWorld* World = GEditor != nullptr ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (FGenexBakeRequest::Parse(Line, Request, Error) && FGenexCollisionBaker::BakeLevel(World, Request, Error)) return;
		UE_LOG(LogGenexBake, Error, TEXT("%s"), *Error);
	}));
