//! Native play identity (CLI_INTEGRATION.md §6b): the three doors that end in the same
//! `embed:play` token a browser holds, plus its ~10-minute refresh. HTTP goes through the Colyseus
//! core's own blocking client (mbedTLS, system roots), so no extra TLS stack is linked.
//!
//! Every call here BLOCKS the calling thread for one HTTP round trip. Call them at startup or
//! from a loading screen; [`EmbedIdentity::token`] only goes to the network when the token is due
//! for its refresh (about every 10 minutes), i.e. at most once per join.

use serde_json::{json, Value};
use std::ffi::{c_void, CStr, CString};
use std::fmt;

use super::{ffi, parse_endpoint};
use crate::stamp::local_now_ms;

/// The environment variable a launcher hands a single-use ticket in (§6b door 2).
pub const TICKET_ENV: &str = "GENEX_EMBED_TICKET";
/// Refresh a token this old (the browser SDK rolls every ~10 minutes; tokens live 15).
const REFRESH_AFTER_MS: f64 = 9.0 * 60_000.0;
/// A token this old is expired for sure.
const TOKEN_LIFETIME_MS: f64 = 15.0 * 60_000.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityError {
    /// HTTP status (0 = transport or local failure).
    pub status: i32,
    /// The API's `error` code when it sent one, else the body or a local message.
    pub message: String,
}

impl IdentityError {
    fn local(message: impl Into<String>) -> Self {
        IdentityError {
            status: 0,
            message: message.into(),
        }
    }
    /// The identity is over (`401 session_expired`): start again with a new door.
    pub fn is_expired(&self) -> bool {
        self.status == 401
    }
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "identity request failed ({}): {}", self.status, self.message)
    }
}

impl std::error::Error for IdentityError {}

/// A blocking JSON client for one API base URL (`https://api.genex.games`).
struct Api {
    settings: *mut ffi::colyseus_settings_t,
    http: *mut ffi::colyseus_http_t,
}

impl Api {
    fn new(base: &str) -> Result<Api, IdentityError> {
        let (address, port, secure) =
            parse_endpoint(base).ok_or_else(|| IdentityError::local(format!("bad API URL `{base}`")))?;
        let address = CString::new(address).map_err(|_| IdentityError::local("bad API URL"))?;
        let port = CString::new(port).map_err(|_| IdentityError::local("bad API URL"))?;
        // SAFETY: plain constructors; freed in Drop, settings after the http client.
        unsafe {
            let settings = ffi::colyseus_settings_create();
            ffi::colyseus_settings_set_address(settings, address.as_ptr());
            ffi::colyseus_settings_set_port(settings, port.as_ptr());
            ffi::colyseus_settings_set_secure(settings, secure);
            let http = ffi::colyseus_http_create(settings);
            Ok(Api { settings, http })
        }
    }

    /// POST `body` to `path`. No `Origin` is ever sent (§6b). `bearer` is the play token to refresh.
    fn post(&self, path: &str, body: &Value, bearer: Option<&str>) -> Result<Value, IdentityError> {
        type Outcome = Option<Result<(i32, String), (i32, String)>>;
        unsafe extern "C" fn ok(r: *const ffi::colyseus_http_response_t, ud: *mut c_void) {
            let out = &mut *(ud as *mut Outcome);
            let r = &*r;
            let body = if r.body.is_null() {
                String::new()
            } else {
                CStr::from_ptr(r.body).to_string_lossy().into_owned()
            };
            *out = Some(Ok((r.status_code, body)));
        }
        unsafe extern "C" fn err(e: *const ffi::colyseus_http_error_t, ud: *mut c_void) {
            let out = &mut *(ud as *mut Outcome);
            let e = &*e;
            let msg = if e.message.is_null() {
                String::new()
            } else {
                CStr::from_ptr(e.message).to_string_lossy().into_owned()
            };
            *out = Some(Err((e.code, msg)));
        }
        let path = CString::new(path).map_err(|_| IdentityError::local("bad path"))?;
        let body = CString::new(body.to_string()).map_err(|_| IdentityError::local("bad body"))?;
        let token = bearer
            .map(CString::new)
            .transpose()
            .map_err(|_| IdentityError::local("bad token"))?;
        let mut outcome: Outcome = None;
        // SAFETY: the request blocks and answers on this thread before returning, so `outcome`
        // outlives both callbacks. The auth token is cleared again right after.
        unsafe {
            ffi::colyseus_http_set_auth_token(self.http, token.as_ref().map_or(std::ptr::null(), |t| t.as_ptr()));
            ffi::colyseus_http_post(
                self.http,
                path.as_ptr(),
                body.as_ptr(),
                ok,
                err,
                &mut outcome as *mut _ as *mut c_void,
            );
            ffi::colyseus_http_set_auth_token(self.http, std::ptr::null());
        }
        match outcome {
            Some(Ok((_, text))) => serde_json::from_str(&text).map_err(|_| IdentityError::local("non-JSON response")),
            Some(Err((status, text))) => {
                let message = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("error")
                            .or_else(|| v.get("status"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or(text);
                Err(IdentityError { status, message })
            }
            None => Err(IdentityError::local("no response")),
        }
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        // SAFETY: created in Api::new, freed once.
        unsafe {
            ffi::colyseus_http_free(self.http);
            ffi::colyseus_settings_free(self.settings);
        }
    }
}

/// A device sign-in in progress (§6b door 3). Show `user_code` and `verification_uri` (or a QR
/// of `verification_uri_complete`), then poll every `interval` seconds.
#[derive(Debug, Clone)]
pub struct DeviceCode {
    device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: f64,
    pub interval: f64,
}

/// One poll of a device sign-in.
pub enum DevicePoll {
    Pending {
        interval: f64,
    },
    /// The player refused: stop and offer a guest.
    Denied,
    /// Expired or already collected: start again.
    Expired,
    Approved(EmbedIdentity),
}

/// A play identity for ONE game: the current `embed:play` token and its refresh.
pub struct EmbedIdentity {
    api: Api,
    token: String,
    minted_at: f64,
    relay_urls: Vec<String>,
    user: Value,
}

impl fmt::Debug for EmbedIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print the token.
        f.debug_struct("EmbedIdentity")
            .field("relay_urls", &self.relay_urls)
            .field("user", &self.user)
            .finish()
    }
}

impl EmbedIdentity {
    fn from_response(api: Api, v: Value) -> Result<EmbedIdentity, IdentityError> {
        let token = v
            .get("embedToken")
            .and_then(Value::as_str)
            .ok_or_else(|| IdentityError::local("no embedToken"))?;
        let relay_urls = v
            .pointer("/colyseus/urls")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        Ok(EmbedIdentity {
            api,
            token: token.to_string(),
            minted_at: local_now_ms(),
            relay_urls,
            user: v.get("user").cloned().unwrap_or(Value::Null),
        })
    }

    /// Door 1: a save-less production guest for a PUBLISHED game.
    pub fn guest(api_base: &str, slug: &str) -> Result<EmbedIdentity, IdentityError> {
        let api = Api::new(api_base)?;
        let v = api.post("/api/embed/guest-session", &json!({ "slug": slug }), None)?;
        Self::from_response(api, v)
    }

    /// Read the launcher's ticket from `GENEX_EMBED_TICKET` and remove it from this process's
    /// environment. Call it FIRST in `main` (the ticket lives 60 s), before any thread starts.
    pub fn take_ticket_from_env() -> Option<String> {
        let ticket = std::env::var(TICKET_ENV).ok().filter(|t| !t.is_empty());
        std::env::remove_var(TICKET_ENV);
        ticket
    }

    /// Door 2: redeem a launcher's single-use ticket. A 401 means fall back (guest or device).
    pub fn from_ticket(api_base: &str, ticket: &str) -> Result<EmbedIdentity, IdentityError> {
        let api = Api::new(api_base)?;
        let v = api.post("/api/embed/session", &json!({ "ticket": ticket }), None)?;
        Self::from_response(api, v)
    }

    /// Door 3, step 1: start a device sign-in for `slug`.
    pub fn device_start(api_base: &str, slug: &str) -> Result<DeviceCode, IdentityError> {
        let api = Api::new(api_base)?;
        let v = api.post("/api/embed/device", &json!({ "slug": slug }), None)?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let device_code = s("deviceCode");
        if device_code.is_empty() {
            return Err(IdentityError::local("no deviceCode"));
        }
        Ok(DeviceCode {
            device_code,
            user_code: s("userCode"),
            verification_uri: s("verificationUri"),
            verification_uri_complete: s("verificationUriComplete"),
            expires_in: v.get("expiresIn").and_then(Value::as_f64).unwrap_or(600.0),
            interval: v.get("interval").and_then(Value::as_f64).unwrap_or(3.0),
        })
    }

    /// Door 3, step 2: poll once. Call no faster than `interval` seconds.
    pub fn device_poll(api_base: &str, code: &DeviceCode) -> Result<DevicePoll, IdentityError> {
        let api = Api::new(api_base)?;
        match api.post(
            "/api/embed/device/token",
            &json!({ "deviceCode": code.device_code }),
            None,
        ) {
            Ok(v) => match v.get("status").and_then(Value::as_str) {
                Some("approved") => Ok(DevicePoll::Approved(Self::from_response(api, v)?)),
                Some("denied") => Ok(DevicePoll::Denied),
                Some("expired") => Ok(DevicePoll::Expired),
                _ => Ok(DevicePoll::Pending {
                    interval: v.get("interval").and_then(Value::as_f64).unwrap_or(code.interval),
                }),
            },
            Err(e) if e.status == 410 => Ok(DevicePoll::Expired),
            Err(e) => Err(e),
        }
    }

    /// The relay URLs the API returned (`colyseus.urls`): pass them as `ConnectOptions::endpoints`.
    pub fn relay_urls(&self) -> &[String] {
        &self.relay_urls
    }

    /// The `user` object the API returned (name, avatar…), if any.
    pub fn user(&self) -> &Value {
        &self.user
    }

    /// A token fit for a join right now, refreshing it first when it is due (§6b "Refresh").
    /// A 503 on refresh keeps the current token while it is still valid.
    pub fn token(&mut self) -> Result<String, IdentityError> {
        let age = local_now_ms() - self.minted_at;
        if age >= REFRESH_AFTER_MS {
            match self.refresh() {
                Ok(()) => {}
                Err(e) if e.status == 503 && age < TOKEN_LIFETIME_MS - 30_000.0 => {}
                Err(e) => return Err(e),
            }
        }
        Ok(self.token.clone())
    }

    /// Roll the token now (`POST /api/embed/session/refresh`). A 401 means the identity is over.
    pub fn refresh(&mut self) -> Result<(), IdentityError> {
        let v = self
            .api
            .post("/api/embed/session/refresh", &json!({}), Some(&self.token))?;
        let t = v
            .get("embedToken")
            .and_then(Value::as_str)
            .ok_or_else(|| IdentityError::local("no embedToken"))?;
        self.token = t.to_string();
        self.minted_at = local_now_ms();
        Ok(())
    }

    /// Turn the identity into the provider `Session::connect` takes.
    pub fn into_provider(mut self) -> impl FnMut() -> Result<String, String> {
        move || self.token().map_err(|e| e.to_string())
    }
}
