// GenexCore's HTTP seam: the one asynchronous request interface the native identity doors
// (GenexIdentity) talk through, so the UE layer can supply one over FHttpModule, the offline tables
// a fake, and the tools the default below over the Colyseus C core's own client.
//
// Port target: the `Api::post` of sdks/rust/genex-multiplayer/src/native/identity.rs (which calls
// colyseus_http_post directly) and Godot identity.gd's `_post` (an HTTPRequest node), reshaped into
// an interface because UE games must not block the game thread.
//
// The contract every IHttp keeps:
// - `done` is called EXACTLY ONCE per Send, on the thread that pumps GenexCore. It SHOULD be called
//   later (after Send returned), as ColyseusHttp and FHttpModule do; callers still tolerate a call
//   from inside Send.
// - `status` is the HTTP status of the answer (any value, 1xx..5xx), `body` its bytes. No answer at
//   all (DNS, refused, TLS, timeout, cancelled) is `status = 0` with a non-empty `transportError`.
// - Redirects are NOT followed (the C core does not follow them; an FHttpModule implementation must
//   not either), so a 3xx reaches the caller as is.
// - Nothing is logged: request headers carry bearer tokens.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexPump.h"

#include <cstddef>
#include <functional>
#include <string>
#include <vector>

namespace genex {

struct HttpHeader {
  std::string name;
  std::string value;
};

struct HttpRequest {
  /** "GET", "POST", "PUT", "DELETE" or "PATCH". */
  std::string method = "GET";
  /** Absolute: `http(s)://host[:port][/path][?query]`. */
  std::string url;
  std::vector<HttpHeader> headers;
  std::string body;
};

struct HttpResponse {
  /** The HTTP status; 0 when no answer arrived (then `transportError` says why). */
  int status = 0;
  std::string body;
  /** Non-empty exactly when no HTTP answer arrived. */
  std::string transportError;

  /** A 2xx answer. */
  bool IsSuccess() const { return transportError.empty() && status >= 200 && status < 300; }
};

using HttpDone = std::function<void(HttpResponse)>;

class GENEX_CORE_API IHttp {
 public:
  virtual ~IHttp();
  /** Start `request`; `done` is called once with its outcome (see the contract above). */
  virtual void Send(HttpRequest request, HttpDone done) = 0;
};

/**
 * IHttp over the Colyseus C core's client (colyseus_http_*: Zig std.http + its bundled CA roots).
 *
 * MEASURED (v0.18.10, macOS arm64, against a local Node server): colyseus_http_post BLOCKS the
 * calling thread for the whole round trip (a 400 ms answer returned after 405 ms) and calls back on
 * that thread BEFORE it returns, in polled mode too: colyseus_poll() plays no part in it. A 3xx is
 * not followed (it arrives as a success callback with that status), the body is read whole with no
 * size bound (5 MB accepted), a NUL byte in the body ends it, a transport failure is code 0 with the
 * Zig error name (`ConnectionRefused`), and an IPv6 literal host fails (`UnknownHostName`). The
 * core sends `Content-Type` (with a body) and `Accept: application/json` itself, and no `Origin`.
 *
 * So this class keeps IHttp's "later" promise by QUEUING: Send only records the request (and
 * registers with genex::Pump); the next Pump::Frame runs every request queued before it, one
 * blocking call each, and calls back. That is fine for tools and loading screens; a UE game should
 * install an FHttpModule IHttp instead, which never blocks the game thread.
 *
 * Single-threaded like the rest of GenexCore. Requests still queued when it is destroyed are
 * dropped without a callback.
 */
class GENEX_CORE_API ColyseusHttp final : public IHttp, public IPumped {
 public:
  ColyseusHttp();
  ~ColyseusHttp() override;
  ColyseusHttp(const ColyseusHttp&) = delete;
  ColyseusHttp& operator=(const ColyseusHttp&) = delete;

  void Send(HttpRequest request, HttpDone done) override;
  /** Runs (blocking) every request queued before this frame, then calls each back. */
  void Update(double nowMs) override;
  /** Requests waiting for the next frame. */
  std::size_t Pending() const { return queue_.size(); }

  /** One blocking request through the C core, answered before it returns (what Update runs). */
  static HttpResponse Perform(const HttpRequest& request);

 private:
  struct Job {
    HttpRequest request;
    HttpDone done;
  };
  std::vector<Job> queue_;
  bool registered_ = false;
};

/** The process-wide ColyseusHttp every GenexCore object uses when it is given no IHttp. */
GENEX_CORE_API IHttp& DefaultHttp();

}  // namespace genex
