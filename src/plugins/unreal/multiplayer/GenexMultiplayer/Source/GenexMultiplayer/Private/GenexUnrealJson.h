// JSON text <-> GenexCore's Json, for the UObject layer (Blueprint carries free-form state as text).
#pragma once

#include "CoreMinimal.h"
#include "GenexCore/GenexJson.h"

namespace GenexUnrealJson
{
inline FString ToText(const genex::Json& Value)
{
	return UTF8_TO_TCHAR(Value.Dump().c_str());
}

inline std::string Utf8(const FString& Text)
{
	return std::string(TCHAR_TO_UTF8(*Text));
}

/** Parse `Text` (empty = null); false with `OutError` set when it is not JSON. */
inline bool Parse(const FString& Text, genex::Json& Out, FString* OutError = nullptr)
{
	if (Text.TrimStartAndEnd().IsEmpty())
	{
		Out = genex::Json();
		return true;
	}
	std::string Error;
	std::optional<genex::Json> Parsed = genex::Json::Parse(Utf8(Text), &Error);
	if (!Parsed)
	{
		if (OutError) *OutError = UTF8_TO_TCHAR(Error.c_str());
		return false;
	}
	Out = std::move(*Parsed);
	return true;
}

/** A number field of an object, or `Fallback`. */
inline double Number(const genex::Json& Object, const char* Key, double Fallback = 0.0)
{
	const genex::Json* Field = Object.IsObject() ? Object.Find(Key) : nullptr;
	return Field && Field->IsNumber() ? Field->AsNumber(Fallback) : Fallback;
}
}
