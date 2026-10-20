#include "GenexAiSubsystem.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "GenexAiSchema.h"
#include "HAL/PlatformTime.h"
#include "Misc/Base64.h"
#include "Misc/ScopeLock.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace
{
	constexpr int32 Wire = 1;
	constexpr int32 MaxInFlight = 4;
	constexpr int32 MaxEcho = 64;
	constexpr double RelayFreshSeconds = 3.0;
	const TCHAR* NoGrant = TEXT("no-grant");
	const TCHAR* OpReply = TEXT("ai.reply");
	const TCHAR* OpDelta = TEXT("ai.delta");

	/** The game instance Studio relays for: the newest one playing. */
	TWeakObjectPtr<UGenexAiSubsystem> Active;
	/** When Studio last pulled, on the platform clock; negative before the first pull of a play. */
	double LastPull = -1.0;

	using FCondensedWriter = TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>;
	using FCondensedWriterFactory = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>;

	FString Condensed(const TSharedRef<FJsonObject>& Object)
	{
		FString Text;
		const TSharedRef<FCondensedWriter> Writer = FCondensedWriterFactory::Create(&Text);
		FJsonSerializer::Serialize(Object, Writer);
		return Text;
	}

	FString CondensedValue(const TSharedPtr<FJsonValue>& Value)
	{
		if (!Value.IsValid())
		{
			return FString();
		}
		FString Text;
		const TSharedRef<FCondensedWriter> Writer = FCondensedWriterFactory::Create(&Text);
		FJsonSerializer::Serialize(Value, FString(), Writer);
		return Text;
	}

	TSharedPtr<FJsonValue> TextOrNull(const FString& Text)
	{
		if (Text.IsEmpty())
		{
			return MakeShared<FJsonValueNull>();
		}
		return MakeShared<FJsonValueString>(Text);
	}

	TArray<TSharedPtr<FJsonValue>> Strings(const TArray<FString>& List)
	{
		TArray<TSharedPtr<FJsonValue>> Out;
		for (const FString& Item : List)
		{
			Out.Add(MakeShared<FJsonValueString>(Item));
		}
		return Out;
	}

	void Remember(TArray<FString>& List, const FString& Rid)
	{
		List.Add(Rid);
		if (List.Num() > MaxEcho)
		{
			List.RemoveAt(0);
		}
	}

	bool IsTier(const FString& Tier) { return Tier == GenexAiWords::Fast || Tier == GenexAiWords::Smart; }
	bool IsAuthority(const FString& Authority) { return Authority == GenexAiWords::Local || Authority == GenexAiWords::Shared; }
}

void UGenexAiSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	Active = this;
	LastPull = -1.0;
}

void UGenexAiSubsystem::Deinitialize()
{
	if (Active.Get() == this)
	{
		Active.Reset();
		LastPull = -1.0;
	}
	FScopeLock Lock(&Gate);
	Waiting.Reset();
	WaitingOrder.Reset();
	Routed.Reset();
	Super::Deinitialize();
}

// --- What a game calls ---

FString UGenexAiSubsystem::Ask(const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options)
{
	TSharedPtr<FJsonObject> Schema;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(SchemaJson);
	if (!FJsonSerializer::Deserialize(Reader, Schema) || !Schema.IsValid())
	{
		return Refused(Site, Options, GenexAiWords::CodeInvalidSchema);
	}
	return Call(TEXT("ask"), Site, Prompt, MakeShared<FJsonValueObject>(Schema), Options);
}

FString UGenexAiSubsystem::AskStruct(const FString& Site, const FString& Prompt, const UScriptStruct* Struct, const FGenexAiOptions& Options)
{
	FString Why;
	const TSharedPtr<FJsonObject> Schema = GenexAiSchema::ObjectFor(Struct, Why);
	if (!Schema.IsValid())
	{
		return Refused(Site, Options, GenexAiWords::CodeInvalidSchema);
	}
	return Call(TEXT("ask"), Site, Prompt, MakeShared<FJsonValueObject>(Schema), Options);
}

FString UGenexAiSubsystem::Say(const FString& Site, const FString& Prompt, const FGenexAiOptions& Options)
{
	return Call(TEXT("say"), Site, Prompt, MakeShared<FJsonValueNull>(), Options);
}

FString UGenexAiSubsystem::Judge(const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options)
{
	TSharedPtr<FJsonObject> Schema;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(SchemaJson);
	if (!FJsonSerializer::Deserialize(Reader, Schema) || !Schema.IsValid())
	{
		return Refused(Site, Options, GenexAiWords::CodeInvalidSchema);
	}
	return Call(TEXT("judge"), Site, Prompt, MakeShared<FJsonValueObject>(Schema), Options);
}

FString UGenexAiSubsystem::Act(const FString& Site, const FString& Prompt, const FString& SchemaJson, const FGenexAiOptions& Options)
{
	TSharedPtr<FJsonObject> Schema;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(SchemaJson);
	if (!FJsonSerializer::Deserialize(Reader, Schema) || !Schema.IsValid())
	{
		return Refused(Site, Options, GenexAiWords::CodeInvalidSchema);
	}
	return Call(TEXT("act"), Site, Prompt, MakeShared<FJsonValueObject>(Schema), Options);
}

void UGenexAiSubsystem::Cancel(const FString& Ticket)
{
	TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetStringField(TEXT("ticket"), Ticket);
	Send(TEXT("cancel"), MakeShared<FJsonValueObject>(Body), FPending{EKind::Other});
}

TArray<FGenexAiResult> UGenexAiSubsystem::Drain()
{
	TArray<FGenexAiResult> Out = TakeArrived();
	if (bChanged)
	{
		bChanged = false;
		OnChanged.Broadcast();
	}
	return Out;
}

FString UGenexAiSubsystem::Partial(const FString& Ticket) const
{
	FScopeLock Lock(&Gate);
	const FString* Text = Partials.Find(Ticket);
	return Text ? *Text : FString();
}

void UGenexAiSubsystem::StartAi(const TArray<FString>& Tiers)
{
	TArray<FString> AskedTiers;
	for (const FString& Tier : Tiers)
	{
		if (IsTier(Tier))
		{
			AskedTiers.AddUnique(Tier);
		}
	}
	if (AskedTiers.IsEmpty())
	{
		AskedTiers.Add(GenexAiWords::Fast);
	}
	TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetNumberField(TEXT("v"), Wire);
	Body->SetStringField(TEXT("requires"), Requires == GenexAiWords::RequiresAi ? GenexAiWords::RequiresAi : GenexAiWords::RequiresOptional);
	Body->SetArrayField(TEXT("tiers"), Strings(AskedTiers));
	Send(TEXT("budget.request"), MakeShared<FJsonValueObject>(Body), FPending{EKind::Grant});
}

void UGenexAiSubsystem::StopAi()
{
	Send(TEXT("budget.stop"), MakeShared<FJsonValueNull>(), FPending{EKind::Other});
	{
		FScopeLock Lock(&Gate);
		Grant.Reset();
	}
	OnChanged.Broadcast();
}

bool UGenexAiSubsystem::IsOn() const
{
	FScopeLock Lock(&Gate);
	return bOn;
}

void UGenexAiSubsystem::Route(const FString& Ticket, TFunction<void(const FGenexAiResult&)> Done)
{
	FScopeLock Lock(&Gate);
	Routed.Add(Ticket, MoveTemp(Done));
}

// --- The tick: the Ask AI nodes' results, and a relay that stopped pulling ---

bool UGenexAiSubsystem::IsTickable() const
{
	FScopeLock Lock(&Gate);
	return !IsTemplate() && (Routed.Num() > 0 || Waiting.Num() > 0);
}

TStatId UGenexAiSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(UGenexAiSubsystem, STATGROUP_Tickables);
}

void UGenexAiSubsystem::Tick(float DeltaTime)
{
	TArray<TPair<TFunction<void(const FGenexAiResult&)>, FGenexAiResult>> Done;
	{
		FScopeLock Lock(&Gate);
		if (Waiting.Num() > 0 && !RelayFresh())
		{
			EndWaiting(GenexAiWords::CodeOff);
		}
		for (int32 Index = Arrived.Num() - 1; Index >= 0; --Index)
		{
			TFunction<void(const FGenexAiResult&)> Callback;
			if (Routed.RemoveAndCopyValue(Arrived[Index].Ticket, Callback))
			{
				Done.Insert(TPair<TFunction<void(const FGenexAiResult&)>, FGenexAiResult>(MoveTemp(Callback), Arrived[Index]), 0);
				Arrived.RemoveAt(Index);
			}
		}
	}
	for (TPair<TFunction<void(const FGenexAiResult&)>, FGenexAiResult>& Pair : Done)
	{
		Pair.Key(Pair.Value);
	}
}

// --- Sending ---

FString UGenexAiSubsystem::Call(const FString& Op, const FString& Site, const FString& Prompt, TSharedPtr<FJsonValue> Schema, const FGenexAiOptions& Options)
{
	const FPending Entry = NewCall(Site, Options);
	TSharedPtr<FJsonObject> Untrusted = MakeShared<FJsonObject>();
	for (const TPair<FString, FString>& Field : Options.Untrusted)
	{
		Untrusted->SetStringField(Field.Key, Field.Value);
	}
	TSharedPtr<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetNumberField(TEXT("v"), Wire);
	Body->SetStringField(TEXT("op"), Op);
	Body->SetStringField(TEXT("site"), Site);
	Body->SetStringField(TEXT("ticket"), Entry.Ticket);
	Body->SetStringField(TEXT("grantId"), GrantId());
	Body->SetField(TEXT("system"), TextOrNull(Options.System));
	Body->SetStringField(TEXT("prompt"), Prompt);
	Body->SetObjectField(TEXT("untrusted"), Untrusted);
	Body->SetField(TEXT("memory"), TextOrNull(Options.Memory));
	Body->SetField(TEXT("schema"), Schema);
	Body->SetStringField(TEXT("tier"), IsTier(Options.Tier) ? Options.Tier : FString(GenexAiWords::Fast));
	Body->SetStringField(TEXT("authority"), IsAuthority(Options.Authority) ? Options.Authority : FString(GenexAiWords::Local));
	Body->SetNumberField(TEXT("maxOutputTokens"), FMath::Max(1, Options.MaxOutputTokens));
	Body->SetBoolField(TEXT("stream"), Op == TEXT("say"));
	Send(TEXT("call"), MakeShared<FJsonValueObject>(Body), Entry);
	return Entry.Ticket;
}

UGenexAiSubsystem::FPending UGenexAiSubsystem::NewCall(const FString& Site, const FGenexAiOptions& Options)
{
	FScopeLock Lock(&Gate);
	Tickets += 1;
	FPending Entry;
	Entry.Kind = EKind::Call;
	Entry.Ticket = FString::Printf(TEXT("uetk-%08d"), Tickets);
	Entry.Site = Site;
	Entry.FallbackJson = Options.FallbackJson;
	return Entry;
}

FString UGenexAiSubsystem::Refused(const FString& Site, const FGenexAiOptions& Options, const TCHAR* Code)
{
	const FPending Entry = NewCall(Site, Options);
	FScopeLock Lock(&Gate);
	Arrived.Add(Failure(Entry, Code));
	return Entry.Ticket;
}

FString UGenexAiSubsystem::GrantId() const
{
	FScopeLock Lock(&Gate);
	FString Id;
	return Grant.IsValid() && Grant->TryGetStringField(TEXT("id"), Id) ? Id : FString(NoGrant);
}

void UGenexAiSubsystem::Send(const FString& Op, TSharedPtr<FJsonValue> Body, const FPending& Entry)
{
	FScopeLock Lock(&Gate);
	if (!RelayFresh())
	{
		Settle(Entry, GenexAiWords::CodeOff);
		return;
	}
	if (Waiting.Num() >= MaxInFlight)
	{
		Settle(Entry, GenexAiWords::CodeConcurrency);
		return;
	}
	Rids += 1;
	const FString Rid = FString::Printf(TEXT("ueai-%08d"), Rids);
	Waiting.Add(Rid, Entry);
	WaitingOrder.Add(Rid);
	Remember(Asked, Rid);
	TSharedRef<FJsonObject> Line = MakeShared<FJsonObject>();
	Line->SetStringField(TEXT("event"), TEXT("ai"));
	Line->SetStringField(TEXT("rid"), Rid);
	Line->SetStringField(TEXT("op"), Op);
	Line->SetField(TEXT("body"), Body);
	Queued.Add(Condensed(Line));
}

bool UGenexAiSubsystem::RelayFresh() const
{
#if WITH_EDITOR
	return LastPull >= 0.0 && FPlatformTime::Seconds() - LastPull <= RelayFreshSeconds;
#else
	return false;
#endif
}

// --- Answers ---

bool UGenexAiSubsystem::TakeStudioOp(const FString& Op, const TSharedPtr<FJsonObject>& Args)
{
	FString Rid;
	if (!Args.IsValid() || !Args->TryGetStringField(TEXT("rid"), Rid))
	{
		return false;
	}
	FScopeLock Lock(&Gate);
	FPending* Entry = Waiting.Find(Rid);
	if (!Entry)
	{
		return false;
	}
	if (Op == OpDelta)
	{
		FString Text;
		if (Entry->Kind != EKind::Call || !Args->TryGetStringField(TEXT("text"), Text))
		{
			return false;
		}
		Partials.Add(Entry->Ticket, Text);
		return true;
	}
	if (Op != OpReply)
	{
		return false;
	}
	const FPending Taken = *Entry;
	Waiting.Remove(Rid);
	WaitingOrder.Remove(Rid);
	Remember(Answered, Rid);
	const TSharedPtr<FJsonObject>* Reply = nullptr;
	const TSharedPtr<FJsonObject> Answer = Args->TryGetObjectField(TEXT("reply"), Reply) && Reply ? *Reply : MakeShared<FJsonObject>();
	if (Taken.Kind == EKind::Call)
	{
		Partials.Remove(Taken.Ticket);
		Arrived.Add(ResultOf(Taken, Answer));
	}
	else if (Taken.Kind == EKind::Grant)
	{
		const TSharedPtr<FJsonObject>* View = nullptr;
		Grant = Answer->TryGetObjectField(TEXT("view"), View) && View ? *View : nullptr;
		SetOn(Grant.IsValid());
		bChanged = true;
	}
	return true;
}

FGenexAiResult UGenexAiSubsystem::ResultOf(const FPending& Entry, const TSharedPtr<FJsonObject>& Answer)
{
	bool bOk = false;
	if (Answer->TryGetBoolField(TEXT("ok"), bOk) && bOk)
	{
		SetOn(true);
		FGenexAiResult Result;
		Result.Ticket = Entry.Ticket;
		Result.Site = Entry.Site;
		Result.bOk = true;
		Result.ValueJson = CondensedValue(Answer->TryGetField(TEXT("value")));
		Answer->TryGetStringField(TEXT("source"), Result.Source);
		Answer->TryGetStringField(TEXT("provenance"), Result.Provenance);
		return Result;
	}
	FString Code = GenexAiWords::CodeProvider;
	Answer->TryGetStringField(TEXT("code"), Code);
	if (Code == GenexAiWords::CodeOff)
	{
		SetOn(false);
	}
	return Failure(Entry, Code);
}

FGenexAiResult UGenexAiSubsystem::Failure(const FPending& Entry, const FString& Code) const
{
	FGenexAiResult Result;
	Result.Ticket = Entry.Ticket;
	Result.Site = Entry.Site;
	Result.bOk = false;
	Result.ValueJson = Entry.FallbackJson;
	Result.Code = Code;
	Result.bUsedFallback = !Entry.FallbackJson.IsEmpty();
	return Result;
}

void UGenexAiSubsystem::Settle(const FPending& Entry, const FString& Code)
{
	if (Entry.Kind == EKind::Call)
	{
		Arrived.Add(Failure(Entry, Code));
	}
	else if (Code == GenexAiWords::CodeOff)
	{
		SetOn(false);
	}
}

void UGenexAiSubsystem::EndWaiting(const TCHAR* Code)
{
	for (const FString& Rid : WaitingOrder)
	{
		if (const FPending* Entry = Waiting.Find(Rid))
		{
			Settle(*Entry, Code);
		}
	}
	Waiting.Reset();
	WaitingOrder.Reset();
	Partials.Reset();
}

void UGenexAiSubsystem::SetOn(bool bValue)
{
	if (bOn != bValue)
	{
		bOn = bValue;
		bChanged = true;
	}
}

TArray<FGenexAiResult> UGenexAiSubsystem::TakeArrived()
{
	FScopeLock Lock(&Gate);
	if (Waiting.Num() > 0 && !RelayFresh())
	{
		EndWaiting(GenexAiWords::CodeOff);
	}
	TArray<FGenexAiResult> Out;
	for (int32 Index = 0; Index < Arrived.Num();)
	{
		if (Routed.Contains(Arrived[Index].Ticket))
		{
			++Index;
			continue;
		}
		Out.Add(Arrived[Index]);
		Arrived.RemoveAt(Index);
	}
	return Out;
}

// --- The relay (UGenexAiRelayLibrary) ---

FString UGenexAiSubsystem::PullForStudio()
{
	TSharedRef<FJsonObject> Out = MakeShared<FJsonObject>();
	UGenexAiSubsystem* Ai = Active.Get();
	if (!Ai)
	{
		LastPull = -1.0;
		Out->SetBoolField(TEXT("playing"), false);
		Out->SetArrayField(TEXT("lines"), TArray<TSharedPtr<FJsonValue>>());
		return Condensed(Out);
	}
	LastPull = FPlatformTime::Seconds();
	FScopeLock Lock(&Ai->Gate);
	TSharedRef<FJsonObject> Echo = MakeShared<FJsonObject>();
	Echo->SetArrayField(TEXT("asked"), Strings(Ai->Asked));
	Echo->SetArrayField(TEXT("answered"), Strings(Ai->Answered));
	Out->SetBoolField(TEXT("playing"), true);
	Out->SetArrayField(TEXT("lines"), Strings(Ai->Queued));
	Out->SetObjectField(TEXT("echo"), Echo);
	Ai->Queued.Reset();
	return Condensed(Out);
}

bool UGenexAiSubsystem::PushFromStudio(const FString& Base64)
{
	UGenexAiSubsystem* Ai = Active.Get();
	TArray<uint8> Bytes;
	if (!Ai || !FBase64::Decode(Base64, Bytes))
	{
		return false;
	}
	const FUTF8ToTCHAR Text(reinterpret_cast<const ANSICHAR*>(Bytes.GetData()), Bytes.Num());
	TArray<TSharedPtr<FJsonValue>> Items;
	const TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(FString(Text.Length(), Text.Get()));
	if (!FJsonSerializer::Deserialize(Reader, Items))
	{
		return false;
	}
	for (const TSharedPtr<FJsonValue>& Item : Items)
	{
		const TSharedPtr<FJsonObject>* Entry = nullptr;
		const TSharedPtr<FJsonObject>* Args = nullptr;
		FString Op;
		if (Item.IsValid() && Item->TryGetObject(Entry) && (*Entry)->TryGetStringField(TEXT("op"), Op) && (*Entry)->TryGetObjectField(TEXT("args"), Args))
		{
			Ai->TakeStudioOp(Op, *Args);
		}
	}
	if (Ai->bChanged)
	{
		Ai->bChanged = false;
		Ai->OnChanged.Broadcast();
	}
	return true;
}
