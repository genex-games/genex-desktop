#include "GenexJsonLibrary.h"

#include "GenexUnrealJson.h"

using namespace GenexUnrealJson;

namespace GenexJsonLibraryDetail
{
genex::Json Object(const FString& Text)
{
	genex::Json Value;
	return Parse(Text, Value) && Value.IsObject() ? Value : genex::Json::MakeObject();
}

const genex::Json* Field(const genex::Json& Value, const FString& Key)
{
	return Value.IsObject() ? Value.Find(Utf8(Key)) : nullptr;
}
}

FString UGenexJsonLibrary::MakeNumbersJson(const TMap<FString, double>& Numbers)
{
	genex::Json Out = genex::Json::MakeObject();
	for (const TPair<FString, double>& Pair : Numbers) Out.Set(Utf8(Pair.Key), Pair.Value);
	return ToText(Out);
}

FString UGenexJsonLibrary::SetNumber(const FString& Json, const FString& Key, double Value)
{
	genex::Json Out = GenexJsonLibraryDetail::Object(Json);
	Out.Set(Utf8(Key), Value);
	return ToText(Out);
}

FString UGenexJsonLibrary::SetString(const FString& Json, const FString& Key, const FString& Value)
{
	genex::Json Out = GenexJsonLibraryDetail::Object(Json);
	Out.Set(Utf8(Key), genex::Json(Utf8(Value)));
	return ToText(Out);
}

double UGenexJsonLibrary::GetNumber(const FString& Json, const FString& Key, double Default)
{
	const genex::Json Value = GenexJsonLibraryDetail::Object(Json);
	const genex::Json* F = GenexJsonLibraryDetail::Field(Value, Key);
	return F && F->IsNumber() ? F->AsNumber(Default) : Default;
}

FString UGenexJsonLibrary::GetString(const FString& Json, const FString& Key)
{
	const genex::Json Value = GenexJsonLibraryDetail::Object(Json);
	const genex::Json* F = GenexJsonLibraryDetail::Field(Value, Key);
	return F && F->IsString() ? FString(UTF8_TO_TCHAR(F->AsString().c_str())) : FString();
}

bool UGenexJsonLibrary::GetBool(const FString& Json, const FString& Key, bool bDefault)
{
	const genex::Json Value = GenexJsonLibraryDetail::Object(Json);
	const genex::Json* F = GenexJsonLibraryDetail::Field(Value, Key);
	return F && F->IsBool() ? F->AsBool(bDefault) : bDefault;
}

FString UGenexJsonLibrary::GetField(const FString& Json, const FString& Key)
{
	const genex::Json Value = GenexJsonLibraryDetail::Object(Json);
	const genex::Json* F = GenexJsonLibraryDetail::Field(Value, Key);
	return F ? ToText(*F) : FString(TEXT("null"));
}

bool UGenexJsonLibrary::IsValidJson(const FString& Json)
{
	genex::Json Value;
	return !Json.TrimStartAndEnd().IsEmpty() && Parse(Json, Value);
}
