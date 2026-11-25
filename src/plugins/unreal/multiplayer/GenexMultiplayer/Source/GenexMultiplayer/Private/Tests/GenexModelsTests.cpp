// Genex.Multiplayer.Models and Genex.Multiplayer.UObject.Models: in-game model calls as Unreal Build Tool compiles
// them. The first holds GenexCore/GenexModels.h to the TypeScript bridge's shared vectors (packages/multiplayer/
// test/vectors/models-bridge.json), as genex_models_check does in the CMake build: every drain read back, the
// hostile drains, and the sentence for every code of the SDK's table. The second runs the subsystem in a game
// instance of its own, the API answered by a fake HTTP transport: Init signs the player in with the launcher's
// ticket, the budget they approved is found, a call under it settles, and what needs the approval window answers
// by code with no request. The calls' shapes, the waits and the hostile inputs are GenexCore's offline suite
// (sdks/unreal/core/tools/offline_models_http.cpp).
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GenexCore/GenexHttp.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexModels.h"
#include "GenexIdentitySubsystem.h"
#include "GenexModelsSubsystem.h"
#include "GenexMultiplayerModule.h"
#include "GenexSettings.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace GenexModelsTestsDetail
{
/** The repository's models vectors: GENEX_REPO_ROOT, else found above the project. Empty when neither has it. */
FString ModelsVectorsPath()
{
	const FString Rel = TEXT("packages/multiplayer/test/vectors/models-bridge.json");
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

/** An event as the bridge's JSON, so a drain can be compared with what was read from it. */
genex::Json ModelsEventJson(const genex::models::Event& E)
{
	genex::Json O = genex::Json::MakeObject();
	O.Set("id", E.id);
	switch (E.type)
	{
	case genex::models::Event::Type::Result:
		O.Set("type", "result");
		O.Set("call", E.call);
		O.Set("result", E.result);
		break;
	case genex::models::Event::Type::Rejected:
		O.Set("type", "rejected");
		O.Set("call", E.call);
		O.Set("error", E.error);
		break;
	case genex::models::Event::Type::Delta:
		O.Set("type", "delta");
		O.Set("text", E.text);
		O.Set("soFar", E.soFar);
		break;
	case genex::models::Event::Type::PartialField:
		O.Set("type", "partialField");
		O.Set("name", E.name);
		O.Set("text", E.text);
		break;
	case genex::models::Event::Type::Gesture:
		O.Set("type", "gesture");
		O.Set("call", E.call);
		O.Set("waiting", E.waiting);
		break;
	}
	return O;
}

/** A game instance of its own (InitializeStandalone: a dummy world, every subsystem initialized). */
struct FModelsTestGame
{
	UGameInstance* Instance = nullptr;

	FModelsTestGame()
	{
		Instance = NewObject<UGameInstance>(GEngine);
		Instance->AddToRoot();
		Instance->InitializeStandalone();
	}
	~FModelsTestGame()
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
};

struct FModelsEnd
{
	int32 Request = 0;
	FString Call;
	bool bRejected = false;
	FString Body;
};

/** An IHttp that holds every request until the test answers it. */
class FModelsFakeHttp final : public genex::IHttp
{
public:
	struct FCall
	{
		genex::HttpRequest Request;
		genex::HttpDone Done;
	};
	TArray<FCall> Calls;
	TArray<genex::HttpRequest> Sent;

	virtual void Send(genex::HttpRequest Request, genex::HttpDone Done) override
	{
		Sent.Add(Request);
		Calls.Add(FCall{ std::move(Request), std::move(Done) });
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
	/** The newest request sent: "<METHOD> <url>", and one of its headers ("" when it has none). */
	bool LastIs(const char* Method, const char* Path) const
	{
		return Sent.Num() > 0 && Sent.Last().method == Method && EndsWith(Sent.Last().url, Path);
	}
	std::string LastHeader(const char* Name) const
	{
		if (Sent.Num() == 0) return std::string();
		for (const genex::HttpHeader& Header : Sent.Last().headers)
		{
			if (Header.name == Name) return Header.value;
		}
		return std::string();
	}

private:
	static bool EndsWith(const std::string& Url, const char* Path)
	{
		const std::string Tail(Path);
		return Url.size() >= Tail.size() && Url.compare(Url.size() - Tail.size(), Tail.size(), Tail) == 0;
	}
};
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexModelsTest, "Genex.Multiplayer.Models",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::ClientContext | EAutomationTestFlags::EngineFilter)
bool FGenexModelsTest::RunTest(const FString&)
{
	using namespace GenexModelsTestsDetail;
	const FString Path = ModelsVectorsPath();
	if (!TestFalse(TEXT("the models vectors are found (set GENEX_REPO_ROOT, or run from the repository)"), Path.IsEmpty())) return false;
	FString Text;
	if (!TestTrue(TEXT("the vectors are read"), FFileHelper::LoadFileToString(Text, *Path))) return false;
	const std::optional<genex::Json> File = genex::Json::Parse(TCHAR_TO_UTF8(*Text));
	if (!TestTrue(TEXT("the vectors are JSON"), File.has_value())) return false;

	const genex::Json* Drains = File->Find("drains");
	if (!TestTrue(TEXT("the vectors have the session's drains"), Drains != nullptr && Drains->IsArray() && Drains->Size() >= 6)) return false;
	int32 Total = 0;
	int32 Frame = 0;
	for (const genex::Json& Drain : Drains->Items())
	{
		const std::vector<genex::models::Event> Events = genex::models::ReadEvents(Drain.Dump());
		genex::Json Read = genex::Json::MakeArray();
		for (const genex::models::Event& E : Events) Read.Push(ModelsEventJson(E));
		TestTrue(*FString::Printf(TEXT("the session's frame %d is read back field for field"), Frame), Read == Drain);
		Total += static_cast<int32>(Events.size());
		Frame += 1;
	}
	TestTrue(TEXT("the session has every kind of event"), Total >= 20);

	const genex::Json* Hostile = File->Find("hostileDrains");
	if (TestTrue(TEXT("the hostile drains are read"), Hostile != nullptr && Hostile->IsArray() && Hostile->Size() >= 20))
	{
		for (const genex::Json& Drain : Hostile->Items())
		{
			TestTrue(*FString::Printf(TEXT("no event from %s"), UTF8_TO_TCHAR(Drain.AsString().c_str())), genex::models::ReadEvents(Drain.AsString()).empty());
		}
	}

	const genex::Json* Native = File->Find("native");
	const genex::Json* Messages = Native != nullptr ? Native->Find("messages") : nullptr;
	if (TestTrue(TEXT("the vectors say what a native build answers"), Messages != nullptr))
	{
		const std::string Code(genex::models::kNativeUnsupported);
		const std::string Later = "a_code_from_next_year";
		const genex::Json* Unsupported = Messages->Find("native_unsupported");
		const genex::Json* General = Messages->Find("default");
		TestTrue(TEXT("the sentence for native_unsupported is the SDK's"), Unsupported != nullptr && genex::models::NativeErrorMessage(&Code) == Unsupported->AsString());
		TestTrue(TEXT("any other code reads as the SDK's general sentence"),
			General != nullptr && genex::models::NativeErrorMessage(nullptr) == General->AsString() && genex::models::NativeErrorMessage(&Later) == General->AsString());
		// The SDK's whole table, code by code, as this engine's compiler built it.
		const genex::Json* Sentences = Native->Find("sentences");
		if (TestTrue(TEXT("the vectors carry the SDK's sentence table"), Sentences != nullptr && Sentences->IsObject() && General != nullptr))
		{
			int32 Rows = 0;
			for (const genex::JsonMember& Member : Sentences->Members())
			{
				++Rows;
				const std::string Said = genex::models::NativeErrorMessage(&Member.key);
				if (!Member.value.IsString() || Said != Member.value.AsString() || Said == General->AsString())
				{
					AddError(FString::Printf(TEXT("the sentence for %s is not the SDK's"), UTF8_TO_TCHAR(Member.key.c_str())));
				}
			}
			TestTrue(TEXT("every code of the SDK's table was read"), Rows > 100);
		}
	}
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexModelsSubsystemTest, "Genex.Multiplayer.UObject.Models",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexModelsSubsystemTest::RunTest(const FString&)
{
	using namespace GenexModelsTestsDetail;
	// The transport outlives the game instance that sends through it.
	FModelsFakeHttp Http;
	FModelsTestGame Game;
	UGenexModelsSubsystem* Models = Game.Instance->GetSubsystem<UGenexModelsSubsystem>();
	UGenexIdentitySubsystem* Identity = Game.Instance->GetSubsystem<UGenexIdentitySubsystem>();
	if (!TestNotNull(TEXT("the game instance has the models subsystem"), Models)) return false;
	if (!TestNotNull(TEXT("and the identity subsystem it signs in through"), Identity)) return false;
	Identity->SetTransport(&Http);
	TestTrue(TEXT("model calls can work in this build"), Models->IsSupported());

	TArray<FModelsEnd> Ends;
	Models->OnEndedNative.AddLambda([&Ends](int32 Request, const FString& Call, bool bRejected, const FString& Body) {
		Ends.Add({Request, Call, bRejected, Body});
	});
	auto Find = [&Ends](int32 Request) -> const FModelsEnd* {
		return Ends.FindByPredicate([Request](const FModelsEnd& E) { return E.Request == Request; });
	};
	auto Settled = [&Find](int32 Request, const TCHAR* Call, const TCHAR* Body) {
		const FModelsEnd* End = Find(Request);
		return Request > 0 && End != nullptr && !End->bRejected && End->Call == Call && End->Body == Body;
	};
	const char* Ticket = "/api/embed/session";
	const char* Current = "/api/runtime/grants/current";
	const char* Generations = "/api/runtime/grants/grant_1/generations";

	// Genex started the game with a one-use ticket: Init redeems it, and a call made meanwhile waits for it.
	FGenexMultiplayerModule::SetLaunchTicketForTests(FString(TEXT("tkt-models-test")));
	const int32 Init = Models->Init(GetDefault<UGenexSettings>()->Slug);
	const int32 Budget = Models->GetActiveSpendGrant();
	TestTrue(TEXT("Init redeems the launcher's ticket"), Http.Sent.Num() == 1 && Http.LastIs("POST", Ticket));
	Models->Poll();
	TestEqual(TEXT("nothing settles before the sign-in answers"), Ends.Num(), 0);
	Http.Answer(Ticket, 200, R"({"embedToken":"tok-models-test","user":{"id":"u_1","name":"Ada"}})");
	TestTrue(TEXT("the call that waited goes out once the player is signed in"), Http.Sent.Num() == 2 && Http.LastIs("GET", Current));
	TestTrue(TEXT("with the player's token as a bearer"), Http.LastHeader("Authorization") == "Bearer tok-models-test");
	TestTrue(TEXT("and no Origin header"), Http.LastHeader("Origin").empty());
	Http.Answer(Current, 200, R"({"id":"grant_1","status":"active","limitCredits":100})");
	Models->Poll();
	TestTrue(TEXT("Init resolves with the player"), Settled(Init, TEXT("init"), TEXT("{\"user\":{\"id\":\"u_1\",\"name\":\"Ada\"},\"guest\":false,\"shell\":\"app\"}")));
	TestTrue(TEXT("the budget the player approved is found"), Settled(Budget, TEXT("getActiveSpendGrant"), TEXT("{\"id\":\"grant_1\",\"status\":\"active\",\"limitCredits\":100}")));

	// A call under that budget.
	const int32 Asked = Models->Generate(TEXT("{\"grantId\":\"grant_1\",\"modelId\":\"cheap/model\",\"prompt\":\"hello\",\"outputFormat\":\"text\",\"maxCredits\":5}"));
	TestTrue(TEXT("a call under the budget is sent"), Http.LastIs("POST", Generations));
	TestFalse(TEXT("a generate is never cancelled"), Models->Cancel(Asked));
	Http.Answer(Generations, 200, R"({"id":"request_1","grantId":"grant_1","status":"succeeded","output":"Hello there.","source":"openrouter"})");
	Models->Poll();
	TestTrue(TEXT("and settles with the model's answer"),
		Settled(Asked, TEXT("generate"), TEXT("{\"status\":\"succeeded\",\"generationId\":\"request_1\",\"output\":\"Hello there.\",\"source\":\"openrouter\"}")));

	// What needs the approval window answers by code, with no request.
	const int32 SentBefore = Http.Sent.Num();
	const int32 OneTime = Models->Generate(TEXT("{\"modelId\":\"cheap/model\",\"prompt\":\"hello\",\"outputFormat\":\"text\",\"maxCredits\":5}"));
	const int32 NoBudgetStream = Models->GenerateStream(TEXT("{\"modelId\":\"cheap/model\",\"prompt\":\"hello\",\"outputFormat\":\"text\",\"maxCredits\":5}"));
	// Text that is not JSON still settles: every call does.
	const int32 NotJson = Models->Generate(TEXT("not json"));
	const int32 BadId = Models->GetSpendGrant(TEXT("../grants"));
	TestEqual(TEXT("nothing settles inside the call"), Ends.Num(), 3);
	Models->Poll();
	TestTrue(TEXT("a one-time generate is native_unsupported"), Settled(OneTime, TEXT("generate"), TEXT("{\"status\":\"failed\",\"error\":\"native_unsupported\"}")));
	TestTrue(TEXT("a stream without a budget is stream_requires_grant"), Settled(NoBudgetStream, TEXT("generateStream"), TEXT("{\"status\":\"failed\",\"error\":\"stream_requires_grant\"}")));
	TestTrue(TEXT("options that are not JSON are invalid_request"), Settled(NotJson, TEXT("generate"), TEXT("{\"status\":\"failed\",\"error\":\"invalid_request\"}")));
	const FModelsEnd* Refused = Find(BadId);
	TestTrue(TEXT("an id that is no id is rejected"), Refused != nullptr && Refused->bRejected && Refused->Call == TEXT("getSpendGrant") && Refused->Body == TEXT("invalid_grant_id"));
	TestEqual(TEXT("and none of them sent a request"), Http.Sent.Num(), SentBefore);

	// Asking for a budget asks the player nothing: the one they approved, or that there is none.
	const int32 Granted = Models->RequestSpendGrant(TEXT("{\"models\":[\"cheap/model\"],\"perCallMaxCredits\":5}"));
	TestTrue(TEXT("RequestSpendGrant reads the live budget, and never asks for one"), Http.LastIs("GET", Current));
	Http.Answer(Current, 404, R"({"error":"grant_not_found"})");
	Models->Poll();
	TestTrue(TEXT("no budget: budget_not_approved"), Settled(Granted, TEXT("requestSpendGrant"), TEXT("{\"status\":\"failed\",\"error\":\"budget_not_approved\"}")));

	Ends.Reset();
	Models->Poll();
	TestEqual(TEXT("and everything settles once"), Ends.Num(), 0);
	const FString Sentence = Models->GenerationErrorMessage(TEXT("budget_not_approved"));
	TestEqual(TEXT("budget_not_approved has its sentence"), Sentence, FString(TEXT("Set an AI budget for this game on its Genex page, then start the game again.")));
	const FString Unsupported = Models->GenerationErrorMessage(TEXT("native_unsupported"));
	TestTrue(TEXT("native_unsupported has its own sentence"), !Unsupported.IsEmpty() && Unsupported != Sentence && Unsupported != Models->GenerationErrorMessage(TEXT("")));
	TestEqual(TEXT("any other code reads as the general sentence"), Models->GenerationErrorMessage(TEXT("a_code_from_next_year")), Models->GenerationErrorMessage(TEXT("")));
	FGenexMultiplayerModule::SetLaunchTicketForTests(TOptional<FString>());
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FGenexModelsPracticeTest, "Genex.Multiplayer.UObject.ModelsPractice",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)
bool FGenexModelsPracticeTest::RunTest(const FString&)
{
	using namespace GenexModelsTestsDetail;
	// A game being made: the editor handed this play a practice helper's key as it began.
	const TCHAR* KeyEnv = TEXT("GENEX_LLM_PRACTICE");
	const char* Token = "0123456789abcdef0123456789abcdef";
	FPlatformMisc::SetEnvironmentVar(KeyEnv, TEXT("51234.0123456789abcdef0123456789abcdef"));
	FModelsFakeHttp Http;
	FModelsTestGame Game;
	TestTrue(TEXT("the key is taken as the game begins, so nothing it starts inherits it"), FPlatformMisc::GetEnvironmentVariable(KeyEnv).IsEmpty());
	UGenexModelsSubsystem* Models = Game.Instance->GetSubsystem<UGenexModelsSubsystem>();
	UGenexIdentitySubsystem* Identity = Game.Instance->GetSubsystem<UGenexIdentitySubsystem>();
	if (!TestNotNull(TEXT("the game instance has the models subsystem"), Models)) return false;
	if (!TestNotNull(TEXT("and the identity subsystem whose transport it sends through"), Identity)) return false;
	Identity->SetTransport(&Http);

	TArray<FModelsEnd> Ends;
	Models->OnEndedNative.AddLambda([&Ends](int32 Request, const FString& Call, bool bRejected, const FString& Body) {
		Ends.Add({Request, Call, bRejected, Body});
	});
	auto Find = [&Ends](int32 Request) -> const FModelsEnd* {
		return Ends.FindByPredicate([Request](const FModelsEnd& E) { return E.Request == Request; });
	};
	auto LastUrl = [&Http]() { return Http.Sent.Num() > 0 ? Http.Sent.Last().url : std::string(); };
	const std::string Bearer = std::string("Bearer ") + Token;

	// Nobody signs in: the launcher's ticket stays unspent and Genex is never asked.
	FGenexMultiplayerModule::SetLaunchTicketForTests(FString(TEXT("tkt-must-stay-unspent")));
	const int32 Init = Models->Init(GetDefault<UGenexSettings>()->Slug);
	Models->Poll();
	const FModelsEnd* Player = Find(Init);
	TestTrue(TEXT("Init answers the helper's stand-in player"),
		Player != nullptr && !Player->bRejected && Player->Body == TEXT("{\"user\":{\"id\":\"local:test\",\"name\":\"Local Tester\"},\"guest\":true,\"shell\":\"local\"}"));
	TestEqual(TEXT("with no request to anyone"), Http.Sent.Num(), 0);

	// Asking for a budget asks the helper, on this computer, with the helper's own token.
	const int32 Granted = Models->RequestSpendGrant(TEXT("{\"models\":[\"cheap/model\"],\"perCallMaxCredits\":5}"));
	TestTrue(TEXT("RequestSpendGrant posts to the helper"), Http.Sent.Num() == 1 && Http.Sent.Last().method == "POST" && LastUrl() == "http://127.0.0.1:51234/api/runtime/grants");
	TestTrue(TEXT("with the helper's token as the bearer"), Http.LastHeader("Authorization") == Bearer);
	TestTrue(TEXT("and no Origin header"), Http.LastHeader("Origin").empty());
	Http.Answer("/api/runtime/grants", 200, R"({"id":"grant_p1","status":"active","limitCredits":20,"source":"practice"})");
	Models->Poll();
	const FModelsEnd* Budget = Find(Granted);
	TestTrue(TEXT("the helper's approval is the budget"),
		Budget != nullptr && !Budget->bRejected && Budget->Body.Contains(TEXT("\"status\":\"active\"")) && Budget->Body.Contains(TEXT("\"grantId\":\"grant_p1\"")));

	// A call under it, and a one-time call, which a published game cannot make.
	const int32 Asked = Models->Generate(TEXT("{\"grantId\":\"grant_p1\",\"modelId\":\"cheap/model\",\"prompt\":\"hello\",\"outputFormat\":\"text\",\"maxCredits\":5}"));
	TestTrue(TEXT("a call under the budget goes to the helper"), LastUrl() == "http://127.0.0.1:51234/api/runtime/grants/grant_p1/generations" && Http.LastHeader("Authorization") == Bearer);
	Http.Answer("/generations", 200, R"({"id":"request_1","grantId":"grant_p1","status":"succeeded","output":"[practice] hello","source":"practice"})");
	const int32 OneTime = Models->Generate(TEXT("{\"modelId\":\"cheap/model\",\"prompt\":\"hello\",\"outputFormat\":\"text\",\"maxCredits\":5}"));
	TestTrue(TEXT("a one-time call goes to the helper too"), LastUrl() == "http://127.0.0.1:51234/api/runtime/generations" && Http.LastHeader("Authorization") == Bearer);
	Http.Answer("/api/runtime/generations", 200, R"({"id":"request_2","status":"succeeded","output":"[practice] hello","source":"practice"})");
	Models->Poll();
	const FModelsEnd* Answer = Find(Asked);
	const FModelsEnd* Single = Find(OneTime);
	TestTrue(TEXT("the call settles with the helper's answer"), Answer != nullptr && !Answer->bRejected && Answer->Body.Contains(TEXT("[practice] hello")));
	TestTrue(TEXT("and so does the one-time call"), Single != nullptr && !Single->bRejected && Single->Body.Contains(TEXT("\"status\":\"succeeded\"")));
	for (const genex::HttpRequest& Request : Http.Sent)
	{
		TestTrue(TEXT("every request of a practice play goes to this computer"), Request.url.rfind("http://127.0.0.1:51234/", 0) == 0);
	}
	FGenexMultiplayerModule::SetLaunchTicketForTests(TOptional<FString>());
	return true;
}

#endif  // WITH_DEV_AUTOMATION_TESTS
