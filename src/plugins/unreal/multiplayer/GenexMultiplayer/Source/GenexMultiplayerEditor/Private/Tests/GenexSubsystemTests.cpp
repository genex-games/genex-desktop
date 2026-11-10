// Genex.Multiplayer.UObject.*: the UObject layer (subsystems, async nodes, the editor's authority URL
// handoff) in a game instance of its own, with the sign-in doors answered by a fake HTTP transport and
// a test clock, so nothing reaches a real API and a sign-in can be held open while the test acts.
// Sessions these rows start point at a closed port on this machine (ws://127.0.0.1:1) and are torn down
// with the game instance before any frame pumps them.
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GenexAsyncActions.h"
#include "GenexAuthoritySubsystem.h"
#include "GenexCollisionWorld.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexAuthoritySession.h"
#include "GenexCore/GenexHttp.h"
#include "GenexCore/GenexInterp.h"
#include "GenexCore/GenexJson.h"
#include "GenexIdentitySubsystem.h"
#include "GenexLocalAuthority.h"
#include "GenexMultiplayerModule.h"
#include "GenexMultiplayerSubsystem.h"
#include "GenexSettings.h"
#include "HAL/PlatformMisc.h"
#include "Tests/GenexTestListener.h"

#include <limits>
#include <string>

namespace GenexSubsystemTestsDetail
{
/** A game instance of its own (InitializeStandalone: a dummy world, every subsystem initialized). */
struct FTestGame
{
	UGameInstance* Instance = nullptr;

	FTestGame()
	{
		Instance = NewObject<UGameInstance>(GEngine);
		Instance->AddToRoot();
		Instance->InitializeStandalone();
	}
	~FTestGame()
	{
		UWorld* World = Instance->GetWorld();
		Instance->Shutdown();
		if (World)
		{
			GEngine->DestroyWorldContext(World);
			World->DestroyWorld(false);
		}
		Instance->RemoveFromRoot();
	}
	UWorld* World() const { return Instance->GetWorld(); }
	UGenexIdentitySubsystem* Identity() const { return Instance->GetSubsystem<UGenexIdentitySubsystem>(); }
	UGenexMultiplayerSubsystem* Relay() const { return Instance->GetSubsystem<UGenexMultiplayerSubsystem>(); }
	UGenexAuthoritySubsystem* Authority() const { return Instance->GetSubsystem<UGenexAuthoritySubsystem>(); }
};

/** An IHttp that holds every request until the test answers it. */
class FFakeHttp final : public genex::IHttp
{
public:
	struct FCall
	{
		genex::HttpRequest Request;
		genex::HttpDone Done;
	};
	TArray<FCall> Calls;
	int32 Sent = 0;

	virtual void Send(genex::HttpRequest Request, genex::HttpDone Done) override
	{
		++Sent;
		Calls.Add(FCall{ std::move(Request), std::move(Done) });
	}
	int32 Pending(const char* Path) const
	{
		int32 N = 0;
		for (const FCall& Call : Calls) N += EndsWith(Call.Request.url, Path) ? 1 : 0;
		return N;
	}
	/** Answer the oldest request to `Path`; false when none waits. */
	bool Answer(const char* Path, int Status, const std::string& Body)
	{
		for (int32 I = 0; I < Calls.Num(); ++I)
		{
			if (!EndsWith(Calls[I].Request.url, Path)) continue;
			genex::HttpDone Done = std::move(Calls[I].Done);
			Calls.RemoveAt(I);
			genex::HttpResponse Response;
			Response.status = Status;
			Response.body = Body;
			Done(std::move(Response));
			return true;
		}
		return false;
	}

private:
	static bool EndsWith(const std::string& Url, const char* Path)
	{
		const std::string Tail(Path);
		return Url.size() >= Tail.size() && Url.compare(Url.size() - Tail.size(), Tail.size(), Tail) == 0;
	}
};

constexpr const char* Guest = "/api/embed/guest-session";
constexpr const char* Ticket = "/api/embed/session";
constexpr const char* Device = "/api/embed/device";
constexpr const char* Refresh = "/api/embed/session/refresh";
const TCHAR* ClosedRelay = TEXT("ws://127.0.0.1:1");

std::string SignedIn(const char* Token, const char* AuthorityUrl = "ws://127.0.0.1:1")
{
	return std::string(R"({"embedToken":")") + Token + R"(","user":{"id":"u-1","name":"Ann"},"colyseus":{"urls":["ws://127.0.0.1:1"],"authorityUrls":[")" + AuthorityUrl + R"("]}})";
}

std::string DeviceCode(const char* Code)
{
	return std::string(R"({"deviceCode":")") + Code + R"(","userCode":"ABCD-EFGH","verificationUri":"https://genex.games/device","expiresIn":600,"interval":3})";
}

FGenexRoomOptions RelayOptions(bool bSignIn)
{
	FGenexRoomOptions Options;
	Options.GameId = TEXT("unreal-uobject-test");
	Options.RelayUrls.Add(ClosedRelay);
	Options.bSignInAutomatically = bSignIn;
	return Options;
}

UGenexTestListener* Listener()
{
	UGenexTestListener* L = NewObject<UGenexTestListener>();
	L->AddToRoot();
	return L;
}

/** The process environment's GENEX_AUTHORITY_URL and the project's AuthorityUrl, put back on scope exit. */
struct FAuthorityUrlScope
{
	FString Env;
	FString Setting;
	FAuthorityUrlScope()
	{
		Env = FPlatformMisc::GetEnvironmentVariable(TEXT("GENEX_AUTHORITY_URL"));
		Setting = GetDefault<UGenexSettings>()->AuthorityUrl;
		FPlatformMisc::SetEnvironmentVar(TEXT("GENEX_AUTHORITY_URL"), TEXT(""));
		GetMutableDefault<UGenexSettings>()->AuthorityUrl.Reset();
	}
	~FAuthorityUrlScope()
	{
		FPlatformMisc::SetEnvironmentVar(TEXT("GENEX_AUTHORITY_URL"), *Env);
		GetMutableDefault<UGenexSettings>()->AuthorityUrl = Setting;
	}
};
}

using namespace GenexSubsystemTestsDetail;

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexLeaveDuringSignInTest, "Genex.Multiplayer.UObject.LeaveDuringSignIn",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexLeaveDuringSignInTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	Game.Relay()->Join(RelayOptions(true));
	TestEqual(TEXT("relay: the join waits on a guest sign-in"), Http.Pending(Guest), 1);
	Game.Relay()->Leave();
	Http.Answer(Guest, 200, SignedIn("tok-relay"));
	TestNull(TEXT("relay: a Leave during the sign-in cancels the join"), Game.Relay()->Core());
	TestTrue(TEXT("relay: closed after the Leave"), Game.Relay()->GetStatus() == EGenexStatus::Closed);

	Game.Identity()->SetTransport(&Http); // signed out again
	FAuthorityUrlScope Urls;
	FGenexAuthorityOptions Options;
	Options.GameId = TEXT("unreal-uobject-test");
	Options.Url = TEXT("ws://genex-test.invalid:9");
	Game.Authority()->Join(Options);
	TestEqual(TEXT("authority: the join waits on a guest sign-in"), Http.Pending(Guest), 1);
	Game.Authority()->Leave();
	Http.Answer(Guest, 200, SignedIn("tok-authority"));
	TestNull(TEXT("authority: a Leave during the sign-in cancels the join"), Game.Authority()->Core());
	TestTrue(TEXT("authority: closed after the Leave"), Game.Authority()->GetStatus() == EGenexStatus::Closed);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexAuthorityUrlAfterSignInTest, "Genex.Multiplayer.UObject.AuthorityUrlAfterSignIn",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexAuthorityUrlAfterSignInTest::RunTest(const FString&)
{
	FAuthorityUrlScope Urls;
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	FGenexAuthorityOptions Options;
	Options.GameId = TEXT("unreal-uobject-test");
	// Nothing names a server, nobody is signed in: the sign-in answer is where the cluster comes from.
	Game.Authority()->Join(Options);
	TestEqual(TEXT("a join that names no server signs in first"), Http.Pending(Guest), 1);
	TestEqual(TEXT("and is not refused before it did"), Game.Authority()->GetLastError(), FString());
	Http.Answer(Guest, 200, SignedIn("tok-1", "ws://127.0.0.1:1"));
	genex::AuthoritySession* Session = Game.Authority()->Core();
	TestNotNull(TEXT("the join goes on after the sign-in"), Session);
	if (Session) TestEqual(TEXT("to the answer's authorityUrls"), FString(UTF8_TO_TCHAR(Session->Url().c_str())), FString(TEXT("ws://127.0.0.1:1")));

	// A development URL in the environment yields to the cluster the sign-in answers (header precedence).
	FPlatformMisc::SetEnvironmentVar(TEXT("GENEX_AUTHORITY_URL"), TEXT("ws://genex-dev.invalid:9"));
	Game.Identity()->SetTransport(&Http);
	Game.Authority()->Join(Options);
	TestEqual(TEXT("an unsigned join to a remote development server signs in first"), Http.Pending(Guest), 1);
	Http.Answer(Guest, 200, SignedIn("tok-2", "ws://127.0.0.1:1"));
	Session = Game.Authority()->Core();
	TestNotNull(TEXT("the second join goes on"), Session);
	if (Session) TestEqual(TEXT("the answer's authorityUrls win over GENEX_AUTHORITY_URL"), FString(UTF8_TO_TCHAR(Session->Url().c_str())), FString(TEXT("ws://127.0.0.1:1")));

	// A server on this machine needs no sign-in.
	FPlatformMisc::SetEnvironmentVar(TEXT("GENEX_AUTHORITY_URL"), TEXT("ws://127.0.0.1:1"));
	Game.Identity()->SetTransport(&Http);
	const int32 SentBefore = Http.Sent;
	Game.Authority()->Join(Options);
	TestEqual(TEXT("a local server joins without signing in"), Http.Sent, SentBefore);
	TestNotNull(TEXT("the local join started"), Game.Authority()->Core());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexMergedSignInTest, "Genex.Multiplayer.UObject.MergedSignIn",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexMergedSignInTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	FGenexMultiplayerModule::SetLaunchTicketForTests(FString(TEXT("ticket-1")));
	TSharedRef<int32> Ok = MakeShared<int32>(0);
	TSharedRef<int32> Failed = MakeShared<int32>(0);
	auto Done = [Ok, Failed]() {
		return FGenexSignInDone::CreateLambda([Ok, Failed](bool bOk, int32, const FString&) { ++*(bOk ? Ok : Failed); });
	};
	Game.Identity()->SignInAutomatically(Done());
	Game.Identity()->SignInAutomatically(Done());
	TestEqual(TEXT("two automatic sign-ins at once send one request"), Http.Sent, 1);
	TestEqual(TEXT("the launcher's ticket"), Http.Pending(Ticket), 1);
	TestEqual(TEXT("no guest beside it"), Http.Pending(Guest), 0);
	Http.Answer(Ticket, 200, SignedIn("tok-launcher"));
	TestEqual(TEXT("both callers hear the one answer"), *Ok, 2);
	TestEqual(TEXT("neither failed"), *Failed, 0);
	TestFalse(TEXT("the launcher's player, not a guest"), Game.Identity()->IsGuest());

	// The relay and authority joins a game starts together share it too.
	Game.Identity()->SetTransport(&Http);
	FGenexMultiplayerModule::SetLaunchTicketForTests(FString(TEXT("ticket-2")));
	FAuthorityUrlScope Urls;
	const int32 SentBefore = Http.Sent;
	Game.Relay()->Join(RelayOptions(true));
	FGenexAuthorityOptions Options;
	Options.GameId = TEXT("unreal-uobject-test");
	Game.Authority()->Join(Options);
	TestEqual(TEXT("relay + authority joins send one sign-in"), Http.Sent - SentBefore, 1);
	Http.Answer(Ticket, 200, SignedIn("tok-both"));
	TestNotNull(TEXT("the relay join went on"), Game.Relay()->Core());
	TestNotNull(TEXT("the authority join went on"), Game.Authority()->Core());
	FGenexMultiplayerModule::SetLaunchTicketForTests(TOptional<FString>());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexSignInNodesTest, "Genex.Multiplayer.UObject.SignInNodes",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexSignInNodesTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	auto Node = [&Game](UGenexTestListener* L) {
		UGenexSignInAction* N = UGenexSignInAction::SignInWithDeviceCode(Game.World());
		N->SignedIn.AddDynamic(L, &UGenexTestListener::OnSignedIn);
		N->Failed.AddDynamic(L, &UGenexTestListener::OnFailed);
		N->ShowCode.AddDynamic(L, &UGenexTestListener::OnCode);
		N->Activate();
		return N;
	};
	UGenexTestListener* First = Listener();
	UGenexTestListener* Second = Listener();
	UGenexTestListener* Third = Listener();
	Node(First);
	Http.Answer(Device, 200, DeviceCode("dc-1"));
	TestEqual(TEXT("the first node shows its code"), First->Codes, 1);
	Node(Second);
	TestEqual(TEXT("a second device node does not fail on the first one's cancel"), Second->Failures, 0);
	TestEqual(TEXT("the first node ends: its sign-in was replaced"), First->Failures, 1);
	Http.Answer(Device, 200, DeviceCode("dc-2"));
	TestEqual(TEXT("the second node shows its own code"), Second->Codes, 1);

	// A join's automatic guest sign-in (refused: a draft) is not the device node's answer.
	Game.Identity()->SetTransport(&Http);
	Node(Third);
	Http.Answer(Device, 200, DeviceCode("dc-3"));
	Game.Relay()->Join(RelayOptions(true));
	Http.Answer(Guest, 404, R"({"error":"not_found"})");
	TestEqual(TEXT("the device node did not fail on the join's guest 404"), Third->Failures, 0);
	TestEqual(TEXT("nor sign in on it"), Third->Successes, 0);
	Game.Identity()->CancelDeviceSignIn();
	for (UGenexTestListener* L : { First, Second, Third }) L->RemoveFromRoot();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexNodesEndTest, "Genex.Multiplayer.UObject.NodesEnd",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexNodesEndTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	auto JoinNode = [&Game](UGenexTestListener* L, const FGenexRoomOptions& Options) {
		UGenexJoinRoomAction* N = UGenexJoinRoomAction::JoinGenexRoom(Game.World(), Options);
		N->Joined.AddDynamic(L, &UGenexTestListener::OnId);
		N->Failed.AddDynamic(L, &UGenexTestListener::OnFailed);
		N->Activate();
		return N;
	};
	// Join Genex Room, then Leave while it signs in.
	UGenexTestListener* Left = Listener();
	JoinNode(Left, RelayOptions(true));
	Game.Relay()->Leave();
	TestEqual(TEXT("Join Genex Room fails when the game leaves during its sign-in"), Left->Failures, 1);
	Http.Answer(Guest, 200, SignedIn("tok-1"));
	TestEqual(TEXT("and stays failed"), Left->Successes, 0);

	// Join Genex Room replaced by a newer join (which fails at once): the old node ends on its own.
	UGenexTestListener* Old = Listener();
	UGenexTestListener* New = Listener();
	JoinNode(Old, RelayOptions(false));
	TestNotNull(TEXT("the first join started a session"), Game.Relay()->Core());
	FGenexRoomOptions Bad = RelayOptions(false);
	Bad.ExtraOptionsJson = TEXT("[1]");
	JoinNode(New, Bad);
	TestEqual(TEXT("the replaced node fails"), Old->Failures, 1);
	TestFalse(TEXT("with its own reason, not the newer join's"), Old->LastMessage.Contains(TEXT("ExtraOptionsJson")));
	TestEqual(TEXT("the newer node fails with its reason"), New->Failures, 1);

	// Claim Control waiting on a session a new Join replaces.
	UGenexTestListener* Claim = Listener();
	Game.Relay()->Join(RelayOptions(false));
	UGenexClaimControlAction* C = UGenexClaimControlAction::ClaimControl(Game.World(), TEXT("door"), false);
	C->Granted.AddDynamic(Claim, &UGenexTestListener::OnControl);
	C->Refused.AddDynamic(Claim, &UGenexTestListener::OnControl);
	C->Activate();
	TestEqual(TEXT("the claim waits for the relay"), Claim->Failures + Claim->Successes, 0);
	Game.Relay()->Join(RelayOptions(false));
	TestEqual(TEXT("Claim Control is refused when a Join replaces its session"), Claim->Failures, 1);

	// Join Genex Authority, then Leave before the room is ready.
	FAuthorityUrlScope Urls;
	UGenexTestListener* Authority = Listener();
	FGenexAuthorityOptions Options;
	Options.GameId = TEXT("unreal-uobject-test");
	Options.Url = ClosedRelay;
	UGenexJoinAuthorityAction* A = UGenexJoinAuthorityAction::JoinGenexAuthority(Game.World(), Options);
	A->Connected.AddDynamic(Authority, &UGenexTestListener::OnId);
	A->Refused.AddDynamic(Authority, &UGenexTestListener::OnRefused);
	A->Activate();
	TestNotNull(TEXT("the authority join started"), Game.Authority()->Core());
	Game.Authority()->Leave();
	TestEqual(TEXT("Join Genex Authority ends when the game leaves before Ready"), Authority->Failures, 1);
	for (UGenexTestListener* L : { Left, Old, New, Claim, Authority }) L->RemoveFromRoot();
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexRelayTokenTest, "Genex.Multiplayer.UObject.RelayToken",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexRelayTokenTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	TSharedRef<double> Now = MakeShared<double>(1.0e6);
	Game.Identity()->SetTransport(&Http, [Now]() { return *Now; });
	Game.Identity()->SignInAsGuest();
	Http.Answer(Guest, 200, SignedIn("tok-1"));
	Game.Relay()->Join(RelayOptions(true));
	FString Token, Error;
	TestTrue(TEXT("the session's first join reads the identity's token"), Game.Relay()->PeekJoinToken(Token, Error));
	TestEqual(TEXT("tok-1"), Token, FString(TEXT("tok-1")));

	*Now += 10.0 * 60000.0;
	TestTrue(TEXT("10 minutes on, a join still has a valid token"), Game.Relay()->PeekJoinToken(Token, Error));
	TestEqual(TEXT("and a refresh is asked for"), Http.Pending(Refresh), 1);
	Http.Answer(Refresh, 200, R"({"embedToken":"tok-2"})");
	Game.Relay()->PeekJoinToken(Token, Error);
	TestEqual(TEXT("a later join (a requeue, a re-search) sends the refreshed token"), Token, FString(TEXT("tok-2")));

	*Now += 16.0 * 60000.0;
	TestFalse(TEXT("a token past its 15 minutes is never sent"), Game.Relay()->PeekJoinToken(Token, Error));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexLocationYawTest, "Genex.Multiplayer.UObject.LocationYaw",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexLocationYawTest::RunTest(const FString&)
{
	// A pawn turning from 170 to 190 degrees (published as 170 .. 180, then -179 .. -170), drawn by
	// another client through the relay session's own interpolation.
	genex::Interpolator Interp;
	const double T0 = 10000.0;
	const int32 Samples = 61;
	for (int32 K = 0; K < Samples; ++K)
	{
		float Yaw = 170.f + 20.f * K / (Samples - 1);
		if (Yaw > 180.f) Yaw -= 360.f;
		genex::Json State;
		if (!TestTrue(TEXT("the location state builds"), UGenexMultiplayerSubsystem::LocationState(FVector(100.0 * K, 0.0, 0.0), Yaw, TEXT("{}"), State))) return false;
		const double Sent = T0 + 33.0 * K;
		Interp.Push("p", "sender", Sent, std::move(State), Sent + 40.0);
	}
	int32 Drawn = 0;
	float Worst = 0.f;
	for (double At = T0 + 400.0; At <= T0 + 33.0 * (Samples - 1); At += 5.0)
	{
		std::optional<genex::Json> V = Interp.Sample("p", At);
		FVector Location;
		float Yaw = 0.f;
		if (!V || !UGenexMultiplayerSubsystem::ReadLocation(*V, Location, Yaw)) continue;
		++Drawn;
		Worst = FMath::Max(Worst, FMath::Abs(FMath::FindDeltaAngleDegrees(Yaw, 180.f)));
	}
	TestTrue(TEXT("frames were drawn"), Drawn > 50);
	TestTrue(FString::Printf(TEXT("the drawn yaw stays within the turn's 10 degrees of 180, never sweeping the long way (worst %.1f)"), Worst), Worst <= 11.f);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexCollisionWorldTest, "Genex.Multiplayer.UObject.CollisionWorld",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexCollisionWorldTest::RunTest(const FString&)
{
	// A world in Unreal units (an asset, arrays) hashes to the room module's: the conversion recovers every
	// float32 Genex value exactly, the vectors' "fractional" world (values with odd float32 bits) included.
	const char* const Fractional = R"({"boxes":[[0.10000000149011612,-1.0000000116860974e-7,-123456.7890625,1000000000,0.30000001192092896,1.5]],"ramps":[[-0.25,0.5,-3.75,7.125,2.0625,9.5,0,9.5,-1.25]]})";
	const char* const Arena = R"({"boxes":[[-1024,-1024,-64,1024,1024,0],[-320,-320,0,320,320,16],[-800,-128,56,-560,128,96]],"ramps":[[400,-160,0,592,160,96,0,0,96]]})";
	for (const char* Spec : {Fractional, Arena})
	{
		const genex::FirstpersonWorldPtr Truth = genex::FirstpersonWorld::FromJsonText(Spec);
		if (!TestNotNull(TEXT("the module's world is accepted"), Truth.get())) return false;
		FString Error;
		UGenexCollisionWorld* Asset = UGenexCollisionWorld::FromWorldJson(UTF8_TO_TCHAR(Spec), Error);
		if (!TestNotNull(FString::Printf(TEXT("the asset is made (%s)"), *Error), Asset)) return false;
		TestEqual(TEXT("the asset (Unreal units) hashes to the module's world"), Asset->GetWorldHash(Error), static_cast<int64>(Truth->Hash()));
		FTestGame Game;
		int64 Hash = -1;
		TestTrue(TEXT("Set World From Asset accepts it"), Game.Authority()->SetWorldFromAsset(Asset, Hash, Error));
		TestEqual(TEXT("its hash"), Hash, static_cast<int64>(Truth->Hash()));
		TestEqual(TEXT("Get World Hash"), Game.Authority()->GetWorldHash(), static_cast<int64>(Truth->Hash()));
		TestTrue(TEXT("Set World (arrays) gives the same hash"), Game.Authority()->SetWorld(Asset->Boxes, Asset->Ramps, Hash, Error) && Hash == static_cast<int64>(Truth->Hash()));
		TestTrue(TEXT("Set World From Json (Genex units) gives the same hash"), Game.Authority()->SetWorldFromJson(UTF8_TO_TCHAR(Spec), Hash, Error) && Hash == static_cast<int64>(Truth->Hash()));
		const FGenexPredictionStatus Status = Game.Authority()->GetPredictionStatus();
		TestTrue(TEXT("before a join: not predicting, no entity, this client's world, no room world"), !Status.bPredicting && Status.Reason == TEXT("no_entity") && Status.World == static_cast<int64>(Truth->Hash()) && Status.RoomWorld == -1);
		// A refused world changes nothing.
		TArray<FGenexWorldBox> Bad;
		Bad.AddDefaulted();  // min = max on every axis
		TestFalse(TEXT("a box with min >= max is refused"), Game.Authority()->SetWorld(Bad, {}, Hash, Error));
		TestTrue(FString::Printf(TEXT("with the reason (%s), and the world kept"), *Error), !Error.IsEmpty() && Game.Authority()->GetWorldHash() == static_cast<int64>(Truth->Hash()));
	}
	FString Error;
	TestNull(TEXT("a world past the limits is refused as an asset"), UGenexCollisionWorld::FromWorldJson(TEXT("{\"boxes\":[[0,0,0,0.1,1,1]]}"), Error));
	// Camera-relative keys turned into world axes by the view's yaw (Unreal: X forward, Y right, Z up).
	const FGenexAuthorityInput North = UGenexAuthoritySubsystem::MakeFirstpersonInput(1.f, 0.f, FRotator(0.f, 90.f, 0.f), 2);
	TestTrue(TEXT("forward at yaw 90 is +Y"), FMath::Abs(North.MoveX) < 1e-6f && FMath::Abs(North.MoveY - 1.f) < 1e-6f && North.Buttons == 2);
	const FGenexAuthorityInput Right = UGenexAuthoritySubsystem::MakeFirstpersonInput(0.f, 1.f, FRotator(0.f, 0.f, 0.f), 0);
	TestTrue(TEXT("right at yaw 0 is +Y"), FMath::Abs(Right.MoveX) < 1e-6f && FMath::Abs(Right.MoveY - 1.f) < 1e-6f);
	const FGenexAuthorityInput Diagonal = UGenexAuthoritySubsystem::MakeFirstpersonInput(1.f, 1.f, FRotator(45.f, 30.f, 0.f), 0);
	TestTrue(TEXT("a diagonal is at most length 1"), FMath::Abs(FMath::Sqrt(Diagonal.MoveX * Diagonal.MoveX + Diagonal.MoveY * Diagonal.MoveY) - 1.f) < 1e-5f);
	TestTrue(TEXT("the view's yaw and pitch go out in radians"), FMath::Abs(Diagonal.Yaw - FMath::DegreesToRadians(30.f)) < 1e-6f && FMath::Abs(Diagonal.Pitch - FMath::DegreesToRadians(45.f)) < 1e-6f);
	// A non-finite key is 0 (the server's sanitizeInput reads a non-finite axis as 0; FMath::Clamp would make it 1).
	const FGenexAuthorityInput NanForward = UGenexAuthoritySubsystem::MakeFirstpersonInput(std::numeric_limits<float>::quiet_NaN(), 0.f, FRotator(0.f, 0.f, 0.f), 0);
	const FGenexAuthorityInput InfRight = UGenexAuthoritySubsystem::MakeFirstpersonInput(1.f, std::numeric_limits<float>::infinity(), FRotator(0.f, 0.f, 0.f), 0);
	TestTrue(TEXT("a NaN Forward or an infinite Right is 0, the other key kept"),
		NanForward.MoveX == 0.f && NanForward.MoveY == 0.f && FMath::Abs(InfRight.MoveX - 1.f) < 1e-6f && FMath::Abs(InfRight.MoveY) < 1e-6f);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexRelayPlaceholderTest, "Genex.Multiplayer.UObject.RelayPlaceholder",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexRelayPlaceholderTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	FGenexRoomOptions Mixed = RelayOptions(false);
	Mixed.RelayUrls.Insert(TEXT("wss://relay.genex-test.invalid"), 0);
	Game.Relay()->Join(Mixed);
	TestNull(TEXT("a list with a remote relay never gets the local placeholder"), Game.Relay()->Core());
	TestTrue(FString::Printf(TEXT("the join fails as not signed in (%s)"), *Game.Relay()->GetLastError()), Game.Relay()->GetLastError().Contains(TEXT("not signed in")));
	Game.Relay()->Join(RelayOptions(false));
	TestNotNull(TEXT("a relay on this machine takes it"), Game.Relay()->Core());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexLoopbackTokenTest, "Genex.Multiplayer.UObject.LoopbackToken",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexLoopbackTokenTest::RunTest(const FString&)
{
	TestFalse(TEXT("a server on this machine never gets the player's token"), UGenexAuthoritySubsystem::SendsPlayerToken(TEXT("ws://127.0.0.1:2567"), {}));
	TestFalse(TEXT("[::1] neither"), UGenexAuthoritySubsystem::SendsPlayerToken(TEXT("ws://[::1]:2567"), {}));
	TestTrue(TEXT("a remote server does"), UGenexAuthoritySubsystem::SendsPlayerToken(TEXT("wss://authority.genex.games"), {}));
	TestTrue(TEXT("a cluster does"), UGenexAuthoritySubsystem::SendsPlayerToken(FString(), { TEXT("wss://a.genex.games"), TEXT("wss://b.genex.games") }));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexUnavailableTest, "Genex.Multiplayer.UObject.Unavailable",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexUnavailableTest::RunTest(const FString&)
{
	FTestGame Game;
	FFakeHttp Http;
	Game.Identity()->SetTransport(&Http);
	FAuthorityUrlScope Urls;
	FGenexMultiplayerModule::SetAvailableForTests(false);
	Game.Relay()->Join(RelayOptions(false));
	const bool bRelayRefused = Game.Relay()->Core() == nullptr && Game.Relay()->GetLastError().Contains(TEXT("unavailable"));
	FGenexAuthorityOptions Options;
	Options.GameId = TEXT("unreal-uobject-test");
	Options.Url = ClosedRelay;
	Game.Authority()->Join(Options);
	const bool bAuthorityRefused = Game.Authority()->Core() == nullptr && Game.Authority()->GetLastError().Contains(TEXT("unavailable"));
	FGenexMultiplayerModule::SetAvailableForTests(true);
	TestTrue(FString::Printf(TEXT("without the core a relay join is refused by name (%s)"), *Game.Relay()->GetLastError()), bRelayRefused);
	TestTrue(FString::Printf(TEXT("and an authority join (%s)"), *Game.Authority()->GetLastError()), bAuthorityRefused);
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexAuthorityUrlHandoffTest, "Genex.Multiplayer.UObject.AuthorityUrlHandoff",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexAuthorityUrlHandoffTest::RunTest(const FString&)
{
	const FString Saved = FPlatformMisc::GetEnvironmentVariable(FGenexLocalAuthority::UrlEnv);
	auto Env = []() { return FPlatformMisc::GetEnvironmentVariable(FGenexLocalAuthority::UrlEnv); };
	FPlatformMisc::SetEnvironmentVar(FGenexLocalAuthority::UrlEnv, TEXT("ws://127.0.0.1:4000"));
	FGenexAuthorityUrlHandoff Handoff;
	Handoff.Name(TEXT("ws://127.0.0.1:5000"));
	TestEqual(TEXT("the play joins Studio's server"), Env(), FString(TEXT("ws://127.0.0.1:5000")));
	Handoff.Name(TEXT("ws://127.0.0.1:5001"));
	Handoff.TakeBack();
	TestEqual(TEXT("the developer's own URL is back after the play"), Env(), FString(TEXT("ws://127.0.0.1:4000")));
	Handoff.TakeBack();
	TestEqual(TEXT("taking back twice changes nothing"), Env(), FString(TEXT("ws://127.0.0.1:4000")));
	FPlatformMisc::SetEnvironmentVar(FGenexLocalAuthority::UrlEnv, TEXT(""));
	Handoff.Name(TEXT("ws://127.0.0.1:5002"));
	Handoff.TakeBack();
	TestEqual(TEXT("unset before, unset after"), Env(), FString());
	FPlatformMisc::SetEnvironmentVar(FGenexLocalAuthority::UrlEnv, *Saved);
	return true;
}

#endif
