//! Sound files into [`Sound`]s: WAV, Ogg Vorbis, MP3 and FLAC through symphonia 0.6 (kira's own
//! copy, so one symphonia in the lock). Opus and AAC never reach the runtime as delivered: the
//! studio's import step converts them to Ogg, so here they are `needs-import`, by extension or by
//! the codec inside the container (an Opus stream named `.ogg`). raylib's own QOA, XM and MOD, and
//! anything else, are `unsupported-format`.
//!
//! Hostile bytes never panic out of here: every symphonia call runs under [`guarded`], so a decoder
//! panic is `malformed` on native (on wasm32 a panic aborts, so the hostile-input table in
//! `tests/decode.rs` is the guard there). No size a file claims is trusted: a track claiming more
//! than [`MAX_CLAIMED_SECONDS`] is `malformed`, and a whole-file decode stops at
//! [`MAX_DECODED_FRAMES`] (`too-large`), so a small file cannot expand into gigabytes.
//!
//! The decode loop and the sample conversion are ported from kira 0.12.5
//! (`src/sound/static_sound/data/from_file.rs` and `src/sound/symphonia.rs`, MIT OR Apache-2.0,
//! used under Apache 2.0), so a sound decodes to the same frames, bit for bit, as kira's
//! `StaticSoundData::from_cursor`. Changed from kira: the decode stops at [`MAX_DECODED_FRAMES`],
//! a claimed length past [`MAX_CLAIMED_SECONDS`] and an Opus or AAC track are refused, every call
//! runs under [`guarded`], and a frame range of a buffer can be appended (the streamed music
//! shares it).

use crate::mixer::{AudioError, AudioErrorCode, Sound};
use crate::vocab::SOUNDS_DECODED_MAX_BYTES;
use kira::Frame;
use kira::sound::static_sound::{StaticSoundData, StaticSoundSettings};
use std::io::Cursor;
use std::ops::Range;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use symphonia::core::audio::conv::{FromSample, IntoSample};
use symphonia::core::audio::sample::Sample;
use symphonia::core::audio::{Audio, AudioBuffer, GenericAudioBufferRef};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::AudioDecoder;
use symphonia::core::codecs::audio::well_known::{CODEC_ID_AAC, CODEC_ID_FLAC, CODEC_ID_OPUS, CODEC_ID_VORBIS};
use symphonia::core::formats::{FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::units::Timestamp;

/// The largest sound file decoded into memory.
pub const MAX_SOUND_BYTES: usize = 64 * 1024 * 1024;
/// Bytes one decoded frame holds (f32 stereo).
pub(crate) const STEREO_FRAME_BYTES: usize = 8;
/// The most frames one whole-file decode keeps: the sim's decoded-sound budget at f32 stereo.
pub const MAX_DECODED_FRAMES: usize = SOUNDS_DECODED_MAX_BYTES / STEREO_FRAME_BYTES;
/// The longest track a file may claim (two hours); a header claiming more is `malformed`.
pub const MAX_CLAIMED_SECONDS: u64 = 2 * 60 * 60;

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

/// Refuse a file by its extension and size before any byte is parsed.
pub(crate) fn admit(bytes_len: usize, ext: &str) -> Result<(), AudioError> {
    match format_of(ext) {
        SoundFormat::Imported => Err(AudioError::new(AudioErrorCode::NeedsImport, format!(".{ext} is converted to Ogg at import"))),
        SoundFormat::Refused => {
            Err(AudioError::new(AudioErrorCode::UnsupportedFormat, format!(".{ext} is not a sound the runtime plays")))
        }
        SoundFormat::Decoded if bytes_len > MAX_SOUND_BYTES => {
            Err(AudioError::new(AudioErrorCode::TooLarge, format!("{bytes_len} bytes")))
        }
        SoundFormat::Decoded => Ok(()),
    }
}

/// `bytes` (a file whose extension is `ext`, without its dot) decoded into a sound at its own rate.
pub fn decode_sound(bytes: &[u8], ext: &str) -> Result<Sound, AudioError> {
    admit(bytes.len(), ext)?;
    let mut track = open_track(Arc::from(bytes))?;
    let frames = decode_all(&mut track)?;
    if frames.is_empty() {
        return Err(malformed("no audio frames"));
    }
    let frames: Arc<[Frame]> = frames.into();
    let data = StaticSoundData { sample_rate: track.sample_rate, frames, settings: StaticSoundSettings::default(), slice: None };
    Ok(Sound::from_data(data))
}

fn decode_all(track: &mut OpenTrack) -> Result<Vec<Frame>, AudioError> {
    let mut frames = Vec::new();
    while let Some((_, decoded)) = track.next_packet()? {
        if frames.len() + decoded > MAX_DECODED_FRAMES {
            let detail = format!("more than {MAX_DECODED_FRAMES} decoded frames; play it as music");
            return Err(AudioError::new(AudioErrorCode::TooLarge, detail));
        }
        append_frames(&track.decoder.last_decoded(), 0..decoded, &mut frames)?;
    }
    Ok(frames)
}

/// A file's default audio track, probed, with its decoder made.
pub(crate) struct OpenTrack {
    reader: Box<dyn FormatReader>,
    pub(crate) decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    pub(crate) sample_rate: u32,
    /// The frames the container claims, already held to [`MAX_CLAIMED_SECONDS`].
    pub(crate) claimed_frames: Option<u64>,
    /// Whether an accurate seek plus one priming packet gives the frames a linear decode gives
    /// (Vorbis and FLAC; MP3's bit reservoir does not, so its loops reopen the file instead).
    pub(crate) seek_exact: bool,
}

impl OpenTrack {
    /// Decode the next packet of the track: `Ok(Some((pts, frames)))` leaves its frames in
    /// `decoder.last_decoded()`; `Ok(None)` is the end of the file.
    pub(crate) fn next_packet(&mut self) -> Result<Option<(i64, usize)>, AudioError> {
        let Self { reader, decoder, track_id, .. } = self;
        guarded(|| {
            loop {
                let Some(packet) = reader.next_packet().map_err(|error| malformed(error.to_string()))? else { return Ok(None) };
                if packet.track_id != *track_id {
                    continue;
                }
                let frames = decoder.decode(&packet).map_err(|error| malformed(error.to_string()))?.frames();
                return Ok(Some((packet.pts.get(), frames)));
            }
        })?
    }

    /// Seek accurately to the packet holding `ts` (or before it) and reset the decoder; answers
    /// the timestamp the reader landed on.
    pub(crate) fn seek(&mut self, ts: i64) -> Result<i64, AudioError> {
        let Self { reader, decoder, track_id, .. } = self;
        guarded(|| {
            let to = SeekTo::Timestamp { ts: Timestamp::new(ts), track_id: *track_id };
            let seeked = reader.seek(SeekMode::Accurate, to).map_err(|error| malformed(error.to_string()))?;
            decoder.reset();
            Ok(seeked.actual_ts.get())
        })?
    }
}

/// Probe `bytes` as kira does (no hint: the content decides) and open its default audio track.
pub(crate) fn open_track(bytes: Arc<[u8]>) -> Result<OpenTrack, AudioError> {
    guarded(move || {
        let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
        let reader = symphonia::default::get_probe()
            .probe(&Default::default(), mss, Default::default(), Default::default())
            .map_err(|error| malformed(error.to_string()))?;
        let track = reader.default_track(TrackType::Audio).ok_or_else(|| malformed("no audio track"))?;
        let Some(CodecParameters::Audio(params)) = track.codec_params.as_ref() else { return Err(malformed("no audio track")) };
        if params.codec == CODEC_ID_OPUS || params.codec == CODEC_ID_AAC {
            return Err(AudioError::new(AudioErrorCode::NeedsImport, "an Opus or AAC stream is converted to Vorbis at import"));
        }
        let sample_rate = params.sample_rate.filter(|rate| *rate > 0).ok_or_else(|| malformed("no sample rate"))?;
        let claimed_frames = track.num_frames;
        if let Some(frames) = claimed_frames.filter(|frames| *frames > MAX_CLAIMED_SECONDS * u64::from(sample_rate)) {
            return Err(malformed(format!("the file claims {frames} frames")));
        }
        let seek_exact = params.codec == CODEC_ID_VORBIS || params.codec == CODEC_ID_FLAC;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(params, &Default::default())
            .map_err(|error| malformed(error.to_string()))?;
        let track_id = track.id;
        Ok(OpenTrack { reader, decoder, track_id, sample_rate, claimed_frames, seek_exact })
    })?
}

/// Append frames `range` of a decoded buffer (mono as both sides), converted as kira converts them.
pub(crate) fn append_frames(
    buffer: &GenericAudioBufferRef<'_>,
    range: Range<usize>,
    out: &mut impl Extend<Frame>,
) -> Result<(), AudioError> {
    match buffer {
        GenericAudioBufferRef::U8(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::U16(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::U24(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::U32(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::S8(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::S16(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::S24(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::S32(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::F32(buffer) => append_from(buffer, range, out),
        GenericAudioBufferRef::F64(buffer) => append_from(buffer, range, out),
    }
}

fn append_from<S: Sample>(buffer: &AudioBuffer<S>, range: Range<usize>, out: &mut impl Extend<Frame>) -> Result<(), AudioError>
where
    f32: FromSample<S>,
{
    let plane = |index: usize| buffer.plane(index).and_then(|plane| plane.get(range.clone())).ok_or_else(|| malformed("a short plane"));
    match buffer.num_planes() {
        1 => out.extend(plane(0)?.iter().map(|sample| Frame::from_mono((*sample).into_sample()))),
        2 => out.extend(plane(0)?.iter().zip(plane(1)?).map(|(left, right)| Frame::new((*left).into_sample(), (*right).into_sample()))),
        planes => return Err(malformed(format!("{planes} channels; the runtime plays mono and stereo"))),
    }
    Ok(())
}

/// Run a symphonia call, turning a panic on hostile bytes into `malformed`.
pub(crate) fn guarded<T>(call: impl FnOnce() -> T) -> Result<T, AudioError> {
    catch_unwind(AssertUnwindSafe(call)).map_err(|_| malformed("the decoder failed on these bytes"))
}

/// A `malformed` refusal.
pub(crate) fn malformed(detail: impl Into<String>) -> AudioError {
    AudioError::new(AudioErrorCode::Malformed, detail)
}
