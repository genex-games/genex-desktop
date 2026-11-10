// Genex.Multiplayer.{TransportDefault,Presets,Firstperson,FirstpersonPrediction,Sincos,Vehicle,Projectile,ProjectilePrediction,
// Schema,Offline,RoomClock}: GenexCore as Unreal Build Tool compiles it (the module's own flags, unity build,
// FPSemantics Precise) held to what the CMake tools check: the topdown, firstperson and vehicle presets
// (PROTOCOL.md §17.7, the latter two with and without their broadphase), the portable sine and cosine,
// and the projectile flight (§17.9) bit for bit against the
// shared vectors, the firstperson world's validation and hash and when it predicts, the prediction's pure pieces (ids, launch values, the hand-off), the
// generated authority schema's wire order, and rows of the offline hostile tables. A difference here and not in genex_presets_check /
// genex_offline_check means UBT's build changed the arithmetic or a parser.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "GenexCore/AuthoritySchema.h"
#include "GenexCore/GenexAuthoritySession.h"
#include "GenexCore/GenexColyseus.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexInput.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexMsgpack.h"
#include "GenexCore/GenexPresets.h"
#include "GenexCore/GenexUrl.h"
#include "GenexCore/GenexVehicle.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexMultiplayerModule.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <optional>
#include <set>

namespace GenexCoreTestsDetail
{
/** The repository's vectors file `Name` (topdown.json, projectile.json): GENEX_REPO_ROOT, else found
 *  above the project (the probe lives at sdks/unreal/Tests/AuthorityProbe). Empty when neither has it. */
FString VectorsPath(const TCHAR* Name = TEXT("topdown.json"))
{
	const FString Rel = FString(TEXT("packages/netcode-bench/conformance/authority/presets/")) + Name;
	const FString Env = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_REPO_ROOT"));
	if (!Env.IsEmpty() && FPaths::FileExists(FPaths::Combine(Env, Rel))) return FPaths::Combine(Env, Rel);
	FString Dir = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
	for (int32 Up = 0; Up < 8 && !Dir.IsEmpty(); ++Up)
	{
		if (FPaths::FileExists(FPaths::Combine(Dir, Rel))) return FPaths::Combine(Dir, Rel);
		const FString Parent = FPaths::GetPath(Dir.EndsWith(TEXT("/")) ? Dir.LeftChop(1) : Dir);
		if (Parent == Dir) break;
		Dir = Parent;
	}
	return FString();
}

double Num(const genex::Json* Object, const char* Key)
{
	const double Nan = std::numeric_limits<double>::quiet_NaN();
	const genex::Json* V = Object ? Object->Find(Key) : nullptr;
	if (!V) return Nan;
	if (V->IsNumber()) return V->AsNumber();
	if (V->IsString() && V->AsString() == "Infinity") return std::numeric_limits<double>::infinity();
	if (V->IsString() && V->AsString() == "-Infinity") return -std::numeric_limits<double>::infinity();
	return Nan;
}

uint64 Bits(double V)
{
	uint64 B = 0;
	std::memcpy(&B, &V, sizeof B);
	return B;
}

/** A value read as the float32 the server writes. */
double F32(double V) { return static_cast<double>(static_cast<float>(V)); }

/** A vectors file, parsed (false and an error added to the test when it cannot be). */
bool LoadVectors(FAutomationTestBase& Test, const TCHAR* Name, std::optional<genex::Json>& Out)
{
	const FString Path = VectorsPath(Name);
	if (!Test.TestFalse(FString::Printf(TEXT("found %s (set GENEX_REPO_ROOT)"), Name), Path.IsEmpty())) return false;
	FString Text;
	if (!Test.TestTrue(TEXT("read the vectors"), FFileHelper::LoadFileToString(Text, *Path))) return false;
	std::string Error;
	Out = genex::Json::Parse(TCHAR_TO_UTF8(*Text), &Error);
	return Test.TestTrue(TEXT("the vectors are JSON"), Out.has_value());
}
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexRoomClockTest, "Genex.Multiplayer.RoomClock",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)

// What everything drawn at the server's present reads. On Windows' 15.6 ms tick this spin sees about 13 values.
bool FGenexRoomClockTest::RunTest(const FString&)
{
	const auto Start = std::chrono::steady_clock::now();
	std::set<double> Readings;
	while (std::chrono::steady_clock::now() - Start < std::chrono::milliseconds(200))
	{
		Readings.insert(colyseus_room_clock_now(nullptr));
	}
	AddInfo(FString::Printf(TEXT("%d readings in 200 ms"), static_cast<int32>(Readings.size())));
	return TestTrue(TEXT("a room clock moves finer than a frame"), Readings.size() >= 100);
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexPresetsTest, "Genex.Multiplayer.Presets",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexPresetsTest::RunTest(const FString&)
{
	using namespace GenexCoreTestsDetail;
	const FString Path = VectorsPath();
	if (!TestFalse(TEXT("found topdown.json (set GENEX_REPO_ROOT)"), Path.IsEmpty())) return false;
	FString Text;
	if (!TestTrue(TEXT("read the vectors"), FFileHelper::LoadFileToString(Text, *Path))) return false;
	std::string Error;
	std::optional<genex::Json> File = genex::Json::Parse(TCHAR_TO_UTF8(*Text), &Error);
	if (!TestTrue(TEXT("the vectors are JSON"), File.has_value())) return false;
	const double FileDt = Num(&*File, "dt");
	const genex::Json* Cases = File->Find("cases");
	if (!TestTrue(TEXT("cases"), Cases && Cases->IsArray())) return false;
	int32 Steps = 0, Exact = 0;
	FString First;
	for (std::size_t C = 0; C < Cases->Size(); ++C)
	{
		const genex::Json& Case = Cases->At(C);
		const genex::TopdownParams Params = genex::presets::ResolveTopdownParams(Case.Find("params"));
		const genex::Json* Initial = Case.Find("initial");
		genex::TopdownBody Body;
		Body.x = Num(Initial, "x");
		Body.y = Num(Initial, "y");
		Body.yaw = Num(Initial, "yaw");
		const genex::Json* List = Case.Find("steps");
		for (std::size_t I = 0; List && I < List->Size(); ++I)
		{
			const genex::Json& S = List->At(I);
			const genex::Json* In = S.Find("input");
			const double Dt = S.Contains("dt") ? Num(&S, "dt") : FileDt;
			Body = genex::presets::StepTopdown(Body, Num(In, "moveX"), Num(In, "moveY"), Num(In, "yaw"), Dt, Params);
			const genex::Json* Want = S.Find("expect");
			++Steps;
			const bool bSame = Bits(Body.x) == Bits(Num(Want, "x")) && Bits(Body.y) == Bits(Num(Want, "y")) && Bits(Body.yaw) == Bits(Num(Want, "yaw"));
			if (bSame) ++Exact;
			else if (First.IsEmpty()) First = FString::Printf(TEXT("case %d step %d: got (%.17g, %.17g, %.17g)"), int32(C), int32(I), Body.x, Body.y, Body.yaw);
		}
	}
	AddInfo(FString::Printf(TEXT("topdown: %d/%d steps bit-exact"), Exact, Steps));
	UE_LOG(LogGenex, Display, TEXT("Genex.Multiplayer.Presets: topdown %d/%d steps bit-exact"), Exact, Steps);
	TestEqual(TEXT("every step of topdown.json is bit-exact under UBT's flags") + (First.IsEmpty() ? FString() : TEXT(" (first: ") + First + TEXT(")")), Exact, Steps);
	TestEqual(TEXT("the file has its 497 steps"), Steps, 497);
	// The sanitizer under the same flags (rows from tools/presets_check.cpp).
	const double Pi = 3.141592653589793;
	const genex::Input Wrapped = genex::Input::FromRaw(0, 0, 0, Pi, 0, 0).Sanitized();
	TestEqual(TEXT("π wraps to -float32(π)"), Bits(Wrapped.yaw), Bits(-static_cast<double>(static_cast<float>(Pi))));
	const genex::Input Clamped = genex::Input::FromRaw(2, -std::numeric_limits<double>::infinity(), -0.5, 7, -7, 16777216).Sanitized();
	TestTrue(TEXT("axes clamp, non-finite is 0, an out-of-range mask is 0"), Clamped.moveX == 1 && Clamped.moveY == 0 && Clamped.moveZ == -0.5 && Clamped.buttons == 0);
	TestEqual(TEXT("7 rad wraps"), Bits(Clamped.yaw), Bits(0.7168146967887878));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexFirstpersonTest, "Genex.Multiplayer.Firstperson",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexFirstpersonTest::RunTest(const FString&)
{
	using namespace GenexCoreTestsDetail;
	std::optional<genex::Json> File;
	if (!LoadVectors(*this, TEXT("firstperson.json"), File)) return false;
	const double FileDt = Num(&*File, "dt");
	const genex::Json* Cases = File->Find("cases");
	if (!TestTrue(TEXT("cases"), Cases && Cases->IsArray())) return false;
	static const char* const Fields[] = {"x", "y", "z", "vx", "vy", "vz", "yaw", "pitch", "duck", "mstate"};
	int32 Steps = 0, Exact = 0, BruteSame = 0, Hashes = 0, HashesOk = 0;
	FString First;
	double FastUs = 0.0;
	for (std::size_t C = 0; C < Cases->Size(); ++C)
	{
		const genex::Json& Case = Cases->At(C);
		const genex::FirstpersonParams Params = genex::presets::ResolveFirstpersonParams(Case.Find("params"));
		std::string Why;
		const genex::FirstpersonWorldPtr Fast = genex::FirstpersonWorld::FromJson(Case.Find("world"), &Why);
		if (!TestTrue(FString::Printf(TEXT("case %d's world is accepted (%s)"), int32(C), UTF8_TO_TCHAR(Why.c_str())), Fast != nullptr)) return false;
		const genex::FirstpersonWorldPtr Brute = Fast->WithBroadphase(false);
		++Hashes;
		if (static_cast<double>(Fast->Hash()) == Num(&Case, "worldHash")) ++HashesOk;
		const genex::Json* Initial = Case.Find("initial");
		genex::FirstpersonBody Body;
		Body.x = Num(Initial, "x");
		Body.y = Num(Initial, "y");
		Body.z = Num(Initial, "z");
		Body.vx = Num(Initial, "vx");
		Body.vy = Num(Initial, "vy");
		Body.vz = Num(Initial, "vz");
		Body.yaw = Num(Initial, "yaw");
		Body.pitch = Num(Initial, "pitch");
		Body.duck = Num(Initial, "duck");
		Body.mstate = Num(Initial, "mstate");
		Body.cap = Num(Initial, "cap");
		genex::FirstpersonBody Other = Body;
		const genex::Json* List = Case.Find("steps");
		for (std::size_t I = 0; List && I < List->Size(); ++I)
		{
			const genex::Json& S = List->At(I);
			const genex::Json* In = S.Find("input");
			const double Dt = S.Contains("dt") ? Num(&S, "dt") : FileDt;
			const double T0 = FPlatformTime::Seconds();
			Body = genex::presets::StepFirstperson(Body, Num(In, "moveX"), Num(In, "moveY"), Num(In, "yaw"), Num(In, "pitch"), Num(In, "buttons"), Dt, Params, *Fast);
			FastUs += (FPlatformTime::Seconds() - T0) * 1e6;
			Other = genex::presets::StepFirstperson(Other, Num(In, "moveX"), Num(In, "moveY"), Num(In, "yaw"), Num(In, "pitch"), Num(In, "buttons"), Dt, Params, *Brute);
			const genex::Json* Want = S.Find("expect");
			const double Got[] = {Body.x, Body.y, Body.z, Body.vx, Body.vy, Body.vz, Body.yaw, Body.pitch, Body.duck, Body.mstate};
			const double GotBrute[] = {Other.x, Other.y, Other.z, Other.vx, Other.vy, Other.vz, Other.yaw, Other.pitch, Other.duck, Other.mstate};
			bool bSame = true, bBrute = true;
			for (int32 F = 0; F < 10; ++F)
			{
				bSame = bSame && Bits(Got[F]) == Bits(Num(Want, Fields[F]));
				bBrute = bBrute && Bits(Got[F]) == Bits(GotBrute[F]);
			}
			++Steps;
			if (bSame) ++Exact;
			else if (First.IsEmpty()) First = FString::Printf(TEXT("case %d step %d"), int32(C), int32(I));
			if (bBrute) ++BruteSame;
		}
	}
	const genex::Json* Worlds = File->Find("worlds");
	for (std::size_t W = 0; Worlds && W < Worlds->Size(); ++W)
	{
		const genex::FirstpersonWorldPtr World = genex::FirstpersonWorld::FromJson(Worlds->At(W).Find("world"));
		++Hashes;
		if (World && static_cast<double>(World->Hash()) == Num(&Worlds->At(W), "hash")) ++HashesOk;
	}
	AddInfo(FString::Printf(TEXT("firstperson: %d/%d steps bit-exact, broadphase = brute on %d/%d, %d/%d world hashes, %.2f us/step"), Exact, Steps, BruteSame, Steps, HashesOk, Hashes, Steps > 0 ? FastUs / Steps : 0.0));
	UE_LOG(LogGenex, Display, TEXT("Genex.Multiplayer.Firstperson: %d/%d steps bit-exact, broadphase = brute on %d/%d, %d/%d world hashes"), Exact, Steps, BruteSame, Steps, HashesOk, Hashes);
	TestEqual(TEXT("every step of firstperson.json is bit-exact under UBT's flags") + (First.IsEmpty() ? FString() : TEXT(" (first: ") + First + TEXT(")")), Exact, Steps);
	TestEqual(TEXT("the broadphase gives every step the bits brute force gives"), BruteSame, Steps);
	TestEqual(TEXT("every world hashes as the file says"), HashesOk, Hashes);
	TestTrue(TEXT("the file has its steps (3536 at the time of writing, more as cases are added)"), Steps >= 3536);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexFirstpersonPredictionTest, "Genex.Multiplayer.FirstpersonPrediction",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexFirstpersonPredictionTest::RunTest(const FString&)
{
	using namespace GenexCoreTestsDetail;
	// Rows of tools/offline_firstperson.cpp under UBT's flags.
	TestTrue(TEXT("the empty world hashes to 2615243109"), genex::FirstpersonWorld::Empty()->Hash() == 2615243109u);
	const char* const Refused[] = {"\"boxes\"", "{\"boxes\":[[0,0,0,1,1]]}", "{\"boxes\":[[0,0,0,0.1,1,1]]}", "{\"boxes\":[[0,0,0,0,1,1]]}", "{\"ramps\":[[0,0,0,10,10,8,0,0,5]]}"};
	for (const char* Spec : Refused) TestTrue(FString::Printf(TEXT("refused: %s"), UTF8_TO_TCHAR(Spec)), genex::FirstpersonWorld::FromJsonText(Spec) == nullptr);
	const genex::FirstpersonWorldPtr Minus = genex::FirstpersonWorld::FromJsonText("{\"boxes\":[[-0,-1,-0,1,1,2]],\"ramps\":[[-0,-0,-0,4,4,2,1,-0,2]]}");
	TestTrue(TEXT("-0 is read as 0 (1549317413)"), Minus && Minus->Hash() == 1549317413u);
	const genex::FirstpersonWorldPtr Floor = genex::FirstpersonWorld::FromJsonText("{\"boxes\":[[-4096,-4096,-64,4096,4096,0]]}");
	const std::string Text = "{\"name\":\"firstperson\",\"params\":{\"world\":1660121386}}";
	TestTrue(TEXT("the empty world is not the floor room's: no prediction"), !genex::PredictionFor(Text).WorldMatches());
	TestTrue(TEXT("the floor world is"), genex::PredictionFor(Text, Floor).WorldMatches());
	TestEqual(TEXT("the drawn pitch limit is float32(pitchLimit)"), Bits(genex::PredictionFor(Text).PitchLimit()), Bits(1.5533430576324463));
	TestEqual(TEXT("a pitch past the limit is drawn at it"), Bits(genex::AuthorityDrawnPitch(3.0, F32(1.5533430576324463))), Bits(F32(1.5533430576324463)));
	// A pitch is a bounded angle, eased and corrected straight (offline: firstperson_pitch_is_not_a_heading).
	{
		const double Widest = 1.5707963705062866;
		genex::AuthorityPose Up;
		Up.t = 100;
		Up.pitch = Widest;
		genex::AuthorityPose Down = Up;
		Down.t = 200;
		Down.pitch = -Widest;
		const std::vector<genex::AuthorityPose> History{Up, Down};
		TestTrue(TEXT("another seat's pitch is sampled straight: level halfway"), FMath::Abs(genex::AuthoritySample(History, 150).pitch) < 1e-12);
		const genex::AuthorityPose Eased = genex::AuthoritySpringStep(Down, 1, true, Up, 1, 25, 25);
		TestTrue(TEXT("the output spring eases the pitch straight"), FMath::Abs(Eased.pitch - (Widest - 2.0 * Widest * (1.0 - FMath::Exp(-1.0)))) < 1e-12);
		TestEqual(TEXT("a pitch correction from down to up is 2 limit"), Bits(genex::AuthorityCorrection("pitch", -Widest, Widest)), Bits(2.0 * Widest));
		TestTrue(TEXT("a heading correction across the seam is the short arc"), FMath::Abs(genex::AuthorityCorrection("yaw", 3.1, -3.1) - (2.0 * UE_DOUBLE_PI - 6.2)) < 1e-12);
		TestTrue(TEXT("only yaw is a heading"), genex::AuthorityIsHeading("yaw") && !genex::AuthorityIsHeading("pitch"));
	}
	// The mirror step against the pure step.
	const genex::Prediction Predicted = genex::PredictionFor(Text, Floor);
	genex::authority_wire::AuthorityEntity Mirror{};
	Mirror.mstate = 1;
	Mirror.cap = 1.0f;
	genex::FirstpersonBody Body;
	Body.mstate = 1;
	bool bSame = true;
	for (int32 I = 0; I < 90; ++I)
	{
		const genex::Input Raw = genex::Input::FromRaw(FMath::Cos(I * 0.07), 0.5, 0.0, I * 0.1, 0.2, (I % 30) < 3 ? 1.0 : 0.0);
		genex::authority_wire::AuthorityInput Wire{};
		Raw.WriteSanitized(Wire);
		Predicted.Step(Mirror, Wire, 1.0 / 60.0);
		Body = genex::presets::StepFirstperson(Body, genex::Input::FromWire(Wire), 1.0 / 60.0, Predicted.Firstperson(), *Floor);
		bSame = bSame && Bits(Mirror.x) == Bits(F32(Body.x)) && Bits(Mirror.z) == Bits(F32(Body.z)) && Bits(Mirror.vy) == Bits(F32(Body.vy)) && Mirror.mstate == Body.mstate;
	}
	TestTrue(TEXT("the mirror step is the pure step, bit for bit"), bSame);
	TestTrue(TEXT("the body moved"), Mirror.y > 10.f);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexSincosTest, "Genex.Multiplayer.Sincos",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexSincosTest::RunTest(const FString&)
{
	using namespace GenexCoreTestsDetail;
	std::optional<genex::Json> File;
	if (!LoadVectors(*this, TEXT("sincos.json"), File)) return false;
	// The constants by their bits (§17.7's table), as this build holds them.
	int32 Constants = 0, ConstantsOk = 0;
	if (const genex::Json* Table = File->Find("constants"))
	{
		for (const genex::JsonMember& M : Table->Members())
		{
			++Constants;
			const uint64 Want = M.value.IsString() ? FCString::Strtoui64(UTF8_TO_TCHAR(M.value.AsString().c_str()), nullptr, 16) : 0;
			if (Bits(genex::presets::SinCosConstant(M.key)) == Want) ++ConstantsOk;
		}
	}
	const genex::Json* Cases = File->Find("cases");
	if (!TestTrue(TEXT("cases"), Cases && Cases->IsArray())) return false;
	int32 Samples = 0, Exact = 0;
	FString First;
	for (std::size_t C = 0; C < Cases->Size(); ++C)
	{
		const genex::Json* List = Cases->At(C).Find("samples");
		for (std::size_t I = 0; List && I < List->Size(); ++I)
		{
			const genex::Json& S = List->At(I);
			// By the sample's bits (a, psin, pcos), so the check does not lean on decimal parsing.
			const genex::Json* B = S.Find("bits");
			const std::string Hex = B && B->IsString() ? B->AsString() : std::string();
			if (!TestEqual(TEXT("a sample's bits are three hex patterns"), int32(Hex.size()), 50)) return false;
			const auto Read = [&](int32 At) {
				const uint64 V = FCString::Strtoui64(UTF8_TO_TCHAR(Hex.substr(At, 16).c_str()), nullptr, 16);
				double D = 0.0;
				std::memcpy(&D, &V, sizeof D);
				return D;
			};
			const genex::presets::SinCos Got = genex::presets::PSinCos(Read(0));
			const genex::presets::SinCos ByText = genex::presets::PSinCos(Num(&S, "a"));
			const bool bSame = Bits(Got.sin) == Bits(Read(17)) && Bits(Got.cos) == Bits(Read(34)) &&
				Bits(ByText.sin) == Bits(Read(17)) && Bits(ByText.cos) == Bits(Read(34));
			++Samples;
			if (bSame) ++Exact;
			else if (First.IsEmpty()) First = FString::Printf(TEXT("case %d sample %d"), int32(C), int32(I));
		}
	}
	AddInfo(FString::Printf(TEXT("sincos: %d/%d samples bit-exact, %d/%d constants"), Exact, Samples, ConstantsOk, Constants));
	UE_LOG(LogGenex, Display, TEXT("Genex.Multiplayer.Sincos: %d/%d samples bit-exact, %d/%d constants"), Exact, Samples, ConstantsOk, Constants);
	TestEqual(TEXT("every sample of sincos.json is bit-exact under UBT's flags") + (First.IsEmpty() ? FString() : TEXT(" (first: ") + First + TEXT(")")), Exact, Samples);
	TestEqual(TEXT("every constant has the table's bits"), ConstantsOk, Constants);
	TestTrue(TEXT("the file has its samples (566 at the time of writing) and 16 constants"), Samples >= 566 && Constants == 16);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexVehicleTest, "Genex.Multiplayer.Vehicle",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexVehicleTest::RunTest(const FString&)
{
	using namespace GenexCoreTestsDetail;
	std::optional<genex::Json> File;
	if (!LoadVectors(*this, TEXT("vehicle.json"), File)) return false;
	const double FileDt = Num(&*File, "dt");
	const genex::Json* Cases = File->Find("cases");
	if (!TestTrue(TEXT("cases"), Cases && Cases->IsArray())) return false;
	static const char* const Fields[] = {"x", "y", "z", "vx", "vy", "vz", "yaw", "spin", "fuel", "mstate"};
	int32 Steps = 0, Exact = 0, BruteSame = 0, Hashes = 0, HashesOk = 0, Discriminating = 0;
	FString First;
	double FastUs = 0.0;
	for (std::size_t C = 0; C < Cases->Size(); ++C)
	{
		const genex::Json& Case = Cases->At(C);
		const genex::VehicleParams Params = genex::presets::ResolveVehicleParams(Case.Find("params"));
		std::string Why;
		const genex::FirstpersonWorldPtr Fast = genex::FirstpersonWorld::FromJson(Case.Find("world"), &Why);
		if (!TestTrue(FString::Printf(TEXT("case %d's world is accepted (%s)"), int32(C), UTF8_TO_TCHAR(Why.c_str())), Fast != nullptr)) return false;
		const genex::FirstpersonWorldPtr Brute = Fast->WithBroadphase(false);
		++Hashes;
		if (static_cast<double>(Fast->Hash()) == Num(&Case, "worldHash")) ++HashesOk;
		if (Case.Contains("tolerance") && Num(&Case, "tolerance") == 0.0) ++Discriminating;
		const genex::Json* Initial = Case.Find("initial");
		genex::VehicleBody Body;
		Body.x = Num(Initial, "x");
		Body.y = Num(Initial, "y");
		Body.z = Num(Initial, "z");
		Body.vx = Num(Initial, "vx");
		Body.vy = Num(Initial, "vy");
		Body.vz = Num(Initial, "vz");
		Body.yaw = Num(Initial, "yaw");
		Body.spin = Num(Initial, "spin");
		Body.fuel = Num(Initial, "fuel");
		Body.mstate = Num(Initial, "mstate");
		Body.cap = Num(Initial, "cap");
		genex::VehicleBody Other = Body;
		const genex::Json* List = Case.Find("steps");
		for (std::size_t I = 0; List && I < List->Size(); ++I)
		{
			const genex::Json& S = List->At(I);
			const genex::Json* In = S.Find("input");
			const double Dt = S.Contains("dt") ? Num(&S, "dt") : FileDt;
			const double T0 = FPlatformTime::Seconds();
			Body = genex::presets::StepVehicle(Body, Num(In, "moveX"), Num(In, "moveY"), Num(In, "buttons"), Dt, Params, *Fast);
			FastUs += (FPlatformTime::Seconds() - T0) * 1e6;
			Other = genex::presets::StepVehicle(Other, Num(In, "moveX"), Num(In, "moveY"), Num(In, "buttons"), Dt, Params, *Brute);
			const genex::Json* Want = S.Find("expect");
			const double Got[] = {Body.x, Body.y, Body.z, Body.vx, Body.vy, Body.vz, Body.yaw, Body.spin, Body.fuel, Body.mstate};
			const double GotBrute[] = {Other.x, Other.y, Other.z, Other.vx, Other.vy, Other.vz, Other.yaw, Other.spin, Other.fuel, Other.mstate};
			bool bSame = true, bBrute = true;
			for (int32 F = 0; F < 10; ++F)
			{
				bSame = bSame && Bits(Got[F]) == Bits(Num(Want, Fields[F]));
				bBrute = bBrute && Bits(Got[F]) == Bits(GotBrute[F]);
			}
			++Steps;
			if (bSame) ++Exact;
			else if (First.IsEmpty()) First = FString::Printf(TEXT("case %d step %d"), int32(C), int32(I));
			if (bBrute) ++BruteSame;
		}
	}
	const genex::Json* Worlds = File->Find("worlds");
	for (std::size_t W = 0; Worlds && W < Worlds->Size(); ++W)
	{
		const genex::FirstpersonWorldPtr World = genex::FirstpersonWorld::FromJson(Worlds->At(W).Find("world"));
		++Hashes;
		if (World && static_cast<double>(World->Hash()) == Num(&Worlds->At(W), "hash")) ++HashesOk;
	}
	AddInfo(FString::Printf(TEXT("vehicle: %d/%d steps bit-exact, broadphase = brute on %d/%d, %d/%d world hashes, %d discriminating cases, %.2f us/step"), Exact, Steps, BruteSame, Steps, HashesOk, Hashes, Discriminating, Steps > 0 ? FastUs / Steps : 0.0));
	UE_LOG(LogGenex, Display, TEXT("Genex.Multiplayer.Vehicle: %d/%d steps bit-exact, broadphase = brute on %d/%d, %d/%d world hashes"), Exact, Steps, BruteSame, Steps, HashesOk, Hashes);
	TestEqual(TEXT("every step of vehicle.json is bit-exact under UBT's flags") + (First.IsEmpty() ? FString() : TEXT(" (first: ") + First + TEXT(")")), Exact, Steps);
	TestEqual(TEXT("the broadphase gives every step the bits brute force gives"), BruteSame, Steps);
	TestEqual(TEXT("every world hashes as the file says"), HashesOk, Hashes);
	TestTrue(TEXT("the file has its steps (4665 at the time of writing) and its discriminate- cases at tolerance 0"), Steps >= 4665 && Discriminating >= 9);

	// The room's preset text as a prediction: world-gated as firstperson's, and the mirror step is the
	// pure step bit for bit.
	const genex::FirstpersonWorldPtr Floor = genex::FirstpersonWorld::FromJsonText("{\"boxes\":[[-100000,-100000,-100,100000,100000,0]]}");
	const std::string Text = "{\"name\":\"vehicle\",\"params\":{\"world\":2517723330}}";
	TestTrue(TEXT("a vehicle room is predicted by name"), genex::PredictionFor(Text).Kind() == genex::PresetKind::Vehicle);
	TestTrue(TEXT("the empty world is not the floor room's: no prediction"), !genex::PredictionFor(Text).WorldMatches());
	TestTrue(TEXT("the floor world is"), Floor && genex::PredictionFor(Text, Floor).WorldMatches());
	const std::optional<genex::Json> Tiny = genex::Json::Parse("{\"turnSpeed\":1e-46}");
	const std::optional<genex::Json> Small = genex::Json::Parse("{\"turnSpeed\":1e-30}");
	TestTrue(TEXT("a vehicle param whose float32 is 0 where 0 is out of range is refused"),
		Tiny && Small && !genex::presets::VehicleParamsValid(&*Tiny) && genex::presets::VehicleParamsValid(&*Small));
	const genex::Prediction Predicted = genex::PredictionFor(Text, Floor);
	genex::authority_wire::AuthorityEntity Mirror{};
	Mirror.mstate = 1;
	Mirror.cap = 1.0f;
	Mirror.fuel = 1.0f;
	Mirror.pitch = 0.25f;
	genex::VehicleBody Car;
	Car.mstate = 1;
	Car.fuel = 1;
	bool bSame = true;
	for (int32 I = 0; I < 240; ++I)
	{
		const genex::Input Raw = genex::Input::FromRaw(FMath::Sin(I * 0.05), 1.0, 0.0, 0.0, 0.0, (I % 60) < 20 ? 2.0 : (I % 90) < 3 ? 1.0 : 4.0);
		genex::authority_wire::AuthorityInput Wire{};
		Raw.WriteSanitized(Wire);
		Predicted.Step(Mirror, Wire, 1.0 / 60.0);
		Car = genex::presets::StepVehicle(Car, genex::Input::FromWire(Wire), 1.0 / 60.0, Predicted.Vehicle(), *Floor);
		bSame = bSame && Bits(Mirror.x) == Bits(F32(Car.x)) && Bits(Mirror.y) == Bits(F32(Car.y)) && Bits(Mirror.yaw) == Bits(F32(Car.yaw)) &&
			Bits(Mirror.spin) == Bits(F32(Car.spin)) && Bits(Mirror.fuel) == Bits(F32(Car.fuel)) && Mirror.mstate == Car.mstate;
	}
	TestTrue(TEXT("the mirror step is the pure step, bit for bit"), bSame);
	TestTrue(TEXT("the car drove, turned and burned fuel"), Mirror.x > 100.f && Mirror.fuel < 1.f);
	TestEqual(TEXT("a vehicle step never touches pitch"), Mirror.pitch, 0.25f);
	// +moveX turns toward −yaw (§17.7); Make Vehicle Input's Steer is the Unreal screen's (+1 right, +Yaw).
	genex::VehicleBody Turn;
	Turn.mstate = 1;
	Turn.vx = 800;
	for (int32 I = 0; I < 30; ++I) Turn = genex::presets::StepVehicle(Turn, 1.0, 1.0, 0.0, 1.0 / 60.0, Predicted.Vehicle(), *Floor);
	TestTrue(TEXT("moveX = +1 turns toward -yaw"), Turn.yaw < -0.1);
	const FGenexAuthorityInput Right = UGenexAuthoritySubsystem::MakeVehicleInput(1.f, 1.f, 2);
	TestTrue(TEXT("Make Vehicle Input: Steer +1 (right on screen, +Yaw) is moveX -1, the throttle moveY"), Right.MoveX == -1.f && Right.MoveY == 1.f && Right.Buttons == 2);
	// A non-finite axis is 0, as §17.7 and the server's sanitizeInput read it (FMath::Clamp turns a NaN into
	// its upper bound: full throttle, full steer).
	const float Bad[] = {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity()};
	bool bZero = true;
	for (const float B : Bad)
	{
		const FGenexAuthorityInput Throttle = UGenexAuthoritySubsystem::MakeVehicleInput(B, 0.5f, 0);
		const FGenexAuthorityInput Steer = UGenexAuthoritySubsystem::MakeVehicleInput(0.5f, B, 0);
		bZero = bZero && Throttle.MoveY == 0.f && Throttle.MoveX == -0.5f && Steer.MoveX == 0.f && !std::signbit(Steer.MoveX) && Steer.MoveY == 0.5f;
	}
	TestTrue(TEXT("Make Vehicle Input: a NaN or infinite Throttle or Steer is 0, the other axis kept"), bZero);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexSchemaTest, "Genex.Multiplayer.Schema",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexSchemaTest::RunTest(const FString&)
{
	using namespace genex::authority_wire;
	auto Names = [](const colyseus_schema_vtable_t& V) {
		FString Out;
		for (int32 I = 0; I < V.field_count; ++I) Out += (I ? TEXT(",") : TEXT("")) + FString(UTF8_TO_TCHAR(V.fields[I].name));
		return Out;
	};
	// Wire order (packages/multiplayer/src/authority/schema.ts): appended only, never reordered. §17.10
	// appended the body fields (qx … sleep), `physics`, `lengthUnit` and `bodies`; §17.11 `rest`, the
	// players' in* fields, `physDesc`, `keyframe`, `shapes` and `joints`; then the input's `tick` (tick@1), the
	// players' inRep, inStarve and inBuf, the room's `lifts` and `matchKey`.
	TestEqual(TEXT("AuthorityInput"), Names(AuthorityInput_vtable), FString(TEXT("moveX,moveY,moveZ,yaw,pitch,buttons,tick")));
	TestEqual(TEXT("AuthorityEntity"), Names(AuthorityEntity_vtable), FString(TEXT("kind,owner,x,y,z,vx,vy,vz,yaw,hp,flags,epoch,data,t0,g,src,pitch,duck,mstate,cap,spin,fuel,qx,qy,qz,qw,lvx,lvy,lvz,avx,avy,avz,sleep,rest")));
	TestEqual(TEXT("AuthorityPlayer"), Names(AuthorityPlayer_vtable), FString(TEXT("name,uid,team,connected,avatarUrl,seqBase,inMoveX,inMoveY,inMoveZ,inYaw,inPitch,inButtons,inRep,inStarve,inBuf")));
	TestEqual(TEXT("AuthorityRoomState"), Names(AuthorityRoomState_vtable), FString(TEXT("players,entities,tick,clockOrigin,preset,moduleSha,tickOrigin,physics,lengthUnit,bodies,physDesc,keyframe,shapes,joints,lifts,matchKey")));
	for (const colyseus_schema_vtable_t* V : { &AuthorityInput_vtable, &AuthorityEntity_vtable, &AuthorityPlayer_vtable, &AuthorityRoomState_vtable })
	{
		for (int32 I = 0; I < V->field_count; ++I) TestEqual(FString::Printf(TEXT("%s field %d index"), UTF8_TO_TCHAR(V->name), I), V->fields[I].index, I);
		colyseus_schema_t* Instance = V->create();
		TestNotNull(FString::Printf(TEXT("%s creates"), UTF8_TO_TCHAR(V->name)), Instance);
		if (Instance) V->destroy(Instance);
	}
	TestEqual(TEXT("float32 fields are C floats"), AuthorityEntity_fields[2].type, COLYSEUS_FIELD_FLOAT32);
	TestTrue(TEXT("maps carry their child vtable"), AuthorityRoomState_fields[1].child_vtable == &AuthorityEntity_vtable);
	TestEqual(TEXT("a projectile's gravity is a C float"), AuthorityEntity_fields[14].type, COLYSEUS_FIELD_FLOAT32);
	TestEqual(TEXT("the tick origin is a float64"), AuthorityRoomState_fields[6].type, COLYSEUS_FIELD_FLOAT64);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexProjectileTest, "Genex.Multiplayer.Projectile",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexProjectileTest::RunTest(const FString&)
{
	// projectile.json (PROTOCOL.md §17.8): every sample of every case bit for bit, under UBT's flags. Its
	// order-fma-* cases land on another float32 when a multiply and an add are fused.
	using namespace GenexCoreTestsDetail;
	std::optional<genex::Json> File;
	if (!LoadVectors(*this, TEXT("projectile.json"), File)) return false;
	const genex::Json* Cases = File->Find("cases");
	if (!TestTrue(TEXT("cases"), Cases && Cases->IsArray())) return false;
	static const char* const Fields[] = {"x", "y", "z", "vx", "vy", "vz"};
	int32 Samples = 0, Exact = 0;
	FString First;
	for (std::size_t C = 0; C < Cases->Size(); ++C)
	{
		const genex::Json& Case = Cases->At(C);
		const genex::Json* L = Case.Find("launch");
		genex::ProjectileLaunch Launch;
		Launch.x = F32(Num(L, "x"));
		Launch.y = F32(Num(L, "y"));
		Launch.z = F32(Num(L, "z"));
		Launch.vx = F32(Num(L, "vx"));
		Launch.vy = F32(Num(L, "vy"));
		Launch.vz = F32(Num(L, "vz"));
		Launch.g = F32(Num(L, "g"));
		Launch.t0 = Num(L, "t0");
		const double TickHz = Num(&Case, "tickHz");
		const genex::Json* List = Case.Find("samples");
		for (std::size_t I = 0; List && I < List->Size(); ++I)
		{
			const genex::Json& S = List->At(I);
			const genex::ProjectileState At = genex::presets::ProjectileAt(Launch, Num(&S, "T"), TickHz);
			const double Got[] = {At.x, At.y, At.z, At.vx, At.vy, At.vz};
			const genex::Json* Want = S.Find("expect");
			bool bSame = true;
			for (int32 F = 0; F < 6; ++F) bSame = bSame && Bits(Got[F]) == Bits(Num(Want, Fields[F]));
			++Samples;
			if (bSame) ++Exact;
			else if (First.IsEmpty()) First = FString::Printf(TEXT("case %d sample %d: got (%.17g, %.17g, %.17g, %.17g)"), int32(C), int32(I), At.x, At.y, At.z, At.vz);
		}
	}
	AddInfo(FString::Printf(TEXT("projectile: %d/%d samples bit-exact"), Exact, Samples));
	UE_LOG(LogGenex, Display, TEXT("Genex.Multiplayer.Projectile: %d/%d samples bit-exact"), Exact, Samples);
	TestEqual(TEXT("every sample of projectile.json is bit-exact under UBT's flags") + (First.IsEmpty() ? FString() : TEXT(" (first: ") + First + TEXT(")")), Exact, Samples);
	TestEqual(TEXT("the file has its 292 samples"), Samples, 292);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexProjectilePredictionTest, "Genex.Multiplayer.ProjectilePrediction",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexProjectilePredictionTest::RunTest(const FString&)
{
	// The prediction's pure pieces (PROTOCOL.md §17.9), as the session uses them under UBT.
	using namespace GenexCoreTestsDetail;
	namespace gp = genex::presets;
	// Ids: <seat>.<seqBase + seq>.<n>, numbers as JavaScript prints them.
	TestEqual(TEXT("the first input's first launch"), FString(UTF8_TO_TCHAR(genex::AuthorityProjectileId("abc", 0, 1, 0).c_str())), FString(TEXT("abc.1.0")));
	TestEqual(TEXT("after a reconnect the sequence goes on from seqBase"), FString(UTF8_TO_TCHAR(genex::AuthorityProjectileId("abc", 120, 3, 1).c_str())), FString(TEXT("abc.123.1")));
	TestEqual(TEXT("a large sequence stays an integer"), FString(UTF8_TO_TCHAR(genex::AuthorityProjectileId("s", 4294967295.0, 1, 0).c_str())), FString(TEXT("s.4294967296.0")));
	// Launch values as the server writes them.
	TestEqual(TEXT("a launch value is a float32"), Bits(gp::LaunchNumber(0.1)), Bits(F32(0.1)));
	TestEqual(TEXT("a non-finite launch value is 0"), Bits(gp::LaunchNumber(std::numeric_limits<double>::quiet_NaN())), Bits(0.0));
	TestEqual(TEXT("-0 is written as 0"), Bits(gp::LaunchNumber(-0.0)), Bits(0.0));
	TestEqual(TEXT("gravity is clamped to 1000"), gp::LaunchGravity(5000.0), 1000.0);
	TestEqual(TEXT("negative gravity is 0"), gp::LaunchGravity(-1.0), 0.0);
	// The room clock: tick n's instant and back.
	TestEqual(TEXT("serverTick"), gp::ServerTick(1500.0, 500.0, 30.0), 30.0);
	TestEqual(TEXT("tickInstant"), gp::TickInstant(30.0, 500.0, 30.0), 1500.0);
	TestEqual(TEXT("a lead in ticks"), genex::AuthorityLeadTicks(100.0, 30.0), 3.0);
	// The hand-off: a prediction fired at fractional tick 100.4 and the server's launch of it at tick 103
	// (its lead: 2.6 ticks). Drawn `lead` ahead, the server's flight continues the prediction's: the same
	// point, to float32 rounding, at every instant after the hand-off.
	genex::ProjectileLaunch Local;
	Local.x = 1.0;
	Local.y = -2.0;
	Local.z = 0.5;
	Local.vx = F32(12.3);
	Local.vy = F32(-7.7);
	Local.vz = F32(4.0);
	Local.g = F32(9.8);
	Local.t0 = 100.4;
	genex::ProjectileLaunch Server = Local;
	Server.t0 = 103.0;
	const double Hz = 30.0;
	const double LeadMs = gp::TickInstant(Server.t0, 250.0, Hz) - gp::TickInstant(Local.t0, 250.0, Hz);
	const double LeadTicks = genex::AuthorityLeadTicks(LeadMs, Hz);
	double Worst = 0.0;
	for (double Tick = 103.5; Tick < 160.0; Tick += 0.37)
	{
		const genex::ProjectileState A = gp::ProjectileAt(Local, Tick, Hz);
		const genex::ProjectileState B = gp::ProjectileAt(Server, Tick + LeadTicks, Hz);
		Worst = FMath::Max(Worst, FMath::Max3(FMath::Abs(A.x - B.x), FMath::Abs(A.y - B.y), FMath::Abs(A.z - B.z)));
	}
	TestTrue(FString::Printf(TEXT("drawn lead ahead, the server's flight continues the prediction's (worst %.3g)"), Worst), Worst <= 1e-4);
	const genex::ProjectileState NoLead = gp::ProjectileAt(Server, 120.0, Hz);
	const genex::ProjectileState Predicted = gp::ProjectileAt(Local, 120.0, Hz);
	TestTrue(TEXT("without the lead it would snap back by lead × velocity"), FMath::Abs(NoLead.x - Predicted.x) > 1.0);
	// Before its launch a projectile sits at its origin; a non-finite tick too.
	const genex::ProjectileState Early = gp::ProjectileAt(Server, 50.0, Hz);
	TestTrue(TEXT("before its launch it sits at its origin"), Early.x == Server.x && Early.y == Server.y && Early.z == F32(Server.z));
	const genex::ProjectileState Bad = gp::ProjectileAt(Server, std::numeric_limits<double>::quiet_NaN(), Hz);
	TestTrue(TEXT("a non-finite tick is its origin"), Bad.x == Server.x && Bad.vz == Server.vz);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexOfflineTest, "Genex.Multiplayer.Offline",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexOfflineTest::RunTest(const FString&)
{
	// JSON: strict, bounded.
	std::string Deep(200, '[');
	Deep += std::string(200, ']');
	TestFalse(TEXT("a depth bomb is refused"), genex::Json::Parse(Deep).has_value());
	TestFalse(TEXT("a trailing comma is refused"), genex::Json::Parse("[1,]").has_value());
	TestFalse(TEXT("NaN is not JSON"), genex::Json::Parse("NaN").has_value());
	TestFalse(TEXT("a lone surrogate is refused"), genex::Json::Parse("\"\\ud800\"").has_value());
	TestEqual(TEXT("numbers print as JavaScript does"), FString(UTF8_TO_TCHAR(genex::Json::Parse("[1e21,1e-7,-0,0.1]")->Dump().c_str())), FString(TEXT("[1e+21,1e-7,0,0.1]")));
	// msgpack: never int64 on the wire (PROTOCOL.md §1).
	std::vector<uint8_t> Out;
	TestTrue(TEXT("encode an epoch-ms number"), genex::EncodeMsgpack(genex::Json(1761235200000.0), Out, nullptr));
	TestEqual(TEXT("an integer past 32 bits goes out as float64 (0xcb)"), int32(Out.empty() ? 0 : Out[0]), 0xcb);
	// URLs: only this machine is loopback.
	TestTrue(TEXT("ws://127.0.0.1:2567 is loopback"), genex::IsLoopbackUrl("ws://127.0.0.1:2567"));
	TestTrue(TEXT("ws://[::1]:2567 is loopback"), genex::IsLoopbackUrl("ws://[::1]:2567"));
	TestFalse(TEXT("a look-alike host is not"), genex::IsLoopbackUrl("ws://127.0.0.1.evil.example:2567"));
	TestFalse(TEXT("userinfo is not"), genex::IsLoopbackUrl("ws://evil@127.0.0.1:2567"));
	TestFalse(TEXT("http is not"), genex::IsLoopbackUrl("http://127.0.0.1:2567"));
	// A sign-in answer's URLs.
	std::optional<genex::Json> Answer = genex::Json::Parse(R"({"colyseus":{"urls":["","wss://ok"],"authorityUrls":"wss://not-a-list"}})");
	const genex::SignInUrls Urls = genex::ColyseusUrls(*Answer);
	TestTrue(TEXT("only non-empty strings; a non-list is no list"), Urls.relay.size() == 1 && Urls.relay[0] == "wss://ok" && Urls.authority.empty());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexTransportDefaultTest, "Genex.Multiplayer.TransportDefault",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)

bool FGenexTransportDefaultTest::RunTest(const FString&)
{
	// PROTOCOL.md §17.12: a game that sets nothing is on UDP; the WebSocket is the fallback.
	TestTrue(TEXT("the fast channel is on unless the game turns it off"), FGenexAuthorityOptions().bFastChannel);
	return true;
}

#endif
