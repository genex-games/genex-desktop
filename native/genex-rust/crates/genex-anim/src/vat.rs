//! Vertex-animation textures for crowds (game systems AN-24): a skinned mesh's clips baked at a
//! fixed rate into per-frame vertex positions and normals, so a far crowd draws from two textures
//! (genex-render's `vat` module encodes and samples them) with no palette, no skinning pass and no
//! skinned output per instance. Ideas from SideFX's crowd VAT talk and Unity.GPUAnimation; the
//! code is ours.
//!
//! The bake is the simulation's own arithmetic. Each frame samples its clip from the rest pose
//! ([`crate::sample::sample`], clamped), builds the palette ([`Skeleton::palette`]) and blends a
//! vertex's four joint matrices by its weights in slot order, then transforms the position and
//! the normal, as genex-render's compute skinning does (its CPU reference `skin_vertices_cpu`).
//! A clip's frames sit at `k / fps` with the last one exactly at its end, so a looping clip
//! blends from its last frame back to its first. Everything is glam scalar math: the same inputs
//! give the same bits on every destination.
//!
//! Frames are stored frame-major: frame `f`'s vertex `v` is entry `f * vertex_count + v`, the
//! texel order genex-render lays out.

use glam::{Mat4, Vec3, Vec4};

use crate::clip::Clip;
use crate::error::AnimationError;
use crate::math::Trs;
use crate::sample::{SampleCursor, Wrap, sample, wrap_time};
use crate::skeleton::Skeleton;

/// The bake rate a crowd uses unless it names one, in frames per second.
pub const VAT_FPS_DEFAULT: f32 = 30.0;
/// The highest bake rate: past it a texture holds more frames than a crowd can show.
pub const VAT_FPS_MAX: f32 = 120.0;
/// Vertices one bake holds (a crowd mesh is a far level, not a hero).
pub const VAT_VERTICES_MAX: usize = 65_536;
/// Frames one bake holds over every clip.
pub const VAT_FRAMES_MAX: usize = 4_096;
/// Vertex-frames one bake holds: 2 Mi texels, 16 MiB per rgba16f texture on the GPU.
pub const VAT_TEXELS_MAX: usize = 1 << 21;

/// A skinned mesh in bind pose, one row per vertex: what [`VatBake::bake`] skins every frame.
#[derive(Clone, Copy, Debug)]
pub struct VatSkin<'a> {
    /// Bind-pose positions, model space.
    pub positions: &'a [[f32; 3]],
    /// Bind-pose unit normals.
    pub normals: &'a [[f32; 3]],
    /// Four palette slots per vertex (a slot past the palette is the identity).
    pub joints: &'a [[u32; 4]],
    /// Their weights, summing to 1.
    pub weights: &'a [[f32; 4]],
}

/// One clip's frames inside a bake.
#[derive(Clone, Debug, PartialEq)]
pub struct VatClip {
    /// The clip's name in its file.
    pub name: String,
    /// Its first frame in the bake.
    pub first_frame: u32,
    /// Its frames: `ceil(duration * fps) + 1` (one for a clip of no length).
    pub frames: u32,
    /// Its length in seconds.
    pub duration: f32,
}

/// Where a time falls in a clip's frames: blend `frame0` toward `frame1` by `blend`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VatSample {
    /// The frame at or before the time (a bake-wide index).
    pub frame0: u32,
    /// The frame after it (equal to `frame0` at a clamped end).
    pub frame1: u32,
    /// 0 at `frame0`, 1 at `frame1`.
    pub blend: f32,
}

/// A skinned mesh's clips, baked: every clip's frames, one position and one normal per vertex.
#[derive(Clone, Debug, PartialEq)]
pub struct VatBake {
    fps: f32,
    vertex_count: usize,
    clips: Vec<VatClip>,
    positions: Vec<[f32; 3]>,
    normals: Vec<[f32; 3]>,
}

impl VatBake {
    /// Bake `clips` of `skeleton` at `fps` frames per second over `skin`. Refused
    /// `animation-asset-invalid` for rows of unequal lengths, no vertex or no clip, a rate outside
    /// `(0, VAT_FPS_MAX]`, a non-finite position or normal, or more than [`VAT_VERTICES_MAX`]
    /// vertices, [`VAT_FRAMES_MAX`] frames or [`VAT_TEXELS_MAX`] vertex-frames.
    pub fn bake(skeleton: &Skeleton, clips: &[Clip], skin: &VatSkin<'_>, fps: f32) -> Result<VatBake, AnimationError> {
        check_skin(skin)?;
        check_rate(fps)?;
        let table = clip_table(clips, fps)?;
        let vertex_count = skin.positions.len();
        let frames: usize = table.iter().map(|clip| clip.frames as usize).sum();
        if frames.saturating_mul(vertex_count) > VAT_TEXELS_MAX {
            return Err(refused(format!("{frames} frames of {vertex_count} vertices; at most {VAT_TEXELS_MAX} vertex-frames")));
        }
        let mut positions = Vec::with_capacity(frames * vertex_count);
        let mut normals = Vec::with_capacity(frames * vertex_count);
        let mut frame = Frame::new(skeleton);
        for (clip, row) in clips.iter().zip(&table) {
            for k in 0..row.frames {
                frame.pose(skeleton, clip, frame_time(k, fps, row.duration));
                frame.skin(skin, &mut positions, &mut normals);
            }
        }
        Ok(VatBake { fps, vertex_count, clips: table, positions, normals })
    }

    /// The bake rate, in frames per second.
    pub fn fps(&self) -> f32 {
        self.fps
    }

    /// Vertices per frame.
    pub fn vertex_count(&self) -> usize {
        self.vertex_count
    }

    /// Frames over every clip.
    pub fn frame_count(&self) -> usize {
        self.clips.iter().map(|clip| clip.frames as usize).sum()
    }

    /// The clips in bake order.
    pub fn clips(&self) -> &[VatClip] {
        &self.clips
    }

    /// Every frame's positions, frame-major.
    pub fn positions(&self) -> &[[f32; 3]] {
        &self.positions
    }

    /// Every frame's unit normals, frame-major.
    pub fn normals(&self) -> &[[f32; 3]] {
        &self.normals
    }

    /// One frame's positions (empty past the last frame).
    pub fn frame_positions(&self, frame: u32) -> &[[f32; 3]] {
        self.frame_rows(&self.positions, frame)
    }

    /// One frame's normals (empty past the last frame).
    pub fn frame_normals(&self, frame: u32) -> &[[f32; 3]] {
        self.frame_rows(&self.normals, frame)
    }

    fn frame_rows<'a>(&self, rows: &'a [[f32; 3]], frame: u32) -> &'a [[f32; 3]] {
        let start = (frame as usize).saturating_mul(self.vertex_count);
        rows.get(start..start.saturating_add(self.vertex_count)).unwrap_or(&[])
    }

    /// Where `time` falls in clip `clip`'s frames (None for a clip the bake does not have): the
    /// CPU reference of the shader's frame pick. `wrap` folds a time outside the clip as
    /// [`crate::sample::sample`] does.
    pub fn sample_at(&self, clip: usize, time: f32, wrap: Wrap) -> Option<VatSample> {
        let row = self.clips.get(clip)?;
        let local = wrap_time(row.duration, time, wrap);
        let last = row.frames.saturating_sub(1);
        // A cast truncates, which is the floor here: `local` is never negative.
        let k = ((local * self.fps) as u32).min(last);
        let next = (k + 1).min(last);
        let (t0, t1) = (frame_time(k, self.fps, row.duration), frame_time(next, self.fps, row.duration));
        let blend = if t1 > t0 { ((local - t0) / (t1 - t0)).clamp(0.0, 1.0) } else { 0.0 };
        Some(VatSample { frame0: row.first_frame + k, frame1: row.first_frame + next, blend })
    }
}

/// The time of frame `k` of a clip of `duration` baked at `fps`: `k / fps`, never past the end.
fn frame_time(k: u32, fps: f32, duration: f32) -> f32 {
    (k as f32 / fps).min(duration)
}

/// The scratch one frame of the bake works in: the pose, model transforms and palette.
struct Frame {
    rest: Vec<Trs>,
    pose: Vec<Trs>,
    model: Vec<Mat4>,
    palette: Vec<[f32; 16]>,
    cursor: SampleCursor,
}

impl Frame {
    fn new(skeleton: &Skeleton) -> Frame {
        Frame {
            rest: skeleton.rest_pose().to_vec(),
            pose: skeleton.rest_pose().to_vec(),
            model: vec![Mat4::IDENTITY; skeleton.joint_count()],
            palette: vec![Mat4::IDENTITY.to_cols_array(); skeleton.skin_joint_count()],
            cursor: SampleCursor::new(),
        }
    }

    /// The palette of `clip` at `time`, sampled from the rest pose.
    fn pose(&mut self, skeleton: &Skeleton, clip: &Clip, time: f32) {
        self.pose.clone_from(&self.rest);
        sample(clip, time, Wrap::Clamp, &mut self.cursor, &mut self.pose);
        skeleton.local_to_model(&self.pose, &mut self.model);
        skeleton.palette(&self.model, &mut self.palette);
    }

    /// Every vertex of `skin` under this frame's palette, appended.
    fn skin(&self, skin: &VatSkin<'_>, positions: &mut Vec<[f32; 3]>, normals: &mut Vec<[f32; 3]>) {
        let rows = skin.positions.iter().zip(skin.normals).zip(skin.joints.iter().zip(skin.weights));
        for ((position, normal), (joints, weights)) in rows {
            let m = self.blend(joints, weights);
            positions.push((m * Vec4::from((Vec3::from(*position), 1.0))).truncate().to_array());
            normals.push((m * Vec4::from((Vec3::from(*normal), 0.0))).truncate().normalize_or(Vec3::Y).to_array());
        }
    }

    /// The four slots' matrices blended by their weights, in slot order (as the compute pass sums).
    fn blend(&self, joints: &[u32; 4], weights: &[f32; 4]) -> Mat4 {
        let mut m = Mat4::ZERO;
        for (joint, weight) in joints.iter().zip(weights) {
            let matrix = self.palette.get(*joint as usize).map_or(Mat4::IDENTITY, Mat4::from_cols_array);
            m += matrix * *weight;
        }
        m
    }
}

fn refused(detail: String) -> AnimationError {
    AnimationError::asset_invalid(format!("vertex-animation bake: {detail}"))
}

fn check_skin(skin: &VatSkin<'_>) -> Result<(), AnimationError> {
    let count = skin.positions.len();
    let lengths = [skin.normals.len(), skin.joints.len(), skin.weights.len()];
    if lengths.iter().any(|length| *length != count) {
        return Err(refused(format!("{count} positions but {lengths:?} normals, joints and weights")));
    }
    if count == 0 || count > VAT_VERTICES_MAX {
        return Err(refused(format!("{count} vertices; 1..={VAT_VERTICES_MAX}")));
    }
    let finite = |row: &[f32; 3]| row.iter().all(|value| value.is_finite());
    if !skin.positions.iter().chain(skin.normals).all(finite) {
        return Err(refused("a position or normal that is not finite".to_owned()));
    }
    Ok(())
}

fn check_rate(fps: f32) -> Result<(), AnimationError> {
    let in_range = fps.is_finite() && fps > 0.0 && fps <= VAT_FPS_MAX;
    if in_range { Ok(()) } else { Err(refused(format!("{fps} frames per second; above 0, at most {VAT_FPS_MAX}"))) }
}

/// Each clip's frame range, in order.
fn clip_table(clips: &[Clip], fps: f32) -> Result<Vec<VatClip>, AnimationError> {
    if clips.is_empty() {
        return Err(refused("no clip".to_owned()));
    }
    let mut table = Vec::with_capacity(clips.len());
    let mut first = 0usize;
    for clip in clips {
        let duration = clip.duration();
        let frames = frames_ceil(duration * fps).saturating_add(1);
        if first.saturating_add(frames) > VAT_FRAMES_MAX {
            return Err(refused(format!("more than {VAT_FRAMES_MAX} frames at {fps} frames per second")));
        }
        table.push(VatClip { name: clip.name().to_owned(), first_frame: first as u32, frames: frames as u32, duration });
        first += frames;
    }
    Ok(table)
}

/// `ceil(x)` of a clip's length in frames, for a finite `x >= 0` (a cast truncates exactly, the
/// same bits on every destination; a non-finite length saturates and is refused by the cap).
fn frames_ceil(x: f32) -> usize {
    let whole = x as usize;
    if (whole as f32) < x { whole + 1 } else { whole }
}
