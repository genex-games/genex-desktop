// Editor only: the practice helper of a game being developed. While a game is made in Genex's
// desktop app, the app runs `genex llm practice` for it (made-up answers, the maker's own AI plan,
// or real models under a cap the maker set) and names the helper in the game's folder as
// .studio/llm-practice.json, {"key": "<port>.<32 hex>"}, removing the file when the helper ends. As
// PIE begins the editor module hands that key to the play in GENEX_LLM_PRACTICE, which
// UGenexModelsSubsystem takes: the play's model calls then go to that helper on 127.0.0.1 instead of
// to Genex, with nobody signed in and no credits spent unless the maker chose real models.
//
// This lives in the editor module on purpose: a packaged game has no editor module, so no game a
// player installs ever reads the file. Only a key that names a port on this computer, in a small
// plain file (no link) of the game's own folder, whose port answers right now, is ever handed on.
#pragma once

#include "CoreMinimal.h"

class GENEXMULTIPLAYEREDITOR_API FGenexLocalPractice
{
public:
	/** The variable UGenexModelsSubsystem takes the helper's key from (GenexCore's kPracticeEnv). */
	static const TCHAR* KeyEnv;
	/** The handoff's name inside the game's `.studio` folder. */
	static const TCHAR* HandoffName;
	static constexpr int64 MaxHandoffBytes = 1024;

	/** The key a handoff's text names (`<port>.<32 hex>`), or empty for anything else. */
	static FString Parse(const FString& Text);

	/** The key of the game's running practice helper for the Unreal project folder `Project`, or
	 *  empty: named in the game's folder and answering on its port. `Answers` replaces the probe. */
	static FString Find(const FString& Project, TFunction<bool(int32)> Answers = nullptr);

	/** Hand `Key` to the play about to begin; an empty key takes away one handed before. */
	static void Hand(const FString& Key);
};
