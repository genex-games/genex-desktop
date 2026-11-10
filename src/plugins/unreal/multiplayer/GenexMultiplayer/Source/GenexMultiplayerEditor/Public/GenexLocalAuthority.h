// Editor only: the game's running local authority server, which Genex Studio names in the game's
// folder while it runs (genex__authority writes .studio/authority.json as
// {"url": "ws://127.0.0.1:<port>"} and removes it once the server ends). The editor module names
// it to PIE in GENEX_AUTHORITY_URL as PIE begins, which UGenexAuthoritySubsystem joins when the
// game names no server, and takes it back when PIE ends.
//
// A port of Studio's Unity GenexLocalAuthority.cs (genex-desktop src/plugins/unity/multiplayer/
// genex-game/): only a loopback address on an unprivileged port, in a small plain file (no link)
// of the game's own folder, whose port answers right now, is ever named.
#pragma once

#include "CoreMinimal.h"

class GENEXMULTIPLAYEREDITOR_API FGenexLocalAuthority
{
public:
	/** The variable the authority session reads the server from when the game names none. */
	static const TCHAR* UrlEnv;
	/** Where Studio names the game's running server, inside the game's folder. */
	static const TCHAR* HandoffFolder;
	static const TCHAR* HandoffName;
	/** The file that marks a Genex game's folder. */
	static const TCHAR* GameMarker;
	/** How far above the Unreal project the game's folder may be (unreal/, or a little deeper). */
	static constexpr int32 MaxLevels = 3;
	static constexpr int64 MaxHandoffBytes = 1024;
	static constexpr int32 ProbeMs = 300;
	static constexpr int32 MinPort = 1024;
	static constexpr int32 MaxPort = 65535;

	/** The Genex game folder holding the Unreal project folder `Project`, or empty. */
	static FString GameFolder(const FString& Project);

	/** The loopback address a handoff's text names (`ws://127.0.0.1:<port>`), or empty for anything else. */
	static FString Parse(const FString& Text);

	/** The game's running local authority server for the Unreal project folder `Project`, or empty:
	 *  named in the game's folder, loopback, and answering on its port. `Answers` replaces the probe. */
	static FString Find(const FString& Project, TFunction<bool(int32)> Answers = nullptr);

	/** Whether something accepts a TCP connection on 127.0.0.1:`Port` within ProbeMs. */
	static bool Answers(int32 Port);

	/** Whether `Path` is a symbolic link (or, on Windows, any reparse point). */
	static bool IsLink(const FString& Path);
};

/** The editor module's hold on GENEX_AUTHORITY_URL while a play runs: Name() points it at the game's
 *  local server, TakeBack() puts back whatever the variable held before (a URL the developer set
 *  before starting the editor survives every play). */
class GENEXMULTIPLAYEREDITOR_API FGenexAuthorityUrlHandoff
{
public:
	/** Point GENEX_AUTHORITY_URL at `Url`. The first Name since the last TakeBack remembers the value it replaces. */
	void Name(const FString& Url);
	/** Put back the value GENEX_AUTHORITY_URL held before the first Name; nothing when nothing is named. */
	void TakeBack();
	bool IsNamed() const { return bNamed; }

private:
	bool bNamed = false;
	FString Previous;
};
