//! The JNI bridge: what the activity's Java side knows and the native side needs, read through
//! framework classes. For the NativeActivity candidate (no Java code of its own) that includes the
//! display cutout GameActivity hands over natively (`Activity.getWindow().getDecorView()
//! .getRootWindowInsets().getDisplayCutout()`, API 28+); for both candidates, the audio focus
//! (`AudioManager.requestAudioFocus`), the thermal status (`PowerManager
//! .getCurrentThermalStatus`) and the display's refresh rate (`Display.getRefreshRate`). A missing object or a Java exception answers `None`, never a panic.

#[cfg(feature = "native-activity")]
use crate::SafeArea;
use jni::objects::{JObject, JValue};
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
