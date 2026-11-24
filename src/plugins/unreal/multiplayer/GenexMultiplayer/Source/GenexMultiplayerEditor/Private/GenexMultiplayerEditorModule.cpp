// The editor module: as PIE begins, names the game's running local authority server (Genex Studio
// runs it with genex__authority) to the play in GENEX_AUTHORITY_URL, which the authority session
// joins when the game names no server; as PIE ends, takes back what it named, putting back whatever
// the variable held before (a URL the developer set before starting the editor). Nothing is named
// while no server runs, so PIE then joins only a server the game names itself. The port of
// Studio's Unity GenexAuthorityPlay.cs.
//
// The same moment hands the play its practice helper (GenexLocalPractice.h): while Genex Studio runs
// one for the game, the play's model calls go to it; as PIE ends the key is taken away again.
#include "GenexLocalAuthority.h"
#include "GenexLocalPractice.h"

#include "Editor.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogGenexEditor, Log, All);

class FGenexMultiplayerEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		PreBeginHandle = FEditorDelegates::PreBeginPIE.AddRaw(this, &FGenexMultiplayerEditorModule::NameServer);
		EndHandle = FEditorDelegates::EndPIE.AddRaw(this, &FGenexMultiplayerEditorModule::TakeBack);
	}

	virtual void ShutdownModule() override
	{
		FEditorDelegates::PreBeginPIE.Remove(PreBeginHandle);
		FEditorDelegates::EndPIE.Remove(EndHandle);
		TakeBack(false);
	}

private:
	void NameServer(bool /*bIsSimulating*/)
	{
		// The helper's key, or none: a key from an earlier play never outlives its helper.
		const FString Practice = FGenexLocalPractice::Find(FPaths::ProjectDir());
		FGenexLocalPractice::Hand(Practice);
		if (!Practice.IsEmpty()) UE_LOG(LogGenexEditor, Display, TEXT("Genex: this play's model calls go to the game's practice helper on this computer."));
		const FString Url = FGenexLocalAuthority::Find(FPaths::ProjectDir());
		if (Url.IsEmpty())
		{
			// Only the server's address: the practice key handed above stays for this play.
			Handoff.TakeBack();
			return;
		}
		Handoff.Name(Url);
		UE_LOG(LogGenexEditor, Display, TEXT("Genex: this play joins the game's local authority server, %s (%s)."), *Url, FGenexLocalAuthority::UrlEnv);
	}

	void TakeBack(bool /*bIsSimulating*/)
	{
		FGenexLocalPractice::Hand(FString());
		Handoff.TakeBack();
	}

	FDelegateHandle PreBeginHandle;
	FDelegateHandle EndHandle;
	/** The address Genex named for this editor's plays, and what it replaced. */
	FGenexAuthorityUrlHandoff Handoff;
};

IMPLEMENT_MODULE(FGenexMultiplayerEditorModule, GenexMultiplayerEditor)
