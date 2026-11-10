#include "GenexIdentitySubsystem.h"

#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexMultiplayerModule.h"
#include "GenexSettings.h"
#include "GenexUnrealHttp.h"
#include "GenexUnrealJson.h"

UGenexIdentitySubsystem::UGenexIdentitySubsystem() = default;
UGenexIdentitySubsystem::~UGenexIdentitySubsystem() = default;

void UGenexIdentitySubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	Http = MakeShared<FGenexUnrealHttp>();
	MakeIdentity(Http.Get());
}

void UGenexIdentitySubsystem::SetTransport(genex::IHttp* InHttp, TFunction<double()> InClock)
{
	Clock = MoveTemp(InClock);
	MakeIdentity(InHttp ? InHttp : Http.Get());
}

namespace GenexIdentityDetail
{
/** How often a due refresh may be asked for again after one that has not answered or failed. */
constexpr double RefreshRetryMs = 30000.0;

FString Describe(const genex::IdentityError& Error) { return UTF8_TO_TCHAR(Error.Describe().c_str()); }
}

double UGenexIdentitySubsystem::NowMs() const
{
	return Clock ? Clock() : genex::Clock::NowMs();
}

void UGenexIdentitySubsystem::MakeIdentity(genex::IHttp* InHttp)
{
	// A sign-in the old identity was running never answers now: its callers hear so.
	ForgetToken();
	if (bSigningInAutomatically) FinishAutomatic(false, 0, TEXT("identity request failed (0): signed out"));
	const UGenexSettings* Settings = GetDefault<UGenexSettings>();
	genex::EmbedIdentity::Options Options;
	Options.apiBase = TCHAR_TO_UTF8(*Settings->ApiUrl);
	Options.slug = TCHAR_TO_UTF8(*Settings->Slug);
	Options.http = InHttp;
	if (Clock) Options.clock = [Fn = Clock]() { return Fn(); };
	Identity = MakeShared<genex::EmbedIdentity>(Options);
	UE_LOG(LogGenex, Verbose, TEXT("Genex identity: slug '%s', API %s"), *Settings->Slug, UTF8_TO_TCHAR(Identity->ApiBase().c_str()));
	TWeakObjectPtr<UGenexIdentitySubsystem> Weak(this);
	Identity->onSessionExpired = [Weak]() {
		if (!Weak.IsValid()) return;
		Weak->ForgetToken();
		Weak->OnSessionExpired.Broadcast();
	};
	Identity->onTokenChanged = [Weak]() {
		if (Weak.IsValid()) Weak->NoteToken();
	};
}

void UGenexIdentitySubsystem::NoteToken()
{
	// Just minted, so the identity answers at once (GetToken refreshes only an older token).
	TSharedRef<bool> InCall = MakeShared<bool>(true);
	FString Token;
	Identity->GetToken([InCall, &Token](bool bOk, const std::string& Value, const genex::IdentityError&) {
		if (*InCall && bOk) Token = UTF8_TO_TCHAR(Value.c_str());
	});
	*InCall = false;
	CurrentToken = MoveTemp(Token);
	TokenAtMs = NowMs();
	RefreshAskedAtMs = -1.0e300;
}

void UGenexIdentitySubsystem::ForgetToken()
{
	CurrentToken.Reset();
	TokenAtMs = 0.0;
	RefreshAskedAtMs = -1.0e300;
}

void UGenexIdentitySubsystem::AskRefresh()
{
	const double Now = NowMs();
	if (Now - RefreshAskedAtMs < GenexIdentityDetail::RefreshRetryMs) return;
	RefreshAskedAtMs = Now;
	// GetToken refreshes a due token (concurrent asks share one request); the answer lands in NoteToken.
	Identity->GetToken([](bool, const std::string&, const genex::IdentityError&) {});
}

bool UGenexIdentitySubsystem::TokenForJoinNow(FString& OutToken)
{
	using namespace genex::identity_limits;
	if (!Identity || !Identity->HasToken() || CurrentToken.IsEmpty()) return false;
	if (NowMs() - TokenAtMs >= kRefreshAfterMs) AskRefresh();
	// A refresh may have answered inside AskRefresh (a synchronous transport): read again.
	if (!Identity || !Identity->HasToken() || CurrentToken.IsEmpty()) return false;
	if (NowMs() - TokenAtMs >= kTokenLifetimeMs - kExpiryMarginMs) return false;
	OutToken = CurrentToken;
	return true;
}

void UGenexIdentitySubsystem::KeepTokenFresh()
{
	if (Identity && Identity->HasToken() && NowMs() - TokenAtMs >= genex::identity_limits::kRefreshAfterMs) AskRefresh();
}

void UGenexIdentitySubsystem::Deinitialize()
{
	AutomaticWaiters.Reset();
	bSigningInAutomatically = false;
	ForgetToken();
	Identity.Reset();
	Http.Reset();
	Super::Deinitialize();
}

void UGenexIdentitySubsystem::Finish(bool bOk, int32 Status, const FString& Message, FGenexSignInDone Done)
{
	if (bOk) OnSignedIn.Broadcast();
	else OnSignInFailed.Broadcast(Status, Message);
	Done.ExecuteIfBound(bOk, Status, Message);
}

void UGenexIdentitySubsystem::SignInAsGuest()
{
	SignInAsGuest(FGenexSignInDone());
}

void UGenexIdentitySubsystem::FinishAutomatic(bool bOk, int32 Status, const FString& Message)
{
	bSigningInAutomatically = false;
	TArray<FGenexSignInDone> Waiters = MoveTemp(AutomaticWaiters);
	AutomaticWaiters.Reset();
	if (bOk) OnSignedIn.Broadcast();
	else OnSignInFailed.Broadcast(Status, Message);
	for (FGenexSignInDone& Done : Waiters) Done.ExecuteIfBound(bOk, Status, Message);
}

void UGenexIdentitySubsystem::SignInAsGuest(FGenexSignInDone Done)
{
	if (!Identity)
	{
		Done.ExecuteIfBound(false, 0, TEXT("genex: no identity"));
		return;
	}
	TWeakObjectPtr<UGenexIdentitySubsystem> Weak(this);
	Identity->SignInAsGuest([Weak, Done](bool bOk, const genex::IdentityError& Error) {
		if (Weak.IsValid()) Weak->Finish(bOk, Error.status, UTF8_TO_TCHAR(Error.Describe().c_str()), Done);
	});
}

void UGenexIdentitySubsystem::SignInAsPreviewGuest(FGenexSignInDone Done)
{
	if (!Identity)
	{
		Done.ExecuteIfBound(false, 0, TEXT("genex: no identity"));
		return;
	}
	TWeakObjectPtr<UGenexIdentitySubsystem> Weak(this);
	Identity->SignInAsPreviewGuest([Weak, Done](bool bOk, const genex::IdentityError& Error) {
		if (Weak.IsValid()) Weak->Finish(bOk, Error.status, UTF8_TO_TCHAR(Error.Describe().c_str()), Done);
	});
}

bool UGenexIdentitySubsystem::SignInFromLauncher()
{
	if (!Identity) return false;
	TOptional<FString> Ticket = FGenexMultiplayerModule::TakeLaunchTicket();
	if (!Ticket.IsSet()) return false;
	TWeakObjectPtr<UGenexIdentitySubsystem> Weak(this);
	Identity->RedeemTicket(TCHAR_TO_UTF8(*Ticket.GetValue()), [Weak](bool bOk, const genex::IdentityError& Error) {
		if (Weak.IsValid()) Weak->Finish(bOk, Error.status, UTF8_TO_TCHAR(Error.Describe().c_str()), FGenexSignInDone());
	});
	return true;
}

void UGenexIdentitySubsystem::SignInAutomatically(FGenexSignInDone Done)
{
	using GenexIdentityDetail::Describe;
	if (!Identity)
	{
		Done.ExecuteIfBound(false, 0, TEXT("genex: no identity"));
		return;
	}
	// One request for every caller: a second one would spend nothing (the ticket is one-use) but race a
	// guest sign-in against the ticket, and whichever answered last would become the player.
	AutomaticWaiters.Add(MoveTemp(Done));
	if (bSigningInAutomatically) return;
	bSigningInAutomatically = true;
	TWeakObjectPtr<UGenexIdentitySubsystem> Weak(this);
	auto AsGuest = [Weak]() {
		Weak->Identity->SignInAsGuest([Weak](bool bOk, const genex::IdentityError& Error) {
			if (Weak.IsValid()) Weak->FinishAutomatic(bOk, Error.status, Describe(Error));
		});
	};
	TOptional<FString> Ticket = FGenexMultiplayerModule::TakeLaunchTicket();
	if (!Ticket.IsSet())
	{
		AsGuest();
		return;
	}
	Identity->RedeemTicket(TCHAR_TO_UTF8(*Ticket.GetValue()), [Weak, AsGuest](bool bOk, const genex::IdentityError& Error) {
		if (!Weak.IsValid()) return;
		// A spent or expired ticket (401) falls back to a guest, as §6b says.
		if (!bOk && Error.IsExpired()) AsGuest();
		else Weak->FinishAutomatic(bOk, Error.status, Describe(Error));
	});
}

void UGenexIdentitySubsystem::StartDeviceSignIn()
{
	StartDeviceSignIn(nullptr, FGenexSignInDone());
}

void UGenexIdentitySubsystem::StartDeviceSignIn(TFunction<void(const FGenexDeviceCode&)> OnCode, FGenexSignInDone Done)
{
	using GenexIdentityDetail::Describe;
	if (!Identity)
	{
		Done.ExecuteIfBound(false, 0, TEXT("genex: no identity"));
		return;
	}
	if (!FGenexMultiplayerModule::IsAvailable())
	{
		// The device wait is driven by the core's pump, which does not run without the core.
		Finish(false, 0, TEXT("genex: multiplayer is unavailable (the Colyseus core did not load)"), Done);
		return;
	}
	TWeakObjectPtr<UGenexIdentitySubsystem> Weak(this);
	Identity->StartDeviceSignIn([Weak, OnCode = MoveTemp(OnCode), Done](bool bOk, const genex::DeviceCodeInfo& Info, const genex::IdentityError& Error) {
		if (!Weak.IsValid()) return;
		if (!bOk)
		{
			Weak->Finish(false, Error.status, Describe(Error), Done);
			return;
		}
		FGenexDeviceCode Code;
		Code.UserCode = UTF8_TO_TCHAR(Info.userCode.c_str());
		Code.VerificationUri = UTF8_TO_TCHAR(Info.verificationUri.c_str());
		Code.VerificationUriComplete = UTF8_TO_TCHAR(Info.verificationUriComplete.c_str());
		Code.ExpiresInSeconds = static_cast<float>(Info.expiresInS);
		Weak->OnDeviceCode.Broadcast(Code);
		if (OnCode) OnCode(Code);
		if (!Weak.IsValid() || !Weak->Identity) return;
		Weak->Identity->WaitForDeviceSignIn([Weak, Done](genex::DevicePollStatus Status, const genex::IdentityError& WaitError) {
			if (!Weak.IsValid()) return;
			if (Status == genex::DevicePollStatus::Approved)
			{
				Weak->Finish(true, 0, FString(), Done);
				return;
			}
			const FString Name = UTF8_TO_TCHAR(genex::DevicePollStatusName(Status));
			const FString Why = UTF8_TO_TCHAR(WaitError.message.c_str());
			Weak->Finish(false, WaitError.status, Why.IsEmpty() ? Name : FString::Printf(TEXT("%s (%s)"), *Name, *Why), Done);
		});
	});
}

void UGenexIdentitySubsystem::CancelDeviceSignIn()
{
	if (Identity) Identity->CancelDeviceSignIn();
}

void UGenexIdentitySubsystem::SignOut()
{
	ForgetToken();
	if (Identity) Identity->SignOut();
}

bool UGenexIdentitySubsystem::IsSignedIn() const { return Identity && Identity->HasToken(); }
bool UGenexIdentitySubsystem::IsGuest() const { return Identity && Identity->IsGuest(); }

FString UGenexIdentitySubsystem::GetPlayerName() const
{
	if (!Identity) return FString();
	const genex::Json* Name = Identity->User().Find("name");
	return Name && Name->IsString() ? FString(UTF8_TO_TCHAR(Name->AsString().c_str())) : FString();
}

TArray<FString> UGenexIdentitySubsystem::GetRelayUrls() const
{
	TArray<FString> Out;
	if (Identity) for (const std::string& Url : Identity->RelayUrls()) Out.Add(UTF8_TO_TCHAR(Url.c_str()));
	if (Out.Num() == 0) Out = GetDefault<UGenexSettings>()->RelayUrls;
	return Out;
}

TArray<FString> UGenexIdentitySubsystem::GetAuthorityUrls() const
{
	TArray<FString> Out;
	if (Identity) for (const std::string& Url : Identity->AuthorityUrls()) Out.Add(UTF8_TO_TCHAR(Url.c_str()));
	return Out;
}

void UGenexIdentitySubsystem::GetToken(TFunction<void(bool, const FString&, const FString&)> Done)
{
	if (!Identity || !Identity->HasToken())
	{
		Done(false, FString(), TEXT("not signed in"));
		return;
	}
	Identity->GetToken([Done](bool bOk, const std::string& Token, const genex::IdentityError& Error) {
		Done(bOk, UTF8_TO_TCHAR(Token.c_str()), UTF8_TO_TCHAR(Error.Describe().c_str()));
	});
}
