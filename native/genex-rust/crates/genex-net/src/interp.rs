//! A sim-time port of genex-multiplayer's §10 interpolator over libm: smoothed states for drawing.
//!
//! Ported from genex-multiplayer `src/interp.rs` and `src/pose.rs` (MIT, first party, vendored at
//! `crates/genex-multiplayer`). Remote streams are drawn slightly in the past, interpolated on the
//! sender's clock: a per-sender clock offset (the window minimum of arrival minus send), an adaptive
//! render delay, numbers lerped, 4-element quaternions slerped, discrete fields held, then an
//! output ease. What changed in the port, and why:
//!
//! - Time is sim time. A sample is stamped with the tick it was sent on and arrives on the tick that
//!   consumed it; [`tick_ms`] turns a tick into milliseconds, so every constant keeps its unit.
//! - Every transcendental is libm's (`exp`, `sin`, `acos`, `sqrt`, `round`, `fmod`) and the keyed
//!   tables are ordered, so a Loopback or scripted run is bit-equal on aarch64, x86_64 and wasm32.
//! - A stamp of 0 is a real tick here (the first one), so only a non-finite stamp is refused; the
//!   upstream crate also refuses 0, which marks an unstamped relay sample.
//! - The starting render delay is the game's `interp_delay_ticks` (6 ticks is upstream's 100 ms).
//!
//! `tests/interp.rs` holds the port to the vendored crate within 1e-6 on every recorded stream in
//! `tests/fixtures/interp/` (written by the ignored `tests/interp_oracle_dump.rs`).

use std::collections::{BTreeMap, VecDeque};

use serde_json::{Map, Value};

use crate::vocab::{NET_INTERP_DELAY_TICKS_DEFAULT, NET_TICK_HZ};

/// A stream's sample: a JSON object (the protocol's state representation).
pub type State = Map<String, Value>;

/// The §10 tuning constants, restated from genex-multiplayer `protocol::interpolation` (tests hold
/// them equal).
pub mod params {
    /// Render delay target: this many median publish gaps.
    pub const RATIO: f64 = 1.5;
    /// Render delay target: at least this much of the 90th-percentile jitter.
    pub const JITTER_SAFETY: f64 = 1.25;
    /// The shortest render delay.
    pub const MIN_MS: f64 = 90.0;
    /// The longest render delay.
    pub const MAX_MS: f64 = 300.0;
    /// Upstream's starting render delay (six ticks).
    pub const DEFAULT_MS: f64 = 100.0;
    /// How far the delay moves toward its target per sample.
    pub const EASE: f64 = 0.1;
    /// Samples a sender's clock window keeps at least.
    pub const CLOCK_WINDOW: usize = 80;
    /// How long a sender's clock window reaches back.
    pub const CLOCK_WINDOW_MS: f64 = 5000.0;
    /// Samples a sender's clock window keeps at most.
    pub const CLOCK_WINDOW_MAX: usize = 4096;
    /// Publish gaps the delay target takes the median of.
    pub const INTERVAL_WINDOW: usize = 30;
    /// A gap at or below this is not a publish gap.
    pub const MIN_GAP_MS: f64 = 5.0;
    /// A gap at or above this is an outage, not a publish gap.
    pub const MAX_GAP_MS: f64 = 2000.0;
    /// How much history a stream keeps.
    pub const HISTORY_MS: f64 = 1500.0;
    /// The furthest numbers extrapolate past the newest sample.
    pub const MAX_EXTRAP_MS: f64 = 250.0;
    /// The furthest rotations extrapolate past the newest sample.
    pub const ROT_EXTRAP_MS: f64 = 150.0;
    /// The output ease's time constant for numbers.
    pub const SMOOTH_TAU_POS_MS: f64 = 30.0;
    /// The output ease's time constant for rotations.
    pub const SMOOTH_TAU_ROT_MS: f64 = 70.0;
    /// A head sample this far ahead of the tail was stamped on a foreign clock.
    pub const POISON_GUARD_MS: f64 = 2000.0;
    /// The longest step the output ease takes at once.
    pub const MAX_HOST_TICK_DT_MS: f64 = 250.0;
    /// The jitter term applies once a stream holds this many (arrival − send) values.
    pub const JITTER_MIN_SAMPLES: usize = 8;
}

use params as ip;

/// The posed stream's numeric keys (§6.6), in schema order.
const NUMERIC_POSE_KEYS: [&str; 7] = ["x", "y", "z", "yaw", "vx", "vy", "vz"];
/// Each position axis and the velocity that dead-reckons it.
const AXES: [(&str, &str); 3] = [("x", "vx"), ("y", "vy"), ("z", "vz")];
/// The median of no gaps (upstream's fallback).
const EMPTY_MEDIAN_MS: f64 = 66.0;
/// A quaternion this close to its target lerps instead of slerping.
const SLERP_LERP_DOT: f64 = 0.9995;

/// Milliseconds of sim time at the start of `tick` (the runtime's fixed 60 Hz step).
pub fn tick_ms(tick: u64) -> f64 {
    tick as f64 * 1000.0 / f64::from(NET_TICK_HZ)
}

#[derive(Clone, Debug, Default)]
struct SenderClock {
    /// (arrival, sample number) of every kept sample, oldest first.
    samples: VecDeque<(f64, u64)>,
    /// Monotonic deque of (arrival − send, sample number): front is the window minimum.
    mins: VecDeque<(f64, u64)>,
    n: u64,
}

impl SenderClock {
    fn push(&mut self, sample: f64, arrival: f64) -> f64 {
        self.n += 1;
        let n = self.n;
        self.samples.push_back((arrival, n));
        while self.mins.back().is_some_and(|(v, _)| *v >= sample) {
            self.mins.pop_back();
        }
        self.mins.push_back((sample, n));
        // Evict only what is BOTH older than CLOCK_WINDOW_MS and beyond the last CLOCK_WINDOW samples.
        while self.should_evict(arrival) {
            self.samples.pop_front();
        }
        let first_kept = self.samples.front().map_or(n, |(_, k)| *k);
        while self.mins.front().is_some_and(|(_, k)| *k < first_kept) {
            self.mins.pop_front();
        }
        self.offset()
    }

    fn should_evict(&self, arrival: f64) -> bool {
        let over_max = self.samples.len() > ip::CLOCK_WINDOW_MAX;
        let front_stale = self.samples.front().is_some_and(|(at, _)| *at < arrival - ip::CLOCK_WINDOW_MS);
        over_max || (self.samples.len() > ip::CLOCK_WINDOW && front_stale)
    }

    fn offset(&self) -> f64 {
        self.mins.front().map_or(0.0, |(v, _)| *v)
    }
}

#[derive(Clone, Debug)]
struct Stream {
    sender: Option<String>,
    buf: VecDeque<(f64, State)>,
    last_stamp: Option<f64>,
    gaps: VecDeque<f64>,
    jitter: VecDeque<f64>,
    delay: f64,
    smoothed: Option<State>,
    smoothed_at: f64,
    /// Set by a soft handoff: seed the next sample's predecessor with the on-screen pose.
    bridge: bool,
    posed: bool,
}

impl Stream {
    fn new(delay: f64) -> Stream {
        Stream {
            sender: None,
            buf: VecDeque::new(),
            last_stamp: None,
            gaps: VecDeque::new(),
            jitter: VecDeque::new(),
            delay,
            smoothed: None,
            smoothed_at: 0.0,
            bridge: false,
            posed: false,
        }
    }

    /// Drop the clock-domain state: buffer, gaps, jitter, delay, sender.
    fn reset_clock(&mut self, delay: f64) {
        self.sender = None;
        self.buf.clear();
        self.last_stamp = None;
        self.gaps.clear();
        self.jitter.clear();
        self.delay = delay;
        self.bridge = false;
    }

    /// Ease the render delay toward its target after a publish gap of `gap`.
    fn adapt_delay(&mut self, gap: f64, offset: f64) {
        self.gaps.push_back(gap);
        if self.gaps.len() > ip::INTERVAL_WINDOW {
            self.gaps.pop_front();
        }
        let jitter = if self.jitter.len() >= ip::JITTER_MIN_SAMPLES { (quantile(self.jitter.iter().copied(), 0.9) - offset).max(0.0) } else { 0.0 };
        let target = (ip::RATIO * median(self.gaps.iter().copied())).max(ip::JITTER_SAFETY * jitter).clamp(ip::MIN_MS, ip::MAX_MS);
        self.delay += (target - self.delay) * ip::EASE;
    }

    /// Append a sample, then trim history and any head stamped on a foreign clock.
    fn buffer(&mut self, s: f64, state: State) {
        if self.bridge
            && self.buf.is_empty()
            && let Some(pose) = self.smoothed.clone()
        {
            self.buf.push_back((s - self.delay.max(1.0), pose));
        }
        self.bridge = false;
        self.buf.push_back((s, state));
        let cutoff = s - ip::HISTORY_MS;
        while self.buf.len() > 2 && self.buf.front().is_some_and(|(t, _)| *t < cutoff) {
            self.buf.pop_front();
        }
        while self.buf.len() > 1 && self.head_is_foreign() {
            self.buf.pop_front();
        }
    }

    fn head_is_foreign(&self) -> bool {
        let head = self.buf.front().map_or(0.0, |(t, _)| *t);
        let tail = self.buf.back().map_or(0.0, |(t, _)| *t);
        head > tail + ip::POISON_GUARD_MS
    }
}

/// The interpolation engine for every remote stream of one seat, in sim time.
///
/// A stream is one remote player (keyed by its id) or one object (`obj:<id>`); clock offsets belong
/// to the sender, so all of one sender's streams share one estimate.
#[derive(Clone, Debug)]
pub struct Interpolator {
    senders: BTreeMap<String, SenderClock>,
    streams: BTreeMap<String, Stream>,
    default_delay: f64,
}

impl Default for Interpolator {
    fn default() -> Interpolator {
        Interpolator::new()
    }
}

impl Interpolator {
    /// An empty engine starting each stream at the default delay (six ticks, upstream's 100 ms).
    pub fn new() -> Interpolator {
        Interpolator::with_delay_ticks(NET_INTERP_DELAY_TICKS_DEFAULT)
    }

    /// An empty engine starting each stream `ticks` behind (`NetConfig::interp_delay_ticks`).
    pub fn with_delay_ticks(ticks: u32) -> Interpolator {
        Interpolator { senders: BTreeMap::new(), streams: BTreeMap::new(), default_delay: tick_ms(u64::from(ticks)) }
    }

    fn stream_mut(&mut self, stream: &str) -> &mut Stream {
        let delay = self.default_delay;
        self.streams.entry(stream.to_owned()).or_insert_with(|| Stream::new(delay))
    }

    /// Mark a stream as a posed player (§10.1) or a JSON stream (§10). Switching drops its history.
    pub fn set_posed(&mut self, stream: &str, posed: bool) {
        let delay = self.default_delay;
        let st = self.stream_mut(stream);
        if st.posed != posed {
            st.reset_clock(delay);
            st.smoothed = None;
            st.posed = posed;
        }
    }

    /// Feed `state`, sent by `sender` on tick `sent_tick`, consumed on tick `arrival_tick`.
    pub fn push(&mut self, stream: &str, sender: &str, sent_tick: u64, state: State, arrival_tick: u64) {
        self.push_ms(stream, sender, tick_ms(sent_tick), state, tick_ms(arrival_tick));
    }

    /// Feed one sample `(s, state)` stamped on `sender`'s clock, arriving at `arrival` (both ms).
    pub fn push_ms(&mut self, stream: &str, sender: &str, s: f64, state: State, arrival: f64) {
        if !s.is_finite() {
            return;
        }
        let sample = arrival - s;
        let offset = self.senders.entry(sender.to_owned()).or_default().push(sample, arrival);
        let st = self.stream_mut(stream);
        st.jitter.push_back(sample);
        if st.jitter.len() > ip::CLOCK_WINDOW {
            st.jitter.pop_front();
        }
        st.sender = Some(sender.to_owned());
        if let Some(prev) = st.last_stamp {
            let gap = s - prev;
            if gap > ip::MIN_GAP_MS && gap < ip::MAX_GAP_MS {
                st.adapt_delay(gap, offset);
            }
        }
        st.last_stamp = Some(s);
        st.buffer(s, state);
    }

    /// The render time of a stream at tick `now_tick`, or `None` before it has a sample.
    pub fn render_time(&self, stream: &str, now_tick: u64) -> Option<f64> {
        self.render_time_ms(stream, tick_ms(now_tick))
    }

    /// The render time of a stream at `now` (ms), or `None` before it has a sample.
    pub fn render_time_ms(&self, stream: &str, now: f64) -> Option<f64> {
        let st = self.streams.get(stream)?;
        let offset = self.senders.get(st.sender.as_deref()?)?.offset();
        Some(now - offset - st.delay)
    }

    /// Sample a stream at tick `now_tick`: interpolate on the sender's clock, then output-ease.
    pub fn sample(&mut self, stream: &str, now_tick: u64) -> Option<State> {
        self.sample_ms(stream, tick_ms(now_tick))
    }

    /// Sample a stream at `now` (ms). `None` until the stream has a sample (or a held pose).
    pub fn sample_ms(&mut self, stream: &str, now: f64) -> Option<State> {
        let r = self.render_time_ms(stream, now).unwrap_or(now - self.default_delay);
        let st = self.streams.get_mut(stream)?;
        let sampled = if st.posed {
            let view: Vec<(f64, &State)> = st.buf.iter().map(|(t, s)| (*t, s)).collect();
            sample_pose(&view, r)
        } else {
            sample_buffer(&st.buf, r)
        };
        let Some(sampled) = sampled else {
            return st.smoothed.clone();
        };
        let out = match &st.smoothed {
            Some(prev) => {
                let dt = (now - st.smoothed_at).clamp(0.0, ip::MAX_HOST_TICK_DT_MS);
                let a_pos = 1.0 - libm::exp(-dt / ip::SMOOTH_TAU_POS_MS);
                let a_rot = 1.0 - libm::exp(-dt / ip::SMOOTH_TAU_ROT_MS);
                if st.posed { ease_pose(prev, &sampled, a_pos, a_rot) } else { ease_state(prev, &sampled, a_pos, a_rot) }
            }
            None => sampled,
        };
        st.smoothed = Some(out.clone());
        st.smoothed_at = now;
        Some(out)
    }

    /// The newest raw sample of a stream (what game logic reads, §10 step 7).
    pub fn latest(&self, stream: &str) -> Option<&State> {
        self.streams.get(stream)?.buf.back().map(|(_, s)| s)
    }

    /// The stream's current render delay (ms).
    pub fn delay(&self, stream: &str) -> Option<f64> {
        self.streams.get(stream).map(|s| s.delay)
    }

    /// The sender's current clock offset estimate (min of arrival − send, ms), if any.
    pub fn sender_offset(&self, sender: &str) -> Option<f64> {
        self.senders.get(sender).map(SenderClock::offset)
    }

    /// An `epoch` change: drop all of the stream's history; the next sample places it (§10 step 6).
    pub fn reset_epoch(&mut self, stream: &str) {
        let delay = self.default_delay;
        if let Some(st) = self.streams.get_mut(stream) {
            st.reset_clock(delay);
            st.smoothed = None;
        }
    }

    /// An ownership change: the soft handoff of §10 step 6. Keeps the eased pose and seeds it as a
    /// bridge sample before the new owner's first sample.
    pub fn soft_handoff(&mut self, stream: &str) {
        let delay = self.default_delay;
        if let Some(st) = self.streams.get_mut(stream) {
            st.reset_clock(delay);
            st.bridge = st.smoothed.is_some();
        }
    }

    /// Hold `state` as the stream's on-screen pose at tick `now_tick`, so a following soft handoff
    /// glides from it.
    pub fn hold(&mut self, stream: &str, state: State, now_tick: u64) {
        self.hold_ms(stream, state, tick_ms(now_tick));
    }

    /// Hold `state` as the stream's on-screen pose at `now` (ms).
    pub fn hold_ms(&mut self, stream: &str, state: State, now: f64) {
        let st = self.stream_mut(stream);
        st.smoothed = Some(state);
        st.smoothed_at = now;
    }

    /// True teardown: a player left or an object was removed.
    pub fn remove_stream(&mut self, stream: &str) {
        self.streams.remove(stream);
    }

    /// A sender's seat is gone: drop its clock estimate.
    pub fn remove_sender(&mut self, sender: &str) {
        self.senders.remove(sender);
    }

    /// One deliberate rebase after a long outage (§8 step 2): every stream and every sender clock.
    pub fn rebase_all(&mut self) {
        self.streams.clear();
        self.senders.clear();
    }

    /// Whether no stream is held.
    pub fn is_empty(&self) -> bool {
        self.streams.is_empty()
    }
}

fn sorted(xs: impl Iterator<Item = f64>) -> Vec<f64> {
    let mut v: Vec<f64> = xs.collect();
    v.sort_by(f64::total_cmp);
    v
}

fn median(xs: impl Iterator<Item = f64>) -> f64 {
    let s = sorted(xs);
    if s.is_empty() {
        return EMPTY_MEDIAN_MS;
    }
    s[s.len() / 2]
}

/// Nearest-rank quantile (0..1).
fn quantile(xs: impl Iterator<Item = f64>, q: f64) -> f64 {
    let s = sorted(xs);
    if s.is_empty() {
        return 0.0;
    }
    let i = (libm::round(q * (s.len() - 1) as f64) as usize).min(s.len() - 1);
    s[i]
}

fn as_quat(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let mut q = [0.0; 4];
    for (slot, x) in q.iter_mut().zip(a) {
        *slot = x.as_f64().filter(|f| f.is_finite())?;
    }
    Some(q)
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.is_finite())
}

/// Quaternion slerp along the shortest arc; `t > 1` extrapolates along the same arc.
pub fn slerp(a: [f64; 4], b: [f64; 4], t: f64) -> [f64; 4] {
    let [ax, ay, az, aw] = a;
    let [mut bx, mut by, mut bz, mut bw] = b;
    let mut dot = ax * bx + ay * by + az * bz + aw * bw;
    if dot < 0.0 {
        (bx, by, bz, bw, dot) = (-bx, -by, -bz, -bw, -dot);
    }
    if dot > SLERP_LERP_DOT {
        let q = [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, aw + (bw - aw) * t];
        let l = libm::sqrt(q.iter().map(|c| c * c).sum::<f64>());
        let l = if l == 0.0 { 1.0 } else { l };
        return q.map(|c| c / l);
    }
    let theta0 = libm::acos(dot);
    let sin0 = libm::sin(theta0);
    let s0 = libm::sin(theta0 - theta0 * t) / sin0;
    let s1 = libm::sin(theta0 * t) / sin0;
    [ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1]
}

fn quat_value(q: [f64; 4]) -> Value {
    Value::from(q.to_vec())
}

/// Blend `a → b`: finite numbers lerp by `t_num`, quaternions slerp by `t_quat`, every other value
/// keeps the OLDER snapshot while interpolating (`t_num < 1`) and the newer once extrapolating.
fn blend(a: &State, b: &State, t_num: f64, t_quat: f64) -> State {
    let interpolating = t_num < 1.0;
    let mut out = Map::new();
    for (k, bv) in b {
        let av = a.get(k);
        let v = if let (Some(x), Some(y)) = (av.and_then(finite), finite(bv)) {
            Value::from(x + (y - x) * t_num)
        } else if let (Some(qa), Some(qb)) = (av.and_then(as_quat), as_quat(bv)) {
            quat_value(slerp(qa, qb, t_quat))
        } else {
            match av {
                Some(av) if interpolating => av.clone(),
                _ => bv.clone(),
            }
        };
        out.insert(k.clone(), v);
    }
    out
}

/// §10 step 4: sample a JSON stream's buffer at render time `r`.
fn sample_buffer(buf: &VecDeque<(f64, State)>, r: f64) -> Option<State> {
    let n = buf.len();
    match n {
        0 => return None,
        1 => return Some(buf[0].1.clone()),
        _ => {}
    }
    let j = buf.iter().take_while(|(t, _)| *t <= r).count();
    if j == 0 {
        return Some(buf[0].1.clone());
    }
    if j >= n {
        let (at, a) = &buf[n - 2];
        let (bt, b) = &buf[n - 1];
        let span = bt - at;
        if span <= 0.0 {
            return Some(b.clone());
        }
        let t_pos = (r.min(bt + ip::MAX_EXTRAP_MS) - at) / span;
        let t_rot = (r.min(bt + ip::ROT_EXTRAP_MS) - at) / span;
        return Some(blend(a, b, t_pos, t_rot));
    }
    let (at, a) = &buf[j - 1];
    let (bt, b) = &buf[j];
    let span = bt - at;
    let t = if span > 0.0 { (r - at) / span } else { 1.0 };
    Some(blend(a, b, t, t))
}

/// §10 step 5: ease `prev` toward `target`; numbers by `a_num`, quaternions by `a_quat`.
fn ease_state(prev: &State, target: &State, a_num: f64, a_quat: f64) -> State {
    let mut out = Map::new();
    for (k, tv) in target {
        let pv = prev.get(k);
        let v = if let (Some(p), Some(t)) = (pv.and_then(finite), finite(tv)) {
            Value::from(p + (t - p) * a_num)
        } else if let (Some(qp), Some(qt)) = (pv.and_then(as_quat), as_quat(tv)) {
            quat_value(slerp(qp, qt, a_quat))
        } else {
            tv.clone()
        };
        out.insert(k.clone(), v);
    }
    out
}

/// Map an angle into (−π, π].
pub fn wrap_angle(a: f64) -> f64 {
    if !a.is_finite() {
        return 0.0;
    }
    let two_pi = 2.0 * std::f64::consts::PI;
    let r = libm::fmod(a, two_pi);
    if r <= -std::f64::consts::PI {
        return r + two_pi;
    }
    if r > std::f64::consts::PI {
        return r - two_pi;
    }
    r
}

fn num(o: &State, k: &str) -> f64 {
    o.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()).unwrap_or(0.0)
}

/// A posed sample as a JSON map (the stream representation the interpolator stores).
/// `nums` is `[x, y, z, yaw, vx, vy, vz]`.
pub fn pose_map(nums: [f64; 7], anim: &str) -> State {
    let mut m = Map::new();
    for (k, v) in NUMERIC_POSE_KEYS.into_iter().zip(nums) {
        m.insert(k.to_owned(), Value::from(if v.is_finite() { v } else { 0.0 }));
    }
    m.insert("anim".to_owned(), Value::from(anim));
    m
}

/// Dead-reckon past the newest posed sample: positions by velocity, yaw by the last turn rate.
fn extrapolate_pose(buf: &[(f64, &State)], r: f64) -> State {
    let n = buf.len();
    let (bt, b) = buf[n - 1];
    let mut out = b.clone();
    let ahead = (r - bt).clamp(0.0, ip::MAX_EXTRAP_MS) / 1000.0;
    for (axis, vel) in AXES {
        out.insert(axis.into(), Value::from(num(b, axis) + num(b, vel) * ahead));
    }
    if n >= 2 {
        let (at, a) = buf[n - 2];
        let span = bt - at;
        if span > 0.0 {
            let k = (r - bt).clamp(0.0, ip::ROT_EXTRAP_MS) / span;
            let yb = num(b, "yaw");
            out.insert("yaw".into(), Value::from(yb + wrap_angle(yb - num(a, "yaw")) * k));
        }
    }
    out
}

/// §10.1 step 2: sample a posed player's buffer (ascending sender-clock stamps) at render time `r`.
fn sample_pose(buf: &[(f64, &State)], r: f64) -> Option<State> {
    let n = buf.len();
    if n == 0 {
        return None;
    }
    let j = buf.iter().take_while(|(t, _)| *t <= r).count();
    if j == 0 {
        return Some(buf[0].1.clone());
    }
    if j >= n {
        return Some(extrapolate_pose(buf, r));
    }
    let (at, a) = buf[j - 1];
    let (bt, b) = buf[j];
    let span = bt - at;
    let k = if span > 0.0 { (r - at) / span } else { 1.0 };
    let mut out = a.clone();
    for key in NUMERIC_POSE_KEYS {
        let va = num(a, key);
        let vb = num(b, key);
        let v = if key == "yaw" { va + wrap_angle(vb - va) * k } else { va + (vb - va) * k };
        out.insert(key.into(), Value::from(v));
    }
    Some(out)
}

/// §10.1 step 3: output ease. Numbers by `a_pos`, `yaw` on the shortest arc by `a_rot`, the rest snaps.
fn ease_pose(prev: &State, target: &State, a_pos: f64, a_rot: f64) -> State {
    let mut out = target.clone();
    for key in NUMERIC_POSE_KEYS {
        let pv = prev.get(key).and_then(Value::as_f64).filter(|v| v.is_finite());
        let tv = target.get(key).and_then(Value::as_f64).filter(|v| v.is_finite());
        let (Some(pv), Some(tv)) = (pv, tv) else {
            continue;
        };
        let v = if key == "yaw" { pv + wrap_angle(tv - pv) * a_rot } else { pv + (tv - pv) * a_pos };
        out.insert(key.into(), Value::from(v));
    }
    out
}
