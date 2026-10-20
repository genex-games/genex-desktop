//! Notifies and foot contacts crossed by a tick, in clip order.
//!
//! A notify is a named event at a time of a clip ("footstep" at 0.42 s of the walk). An
//! [`EventTable`] holds every notify of a character's clips, checked once. Each tick, every clip
//! that plays reports the [`Span`] of clip time it covered, and [`crossed`] fires the notifies
//! inside it in the order they were played. The crossing rule is ozz-animation's
//! `TrackTriggeringJob` (MIT) and Bevy's `animation_event.rs` (MIT OR Apache-2.0), ported as
//! rules, no code copied:
//!
//! - A span is half-open in the direction of play: forward it plays `[from, to)`, backward
//!   `(to, from]`. The point a tick ends on belongs to the next tick, so consecutive ticks never
//!   fire one notify twice, a direction reversal included.
//! - On a loop, the clip's end and start are one point: a notify at `0.0` (or at the clip's
//!   length) fires once per loop, never twice at the wrap. A tick that crosses the end plays the
//!   rest of this cycle, any whole cycles, then the start of the next, at most
//!   [`MAX_LAPS_PER_SPAN`] laps.
//! - A `once` clip that reaches the end it plays toward plays that end point too (an event at the
//!   last frame fires once), and fires nothing more while it holds there.
//! - [`Span::advance`] repeats the state machine's clip arithmetic (`time + delta`, wrapped by
//!   fmod), so a span's end is exactly the next tick's start.
//!
//! When several clips play at once (a crossfade, a blend space), [`collect`] keeps the events of
//! the clips its [`EventFilter`] passes: by default those at weight [`EVENT_THRESHOLD`] or more
//! (Fyrox's idea of filtering by weight, MIT).
//!
//! Events read only clip time, never a pose, so they are the same on every destination and with
//! the presenter's pose LOD on or off.
//!
//! [`foot_contacts`] finds where a clip's feet touch down: frames where the ankle is within a band
//! of its lowest height and barely moving vertically. [`EventTableBuilder::contacts`] turns them
//! into notifies. [`read_event_extras`] reads notifies authored in a GLB's animation extras
//! (`genex_events`); that key stays internal (not pinned) until an importer writes it.

use genex_core::json::{self, Value};
use glam::Mat4;

use crate::blend::BLEND_THRESHOLD;
use crate::clip::Clip;
use crate::error::AnimationError;
use crate::humanoid::{HumanoidBone, HumanoidMap};
use crate::ids::{ClipId, EventId, JointId};
use crate::import::open;
use crate::sample::{SampleCursor, Wrap, sample, wrap_time};
use crate::skeleton::Skeleton;

/// The weight a clip needs for its events to fire under the default filter (the blend
/// threshold, ozz's default).
pub const EVENT_THRESHOLD: f32 = BLEND_THRESHOLD;
/// Event names one table may declare.
pub const MAX_EVENTS: usize = 256;
/// Notifies one clip may carry.
pub const MAX_NOTIFIES_PER_CLIP: usize = 256;
/// The longest event name, in bytes.
pub const MAX_EVENT_NAME_BYTES: usize = 64;
/// Whole loops one span plays at most (a huge tick plays this many and then its end).
pub const MAX_LAPS_PER_SPAN: u32 = 8;
/// The glTF animation extras key notifies are authored under.
pub const EVENTS_EXTRAS_KEY: &str = "genex_events";
/// Frames [`foot_contacts`] samples a clip at by default, per second.
pub const DEFAULT_CONTACT_RATE: f32 = 60.0;
/// How far above its lowest height an ankle still counts as down, in metres.
pub const DEFAULT_HEIGHT_BAND: f32 = 0.03;
/// The fastest an ankle may move vertically and still count as down, in metres per second.
pub const DEFAULT_MAX_VERTICAL_SPEED: f32 = 0.2;
/// The fewest frames a contact lasts.
pub const DEFAULT_MIN_CONTACT_FRAMES: u32 = 2;
/// Frames [`foot_contacts`] samples at most, whatever the rate.
pub const MAX_CONTACT_FRAMES: usize = 4096;

/// One notify: an event at a clip time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Notify {
    /// Seconds into the clip, in `[0, duration]`.
    pub time: f32,
    /// The event.
    pub event: EventId,
}

/// Every notify of a character's clips, checked, sorted by time per clip.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EventTable {
    names: Vec<String>,
    clips: Vec<Vec<Notify>>,
}

impl EventTable {
    /// A builder over the clips the notifies belong to.
    pub fn builder(clips: &[Clip]) -> EventTableBuilder<'_> {
        EventTableBuilder { clips, names: Vec::new(), notifies: Vec::new() }
    }

    /// The event with this name.
    pub fn event(&self, name: &str) -> Option<EventId> {
        self.names.iter().position(|known| known == name).map(|index| EventId(index as u32))
    }

    /// An event's name; empty for an event of another table.
    pub fn name(&self, event: EventId) -> &str {
        self.names.get(event.raw() as usize).map_or("", String::as_str)
    }

    /// Event names, in declaration order.
    pub fn names(&self) -> impl ExactSizeIterator<Item = &str> + '_ {
        self.names.iter().map(String::as_str)
    }

    /// A clip's notifies by time (then declaration); empty for a clip with none.
    pub fn notifies(&self, clip: ClipId) -> &[Notify] {
        self.clips.get(clip.raw() as usize).map_or(&[], Vec::as_slice)
    }
}

/// Builds an [`EventTable`]; refusals wait for [`EventTableBuilder::build`].
#[derive(Debug)]
pub struct EventTableBuilder<'a> {
    clips: &'a [Clip],
    names: Vec<String>,
    notifies: Vec<(ClipId, Notify)>,
}

impl EventTableBuilder<'_> {
    /// The event called `name`, declared now unless it already is.
    pub fn event(&mut self, name: &str) -> EventId {
        if let Some(index) = self.names.iter().position(|known| known == name) {
            return EventId(index as u32);
        }
        self.names.push(name.to_owned());
        EventId((self.names.len() - 1) as u32)
    }

    /// `event` at `time` seconds of `clip`.
    pub fn at(&mut self, clip: ClipId, time: f32, event: EventId) -> &mut Self {
        self.notifies.push((clip, Notify { time, event }));
        self
    }

    /// For each contact of a foot in `events` (foot, event), that event at its touchdown.
    pub fn contacts(&mut self, clip: ClipId, contacts: &[FootContact], events: &[(JointId, EventId)]) -> &mut Self {
        for contact in contacts {
            for (foot, event) in events {
                if *foot == contact.foot {
                    self.at(clip, contact.start, *event);
                }
            }
        }
        self
    }

    /// Notifies read by [`read_event_extras`], on `clip`.
    pub fn authored(&mut self, clip: ClipId, authored: &[AuthoredNotify]) -> &mut Self {
        for notify in authored {
            let event = self.event(&notify.name);
            self.at(clip, notify.time, event);
        }
        self
    }

    /// The checked table. Refused `animation-graph-invalid`: more than [`MAX_EVENTS`] names, an
    /// empty name or one over [`MAX_EVENT_NAME_BYTES`], a clip or event of another table, a time
    /// that is not finite or lies outside its clip, one event at one time of one clip declared
    /// twice, or more than [`MAX_NOTIFIES_PER_CLIP`] on a clip.
    pub fn build(self) -> Result<EventTable, AnimationError> {
        self.check().map_err(AnimationError::graph_invalid)?;
        let mut clips = vec![Vec::new(); self.clips.len()];
        for (clip, notify) in self.notifies {
            clips[clip.raw() as usize].push(notify);
        }
        for notifies in &mut clips {
            notifies.sort_by(|a, b| a.time.total_cmp(&b.time));
        }
        Ok(EventTable { names: self.names, clips })
    }

    fn check(&self) -> Result<(), String> {
        if self.names.len() > MAX_EVENTS {
            return Err(format!("{} event names, more than {MAX_EVENTS}", self.names.len()));
        }
        if let Some(name) = self.names.iter().find(|name| name.is_empty() || name.len() > MAX_EVENT_NAME_BYTES) {
            return Err(format!("an event name of {} bytes (1 to {MAX_EVENT_NAME_BYTES})", name.len()));
        }
        let mut per_clip = vec![0_usize; self.clips.len()];
        for (index, (clip, notify)) in self.notifies.iter().enumerate() {
            let Some(owner) = self.clips.get(clip.raw() as usize) else {
                return Err(format!("clip {} is not one of the table's {} clips", clip.raw(), self.clips.len()));
            };
            if notify.event.raw() as usize >= self.names.len() {
                return Err(format!("event {} is not an event of this table", notify.event.raw()));
            }
            let inside = notify.time.is_finite() && notify.time >= 0.0 && notify.time <= owner.duration();
            if !inside {
                return Err(format!("{:?} at {} s lies outside clip {:?} (0 to {} s)", self.names[notify.event.raw() as usize], notify.time, owner.name(), owner.duration()));
            }
            let same = |(other_clip, other): &(ClipId, Notify)| other_clip == clip && other.event == notify.event && other.time.to_bits() == notify.time.to_bits();
            if self.notifies[..index].iter().any(same) {
                return Err(format!("{:?} at {} s of clip {:?} is declared twice", self.names[notify.event.raw() as usize], notify.time, owner.name()));
            }
            per_clip[clip.raw() as usize] += 1;
        }
        if let Some((clip, count)) = per_clip.iter().enumerate().find(|(_, count)| **count > MAX_NOTIFIES_PER_CLIP) {
            return Err(format!("clip {:?} carries {count} notifies, more than {MAX_NOTIFIES_PER_CLIP}", self.clips[clip].name()));
        }
        Ok(())
    }
}

/// The clip time one clip played over one tick; see the module docs for the rule.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Span {
    from: f32,
    to: f32,
    length: f32,
    /// Times the play crossed the end (forward) or the start (backward) of a loop.
    laps: u32,
    backwards: bool,
    looping: bool,
    /// A `once` clip reached the end it plays toward this tick, so that point is played.
    reaches_end: bool,
}

impl Span {
    /// A span that plays nothing, at `time`.
    fn still(time: f32, length: f32, looping: bool) -> Span {
        Span { from: time, to: time, length, laps: 0, backwards: false, looping, reaches_end: false }
    }

    /// Where a clip of `length` lands from `from` (wrapped into a loop, clamped into a `once`
    /// clip) after `delta` seconds of clip time (`dt × speed`, negative backwards), with the state
    /// machine's arithmetic. A NaN or infinite input (a non-finite start rests at 0), a zero
    /// `delta` or a clip of no length plays nothing; every end stays finite.
    pub fn advance(from: f32, delta: f32, length: f32, looping: bool) -> Span {
        if !(length.is_finite() && length > 0.0) {
            return Span::still(if from.is_finite() { from } else { 0.0 }, 0.0, looping);
        }
        if !from.is_finite() {
            return Span::still(0.0, length, looping);
        }
        let wrap = if looping { Wrap::Loop } else { Wrap::Clamp };
        let start = wrap_time(length, from, wrap);
        let raw = start + delta;
        if !delta.is_finite() || delta == 0.0 || !raw.is_finite() {
            return Span::still(start, length, looping);
        }
        let backwards = delta < 0.0;
        if !looping {
            let to = raw.clamp(0.0, length);
            let reaches_end = if backwards { raw <= 0.0 && start > 0.0 } else { raw >= length && start < length };
            return Span { from: start, to, length, laps: 0, backwards, looping, reaches_end };
        }
        // `rem_euclid` is fmod, exact on every destination (the machine's and the sampler's
        // rule); `+ 0.0` turns a negative zero positive.
        let wrapped = raw.rem_euclid(length) + 0.0;
        let to = if wrapped >= length { 0.0 } else { wrapped };
        let crossed = if backwards { raw < 0.0 } else { raw >= length };
        // `raw - to` is a whole number of lengths; rounding absorbs the division's error.
        let laps = if crossed { ((raw - to).abs() / length).round().clamp(1.0, MAX_LAPS_PER_SPAN as f32) as u32 } else { 0 };
        Span { from: start, to, length, laps, backwards, looping, reaches_end: false }
    }

    /// The span between two clip times read off a clip that played toward `to` (backward when
    /// `backwards`), taking at most one lap on a loop: forward, a `to` before `from` crossed the
    /// end once. On a `once` clip a `to` behind `from` plays nothing.
    pub fn between(from: f32, to: f32, length: f32, looping: bool, backwards: bool) -> Span {
        if !(length.is_finite() && length > 0.0) {
            return Span::still(0.0, 0.0, looping);
        }
        let wrap = if looping { Wrap::Loop } else { Wrap::Clamp };
        let (from, to) = (wrap_time(length, from, wrap), wrap_time(length, to, wrap));
        let behind = if backwards { to > from } else { to < from };
        if looping {
            return Span { from, to, length, laps: u32::from(behind), backwards, looping, reaches_end: false };
        }
        if behind {
            return Span::still(from, length, looping);
        }
        let reaches_end = if backwards { to <= 0.0 && from > 0.0 } else { to >= length && from < length };
        Span { from, to, length, laps: 0, backwards, looping, reaches_end }
    }

    /// Where the span starts.
    pub fn from(&self) -> f32 {
        self.from
    }

    /// Where it ends: the next tick's start.
    pub fn to(&self) -> f32 {
        self.to
    }

    /// Times it crossed a loop's end (or start, backwards).
    pub fn laps(&self) -> u32 {
        self.laps
    }

    /// It plays backwards.
    pub fn backwards(&self) -> bool {
        self.backwards
    }

    fn is_still(&self) -> bool {
        self.laps == 0 && self.from == self.to && !self.reaches_end
    }
}

/// A range of clip times with open or closed ends.
#[derive(Clone, Copy)]
struct Range {
    low: f32,
    low_closed: bool,
    high: f32,
    high_closed: bool,
}

impl Range {
    const fn new(low: f32, low_closed: bool, high: f32, high_closed: bool) -> Range {
        Range { low, low_closed, high, high_closed }
    }

    fn holds(self, time: f32) -> bool {
        let above = time > self.low || (self.low_closed && time == self.low);
        let below = time < self.high || (self.high_closed && time == self.high);
        above && below
    }
}

/// Fire the notifies inside `range`, ascending or descending. On a loop a notify at the clip's
/// length is the start point, played with the notifies at 0.
fn fire_range(notifies: &[Notify], length: f32, looping: bool, range: Range, descending: bool, fire: &mut impl FnMut(Notify)) {
    let at_start = looping && range.holds(0.0);
    let (wrapped, plain): (&[Notify], &[Notify]) = if looping {
        let split = notifies.partition_point(|notify| notify.time < length);
        (&notifies[split..], &notifies[..split])
    } else {
        (&[], notifies)
    };
    if !descending && at_start {
        wrapped.iter().copied().for_each(&mut *fire);
    }
    let inside = |notify: &&Notify| range.holds(notify.time);
    if descending {
        plain.iter().rev().filter(inside).copied().for_each(&mut *fire);
    } else {
        plain.iter().filter(inside).copied().for_each(&mut *fire);
    }
    if descending && at_start {
        wrapped.iter().rev().copied().for_each(&mut *fire);
    }
}

/// Fire each notify of one clip that `span` plays, in the order it plays them.
pub fn crossed(notifies: &[Notify], span: Span, mut fire: impl FnMut(Notify)) {
    if span.is_still() {
        return;
    }
    let Span { from, to, length, laps, backwards, looping, reaches_end } = span;
    let mut play = |range: Range| fire_range(notifies, length, looping, range, backwards, &mut fire);
    let whole = Range::new(0.0, true, length, false);
    match (backwards, laps) {
        (false, 0) => play(Range::new(from, true, to, reaches_end)),
        (true, 0) => play(Range::new(to, reaches_end, from, true)),
        (false, _) => {
            play(Range::new(from, true, length, false));
            (1..laps).for_each(|_| play(whole));
            play(Range::new(0.0, true, to, false));
        }
        (true, _) => {
            play(Range::new(0.0, true, from, true));
            (1..laps).for_each(|_| play(whole));
            play(Range::new(to, false, length, false));
        }
    }
}

/// Which playing clips' events fire.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EventFilter {
    /// Clips at this weight or more (the default, at [`EVENT_THRESHOLD`]).
    AtLeast(f32),
    /// Only the heaviest clip (the first of equals).
    Heaviest,
    /// Every clip, whatever its weight.
    All,
}

impl Default for EventFilter {
    fn default() -> EventFilter {
        EventFilter::AtLeast(EVENT_THRESHOLD)
    }
}

/// One clip that played this tick: what it covered and how much it counts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Played {
    /// The clip.
    pub clip: ClipId,
    /// The time it covered.
    pub span: Span,
    /// Its blend weight; NaN, negative or infinite counts as 0.
    pub weight: f32,
}

/// An event that fired.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fired {
    /// The event.
    pub event: EventId,
    /// The clip whose notify it was.
    pub clip: ClipId,
    /// The notify's clip time.
    pub time: f32,
    /// The clip's weight (after the NaN rule).
    pub weight: f32,
}

fn usable_weight(weight: f32) -> f32 {
    if weight.is_finite() && weight > 0.0 { weight } else { 0.0 }
}

/// Append to `out` the events `played` fire under `filter`: clip by clip in the order given, each
/// in the order it played them. Allocates only when `out` grows.
pub fn collect(table: &EventTable, played: &[Played], filter: EventFilter, out: &mut Vec<Fired>) {
    let heaviest = played.iter().enumerate().fold(None, |best: Option<(usize, f32)>, (index, entry)| {
        let weight = usable_weight(entry.weight);
        match best {
            Some((_, top)) if top >= weight => best,
            _ => Some((index, weight)),
        }
    });
    for (index, entry) in played.iter().enumerate() {
        let weight = usable_weight(entry.weight);
        let passes = match filter {
            EventFilter::AtLeast(threshold) => weight >= threshold && weight > 0.0,
            EventFilter::Heaviest => heaviest.is_some_and(|(top, _)| top == index),
            EventFilter::All => true,
        };
        if !passes {
            continue;
        }
        crossed(table.notifies(entry.clip), entry.span, |notify| out.push(Fired { event: notify.event, clip: entry.clip, time: notify.time, weight }));
    }
}

/// How [`foot_contacts`] decides a foot is down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContactRule {
    /// Frames sampled per second (at most [`MAX_CONTACT_FRAMES`] in all).
    pub rate: f32,
    /// How far above its lowest height the ankle still counts as down, in metres.
    pub height_band: f32,
    /// The fastest the ankle may move vertically and still count as down, in metres per second.
    pub max_vertical_speed: f32,
    /// The fewest frames a contact lasts.
    pub min_frames: u32,
}

impl Default for ContactRule {
    fn default() -> ContactRule {
        ContactRule { rate: DEFAULT_CONTACT_RATE, height_band: DEFAULT_HEIGHT_BAND, max_vertical_speed: DEFAULT_MAX_VERTICAL_SPEED, min_frames: DEFAULT_MIN_CONTACT_FRAMES }
    }
}

/// One stretch of a clip where a foot is down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FootContact {
    /// The foot (ankle) joint.
    pub foot: JointId,
    /// The touchdown, in clip seconds.
    pub start: f32,
    /// The last frame it is down; before `start` when the contact crosses a loop's end.
    pub end: f32,
}

/// A humanoid's left and right foot joints, when the rig maps them.
pub fn humanoid_feet(skeleton: &Skeleton) -> Option<[JointId; 2]> {
    let map = HumanoidMap::of(skeleton);
    Some([map.joint(HumanoidBone::LeftFoot)?, map.joint(HumanoidBone::RightFoot)?])
}

/// Each foot's model-space height (y) at every frame, one row per foot.
fn foot_heights(skeleton: &Skeleton, clip: &Clip, feet: &[JointId], frames: usize, step: f32) -> Vec<Vec<f32>> {
    let rest = skeleton.rest_pose();
    let mut pose = rest.to_vec();
    let mut model = vec![Mat4::IDENTITY; skeleton.joint_count()];
    let mut cursor = SampleCursor::new();
    let mut heights = vec![Vec::with_capacity(frames); feet.len()];
    for frame in 0..frames {
        pose.copy_from_slice(rest);
        sample(clip, frame as f32 * step, Wrap::Clamp, &mut cursor, &mut pose);
        skeleton.local_to_model(&pose, &mut model);
        for (row, foot) in heights.iter_mut().zip(feet) {
            row.push(model[usize::from(foot.raw())].w_axis.y);
        }
    }
    heights
}

/// Which frames of one foot's heights are down under `rule`.
fn down_frames(heights: &[f32], looping: bool, step: f32, rule: ContactRule) -> Vec<bool> {
    let band = if rule.height_band.is_finite() { rule.height_band.max(0.0) } else { 0.0 };
    let speed = if rule.max_vertical_speed.is_nan() { 0.0 } else { rule.max_vertical_speed.max(0.0) };
    let lowest = heights.iter().copied().fold(f32::INFINITY, f32::min);
    let count = heights.len();
    (0..count)
        .map(|frame| {
            // The forward difference: a touchdown frame is already still, the frame before it is
            // still falling.
            let (a, b) = match (frame + 1 < count, looping) {
                (true, _) => (frame, frame + 1),
                (false, true) => (frame, 0),
                (false, false) => (frame.saturating_sub(1), frame),
            };
            let vertical = (heights[b] - heights[a]).abs() / step;
            heights[frame] <= lowest + band && vertical <= speed
        })
        .collect()
}

/// Runs of down frames as (first, last) frame indices; on a loop a run may wrap (last < first).
fn runs(down: &[bool], looping: bool) -> Vec<(usize, usize)> {
    let count = down.len();
    if down.iter().all(|frame| *frame) {
        return vec![(0, count - 1)];
    }
    // Start scanning just after an up frame, so a loop's wrapping run is seen whole.
    let origin = if looping { down.iter().position(|frame| !*frame).map_or(0, |up| up + 1) } else { 0 };
    let mut out = Vec::new();
    let mut open: Option<usize> = None;
    for offset in 0..count {
        let frame = (origin + offset) % count;
        match (down[frame], open) {
            (true, None) => open = Some(frame),
            (false, Some(first)) => {
                out.push((first, (frame + count - 1) % count));
                open = None;
            }
            _ => {}
        }
    }
    if let Some(first) = open {
        out.push((first, (origin + count - 1) % count));
    }
    out
}

/// Where `feet` touch down in `clip`: each stretch of at least `rule.min_frames` frames where the
/// ankle is within `rule.height_band` of its lowest height in the clip and moves vertically no
/// faster than `rule.max_vertical_speed`, sampled at `rule.rate`. On a loop a stretch may cross
/// the end. Ordered by touchdown, then by the order of `feet`. A clip of no length, a foot past
/// the skeleton or a NaN rule answers fewer contacts, never a panic.
pub fn foot_contacts(skeleton: &Skeleton, clip: &Clip, feet: &[JointId], looping: bool, rule: ContactRule) -> Vec<FootContact> {
    let duration = clip.duration();
    let feet: Vec<JointId> = feet.iter().copied().filter(|foot| usize::from(foot.raw()) < skeleton.joint_count()).collect();
    if !(duration.is_finite() && duration > 0.0) || feet.is_empty() {
        return Vec::new();
    }
    let rate = if rule.rate.is_finite() && rule.rate > 0.0 { rule.rate } else { DEFAULT_CONTACT_RATE };
    let intervals = (duration * rate).round().clamp(1.0, MAX_CONTACT_FRAMES as f32) as usize;
    let step = duration / intervals as f32;
    let frames = if looping { intervals } else { intervals + 1 };
    let heights = foot_heights(skeleton, clip, &feet, frames, step);
    let min_frames = rule.min_frames.max(1) as usize;
    let mut contacts = Vec::new();
    for (foot, row) in feet.iter().zip(&heights) {
        for (first, last) in runs(&down_frames(row, looping, step, rule), looping) {
            let length = (last + frames - first) % frames + 1;
            if length >= min_frames {
                contacts.push(FootContact { foot: *foot, start: first as f32 * step, end: last as f32 * step });
            }
        }
    }
    contacts.sort_by(|a, b| a.start.total_cmp(&b.start));
    contacts
}

/// One notify as a GLB authors it: an event name and a clip time.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthoredNotify {
    /// The event's name.
    pub name: String,
    /// Seconds into the clip.
    pub time: f32,
}

/// The notifies each animation of a GLB authors under its extras' `genex_events` key (a list of
/// `{"name", "time"}`), one list per animation in file order (the clip order of
/// [`crate::clip::import_clips`]). Internal: the key is read but not pinned until an importer
/// writes it. Refused `animation-asset-invalid`: anything the rig importer refuses in the
/// container, extras that are not JSON, a `genex_events` that is not a list, an entry without a
/// text name and a finite, non-negative time, or more than [`MAX_NOTIFIES_PER_CLIP`] entries. A
/// time past its clip reads, and [`EventTableBuilder::build`] refuses it.
pub fn read_event_extras(bytes: &[u8]) -> Result<Vec<Vec<AuthoredNotify>>, AnimationError> {
    let gltf = open(bytes)?;
    let mut out = Vec::new();
    for (index, animation) in gltf.document.as_json().animations.iter().enumerate() {
        let Some(raw) = &animation.extras else {
            out.push(Vec::new());
            continue;
        };
        let extras = json::parse(raw.get().as_bytes()).map_err(|error| AnimationError::asset_invalid(format!("animation {index}'s extras: {error:?}")))?;
        out.push(authored(&extras).map_err(|detail| AnimationError::asset_invalid(format!("animation {index}'s {EVENTS_EXTRAS_KEY}: {detail}")))?);
    }
    Ok(out)
}

fn authored(extras: &Value) -> Result<Vec<AuthoredNotify>, String> {
    let Some(list) = extras.get(EVENTS_EXTRAS_KEY) else { return Ok(Vec::new()) };
    let Value::Array(entries) = list else { return Err("not a list".to_owned()) };
    if entries.len() > MAX_NOTIFIES_PER_CLIP {
        return Err(format!("{} entries, more than {MAX_NOTIFIES_PER_CLIP}", entries.len()));
    }
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let Some(Value::String(name)) = entry.get("name") else { return Err(format!("entry {index} has no text name")) };
            let name = String::from_utf8(name.clone()).map_err(|_| format!("entry {index}'s name is not UTF-8"))?;
            let Some(Value::Number(time)) = entry.get("time") else { return Err(format!("entry {index} has no time")) };
            let time = *time as f32;
            if !time.is_finite() || time < 0.0 {
                return Err(format!("entry {index}'s time {time} is not a finite, non-negative number"));
            }
            Ok(AuthoredNotify { name, time })
        })
        .collect()
}
