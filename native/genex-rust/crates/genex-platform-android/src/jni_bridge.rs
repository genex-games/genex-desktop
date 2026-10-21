//! The JNI bridge: what the activity's Java side knows and the native side needs, read through
//! framework classes. For the NativeActivity candidate (no Java code of its own) that includes the
//! display cutout GameActivity hands over natively (`Activity.getWindow().getDecorView()
//! .getRootWindowInsets().getDisplayCutout()`, API 28+); for both candidates, the audio focus
//! (`AudioManager.requestAudioFocus`), the thermal status (`PowerManager
//! .getCurrentThermalStatus`), the display's refresh rate (`Display.getRefreshRate`) and an input
//! device's USB vendor and product ids (`InputDevice.getVendorId`/`getProductId`, which name a
//! gamepad's family) and the memory facts the streamed content pool reads (game systems STR-7:
//! `ActivityManager.getMemoryClass`, the last trim level and the low-memory flag). A missing object
//! or a Java exception answers `None`, never a panic.

#[cfg(feature = "native-activity")]
use crate::SafeArea;
use jni::objects::{JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

/// `Context.AUDIO_SERVICE`.
const AUDIO_SERVICE: &str = "audio";
/// `AudioManager.STREAM_MUSIC`: games play on the media stream.
const STREAM_MUSIC: i32 = 3;
/// `AudioManager.AUDIOFOCUS_GAIN`: focus for an unknown duration.
const AUDIOFOCUS_GAIN: i32 = 1;
/// `AudioManager.AUDIOFOCUS_REQUEST_GRANTED`.
const AUDIOFOCUS_REQUEST_GRANTED: i32 = 1;
/// `Context.POWER_SERVICE`.
const POWER_SERVICE: &str = "power";
/// `Context.ACTIVITY_SERVICE`.
const ACTIVITY_SERVICE: &str = "activity";
/// `android.app.ActivityManager`, whose static `getMyMemoryState` fills a process record.
const ACTIVITY_MANAGER_CLASS: &str = "android/app/ActivityManager";
/// `ActivityManager.RunningAppProcessInfo`, which carries `lastTrimLevel`.
const PROCESS_INFO_CLASS: &str = "android/app/ActivityManager$RunningAppProcessInfo";
/// `ActivityManager.MemoryInfo`, which carries `lowMemory`.
const MEMORY_INFO_CLASS: &str = "android/app/ActivityManager$MemoryInfo";
/// `android.view.InputDevice`, whose static `getDevice(int)` answers a device by id.
const INPUT_DEVICE_CLASS: &str = "android/view/InputDevice";
/// `requestAudioFocus(OnAudioFocusChangeListener, int, int)` (deprecated in API 26, still served:
/// the listener-less form needs no Java class of the app's own). A focus loss while resumed needs
/// a listener, which is a Java class: the APK has none of its own (NativeActivity), so the shell
/// learns of a call or another app's playback through the activity pausing (`suspended`).
/// TODO(M5-F1): an `OnAudioFocusChangeListener` class in the packaged APK (a `classes.dex`, so the
/// manifest's `hasCode` rule flips), queued like iOS's interruptions.
const REQUEST_FOCUS_SIG: &str = "(Landroid/media/AudioManager$OnAudioFocusChangeListener;II)I";
const ABANDON_FOCUS_SIG: &str = "(Landroid/media/AudioManager$OnAudioFocusChangeListener;)I";

/// Run `read` with the JNI environment of this thread and the activity object.
fn with_activity<T>(read: impl FnOnce(&mut JNIEnv<'_>, &JObject<'_>) -> Option<T>) -> Option<T> {
    let context = ndk_context::android_context();
    // SAFETY: ndk-context holds the process's JavaVM and the activity's global reference for the
    // whole life of `android_main`; both pointers are valid and outlive this call.
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.ok()?;
    // SAFETY: the activity object is a global reference owned by android-activity; wrapping it
    // does not take ownership (a JObject never deletes its reference).
    let activity = unsafe { JObject::from_raw(context.context().cast()) };
    let mut guard = vm.attach_current_thread().ok()?;
    let env: &mut JNIEnv<'_> = &mut guard;
    read(env, &activity)
}

/// Call a method; a null receiver or a thrown exception answers `None`.
fn call<'local>(
    env: &mut JNIEnv<'local>,
    obj: &JObject<'_>,
    name: &str,
    sig: &str,
    args: &[JValue<'_, '_>],
) -> Option<jni::objects::JValueOwned<'local>> {
    if obj.is_null() {
        return None;
    }
    let value = env.call_method(obj, name, sig, args);
    if value.is_err() {
        let _ = env.exception_clear();
    }
    value.ok()
}

/// A method answering an object, or `None` for null.
fn object<'local>(env: &mut JNIEnv<'local>, obj: &JObject<'_>, name: &str, sig: &str, args: &[JValue<'_, '_>]) -> Option<JObject<'local>> {
    call(env, obj, name, sig, args)?.l().ok().filter(|answer| !answer.is_null())
}

/// A no-argument method answering a non-negative `int`.
#[cfg(feature = "native-activity")]
fn inset(env: &mut JNIEnv<'_>, cutout: &JObject<'_>, name: &str) -> Option<u32> {
    u32::try_from(call(env, cutout, name, "()I", &[])?.i().ok()?).ok()
}

/// The display cutout's safe insets, in physical pixels, or `None` when there is no cutout (or
/// it cannot be read). GameActivity insets its content view itself.
#[cfg(feature = "native-activity")]
pub fn cutout_insets() -> Option<SafeArea> {
    with_activity(|env, activity| {
        let window = object(env, activity, "getWindow", "()Landroid/view/Window;", &[])?;
        let decor = object(env, &window, "getDecorView", "()Landroid/view/View;", &[])?;
        let insets = object(env, &decor, "getRootWindowInsets", "()Landroid/view/WindowInsets;", &[])?;
        let cutout = object(env, &insets, "getDisplayCutout", "()Landroid/view/DisplayCutout;", &[])?;
        Some(SafeArea {
            top: inset(env, &cutout, "getSafeInsetTop")?,
            left: inset(env, &cutout, "getSafeInsetLeft")?,
            bottom: inset(env, &cutout, "getSafeInsetBottom")?,
            right: inset(env, &cutout, "getSafeInsetRight")?,
        })
    })
}

/// The activity's `AudioManager`.
fn audio_manager<'local>(env: &mut JNIEnv<'local>, activity: &JObject<'_>) -> Option<JObject<'local>> {
    let name = env.new_string(AUDIO_SERVICE).ok()?;
    object(env, activity, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[JValue::Object(&name)])
}

/// Ask for the media stream's audio focus; answers whether it was granted (`None`: not asked).
pub fn request_audio_focus() -> Option<bool> {
    with_activity(|env, activity| {
        let manager = audio_manager(env, activity)?;
        let none = JObject::null();
        let args = [JValue::Object(&none), JValue::Int(STREAM_MUSIC), JValue::Int(AUDIOFOCUS_GAIN)];
        let answer = call(env, &manager, "requestAudioFocus", REQUEST_FOCUS_SIG, &args)?.i().ok()?;
        Some(answer == AUDIOFOCUS_REQUEST_GRANTED)
    })
}

/// Give the audio focus back (`None`: not asked).
pub fn abandon_audio_focus() -> Option<()> {
    with_activity(|env, activity| {
        let manager = audio_manager(env, activity)?;
        let none = JObject::null();
        call(env, &manager, "abandonAudioFocus", ABANDON_FOCUS_SIG, &[JValue::Object(&none)])?;
        Some(())
    })
}

/// The device's thermal status (`PowerManager.THERMAL_STATUS_*`; API 29), or `None`.
pub fn thermal_status() -> Option<i32> {
    with_activity(|env, activity| {
        let name = env.new_string(POWER_SERVICE).ok()?;
        let manager = object(env, activity, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[JValue::Object(&name)])?;
        call(env, &manager, "getCurrentThermalStatus", "()I", &[])?.i().ok()
    })
}

/// The display's refresh rate in Hz (`getWindowManager().getDefaultDisplay().getRefreshRate()`,
/// API 1; the rate the panel runs now, after the shell's frame-rate vote), or `None`.
pub fn display_refresh_hz() -> Option<f32> {
    with_activity(|env, activity| {
        let manager = object(env, activity, "getWindowManager", "()Landroid/view/WindowManager;", &[])?;
        let display = object(env, &manager, "getDefaultDisplay", "()Landroid/view/Display;", &[])?;
        call(env, &display, "getRefreshRate", "()F", &[])?.f().ok()
    })
}

/// The USB vendor and product ids of the input device with `device_id` (the id a key or motion
/// event names; `InputDevice.getDevice(int)`, `getVendorId()`, `getProductId()`, API 19), or `None`
/// for a device that is gone, a virtual one (ids 0) or ids outside a USB id's range.
/// TODO(IN-6): the per-device joystick reader, which sees raw device ids before winit, sends
/// `PadChange::Family(pad_family(vendor, product))` when a controller first takes a slot.
pub fn input_device_ids(device_id: i32) -> Option<(u16, u16)> {
    with_activity(|env, _| {
        let found = env.call_static_method(INPUT_DEVICE_CLASS, "getDevice", "(I)Landroid/view/InputDevice;", &[JValue::Int(device_id)]);
        if found.is_err() {
            let _ = env.exception_clear();
        }
        let device = found.ok()?.l().ok().filter(|device| !device.is_null())?;
        let vendor = u16::try_from(call(env, &device, "getVendorId", "()I", &[])?.i().ok()?).ok()?;
        let product = u16::try_from(call(env, &device, "getProductId", "()I", &[])?.i().ok()?).ok()?;
        (vendor != 0 || product != 0).then_some((vendor, product))
    })
}

/// What Android's `ActivityManager` says about memory (game systems STR-7), each part `None` when
/// it cannot be read. NativeActivity has no Java class to receive `onTrimMemory`, so the trim
/// level is polled instead: `getMyMemoryState` reports the last level the system sent this
/// process (`lastTrimLevel`, API 16). The shell reads it with its thermal poll and on winit's
/// memory warning (`onLowMemory`), and merges it into `genex_gpu_memory::MemoryFacts`
/// (`with_android`), where `RUNNING_LOW` or worse cuts the phone's content pool.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoryState {
    /// The per-app memory class in MiB (`getMemoryClass`, API 5).
    pub memory_class_mib: Option<u32>,
    /// The last `ComponentCallbacks2.TRIM_MEMORY_*` level sent to this process (0: none yet).
    pub last_trim_level: Option<i32>,
    /// Whether the system considers itself low on memory (`MemoryInfo.lowMemory`, API 1).
    pub low_memory: Option<bool>,
}

/// The activity manager's memory facts, or `None` without an activity manager.
pub fn memory_state() -> Option<MemoryState> {
    with_activity(|env, activity| {
        let name = env.new_string(ACTIVITY_SERVICE).ok()?;
        let manager = object(env, activity, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[JValue::Object(&name)])?;
        let memory_class = call(env, &manager, "getMemoryClass", "()I", &[]).and_then(|answer| answer.i().ok());
        Some(MemoryState {
            memory_class_mib: memory_class.and_then(|mib| u32::try_from(mib).ok()).filter(|mib| *mib > 0),
            last_trim_level: last_trim_level(env),
            low_memory: low_memory(env, &manager),
        })
    })
}

/// A new object of `class` from its no-argument constructor; a thrown exception answers `None`.
fn new_object<'local>(env: &mut JNIEnv<'local>, class: &str) -> Option<JObject<'local>> {
    let made = env.new_object(class, "()V", &[]);
    if made.is_err() {
        let _ = env.exception_clear();
    }
    made.ok().filter(|made| !made.is_null())
}

/// An `int` field of `obj`; a missing field answers `None`.
fn int_field(env: &mut JNIEnv<'_>, obj: &JObject<'_>, name: &str) -> Option<i32> {
    let value = env.get_field(obj, name, "I");
    if value.is_err() {
        let _ = env.exception_clear();
    }
    value.ok()?.i().ok()
}

/// The last trim level the system sent this process (`getMyMemoryState(info).lastTrimLevel`).
fn last_trim_level(env: &mut JNIEnv<'_>) -> Option<i32> {
    let info = new_object(env, PROCESS_INFO_CLASS)?;
    let sig = "(Landroid/app/ActivityManager$RunningAppProcessInfo;)V";
    let filled = env.call_static_method(ACTIVITY_MANAGER_CLASS, "getMyMemoryState", sig, &[JValue::Object(&info)]);
    if filled.is_err() {
        let _ = env.exception_clear();
        return None;
    }
    int_field(env, &info, "lastTrimLevel")
}

/// Whether the system is low on memory (`getMemoryInfo(info).lowMemory`).
fn low_memory(env: &mut JNIEnv<'_>, manager: &JObject<'_>) -> Option<bool> {
    let info = new_object(env, MEMORY_INFO_CLASS)?;
    call(env, manager, "getMemoryInfo", "(Landroid/app/ActivityManager$MemoryInfo;)V", &[JValue::Object(&info)])?;
    let value = env.get_field(&info, "lowMemory", "Z");
    if value.is_err() {
        let _ = env.exception_clear();
    }
    value.ok()?.z().ok()
}

/// The process's last exit as `ActivityManager.getHistoricalProcessExitReasons` reports it (API 30+;
/// game systems CRASH-4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastExit {
    /// `ApplicationExitInfo.getReason` (a `REASON_*`).
    pub reason: i32,
    /// The system's description ("" when it has none).
    pub description: String,
    /// When the process exited (`getTimestamp`, milliseconds since the epoch).
    pub timestamp_ms: i64,
    /// The trace (`getTraceInputStream`, API 31+: a native crash's tombstone), at most the cap
    /// asked for; `None` without one or past the cap.
    pub trace: Option<Vec<u8>>,
}

/// Bytes read from a trace stream at a time.
const TRACE_CHUNK_BYTES: i32 = 16 * 1024;

/// This process's last exit, with its trace when one of at most `trace_max` bytes is kept; `None`
/// before API 30, with no exit recorded, or on any Java exception.
pub fn last_exit(trace_max: usize) -> Option<LastExit> {
    with_activity(|env, activity| {
        let name = env.new_string(ACTIVITY_SERVICE).ok()?;
        let manager = object(env, activity, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[JValue::Object(&name)])?;
        let package = JObject::null();
        let sig = "(Ljava/lang/String;II)Ljava/util/List;";
        let exits = object(env, &manager, "getHistoricalProcessExitReasons", sig, &[JValue::Object(&package), JValue::Int(0), JValue::Int(1)])?;
        let exit = object(env, &exits, "get", "(I)Ljava/lang/Object;", &[JValue::Int(0)])?;
        let reason = call(env, &exit, "getReason", "()I", &[])?.i().ok()?;
        let timestamp_ms = call(env, &exit, "getTimestamp", "()J", &[])?.j().ok()?;
        let description = object(env, &exit, "getDescription", "()Ljava/lang/String;", &[])
            .and_then(|text| env.get_string(&JString::from(text)).ok().map(String::from))
            .unwrap_or_default();
        let trace = object(env, &exit, "getTraceInputStream", "()Ljava/io/InputStream;", &[]).and_then(|stream| read_stream(env, &stream, trace_max));
        Some(LastExit { reason, description, timestamp_ms, trace })
    })
}

/// A Java `InputStream` read to its end and closed; `None` past `max` bytes or on an exception.
fn read_stream(env: &mut JNIEnv<'_>, stream: &JObject<'_>, max: usize) -> Option<Vec<u8>> {
    let buffer = env.new_byte_array(TRACE_CHUNK_BYTES).ok()?;
    let mut out = Vec::new();
    let mut chunk = vec![0i8; TRACE_CHUNK_BYTES as usize];
    let whole = loop {
        let Some(read) = call(env, stream, "read", "([B)I", &[JValue::Object(&buffer)]).and_then(|answer| answer.i().ok()) else { break false };
        let Ok(count) = usize::try_from(read) else { break true };
        if out.len() + count > max || env.get_byte_array_region(&buffer, 0, &mut chunk[..count]).is_err() {
            break false;
        }
        out.extend(chunk[..count].iter().map(|byte| u8::from_ne_bytes(byte.to_ne_bytes())));
    };
    let _ = call(env, stream, "close", "()V", &[]);
    whole.then_some(out)
}
