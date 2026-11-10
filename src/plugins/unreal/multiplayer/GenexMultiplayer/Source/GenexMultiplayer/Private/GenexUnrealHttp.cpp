#include "GenexUnrealHttp.h"

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
}

FGenexUnrealHttp::FGenexUnrealHttp() : Alive(MakeShared<bool>(true)) {}

FGenexUnrealHttp::~FGenexUnrealHttp()
{
	*Alive = false;
}

void FGenexUnrealHttp::Send(genex::HttpRequest Request, genex::HttpDone Done)
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
	Http->SetTimeout(TimeoutSeconds);
	TWeakPtr<bool> WeakAlive = Alive;
	const FString Wanted = Origin(Url);
	// Exactly once: the completion delegate or the failed start below, whichever comes first.
	TSharedRef<genex::HttpDone> Once = MakeShared<genex::HttpDone>(MoveTemp(Done));
	Http->OnProcessRequestComplete().BindLambda(
		[WeakAlive, Wanted, Once](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected) {
			TSharedPtr<bool> StillAlive = WeakAlive.Pin();
			if (!StillAlive.IsValid() || !*StillAlive || !*Once) return;
			genex::HttpDone Callback = MoveTemp(*Once);
			*Once = nullptr;
			genex::HttpResponse Out;
			if (!bConnected || !Response.IsValid())
			{
				Out.transportError = "no answer";
			}
			else if (!Wanted.IsEmpty() && Origin(Response->GetEffectiveURL()) != Wanted && !Response->GetEffectiveURL().IsEmpty())
			{
				Out.transportError = "redirected to another origin";
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
		genex::HttpDone Callback = MoveTemp(*Once);
		*Once = nullptr;
		genex::HttpResponse Out;
		Out.transportError = "could not start the request";
		Callback(MoveTemp(Out));
	}
}
