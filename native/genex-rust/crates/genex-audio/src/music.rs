//! Music the mixer plays on its two music tracks. A music file stays compressed: [`Music::stream`]
//! keeps the file's bytes (shared with the asset table, never read from disk here) and a playing
//! music track decodes its packets inline, inside kira's `process()`, into a ring of at most
//! [`MUSIC_RING_FRAMES`] frames. There is no decoder thread (kira's `StreamingSoundData` starts
//! one and does not exist on wasm32): the device-less renderer runs on the sim thread, so decoding
//! there is safe and its output is a pure function of the bytes and the [`MusicOpts`].
//!
//! The playback is ported from kira 0.12.5's `StaticSound` (`src/sound/static_sound/sound.rs` and
//! `sound/resampler.rs`, MIT OR Apache-2.0, used under Apache 2.0): the same 4-point resampler for
//! a file at another rate and the same volume, fade and position arithmetic, so a streamed file
//! sounds, bit for bit, like the same file decoded whole and played static, loops included.
//! Changed from kira: source frames come from a ring that symphonia packets fill inline instead of
//! a decoded array; a loop wraps by an accurate seek before the loop start plus one priming packet
//! (Vorbis, FLAC) or by reopening the file and decoding forward to it (MP3, or a seek that lands
//! past it); there are no pause, resume, rate, panning, seek or loop-region commands, only a stop.

use crate::decode::{OpenTrack, STEREO_FRAME_BYTES, admit, append_frames, malformed, open_track};
use crate::graph::{clamp_db, tween};
use crate::mixer::{AudioError, AudioErrorCode, Sound};
use crate::ops::MusicOpts;
use kira::command::{CommandReader, CommandWriter, command_writer_and_reader};
use kira::info::Info;
use kira::sound::static_sound::StaticSoundHandle;
use kira::sound::{PlaybackState, SoundData};
use kira::track::TrackHandle;
use kira::{Decibels, Frame, Panning, Parameter, Tween, Value, interpolate_frame};
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// The most decoded frames a playing music track holds ahead of playback.
pub const MUSIC_RING_FRAMES: usize = 4096;
/// What a playing streamed track holds beyond its file, at most: symphonia's Vorbis decoder keeps
/// its codebooks' lookup tables (1.55-1.94 MB measured over libvorbis files from `-q:a -1` to
/// `-q:a 10` at 22-48 kHz), the Ogg reader 0.16 MB (its 64 KiB read buffer included) and the ring
/// 32 KiB. The music tests measure it against this.
pub const MUSIC_WORKING_BYTES: usize = 2560 * 1024;
/// Frames a loop's seek lands before the loop start, so the priming packet (which decodes to
/// nothing) ends before it: twice Vorbis's largest block.
const SEEK_PREROLL_FRAMES: u64 = 16_384;
/// Packets decoded when a file is admitted, to refuse one that does not play before it is used.
const ADMIT_PACKETS: usize = 8;
/// Consecutive loop wraps that produced no frame before a looped track gives up (an empty region).
const EMPTY_WRAPS_MAX: u32 = 2;

/// A music file ready to play.
#[derive(Clone, Debug)]
pub struct Music {
    kind: MusicKind,
}

#[derive(Clone, Debug)]
enum MusicKind {
    Decoded(Box<Sound>),
    Streamed(Arc<StreamedFile>),
}

/// A compressed file a music track decodes while it plays.
struct StreamedFile {
    bytes: Arc<[u8]>,
    sample_rate: u32,
    claimed_frames: Option<u64>,
    /// A packet's first decoded frame is frame `pts + pts_offset` of the linear decode.
    pts_offset: i64,
    seek_exact: bool,
}

impl fmt::Debug for StreamedFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamedFile").field("bytes", &self.bytes.len()).field("sample_rate", &self.sample_rate).finish()
    }
}

impl Music {
    /// `bytes` (a file whose extension is `ext`) as streamed music; the bytes are copied once.
    pub fn decode(bytes: &[u8], ext: &str) -> Result<Music, AudioError> {
        Music::stream(Arc::from(bytes), ext)
    }

    /// `bytes` (a file whose extension is `ext`, shared with the asset table) as streamed music.
    /// The first packets are decoded now, so a file that does not play is refused here, typed
    /// like [`crate::decode_sound`]'s refusals, rather than going silent while it plays.
    pub fn stream(bytes: Arc<[u8]>, ext: &str) -> Result<Music, AudioError> {
        admit(bytes.len(), ext)?;
        let mut track = open_track(bytes.clone())?;
        let pts_offset = first_frame_offset(&mut track)?;
        let file = StreamedFile {
            bytes,
            sample_rate: track.sample_rate,
            claimed_frames: track.claimed_frames,
            pts_offset,
            seek_exact: track.seek_exact,
        };
        Ok(Music { kind: MusicKind::Streamed(Arc::new(file)) })
    }

    /// Already decoded frames as music.
    pub fn from_sound(sound: Sound) -> Music {
        Music { kind: MusicKind::Decoded(Box::new(sound)) }
    }

    /// Whether it plays from compressed bytes.
    pub fn is_streamed(&self) -> bool {
        matches!(self.kind, MusicKind::Streamed(_))
    }

    /// The file's own sample rate, in Hz.
    pub fn sample_rate(&self) -> u32 {
        match &self.kind {
            MusicKind::Decoded(sound) => sound.sample_rate(),
            MusicKind::Streamed(file) => file.sample_rate,
        }
    }

    /// Length in seconds (for a streamed file, the length its container claims).
    pub fn seconds(&self) -> f64 {
        match &self.kind {
            MusicKind::Decoded(sound) => sound.seconds(),
            MusicKind::Streamed(file) => file.claimed_frames.unwrap_or(0) as f64 / f64::from(file.sample_rate),
        }
    }

    /// Bytes this music holds in memory while one track plays it: the decoded frames, or the
    /// compressed file plus at most [`MUSIC_WORKING_BYTES`] (a crossfade between two streamed
    /// tracks holds two working sets).
    pub fn resident_bytes(&self) -> usize {
        match &self.kind {
            MusicKind::Decoded(sound) => sound.frames() * STEREO_FRAME_BYTES,
            MusicKind::Streamed(file) => file.bytes.len() + MUSIC_WORKING_BYTES,
        }
    }

    /// Start it on `track` with `opts` (its `fade_s` is the fade-in).
    pub(crate) fn play_on(&self, track: &mut TrackHandle, opts: &MusicOpts) -> Result<MusicPlayback, AudioError> {
        let refused = |detail: String| AudioError::new(AudioErrorCode::SoundLimit, detail);
        match &self.kind {
            MusicKind::Decoded(sound) => {
                let handle = track.play(static_data(sound, opts)).map_err(|error| refused(error.to_string()))?;
                Ok(MusicPlayback { handle: PlaybackHandle::Decoded(handle) })
            }
            MusicKind::Streamed(file) => {
                let data = StreamData { file: file.clone(), opts: *opts };
                let handle = track.play(data).map_err(|error| refused(error.to_string()))?;
                Ok(MusicPlayback { handle: PlaybackHandle::Streamed(handle) })
            }
        }
    }
}

/// Decode the first packets: the file plays, and where a packet's frames sit in the linear decode
/// (the first packet with frames starts it, so its timestamp maps to frame 0).
fn first_frame_offset(track: &mut OpenTrack) -> Result<i64, AudioError> {
    for _ in 0..ADMIT_PACKETS {
        match track.next_packet()? {
            Some((pts, frames)) if frames > 0 => return Ok(pts.saturating_neg()),
            Some(_) => {}
            None => break,
        }
    }
    Err(malformed("no audio frames in the first packets"))
}

fn static_data(sound: &Sound, opts: &MusicOpts) -> kira::sound::static_sound::StaticSoundData {
    let mut data = sound.data().clone().volume(clamp_db(opts.volume_db)).fade_in_tween(Some(tween(opts.fade_s)));
    data = data.start_position(finite_seconds(opts.start_s));
    match loop_seconds(opts) {
        Some((start, Some(end))) => data.loop_region(start..end),
        Some((start, None)) => data.loop_region(start..),
        None => data,
    }
}

/// The loop region in seconds: its start, and its end (`None`: the end of the file).
fn loop_seconds(opts: &MusicOpts) -> Option<(f64, Option<f64>)> {
    if !opts.looped {
        return None;
    }
    let start = finite_seconds(opts.loop_start_s);
    Some((start, opts.loop_end_s.map(finite_seconds).filter(|end| *end > start)))
}

fn finite_seconds(seconds: f32) -> f64 {
    if seconds.is_finite() { f64::from(seconds.max(0.0)) } else { 0.0 }
}

/// Seconds to a frame index, as kira's `PlaybackPosition::into_samples` rounds them.
fn frame_index(seconds: f64, sample_rate: u32) -> u64 {
    (seconds * f64::from(sample_rate)).round() as u64
}

/// A music file playing on a music track.
#[derive(Debug)]
pub(crate) struct MusicPlayback {
    handle: PlaybackHandle,
}

#[derive(Debug)]
enum PlaybackHandle {
    Decoded(StaticSoundHandle),
    Streamed(StreamHandle),
}

impl MusicPlayback {
    /// Fade it out over `fade_s` and stop.
    pub(crate) fn stop(&mut self, fade_s: f32) {
        match &mut self.handle {
            PlaybackHandle::Decoded(handle) => handle.stop(tween(fade_s)),
            PlaybackHandle::Streamed(handle) => handle.stop.write(tween(fade_s)),
        }
    }

    /// Whether it still plays.
    pub(crate) fn is_playing(&self) -> bool {
        match &self.handle {
            PlaybackHandle::Decoded(handle) => handle.state() != PlaybackState::Stopped,
            PlaybackHandle::Streamed(handle) => !handle.stopped.load(Ordering::SeqCst),
        }
    }
}

/// What the game holds of a streamed track: a stop command and whether it stopped.
pub(crate) struct StreamHandle {
    stop: CommandWriter<Tween>,
    stopped: Arc<AtomicBool>,
}

impl fmt::Debug for StreamHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamHandle").field("stopped", &self.stopped.load(Ordering::SeqCst)).finish()
    }
}

/// A streamed file and how to play it, before kira takes it.
struct StreamData {
    file: Arc<StreamedFile>,
    opts: MusicOpts,
}

impl SoundData for StreamData {
    type Error = AudioError;
    type Handle = StreamHandle;

    fn into_sound(self) -> Result<(Box<dyn kira::sound::Sound>, StreamHandle), AudioError> {
        let (writer, reader) = command_writer_and_reader();
        let stopped = Arc::new(AtomicBool::new(false));
        let sound = MusicStream::new(&self.file, &self.opts, reader, stopped.clone());
        Ok((Box::new(sound), StreamHandle { stop: writer, stopped }))
    }
}

/// kira's `StaticSound` playback over a [`Feeder`] (see the module docs).
struct MusicStream {
    feeder: Feeder,
    ring: VecDeque<Frame>,
    sample_rate: u32,
    resampler: Resampler,
    fractional_position: f64,
    /// Whether the source still has frames (kira's `transport.playing`).
    source_playing: bool,
    volume: Parameter<Decibels>,
    fade: Parameter<Decibels>,
    state: PlaybackState,
    stop: CommandReader<Tween>,
    stopped: Arc<AtomicBool>,
}

impl MusicStream {
    fn new(file: &Arc<StreamedFile>, opts: &MusicOpts, stop: CommandReader<Tween>, stopped: Arc<AtomicBool>) -> MusicStream {
        let rate = file.sample_rate;
        let start = frame_index(finite_seconds(opts.start_s), rate);
        let looped =
            loop_seconds(opts).map(|(start, end)| (frame_index(start, rate), end.map(|end| frame_index(end, rate))));
        let mut fade = Parameter::new(Value::Fixed(Decibels::SILENCE), Decibels::SILENCE);
        fade.set(Value::Fixed(Decibels::IDENTITY), tween(opts.fade_s));
        let mut sound = MusicStream {
            feeder: Feeder::new(file.clone(), start, looped),
            ring: VecDeque::with_capacity(MUSIC_RING_FRAMES),
            sample_rate: rate,
            resampler: Resampler::default(),
            fractional_position: 0.0,
            source_playing: true,
            volume: Parameter::new(Value::Fixed(Decibels(clamp_db(opts.volume_db))), Decibels::IDENTITY),
            fade,
            state: PlaybackState::Playing,
            stop,
            stopped,
        };
        // As kira's static sound: three frames in the resampler so playback starts at once.
        for _ in 0..3 {
            sound.update_position();
        }
        sound
    }

    /// The next source frame (refilling the ring from the decoder when it runs dry), pushed to
    /// the resampler: kira's `update_position` with the transport replaced by the feeder.
    fn update_position(&mut self) {
        let frame = if self.source_playing { self.next_frame() } else { None };
        self.source_playing = frame.is_some();
        self.resampler.push_frame(frame);
        if !self.source_playing && self.resampler.empty() {
            self.mark(PlaybackState::Stopped);
        }
    }

    fn next_frame(&mut self) -> Option<Frame> {
        if self.ring.is_empty() {
            self.feeder.fill(&mut self.ring, MUSIC_RING_FRAMES);
        }
        self.ring.pop_front()
    }

    fn mark(&mut self, state: PlaybackState) {
        self.state = state;
        let stopped = state == PlaybackState::Stopped;
        self.stopped.store(stopped, Ordering::SeqCst);
        if stopped {
            self.release();
        }
    }

    /// Free the working set (the decoder, its reader and the ring) once the track stopped: kira
    /// drops a finished sound only later, so a crossfade every few seconds would otherwise hold a
    /// third working set (GE fix r2, AU-10's crossfade row). A stopped stream reads no frame again.
    fn release(&mut self) {
        self.feeder.track = None;
        self.ring = VecDeque::new();
    }

    /// kira's `PlaybackStateManager::update` for the states music uses.
    fn update_fade(&mut self, dt: f64, info: &Info) {
        let finished = self.fade.update(dt, info);
        if finished && self.state == PlaybackState::Stopping {
            self.mark(PlaybackState::Stopped);
        }
    }
}

impl kira::sound::Sound for MusicStream {
    fn on_start_processing(&mut self) {
        if let Some(fade_out) = self.stop.read()
            && self.state != PlaybackState::Stopped
        {
            self.state = PlaybackState::Stopping;
            self.fade.set(Value::Fixed(Decibels::SILENCE), fade_out);
        }
    }

    fn process(&mut self, out: &mut [Frame], dt: f64, info: &Info) {
        let chunk_seconds = dt * out.len() as f64;
        self.volume.update(chunk_seconds, info);
        self.update_fade(chunk_seconds, info);
        if !self.state.is_advancing() {
            out.fill(Frame::ZERO);
            return;
        }
        let frames = out.len();
        for (i, frame) in out.iter_mut().enumerate() {
            let time_in_chunk = (i + 1) as f64 / frames as f64;
            let volume = self.volume.interpolated_value(time_in_chunk).as_amplitude();
            let fade_volume = self.fade.interpolated_value(time_in_chunk).as_amplitude();
            let resampled = self.resampler.get(self.fractional_position as f32);
            self.fractional_position += f64::from(self.sample_rate) * dt;
            while self.fractional_position >= 1.0 {
                self.fractional_position -= 1.0;
                self.update_position();
            }
            *frame = (resampled * fade_volume * volume).panned(Panning::CENTER);
        }
    }

    fn finished(&self) -> bool {
        self.state == PlaybackState::Stopped
    }
}

/// kira's static-sound resampler: the four most recent source frames for 4-point interpolation.
#[derive(Default)]
struct Resampler {
    frames: [Frame; 4],
    time_until_empty: usize,
}

impl Resampler {
    fn push_frame(&mut self, frame: Option<Frame>) {
        self.time_until_empty = if frame.is_some() { 4 } else { self.time_until_empty.saturating_sub(1) };
        self.frames.copy_within(1.., 0);
        self.frames[3] = frame.unwrap_or_default();
    }

    fn get(&self, fraction: f32) -> Frame {
        interpolate_frame(self.frames[0], self.frames[1], self.frames[2], self.frames[3], fraction)
    }

    fn empty(&self) -> bool {
        self.time_until_empty == 0
    }
}

/// The decoder side of a playing track: frames of the linear decode in playback order, from the
/// start position, wrapping at the loop end.
struct Feeder {
    file: Arc<StreamedFile>,
    track: Option<OpenTrack>,
    /// Index (in the linear decode) of the decoder's last buffer's first frame, its length, and the
    /// next frame of it to hand out.
    packet_start: u64,
    packet_len: usize,
    cursor: usize,
    /// Index of the next packet's first frame while decoding linearly.
    next_start: u64,
    /// After a seek: take the next packet's index from its timestamp.
    anchored: bool,
    /// Frames before this index are decoded and dropped (the start position, a loop start).
    skip_below: u64,
    looped: Option<(u64, Option<u64>)>,
    since_wrap: u64,
    empty_wraps: u32,
    /// Times the file was opened (the first open included).
    opens: u32,
}

impl Feeder {
    fn new(file: Arc<StreamedFile>, start: u64, looped: Option<(u64, Option<u64>)>) -> Feeder {
        let mut feeder = Feeder {
            file,
            track: None,
            packet_start: 0,
            packet_len: 0,
            cursor: 0,
            next_start: 0,
            anchored: false,
            skip_below: 0,
            looped,
            since_wrap: 0,
            empty_wraps: 0,
            opens: 0,
        };
        feeder.restart_at(start);
        feeder
    }

    /// Queue frames until `ring` holds `cap` or the music ends (the track is then `None`).
    fn fill(&mut self, ring: &mut VecDeque<Frame>, cap: usize) {
        while ring.len() < cap && self.track.is_some() {
            if self.cursor >= self.packet_len {
                self.next_packet();
                continue;
            }
            let index = self.packet_start + self.cursor as u64;
            if let Some((start, Some(end))) = self.looped
                && index >= end
            {
                self.wrap(start);
                continue;
            }
            let left = (self.packet_len - self.cursor) as u64;
            if index < self.skip_below {
                self.cursor += usize::try_from(left.min(self.skip_below - index)).unwrap_or(usize::MAX);
                continue;
            }
            let until_end = self.looped.and_then(|(_, end)| end).map_or(u64::MAX, |end| end - index);
            let take = left.min(until_end).min((cap - ring.len()) as u64) as usize;
            self.copy(ring, take);
        }
    }

    fn copy(&mut self, ring: &mut VecDeque<Frame>, take: usize) {
        let Some(track) = self.track.as_ref() else { return };
        if append_frames(&track.decoder.last_decoded(), self.cursor..self.cursor + take, ring).is_err() {
            self.track = None;
            return;
        }
        self.cursor += take;
        self.since_wrap += take as u64;
    }

    fn next_packet(&mut self) {
        let Some(track) = self.track.as_mut() else { return };
        match track.next_packet() {
            Ok(Some((pts, frames))) => self.take_packet(pts, frames),
            Ok(None) => match self.looped {
                Some((start, None)) => self.wrap(start),
                _ => self.track = None,
            },
            // A packet that does not decode ends the music; the frames before it played.
            Err(_) => self.track = None,
        }
    }

    fn take_packet(&mut self, pts: i64, frames: usize) {
        let start = if self.anchored { u64::try_from(pts + self.file.pts_offset).unwrap_or(0) } else { self.next_start };
        if self.anchored && frames > 0 {
            self.anchored = false;
            if start > self.skip_below {
                // The seek landed past the frame wanted: decode forward from the start instead.
                self.reopen();
                return;
            }
        }
        self.packet_start = start;
        self.packet_len = frames;
        self.cursor = 0;
        self.next_start = start + frames as u64;
    }

    fn wrap(&mut self, start: u64) {
        self.empty_wraps = if self.since_wrap == 0 { self.empty_wraps + 1 } else { 0 };
        if self.empty_wraps >= EMPTY_WRAPS_MAX {
            self.track = None;
            return;
        }
        self.since_wrap = 0;
        self.restart_at(start);
    }

    /// Hand out frames from `target` next: seek before it when the codec seeks exactly, else (or
    /// when the seek fails) reopen the file and decode forward to it.
    fn restart_at(&mut self, target: u64) {
        self.skip_below = target;
        self.packet_len = 0;
        self.cursor = 0;
        if self.track.is_none() {
            self.reopen();
        }
        if !(self.file.seek_exact && target > SEEK_PREROLL_FRAMES) {
            if self.next_start > 0 || self.anchored {
                self.reopen();
            }
            return;
        }
        let ts = i64::try_from(target - SEEK_PREROLL_FRAMES).unwrap_or(i64::MAX).saturating_sub(self.file.pts_offset);
        match self.track.as_mut().map(|track| track.seek(ts)) {
            Some(Ok(_)) => self.anchored = true,
            _ => self.reopen(),
        }
    }

    fn reopen(&mut self) {
        // The old decoder goes first, so a wrap never holds two working sets.
        self.track = None;
        self.track = open_track(self.file.bytes.clone()).ok();
        self.opens += 1;
        self.packet_len = 0;
        self.cursor = 0;
        self.next_start = 0;
        self.anchored = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode_sound;

    /// Read at run time: `cargo test` sets the variable, and an ejected fork's sources may not
    /// bake a build path in with `env!` (the stage refuses `env-not-fixed`).
    fn fixture() -> Vec<u8> {
        let dir = std::env::var_os("CARGO_MANIFEST_DIR").expect("cargo test sets CARGO_MANIFEST_DIR");
        std::fs::read(std::path::Path::new(&dir).join("tests/fixtures/music-10s.ogg")).unwrap()
    }

    fn feed(feeder: &mut Feeder, frames: usize) -> Vec<Frame> {
        let mut ring = VecDeque::new();
        let mut out = Vec::new();
        while out.len() < frames {
            feeder.fill(&mut ring, MUSIC_RING_FRAMES);
            if ring.is_empty() {
                break;
            }
            out.extend(ring.drain(..));
        }
        out.truncate(frames);
        out
    }

    /// The first frame where `got` leaves `expected`, if any (frames compared bit for bit).
    fn first_difference(got: &[Frame], expected: &[Frame]) -> Option<usize> {
        let bits = |frame: &Frame| (frame.left.to_bits(), frame.right.to_bits());
        let differs = got.iter().zip(expected).position(|(a, b)| bits(a) != bits(b));
        differs.or((got.len() != expected.len()).then_some(got.len().min(expected.len())))
    }

    /// A loop 6 s into a Vorbis file wraps by seeking (the file is opened once) and hands out
    /// exactly the linear decode's frames: the region, then the region again.
    #[test]
    fn a_vorbis_loop_wraps_by_seeking_to_the_linear_decodes_frames() {
        let bytes = fixture();
        let linear = decode_sound(&bytes, "ogg").unwrap();
        let Music { kind: MusicKind::Streamed(file) } = Music::decode(&bytes, "ogg").unwrap() else { panic!("streamed") };
        let (start, end) = (288_000_usize, 302_400_usize);
        let mut feeder = Feeder::new(file, start as u64, Some((start as u64, Some(end as u64))));
        let region = &linear.data().frames[start..end];
        let expected: Vec<Frame> = region.iter().chain(region).chain(region).copied().collect();
        assert_eq!(first_difference(&feed(&mut feeder, expected.len()), &expected), None);
        assert_eq!(feeder.opens, 1, "every wrap was a seek");
    }

    /// A loop starting within the seek preroll, and any MP3 loop, reopens the file instead.
    #[test]
    fn a_loop_near_the_start_reopens_the_file() {
        let bytes = fixture();
        let linear = decode_sound(&bytes, "ogg").unwrap();
        let Music { kind: MusicKind::Streamed(file) } = Music::decode(&bytes, "ogg").unwrap() else { panic!("streamed") };
        let mut feeder = Feeder::new(file, 0, Some((4_800, Some(9_600))));
        let head = &linear.data().frames[..9_600];
        let region = &linear.data().frames[4_800..9_600];
        let expected: Vec<Frame> = head.iter().chain(region).copied().collect();
        assert_eq!(first_difference(&feed(&mut feeder, expected.len()), &expected), None);
        assert!(feeder.opens >= 2, "each wrap reopened the file: {} opens", feeder.opens);
    }
}
