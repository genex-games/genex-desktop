#include "GenexUnrealHttp.h"

#include "Containers/Ticker.h"
#include "HAL/CriticalSection.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"

namespace GenexUnrealHttpDetail
{
/** scheme://host[:port] of an absolute URL, lower-cased; empty when it is not one. */
FString Origin(const FString& Url)
{
	int32 Scheme = Url.Find(TEXT("://"));
	if (Scheme == INDEX_NONE) return FString();
	const int32 HostStart = Scheme + 3;
	int32 End = HostStart;
	while (End < Url.Len() && Url[End] != '/' && Url[End] != '?' && Url[End] != '#') ++End;
	return Url.Left(End).ToLower();
}

/** Seconds a sign-in request may take end to end. */
constexpr float TimeoutSeconds = 30.f;
/** Seconds an answer read in pieces may take end to end: a model writing, a line being spoken. */
constexpr float StreamTimeoutSeconds = 180.f;
/** Seconds such an answer may say nothing at all; the stand sends a comment line every fifteen. */
constexpr float StreamSilenceSeconds = 45.f;

/** The body of an answer read in pieces. The HTTP thread appends, the game thread takes. */
struct FStreamed
{
	FCriticalSection Lock;
	/** Arrived and not handed over yet. */
	std::string Fresh;
	/** Everything that arrived: `done` still carries the whole body. */
	std::string Whole;
	genex::HttpChunk Chunk;
	FTSTicker::FDelegateHandle Ticker;

	/** Game thread: hand over what arrived since the last call. */
	void HandOver()
	{
		std::string Bytes;
		{
			FScopeLock Scope(&Lock);
			Bytes.swap(Fresh);
		}
		if (!Bytes.empty() && Chunk) Chunk(Bytes);
	}
};
}

FGenexUnrealHttp::FGenexUnrealHttp() : Alive(MakeShared<bool>(true)) {}

FGenexUnrealHttp::~FGenexUnrealHttp()
{
	*Alive = false;
}

void FGenexUnrealHttp::Send(genex::HttpRequest Request, genex::HttpDone Done)
{
	Start(MoveTemp(Request), nullptr, MoveTemp(Done));
}

void FGenexUnrealHttp::SendStreamed(genex::HttpRequest Request, genex::HttpChunk Chunk, genex::HttpDone Done)
{
	Start(MoveTemp(Request), MoveTemp(Chunk), MoveTemp(Done));
}

void FGenexUnrealHttp::Start(genex::HttpRequest Request, genex::HttpChunk Chunk, genex::HttpDone Done)
{
	using namespace GenexUnrealHttpDetail;
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Http = FHttpModule::Get().CreateRequest();
	const FString Url = UTF8_TO_TCHAR(Request.url.c_str());
	Http->SetURL(Url);
	Http->SetVerb(UTF8_TO_TCHAR(Request.method.c_str()));
	for (const genex::HttpHeader& Header : Request.headers)
	{
		Http->SetHeader(UTF8_TO_TCHAR(Header.name.c_str()), UTF8_TO_TCHAR(Header.value.c_str()));
	}
	if (!Request.body.empty())
	{
		TArray<uint8> Body;
		Body.Append(reinterpret_cast<const uint8*>(Request.body.data()), static_cast<int32>(Request.body.size()));
		Http->SetContent(MoveTemp(Body));
	}
	TWeakPtr<bool> WeakAlive = Alive;
	// Read in pieces: the HTTP thread only appends; the game thread hands the pieces over once a frame, so the core
	// is still called from one thread.
	TSharedPtr<FStreamed, ESPMode::ThreadSafe> Streamed;
	if (Chunk)
	{
		Streamed = MakeShared<FStreamed, ESPMode::ThreadSafe>();
		Streamed->Chunk = MoveTemp(Chunk);
		Http->SetTimeout(StreamTimeoutSeconds);
		Http->SetActivityTimeout(StreamSilenceSeconds);
		Http->SetResponseBodyReceiveStreamDelegateV2(FHttpRequestStreamDelegateV2::CreateLambda([Streamed](void* Bytes, int64& Length) {
			if (Bytes == nullptr || Length <= 0) return;
			FScopeLock Scope(&Streamed->Lock);
			Streamed->Fresh.append(static_cast<const char*>(Bytes), static_cast<size_t>(Length));
			Streamed->Whole.append(static_cast<const char*>(Bytes), static_cast<size_t>(Length));
		}));
		Streamed->Ticker = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakAlive, Streamed](float) {
			TSharedPtr<bool> StillAlive = WeakAlive.Pin();
			if (!StillAlive.IsValid() || !*StillAlive) return false;
			Streamed->HandOver();
			return true;
		}));
	}
	else
	{
		Http->SetTimeout(TimeoutSeconds);
	}
	const FString Wanted = Origin(Url);
	// Exactly once: the completion delegate or the failed start below, whichever comes first.
	TSharedRef<genex::HttpDone> Once = MakeShared<genex::HttpDone>(MoveTemp(Done));
	Http->OnProcessRequestComplete().BindLambda(
		[WeakAlive, Wanted, Once, Streamed](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected) {
			if (Streamed.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(Streamed->Ticker);
			TSharedPtr<bool> StillAlive = WeakAlive.Pin();
			if (!StillAlive.IsValid() || !*StillAlive || !*Once) return;
			genex::HttpDone Callback = MoveTemp(*Once);
			*Once = nullptr;
			genex::HttpResponse Out;
			const bool bRedirected = Response.IsValid() && !Wanted.IsEmpty() && !Response->GetEffectiveURL().IsEmpty() && Origin(Response->GetEffectiveURL()) != Wanted;
			if (Streamed.IsValid() && !bRedirected)
			{
				// Every piece before `done`, whatever became of the connection: what arrived, arrived.
				Streamed->HandOver();
			}
			if (!Response.IsValid() || (!bConnected && !Streamed.IsValid()))
			{
				Out.transportError = "no answer";
			}
			else if (bRedirected)
			{
				Out.transportError = "redirected to another origin";
			}
			else if (Streamed.IsValid())
			{
				// A stream cut off after it began is a broken connection, with what arrived in the pieces.
				Out.status = Response->GetResponseCode();
				if (!bConnected || Out.status == 0) { Out.status = 0; Out.transportError = "the stream broke"; }
				FScopeLock Scope(&Streamed->Lock);
				Out.body = Streamed->Whole;
			}
			else
			{
				Out.status = Response->GetResponseCode();
				const TArray<uint8>& Bytes = Response->GetContent();
				Out.body.assign(reinterpret_cast<const char*>(Bytes.GetData()), Bytes.Num());
			}
			Callback(MoveTemp(Out));
		});
	if (!Http->ProcessRequest() && *Once)
	{
		if (Streamed.IsValid()) FTSTicker::GetCoreTicker().RemoveTicker(Streamed->Ticker);
		genex::HttpDone Callback = MoveTemp(*Once);
		*Once = nullptr;
		genex::HttpResponse Out;
		Out.transportError = "could not start the request";
		Callback(MoveTemp(Out));
	}
}
