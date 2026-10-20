//! Optional typed pose (§6.6, §10.1): the pure half, a port of `packages/multiplayer/src/pose.ts`.
//!
//! Off by default for senders (`ConnectOptions::pose`); receivers always understand a posed player.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::f64::consts::PI;

use crate::protocol::{interpolation as ip, limits};

/// One `__pose` publish. Every field is optional: an absent field keeps the relay's stored value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PoseFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<f64>,
    /// Radians, any finite value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yaw: Option<f64>,
    /// World units per second. Derived from successive poses when left unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vx: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vz: Option<f64>,
    /// At most 64 characters. Discrete: never interpolated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anim: Option<String>,
}

impl PoseFields {
    /// Whether every present value is one the relay accepts (finite, |v| ≤ 1e9, anim ≤ 64 chars).
    pub fn is_valid(&self) -> bool {
        let nums = [self.x, self.y, self.z, self.yaw, self.vx, self.vy, self.vz];
        nums.iter().flatten().all(|v| valid_pose_number(*v))
            && self
                .anim
                .as_ref()
                .is_none_or(|a| a.encode_utf16().count() <= limits::MAX_ANIM_CHARS)
    }
}

pub(crate) fn valid_pose_number(v: f64) -> bool {
    v.is_finite() && v.abs() <= limits::MAX_POSE_ABS
}

/// Map an angle into (−π, π].
pub fn wrap_angle(a: f64) -> f64 {
    if !a.is_finite() {
        return 0.0;
    }
    let two_pi = 2.0 * PI;
    let mut r = a % two_pi;
    if r <= -PI {
        r += two_pi;
    } else if r > PI {
        r -= two_pi;
    }
    r
}

/// Sender-side memory for velocity derivation: the last published position and its stamp.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VelocityMemory {
    t: f64,
    pos: [Option<f64>; 3],
}

/// Fill in `vx/vy/vz` the game did not set, from Δposition / Δt on the sender's clock (§6.6).
/// A first publish, or a gap outside (5, 2000) ms, derives 0 rather than a spike.
pub fn derive_velocity(pose: &PoseFields, t: f64, prev: Option<&VelocityMemory>) -> (PoseFields, VelocityMemory) {
    let mut out = pose.clone();
    let mut memory = VelocityMemory { t, pos: [None; 3] };
    let dt = prev.map(|p| t - p.t).unwrap_or(0.0);
    let usable = prev.is_some() && dt > ip::MIN_GAP_MS && dt < ip::MAX_GAP_MS;
    let axes = [(pose.x, &mut out.vx), (pose.y, &mut out.vy), (pose.z, &mut out.vz)];
    for (i, (p, vel)) in axes.into_iter().enumerate() {
        let Some(p) = p else { continue };
        memory.pos[i] = Some(p);
        if vel.is_some() {
            continue;
        }
        let before = prev.and_then(|m| m.pos[i]);
        let v = match (usable, before) {
            (true, Some(b)) => (p - b) / dt * 1000.0,
            _ => 0.0,
        };
        *vel = Some(if valid_pose_number(v) { v } else { 0.0 });
    }
    (out, memory)
}

const NUMERIC_POSE_KEYS: [&str; 7] = ["x", "y", "z", "yaw", "vx", "vy", "vz"];
const AXES: [(&str, &str); 3] = [("x", "vx"), ("y", "vy"), ("z", "vz")];

fn num(o: &Map<String, Value>, k: &str) -> f64 {
    o.get(k)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
}

/// A pose sample as a JSON map (the stream representation the interpolator stores).
/// `nums` is `[x, y, z, yaw, vx, vy, vz]`.
pub fn pose_map(nums: [f64; 7], anim: &str) -> Map<String, Value> {
    let mut m = Map::new();
    for (k, v) in NUMERIC_POSE_KEYS.into_iter().zip(nums) {
        m.insert(k.to_string(), Value::from(if v.is_finite() { v } else { 0.0 }));
    }
    m.insert("anim".to_string(), Value::from(anim));
    m
}

/// §10.1 step 2: sample a posed player's buffer (ascending sender-clock stamps) at render time `r`.
pub fn sample_pose(buf: &[(f64, &Map<String, Value>)], r: f64) -> Option<Map<String, Value>> {
    let n = buf.len();
    if n == 0 {
        return None;
    }
    let j = buf.iter().take_while(|(t, _)| *t <= r).count();
    if j == 0 {
        return Some(buf[0].1.clone());
    }
    if j >= n {
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
        return Some(out);
    }
    let (at, a) = buf[j - 1];
    let (bt, b) = buf[j];
    let span = bt - at;
    let k = if span > 0.0 { (r - at) / span } else { 1.0 };
    let mut out = a.clone();
    for key in NUMERIC_POSE_KEYS {
        let va = num(a, key);
        let vb = num(b, key);
        let v = if key == "yaw" {
            va + wrap_angle(vb - va) * k
        } else {
            va + (vb - va) * k
        };
        out.insert(key.into(), Value::from(v));
    }
    Some(out)
}

/// §10.1 step 3: output ease. Numbers by `a_pos`, `yaw` on the shortest arc by `a_rot`, the rest snaps.
pub fn ease_pose(prev: &Map<String, Value>, target: &Map<String, Value>, a_pos: f64, a_rot: f64) -> Map<String, Value> {
    let mut out = target.clone();
    for key in NUMERIC_POSE_KEYS {
        let (Some(pv), Some(tv)) = (
            prev.get(key).and_then(Value::as_f64),
            target.get(key).and_then(Value::as_f64),
        ) else {
            continue;
        };
        if !pv.is_finite() || !tv.is_finite() {
            continue;
        }
        let v = if key == "yaw" {
            pv + wrap_angle(tv - pv) * a_rot
        } else {
            pv + (tv - pv) * a_pos
        };
        out.insert(key.into(), Value::from(v));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn wraps_into_half_open_interval() {
        assert!((wrap_angle(3.0 * PI) - PI).abs() < 1e-9);
        assert!((wrap_angle(-PI) - PI).abs() < 1e-9);
        assert!(wrap_angle(0.5) == 0.5);
        assert_eq!(wrap_angle(f64::NAN), 0.0);
    }

    #[test]
    fn yaw_takes_the_short_way_across_pi() {
        let a = pose_map([0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0], "run");
        let b = pose_map([0.0, 0.0, 0.0, -3.0, 0.0, 0.0, 0.0], "jump");
        let s = sample_pose(&[(0.0, &a), (100.0, &b)], 50.0).unwrap();
        let yaw = s["yaw"].as_f64().unwrap();
        // Halfway along the 0.28 rad short arc through π, not through 0.
        assert!((wrap_angle(yaw) - PI).abs() < 0.01, "yaw {yaw}");
        // anim holds the OLDER sample while interpolating.
        assert_eq!(s["anim"], json!("run"));
    }

    #[test]
    fn dead_reckons_past_the_newest_with_velocity_capped() {
        let a = pose_map([0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0], "a");
        let b = pose_map([1.0, 0.0, 0.0, 0.0, 10.0, 0.0, 0.0], "b");
        let s = sample_pose(&[(0.0, &a), (100.0, &b)], 1100.0).unwrap();
        // 250 ms cap at 10 u/s = +2.5.
        assert!((s["x"].as_f64().unwrap() - 3.5).abs() < 1e-9);
        assert_eq!(s["anim"], json!("b"));
    }

    #[test]
    fn derives_velocity_from_successive_poses() {
        let (p1, mem) = derive_velocity(
            &PoseFields {
                x: Some(0.0),
                ..Default::default()
            },
            100.0,
            None,
        );
        assert_eq!(p1.vx, Some(0.0));
        assert_eq!(p1.vy, None);
        let (p2, _) = derive_velocity(
            &PoseFields {
                x: Some(1.0),
                ..Default::default()
            },
            150.0,
            Some(&mem),
        );
        assert!((p2.vx.unwrap() - 20.0).abs() < 1e-9);
        // A velocity the game supplied is never overwritten.
        let (p3, _) = derive_velocity(
            &PoseFields {
                x: Some(5.0),
                vx: Some(1.0),
                ..Default::default()
            },
            160.0,
            Some(&mem),
        );
        assert_eq!(p3.vx, Some(1.0));
    }

    #[test]
    fn eases_yaw_on_the_short_arc() {
        let prev = m(json!({"x": 0.0, "yaw": 3.1, "anim": "a"}));
        let target = m(json!({"x": 10.0, "yaw": -3.1, "anim": "b"}));
        let out = ease_pose(&prev, &target, 0.5, 0.5);
        assert_eq!(out["x"], json!(5.0));
        assert!(out["yaw"].as_f64().unwrap() > 3.1);
        assert_eq!(out["anim"], json!("b"));
    }

    #[test]
    fn validates_pose_fields() {
        assert!(PoseFields {
            x: Some(1.0),
            anim: Some("idle".into()),
            ..Default::default()
        }
        .is_valid());
        assert!(!PoseFields {
            x: Some(2e9),
            ..Default::default()
        }
        .is_valid());
        assert!(!PoseFields {
            anim: Some("a".repeat(65)),
            ..Default::default()
        }
        .is_valid());
    }
}
