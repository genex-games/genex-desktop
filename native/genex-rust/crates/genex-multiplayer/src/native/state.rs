//! Copy the decoded room state out of the C core's reflection-built dynamic schema (§4).
//!
//! No codegen and no per-field callbacks: on every state change the whole root is walked and
//! copied into plain Rust values, which the session then diffs against its previous copy. At
//! ≤64 players, ≤128 objects and ≤256 shared keys this is cheap, it never holds a C pointer past
//! the callback, and the diff gives the §8 step-3 prune after a reconnect for free.

use std::ffi::{c_char, c_void, CStr};

use super::ffi::{self, field};

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PlayerRaw {
    pub name: String,
    pub data: String,
    pub epoch: f64,
    pub connected: bool,
    pub avatar_url: String,
    pub uid: String,
    pub team: f64,
    pub pose: [f64; 7],
    pub anim: String,
    pub pose_t: f64,
    pub posed: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ObjectRaw {
    pub owner: String,
    pub seq: f64,
    pub epoch: f64,
    pub t: f64,
    pub d: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Snapshot {
    pub players: Vec<(String, PlayerRaw)>,
    pub shared: Vec<(String, String)>,
    pub objects: Vec<(String, ObjectRaw)>,
    pub host: String,
    pub match_text: String,
    pub clock_origin: f64,
}

/// A field of a dynamic schema instance, or `None` when absent.
unsafe fn get<'a>(obj: *mut c_void, name: &CStr) -> Option<&'a ffi::colyseus_dynamic_value_t> {
    if obj.is_null() {
        return None;
    }
    ffi::colyseus_dynamic_schema_get_by_name(obj, name.as_ptr()).as_ref()
}

unsafe fn c_string(p: *const c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}

unsafe fn str_field(obj: *mut c_void, name: &CStr) -> String {
    match get(obj, name) {
        Some(v) if v.ty == field::STRING => c_string(v.data.str_),
        _ => String::new(),
    }
}

unsafe fn num_field(obj: *mut c_void, name: &CStr, default: f64) -> f64 {
    let Some(v) = get(obj, name) else { return default };
    let n = match v.ty {
        field::NUMBER | field::FLOAT64 => v.data.num,
        field::FLOAT32 => v.data.f32_ as f64,
        field::INT8 => v.data.i8_ as f64,
        field::UINT8 => v.data.u8_ as f64,
        field::INT16 => v.data.i16_ as f64,
        field::UINT16 => v.data.u16_ as f64,
        field::INT32 => v.data.i32_ as f64,
        field::UINT32 => v.data.u32_ as f64,
        field::INT64 => v.data.i64_ as f64,
        field::UINT64 => v.data.u64_ as f64,
        _ => return default,
    };
    if n.is_finite() {
        n
    } else {
        default
    }
}

unsafe fn bool_field(obj: *mut c_void, name: &CStr, default: bool) -> bool {
    match get(obj, name) {
        Some(v) if v.ty == field::BOOLEAN => v.data.boolean,
        _ => default,
    }
}

unsafe fn map_field(obj: *mut c_void, name: &CStr) -> *mut c_void {
    match get(obj, name) {
        Some(v) if v.ty == field::MAP => v.data.ptr,
        _ => std::ptr::null_mut(),
    }
}

/// Visit every (key, value pointer) of a map. Values are typed by the child: a Schema child is a
/// dynamic schema instance, `map<string>` a `char*`, `map<boolean>` a `bool*`.
unsafe fn for_each(map: *mut c_void, mut f: impl FnMut(String, *mut c_void)) {
    if map.is_null() {
        return;
    }
    unsafe extern "C" fn trampoline(key: *const c_char, value: *mut c_void, ud: *mut c_void) {
        let f = &mut *(ud as *mut &mut dyn FnMut(String, *mut c_void));
        f(c_string(key), value);
    }
    let mut dyn_f: &mut dyn FnMut(String, *mut c_void) = &mut f;
    ffi::colyseus_map_schema_foreach(map, trampoline, &mut dyn_f as *mut _ as *mut c_void);
}

/// Copy the room's whole state. `None` before the first state arrives.
///
/// # Safety
/// `room` must be a live room, read on the polling thread outside any decode.
pub(crate) unsafe fn read_snapshot(room: *mut ffi::colyseus_room_t) -> Option<Snapshot> {
    if room.is_null() {
        return None;
    }
    let root = ffi::colyseus_room_get_state(room);
    if root.is_null() {
        return None;
    }
    let mut snap = Snapshot {
        host: str_field(root, c"host"),
        match_text: str_field(root, c"match"),
        clock_origin: num_field(root, c"clockOrigin", 0.0),
        ..Default::default()
    };
    for_each(map_field(root, c"players"), |id, p| {
        if p.is_null() {
            return;
        }
        snap.players.push((
            id,
            PlayerRaw {
                name: str_field(p, c"name"),
                data: str_field(p, c"data"),
                epoch: num_field(p, c"epoch", 0.0),
                connected: bool_field(p, c"connected", true),
                avatar_url: str_field(p, c"avatarUrl"),
                uid: str_field(p, c"uid"),
                team: num_field(p, c"team", -1.0),
                pose: [
                    num_field(p, c"x", 0.0),
                    num_field(p, c"y", 0.0),
                    num_field(p, c"z", 0.0),
                    num_field(p, c"yaw", 0.0),
                    num_field(p, c"vx", 0.0),
                    num_field(p, c"vy", 0.0),
                    num_field(p, c"vz", 0.0),
                ],
                anim: str_field(p, c"anim"),
                pose_t: num_field(p, c"poseT", 0.0),
                posed: bool_field(p, c"posed", false),
            },
        ));
    });
    for_each(map_field(root, c"shared"), |key, v| {
        snap.shared.push((key, c_string(v as *const c_char)));
    });
    for_each(map_field(root, c"objects"), |id, o| {
        if o.is_null() {
            return;
        }
        snap.objects.push((
            id,
            ObjectRaw {
                owner: str_field(o, c"owner"),
                seq: num_field(o, c"seq", 0.0),
                epoch: num_field(o, c"epoch", 0.0),
                t: num_field(o, c"t", 0.0),
                d: str_field(o, c"d"),
            },
        ));
    });
    Some(snap)
}
