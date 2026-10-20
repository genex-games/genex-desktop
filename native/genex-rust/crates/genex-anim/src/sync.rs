//! Phase sync between the clips of a blend.
//!
//! Clips of different lengths blended together (walk 1.0 s with run 0.7 s) slide their feet
//! unless they play in step. A [`SyncGroup`] gives every clip of a blend one shared phase:
//!
//! - [`SyncMode::Normalized`] (Godot's `Sync`, Unity's blend-tree rule): every clip is at the same
//!   fraction of its cycle, and the cycle lasts the weighted mean of the clips' lengths.
//! - [`SyncMode::Markers`]: sync markers, as bevy_animation_graph's sync tracks and Unreal's sync
//!   markers do (ideas only, no code taken). Each clip carries a [`SyncTrack`] of marker
//!   fractions, usually its foot touchdowns ([`SyncTrack::from_contacts`]). The phase counts
//!   marker segments: between two markers every clip is at the same fraction of its own segment,
//!   and each segment lasts the weighted mean of the clips' segments. Footsteps that sit at
//!   different fractions of their cycles still land together. A group whose clips do not all
//!   carry the same number of markers plays normalized.
//! - [`SyncMode::Off`]: each clip keeps its own clock.
//!
//! [`SyncGroup::advance`] writes each clip's [`Span`] for the tick, so the events of a synced
//! blend fire from the times the clips actually play. Spans chain exactly: each clip's time is
//! computed from the phase, never accumulated, and a tick covers at most one lap of a clip. Plain
//! f32 arithmetic in a fixed order, no allocation once the group exists.

use crate::error::AnimationError;
use crate::events::{FootContact, Notify, Span};
use crate::ids::EventId;
use crate::sample::{Wrap, wrap_time};

/// Markers one sync track may carry.
pub const MAX_SYNC_MARKERS: usize = 64;
/// Marker segments one advance may cross (a huge tick stops after this many).
const MAX_SEGMENT_STEPS: usize = 4 * MAX_SYNC_MARKERS;

/// A clip's sync markers: fractions of its cycle in `[0, 1)`, ascending.
#[derive(Clone, Debug, PartialEq)]
pub struct SyncTrack {
    markers: Vec<f32>,
}

impl SyncTrack {
    /// Markers at these cycle fractions. Refused `animation-graph-invalid`: none, more than
    /// [`MAX_SYNC_MARKERS`], one that is not finite or outside `[0, 1)`, or two out of order or
    /// equal.
    pub fn new(markers: &[f32]) -> Result<SyncTrack, AnimationError> {
        if markers.is_empty() || markers.len() > MAX_SYNC_MARKERS {
            return Err(AnimationError::graph_invalid(format!("a sync track of {} markers (1 to {MAX_SYNC_MARKERS})", markers.len())));
        }
        if let Some(marker) = markers.iter().find(|marker| !(**marker >= 0.0 && **marker < 1.0)) {
            return Err(AnimationError::graph_invalid(format!("a sync marker at {marker}, outside [0, 1)")));
        }
        if markers.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(AnimationError::graph_invalid("sync markers out of order or repeated"));
        }
        Ok(SyncTrack { markers: markers.to_vec() })
    }

    /// Markers at the touchdowns of `contacts` in a clip of `duration` seconds.
    pub fn from_contacts(contacts: &[FootContact], duration: f32) -> Result<SyncTrack, AnimationError> {
        SyncTrack::from_times(contacts.iter().map(|contact| contact.start), duration)
    }

    /// Markers at the notifies of `events` in a clip of `duration` seconds.
    pub fn from_notifies(notifies: &[Notify], events: &[EventId], duration: f32) -> Result<SyncTrack, AnimationError> {
        SyncTrack::from_times(notifies.iter().filter(|notify| events.contains(&notify.event)).map(|notify| notify.time), duration)
    }

    fn from_times(times: impl Iterator<Item = f32>, duration: f32) -> Result<SyncTrack, AnimationError> {
        if !(duration.is_finite() && duration > 0.0) {
            return Err(AnimationError::graph_invalid(format!("a sync track for a clip of {duration} s")));
        }
        let mut markers: Vec<f32> = times.map(|time| wrap_time(duration, time, Wrap::Loop) / duration).map(|marker| if marker >= 1.0 { 0.0 } else { marker }).collect();
        markers.sort_by(f32::total_cmp);
        markers.dedup();
        SyncTrack::new(&markers)
    }

    /// The markers.
    pub fn markers(&self) -> &[f32] {
        &self.markers
    }

    /// Where segment `segment` starts and ends, as cycle fractions (the last segment ends past 1,
    /// at the first marker of the next cycle).
    fn segment(&self, segment: usize) -> (f32, f32) {
        let count = self.markers.len();
        let start = self.markers[segment % count];
        let end = if segment + 1 < count { self.markers[segment + 1] } else { self.markers[0] + 1.0 };
        (start, end)
    }
}

/// How the clips of a blend keep in step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SyncMode {
    /// Each clip keeps its own clock.
    Off,
    /// Every clip at the same fraction of its cycle.
    Normalized,
    /// Every clip at the same fraction of the same marker segment.
    Markers,
}

/// One clip of a synced blend.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SyncClip<'a> {
    /// Its length in seconds.
    pub duration: f32,
    /// Its blend weight this tick; NaN, negative or infinite counts as 0, and a group whose
    /// weights are all 0 weighs its clips equally.
    pub weight: f32,
    /// Its markers, for [`SyncMode::Markers`].
    pub markers: Option<&'a SyncTrack>,
}

/// The shared phase of a blend's clips; see the module docs.
#[derive(Clone, Debug, PartialEq)]
pub struct SyncGroup {
    mode: SyncMode,
    /// Marker segments played, in `[0, segments)` (normalized: the cycle fraction).
    phase: f32,
    segments: usize,
    /// Each clip's time after the last advance (its own clock for [`SyncMode::Off`]).
    free: Vec<f32>,
}

impl SyncGroup {
    /// A group over `clips` at the start of its first marker (time 0 when normalized or off).
    /// [`SyncMode::Markers`] plays normalized unless every clip carries a track of one marker
    /// count.
    pub fn new(mode: SyncMode, clips: &[SyncClip<'_>]) -> SyncGroup {
        let counts = clips.iter().map(|clip| clip.markers.map(|track| track.markers.len()));
        let shared = counts.clone().next().flatten().filter(|first| counts.clone().all(|count| count == Some(*first)));
        let (mode, segments) = match (mode, shared) {
            (SyncMode::Markers, Some(count)) => (SyncMode::Markers, count),
            (SyncMode::Off, _) => (SyncMode::Off, 1),
            _ => (SyncMode::Normalized, 1),
        };
        let mut group = SyncGroup { mode, phase: 0.0, segments, free: vec![0.0; clips.len()] };
        for index in 0..clips.len() {
            group.free[index] = group.time(clips, index);
        }
        group
    }

    /// The mode it plays (Markers may have fallen back to Normalized).
    pub fn mode(&self) -> SyncMode {
        self.mode
    }

    /// The phase: marker segments played, or the cycle fraction when normalized.
    pub fn phase(&self) -> f32 {
        self.phase
    }

    /// Clip `index`'s time now, in seconds (0 for an index past the group).
    pub fn time(&self, clips: &[SyncClip<'_>], index: usize) -> f32 {
        let Some(clip) = clips.get(index) else { return 0.0 };
        if self.mode == SyncMode::Off {
            return self.free.get(index).copied().unwrap_or(0.0);
        }
        let segment = (self.phase as usize).min(self.segments - 1);
        let fraction = self.phase - segment as f32;
        let (start, end) = self.segment_of(clip, segment);
        wrap_time(clip.duration, (start + fraction * (end - start)) * clip.duration, Wrap::Loop)
    }

    /// Advance by `dt` seconds of play (negative plays backwards) under `clips`' weights, and
    /// write each clip's span into `spans` (as far as both reach). A NaN, infinite or zero `dt`
    /// does not move the group.
    pub fn advance(&mut self, dt: f32, clips: &[SyncClip<'_>], spans: &mut [Span]) {
        let moving = dt.is_finite() && dt != 0.0;
        if self.mode == SyncMode::Off {
            for (index, (clip, span)) in clips.iter().zip(spans.iter_mut()).enumerate() {
                let Some(time) = self.free.get_mut(index) else { break };
                *span = Span::advance(*time, if moving { dt } else { 0.0 }, clip.duration, true);
                *time = span.to();
            }
            return;
        }
        if moving {
            self.move_phase(dt, clips);
        }
        for (index, (clip, span)) in clips.iter().zip(spans.iter_mut()).enumerate() {
            let to = self.time(clips, index);
            let Some(from) = self.free.get_mut(index) else { break };
            *span = Span::between(*from, to, clip.duration, true, dt < 0.0);
            *from = to;
        }
    }

    /// A clip's segment `segment` as cycle fractions: its markers' segment, or the whole cycle.
    fn segment_of(&self, clip: &SyncClip<'_>, segment: usize) -> (f32, f32) {
        match (self.mode, clip.markers) {
            (SyncMode::Markers, Some(track)) => track.segment(segment),
            _ => (0.0, 1.0),
        }
    }

    /// How long segment `segment` lasts under the clips' weights: the weighted mean of each clip's
    /// own segment in seconds.
    fn segment_seconds(&self, clips: &[SyncClip<'_>], segment: usize) -> f32 {
        let weight = |clip: &SyncClip<'_>| if clip.weight.is_finite() && clip.weight > 0.0 { clip.weight } else { 0.0 };
        let total: f32 = clips.iter().map(weight).sum();
        let mut seconds = 0.0;
        for clip in clips {
            let share = if total > 0.0 { weight(clip) / total } else { 1.0 / clips.len() as f32 };
            let (start, end) = self.segment_of(clip, segment);
            let length = if clip.duration.is_finite() && clip.duration > 0.0 { clip.duration } else { 0.0 };
            seconds += share * length * (end - start);
        }
        seconds
    }

    fn move_phase(&mut self, dt: f32, clips: &[SyncClip<'_>]) {
        let segments = self.segments as f32;
        let mut remaining = dt;
        for _ in 0..MAX_SEGMENT_STEPS {
            if remaining == 0.0 {
                break;
            }
            let forward = remaining > 0.0;
            // The segment being played: backward from a segment's start plays the one before it.
            let base = self.phase.floor();
            let segment = if !forward && self.phase == base { (base as usize + self.segments - 1) % self.segments } else { base as usize % self.segments };
            let seconds = self.segment_seconds(clips, segment);
            if seconds.is_nan() || seconds <= 0.0 {
                break;
            }
            let start = if !forward && self.phase == base { segment as f32 + 1.0 } else { self.phase };
            let fraction = start - segment as f32;
            let left = if forward { (1.0 - fraction) * seconds } else { fraction * seconds };
            if remaining.abs() < left {
                self.phase = segment as f32 + fraction + remaining / seconds;
                break;
            }
            remaining -= if forward { left } else { -left };
            self.phase = if forward { (segment as f32 + 1.0) % segments } else { segment as f32 };
        }
        if !(self.phase >= 0.0 && self.phase < segments) {
            self.phase = self.phase.rem_euclid(segments) + 0.0;
            if self.phase >= segments {
                self.phase = 0.0;
            }
        }
    }
}
