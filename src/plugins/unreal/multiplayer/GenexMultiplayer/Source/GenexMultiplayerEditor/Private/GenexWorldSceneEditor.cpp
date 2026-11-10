#include "GenexWorldSceneEditor.h"

#include "Components/BrushComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/ModelComponent.h"
#include "Components/SplineMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/Brush.h"
#include "Engine/Level.h"
#include "Engine/LevelStreaming.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Character.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/PlayerStart.h"
#include "GameFramework/WorldSettings.h"
#include "GameMapsSettings.h"
#include "GenexCollisionBakeEditor.h"
#include "GenexCollisionWorld.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexSettings.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformProcess.h"
#include "Interface_CollisionDataProviderCore.h"
#include "Interfaces/Interface_CollisionDataProvider.h"
#include "LandscapeComponent.h"
#include "LandscapeDataAccess.h"
#include "LandscapeHeightfieldCollisionComponent.h"
#include "LandscapeProxy.h"
#include "Misc/CommandLine.h"
#include "Misc/DefaultValueHelper.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Model.h"
#include "PhysicsEngine/AggregateGeom.h"
#include "PhysicsEngine/BodySetup.h"
#include "PhysicsEngine/PhysicsSettings.h"
#include "WorldPartition/WorldPartition.h"

DEFINE_LOG_CATEGORY_STATIC(LogGenexScene, Log, All);

namespace GenexWorldSceneDetail
{
using genex::world_scene::Channels;
using genex::world_scene::HullSize;
using genex::world_scene::Point;
using genex::world_scene::SceneActor;
using genex::world_scene::SceneSpawn;
using genex::world_scene::Surface;
using genex::world_scene::SurfaceKind;

/** A landscape this close to unturned and unmirrored is a heightfield; otherwise its quads go as triangles. */
constexpr double LandscapeTurnTolerance = 1e-6;
/** A movable part is its own scene actor: `Actor.Component`, so the fit names exactly what it left out. */
constexpr const char* MovableTag = "movable";
constexpr const char* PropTag = "prop";

std::string ToUtf8(const FString& Text) { return std::string(TCHAR_TO_UTF8(*Text)); }
Point ToPoint(const FVector& V) { return Point{V.X, V.Y, V.Z}; }

/** Which of the request's channels `Component` blocks. */
Channels ChannelsOf(const UPrimitiveComponent& Component, const FGenexSceneRequest& Request)
{
	Channels Blocks;
	Blocks.move = Component.GetCollisionResponseToChannel(Request.MoveChannel) == ECR_Block;
	Blocks.shot = Component.GetCollisionResponseToChannel(Request.ShotChannel) == ECR_Block;
	return Blocks;
}

/** One mesh's triangles, read once however many instances use it. */
struct FTriangles
{
	TArray<FVector3f> Vertices;
	std::vector<std::uint32_t> Indices;
};

struct FWalkState
{
	const FGenexSceneRequest& Request;
	FGenexSceneWalk& Out;
	TMap<const UStaticMesh*, TSharedPtr<FTriangles>> MeshTriangles;
};

TSharedPtr<FTriangles> ReadProvider(IInterface_CollisionDataProvider* Provider)
{
	FTriMeshCollisionData Data;
	if (Provider == nullptr || !Provider->GetPhysicsTriMeshData(&Data, true) || Data.Indices.Num() == 0) return nullptr;
	TSharedPtr<FTriangles> Read = MakeShared<FTriangles>();
	Read->Vertices = MoveTemp(Data.Vertices);
	Read->Indices.reserve(static_cast<std::size_t>(Data.Indices.Num()) * 3);
	for (const FTriIndices& Face : Data.Indices)
	{
		Read->Indices.push_back(Face.v0);
		Read->Indices.push_back(Face.v1);
		Read->Indices.push_back(Face.v2);
	}
	return Read;
}

TSharedPtr<FTriangles> TrianglesOf(FWalkState& State, UStaticMesh* Mesh)
{
	if (Mesh == nullptr) return nullptr;
	if (const TSharedPtr<FTriangles>* Found = State.MeshTriangles.Find(Mesh)) return *Found;
	TSharedPtr<FTriangles> Read = ReadProvider(Mesh);
	State.MeshTriangles.Add(Mesh, Read);
	return Read;
}

void AddMesh(std::vector<Surface>& Surfaces, const FTriangles& Triangles, const FTransform& ToWorld, const Channels& Answers)
{
	Surface Mesh;
	Mesh.kind = SurfaceKind::Mesh;
	Mesh.channels = Answers;
	Mesh.points.reserve(Triangles.Vertices.Num());
	for (const FVector3f& Vertex : Triangles.Vertices) Mesh.points.push_back(ToPoint(ToWorld.TransformPosition(FVector(Vertex))));
	Mesh.indices = Triangles.Indices;
	Surfaces.push_back(std::move(Mesh));
}

/** Simple collision by the rule Chaos reads it: a sphere and a capsule keep their round shape on any scale. */
void AddSimple(std::vector<Surface>& Surfaces, const FKAggregateGeom& Geom, const FTransform& ToWorld, const Channels& Answers, TArray<FString>& NotWritten, const FString& Name)
{
	const FVector Scale = ToWorld.GetScale3D();
	for (const FKBoxElem& Box : Geom.BoxElems)
	{
		const FTransform Element = Box.GetTransform();
		const FVector Half(Box.X * 0.5, Box.Y * 0.5, Box.Z * 0.5);
		std::array<Point, 8> Corners;
		for (int32 I = 0; I < 8; ++I)
		{
			const FVector Corner((I & 1) ? Half.X : -Half.X, (I & 2) ? Half.Y : -Half.Y, (I & 4) ? Half.Z : -Half.Z);
			Corners[static_cast<std::size_t>(I)] = ToPoint(ToWorld.TransformPosition(Element.TransformPosition(Corner)));
		}
		Surface Written;
		Written.channels = Answers;
		if (genex::world_scene::SurfaceFromBoxCorners(Corners, Written)) Surfaces.push_back(std::move(Written));
	}
	for (const FKConvexElem& Convex : Geom.ConvexElems)
	{
		const FTransform Element = Convex.GetTransform();
		Surface Written;
		Written.kind = SurfaceKind::Hull;
		Written.channels = Answers;
		Written.points.reserve(Convex.VertexData.Num());
		for (const FVector& Point3 : Convex.VertexData) Written.points.push_back(ToPoint(ToWorld.TransformPosition(Element.TransformPosition(Point3))));
		genex::world_scene::SimplifyHull(Written);
		Surfaces.push_back(std::move(Written));
	}
	for (const FKSphereElem& Sphere : Geom.SphereElems)
	{
		Surface Written;
		Written.kind = SurfaceKind::Sphere;
		Written.channels = Answers;
		Written.center = ToPoint(ToWorld.TransformPosition(Sphere.Center));
		Written.radius = Sphere.Radius * Scale.GetAbsMin();
		Surfaces.push_back(std::move(Written));
	}
	for (const FKSphylElem& Capsule : Geom.SphylElems)
	{
		const FVector Middle = ToWorld.TransformPosition(Capsule.Center);
		const FVector Along = ToWorld.TransformVectorNoScale(Capsule.Rotation.Quaternion().RotateVector(FVector::UpVector));
		const double Half = Capsule.GetScaledCylinderLength(Scale) * 0.5;
		Surface Written;
		Written.kind = SurfaceKind::Capsule;
		Written.channels = Answers;
		Written.a = ToPoint(Middle - Along * Half);
		Written.b = ToPoint(Middle + Along * Half);
		Written.radius = Capsule.GetScaledRadius(Scale);
		Surfaces.push_back(std::move(Written));
	}
	const int32 Other = Geom.TaperedCapsuleElems.Num() + Geom.LevelSetElems.Num() + Geom.SkinnedLevelSetElems.Num() + Geom.MLLevelSetElems.Num() + Geom.SkinnedTriangleMeshElems.Num();
	if (Other > 0) NotWritten.Add(FString::Printf(TEXT("%s (%d tapered capsule or level set elements)"), *Name, Other));
}

/** One body at one transform. A capsule's sweep reads simple collision, or triangles when they serve as simple; a bullet's
 *  trace reads triangles unless the body says simple serves as complex. So each surface answers what really stops on it. */
void AddBody(std::vector<Surface>& Surfaces, UBodySetup* Body, const TSharedPtr<FTriangles>& Triangles, const FTransform& ToWorld, const Channels& Blocks, FWalkState& State, const FString& Name)
{
	if (Body == nullptr) return;
	const bool bHasSimple = Body->AggGeom.GetElementCount() > 0;
	const ECollisionTraceFlag Trace = Body->GetCollisionTraceFlag();
	const bool bComplexAsSimple = Trace == CTF_UseComplexAsSimple;
	if (bHasSimple && !bComplexAsSimple)
	{
		const bool bShotReadsTriangles = Blocks.shot && State.Request.bShotTriangles && Trace != CTF_UseSimpleAsComplex && Triangles.IsValid();
		Channels Simple;
		Simple.move = Blocks.move;
		Simple.shot = Blocks.shot && !bShotReadsTriangles;
		AddSimple(Surfaces, Body->AggGeom, ToWorld, Simple, State.Out.NotWritten, Name);
		if (bShotReadsTriangles)
		{
			Channels ShotOnly;
			ShotOnly.move = false;
			ShotOnly.shot = true;
			AddMesh(Surfaces, *Triangles, ToWorld, ShotOnly);
		}
		return;
	}
	Channels Complex;
	Complex.move = Blocks.move && (bComplexAsSimple || State.Request.bComplexWithoutSimple);
	Complex.shot = Blocks.shot;
	if (Blocks.move && !Complex.move) State.Out.NoSimpleCollision.Add(Name);
	if (!Complex.move && !Complex.shot) return;
	if (!Triangles.IsValid())
	{
		// A mesh with no triangles for it is nothing to collide with, unless a hull should have stopped on it.
		if (Complex.move) State.Out.NotWritten.Add(Name + TEXT(" (no triangle data)"));
		return;
	}
	AddMesh(Surfaces, *Triangles, ToWorld, Complex);
}

/** A landscape's collision quads marked as holes: its visibility layer, where it has one. Empty is none. */
TArray<uint8> LandscapeHoles(ULandscapeHeightfieldCollisionComponent& Landscape, int32 Verts)
{
	TArray<uint8> Holes;
	const int32 VisibilityIndex = Landscape.ComponentLayerInfos.IndexOfByKey(ALandscapeProxy::VisibilityLayer);
	if (VisibilityIndex == INDEX_NONE || Landscape.DominantLayerData.GetElementCount() < static_cast<int64>(Verts) * Verts) return Holes;
	const uint8* Dominant = static_cast<const uint8*>(Landscape.DominantLayerData.LockReadOnly());
	const int32 Quads = Verts - 1;
	Holes.SetNumZeroed(Quads * Quads);
	bool bAny = false;
	for (int32 Row = 0; Row < Quads; ++Row)
	{
		for (int32 Col = 0; Col < Quads; ++Col)
		{
			const bool bHole = Dominant[Row * Verts + Col] == VisibilityIndex;
			Holes[Row * Quads + Col] = bHole ? 1 : 0;
			bAny = bAny || bHole;
		}
	}
	Landscape.DominantLayerData.Unlock();
	if (!bAny) Holes.Reset();
	return Holes;
}

/** A landscape component: a heightfield when it lies square to the world, else its quads as triangles. A hole is a quad
 *  and the format's hole is a sample, so a component with holes is triangles too: the hole stays its true size. */
void AddLandscape(std::vector<Surface>& Surfaces, ULandscapeHeightfieldCollisionComponent& Landscape, const Channels& Blocks, TArray<FString>& NotWritten, const FString& Name)
{
	const int32 Verts = Landscape.CollisionSizeQuads + 1;
	if (Landscape.CollisionHeightData.GetElementCount() < static_cast<int64>(Verts) * Verts)
	{
		NotWritten.Add(Name + TEXT(" (no collision heights: a cooked map; bake from the editor's own map)"));
		return;
	}
	TArray<uint8> Holes = LandscapeHoles(Landscape, Verts);
	const FTransform ToWorld = Landscape.GetComponentTransform();
	const FVector Scale = ToWorld.GetScale3D();
	const bool bSquare = ToWorld.GetRotation().IsIdentity(LandscapeTurnTolerance) && Scale.X > 0.0 && Scale.Y > 0.0 && Scale.Z > 0.0;

	const uint16* Heights = static_cast<const uint16*>(Landscape.CollisionHeightData.LockReadOnly());
	const auto LocalPoint = [&Landscape, Heights, Verts](int32 Row, int32 Col) {
		const double X = Col * static_cast<double>(Landscape.CollisionScale);
		const double Y = Row * static_cast<double>(Landscape.CollisionScale);
		return FVector(X, Y, LandscapeDataAccess::GetLocalHeight(Heights[Row * Verts + Col]));
	};
	Surface Written;
	Written.channels = Blocks;
	if (bSquare && Holes.Num() == 0)
	{
		Written.kind = SurfaceKind::Heightfield;
		const FVector Origin = ToWorld.TransformPosition(FVector::ZeroVector);
		Written.originX = Origin.X;
		Written.originY = Origin.Y;
		Written.cellX = Scale.X * Landscape.CollisionScale;
		Written.cellY = Scale.Y * Landscape.CollisionScale;
		Written.cols = Verts;
		Written.rows = Verts;
		Written.heights.reserve(static_cast<std::size_t>(Verts) * Verts);
		for (int32 Row = 0; Row < Verts; ++Row)
		{
			for (int32 Col = 0; Col < Verts; ++Col) Written.heights.push_back(ToWorld.TransformPosition(LocalPoint(Row, Col)).Z);
		}
	}
	else
	{
		std::vector<Point> Grid;
		Grid.reserve(static_cast<std::size_t>(Verts) * Verts);
		for (int32 Row = 0; Row < Verts; ++Row)
		{
			for (int32 Col = 0; Col < Verts; ++Col) Grid.push_back(ToPoint(ToWorld.TransformPosition(LocalPoint(Row, Col))));
		}
		std::vector<std::uint8_t> QuadHoles(Holes.GetData(), Holes.GetData() + Holes.Num());
		genex::world_scene::MeshFromGrid(Grid, Verts, Verts, QuadHoles, Written);
	}
	Landscape.CollisionHeightData.Unlock();
	Surfaces.push_back(std::move(Written));
}

/** One component's surfaces. Instanced meshes, spline meshes and anything else that hands the engine a body all come here. */
void AddComponentSurfaces(std::vector<Surface>& Surfaces, UPrimitiveComponent& Component, const Channels& Blocks, FWalkState& State, const FString& Name)
{
	if (ULandscapeHeightfieldCollisionComponent* Landscape = Cast<ULandscapeHeightfieldCollisionComponent>(&Component))
	{
		AddLandscape(Surfaces, *Landscape, Blocks, State.Out.NotWritten, Name);
		return;
	}
	if (USplineMeshComponent* Spline = Cast<USplineMeshComponent>(&Component))
	{
		// The component's own body is the mesh bent along the spline; it is built only when the physics state was.
		if (Spline->GetBodySetup() == nullptr) Spline->RecreateCollision();
		AddBody(Surfaces, Spline->GetBodySetup(), ReadProvider(Spline), Spline->GetComponentTransform(), Blocks, State, Name);
		return;
	}
	if (UInstancedStaticMeshComponent* Instanced = Cast<UInstancedStaticMeshComponent>(&Component))
	{
		const TSharedPtr<FTriangles> Triangles = TrianglesOf(State, Instanced->GetStaticMesh());
		for (int32 Index = 0; Index < Instanced->GetInstanceCount(); ++Index)
		{
			FTransform Instance;
			if (Instanced->GetInstanceTransform(Index, Instance, true)) AddBody(Surfaces, Instanced->GetBodySetup(), Triangles, Instance, Blocks, State, Name);
		}
		return;
	}
	if (UStaticMeshComponent* Mesh = Cast<UStaticMeshComponent>(&Component))
	{
		AddBody(Surfaces, Mesh->GetBodySetup(), TrianglesOf(State, Mesh->GetStaticMesh()), Mesh->GetComponentTransform(), Blocks, State, Name);
		return;
	}
	UBodySetup* Body = Component.GetBodySetup();
	if (Body == nullptr)
	{
		// A brush's own component has no body: the level's model holds what it became (WalkBsp). Anything else with its query
		// collision on and no body is a skeletal mesh or something custom: say so only if it matters.
		if (Blocks.move && Cast<UBrushComponent>(&Component) == nullptr) State.Out.NotWritten.Add(Name + TEXT(" (") + Component.GetClass()->GetName() + TEXT(": no body to read)"));
		return;
	}
	AddBody(Surfaces, Body, ReadProvider(Cast<IInterface_CollisionDataProvider>(&Component)), Component.GetComponentTransform(), Blocks, State, Name);
}

std::vector<std::string> ActorTags(const AActor& Actor)
{
	std::vector<std::string> Tags;
	for (const FName& Tag : Actor.Tags)
	{
		const FString Text = Tag.ToString();
		if (Text.Equals(TEXT("prop"), ESearchCase::IgnoreCase)) Tags.push_back(PropTag);
		else if (Text.Equals(TEXT("movable"), ESearchCase::IgnoreCase)) Tags.push_back(MovableTag);
		else Tags.push_back(ToUtf8(Text));
	}
	return Tags;
}

void WalkActor(AActor& Actor, FWalkState& State)
{
	const FString ActorName = Actor.GetActorNameOrLabel();
	SceneActor Scene;
	Scene.name = ToUtf8(ActorName);
	Scene.tags = ActorTags(Actor);
	std::vector<SceneActor> Parts;
	Actor.ForEachComponent<UPrimitiveComponent>(true, [&](UPrimitiveComponent* Component) {
		if (Component->IsEditorOnly() || !Component->IsQueryCollisionEnabled()) return;
		const Channels Blocks = ChannelsOf(*Component, State.Request);
		if (!Blocks.move && !Blocks.shot) return;
		const FString Name = ActorName + TEXT(".") + Component->GetName();
		if (Component->Mobility != EComponentMobility::Movable)
		{
			AddComponentSurfaces(Scene.surfaces, *Component, Blocks, State, Name);
			return;
		}
		SceneActor Moving;
		Moving.name = ToUtf8(Name);
		Moving.tags = Scene.tags;
		Moving.tags.push_back(MovableTag);
		AddComponentSurfaces(Moving.surfaces, *Component, Blocks, State, Name);
		if (!Moving.surfaces.empty()) Parts.push_back(std::move(Moving));
	});
	if (!Scene.surfaces.empty()) State.Out.Input.actors.push_back(std::move(Scene));
	for (SceneActor& Part : Parts) State.Out.Input.actors.push_back(std::move(Part));
}

/** BSP is the level's own model, CSG already done: its polygons, fanned, a mesh per brush each came from with the brush's
 *  name as a tag. Built by Build Geometry, like everything Unreal itself collides with here. */
void WalkBsp(ULevel& Level, FWalkState& State)
{
	UModel* Model = Level.Model;
	if (Model == nullptr || Model->Nodes.Num() == 0) return;
	Channels Blocks;
	Blocks.move = false;
	Blocks.shot = false;
	for (const UModelComponent* Component : Level.ModelComponents)
	{
		if (Component == nullptr || !Component->IsQueryCollisionEnabled()) continue;
		const Channels These = ChannelsOf(*Component, State.Request);
		Blocks.move = Blocks.move || These.move;
		Blocks.shot = Blocks.shot || These.shot;
	}
	if (!Blocks.move && !Blocks.shot) return;

	TMap<FString, TArray<FVector>> PolygonsByBrush;
	for (const FBspNode& Node : Model->Nodes)
	{
		if (Node.NumVertices < 3 || !Model->Surfs.IsValidIndex(Node.iSurf)) continue;
		const FBspSurf& Surf = Model->Surfs[Node.iSurf];
		if ((Surf.PolyFlags & PF_Portal) != 0) continue;
		const FString BrushName = Surf.Actor != nullptr ? Surf.Actor->GetActorNameOrLabel() : TEXT("BSP");
		TArray<FVector>& Triangles = PolygonsByBrush.FindOrAdd(BrushName);
		const FVert* Verts = &Model->Verts[Node.iVertPool];
		const FVector First = FVector(Model->Points[Verts[0].pVertex]);
		for (int32 Fan = 2; Fan < Node.NumVertices; ++Fan)
		{
			Triangles.Add(First);
			Triangles.Add(FVector(Model->Points[Verts[Fan - 1].pVertex]));
			Triangles.Add(FVector(Model->Points[Verts[Fan].pVertex]));
		}
	}
	// One scene actor for the level's model: a subtractive brush's faces are only the inside of something else, so on their
	// own they look like a small loose prop, and a prop can become one box, which would close the door it cut.
	SceneActor Actor;
	Actor.name = "BSP";
	if (Level.GetOuter() != nullptr && !Level.IsPersistentLevel()) Actor.name += "_" + ToUtf8(FPackageName::GetShortName(Level.GetOutermost()->GetName()));
	for (TPair<FString, TArray<FVector>>& Brush : PolygonsByBrush)
	{
		Surface Mesh;
		Mesh.kind = SurfaceKind::Mesh;
		Mesh.channels = Blocks;
		Mesh.tags.push_back(ToUtf8(Brush.Key));
		Mesh.points.reserve(Brush.Value.Num());
		Mesh.indices.reserve(Brush.Value.Num());
		for (const FVector& Point3 : Brush.Value)
		{
			Mesh.indices.push_back(static_cast<std::uint32_t>(Mesh.points.size()));
			Mesh.points.push_back(ToPoint(Point3));
		}
		Actor.surfaces.push_back(std::move(Mesh));
	}
	State.Out.Input.actors.push_back(std::move(Actor));
}

/** The hull of the level's default pawn, in engine units, when it is a Character: what a creator already set. */
bool PawnHull(UWorld& World, HullSize& Hull, FString& From)
{
	TSubclassOf<AGameModeBase> GameMode;
	if (const AWorldSettings* Settings = World.GetWorldSettings()) GameMode = Settings->DefaultGameMode;
	if (GameMode == nullptr) GameMode = LoadClass<AGameModeBase>(nullptr, *UGameMapsSettings::GetGlobalDefaultGameMode());
	if (GameMode == nullptr) return false;
	const UClass* PawnClass = GameMode->GetDefaultObject<AGameModeBase>()->DefaultPawnClass;
	const ACharacter* Character = PawnClass != nullptr ? Cast<ACharacter>(PawnClass->GetDefaultObject()) : nullptr;
	if (Character == nullptr) return false;
	const UCapsuleComponent* Capsule = Character->GetCapsuleComponent();
	const UCharacterMovementComponent* Movement = Character->GetCharacterMovement();
	if (Capsule == nullptr || Movement == nullptr) return false;
	const double Gravity = FMath::Abs(UPhysicsSettings::Get()->DefaultGravityZ * Movement->GravityScale);
	if (Gravity <= 0.0) return false;
	Hull.radius = Capsule->GetUnscaledCapsuleRadius();
	Hull.height = Capsule->GetUnscaledCapsuleHalfHeight() * 2.0;
	Hull.crouchHeight = FMath::Min(Hull.height, Movement->GetCrouchedHalfHeight() * 2.0);
	Hull.step = Movement->MaxStepHeight;
	Hull.jump = Movement->JumpZVelocity * Movement->JumpZVelocity / (2.0 * Gravity);
	Hull.leap = Movement->MaxWalkSpeed * 2.0 * Movement->JumpZVelocity / Gravity;
	From = TEXT("the level's default pawn, ") + PawnClass->GetName();
	return true;
}

void AddSpawns(UWorld& World, FWalkState& State)
{
	for (TActorIterator<APlayerStart> It(&World); It; ++It)
	{
		APlayerStart* Start = *It;
		SceneSpawn Spawn;
		Spawn.name = ToUtf8(Start->GetActorNameOrLabel());
		Spawn.tags = ActorTags(*Start);
		if (!Start->PlayerStartTag.IsNone()) Spawn.tags.push_back(ToUtf8(Start->PlayerStartTag.ToString()));
		// A PlayerStart stands at its capsule's middle; the scene's spawn is where the feet are.
		const UCapsuleComponent* Capsule = Start->GetCapsuleComponent();
		const double HalfHeight = Capsule != nullptr ? Capsule->GetScaledCapsuleHalfHeight() : 0.0;
		Spawn.at = ToPoint(Start->GetActorLocation() - FVector(0, 0, HalfHeight));
		State.Out.Input.spawns.push_back(std::move(Spawn));
	}
	int32 Index = 0;
	for (const FVector& At : State.Request.Spawns)
	{
		SceneSpawn Spawn;
		Spawn.name = "Spawn_" + std::to_string(Index++);
		Spawn.at = ToPoint(At);
		State.Out.Input.spawns.push_back(std::move(Spawn));
	}
}

bool ReadChannel(const FString& Line, const TCHAR* Key, ECollisionChannel& Out, FString& Error)
{
	FString Channel;
	if (!FParse::Value(*Line, Key, Channel)) return true;
	const int64 Value = StaticEnum<ECollisionChannel>()->GetValueByNameString(Channel);
	if (Value == INDEX_NONE)
	{
		Error = TEXT("unknown collision channel ") + Channel + TEXT(": use an ECollisionChannel name such as ECC_Pawn or ECC_GameTraceChannel1");
		return false;
	}
	Out = static_cast<ECollisionChannel>(Value);
	return true;
}

bool ReadNumbers(const FString& Text, int32 Count, TArray<double>& Out)
{
	TArray<FString> Parts;
	Text.ParseIntoArray(Parts, TEXT(","));
	if (Parts.Num() != Count) return false;
	for (const FString& Part : Parts)
	{
		double Value = 0.0;
		if (!FDefaultValueHelper::ParseDouble(Part, Value) || !FMath::IsFinite(Value)) return false;
		Out.Add(Value);
	}
	return true;
}

FString MapNameOf(const UWorld& World) { return FPackageName::GetShortName(World.GetOutermost()->GetName()); }

FString QuoteArg(const FString& Arg) { return TEXT("\"") + Arg.Replace(TEXT("\""), TEXT("\\\"")) + TEXT("\""); }

/** Runs `genex` with `Args`: through the shell's search, since a game's PATH is where a creator installed it. */
bool RunGenex(const FString& Cli, const FString& Args, FString& Out, FString& Err, int32& Code)
{
#if PLATFORM_WINDOWS
	const FString Program = TEXT("cmd.exe");
	const FString Line = TEXT("/c ") + QuoteArg(Cli) + TEXT(" ") + Args;
#else
	const FString Program = TEXT("/usr/bin/env");
	const FString Line = QuoteArg(Cli) + TEXT(" ") + Args;
#endif
	return FPlatformProcess::ExecProcess(*Program, *Line, &Code, &Out, &Err);
}
} // namespace GenexWorldSceneDetail

bool FGenexSceneRequest::Parse(const FString& Line, FGenexSceneRequest& Out, FString& Error)
{
	using namespace GenexWorldSceneDetail;
	if (!ReadChannel(Line, TEXT("Channel="), Out.MoveChannel, Error)) return false;
	if (!ReadChannel(Line, TEXT("ShotChannel="), Out.ShotChannel, Error)) return false;
	FParse::Value(*Line, TEXT("Scene="), Out.ScenePath, false);
	FParse::Value(*Line, TEXT("World="), Out.WorldPath, false);
	FParse::Value(*Line, TEXT("Asset="), Out.AssetPath, false);
	FParse::Value(*Line, TEXT("GenexCli="), Out.GenexCli, false);
	FParse::Value(*Line, TEXT("FitArgs="), Out.FitArgs, false);
	Out.bAllowSkipped = FParse::Param(*Line, TEXT("AllowSkipped"));
	Out.bComplexWithoutSimple = FParse::Param(*Line, TEXT("ComplexWithoutSimple"));
	Out.bShotTriangles = !FParse::Param(*Line, TEXT("NoShotTriangles"));
	FString Text;
	if (FParse::Value(*Line, TEXT("Hull="), Text, false))
	{
		TArray<double> Numbers;
		if (!ReadNumbers(Text, 6, Numbers))
		{
			Error = TEXT("Hull= takes six numbers in room units: radius,height,crouchHeight,step,jump,leap");
			return false;
		}
		const double Unit = GetDefault<UGenexSettings>()->UnitsPerMeter;
		Out.bHasHull = true;
		Out.Hull = HullSize{Numbers[0] * Unit, Numbers[1] * Unit, Numbers[2] * Unit, Numbers[3] * Unit, Numbers[4] * Unit, Numbers[5] * Unit};
	}
	if (FParse::Value(*Line, TEXT("Spawn="), Text, false))
	{
		TArray<FString> Places;
		Text.ParseIntoArray(Places, TEXT("+"));
		for (const FString& Place : Places)
		{
			TArray<double> Numbers;
			if (!ReadNumbers(Place, 3, Numbers))
			{
				Error = TEXT("Spawn= takes x,y,z points joined by +, in engine units: ") + Place;
				return false;
			}
			Out.Spawns.Add(FVector(Numbers[0], Numbers[1], Numbers[2]));
		}
	}
	return true;
}

FGenexSceneWalk FGenexWorldSceneExporter::Walk(UWorld* World, const FGenexSceneRequest& Request)
{
	using namespace GenexWorldSceneDetail;
	FGenexSceneWalk Walked;
	FWalkState State{Request, Walked, {}};
	Walked.Input.unitsPerGenex = GetDefault<UGenexSettings>()->UnitsPerMeter;
	Walked.Input.source["engine"] = "unreal";
	Walked.Input.source["engineVersion"] = ToUtf8(FEngineVersion::Current().ToString(EVersionComponent::Patch));
	Walked.Input.source["level"] = ToUtf8(MapNameOf(*World));
	Walked.Input.source["tool"] = "GenexExportWorldScene";

	for (TActorIterator<AActor> It(World); It; ++It)
	{
		AActor* Actor = *It;
		if (Actor->IsEditorOnly() || Actor->HasAnyFlags(RF_Transient)) continue;
		WalkActor(*Actor, State);
	}
	for (ULevel* Level : World->GetLevels())
	{
		if (Level != nullptr) WalkBsp(*Level, State);
	}
	for (const ULevelStreaming* Streaming : World->GetStreamingLevels())
	{
		if (Streaming != nullptr && Streaming->GetLoadedLevel() == nullptr) Walked.NotWritten.Add(Streaming->GetWorldAssetPackageName() + TEXT(" (a sublevel that is not loaded)"));
	}
	AddSpawns(*World, State);
	if (Request.bHasHull)
	{
		Walked.Input.hasHull = true;
		Walked.Input.hull = Request.Hull;
		Walked.HullFrom = TEXT("Hull=");
	}
	else
	{
		Walked.Input.hasHull = PawnHull(*World, Walked.Input.hull, Walked.HullFrom);
		if (!Walked.Input.hasHull) Walked.HullFrom = TEXT("left out: the level's default pawn is no Character, so the fit scales the Source defaults; pass Hull= for the room's own");
	}
	return Walked;
}

bool FGenexWorldSceneExporter::ExportLevel(UWorld* World, const FGenexSceneRequest& Request, FString& OutPath, FString& Error)
{
	using namespace GenexWorldSceneDetail;
	if (World == nullptr)
	{
		Error = TEXT("no level is open");
		return false;
	}
	if (World->GetWorldPartition() != nullptr) UE_LOG(LogGenexScene, Warning, TEXT("World Partition: only the actors loaded now are in the scene; load the whole map first"));
	const FGenexSceneWalk Walked = Walk(World, Request);
	genex::world_scene::ExportOptions Options;
	Options.allowRefused = Request.bAllowSkipped;
	const genex::world_scene::ExportResult Result = genex::world_scene::Export(Walked.Input, Options);
	for (const std::string& Line : genex::world_scene::ReportLines(Result.report)) UE_LOG(LogGenexScene, Display, TEXT("%s"), UTF8_TO_TCHAR(Line.c_str()));
	UE_LOG(LogGenexScene, Display, TEXT("  hull: %s"), *Walked.HullFrom);
	for (const FString& Name : Walked.NoSimpleCollision) UE_LOG(LogGenexScene, Display, TEXT("  NO SIMPLE COLLISION, a capsule walks through it and only bullets stop (-ComplexWithoutSimple makes it stop a hull): %s"), *Name);
	for (const FString& Name : Walked.NotWritten) UE_LOG(LogGenexScene, Warning, TEXT("  NOT WRITTEN: %s"), *Name);
	if (Result.report.status != genex::world_scene::ExportStatus::Ok)
	{
		Error = FString::Printf(TEXT("the scene was refused: %s %s"), UTF8_TO_TCHAR(genex::world_scene::ExportStatusName(Result.report.status)), UTF8_TO_TCHAR(Result.report.detail.c_str()));
		return false;
	}
	if (Walked.NotWritten.Num() > 0 && !Request.bAllowSkipped)
	{
		Error = FString::Printf(TEXT("%d blocking things are not in the scene (listed above): fix them, or pass -AllowSkipped"), Walked.NotWritten.Num());
		return false;
	}
	if (Walked.NotWritten.Num() > 0) UE_LOG(LogGenexScene, Warning, TEXT("-AllowSkipped: this scene leaves out %d blocking things, so a player passes through them"), Walked.NotWritten.Num());
	OutPath = Request.ScenePath.IsEmpty() ? FPaths::ProjectSavedDir() / TEXT("Genex") / MapNameOf(*World) + TEXT(".scene.json") : Request.ScenePath;
	if (!FFileHelper::SaveArrayToFile(TArrayView64<const uint8>(reinterpret_cast<const uint8*>(Result.text.data()), static_cast<int64>(Result.text.size())), *OutPath))
	{
		Error = TEXT("could not write ") + OutPath;
		return false;
	}
	UE_LOG(LogGenexScene, Display, TEXT("scene: %s"), *OutPath);
	return true;
}

bool FGenexWorldSceneExporter::ImportWorld(const FString& WorldPath, const FString& AssetPath, uint32& OutHash, FString& Error)
{
	FString Json;
	if (!FFileHelper::LoadFileToString(Json, *WorldPath))
	{
		Error = TEXT("could not read ") + WorldPath;
		return false;
	}
	std::string Why;
	const genex::FirstpersonWorldPtr World = genex::FirstpersonWorld::FromJsonText(TCHAR_TO_UTF8(*Json), &Why);
	if (World == nullptr)
	{
		Error = WorldPath + TEXT(" is no world a room takes: ") + UTF8_TO_TCHAR(Why.c_str());
		return false;
	}
	if (!FGenexCollisionBaker::SaveWorldAsset(AssetPath, *World, Error)) return false;
	OutHash = World->Hash();
	UE_LOG(LogGenexScene, Display, TEXT("world hash %u: asset %s, room module world %s"), OutHash, *AssetPath, *WorldPath);
	return true;
}

bool FGenexWorldSceneExporter::FitLevel(UWorld* World, const FGenexSceneRequest& Request, FString& Error)
{
	using namespace GenexWorldSceneDetail;
	FString ScenePath;
	if (!ExportLevel(World, Request, ScenePath, Error)) return false;
	const FString Map = MapNameOf(*World);
	const FString WorldPath = Request.WorldPath.IsEmpty() ? FPaths::ProjectSavedDir() / TEXT("Genex") / Map + TEXT(".world.json") : Request.WorldPath;
	const FString AssetPath = Request.AssetPath.IsEmpty() ? TEXT("/Game/Genex/") + Map + TEXT("_CollisionWorld") : Request.AssetPath;
	const FString Cli = Request.GenexCli.IsEmpty() ? TEXT("genex") : Request.GenexCli;
	const FString FullScene = FPaths::ConvertRelativePathToFull(ScenePath);
	const FString FullWorld = FPaths::ConvertRelativePathToFull(WorldPath);
	const FString Args = TEXT("world fit ") + QuoteArg(FullScene) + TEXT(" ") + QuoteArg(FullWorld) + (Request.FitArgs.IsEmpty() ? FString() : TEXT(" ") + Request.FitArgs);
	FString Out;
	FString Err;
	int32 Code = -1;
	const bool bStarted = RunGenex(Cli, Args, Out, Err, Code);
	if (!Out.IsEmpty()) UE_LOG(LogGenexScene, Display, TEXT("%s"), *Out);
	if (!bStarted || Code != 0)
	{
		Error = FString::Printf(TEXT("%s %s: %s %s"), *Cli, *Args, bStarted ? *FString::Printf(TEXT("exit %d"), Code) : TEXT("did not start (GenexCli= names it)"), *Err);
		return false;
	}
	uint32 Hash = 0;
	return ImportWorld(WorldPath, AssetPath, Hash, Error);
}

UGenexExportWorldSceneCommandlet::UGenexExportWorldSceneCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UGenexExportWorldSceneCommandlet::Main(const FString& Params)
{
	FGenexSceneRequest Request;
	FString Error;
	FString Path;
	UWorld* World = FGenexSceneRequest::Parse(Params, Request, Error) ? FGenexCollisionBaker::LoadLevelForBake(Params, Error) : nullptr;
	if (World != nullptr && FGenexWorldSceneExporter::ExportLevel(World, Request, Path, Error)) return 0;
	UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
	return 1;
}

UGenexImportCollisionWorldCommandlet::UGenexImportCollisionWorldCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UGenexImportCollisionWorldCommandlet::Main(const FString& Params)
{
	FGenexSceneRequest Request;
	FString Error;
	uint32 Hash = 0;
	if (!FGenexSceneRequest::Parse(Params, Request, Error))
	{
		UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
		return 1;
	}
	if (Request.WorldPath.IsEmpty() || Request.AssetPath.IsEmpty())
	{
		UE_LOG(LogGenexScene, Error, TEXT("World=<file> and Asset=/Game/... are required"));
		return 1;
	}
	if (FGenexWorldSceneExporter::ImportWorld(Request.WorldPath, Request.AssetPath, Hash, Error)) return 0;
	UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
	return 1;
}

UGenexFitCollisionCommandlet::UGenexFitCollisionCommandlet()
{
	IsClient = false;
	IsEditor = true;
	IsServer = false;
	LogToConsole = true;
}

int32 UGenexFitCollisionCommandlet::Main(const FString& Params)
{
	FGenexSceneRequest Request;
	FString Error;
	UWorld* World = FGenexSceneRequest::Parse(Params, Request, Error) ? FGenexCollisionBaker::LoadLevelForBake(Params, Error) : nullptr;
	if (World != nullptr && FGenexWorldSceneExporter::FitLevel(World, Request, Error)) return 0;
	UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
	return 1;
}

static FAutoConsoleCommand GenexExportWorldSceneCommand(
	TEXT("Genex.ExportWorldScene"),
	TEXT("Writes the open level as a world scene for `genex world fit`. Channel=ECC_Pawn ShotChannel=ECC_Visibility Scene=<file> Hull=r,h,c,s,j,l Spawn=x,y,z+x,y,z -AllowSkipped -ComplexWithoutSimple -NoShotTriangles"),
	FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
	{
		FGenexSceneRequest Request;
		FString Error;
		FString Path;
		UWorld* World = GEditor != nullptr ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (FGenexSceneRequest::Parse(FString::Join(Args, TEXT(" ")), Request, Error) && FGenexWorldSceneExporter::ExportLevel(World, Request, Path, Error)) return;
		UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
	}));

static FAutoConsoleCommand GenexImportCollisionWorldCommand(
	TEXT("Genex.ImportCollisionWorld"),
	TEXT("Saves a world JSON (from `genex world fit`) as a collision world asset with its hash checked. World=<file> Asset=/Game/..."),
	FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
	{
		FGenexSceneRequest Request;
		FString Error;
		uint32 Hash = 0;
		if (FGenexSceneRequest::Parse(FString::Join(Args, TEXT(" ")), Request, Error) && FGenexWorldSceneExporter::ImportWorld(Request.WorldPath, Request.AssetPath, Hash, Error)) return;
		UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
	}));

static FAutoConsoleCommand GenexFitCollisionWorldCommand(
	TEXT("Genex.FitCollisionWorld"),
	TEXT("The open level through the shared fit: scene, `genex world fit`, asset and room module JSON. The same options as Genex.ExportWorldScene, plus World=<file> Asset=/Game/... GenexCli=<path> FitArgs=\"...\""),
	FConsoleCommandWithArgsDelegate::CreateLambda([](const TArray<FString>& Args)
	{
		FGenexSceneRequest Request;
		FString Error;
		UWorld* World = GEditor != nullptr ? GEditor->GetEditorWorldContext().World() : nullptr;
		if (FGenexSceneRequest::Parse(FString::Join(Args, TEXT(" ")), Request, Error) && FGenexWorldSceneExporter::FitLevel(World, Request, Error)) return;
		UE_LOG(LogGenexScene, Error, TEXT("%s"), *Error);
	}));
