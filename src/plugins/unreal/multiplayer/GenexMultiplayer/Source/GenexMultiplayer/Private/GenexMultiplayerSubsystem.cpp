#include "GenexMultiplayerSubsystem.h"

#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexProtocol.h"
#include "GenexCore/GenexPump.h"
#include "GenexCore/GenexRelaySession.h"
#include "GenexCore/GenexUrl.h"
#include "GenexIdentitySubsystem.h"
#include "GenexMultiplayerModule.h"
#include "GenexSettings.h"
#include "GenexUnrealJson.h"
#include "Engine/GameInstance.h"

using namespace GenexUnrealJson;

/** What the relay session reads right before each join it starts (§3.2): the identity's token as it
 *  is at that moment, never the one read when Join ran, so a requeue or a re-search 15 minutes on
 *  still sends a valid one. */
struct FGenexRelayTokenSource
{
	genex::JoinTokenProvider Provider;
	/** The identity the provider reads; unset for a relay on this machine (the local placeholder). */
	TWeakObjectPtr<UGenexIdentitySubsystem> Identity;
};

/** Registered with genex::Pump after the session (registration order = update order), so the
 *  subsystem's events fire in the same pump frame, right after the session updated. */
class FGenexRelayPumpHook final : public genex::IPumped
{
public:
	explicit FGenexRelayPumpHook(UGenexMultiplayerSubsystem* InOwner) : Owner(InOwner) { genex::Pump::Register(this); }
	virtual ~FGenexRelayPumpHook() override { genex::Pump::Unregister(this); }
	virtual void Update(double) override
	{
		if (!Owner.IsValid()) return;
		Owner->DispatchEvents();
		if (Owner.IsValid()) Owner->KeepTokenFresh();
	}

private:
	TWeakObjectPtr<UGenexMultiplayerSubsystem> Owner;
};

namespace GenexRelayDetail
{
FString Str(const std::string& S) { return UTF8_TO_TCHAR(S.c_str()); }
FString Str(const std::optional<std::string>& S) { return S ? Str(*S) : FString(); }

FGenexControlResult ToResult(const genex::RelayControlResult& R)
{
	FGenexControlResult Out;
	Out.RequestId = Str(R.requestId);
	Out.Operation = Str(R.operation);
	Out.Id = Str(R.id);
	Out.bAccepted = R.accepted;
	Out.Owner = Str(R.owner);
	Out.Sequence = static_cast<int32>(R.sequence);
	Out.Reason = Str(R.reason);
	Out.RetryAfterMs = R.retryAfterMs ? static_cast<float>(*R.retryAfterMs) : 0.f;
	return Out;
}

FGenexChatMessage ToChat(const genex::RelayChatMessage& M)
{
	FGenexChatMessage Out;
	Out.Id = FString::Printf(TEXT("%.0f"), M.id);
	Out.From = Str(M.from);
	Out.Name = Str(M.name);
	Out.Text = Str(M.text);
	Out.At = M.at;
	return Out;
}

FGenexPlayer ToPlayer(const genex::RelayPlayerView& P)
{
	FGenexPlayer Out;
	Out.Id = Str(P.id);
	Out.Uid = Str(P.uid);
	Out.Name = Str(P.name);
	Out.Team = P.team;
	Out.bConnected = P.connected;
	Out.DataJson = ToText(P.stateRaw.IsNull() ? genex::Json::MakeObject() : P.stateRaw);
	return Out;
}

FGenexObject ToObject(const genex::RelayObjectView& O)
{
	FGenexObject Out;
	Out.Id = Str(O.id);
	Out.Owner = Str(O.owner);
	Out.Sequence = static_cast<int32>(O.seq);
	Out.Epoch = static_cast<int32>(O.epoch);
	Out.DataJson = ToText(O.stateRaw);
	return Out;
}

genex::RelayTarget ToTarget(EGenexRoomKind Kind)
{
	switch (Kind)
	{
	case EGenexRoomKind::Queue: return genex::RelayTarget::Queue;
	case EGenexRoomKind::CreatePrivate: return genex::RelayTarget::CreatePrivate;
	case EGenexRoomKind::JoinById: return genex::RelayTarget::JoinById;
	default: return genex::RelayTarget::Play;
	}
}

float Scale() { return GetDefault<UGenexSettings>()->UnitsPerMeter; }
}

UGenexMultiplayerSubsystem::UGenexMultiplayerSubsystem() = default;
UGenexMultiplayerSubsystem::~UGenexMultiplayerSubsystem() = default;

void UGenexMultiplayerSubsystem::Deinitialize()
{
	Teardown();
	Super::Deinitialize();
}

void UGenexMultiplayerSubsystem::Teardown()
{
	const bool bInFlight = Session.IsValid() || Status == EGenexStatus::Connecting;
	Hook.Reset();
	Session.Reset(); // a seated session leaves with consent on destruction
	TokenSource.Reset();
	Status = EGenexStatus::Idle;
	// Destroyed without an event: whatever waits on it (a Join or Claim Control node) hears it here.
	if (bInFlight) OnJoinAbandoned.Broadcast(JoinGeneration);
}

bool UGenexMultiplayerSubsystem::IsPending(uint32 Generation) const
{
	return JoinGeneration == Generation && Status == EGenexStatus::Connecting && !Session;
}

void UGenexMultiplayerSubsystem::FailJoin(int32 Code, const FString& Message)
{
	Status = EGenexStatus::Closed;
	LastError = Message;
	OnJoinFailed.Broadcast(Code, Message);
}

void UGenexMultiplayerSubsystem::KeepTokenFresh()
{
	if (Session && !Session->IsClosed() && TokenSource && TokenSource->Identity.IsValid()) TokenSource->Identity->KeepTokenFresh();
}

void UGenexMultiplayerSubsystem::Join(const FGenexRoomOptions& Options)
{
	Teardown();
	const uint32 Generation = ++JoinGeneration;
	Status = EGenexStatus::Connecting;
	LastError.Reset();
	if (!FGenexMultiplayerModule::IsAvailable())
	{
		FailJoin(0, TEXT("genex: multiplayer is unavailable (the Colyseus core did not load)"));
		return;
	}
	UGenexIdentitySubsystem* Identity = GetGameInstance()->GetSubsystem<UGenexIdentitySubsystem>();
	TWeakObjectPtr<UGenexMultiplayerSubsystem> Weak(this);
	// Every callback below checks IsPending: a Leave, or a newer Join, while it waited starts nothing.
	auto WithToken = [Weak, Generation, Options](bool bOk, const FString&, const FString& Error) {
		if (!Weak.IsValid() || !Weak->IsPending(Generation)) return;
		if (bOk)
		{
			Weak->StartSession(Options, false);
			return;
		}
		// No identity: only the bench relay takes the local placeholder (a real relay, development
		// ones included, verifies every token and refuses it with 401), and only when EVERY URL is on
		// this machine: with several the session joins whichever answers first. Else fail here, by name.
		TArray<FString> Urls = Options.RelayUrls.Num() > 0 ? Options.RelayUrls : Weak->GetGameInstance()->GetSubsystem<UGenexIdentitySubsystem>()->GetRelayUrls();
		const bool bLocal = Urls.Num() > 0 && !Urls.ContainsByPredicate([](const FString& U) { return !genex::IsLoopbackUrl(TCHAR_TO_UTF8(*U)); });
		if (bLocal)
		{
			Weak->StartSession(Options, true);
			return;
		}
		Weak->FailJoin(401, FString::Printf(TEXT("genex: not signed in (%s)"), *Error));
	};
	if (Identity && Identity->IsSignedIn())
	{
		Identity->GetToken(WithToken);
	}
	else if (Identity && Options.bSignInAutomatically)
	{
		Identity->SignInAutomatically(FGenexSignInDone::CreateLambda([Weak, Generation, WithToken](bool bOk, int32, const FString& Error) {
			if (!Weak.IsValid() || !Weak->IsPending(Generation)) return;
			UGenexIdentitySubsystem* Id = Weak->GetGameInstance()->GetSubsystem<UGenexIdentitySubsystem>();
			if (bOk && Id) Id->GetToken(WithToken);
			else WithToken(false, FString(), Error);
		}));
	}
	else
	{
		WithToken(false, FString(), TEXT("signing in is off"));
	}
}

void UGenexMultiplayerSubsystem::StartSession(const FGenexRoomOptions& Options, bool bLocalPlaceholder)
{
	const UGenexSettings* Settings = GetDefault<UGenexSettings>();
	UGenexIdentitySubsystem* Identity = GetGameInstance()->GetSubsystem<UGenexIdentitySubsystem>();
	genex::RelayConnectOptions Core;
	const TArray<FString> Urls = Options.RelayUrls.Num() > 0 ? Options.RelayUrls : (Identity ? Identity->GetRelayUrls() : Settings->RelayUrls);
	for (const FString& Url : Urls) Core.endpoints.push_back(Utf8(Url));
	Core.gameId = Utf8(Options.GameId.IsEmpty() ? Settings->Slug : Options.GameId);
	if (!Options.Name.IsEmpty()) Core.name = Utf8(Options.Name);
	Core.room = GenexRelayDetail::ToTarget(Options.Room);
	Core.joinCode = Utf8(Options.JoinCode);
	Core.publishHz = Options.PublishHz;
	if (!Options.ExtraOptionsJson.IsEmpty())
	{
		genex::Json Extra;
		FString Error;
		if (!Parse(Options.ExtraOptionsJson, Extra, &Error) || !Extra.IsObject())
		{
			FailJoin(0, FString::Printf(TEXT("genex: ExtraOptionsJson is not a JSON object (%s)"), *Error));
			return;
		}
		Core.options = std::move(Extra);
	}
	// The relay session asks for a token right before each join it starts (the first, a matchmaking
	// seat, a requeue, a re-search), synchronously: it reads the identity's token as it is then, which
	// the pump hook keeps refreshed while the session is open (KeepTokenFresh).
	TokenSource = MakeShared<FGenexRelayTokenSource>();
	if (bLocalPlaceholder)
	{
		TokenSource->Provider = []() { return genex::JoinToken::Ok(genex::kLocalAuthorityToken); };
	}
	else
	{
		TokenSource->Identity = Identity;
		TWeakObjectPtr<UGenexIdentitySubsystem> WeakIdentity(Identity);
		TokenSource->Provider = [WeakIdentity]() {
			FString Fresh;
			if (WeakIdentity.IsValid() && WeakIdentity->TokenForJoinNow(Fresh)) return genex::JoinToken::Ok(Utf8(Fresh));
			return genex::JoinToken::Fail("not signed in: the player's identity holds no valid token (sign in again)");
		};
	}
	Session = MakeShared<genex::RelaySession>(std::move(Core), TokenSource->Provider);
	Hook = MakeShared<FGenexRelayPumpHook>(this);
}

void UGenexMultiplayerSubsystem::Leave()
{
	if (Session)
	{
		Session->Leave(); // OnDisconnected follows from the session
		return;
	}
	if (Status != EGenexStatus::Connecting) return;
	// A Join still signing in or fetching its token: it starts nothing now (IsPending), and the
	// consented leave is said as the session would say it.
	Status = EGenexStatus::Closed;
	LastError = FString::Printf(TEXT("disconnected (%d): left"), genex::protocol::close_code::kConsented);
	OnDisconnected.Broadcast(genex::protocol::close_code::kConsented, TEXT("left"));
}

void UGenexMultiplayerSubsystem::DispatchEvents()
{
	if (!Session) return;
	// Dispatch can reach game code that calls Leave or Join (which destroys the session): drain first.
	std::vector<genex::RelayEvent> Events = Session->DrainEvents();
	const uint32 Generation = JoinGeneration;
	for (const genex::RelayEvent& Event : Events)
	{
		Dispatch(Event);
		if (JoinGeneration != Generation) return;
	}
}

void UGenexMultiplayerSubsystem::Dispatch(const genex::RelayEvent& E)
{
	using namespace GenexRelayDetail;
	using T = genex::RelayEventType;
	switch (E.type)
	{
	case T::Joined: Status = EGenexStatus::Connected; OnJoined.Broadcast(Str(E.id)); break;
	case T::JoinFailed: Status = EGenexStatus::Closed; LastError = FString::Printf(TEXT("join failed (%d): %s"), E.code, *Str(E.message)); OnJoinFailed.Broadcast(E.code, Str(E.message)); break;
	case T::PlayerJoined: OnPlayerJoined.Broadcast(Str(E.id)); break;
	case T::PlayerLeft: OnPlayerLeft.Broadcast(Str(E.id)); break;
	case T::HostChanged: OnHostChanged.Broadcast(Str(E.owner)); break;
	case T::SharedChanged: OnSharedChanged.Broadcast(Str(E.id)); break;
	case T::ObjectChanged: OnObjectChanged.Broadcast(Str(E.id), Str(E.owner)); break;
	case T::ObjectRemoved: OnObjectRemoved.Broadcast(Str(E.id)); break;
	case T::ControlResult: OnControlResult.Broadcast(ToResult(E.control)); break;
	case T::Message: OnMessage.Broadcast(Str(E.id), GenexUnrealJson::ToText(E.data)); break;
	case T::Input: OnInputReceived.Broadcast(Str(E.id), GenexUnrealJson::ToText(E.data)); break;
	case T::RoomOpen: OnRoomOpenChanged.Broadcast(E.flag); break;
	case T::Chat: OnChat.Broadcast(ToChat(E.chat)); break;
	case T::RateDrop: OnWarning.Broadcast(FString::Printf(TEXT("the relay dropped %.0f messages for rate: publish less"), E.value)); break;
	case T::ServerRestart: OnServerRestart.Broadcast(); break;
	case T::MatchStart: OnMatchStarted.Broadcast(static_cast<int32>(E.value)); break;
	case T::MatchEnded: OnMatchEnded.Broadcast(TEXT("matchEnded"), GenexUnrealJson::ToText(E.data)); break;
	case T::MatchRequeue: OnWarning.Broadcast(FString::Printf(TEXT("requeued: %s"), *Str(E.owner))); break;
	case T::Queue: OnQueueUpdate.Broadcast(static_cast<int32>(E.value), static_cast<int32>(E.value2)); break;
	case T::Seated: break;
	case T::Reconnecting: Status = EGenexStatus::Reconnecting; OnReconnecting.Broadcast(E.code); break;
	case T::Reconnected: Status = EGenexStatus::Connected; OnReconnected.Broadcast(); break;
	case T::Disconnected: Status = EGenexStatus::Closed; LastError = FString::Printf(TEXT("disconnected (%d): %s"), E.code, *Str(E.message)); OnDisconnected.Broadcast(E.code, Str(E.message)); break;
	case T::Warning: OnWarning.Broadcast(Str(E.message)); break;
	default: break;
	}
}

bool UGenexMultiplayerSubsystem::IsJoined() const { return Session && !Session->SessionId().empty() && !Session->IsClosed(); }
bool UGenexMultiplayerSubsystem::IsConnected() const { return Session && Session->IsConnected(); }
FString UGenexMultiplayerSubsystem::GetSessionId() const { return Session ? GenexRelayDetail::Str(Session->SessionId()) : FString(); }
FString UGenexMultiplayerSubsystem::GetRoomId() const { return Session ? GenexRelayDetail::Str(Session->RoomId()) : FString(); }
FString UGenexMultiplayerSubsystem::GetHostId() const { return Session ? GenexRelayDetail::Str(Session->HostId()) : FString(); }
bool UGenexMultiplayerSubsystem::IsHost() const { return Session && Session->IsHost(); }

TArray<FGenexPlayer> UGenexMultiplayerSubsystem::GetPlayers() const
{
	TArray<FGenexPlayer> Out;
	if (Session) for (const genex::RelayPlayerView& P : Session->Players()) Out.Add(GenexRelayDetail::ToPlayer(P));
	return Out;
}

bool UGenexMultiplayerSubsystem::GetPlayer(const FString& Id, FGenexPlayer& OutPlayer) const
{
	const genex::RelayPlayerView* P = Session ? Session->Player(Utf8(Id)) : nullptr;
	if (!P) return false;
	OutPlayer = GenexRelayDetail::ToPlayer(*P);
	return true;
}

FString UGenexMultiplayerSubsystem::GetPlayerStateJson(const FString& Id) const
{
	const genex::RelayPlayerView* P = Session ? Session->Player(Utf8(Id)) : nullptr;
	return P ? ToText(P->state) : FString(TEXT("null"));
}

namespace GenexRelayDetail
{
bool Publish(genex::RelaySession* S, const FString& Json, bool bSnap, UGenexMultiplayerSubsystem* Self)
{
	if (!S) return false;
	genex::Json State;
	FString Error;
	if (!Parse(Json, State, &Error) || !State.IsObject())
	{
		Self->OnWarning.Broadcast(FString::Printf(TEXT("player state must be a JSON object (%s)"), *Error));
		return false;
	}
	const genex::RelayStatus R = bSnap ? S->SnapMe(std::move(State)) : S->SetMe(std::move(State));
	return R.Ok();
}
}

bool UGenexMultiplayerSubsystem::SetMyStateJson(const FString& StateJson) { return GenexRelayDetail::Publish(Session.Get(), StateJson, false, this); }
bool UGenexMultiplayerSubsystem::SnapMyStateJson(const FString& StateJson) { return GenexRelayDetail::Publish(Session.Get(), StateJson, true, this); }

bool UGenexMultiplayerSubsystem::PeekJoinToken(FString& OutToken, FString& OutError) const
{
	if (!TokenSource || !TokenSource->Provider)
	{
		OutError = TEXT("no session");
		return false;
	}
	const genex::JoinToken Token = TokenSource->Provider();
	OutToken = UTF8_TO_TCHAR(Token.token.c_str());
	OutError = UTF8_TO_TCHAR(Token.error.c_str());
	return Token.ok;
}

bool UGenexMultiplayerSubsystem::LocationState(const FVector& Location, float YawDegrees, const FString& ExtraJson, genex::Json& OutState)
{
	genex::Json State = genex::Json::MakeObject();
	if (!ExtraJson.IsEmpty())
	{
		genex::Json Extra;
		if (!Parse(ExtraJson, Extra) || !Extra.IsObject()) return false;
		State = std::move(Extra);
	}
	const double S = GenexRelayDetail::Scale();
	State.Set("x", Location.X / S);
	State.Set("y", Location.Y / S);
	State.Set("z", Location.Z / S);
	const double Yaw = FMath::DegreesToRadians(static_cast<double>(YawDegrees));
	State.Set("yaw", Yaw);
	// The yaw as a quaternion about Z as well: receivers slerp a 4-number quaternion the short way
	// round (§10), where a plain yaw number would lerp from 179° to -179° through 0, the other way.
	genex::Json Q = genex::Json::MakeArray();
	Q.Push(0.0);
	Q.Push(0.0);
	Q.Push(FMath::Sin(Yaw * 0.5));
	Q.Push(FMath::Cos(Yaw * 0.5));
	State.Set("q", std::move(Q));
	OutState = std::move(State);
	return true;
}

bool UGenexMultiplayerSubsystem::ReadLocation(const genex::Json& State, FVector& OutLocation, float& OutYawDegrees)
{
	if (!State.IsObject() || !State.Find("x")) return false;
	const double S = GenexRelayDetail::Scale();
	OutLocation = FVector(Number(State, "x") * S, Number(State, "y") * S, Number(State, "z") * S);
	double Yaw = Number(State, "yaw");
	const genex::Json* Q = State.Find("q");
	if (Q && Q->IsArray() && Q->Size() == 4 && Q->At(0).IsNumber() && Q->At(1).IsNumber() && Q->At(2).IsNumber() && Q->At(3).IsNumber())
	{
		// The rotation about Z of a quaternion (x, y, z, w).
		const double X = Q->At(0).AsNumber(), Y = Q->At(1).AsNumber(), Z = Q->At(2).AsNumber(), W = Q->At(3).AsNumber();
		const double FromQ = FMath::Atan2(2.0 * (W * Z + X * Y), 1.0 - 2.0 * (Y * Y + Z * Z));
		if (FMath::IsFinite(FromQ)) Yaw = FromQ;
	}
	OutYawDegrees = static_cast<float>(FMath::RadiansToDegrees(Yaw));
	return true;
}

bool UGenexMultiplayerSubsystem::SetMyLocation(FVector Location, float YawDegrees, const FString& ExtraJson)
{
	genex::Json State;
	if (!Session || !LocationState(Location, YawDegrees, ExtraJson, State)) return false;
	return Session->SetMe(std::move(State)).Ok();
}

bool UGenexMultiplayerSubsystem::GetPlayerLocation(const FString& Id, FVector& OutLocation, float& OutYawDegrees) const
{
	const genex::RelayPlayerView* P = Session ? Session->Player(Utf8(Id)) : nullptr;
	return P && ReadLocation(P->state, OutLocation, OutYawDegrees);
}

bool UGenexMultiplayerSubsystem::SetShared(const FString& Key, const FString& ValueJson)
{
	genex::Json Value;
	if (!Session || !Parse(ValueJson, Value)) return false;
	return Session->SetShared(Utf8(Key), Value).Ok();
}

FString UGenexMultiplayerSubsystem::GetShared(const FString& Key) const
{
	if (!Session) return TEXT("null");
	std::optional<genex::Json> V = Session->SharedGet(Utf8(Key));
	return V ? ToText(*V) : FString(TEXT("null"));
}

TArray<FString> UGenexMultiplayerSubsystem::GetSharedKeys() const
{
	TArray<FString> Out;
	if (Session) for (const auto& Pair : Session->Shared()) Out.Add(GenexRelayDetail::Str(Pair.first));
	return Out;
}

FString UGenexMultiplayerSubsystem::Claim(const FString& Id, bool bAsHost)
{
	std::string RequestId;
	if (!Session) return FString();
	const genex::RelayStatus R = bAsHost ? Session->ClaimAsHost(Utf8(Id), &RequestId) : Session->Claim(Utf8(Id), &RequestId);
	return R.Ok() ? GenexRelayDetail::Str(RequestId) : FString();
}

FString UGenexMultiplayerSubsystem::Release(const FString& Id)
{
	std::string RequestId;
	return Session && Session->Release(Utf8(Id), &RequestId).Ok() ? GenexRelayDetail::Str(RequestId) : FString();
}

FString UGenexMultiplayerSubsystem::Destroy(const FString& Id)
{
	std::string RequestId;
	return Session && Session->Destroy(Utf8(Id), &RequestId).Ok() ? GenexRelayDetail::Str(RequestId) : FString();
}

bool UGenexMultiplayerSubsystem::Owns(const FString& Id) const { return Session && Session->Owns(Utf8(Id)); }

bool UGenexMultiplayerSubsystem::SetObjectJson(const FString& Id, const FString& StateJson)
{
	genex::Json State;
	if (!Session || !Parse(StateJson, State) || !State.IsObject()) return false;
	return Session->SetObject(Utf8(Id), std::move(State)).Ok();
}

bool UGenexMultiplayerSubsystem::SnapObjectJson(const FString& Id, const FString& StateJson)
{
	genex::Json State;
	if (!Session || !Parse(StateJson, State) || !State.IsObject()) return false;
	return Session->SnapObject(Utf8(Id), std::move(State)).Ok();
}

TArray<FGenexObject> UGenexMultiplayerSubsystem::GetObjects() const
{
	TArray<FGenexObject> Out;
	if (Session) for (const genex::RelayObjectView& O : Session->Objects()) Out.Add(GenexRelayDetail::ToObject(O));
	return Out;
}

bool UGenexMultiplayerSubsystem::GetObject(const FString& Id, FGenexObject& OutObject) const
{
	const genex::RelayObjectView* O = Session ? Session->Object(Utf8(Id)) : nullptr;
	if (!O) return false;
	OutObject = GenexRelayDetail::ToObject(*O);
	return true;
}

bool UGenexMultiplayerSubsystem::SendEvent(const FString& Type, const FString& DataJson)
{
	genex::Json Data;
	if (!Session || !Parse(DataJson, Data)) return false;
	return Session->Send(Utf8(Type), Data).Ok();
}

bool UGenexMultiplayerSubsystem::SendInput(const FString& DataJson)
{
	genex::Json Data;
	if (!Session || !Parse(DataJson, Data)) return false;
	return Session->SendInput(Data).Ok();
}

bool UGenexMultiplayerSubsystem::SendChat(const FString& Text) { return Session && Session->ChatSend(Utf8(Text)).Ok(); }

TArray<FGenexChatMessage> UGenexMultiplayerSubsystem::GetChatHistory() const
{
	TArray<FGenexChatMessage> Out;
	if (Session) for (const genex::RelayChatMessage& M : Session->ChatMessages()) Out.Add(GenexRelayDetail::ToChat(M));
	return Out;
}

bool UGenexMultiplayerSubsystem::SetRoomOpen(bool bOpen) { return Session && Session->SetRoomOpen(bOpen).Ok(); }

double UGenexMultiplayerSubsystem::GetServerNow() const
{
	std::optional<double> V = Session ? Session->ServerNow() : std::nullopt;
	return V ? *V : -1.0;
}

double UGenexMultiplayerSubsystem::GetRtt() const
{
	std::optional<double> V = Session ? Session->Rtt() : std::nullopt;
	return V ? *V : -1.0;
}
