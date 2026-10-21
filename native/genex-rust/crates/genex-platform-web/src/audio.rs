//! The page's audio (game systems AU-8): the browser's autoplay policy lets an `AudioContext`
//! play only after a person's gesture, so the web shell opens its device (cpal's webaudio output
//! over the runtime's queue) on the first `pointerdown`, `keydown` or `touchend` and then removes
//! its listeners ([`Unlock`]). The meter works before that: `audio()` answers the game's own mix
//! ([`level_answer`]) whether or not a device plays, as `audioLevel` does natively.

use genex::audio::AudioLevel;
use serde_json::{Value, json};

/// The page events whose first one opens the audio device (a person's gesture).
pub const UNLOCK_EVENTS: [&str; 3] = ["pointerdown", "keydown", "touchend"];
/// `audio()` reports rms to four decimals and the centroid in whole hertz, as the native
/// `audioLevel` op does.
const RMS_SCALE: f64 = 10_000.0;

/// Whether the page's first gesture still has to open the device: the first one does, every
/// later one finds the listeners gone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Unlock {
    done: bool,
}

impl Unlock {
    /// A gesture arrived: answers true exactly once (open the device, remove the listeners).
    pub fn gesture(&mut self) -> bool {
        !std::mem::replace(&mut self.done, true)
    }

    /// Whether the gesture came and the listeners are gone.
    pub fn done(&self) -> bool {
        self.done
    }
}

/// The page's `audio()` probe: `{available: true, rms, centroid}` from the game's own mix, the
/// last 2048 frames before the mute (silence for a game that plays nothing).
pub fn level_answer(level: AudioLevel) -> Value {
    let rms = (level.rms * RMS_SCALE).round() / RMS_SCALE;
    json!({ "available": true, "rms": rms, "centroid": level.centroid.round() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AU-8 red row: the unlock listener opens the device once and is then removed.
    #[test]
    fn the_first_gesture_unlocks_once_and_later_ones_find_nothing_to_do() {
        let mut unlock = Unlock::default();
        assert!(!unlock.done());
        assert!(unlock.gesture(), "the first gesture opens the device");
        assert!(unlock.done(), "and the listeners go");
        for _ in UNLOCK_EVENTS {
            assert!(!unlock.gesture(), "never a second open");
        }
    }

    /// AU-8 red row: `audio()` answers available with the game's level, rounded as the native op.
    #[test]
    fn the_level_answer_is_available_with_the_rounded_mix() {
        let answer = level_answer(AudioLevel { rms: 0.088_634, centroid: 459.4 });
        assert_eq!(answer, json!({ "available": true, "rms": 0.0886, "centroid": 459.0 }));
        assert_eq!(level_answer(AudioLevel::default()), json!({ "available": true, "rms": 0.0, "centroid": 0.0 }));
    }
}
