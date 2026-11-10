// GenexCore's HTTP seam (GenexCore/GenexHttp.h) over Unreal's FHttpModule, so the sign-in doors
// never block the game thread (the C core's own client blocks for the whole round trip).
//
// One departure from the IHttp contract: Unreal's HTTP module follows redirects and offers no
// switch (libcurl FOLLOWLOCATION on Windows/Linux, NSURLSession on Mac). An answer whose effective
// URL is on another origin than the request's is therefore turned into a transport error, so a
// redirected sign-in is never adopted. Genex's API answers these POSTs directly; it never redirects.
#pragma once

#include "CoreMinimal.h"
#include "GenexCore/GenexHttp.h"

class FGenexUnrealHttp final : public genex::IHttp
{
public:
	FGenexUnrealHttp();
	virtual ~FGenexUnrealHttp() override;
	virtual void Send(genex::HttpRequest Request, genex::HttpDone Done) override;

private:
	/** Cleared on destruction, so an answer after it calls nothing. */
	TSharedRef<bool> Alive;
};
