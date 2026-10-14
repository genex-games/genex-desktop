//! Sound files into [`Sound`]s: WAV, Ogg Vorbis, MP3 and FLAC through symphonia 0.6 (kira's own
//! copy, so one symphonia in the lock). Opus and AAC never reach the runtime as delivered: the
//! studio's import step converts them to Ogg, so here they are `needs-import`. raylib's own QOA,
//! XM and MOD, and anything else, are `unsupported-format`.

use crate::mixer::{AudioError, AudioErrorCode, Sound};
use kira::sound::static_sound::StaticSoundData;
use std::io::Cursor;

/// The largest sound file decoded into memory.
pub const MAX_SOUND_BYTES: usize = 64 * 1024 * 1024;

/// What the runtime does with a sound file, by its lowercase extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SoundFormat {
    Decoded,
    Imported,
    Refused,
}

fn format_of(ext: &str) -> SoundFormat {
    match ext.to_ascii_lowercase().as_str() {
        "wav" | "ogg" | "oga" | "mp3" | "flac" => SoundFormat::Decoded,
        "opus" | "m4a" | "aac" => SoundFormat::Imported,
        _ => SoundFormat::Refused,
    }
}

/// `bytes` (a file whose extension is `ext`, without its dot) decoded into a sound at its own rate.
pub fn decode_sound(bytes: &[u8], ext: &str) -> Result<Sound, AudioError> {
    match format_of(ext) {
        SoundFormat::Imported => {
            return Err(AudioError::new(AudioErrorCode::NeedsImport, format!(".{ext} is converted to Ogg at import")));
        }
        SoundFormat::Refused => {
            return Err(AudioError::new(AudioErrorCode::UnsupportedFormat, format!(".{ext} is not a sound the runtime plays")));
        }
        SoundFormat::Decoded => {}
    }
    if bytes.len() > MAX_SOUND_BYTES {
        return Err(AudioError::new(AudioErrorCode::TooLarge, format!("{} bytes", bytes.len())));
    }
    let data = StaticSoundData::from_cursor(Cursor::new(bytes.to_vec()))
        .map_err(|error| AudioError::new(AudioErrorCode::Malformed, error.to_string()))?;
    if data.frames.is_empty() || data.sample_rate == 0 {
        return Err(AudioError::new(AudioErrorCode::Malformed, "no audio frames"));
    }
    Ok(Sound::from_data(data))
}
