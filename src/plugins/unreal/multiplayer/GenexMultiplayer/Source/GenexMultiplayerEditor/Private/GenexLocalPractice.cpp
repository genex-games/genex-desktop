#include "GenexLocalPractice.h"

#include "GenexCore/GenexModelsHttp.h"
#include "GenexLocalAuthority.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformMisc.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"

#include <optional>
#include <string>

const TCHAR* FGenexLocalPractice::KeyEnv = TEXT("GENEX_LLM_PRACTICE");
const TCHAR* FGenexLocalPractice::HandoffName = TEXT("llm-practice.json");

namespace GenexLocalPracticeDetail
{
bool IsSpace(TCHAR C) { return C == ' ' || C == '\t' || C == '\n' || C == '\r' || C == '\f' || C == '\v'; }
void SkipSpace(const FString& S, int32& I) { while (I < S.Len() && IsSpace(S[I])) ++I; }
bool Expect(const FString& S, int32& I, const TCHAR* Literal)
{
	const int32 N = FCString::Strlen(Literal);
	if (I + N > S.Len() || FCString::Strncmp(*S + I, Literal, N) != 0) return false;
	I += N;
	return true;
}

/** The handoff's text, when it is a small plain file in a plain folder of the game. */
bool ReadHandoff(const FString& Game, FString& Out)
{
	const FString Folder = FPaths::Combine(Game, FGenexLocalAuthority::HandoffFolder);
	if (!FPaths::DirectoryExists(Folder) || FGenexLocalAuthority::IsLink(Folder)) return false;
	const FString File = FPaths::Combine(Folder, FGenexLocalPractice::HandoffName);
	if (!FPaths::FileExists(File) || FGenexLocalAuthority::IsLink(File)) return false;
	const int64 Size = IFileManager::Get().FileSize(*File);
	if (Size < 0 || Size > FGenexLocalPractice::MaxHandoffBytes) return false;
	return FFileHelper::LoadFileToString(Out, *File);
}
}

FString FGenexLocalPractice::Parse(const FString& Text)
{
	// ^\s*\{\s*"key"\s*:\s*"<port>.<32 hex>"\s*\}\s*$, the key as GenexCore reads one.
	using namespace GenexLocalPracticeDetail;
	int32 I = 0;
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("{"))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("\"key\""))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT(":"))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("\""))) return FString();
	const int32 KeyStart = I;
	while (I < Text.Len() && Text[I] != '"') ++I;
	const FString Key = Text.Mid(KeyStart, I - KeyStart);
	if (!Expect(Text, I, TEXT("\""))) return FString();
	SkipSpace(Text, I);
	if (!Expect(Text, I, TEXT("}"))) return FString();
	SkipSpace(Text, I);
	if (I != Text.Len()) return FString();
	// A character outside ASCII is no key; the narrow copy below would otherwise fold it.
	for (const TCHAR C : Key)
	{
		if (C < 0x21 || C > 0x7e) return FString();
	}
	const std::optional<genex::models::PracticeTarget> Target = genex::models::ParsePracticeKey(std::string(TCHAR_TO_UTF8(*Key)));
	return Target ? Key : FString();
}

FString FGenexLocalPractice::Find(const FString& Project, TFunction<bool(int32)> AnswersFn)
{
	const FString Game = FGenexLocalAuthority::GameFolder(Project);
	if (Game.IsEmpty()) return FString();
	FString Text;
	if (!GenexLocalPracticeDetail::ReadHandoff(Game, Text)) return FString();
	const FString Key = Parse(Text);
	if (Key.IsEmpty()) return FString();
	FString PortText;
	Key.Split(TEXT("."), &PortText, nullptr);
	const int32 Port = FCString::Atoi(*PortText);
	const bool bAnswers = AnswersFn ? AnswersFn(Port) : FGenexLocalAuthority::Answers(Port);
	return bAnswers ? Key : FString();
}

void FGenexLocalPractice::Hand(const FString& Key)
{
	// Setting it empty removes it: a play with no helper asks Genex, as a published game does.
	FPlatformMisc::SetEnvironmentVar(KeyEnv, *Key);
}
