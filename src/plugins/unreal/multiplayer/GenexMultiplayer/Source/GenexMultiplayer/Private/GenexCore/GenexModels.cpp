#include "GenexCore/GenexModels.h"

#include <cmath>
#include <limits>
#include <optional>
#include <utility>

namespace genex::models {

namespace {

/** The calls whose JavaScript promise never rejects: they settle as a result with a `status`. */
constexpr std::string_view kModelsSettlingCalls[] = {"generate", "generateStream", "judge", "requestSpendGrant", "waitForGeneration"};

bool ModelsSettles(std::string_view method) {
  for (const std::string_view call : kModelsSettlingCalls) {
    if (call == method) return true;
  }
  return false;
}

/** A request id as a bridge writes it: a positive whole number an int holds. */
std::optional<int> ModelsRequestId(const Json* value) {
  if (value == nullptr || !value->IsNumber()) return std::nullopt;
  const double n = value->AsNumber();
  if (!std::isfinite(n) || n < 1.0 || n > static_cast<double>(std::numeric_limits<int>::max()) || std::floor(n) != n) return std::nullopt;
  return static_cast<int>(n);
}

/** A text field, or nothing when it is absent or of another type. */
const std::string* ModelsText(const Json& entry, std::string_view key) {
  const Json* value = entry.Find(key);
  return value != nullptr && value->IsString() ? &value->AsString() : nullptr;
}

/** The bridge of a Models given none: each call settles kNativeUnsupported at the next drain, and nothing is sent
 *  anywhere. */
class NativeModelsBridge final : public Bridge {
 public:
  bool Supported() const override { return false; }
  int Call(std::string_view method, std::string_view) override {
    next_ += 1;
    Json event = Json::MakeObject();
    event.Set("id", next_);
    event.Set("call", method);
    if (ModelsSettles(method)) {
      Json result = Json::MakeObject();
      result.Set("status", "failed");
      result.Set("error", kNativeUnsupported);
      event.Set("type", "result");
      event.Set("result", std::move(result));
    } else {
      event.Set("type", "rejected");
      event.Set("error", kNativeUnsupported);
    }
    queue_.Push(std::move(event));
    return next_;
  }
  bool Cancel(int) override { return false; }
  int Pending() override { return static_cast<int>(queue_.Size()); }
  std::string DrainEventsJson() override {
    std::string text = queue_.Dump();
    queue_ = Json::MakeArray();
    return text;
  }
  std::string GenerationErrorMessage(const std::string* code) const override { return NativeErrorMessage(code); }

 private:
  int next_ = 0;
  Json queue_ = Json::MakeArray();
};

}  // namespace

Bridge::~Bridge() = default;

std::vector<Event> ReadEvents(std::string_view drainJson) {
  std::vector<Event> events;
  const std::optional<Json> parsed = Json::Parse(drainJson);
  if (!parsed || !parsed->IsArray()) return events;
  for (const Json& entry : parsed->Items()) {
    if (!entry.IsObject()) continue;
    const std::string* type = ModelsText(entry, "type");
    const std::optional<int> id = ModelsRequestId(entry.Find("id"));
    if (type == nullptr || !id) continue;
    const Json* callField = entry.Find("call");
    if (callField != nullptr && !callField->IsString()) continue;
    Event event;
    event.id = *id;
    if (callField != nullptr) event.call = callField->AsString();
    if (*type == "result") {
      event.type = Event::Type::Result;
      if (const Json* result = entry.Find("result")) event.result = *result;
    } else if (*type == "rejected") {
      const std::string* error = ModelsText(entry, "error");
      if (error == nullptr) continue;
      event.type = Event::Type::Rejected;
      event.error = *error;
    } else if (*type == "delta") {
      const std::string* text = ModelsText(entry, "text");
      const std::string* soFar = ModelsText(entry, "soFar");
      if (text == nullptr || soFar == nullptr) continue;
      event.type = Event::Type::Delta;
      event.text = *text;
      event.soFar = *soFar;
    } else if (*type == "partialField") {
      const std::string* name = ModelsText(entry, "name");
      const std::string* text = ModelsText(entry, "text");
      if (name == nullptr || text == nullptr) continue;
      event.type = Event::Type::PartialField;
      event.name = *name;
      event.text = *text;
    } else if (*type == "speechStart") {
      const std::string* encoding = ModelsText(entry, "encoding");
      const Json* rate = entry.Find("sampleRate");
      const Json* channels = entry.Find("channels");
      const bool whole = rate != nullptr && rate->IsNumber() && channels != nullptr && channels->IsNumber();
      if (encoding == nullptr || !whole || rate->AsNumber() < 1.0 || rate->AsNumber() > 384000.0 || channels->AsNumber() < 1.0 || channels->AsNumber() > 8.0) continue;
      event.type = Event::Type::SpeechStart;
      event.name = *encoding;
      event.sampleRate = static_cast<int>(rate->AsNumber());
      event.channels = static_cast<int>(channels->AsNumber());
    } else if (*type == "speechAudio") {
      const std::string* data = ModelsText(entry, "data");
      if (data == nullptr) continue;
      event.type = Event::Type::SpeechAudio;
      event.text = *data;
    } else if (*type == "gesture") {
      const Json* waiting = entry.Find("waiting");
      if (waiting == nullptr || !waiting->IsBool()) continue;
      event.type = Event::Type::Gesture;
      event.waiting = waiting->AsBool();
    } else {
      continue;
    }
    events.push_back(std::move(event));
  }
  return events;
}

Models::Models() : bridge_(std::make_unique<NativeModelsBridge>()) {}

Models::Models(std::unique_ptr<Bridge> bridge) : bridge_(std::move(bridge)) {
  if (!bridge_) bridge_ = std::make_unique<NativeModelsBridge>();
}

Models::~Models() = default;

bool Models::Supported() const { return bridge_->Supported(); }

int Models::Start(std::string_view method, Json args) { return bridge_->Call(method, args.Dump()); }

int Models::Init(std::string_view gameId) {
  Json options = Json::MakeObject();
  options.Set("gameId", gameId);
  Json args = Json::MakeArray();
  args.Push(std::move(options));
  return Start("init", std::move(args));
}

int Models::GetGenerationModels() { return Start("getGenerationModels", Json::MakeArray()); }

int Models::Generate(const Json& options) {
  Json args = Json::MakeArray();
  args.Push(options);
  return Start("generate", std::move(args));
}

int Models::GenerateStream(const Json& options) {
  Json args = Json::MakeArray();
  args.Push(options);
  return Start("generateStream", std::move(args));
}

int Models::Speak(const Json& options) {
  Json args = Json::MakeArray();
  args.Push(options);
  return Start("speak", std::move(args));
}

int Models::Transcribe(const Json& options) {
  Json args = Json::MakeArray();
  args.Push(options);
  return Start("transcribe", std::move(args));
}

int Models::Judge(const Json& options) {
  Json args = Json::MakeArray();
  args.Push(options);
  return Start("judge", std::move(args));
}

int Models::RequestSpendGrant(const Json& options) {
  Json args = Json::MakeArray();
  args.Push(options);
  return Start("requestSpendGrant", std::move(args));
}

int Models::GetSpendGrant(std::string_view grantId) {
  Json args = Json::MakeArray();
  args.Push(grantId);
  return Start("getSpendGrant", std::move(args));
}

int Models::GetActiveSpendGrant() { return Start("getActiveSpendGrant", Json::MakeArray()); }

int Models::StopSpendGrant(std::string_view grantId) {
  Json args = Json::MakeArray();
  args.Push(grantId);
  return Start("stopSpendGrant", std::move(args));
}

int Models::WaitForGeneration(std::string_view generationId, double timeoutMs) {
  Json args = Json::MakeArray();
  args.Push(generationId);
  if (std::isfinite(timeoutMs) && timeoutMs > 0.0) args.Push(timeoutMs);
  return Start("waitForGeneration", std::move(args));
}

int Models::GetGeneration(std::string_view generationId) {
  Json args = Json::MakeArray();
  args.Push(generationId);
  return Start("getGeneration", std::move(args));
}

bool Models::Cancel(int request) { return request > 0 && bridge_->Cancel(request); }

std::string Models::GenerationErrorMessage(const std::string* code) const {
  std::string sentence = bridge_->GenerationErrorMessage(code);
  return sentence.empty() ? NativeErrorMessage(code) : sentence;
}

std::vector<Event> Models::Poll() {
  if (bridge_->Pending() <= 0) return {};
  return ReadEvents(bridge_->DrainEventsJson());
}

}  // namespace genex::models
