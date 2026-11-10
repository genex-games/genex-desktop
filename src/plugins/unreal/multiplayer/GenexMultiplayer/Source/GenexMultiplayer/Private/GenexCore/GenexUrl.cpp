// Port of the URL and join-option rules named in GenexCore/GenexUrl.h (Unity GenexAuthoritySession.cs
// IsLoopbackUrl/PickUrl/BuildJoinOptions, Godot genex_authority.gd + native_backend.gd +
// authority_native.gd + util.gd sanitize, Rust native/mod.rs parse_endpoint + join_options).
#include "GenexCore/GenexUrl.h"

#include "GenexCore/GenexProtocol.h"

#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <string>
#include <string_view>
#include <utility>

namespace genex::url_detail {

bool StartsWith(std::string_view text, std::string_view prefix) {
  return text.size() >= prefix.size() && text.substr(0, prefix.size()) == prefix;
}

bool IsHexOrV6(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == ':' || c == '.';
}

bool IsHostChar(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '.' ||
         c == '_' || c == '~' || c == '%';
}

bool Fail(std::string* error, const char* why) {
  if (error != nullptr) *error = why;
  return false;
}

/** Copy of `value` (at nesting level `depth`, the root being 1) for the wire, as Godot util.gd
 *  sanitize: non-finite → 0, and a container on the last allowed level → null, so the result never
 *  holds more than kMaxJsonDepth levels and always encodes. */
Json Sanitize(const Json& value, std::size_t depth) {
  if (depth >= protocol::limits::kMaxJsonDepth && (value.IsArray() || value.IsObject())) return Json();
  switch (value.GetType()) {
    case Json::Type::Number: {
      const double n = value.AsNumber();
      return std::isfinite(n) ? Json(n) : Json(0.0);
    }
    case Json::Type::Array: {
      Json out = Json::MakeArray();
      for (const Json& item : value.Items()) out.Push(Sanitize(item, depth + 1));
      return out;
    }
    case Json::Type::Object: {
      Json out = Json::MakeObject();
      for (const JsonMember& member : value.Members()) out.Set(member.key, Sanitize(member.value, depth + 1));
      return out;
    }
    case Json::Type::Null:
    case Json::Type::Bool:
    case Json::Type::String:
      return value;
  }
  return Json();
}

const char* const kOwnKeys[] = {protocol::join_option::kGameId, protocol::join_option::kEmbedToken,
                                protocol::join_option::kName, protocol::join_option::kProtocol};

std::vector<std::string> NonEmpty(const std::vector<std::string>& urls) {
  std::vector<std::string> out;
  for (const std::string& u : urls) {
    if (!u.empty()) out.push_back(u);
  }
  return out;
}

}  // namespace genex::url_detail

namespace genex {

std::string ParsedUrl::Origin() const {
  std::string out = scheme + "://" + host;
  if (explicitPort) out += ":" + std::to_string(port);
  return out;
}

std::optional<ParsedUrl> ParseUrl(std::string_view url, std::string* error) {
  using url_detail::Fail;
  for (const char c : url) {
    const unsigned char b = static_cast<unsigned char>(c);
    if (b <= 0x20 || b == 0x7f) {
      Fail(error, "space or control character in URL");
      return std::nullopt;
    }
    if (c == '#' || c == '\\') {
      Fail(error, "fragment or backslash in URL");
      return std::nullopt;
    }
  }
  ParsedUrl out;
  std::string_view rest;
  if (url_detail::StartsWith(url, "wss://")) {
    out.scheme = "wss";
    out.secure = true;
  } else if (url_detail::StartsWith(url, "ws://")) {
    out.scheme = "ws";
  } else if (url_detail::StartsWith(url, "https://")) {
    out.scheme = "https";
    out.secure = true;
  } else if (url_detail::StartsWith(url, "http://")) {
    out.scheme = "http";
  } else {
    Fail(error, "not a ws, wss, http or https URL");
    return std::nullopt;
  }
  rest = url.substr(out.scheme.size() + 3);
  const std::size_t end = rest.find_first_of("/?");
  const std::string_view authority = rest.substr(0, end);
  if (end != std::string_view::npos) out.path = std::string(rest.substr(end));
  if (authority.empty()) {
    Fail(error, "no host");
    return std::nullopt;
  }
  if (authority.find('@') != std::string_view::npos) {
    Fail(error, "userinfo in URL");
    return std::nullopt;
  }
  std::string_view host;
  std::string_view port;
  bool hasPort = false;
  if (authority.front() == '[') {
    const std::size_t close = authority.find(']');
    if (close == std::string_view::npos || close < 2) {
      Fail(error, "bad IPv6 literal");
      return std::nullopt;
    }
    for (const char c : authority.substr(1, close - 1)) {
      if (!url_detail::IsHexOrV6(c)) {
        Fail(error, "bad IPv6 literal");
        return std::nullopt;
      }
    }
    host = authority.substr(0, close + 1);
    const std::string_view after = authority.substr(close + 1);
    if (!after.empty()) {
      if (after.front() != ':') {
        Fail(error, "text after an IPv6 literal");
        return std::nullopt;
      }
      port = after.substr(1);
      hasPort = true;
    }
  } else {
    const std::size_t colon = authority.find(':');
    host = authority.substr(0, colon);
    if (colon != std::string_view::npos) {
      port = authority.substr(colon + 1);
      hasPort = true;
    }
    if (host.empty()) {
      Fail(error, "no host");
      return std::nullopt;
    }
    for (const char c : host) {
      if (!url_detail::IsHostChar(c)) {
        Fail(error, "bad host character");
        return std::nullopt;
      }
    }
  }
  if (hasPort) {
    if (port.empty() || port.size() > 5) {
      Fail(error, "bad port");
      return std::nullopt;
    }
    int value = 0;
    for (const char c : port) {
      if (c < '0' || c > '9') {
        Fail(error, "bad port");
        return std::nullopt;
      }
      value = value * 10 + (c - '0');
    }
    if (value < 1 || value > 65535) {
      Fail(error, "port out of range");
      return std::nullopt;
    }
    out.port = value;
    out.explicitPort = true;
  } else {
    out.port = out.secure ? 443 : 80;
  }
  out.host = std::string(host);
  return out;
}

bool IsLoopbackUrl(std::string_view url) {
  if (url.empty()) return false;
  std::string_view rest;
  if (url_detail::StartsWith(url, "ws://")) {
    rest = url.substr(5);
  } else if (url_detail::StartsWith(url, "wss://")) {
    rest = url.substr(6);
  } else {
    return false;
  }
  std::string_view host = rest.substr(0, rest.find('/'));
  if (host.find('@') != std::string_view::npos) return false;
  if (url_detail::StartsWith(host, "[::1]")) return host == "[::1]" || url_detail::StartsWith(host, "[::1]:");
  host = host.substr(0, host.find(':'));
  return host == "127.0.0.1" || host == "localhost";
}

std::optional<std::string> GetEnv(const char* name) {
  if (name == nullptr) return std::nullopt;
#if defined(_WIN32)
  char* value = nullptr;
  std::size_t size = 0;
  if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) return std::nullopt;
  std::string out(value);
  std::free(value);
  return out;
#else
  const char* value = std::getenv(name);
  if (value == nullptr) return std::nullopt;
  return std::string(value);
#endif
}

bool SetEnv(const char* name, const char* value) {
  if (name == nullptr || value == nullptr) return false;
#if defined(_WIN32)
  // _putenv_s with "" REMOVES the variable on Windows; an empty value cannot be stored there.
  return _putenv_s(name, value) == 0;
#else
  return setenv(name, value, 1) == 0;
#endif
}

bool UnsetEnv(const char* name) {
  if (name == nullptr) return false;
#if defined(_WIN32)
  return _putenv_s(name, "") == 0;
#else
  return unsetenv(name) == 0;
#endif
}

UrlPick PickRelayUrl(std::string_view url, const std::vector<std::string>& urls) {
  UrlPick pick;
  if (!url.empty()) {
    pick.kind = UrlPickKind::Direct;
    pick.url = std::string(url);
    return pick;
  }
  std::vector<std::string> usable = url_detail::NonEmpty(urls);
  if (usable.size() == 1) {
    pick.kind = UrlPickKind::Direct;
    pick.url = usable.front();
  } else if (usable.size() > 1) {
    pick.kind = UrlPickKind::Race;
    pick.urls = std::move(usable);
  } else {
    pick.error = "no server URL (pass url or urls)";
  }
  return pick;
}

UrlPick PickAuthorityUrl(std::string_view url, const std::vector<std::string>& urls,
                         const std::optional<std::string>& env) {
  UrlPick pick = PickRelayUrl(url, urls);
  if (pick.kind != UrlPickKind::Refused) return pick;
  if (env && !env->empty()) {
    pick.kind = UrlPickKind::Direct;
    pick.url = *env;
    pick.error.clear();
    return pick;
  }
  pick.error = "no authority URL (pass url or urls, or set GENEX_AUTHORITY_URL)";
  return pick;
}

UrlPick PickAuthorityUrlFromEnv(std::string_view url, const std::vector<std::string>& urls) {
  return PickAuthorityUrl(url, urls, GetEnv(kAuthorityUrlEnv));
}

bool IsServerOwnedJoinOption(RoomProtocol room, std::string_view key) {
  if (room == RoomProtocol::Authority) {
    for (const char* owned : protocol::kAuthorityServerOwnedJoinOptions) {
      if (key == owned) return true;
    }
    return false;
  }
  for (const char* owned : protocol::kServerOwnedJoinOptions) {
    if (key == owned) return true;
  }
  return false;
}

std::string CapDisplayName(std::string_view name) {
  if (!IsValidUtf8(name)) return std::string();
  std::size_t units = 0;
  std::size_t i = 0;
  while (i < name.size()) {
    const unsigned char lead = static_cast<unsigned char>(name[i]);
    const std::size_t bytes = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
    const std::size_t cost = bytes == 4 ? 2 : 1;
    if (units + cost > protocol::limits::kMaxNameChars) break;
    units += cost;
    i += bytes;
  }
  return std::string(name.substr(0, i));
}

Json SanitizeJoinValue(const Json& value) { return url_detail::Sanitize(value, 1); }

std::optional<Json> BuildJoinOptions(RoomProtocol room, const JoinSpec& spec, std::string_view token,
                                     std::string* error) {
  if (spec.gameId.empty() || !IsValidUtf8(spec.gameId)) {
    url_detail::Fail(error, "gameId is required (the game's slug)");
    return std::nullopt;
  }
  Json o = Json::MakeObject();
  if (spec.extra.IsObject()) {
    for (const JsonMember& member : spec.extra.Members()) {
      if (IsServerOwnedJoinOption(room, member.key)) continue;
      bool own = false;
      for (const char* key : url_detail::kOwnKeys) own = own || member.key == key;
      if (own || (spec.caps && member.key == protocol::join_option::kCaps)) continue;
      // The options object itself is depth 1, so a member value starts at depth 2.
      o.Set(member.key, url_detail::Sanitize(member.value, 2));
    }
  }
  o.Set(protocol::join_option::kGameId, spec.gameId);
  if (!token.empty()) o.Set(protocol::join_option::kEmbedToken, std::string(token));
  const std::string name = CapDisplayName(spec.name);
  if (!name.empty()) o.Set(protocol::join_option::kName, name);
  if (spec.caps) {
    Json caps = Json::MakeArray();
    for (const std::string& cap : *spec.caps) caps.Push(cap);
    o.Set(protocol::join_option::kCaps, std::move(caps));
  }
  // Last, so nothing can misreport it (§2).
  o.Set(protocol::join_option::kProtocol, room == RoomProtocol::Authority ? protocol::kAuthorityProtocolVersion
                                                                              : protocol::kProtocolVersion);
  return o;
}

}  // namespace genex
