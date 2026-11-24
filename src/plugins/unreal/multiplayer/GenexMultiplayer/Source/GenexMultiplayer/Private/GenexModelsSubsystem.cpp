#include "GenexModelsSubsystem.h"

#include "GenexCore/GenexHttp.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexModels.h"
#include "GenexCore/GenexModelsHttp.h"
#include "GenexIdentitySubsystem.h"
#include "GenexSettings.h"
#include "GenexUnrealJson.h"
#include "Subsystems/SubsystemCollection.h"

#include <functional>
#include <memory>
#include <string>
#include <utility>
#include <vector>

/** GenexCore's HTTP seam for the model calls: each request goes out through the transport the identity subsystem
 *  uses at that moment (Unreal's HTTP module, or a test's), so one swapped under the bridge is followed and one that
 *  is gone is never called. */
class FGenexModelsHttp final : public genex::IHttp
{
public:
	explicit FGenexModelsHttp(UGenexIdentitySubsystem* InIdentity) : Identity(InIdentity) {}

	virtual void Send(genex::HttpRequest Request, genex::HttpDone Done) override
	{
		genex::IHttp* Http = Identity.IsValid() ? Identity->Transport() : nullptr;
		if (!Http)
		{
			genex::HttpResponse Response;
			Response.transportError = "genex: no HTTP transport";
			Done(std::move(Response));
			return;
		}
		Http->Send(std::move(Request), std::move(Done));
	}

private:
	TWeakObjectPtr<UGenexIdentitySubsystem> Identity;
};

namespace GenexModelsSubsystemDetail
{
/** A call's options from JSON text. Text that is not JSON crosses as `null`: the call still settles, as every call
 *  does (`invalid_request`, as over a page's bridge). */
genex::Json Options(const FString& Text)
{
	genex::Json Value;
	if (!GenexUnrealJson::Parse(Text, Value)) return genex::Json();
	return Value;
}

/** The bridge's doors onto the identity subsystem. Each reads the subsystem's identity when it is called, never
 *  one kept from before: SetTransport starts a fresh identity, and the subsystem may be gone. */
genex::models::HttpBridgeOptions BridgeOptions(UGenexIdentitySubsystem* Identity, genex::IHttp* Http)
{
	const TWeakObjectPtr<UGenexIdentitySubsystem> Weak(Identity);
	genex::models::HttpBridgeOptions Bridge;
	Bridge.http = Http;
	// A fresh token before every request (refreshed first when it is due), never one cached here.
	Bridge.token = [Weak](genex::TokenCallback Done) {
		genex::EmbedIdentity* Core = Weak.IsValid() ? Weak->Core() : nullptr;
		if (!Core)
		{
			Done(false, std::string(), genex::IdentityError());
			return;
		}
		Core->GetToken(std::move(Done));
	};
	// GENEX_API_URL (a launcher's gateway) wins over the project's ApiUrl, read per request.
	Bridge.apiBase = [Weak]() {
		genex::EmbedIdentity* Core = Weak.IsValid() ? Weak->Core() : nullptr;
		if (Core) return Core->ApiBase();
		return genex::ApiBaseFromEnvironment(GenexUnrealJson::Utf8(GetDefault<UGenexSettings>()->ApiUrl));
	};
	Bridge.slug = [Weak]() {
		genex::EmbedIdentity* Core = Weak.IsValid() ? Weak->Core() : nullptr;
		return Core ? Core->Slug() : std::string();
	};
	Bridge.player = [Weak]() {
		genex::models::HttpPlayer Player;
		genex::EmbedIdentity* Core = Weak.IsValid() ? Weak->Core() : nullptr;
		if (!Core) return Player;
		Player.signedIn = Core->HasToken();
		Player.guest = Core->IsGuest();
		Player.user = Core->User();
		return Player;
	};
	// Init makes sure somebody plays, as a relay join does: the launcher's ticket, else a guest. Whether that
	// worked is read by Init's answer (`guest`, `user`) and by the first call (`no_player_session`).
	Bridge.beforeInit = [Weak](std::function<void()> Done) {
		if (!Weak.IsValid() || Weak->IsSignedIn())
		{
			Done();
			return;
		}
		Weak->SignInAutomatically(FGenexSignInDone::CreateLambda([Done](bool, int32, const FString&) { Done(); }));
	};
	// The subsystem's ticker polls every frame, which advances the bridge's waits: the model calls need Unreal's
	// HTTP module only, never the Colyseus core or its pump.
	Bridge.usePump = false;
	return Bridge;
}
}

UGenexModelsSubsystem::UGenexModelsSubsystem() = default;
UGenexModelsSubsystem::~UGenexModelsSubsystem() = default;

void UGenexModelsSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	// The bridge asks the identity for a token before every request: it is initialized first.
	UGenexIdentitySubsystem* Identity = Collection.InitializeDependency<UGenexIdentitySubsystem>();
	Http = MakeShared<FGenexModelsHttp>(Identity);
	Models = MakeShared<genex::models::Models>(
		std::make_unique<genex::models::HttpBridge>(GenexModelsSubsystemDetail::BridgeOptions(Identity, Http.Get())));
	TickerHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateUObject(this, &UGenexModelsSubsystem::OnTicker));
}

void UGenexModelsSubsystem::Deinitialize()
{
	if (TickerHandle.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(TickerHandle);
	TickerHandle.Reset();
	// The bridge first: it holds the transport by address.
	Models.Reset();
	Http.Reset();
	Super::Deinitialize();
}

bool UGenexModelsSubsystem::OnTicker(float)
{
	Poll();
	return true;
}

bool UGenexModelsSubsystem::IsSupported() const
{
	return Models.IsValid() && Models->Supported();
}

int32 UGenexModelsSubsystem::Init(const FString& GameId)
{
	return Models.IsValid() ? Models->Init(GenexUnrealJson::Utf8(GameId)) : 0;
}

int32 UGenexModelsSubsystem::GetGenerationModels()
{
	return Models.IsValid() ? Models->GetGenerationModels() : 0;
}

int32 UGenexModelsSubsystem::Generate(const FString& OptionsJson)
{
	return Models.IsValid() ? Models->Generate(GenexModelsSubsystemDetail::Options(OptionsJson)) : 0;
}

int32 UGenexModelsSubsystem::GenerateStream(const FString& OptionsJson)
{
	return Models.IsValid() ? Models->GenerateStream(GenexModelsSubsystemDetail::Options(OptionsJson)) : 0;
}

int32 UGenexModelsSubsystem::Judge(const FString& OptionsJson)
{
	return Models.IsValid() ? Models->Judge(GenexModelsSubsystemDetail::Options(OptionsJson)) : 0;
}

int32 UGenexModelsSubsystem::RequestSpendGrant(const FString& OptionsJson)
{
	return Models.IsValid() ? Models->RequestSpendGrant(GenexModelsSubsystemDetail::Options(OptionsJson)) : 0;
}

int32 UGenexModelsSubsystem::GetSpendGrant(const FString& GrantId)
{
	return Models.IsValid() ? Models->GetSpendGrant(GenexUnrealJson::Utf8(GrantId)) : 0;
}

int32 UGenexModelsSubsystem::GetActiveSpendGrant()
{
	return Models.IsValid() ? Models->GetActiveSpendGrant() : 0;
}

int32 UGenexModelsSubsystem::StopSpendGrant(const FString& GrantId)
{
	return Models.IsValid() ? Models->StopSpendGrant(GenexUnrealJson::Utf8(GrantId)) : 0;
}

int32 UGenexModelsSubsystem::WaitForGeneration(const FString& GenerationId, float TimeoutMs)
{
	return Models.IsValid() ? Models->WaitForGeneration(GenexUnrealJson::Utf8(GenerationId), static_cast<double>(TimeoutMs)) : 0;
}

int32 UGenexModelsSubsystem::GetGeneration(const FString& GenerationId)
{
	return Models.IsValid() ? Models->GetGeneration(GenexUnrealJson::Utf8(GenerationId)) : 0;
}

bool UGenexModelsSubsystem::Cancel(int32 Request)
{
	return Models.IsValid() && Models->Cancel(Request);
}

FString UGenexModelsSubsystem::GenerationErrorMessage(const FString& Code) const
{
	const std::string Utf8 = GenexUnrealJson::Utf8(Code);
	const std::string Sentence = Models.IsValid() ? Models->GenerationErrorMessage(Code.IsEmpty() ? nullptr : &Utf8)
		: genex::models::NativeErrorMessage(Code.IsEmpty() ? nullptr : &Utf8);
	return FString(UTF8_TO_TCHAR(Sentence.c_str()));
}

void UGenexModelsSubsystem::Poll()
{
	if (!Models.IsValid()) return;
	// A handler may call back in (the next line of dialogue): the events are taken first, the door stays valid.
	const TSharedPtr<genex::models::Models> Keep = Models;
	const std::vector<genex::models::Event> Events = Keep->Poll();
	for (const genex::models::Event& Event : Events)
	{
		const FString Call(UTF8_TO_TCHAR(Event.call.c_str()));
		switch (Event.type)
		{
		case genex::models::Event::Type::Result:
		{
			const FString Result = GenexUnrealJson::ToText(Event.result);
			OnEndedNative.Broadcast(Event.id, Call, false, Result);
			OnSettled.Broadcast(Event.id, Call, Result);
			break;
		}
		case genex::models::Event::Type::Rejected:
		{
			const FString Error(UTF8_TO_TCHAR(Event.error.c_str()));
			OnEndedNative.Broadcast(Event.id, Call, true, Error);
			OnRejected.Broadcast(Event.id, Call, Error);
			break;
		}
		case genex::models::Event::Type::Delta:
			OnDelta.Broadcast(Event.id, FString(UTF8_TO_TCHAR(Event.text.c_str())), FString(UTF8_TO_TCHAR(Event.soFar.c_str())));
			break;
		case genex::models::Event::Type::PartialField:
			OnPartialField.Broadcast(Event.id, FString(UTF8_TO_TCHAR(Event.name.c_str())), FString(UTF8_TO_TCHAR(Event.text.c_str())));
			break;
		case genex::models::Event::Type::Gesture:
			OnGesture.Broadcast(Event.id, Call, Event.waiting);
			break;
		}
	}
}
