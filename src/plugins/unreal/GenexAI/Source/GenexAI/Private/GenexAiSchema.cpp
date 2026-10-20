#include "GenexAiSchema.h"

#include "Dom/JsonObject.h"
#include "JsonObjectConverter.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UObject/EnumProperty.h"
#include "UObject/TextProperty.h"
#include "UObject/UnrealType.h"

namespace
{
	const FName MaxItemsMeta(TEXT("GenexMaxItems"));
	const FName MaxLengthMeta(TEXT("GenexMaxLength"));

	TSharedPtr<FJsonObject> OfProperty(const FProperty* Property, int32 Depth, FString& Why);

	/** A meta bound on the property, when it names a whole number. */
	void Bound(const FProperty* Property, const FName& Meta, const TCHAR* Field, TSharedPtr<FJsonObject> Schema)
	{
#if WITH_METADATA
		if (Property && Property->HasMetaData(Meta))
		{
			Schema->SetNumberField(Field, FCString::Atoi(*Property->GetMetaData(Meta)));
		}
#endif
	}

	TSharedPtr<FJsonObject> Typed(const TCHAR* Type)
	{
		TSharedPtr<FJsonObject> Schema = MakeShared<FJsonObject>();
		Schema->SetStringField(TEXT("type"), Type);
		return Schema;
	}

	/** An enum as a string enum of its names, without the hidden _MAX entry. */
	TSharedPtr<FJsonObject> OfEnum(const UEnum* Enum)
	{
		TArray<TSharedPtr<FJsonValue>> Names;
		const int32 Count = Enum->ContainsExistingMax() ? Enum->NumEnums() - 1 : Enum->NumEnums();
		for (int32 Index = 0; Index < Count; ++Index)
		{
			Names.Add(MakeShared<FJsonValueString>(Enum->GetNameStringByIndex(Index)));
		}
		TSharedPtr<FJsonObject> Schema = Typed(TEXT("string"));
		Schema->SetArrayField(TEXT("enum"), Names);
		return Schema;
	}

	TSharedPtr<FJsonObject> OfStruct(const UScriptStruct* Struct, int32 Depth, FString& Why)
	{
		if (Depth > GenexAiSchema::MaxDepth)
		{
			Why = FString::Printf(TEXT("%s nests deeper than %d."), *Struct->GetName(), GenexAiSchema::MaxDepth);
			return nullptr;
		}
		TSharedPtr<FJsonObject> Properties = MakeShared<FJsonObject>();
		TArray<TSharedPtr<FJsonValue>> Required;
		for (TFieldIterator<FProperty> It(Struct); It; ++It)
		{
			const FString Name = FJsonObjectConverter::StandardizeCase(It->GetAuthoredName());
			TSharedPtr<FJsonObject> Inner = OfProperty(*It, Depth + 1, Why);
			if (!Inner)
			{
				return nullptr;
			}
			Properties->SetObjectField(Name, Inner);
			Required.Add(MakeShared<FJsonValueString>(Name));
		}
		TSharedPtr<FJsonObject> Schema = Typed(TEXT("object"));
		Schema->SetObjectField(TEXT("properties"), Properties);
		Schema->SetArrayField(TEXT("required"), Required);
		Schema->SetBoolField(TEXT("additionalProperties"), false);
		return Schema;
	}

	TSharedPtr<FJsonObject> OfProperty(const FProperty* Property, int32 Depth, FString& Why)
	{
		if (Depth > GenexAiSchema::MaxDepth)
		{
			Why = FString::Printf(TEXT("%s nests deeper than %d."), *Property->GetName(), GenexAiSchema::MaxDepth);
			return nullptr;
		}
		if (Property->IsA<FStrProperty>() || Property->IsA<FNameProperty>() || Property->IsA<FTextProperty>())
		{
			TSharedPtr<FJsonObject> Schema = Typed(TEXT("string"));
			Bound(Property, MaxLengthMeta, TEXT("maxLength"), Schema);
			return Schema;
		}
		if (Property->IsA<FBoolProperty>())
		{
			return Typed(TEXT("boolean"));
		}
		if (const FEnumProperty* EnumProperty = CastField<FEnumProperty>(Property))
		{
			return OfEnum(EnumProperty->GetEnum());
		}
		if (const FByteProperty* Byte = CastField<FByteProperty>(Property); Byte && Byte->Enum)
		{
			return OfEnum(Byte->Enum);
		}
		if (const FNumericProperty* Number = CastField<FNumericProperty>(Property))
		{
			return Typed(Number->IsFloatingPoint() ? TEXT("number") : TEXT("integer"));
		}
		if (const FArrayProperty* Array = CastField<FArrayProperty>(Property))
		{
			TSharedPtr<FJsonObject> Items = OfProperty(Array->Inner, Depth + 1, Why);
			if (!Items)
			{
				return nullptr;
			}
			TSharedPtr<FJsonObject> Schema = Typed(TEXT("array"));
			Schema->SetObjectField(TEXT("items"), Items);
			Bound(Property, MaxItemsMeta, TEXT("maxItems"), Schema);
			return Schema;
		}
		if (const FStructProperty* Inner = CastField<FStructProperty>(Property))
		{
			return OfStruct(Inner->Struct, Depth, Why);
		}
		Why = FString::Printf(TEXT("%s is not a type Genex's schema can say."), *Property->GetName());
		return nullptr;
	}
}

TSharedPtr<FJsonObject> GenexAiSchema::ObjectFor(const UScriptStruct* Struct, FString& Why)
{
	if (!Struct)
	{
		Why = TEXT("no struct");
		return nullptr;
	}
	// The root is depth 0, as Genex's own check counts it (`checkSchema`): five nested structs and a leaf fit.
	return OfStruct(Struct, 0, Why);
}

FString GenexAiSchema::For(const UScriptStruct* Struct, FString& Why)
{
	const TSharedPtr<FJsonObject> Schema = ObjectFor(Struct, Why);
	if (!Schema)
	{
		return FString();
	}
	FString Text;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Text);
	FJsonSerializer::Serialize(Schema.ToSharedRef(), Writer);
	return Text;
}
