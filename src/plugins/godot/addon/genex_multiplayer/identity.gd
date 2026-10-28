extends Node
## Native play identity (CLI_INTEGRATION.md §6b): obtains the `embed:play` token a native
## build passes to the relay, keeps it refreshed, and hands GenexMultiplayer.join() a provider.
## Web exports do not need this: the page's @genex-ai/embed-sdk owns identity there.
##
##   var id = preload("res://addons/genex_multiplayer/identity.gd").new()
##   add_child(id)
##   id.api_url = "https://api.genex.games"
##   var ok := await id.from_launcher("my-game")      # GENEX_EMBED_TICKET, if Genex launched us
##   if not ok:
##       ok = await id.guest("my-game")               # or the device-code sign-in below
##   GenexMultiplayer.join({"urls": id.relay_urls, "game_id": "my-game", "identity": id.provider()})
##
## Device sign-in:  var code = await id.device_start("my-game")   # show code.userCode + code.verificationUri
##                  var ok = await id.device_wait()                # polls until approved/denied/expired
##
## The token is never logged or persisted by this script.

signal token_changed()
signal session_expired()

const TICKET_ENV := "GENEX_EMBED_TICKET"
## Genex's API as the launcher names it: its local gateway when Genex's Play started this game in
## its sandbox. It wins over `api_url`, whatever the game set.
const API_ENV := "GENEX_API_URL"
const REFRESH_AFTER_MS := 10 * 60 * 1000

var api_url := "https://api.genex.games"
var relay_urls: Array = []
var user := {}
var is_guest := false

var _token := ""
var _minted_at := 0
var _device := {}


func has_token() -> bool:
	return _token != ""


## A Callable for GenexMultiplayer.join({"identity": ...}): returns a fresh token, refreshing
## first when the current one is older than ~10 minutes.
func provider() -> Callable:
	return func():
		if _token != "" and Time.get_ticks_msec() - _minted_at > REFRESH_AFTER_MS:
			await refresh()
		return _token


## Door 2: redeem the launcher's single-use ticket. Reads GENEX_EMBED_TICKET once and removes
## it from this process's environment. False when not launched by Genex or the ticket is spent.
func from_launcher(_slug := "") -> bool:
	var ticket := OS.get_environment(TICKET_ENV)
	if ticket == "":
		return false
	OS.unset_environment(TICKET_ENV)
	var res := await _post("/api/embed/session", {"ticket": ticket})
	return _adopt(res)


## Door 1: a guest token for a published game.
func guest(slug: String) -> bool:
	var res := await _post("/api/embed/guest-session", {"slug": slug})
	var ok := _adopt(res)
	is_guest = ok
	return ok


## Door 3, step 1: start a device sign-in. Returns {deviceCode, userCode, verificationUri,
## verificationUriComplete, expiresIn, interval, project} or {} on failure. Show the user code
## and the URI (or a QR of verificationUriComplete); never show the deviceCode.
func device_start(slug: String) -> Dictionary:
	var res := await _post("/api/embed/device", {"slug": slug})
	if res.code != 200 or not (res.body is Dictionary):
		return {}
	_device = res.body
	var shown: Dictionary = _device.duplicate()
	shown.erase("deviceCode")
	return shown


## Door 3, step 2: poll until the player approves (true), denies or the code expires (false).
func device_wait() -> bool:
	if _device.is_empty():
		return false
	var interval := maxf(1.0, float(_device.get("interval", 3)))
	var deadline := Time.get_ticks_msec() + int(float(_device.get("expiresIn", 600)) * 1000.0)
	while Time.get_ticks_msec() < deadline:
		await get_tree().create_timer(interval).timeout
		var res := await _post("/api/embed/device/token", {"deviceCode": _device.deviceCode})
		var body = res.body if res.body is Dictionary else {}
		var status := str(body.get("status", ""))
		if res.code == 200 and status == "approved":
			_device = {}
			return _adopt(res)
		if status == "denied" or res.code == 410:
			_device = {}
			return false
		if body.has("interval"):
			interval = maxf(1.0, float(body.interval))
	_device = {}
	return false


## Roll the token (the browser SDK does this every ~10 minutes).
func refresh() -> bool:
	if _token == "":
		return false
	var res := await _post("/api/embed/session/refresh", {}, _token)
	if res.code == 401:
		_token = ""
		session_expired.emit()
		return false
	if res.code == 200 and res.body is Dictionary and res.body.get("embedToken") is String:
		_token = res.body.embedToken
		_minted_at = Time.get_ticks_msec()
		token_changed.emit()
		return true
	return false # transient (503): keep the current token, retry later


func _adopt(res: Dictionary) -> bool:
	if res.code != 200 or not (res.body is Dictionary) or not (res.body.get("embedToken") is String):
		return false
	var body: Dictionary = res.body
	_token = body.embedToken
	_minted_at = Time.get_ticks_msec()
	user = body.get("user", {}) if body.get("user") is Dictionary else {}
	var col = body.get("colyseus")
	if col is Dictionary:
		if col.get("urls") is Array and not col.urls.is_empty():
			relay_urls = col.urls
		elif col.get("url") is String:
			relay_urls = [col.url]
	token_changed.emit()
	return true


## The API this identity talks to: the launcher's (GENEX_API_URL) when it named one, else `api_url`.
func _api() -> String:
	var launcher := OS.get_environment(API_ENV)
	return launcher if launcher != "" else api_url


func _post(path: String, payload: Dictionary, bearer := "") -> Dictionary:
	var req := HTTPRequest.new()
	add_child(req)
	var headers := PackedStringArray(["Content-Type: application/json", "Accept: application/json"])
	if bearer != "":
		headers.append("Authorization: Bearer " + bearer)
	var err := req.request(_api().trim_suffix("/") + path, headers, HTTPClient.METHOD_POST, JSON.stringify(payload))
	if err != OK:
		req.queue_free()
		return {"code": 0, "body": null}
	var r: Array = await req.request_completed
	req.queue_free()
	var text: String = (r[3] as PackedByteArray).get_string_from_utf8()
	var json := JSON.new()
	return {"code": int(r[1]), "body": json.data if json.parse(text) == OK else null}
