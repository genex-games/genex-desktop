// The player's Genex identity for this game instance: the three native sign-in doors of
// CLI_INTEGRATION.md §6b over GenexCore's EmbedIdentity (on Unreal's HTTP module), and the token
// every join reads, fresh before each one (PROTOCOL.md §3.2). Tokens are never logged or saved.
//
//   Door 1  SignInAsGuest            a save-less guest of a PUBLISHED game
//   Door 2  SignInFromLauncher       the one-use GENEX_EMBED_TICKET a Genex launcher passed (read
//                                    once at startup and removed from the environment)
//   Door 3  StartDeviceSignIn        show a code; the player approves it on genex.games
//
// The relay and authority subsystems use it on their own: a join with nobody signed in tries the
// launcher's ticket, then a guest — or, for a server on this machine, the local test placeholder.
// Automatic sign-ins that overlap (a relay and an authority join at startup) share ONE request, so the
// one-use ticket is redeemed once and every caller hears the same answer. The Blueprint sign-in nodes
// complete on their own request, never on another caller's.
#pragma once

#include "CoreMinimal.h"
#include "GenexTypes.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "GenexIdentitySubsystem.generated.h"

namespace genex { class EmbedIdentity; class IHttp; }
class FGenexUnrealHttp;

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FGenexSignedInSignature);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FGenexSignInFailedSignature, int32, Status, const FString&, Message);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FGenexDeviceCodeSignature, const FGenexDeviceCode&, Code);

/** One sign-in's outcome, for C++ callers: the HTTP status (0 = no answer or a local failure) and why. */
DECLARE_DELEGATE_ThreeParams(FGenexSignInDone, bool /*bOk*/, int32 /*Status*/, const FString& /*Error*/);

UCLASS()
class GENEXMULTIPLAYER_API UGenexIdentitySubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	/** Out of line, and the members are TSharedPtr (whose deleter is bound where it is made): their types
	 *  are complete only in the .cpp, never in UHT's generated file. */
	UGenexIdentitySubsystem();
	virtual ~UGenexIdentitySubsystem() override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** Door 1. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity")
	void SignInAsGuest();
	/** Door 2: true when the game was started by a Genex launcher (a ticket was there). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity")
	bool SignInFromLauncher();
	/** Door 3: OnDeviceCode fires with what to show, then OnSignedIn once the player approves. */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity")
	void StartDeviceSignIn();
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity")
	void CancelDeviceSignIn();
	/** Forget the token here (nothing is sent). */
	UFUNCTION(BlueprintCallable, Category = "Genex|Identity")
	void SignOut();

	UFUNCTION(BlueprintPure, Category = "Genex|Identity")
	bool IsSignedIn() const;
	UFUNCTION(BlueprintPure, Category = "Genex|Identity")
	bool IsGuest() const;
	/** The display name of the signed-in player, when the API sent one. */
	UFUNCTION(BlueprintPure, Category = "Genex|Identity")
	FString GetPlayerName() const;
	/** The relay URLs the last sign-in answered (else the project's development RelayUrls). */
	UFUNCTION(BlueprintPure, Category = "Genex|Identity")
	TArray<FString> GetRelayUrls() const;
	/** The authority cluster's URLs the last sign-in answered (colyseus.authorityUrls). */
	UFUNCTION(BlueprintPure, Category = "Genex|Identity")
	TArray<FString> GetAuthorityUrls() const;

	UPROPERTY(BlueprintAssignable, Category = "Genex|Identity")
	FGenexSignedInSignature OnSignedIn;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Identity")
	FGenexSignInFailedSignature OnSignInFailed;
	UPROPERTY(BlueprintAssignable, Category = "Genex|Identity")
	FGenexDeviceCodeSignature OnDeviceCode;
	/** The identity ended (a refresh answered 401): sign in again. */
	UPROPERTY(BlueprintAssignable, Category = "Genex|Identity")
	FGenexSignedInSignature OnSessionExpired;

	// ---- C++ ----
	void SignInAsGuest(FGenexSignInDone Done);
	/** Door 1's preview form (GenexCore's SignInAsPreviewGuest), for a test client on a draft's preview. */
	void SignInAsPreviewGuest(FGenexSignInDone Done);
	/** Door 2 then door 1: the launcher's ticket when there is one, else a guest. A call while one is
	 *  under way joins it (one request, the same answer for every caller). */
	void SignInAutomatically(FGenexSignInDone Done);
	/** Door 3 for one caller: `OnCode` with what to show, then `Done` once the player approved it, or
	 *  with why not (denied, expired, failed, or "cancelled" when a newer device sign-in replaced it). */
	void StartDeviceSignIn(TFunction<void(const FGenexDeviceCode&)> OnCode, FGenexSignInDone Done);
	/** The token a join starting RIGHT NOW sends (the relay session asks synchronously before every
	 *  join it starts): the identity's current token while it is valid, never one past its lifetime.
	 *  A refresh that is due is asked for on the way; its answer serves the joins after it. */
	bool TokenForJoinNow(FString& OutToken);
	/** Ask for a refresh when the token is due one (at most every 30 s); an open session that may join
	 *  again (a requeue, a re-search) calls it every frame, so its token never ages out. */
	void KeepTokenFresh();
	/** A token fit for a join right now (refreshed when due). `Done(bOk, Token, Error)`. */
	void GetToken(TFunction<void(bool, const FString&, const FString&)> Done);
	/** GenexCore's identity, or null before Initialize. */
	genex::EmbedIdentity* Core() const { return Identity.Get(); }
	/** Another HTTP transport (null = Unreal's HTTP module) and clock (empty = genex::Clock): tests
	 *  answer the doors with a fake. Starts a fresh identity: whoever was signed in is signed out. The
	 *  transport must outlive this subsystem or the next SetTransport. */
	void SetTransport(genex::IHttp* InHttp, TFunction<double()> InClock = nullptr);

private:
	void MakeIdentity(genex::IHttp* InHttp);
	void Finish(bool bOk, int32 Status, const FString& Message, FGenexSignInDone Done);
	void FinishAutomatic(bool bOk, int32 Status, const FString& Message);
	/** Mirror the identity's new token (onTokenChanged) for TokenForJoinNow; cleared with it. */
	void NoteToken();
	void ForgetToken();
	void AskRefresh();
	double NowMs() const;

	TSharedPtr<FGenexUnrealHttp> Http;
	TSharedPtr<genex::EmbedIdentity> Identity;
	TFunction<double()> Clock;
	/** Every caller of the automatic sign-in under way. */
	TArray<FGenexSignInDone> AutomaticWaiters;
	bool bSigningInAutomatically = false;
	/** The identity's current token (in memory only, never logged or saved) and when it was minted. */
	FString CurrentToken;
	double TokenAtMs = 0.0;
	double RefreshAskedAtMs = -1.0e300;
};
