// The default IHttp over the Colyseus C core's colyseus_http_* (see GenexCore/GenexHttp.h for the
// measured behaviour). Port of the request half of sdks/rust/genex-multiplayer/src/native/identity.rs
// `Api` (settings + http client per base URL, both callbacks, "no response" when neither fires).
#include "GenexCore/GenexHttp.h"

#include "GenexCore/GenexColyseus.h"
#include "GenexCore/GenexUrl.h"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace genex::http_detail {

struct Outcome {
  bool fired = false;
  HttpResponse response;
};

void OnSuccess(const colyseus_http_response_t* r, void* userdata) {
  Outcome* out = static_cast<Outcome*>(userdata);
  out->fired = true;
  out->response.status = r->status_code;
  if (r->body != nullptr) out->response.body = r->body;
}

void OnError(const colyseus_http_error_t* e, void* userdata) {
  Outcome* out = static_cast<Outcome*>(userdata);
  out->fired = true;
  const std::string message = e->message != nullptr ? std::string(e->message) : std::string();
  if (e->code >= 100) {
    // An HTTP answer >= 400: the message is its body.
    out->response.status = e->code;
    out->response.body = message;
  } else {
    // A transport failure (code 0; the Zig error name, e.g. ConnectionRefused).
    out->response.status = 0;
    out->response.transportError = message.empty() ? std::string("transport error") : message;
  }
}

bool SameName(const std::string& a, const char* b) {
  std::size_t i = 0;
  for (; i < a.size() && b[i] != '\0'; ++i) {
    char x = a[i];
    char y = b[i];
    if (x >= 'A' && x <= 'Z') x = static_cast<char>(x - 'A' + 'a');
    if (y >= 'A' && y <= 'Z') y = static_cast<char>(y - 'A' + 'a');
    if (x != y) return false;
  }
  return i == a.size() && b[i] == '\0';
}

bool HasNul(const std::string& text) { return text.find('\0') != std::string::npos; }

HttpResponse Failure(const char* why) {
  HttpResponse r;
  r.transportError = why;
  return r;
}

}  // namespace genex::http_detail

namespace genex {

IHttp::~IHttp() = default;

ColyseusHttp::ColyseusHttp() = default;

ColyseusHttp::~ColyseusHttp() {
  if (registered_) Pump::Unregister(this);
}

void ColyseusHttp::Send(HttpRequest request, HttpDone done) {
  queue_.push_back(Job{std::move(request), std::move(done)});
  if (!registered_) {
    registered_ = true;
    Pump::Register(this);
  }
}

void ColyseusHttp::Update(double /*nowMs*/) {
  // Requests sent from inside a callback below wait for the next frame.
  std::vector<Job> jobs;
  jobs.swap(queue_);
  if (queue_.empty() && registered_) {
    registered_ = false;
    Pump::Unregister(this);
  }
  for (Job& job : jobs) {
    HttpResponse response = Perform(job.request);
    if (job.done) job.done(std::move(response));
  }
}

HttpResponse ColyseusHttp::Perform(const HttpRequest& request) {
  std::string error;
  const std::optional<ParsedUrl> url = ParseUrl(request.url, &error);
  if (!url || (url->scheme != "http" && url->scheme != "https")) return http_detail::Failure("bad request URL");
  if (http_detail::HasNul(request.body) || http_detail::HasNul(url->path)) {
    return http_detail::Failure("request holds a NUL byte");
  }
  for (const HttpHeader& header : request.headers) {
    if (http_detail::HasNul(header.name) || http_detail::HasNul(header.value) ||
        header.name.find_first_of("\r\n:") != std::string::npos ||
        header.value.find_first_of("\r\n") != std::string::npos) {
      return http_detail::Failure("bad request header");
    }
  }
  const std::string& method = request.method;
  const bool hasBody = method == "POST" || method == "PUT" || method == "PATCH";
  if (!hasBody && method != "GET" && method != "DELETE") return http_detail::Failure("unsupported method");

  colyseus_settings_t* settings = colyseus_settings_create();
  if (settings == nullptr) return http_detail::Failure("out of memory");
  colyseus_settings_set_address(settings, url->host.c_str());
  colyseus_settings_set_port(settings, std::to_string(url->port).c_str());
  colyseus_settings_set_secure(settings, url->secure);
  for (const HttpHeader& header : request.headers) {
    // The core writes Content-Type (with a body) and Accept itself.
    if (http_detail::SameName(header.name, "Content-Type") || http_detail::SameName(header.name, "Accept")) continue;
    colyseus_settings_add_header(settings, header.name.c_str(), header.value.c_str());
  }
  colyseus_http_t* http = colyseus_http_create(settings);
  if (http == nullptr) {
    colyseus_settings_free(settings);
    return http_detail::Failure("out of memory");
  }
  const std::string path = url->path.empty() ? std::string("/") : url->path;
  http_detail::Outcome outcome;
  // Native: each call blocks and calls back before it returns (measured; GenexHttp.h).
  if (method == "GET") {
    colyseus_http_get(http, path.c_str(), &http_detail::OnSuccess, &http_detail::OnError, &outcome);
  } else if (method == "DELETE") {
    colyseus_http_delete(http, path.c_str(), &http_detail::OnSuccess, &http_detail::OnError, &outcome);
  } else if (method == "POST") {
    colyseus_http_post(http, path.c_str(), request.body.c_str(), &http_detail::OnSuccess, &http_detail::OnError,
                       &outcome);
  } else if (method == "PUT") {
    colyseus_http_put(http, path.c_str(), request.body.c_str(), &http_detail::OnSuccess, &http_detail::OnError,
                      &outcome);
  } else {
    colyseus_http_patch(http, path.c_str(), request.body.c_str(), &http_detail::OnSuccess, &http_detail::OnError,
                        &outcome);
  }
  colyseus_http_free(http);
  colyseus_settings_free(settings);
  // The core drops the callback when it cannot even allocate the error message.
  if (!outcome.fired) return http_detail::Failure("no response");
  return std::move(outcome.response);
}

IHttp& DefaultHttp() {
  // The pump's state is constructed first, so it outlives this object at exit (its destructor
  // unregisters from the pump).
  static const std::uint64_t pumpFirst = Pump::Count();
  static ColyseusHttp http;
  static_cast<void>(pumpFirst);
  return http;
}

}  // namespace genex
