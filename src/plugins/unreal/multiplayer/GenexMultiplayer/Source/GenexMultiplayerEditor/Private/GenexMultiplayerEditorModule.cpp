// The editor module: as PIE begins, names the game's running local authority server (Genex Studio
// runs it with genex__authority) to the play in GENEX_AUTHORITY_URL, which the authority session
// joins when the game names no server; as PIE ends, takes back what it named, putting back whatever
// the variable held before (a URL the developer set before starting the editor). Nothing is named
// while no server runs, so PIE then joins only a server the game names itself. The port of
// Studio's Unity GenexAuthorityPlay.cs.
#include "GenexLocalAuthority.h"

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
		const FString Url = FGenexLocalAuthority::Find(FPaths::ProjectDir());
		if (Url.IsEmpty())
		{
			TakeBack(false);
			return;
		}
		Handoff.Name(Url);
		UE_LOG(LogGenexEditor, Display, TEXT("Genex: this play joins the game's local authority server, %s (%s)."), *Url, FGenexLocalAuthority::UrlEnv);
	}

	void TakeBack(bool /*bIsSimulating*/)
	{
		Handoff.TakeBack();
	}

	FDelegateHandle PreBeginHandle;
	FDelegateHandle EndHandle;
	/** The address Genex named for this editor's plays, and what it replaced. */
	FGenexAuthorityUrlHandoff Handoff;
};

IMPLEMENT_MODULE(FGenexMultiplayerEditorModule, GenexMultiplayerEditor)
