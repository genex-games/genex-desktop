//! The §10 interpolation contract: remote streams rendered slightly in the past, interpolated on
//! the SENDER's clock. A port of the TypeScript SDK's engine (`pushSnap` / `sampleSmoothed`).
//!
//! A *stream* is one remote player (keyed by session id) or one object (`obj:<id>`); a *sample*
//! is `(s, state)` with `s` the sender's own clock stamp. Clock offsets belong to the sender, so
//! all of one machine's streams share one estimate and two machines' clocks never mix.

use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};

use crate::pose;
use crate::protocol::interpolation as ip;

type State = Map<String, Value>;

#[derive(Debug, Default)]
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
        while self.samples.len() > ip::CLOCK_WINDOW_MAX
            || (self.samples.len() > ip::CLOCK_WINDOW
                && self
                    .samples
                    .front()
                    .is_some_and(|(at, _)| *at < arrival - ip::CLOCK_WINDOW_MS))
        {
            self.samples.pop_front();
        }
        let first_kept = self.samples.front().map(|(_, n)| *n).unwrap_or(n);
        while self.mins.front().is_some_and(|(_, k)| *k < first_kept) {
            self.mins.pop_front();
        }
        self.offset()
    }

    fn offset(&self) -> f64 {
        self.mins.front().map(|(v, _)| *v).unwrap_or(0.0)
    }
}

#[derive(Debug)]
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

impl Default for Stream {
    fn default() -> Self {
        Stream {
            sender: None,
            buf: VecDeque::new(),
            last_stamp: None,
            gaps: VecDeque::new(),
            jitter: VecDeque::new(),
            delay: ip::DEFAULT_MS,
            smoothed: None,
            smoothed_at: 0.0,
            bridge: false,
            posed: false,
        }
    }
}

impl Stream {
    /// Drop the clock-domain state: buffer, gaps, jitter, delay, sender.
    fn reset_clock(&mut self) {
        self.sender = None;
        self.buf.clear();
        self.last_stamp = None;
        self.gaps.clear();
        self.jitter.clear();
        self.delay = ip::DEFAULT_MS;
        self.bridge = false;
    }
}

/// The interpolation engine for every remote stream of one session.
#[derive(Debug, Default)]
pub struct Interpolator {
    senders: HashMap<String, SenderClock>,
    streams: HashMap<String, Stream>,
}

impl Interpolator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark a stream as a posed player (§10.1) or a JSON stream (§10). Switching drops its history.
    pub fn set_posed(&mut self, stream: &str, posed: bool) {
        let s = self.streams.entry(stream.to_string()).or_default();
        if s.posed != posed {
            s.reset_clock();
            s.smoothed = None;
            s.posed = posed;
        }
    }

    /// Feed one sample `(s, state)` stamped on `sender`'s clock, arriving at local time `arrival`.
    /// Never feed an unstamped or `t = 0` sample (§7.3, §10).
    pub fn push(&mut self, stream: &str, sender: &str, s: f64, state: State, arrival: f64) {
        if !s.is_finite() || s == 0.0 {
            return;
        }
        let sample = arrival - s;
        let offset = self
            .senders
            .entry(sender.to_string())
            .or_default()
            .push(sample, arrival);
        let st = self.streams.entry(stream.to_string()).or_default();
        st.jitter.push_back(sample);
        if st.jitter.len() > ip::CLOCK_WINDOW {
            st.jitter.pop_front();
        }
        st.sender = Some(sender.to_string());

        if let Some(prev) = st.last_stamp {
            let gap = s - prev;
            if gap > ip::MIN_GAP_MS && gap < ip::MAX_GAP_MS {
                st.gaps.push_back(gap);
                if st.gaps.len() > ip::INTERVAL_WINDOW {
                    st.gaps.pop_front();
                }
                let jitter = if st.jitter.len() >= ip::JITTER_MIN_SAMPLES {
                    (quantile(st.jitter.iter().copied(), 0.9) - offset).max(0.0)
                } else {
                    0.0
                };
                let target = (ip::RATIO * median(st.gaps.iter().copied()))
                    .max(ip::JITTER_SAFETY * jitter)
                    .clamp(ip::MIN_MS, ip::MAX_MS);
                st.delay += (target - st.delay) * ip::EASE;
            }
        }
        st.last_stamp = Some(s);

        if st.bridge && st.buf.is_empty() {
            if let Some(pose) = st.smoothed.clone() {
                st.buf.push_back((s - st.delay.max(1.0), pose));
            }
        }
        st.bridge = false;
        st.buf.push_back((s, state));
        let cutoff = s - ip::HISTORY_MS;
        while st.buf.len() > 2 && st.buf.front().is_some_and(|(t, _)| *t < cutoff) {
            st.buf.pop_front();
        }
        // A head stamped on a foreign clock sits far in the future of the tail: drop it.
        while st.buf.len() > 1
            && st.buf.front().map(|(t, _)| *t).unwrap_or(0.0)
                > st.buf.back().map(|(t, _)| *t).unwrap_or(0.0) + ip::POISON_GUARD_MS
        {
            st.buf.pop_front();
        }
    }

    /// The render time of a stream, or `None` before it has a stamped sample.
    pub fn render_time(&self, stream: &str, now: f64) -> Option<f64> {
        let st = self.streams.get(stream)?;
        let offset = self.senders.get(st.sender.as_deref()?)?.offset();
        Some(now - offset - st.delay)
    }

    /// Sample a stream at local time `now`: interpolate on the sender's clock, then output-ease.
    /// `None` until the stream has a sample (or a held pose after a soft handoff).
    pub fn sample(&mut self, stream: &str, now: f64) -> Option<State> {
        let r = self.render_time(stream, now).unwrap_or(now - ip::DEFAULT_MS);
        let st = self.streams.get_mut(stream)?;
        let sampled = if st.posed {
            let view: Vec<(f64, &State)> = st.buf.iter().map(|(t, s)| (*t, s)).collect();
            pose::sample_pose(&view, r)
        } else {
            sample_buffer(&st.buf, r)
        };
        let Some(sampled) = sampled else {
            return st.smoothed.clone();
        };
        let out = match &st.smoothed {
            Some(prev) => {
                let dt = (now - st.smoothed_at).clamp(0.0, ip::MAX_HOST_TICK_DT_MS);
                let a_pos = 1.0 - (-dt / ip::SMOOTH_TAU_POS_MS).exp();
                let a_rot = 1.0 - (-dt / ip::SMOOTH_TAU_ROT_MS).exp();
                if st.posed {
                    pose::ease_pose(prev, &sampled, a_pos, a_rot)
                } else {
                    ease_state(prev, &sampled, a_pos, a_rot)
                }
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

    /// The sender's current clock offset estimate (min of arrival − send), if any.
    pub fn sender_offset(&self, sender: &str) -> Option<f64> {
        self.senders.get(sender).map(SenderClock::offset)
    }

    /// An `epoch` change: drop all of the stream's history; the next sample places it (§10 step 6).
    pub fn reset_epoch(&mut self, stream: &str) {
        if let Some(st) = self.streams.get_mut(stream) {
            st.reset_clock();
            st.smoothed = None;
        }
    }

    /// An ownership change (`seq` changed): the soft handoff of §10 step 6. Keeps the eased pose
    /// and seeds it as a bridge sample before the new owner's first sample.
    pub fn soft_handoff(&mut self, stream: &str) {
        if let Some(st) = self.streams.get_mut(stream) {
            st.reset_clock();
            st.bridge = st.smoothed.is_some();
        }
    }

    /// Hold `state` as the stream's on-screen pose (e.g. our own last publish of an object we just
    /// lost), so a following soft handoff glides from it.
    pub fn hold(&mut self, stream: &str, state: State, now: f64) {
        let st = self.streams.entry(stream.to_string()).or_default();
        st.smoothed = Some(state);
        st.smoothed_at = now;
    }

    /// True teardown: a player left or an object was destroyed.
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
}

fn sorted(xs: impl Iterator<Item = f64>) -> Vec<f64> {
    let mut v: Vec<f64> = xs.collect();
    v.sort_by(f64::total_cmp);
    v
}

fn median(xs: impl Iterator<Item = f64>) -> f64 {
    let s = sorted(xs);
    if s.is_empty() {
        66.0
    } else {
        s[s.len() / 2]
    }
}

/// Nearest-rank quantile (0..1).
fn quantile(xs: impl Iterator<Item = f64>, q: f64) -> f64 {
    let s = sorted(xs);
    if s.is_empty() {
        return 0.0;
    }
    let i = ((q * (s.len() - 1) as f64).round() as usize).min(s.len() - 1);
    s[i]
}

fn as_quat(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let mut q = [0.0; 4];
    for (i, x) in a.iter().enumerate() {
        q[i] = x.as_f64().filter(|f| f.is_finite())?;
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
    if dot > 0.9995 {
        let q = [
            ax + (bx - ax) * t,
            ay + (by - ay) * t,
            az + (bz - az) * t,
            aw + (bw - aw) * t,
        ];
        let l = q.iter().map(|c| c * c).sum::<f64>().sqrt();
        let l = if l == 0.0 { 1.0 } else { l };
        return q.map(|c| c / l);
    }
    let theta0 = dot.acos();
    let sin0 = theta0.sin();
    let s0 = (theta0 - theta0 * t).sin() / sin0;
    let s1 = (theta0 * t).sin() / sin0;
    [
        ax * s0 + bx * s1,
        ay * s0 + by * s1,
        az * s0 + bz * s1,
        aw * s0 + bw * s1,
    ]
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
        let v = match (av.and_then(finite), finite(bv)) {
            (Some(x), Some(y)) => Value::from(x + (y - x) * t_num),
            _ => match (av.and_then(as_quat), as_quat(bv)) {
                (Some(qa), Some(qb)) => quat_value(slerp(qa, qb, t_quat)),
                _ => match av {
                    Some(av) if interpolating => av.clone(),
                    _ => bv.clone(),
                },
            },
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
        let v = match (pv.and_then(finite), finite(tv)) {
            (Some(p), Some(t)) => Value::from(p + (t - p) * a_num),
            _ => match (pv.and_then(as_quat), as_quat(tv)) {
                (Some(qp), Some(qt)) => quat_value(slerp(qp, qt, a_quat)),
                _ => tv.clone(),
            },
        };
        out.insert(k.clone(), v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn st(v: Value) -> State {
        v.as_object().unwrap().clone()
    }

    fn x_of(s: &State) -> f64 {
        s["x"].as_f64().unwrap()
    }

    /// A sender 1000 ms ahead of us, 20 ms of transit, publishing x = t/10 every 50 ms.
    fn feed(ip: &mut Interpolator, stream: &str, sender: &str, from: f64, to: f64) {
        let mut s = from;
        while s <= to {
            ip.push(
                stream,
                sender,
                s,
                st(json!({"x": s / 10.0, "mode": format!("m{s}")})),
                s - 1000.0 + 20.0,
            );
            s += 50.0;
        }
    }

    #[test]
    fn offset_is_the_window_minimum_of_arrival_minus_send() {
        let mut i = Interpolator::new();
        i.push("p", "p", 1000.0, st(json!({"x": 0})), 50.0); // arrival - send = -950
        i.push("p", "p", 1050.0, st(json!({"x": 0})), 80.0); // -970: faster sample, new min
        i.push("p", "p", 1100.0, st(json!({"x": 0})), 160.0); // -940
        assert_eq!(i.sender_offset("p"), Some(-970.0));
    }

    #[test]
    fn interpolates_on_the_sender_clock() {
        let mut i = Interpolator::new();
        feed(&mut i, "p", "p", 1000.0, 2000.0);
        // offset = -980; at local now = 1005, render r = now + 980 - delay.
        let now = 1005.0;
        let r = i.render_time("p", now).unwrap();
        let d = i.delay("p").unwrap();
        assert!((r - (now + 980.0 - d)).abs() < 1e-9);
        let s = i.sample("p", now).unwrap();
        assert!((x_of(&s) - r / 10.0).abs() < 1e-6, "x {} r {}", x_of(&s), r);
        // The discrete field holds the OLDER snapshot of the bracketing pair.
        let older = ((r / 50.0).floor() * 50.0) as i64;
        assert_eq!(s["mode"], json!(format!("m{older}")));
    }

    #[test]
    fn render_delay_is_clamped_and_eases_toward_target() {
        let mut i = Interpolator::new();
        assert!(i.delay("p").is_none());
        feed(&mut i, "p", "p", 1000.0, 1050.0);
        // One 50 ms gap: target = clamp(1.5 × 50, 90, 300) = 90; 100 + (90 − 100) × 0.1 = 99.
        assert!((i.delay("p").unwrap() - 99.0).abs() < 1e-9);
        feed(&mut i, "p", "p", 1100.0, 20_000.0);
        assert!((i.delay("p").unwrap() - 90.0).abs() < 0.01);
    }

    #[test]
    fn extrapolates_at_most_250_ms_past_the_newest() {
        let mut i = Interpolator::new();
        feed(&mut i, "p", "p", 1000.0, 1100.0);
        // Far in the future: x at newest (110) + 250 ms of 1 unit / 10 ms = 135.
        let s = i.sample("p", 100_000.0).unwrap();
        assert!((x_of(&s) - 135.0).abs() < 1e-6, "x {}", x_of(&s));
    }

    #[test]
    fn quaternions_slerp_and_ease() {
        let mut i = Interpolator::new();
        let half = std::f64::consts::FRAC_1_SQRT_2;
        i.push("o", "a", 1000.0, st(json!({"q": [0.0, 0.0, 0.0, 1.0]})), 1000.0);
        i.push("o", "a", 1100.0, st(json!({"q": [0.0, half, 0.0, half]})), 1100.0);
        // offset 0, delay ~99: render at 1050 → halfway between identity and 90° about y.
        let s = i.sample("o", 1050.0 + i.delay("o").unwrap()).unwrap();
        let q = as_quat(&s["q"]).unwrap();
        let expect = (std::f64::consts::PI / 8.0).sin();
        assert!((q[1] - expect).abs() < 1e-6, "q {q:?}");
    }

    #[test]
    fn epoch_reset_places_at_the_new_state() {
        let mut i = Interpolator::new();
        feed(&mut i, "p", "p", 1000.0, 1500.0);
        i.sample("p", 600.0);
        i.reset_epoch("p");
        i.push("p", "p", 1550.0, st(json!({"x": 999.0})), 570.0);
        assert_eq!(x_of(&i.sample("p", 600.0).unwrap()), 999.0);
    }

    #[test]
    fn soft_handoff_bridges_from_the_on_screen_pose() {
        let mut i = Interpolator::new();
        // Owner A: clock offset -980.
        feed(&mut i, "obj:ball", "A", 1000.0, 1500.0);
        let before = i.sample("obj:ball", 600.0).unwrap();
        i.soft_handoff("obj:ball");
        // Held while the new owner has not published.
        assert_eq!(i.sample("obj:ball", 610.0).unwrap(), before);
        // New owner B on a totally different clock (offset +5000) publishes far away.
        i.push("obj:ball", "B", 10.0, st(json!({"x": 500.0, "mode": "b"})), 5010.0);
        assert_eq!(i.sender_offset("A"), Some(-980.0));
        assert_eq!(i.sender_offset("B"), Some(5000.0));
        // The first frame after the sample starts at the bridge, not at 500.
        let first = i.sample("obj:ball", 5010.0).unwrap();
        assert!(
            (x_of(&first) - x_of(&before)).abs() < 1.0,
            "starts at the bridge {}, got {}",
            x_of(&before),
            x_of(&first)
        );
        // ...and glides most of the way to the new owner's sample one render delay later.
        let later = i.sample("obj:ball", 5010.0 + ip::DEFAULT_MS).unwrap();
        assert!(x_of(&later) > 450.0 && x_of(&later) <= 500.0, "x {}", x_of(&later));
    }

    #[test]
    fn foreign_clock_head_is_dropped() {
        let mut i = Interpolator::new();
        i.push("p", "p", 900_000.0, st(json!({"x": 1})), 0.0);
        i.push("p", "p", 1000.0, st(json!({"x": 2})), 0.0);
        i.push("p", "p", 1050.0, st(json!({"x": 3})), 0.0);
        assert_eq!(i.streams["p"].buf.len(), 2);
        assert_eq!(i.latest("p").unwrap()["x"], json!(3));
    }

    #[test]
    fn unstamped_samples_are_never_fed() {
        let mut i = Interpolator::new();
        i.push("o", "a", 0.0, st(json!({"x": 1})), 10.0);
        i.push("o", "a", f64::NAN, st(json!({"x": 1})), 10.0);
        assert!(i.sample("o", 10.0).is_none());
        assert!(i.sender_offset("a").is_none());
    }

    #[test]
    fn sender_window_spans_time_not_just_count() {
        let mut i = Interpolator::new();
        // 200 samples within 1 s from one sender (many streams): an early fast sample (-1000)
        // is younger than 5 s, so it must stay the minimum even past 80 samples.
        i.push("s0", "host", 1000.0, st(json!({})), 0.0);
        for k in 1..200 {
            let s = 1000.0 + k as f64 * 5.0;
            i.push(&format!("s{}", k % 10), "host", s, st(json!({})), s - 990.0);
        }
        assert_eq!(i.sender_offset("host"), Some(-1000.0));
    }

    #[test]
    fn posed_streams_sample_as_poses() {
        let mut i = Interpolator::new();
        i.set_posed("p", true);
        let a = pose::pose_map([0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0], "walk");
        let b = pose::pose_map([10.0, 0.0, 0.0, -3.0, 0.0, 0.0, 0.0], "run");
        i.push("p", "p", 1000.0, a, 1000.0);
        i.push("p", "p", 1100.0, b, 1100.0);
        let s = i.sample("p", 1050.0 + i.delay("p").unwrap()).unwrap();
        assert!((x_of(&s) - 5.0).abs() < 1e-6);
        assert_eq!(s["anim"], json!("walk"));
        assert!(s["yaw"].as_f64().unwrap().abs() > 3.0);
    }
}
