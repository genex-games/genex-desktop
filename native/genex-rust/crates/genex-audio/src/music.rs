//! Music the mixer plays on its two music tracks. Bodies are AU-4's: today a music file is
//! decoded whole like a sound; AU-4 makes it a `MusicStream` that keeps the compressed bytes and
//! decodes Ogg packets inline while it plays (a ring of [`MUSIC_RING_FRAMES`]).

use crate::decode::decode_sound;
use crate::graph::tween;
use crate::mixer::{AudioError, Sound};
use crate::ops::MusicOpts;
use kira::sound::PlaybackState;
use kira::sound::static_sound::StaticSoundHandle;
use kira::track::TrackHandle;

/// Frames the streamed decoder keeps ahead of playback (0.5 s at 48 kHz).
pub const MUSIC_RING_FRAMES: usize = 24_000;
const STEREO_FRAME_BYTES: usize = 8;

/// A music file ready to play.
#[derive(Clone, Debug)]
pub struct Music {
    sound: Sound,
}

impl Music {
    /// `bytes` (a file whose extension is `ext`) as music.
    pub fn decode(bytes: &[u8], ext: &str) -> Result<Music, AudioError> {
        decode_sound(bytes, ext).map(Music::from_sound)
    }

    /// Already decoded frames as music.
    pub fn from_sound(sound: Sound) -> Music {
        Music { sound }
    }

    /// Length in seconds.
    pub fn seconds(&self) -> f64 {
        self.sound.seconds()
    }

    /// Bytes this music holds in memory.
    pub fn resident_bytes(&self) -> usize {
        self.sound.frames() * STEREO_FRAME_BYTES
    }

    /// Start it on `track` with `opts` (its `fade_s` is the fade-in).
    pub(crate) fn play_on(&self, track: &mut TrackHandle, opts: &MusicOpts) -> Result<MusicPlayback, AudioError> {
        let mut data = self.sound.data().clone().volume(crate::graph::clamp_db(opts.volume_db)).fade_in_tween(Some(tween(opts.fade_s)));
        data = data.start_position(finite_seconds(opts.start_s));
        if opts.looped {
            let start = finite_seconds(opts.loop_start_s);
            data = match opts.loop_end_s.map(finite_seconds).filter(|end| *end > start) {
                Some(end) => data.loop_region(start..end),
                None => data.loop_region(start..),
            };
        }
        let handle = track.play(data).map_err(|error| AudioError::new(crate::AudioErrorCode::SoundLimit, error.to_string()))?;
        Ok(MusicPlayback { handle })
    }
}

/// A music file playing on a music track.
#[derive(Debug)]
pub(crate) struct MusicPlayback {
    handle: StaticSoundHandle,
}

impl MusicPlayback {
    /// Fade it out over `fade_s` and stop.
    pub(crate) fn stop(&mut self, fade_s: f32) {
        self.handle.stop(tween(fade_s));
    }

    /// Whether it still plays.
    pub(crate) fn is_playing(&self) -> bool {
        self.handle.state() != PlaybackState::Stopped
    }
}

fn finite_seconds(seconds: f32) -> f64 {
    if seconds.is_finite() { f64::from(seconds.max(0.0)) } else { 0.0 }
}
