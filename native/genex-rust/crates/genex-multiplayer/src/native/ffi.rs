//! Hand-written C ABI of colyseus/native-sdk v0.18.10 (`include/colyseus/*.h`). Only what this
//! crate calls; every struct but the two value types and the two read-only heads is opaque.
#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_int, c_void};

#[repr(C)]
pub struct colyseus_settings_t {
    _p: [u8; 0],
}
#[repr(C)]
pub struct colyseus_client_t {
    _p: [u8; 0],
}
#[repr(C)]
pub struct colyseus_room_t {
    _p: [u8; 0],
}
#[repr(C)]
pub struct colyseus_room_clock_t {
    _p: [u8; 0],
}
#[repr(C)]
pub struct colyseus_input_handle_t {
    _p: [u8; 0],
}

/// `colyseus_reconnection_options_t` (room.h).
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct colyseus_reconnection_options_t {
    pub enabled: bool,
    pub max_retries: c_int,
    pub min_delay_ms: c_int,
    pub max_delay_ms: c_int,
    pub min_uptime_ms: c_int,
    pub delay_ms: c_int,
    pub max_enqueued_messages: c_int,
}

/// The leading fields of `struct colyseus_room` (room.h, public in v0.18.10), read-only, used only
/// by `room_probe` to watch the core's reconnect. `bool`s are read as bytes, and `room_probe`
/// checks this layout against the accessor functions before it trusts any field.
#[repr(C)]
pub struct colyseus_room_head_t {
    pub name: *const c_char,
    pub room_id: *const c_char,
    pub session_id: *const c_char,
    pub reconnection_token: *const c_char,
    pub serializer_id: *const c_char,
    pub has_joined: u8,
    pub transport: *const colyseus_transport_head_t,
    pub transport_factory: *const c_void,
    pub endpoint_url: *const c_char,
    pub settings: *const c_void,
    pub joined_at_ms: u64,
    // colyseus_reconnection_state_t starts right here (8-aligned, like the u64 above), with its
    // colyseus_reconnection_options_t flattened so that `enabled` is read as a byte too.
    pub reconnection_enabled: u8,
    pub reconnection_max_retries: c_int,
    pub reconnection_min_delay_ms: c_int,
    pub reconnection_max_delay_ms: c_int,
    pub reconnection_min_uptime_ms: c_int,
    pub reconnection_delay_ms: c_int,
    pub reconnection_max_enqueued_messages: c_int,
    pub retry_count: c_int,
    pub is_reconnecting: u8,
    pub cancelled: u8,
}

/// The leading vtable of `struct colyseus_transport` (transport.h, public); only `is_open` is called.
#[repr(C)]
pub struct colyseus_transport_head_t {
    pub connect: *const c_void,
    pub send: *const c_void,
    pub send_unreliable: *const c_void,
    pub close: *const c_void,
    pub is_open: Option<unsafe extern "C" fn(transport: *const colyseus_transport_head_t) -> bool>,
}

/// `colyseus_latency_options_t` (latency.h).
#[repr(C)]
pub struct colyseus_latency_options_t {
    pub ping_count: c_int,
    pub timeout_ms: c_int,
    pub use_secure: bool,
    pub tls_skip_verification: bool,
    pub ca_pem_data: *const u8,
    pub ca_pem_len: usize,
}

/// `colyseus_field_type_t` (schema/types.h), a C enum starting at 0.
pub mod field {
    pub const STRING: i32 = 0;
    pub const NUMBER: i32 = 1;
    pub const BOOLEAN: i32 = 2;
    pub const INT8: i32 = 3;
    pub const UINT8: i32 = 4;
    pub const INT16: i32 = 5;
    pub const UINT16: i32 = 6;
    pub const INT32: i32 = 7;
    pub const UINT32: i32 = 8;
    pub const INT64: i32 = 9;
    pub const UINT64: i32 = 10;
    pub const FLOAT32: i32 = 11;
    pub const FLOAT64: i32 = 12;
    pub const REF: i32 = 13;
    pub const ARRAY: i32 = 14;
    pub const MAP: i32 = 15;
}

/// `struct colyseus_dynamic_value` (schema/dynamic_schema.h): a tagged union, 16 bytes on 64-bit.
#[repr(C)]
pub struct colyseus_dynamic_value_t {
    pub ty: c_int,
    pub data: DynData,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union DynData {
    pub str_: *mut c_char,
    pub num: f64,
    pub f32_: f32,
    pub boolean: bool,
    pub i8_: i8,
    pub u8_: u8,
    pub i16_: i16,
    pub u16_: u16,
    pub i32_: i32,
    pub u32_: u32,
    pub i64_: i64,
    pub u64_: u64,
    pub ptr: *mut c_void,
}

#[repr(C)]
pub struct colyseus_http_t {
    _p: [u8; 0],
}

/// `colyseus_http_response_t` (http.h).
#[repr(C)]
pub struct colyseus_http_response_t {
    pub status_code: c_int,
    pub body: *mut c_char,
    pub success: bool,
}

/// `colyseus_http_error_t` (http.h): `message` is the response body for an HTTP status ≥ 400.
#[repr(C)]
pub struct colyseus_http_error_t {
    pub code: c_int,
    pub message: *mut c_char,
}

pub type HttpOkCb = unsafe extern "C" fn(response: *const colyseus_http_response_t, ud: *mut c_void);
pub type HttpErrCb = unsafe extern "C" fn(error: *const colyseus_http_error_t, ud: *mut c_void);
pub type RoomCb = unsafe extern "C" fn(room: *mut colyseus_room_t, ud: *mut c_void);
pub type ErrorCb = unsafe extern "C" fn(code: c_int, message: *const c_char, ud: *mut c_void);
pub type VoidCb = unsafe extern "C" fn(ud: *mut c_void);
pub type CodeCb = unsafe extern "C" fn(code: c_int, reason: *const c_char, ud: *mut c_void);
pub type MessageCb = unsafe extern "C" fn(kind: *const c_char, data: *const u8, len: usize, ud: *mut c_void);
pub type MapForeachCb = unsafe extern "C" fn(key: *const c_char, value: *mut c_void, ud: *mut c_void);
pub type SelectByLatencyCb = unsafe extern "C" fn(best: *const c_char, latency_ms: f64, ud: *mut c_void);

extern "C" {
    // client.h
    pub fn colyseus_set_polled(polled: bool);
    pub fn colyseus_poll();
    pub fn colyseus_client_create(settings: *mut colyseus_settings_t) -> *mut colyseus_client_t;
    pub fn colyseus_client_free(client: *mut colyseus_client_t);
    pub fn colyseus_client_join_or_create(
        client: *mut colyseus_client_t,
        room_name: *const c_char,
        options_json: *const c_char,
        on_success: RoomCb,
        on_error: ErrorCb,
        ud: *mut c_void,
    );
    pub fn colyseus_client_create_room(
        client: *mut colyseus_client_t,
        room_name: *const c_char,
        options_json: *const c_char,
        on_success: RoomCb,
        on_error: ErrorCb,
        ud: *mut c_void,
    );
    pub fn colyseus_client_join_by_id(
        client: *mut colyseus_client_t,
        room_id: *const c_char,
        options_json: *const c_char,
        on_success: RoomCb,
        on_error: ErrorCb,
        ud: *mut c_void,
    );
    pub fn colyseus_client_reconnect(
        client: *mut colyseus_client_t,
        reconnection_token: *const c_char,
        on_success: RoomCb,
        on_error: ErrorCb,
        ud: *mut c_void,
    );
    pub fn colyseus_client_consume_seat_reservation_json(
        client: *mut colyseus_client_t,
        reservation_json: *const c_char,
        on_success: RoomCb,
        on_error: ErrorCb,
        ud: *mut c_void,
    );

    // settings.h
    pub fn colyseus_settings_create() -> *mut colyseus_settings_t;
    pub fn colyseus_settings_free(settings: *mut colyseus_settings_t);
    pub fn colyseus_settings_set_address(settings: *mut colyseus_settings_t, address: *const c_char);
    pub fn colyseus_settings_set_port(settings: *mut colyseus_settings_t, port: *const c_char);
    pub fn colyseus_settings_set_secure(settings: *mut colyseus_settings_t, secure: bool);

    // http.h — blocking; callbacks fire on the calling thread before the call returns
    pub fn colyseus_http_create(settings: *const colyseus_settings_t) -> *mut colyseus_http_t;
    pub fn colyseus_http_free(http: *mut colyseus_http_t);
    pub fn colyseus_http_set_auth_token(http: *mut colyseus_http_t, token: *const c_char);
    pub fn colyseus_http_post(
        http: *mut colyseus_http_t,
        path: *const c_char,
        json_body: *const c_char,
        on_success: HttpOkCb,
        on_error: HttpErrCb,
        ud: *mut c_void,
    );

    // latency.h
    pub fn colyseus_select_by_latency(
        endpoints: *const *const c_char,
        count: usize,
        options: *const colyseus_latency_options_t,
        cb: SelectByLatencyCb,
        ud: *mut c_void,
    );

    // room.h
    pub fn colyseus_room_free(room: *mut colyseus_room_t);
    pub fn colyseus_room_leave(room: *mut colyseus_room_t, consented: bool);
    pub fn colyseus_room_get_state(room: *mut colyseus_room_t) -> *mut c_void;
    pub fn colyseus_room_get_id(room: *const colyseus_room_t) -> *const c_char;
    pub fn colyseus_room_get_session_id(room: *const colyseus_room_t) -> *const c_char;
    pub fn colyseus_room_is_connected(room: *const colyseus_room_t) -> bool;
    pub fn colyseus_room_get_reconnection_token(room: *const colyseus_room_t) -> *const c_char;
    pub fn colyseus_room_is_reconnecting(room: *const colyseus_room_t) -> bool;
    pub fn colyseus_room_get_reconnection_options(
        room: *const colyseus_room_t,
        out_options: *mut colyseus_reconnection_options_t,
    );
    pub fn colyseus_room_get_clock(room: *mut colyseus_room_t) -> *mut colyseus_room_clock_t;
    pub fn colyseus_room_input(
        room: *mut colyseus_room_t,
        input_vtable: *const c_void,
        options: *const c_void,
    ) -> *mut colyseus_input_handle_t;
    pub fn colyseus_room_on_join(room: *mut colyseus_room_t, cb: VoidCb, ud: *mut c_void);
    pub fn colyseus_room_on_state_change(room: *mut colyseus_room_t, cb: VoidCb, ud: *mut c_void);
    pub fn colyseus_room_on_error(room: *mut colyseus_room_t, cb: CodeCb, ud: *mut c_void);
    pub fn colyseus_room_on_leave(room: *mut colyseus_room_t, cb: CodeCb, ud: *mut c_void);
    pub fn colyseus_room_on_drop(room: *mut colyseus_room_t, cb: CodeCb, ud: *mut c_void);
    pub fn colyseus_room_on_reconnect(room: *mut colyseus_room_t, cb: VoidCb, ud: *mut c_void);
    pub fn colyseus_room_set_reconnection_options(
        room: *mut colyseus_room_t,
        options: *const colyseus_reconnection_options_t,
    );
    pub fn colyseus_room_on_message_any_with_type_encoded(room: *mut colyseus_room_t, cb: MessageCb, ud: *mut c_void);
    pub fn colyseus_room_send_encoded(room: *mut colyseus_room_t, kind: *const c_char, data: *const u8, len: usize);

    // room_clock.h
    pub fn colyseus_room_clock_server_now(clock: *const colyseus_room_clock_t) -> f64;
    pub fn colyseus_room_clock_rtt(clock: *const colyseus_room_clock_t) -> f64;
    pub fn colyseus_room_clock_smoothed_rtt(clock: *const colyseus_room_clock_t) -> f64;

    // input_handle.h
    pub fn colyseus_input_handle_send(handle: *mut colyseus_input_handle_t) -> c_int;
    pub fn colyseus_input_handle_last_processed(handle: *const colyseus_input_handle_t) -> c_int;

    // schema/dynamic_schema.h, schema/collections.h
    pub fn colyseus_dynamic_schema_get_by_name(
        schema: *mut c_void,
        name: *const c_char,
    ) -> *mut colyseus_dynamic_value_t;
    pub fn colyseus_map_schema_foreach(map: *mut c_void, cb: MapForeachCb, ud: *mut c_void);
}
