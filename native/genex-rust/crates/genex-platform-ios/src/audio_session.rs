//! The iOS audio session: `AVAudioSession`'s ambient category (the game follows the silent switch
//! and mixes with other apps' audio, as a game without its own music player should), active while
//! the app is resumed. The session is reached through the Objective-C runtime; a missing class or
//! a refused call answers "not granted", never a panic. Off iOS there is no session to ask for.
//!
//! Interruptions (a call, Siri, an alarm) arrive as `AVAudioSessionInterruptionNotification`s: an
//! observer registered with the first `acquire` turns each into an [`AudioChange`] on a small
//! queue the shell drains every frame ([`poll`]). Route changes need nothing: the ambient session
//! follows the route on its own.

use crate::mobile::audio::{AudioChange, AudioPlatform};
use std::collections::VecDeque;
use std::sync::Mutex;

/// Changes kept for the shell at most; older ones are dropped first (a frame drains them all).
pub const MAX_PENDING_CHANGES: usize = 16;
/// `AVAudioSessionInterruptionTypeBegan`.
const INTERRUPTION_BEGAN: usize = 1;
/// `AVAudioSessionInterruptionTypeEnded`.
const INTERRUPTION_ENDED: usize = 0;
/// `AVAudioSessionInterruptionOptionShouldResume`.
const OPTION_SHOULD_RESUME: usize = 1;

/// This build's audio hooks: the session on iOS, none elsewhere (the host's unit tests).
#[cfg(target_os = "ios")]
pub const PLATFORM_AUDIO: AudioPlatform = AudioPlatform { acquire: ios::acquire, release: ios::release, poll };
/// This build's audio hooks: the session on iOS, none elsewhere (the host's unit tests).
#[cfg(not(target_os = "ios"))]
pub const PLATFORM_AUDIO: AudioPlatform = AudioPlatform::NONE;

/// The interruption notification's type and options as a change (`None`: an unknown type).
pub fn interruption_change(kind: usize, options: usize) -> Option<AudioChange> {
    match kind {
        INTERRUPTION_BEGAN => Some(AudioChange::InterruptionBegan),
        INTERRUPTION_ENDED => Some(AudioChange::InterruptionEnded { resume: options & OPTION_SHOULD_RESUME != 0 }),
        _ => None,
    }
}

/// Changes the observer queued and the shell has not taken yet.
static PENDING: Mutex<VecDeque<AudioChange>> = Mutex::new(VecDeque::new());

/// Queue a change for the shell, dropping the oldest past [`MAX_PENDING_CHANGES`].
pub fn queue_change(change: AudioChange) {
    let Ok(mut pending) = PENDING.lock() else { return };
    if pending.len() >= MAX_PENDING_CHANGES {
        pending.pop_front();
    }
    pending.push_back(change);
}

/// The oldest change the shell has not taken.
pub fn poll() -> Option<AudioChange> {
    PENDING.lock().ok()?.pop_front()
}

#[cfg(target_os = "ios")]
mod ios {
    use super::{interruption_change, queue_change};
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, NSObject, Sel};
    use objc2::{ClassType, msg_send, sel};
    use objc2_foundation::NSString;
    use std::sync::Once;

    // AVAudioSession lives in AVFAudio (split out of AVFoundation in iOS 14.5); linking the
    // framework loads the class and the notification's name and keys.
    #[link(name = "AVFAudio", kind = "framework")]
    unsafe extern "C" {
        static AVAudioSessionInterruptionNotification: &'static NSString;
        static AVAudioSessionInterruptionTypeKey: &'static NSString;
        static AVAudioSessionInterruptionOptionKey: &'static NSString;
    }

    /// The observer is registered once, with the first `acquire`.
    static OBSERVE: Once = Once::new();

    /// `userInfo[key]` as an unsigned integer (0 when missing).
    fn info_number(note: &AnyObject, key: &NSString) -> usize {
        // SAFETY: -[NSNotification userInfo] answers an NSDictionary or nil.
        let info: *mut AnyObject = unsafe { msg_send![note, userInfo] };
        // SAFETY: the dictionary lives as long as the notification being delivered.
        let Some(info) = (unsafe { info.as_ref() }) else { return 0 };
        // SAFETY: -objectForKey: answers the value or nil; the interruption keys hold NSNumbers.
        let number: *mut AnyObject = unsafe { msg_send![info, objectForKey: key] };
        // SAFETY: as above, owned by the dictionary.
        let Some(number) = (unsafe { number.as_ref() }) else { return 0 };
        // SAFETY: -[NSNumber unsignedIntegerValue] answers an NSUInteger.
        unsafe { msg_send![number, unsignedIntegerValue] }
    }

    /// `-interrupted:`: one interruption notification, queued for the shell.
    unsafe extern "C-unwind" fn interrupted(_this: &AnyObject, _cmd: Sel, note: *mut AnyObject) {
        // SAFETY: NSNotificationCenter passes the notification being delivered.
        let Some(note) = (unsafe { note.as_ref() }) else { return };
        // SAFETY: the keys are AVFAudio's constant strings, alive for the whole process.
        let (type_key, option_key) = unsafe { (AVAudioSessionInterruptionTypeKey, AVAudioSessionInterruptionOptionKey) };
        if let Some(change) = interruption_change(info_number(note, type_key), info_number(note, option_key)) {
            queue_change(change);
        }
    }

    /// Register the observer class and add one instance to the default notification center.
    fn observe_interruptions() {
        let Some(mut builder) = ClassBuilder::new(c"GenexAudioInterruptions", NSObject::class()) else { return };
        // SAFETY: `interrupted` matches `-interrupted:` (an object receiver, a selector, one object).
        unsafe {
            builder.add_method(sel!(interrupted:), interrupted as unsafe extern "C-unwind" fn(_, _, _));
        }
        let class = builder.register();
        // SAFETY: +new on an NSObject subclass answers a retained instance; it is kept for the
        // whole process (the center does not retain its observers).
        let observer: *mut AnyObject = unsafe { msg_send![class, new] };
        let Some(center_class) = AnyClass::get(c"NSNotificationCenter") else { return };
        // SAFETY: +defaultCenter answers the process's center.
        let center: *mut AnyObject = unsafe { msg_send![center_class, defaultCenter] };
        let (Some(center), Some(observer)) = (unsafe { center.as_ref() }, unsafe { observer.as_ref() }) else { return };
        let none: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: the notification name is AVFAudio's constant; a nil object observes every sender.
        let name = unsafe { AVAudioSessionInterruptionNotification };
        // SAFETY: -addObserver:selector:name:object: with a live observer that implements the selector.
        let () = unsafe { msg_send![center, addObserver: observer, selector: sel!(interrupted:), name: name, object: none] };
    }

    /// `AVAudioSessionCategoryAmbient`'s value (Apple's category constants are their own names).
    const CATEGORY_AMBIENT: &str = "AVAudioSessionCategoryAmbient";

    /// The process's session, or `None` when the class is not there.
    fn shared_session() -> Option<&'static AnyObject> {
        let class = AnyClass::get(c"AVAudioSession")?;
        // SAFETY: +[AVAudioSession sharedInstance] takes no arguments and answers the process's
        // session, a singleton never released (or nil).
        let session: *mut AnyObject = unsafe { msg_send![class, sharedInstance] };
        // SAFETY: a non-null singleton lives for the whole process.
        unsafe { session.as_ref() }
    }

    /// Set the ambient category and activate the session; answers whether both were accepted.
    pub(super) fn acquire() -> bool {
        OBSERVE.call_once(observe_interruptions);
        let Some(session) = shared_session() else {
            log::warn!("no AVAudioSession: the game plays without a session");
            return false;
        };
        let category = NSString::from_str(CATEGORY_AMBIENT);
        let no_error: *mut *mut AnyObject = std::ptr::null_mut();
        // SAFETY: -setCategory:error: takes an NSString and a nullable NSError** out pointer.
        let categorized: bool = unsafe { msg_send![session, setCategory: &*category, error: no_error] };
        // SAFETY: -setActive:error: takes a BOOL and a nullable NSError** out pointer.
        let active: bool = unsafe { msg_send![session, setActive: true, error: no_error] };
        categorized && active
    }

    /// Deactivate the session (backgrounded).
    pub(super) fn release() {
        let Some(session) = shared_session() else { return };
        let no_error: *mut *mut AnyObject = std::ptr::null_mut();
        // SAFETY: -setActive:error: takes a BOOL and a nullable NSError** out pointer.
        let _: bool = unsafe { msg_send![session, setActive: false, error: no_error] };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_interruption_notification_becomes_a_typed_change() {
        assert_eq!(interruption_change(1, 0), Some(AudioChange::InterruptionBegan));
        assert_eq!(interruption_change(0, 1), Some(AudioChange::InterruptionEnded { resume: true }));
        assert_eq!(interruption_change(0, 0), Some(AudioChange::InterruptionEnded { resume: false }));
        assert_eq!(interruption_change(7, 1), None);
    }

    #[test]
    fn queued_changes_come_out_in_order_and_the_queue_is_bounded() {
        while poll().is_some() {}
        for _ in 0..MAX_PENDING_CHANGES + 3 {
            queue_change(AudioChange::InterruptionBegan);
        }
        queue_change(AudioChange::InterruptionEnded { resume: true });
        let drained: Vec<AudioChange> = std::iter::from_fn(poll).collect();
        assert_eq!(drained.len(), MAX_PENDING_CHANGES);
        assert_eq!(drained.last(), Some(&AudioChange::InterruptionEnded { resume: true }), "the newest is kept");
    }
}
