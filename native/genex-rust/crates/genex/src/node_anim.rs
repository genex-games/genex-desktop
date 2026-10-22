//! Rigid GLB node clips (game systems AN-27): doors, platforms, lifts and props whose nodes move
//! by the GLB's own animations, without a skin.
//!
//! - `gfx.node_clips(path)` (in `on_reset`) reads the GLB's node tree and its clips once a reset;
//!   a GLB with no animations is refused `animation-clip-missing`, one that is not a usable GLB
//!   `animation-asset-invalid`.
//! - A [`NodeAnimator`] is simulation state: the clip playing and its time, nothing else, so it is
//!   deterministic and listed by [`NodeAnimator::probe`]. It holds the file's clips, so a save
//!   carries [`NodeAnimator::snapshot`] (a save section) and [`NodeAnimator::restore`] puts it back
//!   exactly. `play` loops, `play_once` holds the last frame; `update(dt)` advances it in
//!   `on_update`.
//! - `frame.model_posed(&model, &animator, transform)` draws the model with every node at the
//!   animator's pose: one logical draw. The presenter draws it through the skinned path, every
//!   vertex bound to its node at weight 1 (`SkinnedModel::rigid_from_glb`); a file the presenter
//!   cannot pose draws as `frame.model` does.
//!
//! The pose is sampled with genex-render's glTF node sampler (`skin::Animation::sample`: linear
//! and step keys, a cubic-spline key's value), the one the skinned GLB import pins.

use std::sync::Arc;

use genex_anim::AnimationError;
use genex_anim::sample::{Wrap, wrap_time};
use genex_render::skin::{Animation, Skeleton, SkinnedModel};
use serde_json::{Value, json};

/// The [`NodeAnimator::snapshot`] layout this build writes and reads.
const SNAPSHOT_VERSION: u64 = 1;

/// A GLB's node tree and its clips (`gfx.node_clips`), shared by `Arc` (cloning is cheap).
#[derive(Clone, Debug)]
pub struct NodeClips {
    path: Arc<str>,
    skeleton: Arc<Skeleton>,
    clips: Arc<[Animation]>,
}

impl PartialEq for NodeClips {
    /// The same file's clips.
    fn eq(&self, other: &NodeClips) -> bool {
        self.path == other.path && Arc::ptr_eq(&self.clips, &other.clips)
    }
}

impl NodeClips {
    /// The clips of the GLB `bytes` read from `path`: refused `animation-asset-invalid` when they
    /// are not a usable GLB, `animation-clip-missing` when it has no animations.
    pub(crate) fn from_glb(path: &str, bytes: &[u8]) -> Result<NodeClips, AnimationError> {
        let model = SkinnedModel::rigid_from_glb(bytes).map_err(|error| AnimationError::asset_invalid(format!("{path:?}: {error}")))?;
        if model.data.animations.is_empty() {
            return Err(AnimationError::clip_missing(format!("{path:?} has no animations")));
        }
        Ok(NodeClips { path: Arc::from(path), skeleton: Arc::new(model.data.skeleton), clips: model.data.animations.into() })
    }

    /// The path under `assets/` it was read from.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Its clips' names, in file order (an unnamed clip is `clip<index>`).
    pub fn clip_names(&self) -> Vec<String> {
        (0..self.clips.len()).map(|at| self.clip_name(at)).collect()
    }

    /// A clip's length in seconds, if it has one by that name.
    pub fn duration(&self, name: &str) -> Option<f32> {
        self.find(name).map(|at| self.clips[at].duration)
    }

    /// An animator over these clips, playing none (the rest pose).
    pub fn animator(&self) -> NodeAnimator {
        NodeAnimator { clips: self.clone(), playing: None, time: 0.0, once: false }
    }

    fn clip_name(&self, at: usize) -> String {
        self.clips[at].name.clone().unwrap_or_else(|| format!("clip{at}"))
    }

    fn find(&self, name: &str) -> Option<usize> {
        (0..self.clips.len()).find(|at| self.clip_name(*at) == name)
    }

    /// The node joint matrices of clip `at` at `time` seconds (the rest pose for none).
    fn palette(&self, at: Option<usize>, time: f32) -> Vec<[f32; 16]> {
        let pose = match at {
            Some(at) => self.clips[at].sample(&self.skeleton, time),
            None => self.skeleton.rest_pose(),
        };
        self.skeleton.joint_matrices(&pose)
    }
}

/// A node-animated model's simulation state (module docs): the clip playing and its time.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeAnimator {
    clips: NodeClips,
    playing: Option<usize>,
    time: f32,
    once: bool,
}

impl NodeAnimator {
    /// Loop the clip `name` from its start. Refused `animation-clip-missing` for a name the file
    /// does not have (the animator keeps what it played).
    pub fn play(&mut self, name: &str) -> Result<(), AnimationError> {
        self.start(name, false)
    }

    /// Play the clip `name` once from its start, then hold its last frame.
    pub fn play_once(&mut self, name: &str) -> Result<(), AnimationError> {
        self.start(name, true)
    }

    fn start(&mut self, name: &str, once: bool) -> Result<(), AnimationError> {
        let at = self.clips.find(name).ok_or_else(|| AnimationError::clip_missing(format!("{:?} has no clip {name:?}", self.clips.path())))?;
        self.playing = Some(at);
        self.time = 0.0;
        self.once = once;
        Ok(())
    }

    /// Stop on the rest pose.
    pub fn stop(&mut self) {
        self.playing = None;
        self.time = 0.0;
    }

    /// Advance the clip by `dt` seconds (a looping clip wraps, a clip played once holds its end).
    /// A `dt` that is not finite and positive changes nothing.
    pub fn update(&mut self, dt: f32) {
        let Some(at) = self.playing else { return };
        if !(dt.is_finite() && dt > 0.0) {
            return;
        }
        let duration = self.clips.clips[at].duration;
        let advanced = self.time + dt;
        let wrap = if self.once { Wrap::Clamp } else { Wrap::Loop };
        self.time = wrap_time(duration, advanced, wrap);
    }

    /// The clip playing, if any.
    pub fn playing(&self) -> Option<String> {
        self.playing.map(|at| self.clips.clip_name(at))
    }

    /// The time into the clip, in seconds.
    pub fn time(&self) -> f32 {
        self.time
    }

    /// Whether a clip played once reached its end.
    pub fn finished(&self) -> bool {
        self.once && self.playing.is_some_and(|at| self.time >= self.clips.clips[at].duration)
    }

    /// The clips it plays.
    pub fn clips(&self) -> &NodeClips {
        &self.clips
    }

    /// The state for a probe: `{clip, time, once, finished}` (`clip` null at rest).
    pub fn probe(&self) -> Value {
        json!({ "clip": self.playing(), "time": self.time, "once": self.once, "finished": self.finished() })
    }

    /// The whole state as a value for a save section: `{version, file, clip, time, once}`, the
    /// time as its float bits. [`NodeAnimator::restore`] on an animator of the same file continues
    /// exactly where this one is.
    pub fn snapshot(&self) -> Value {
        json!({ "version": SNAPSHOT_VERSION, "file": self.clips.path(), "clip": self.playing(), "time": self.time.to_bits(), "once": self.once })
    }

    /// Restore a [`NodeAnimator::snapshot`]. Refused `animation-asset-invalid`, with the animator
    /// unchanged: not a snapshot of this version, taken from another file's animator, a clip the
    /// file does not have, a field missing or of the wrong kind, or a time that is not a finite,
    /// non-negative float.
    pub fn restore(&mut self, snapshot: &Value) -> Result<(), AnimationError> {
        let (playing, time, once) = self.restored(snapshot).map_err(|problem| AnimationError::asset_invalid(format!("node animator snapshot: {problem}")))?;
        self.playing = playing;
        self.time = time;
        self.once = once;
        Ok(())
    }

    fn restored(&self, snapshot: &Value) -> Result<(Option<usize>, f32, bool), String> {
        if !snapshot.is_object() {
            return Err("not an object".to_owned());
        }
        let version = snapshot["version"].as_u64();
        if version != Some(SNAPSHOT_VERSION) {
            return Err(format!("version {}, this build reads {SNAPSHOT_VERSION}", snapshot["version"]));
        }
        if snapshot["file"].as_str() != Some(self.clips.path()) {
            return Err(format!("taken from an animator of {}, not {:?}", snapshot["file"], self.clips.path()));
        }
        let playing = match &snapshot["clip"] {
            Value::Null => None,
            Value::String(name) => Some(self.clips.find(name).ok_or_else(|| format!("{:?} has no clip {name:?}", self.clips.path()))?),
            other => return Err(format!("clip {other} is not a name")),
        };
        let bits = snapshot["time"].as_u64().and_then(|bits| u32::try_from(bits).ok()).ok_or("time is not float bits")?;
        let time = f32::from_bits(bits);
        if !(time.is_finite() && time >= 0.0) {
            return Err(format!("time {time} is not a finite, non-negative float"));
        }
        let once = snapshot["once"].as_bool().ok_or("once is not a flag")?;
        Ok((playing, time, once))
    }

    /// The node joint matrices of the pose, in node order (the presenter's skinning palette).
    pub(crate) fn palette(&self) -> Vec<[f32; 16]> {
        self.clips.palette(self.playing, self.time)
    }
}
