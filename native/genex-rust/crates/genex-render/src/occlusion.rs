//! Instance occlusion (horde 10k, HZ-1): Hi-Z occlusion culling of the instance path's draws, in
//! the camera and in the sun's cascades, so a packed crowd, a forest or a city block draws only
//! the copies something can see. The instance cull (`shaders/cull.wgsl`) runs in phases:
//!
//! - **The camera** (one pass, exact): the prepass draws every copy in the frustum, a Hi-Z of its
//!   depth is built, and the camera's lists are culled again against it ([`OcclusionPhase::Final`])
//!   before the world pass, the screen effects and TAA's reactive pass read them. A copy the
//!   Hi-Z hides would have failed every depth test of the world pass, so the picture is the one
//!   without occlusion, bit for bit; only the work of drawing it goes.
//! - **A sun cascade** (two passes, Haar/Aaltonen): the cull's first phase
//!   ([`OcclusionPhase::History`]) keeps, in an occluded cascade, the copies that cascade saw last
//!   frame; the cascade draws them, its Hi-Z is built from that depth, the second phase
//!   ([`OcclusionPhase::Second`]) re-tests every copy in the cascade against it, writes the next
//!   frame's history and keeps the visible copies the first phase did not draw, and the cascade
//!   draws those over the first. The history only decides what draws first: the map is the one
//!   without occlusion either way. A low sun, where a crowd's front rows hide the rest from the
//!   sun as from the camera, is where it pays most.
//! - **History** is one word per (view, row) in [`HISTORY_SLOTS`] slots: two for Live (one read,
//!   one written, in turn) and one spare. A row finds last frame's through its identity
//!   ([`RowHistory`]: the draw id, else the mesh and its ordinal, as motion vectors match rows), so
//!   a copy that changes mesh (a crowd's baked poses) keeps it. A row without a match, a view
//!   whose last frame wrote no history, and every settled capture draw every copy first.
//! - **When it runs** ([`occlusion_runs`]): on the GPU-driven instance path of a frame of at least
//!   [`INSTANCE_OCCLUSION_MIN_ROWS`] opaque rows, unless the game or a test turned it off
//!   ([`InstanceOcclusion::Off`]). The camera needs the prepass and a one-sample world pass (a
//!   Hi-Z of the single-sample prepass would cull a copy seen only through an edge pixel's
//!   uncovered samples) and stands down while meshlet occlusion runs (it owns the prepass's
//!   second part); a cascade must be drawn whole this frame (not held by its cadence, not drawn
//!   from the static shadow cache) on a Live frame. Spot shadows are not occluded.
//! - **Whether it pays** ([`occlusion_pays`]): each Hi-Z phase counts the rows it tested and those
//!   it found visible, and the counts come back to the CPU a frame or two later
//!   ([`OcclusionState`]'s readback). A view whose Hi-Z hid less than [`OCCLUSION_PAYS_MIN`] of what
//!   it tested (an open field, a crowd seen from above) sits out [`OCCLUSION_RETRY_FRAMES`], then
//!   measures again; only the cost changes, never a picture.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use bytemuck::{Pod, Zeroable};
use wgpu::{Buffer, BufferUsages, Device, Queue};

use crate::error::RenderError;
use crate::layout::MAX_CASCADES;
use crate::motion::MotionRow;

/// The fewest opaque instance rows a frame needs before its views are occluded: below it the
/// Hi-Z builds and the cascades' second passes cost more than a scene that small can hide.
pub const INSTANCE_OCCLUSION_MIN_ROWS: u32 = 1024;
/// Views a history keeps: the camera and the cascades (`shaders/cull.wgsl` `GX_OCC_VIEWS`).
pub const OCCLUSION_VIEWS: u32 = 1 + MAX_CASCADES as u32;
/// History slots: Live's pair (read and written in turn) and one spare.
pub const HISTORY_SLOTS: u32 = 3;
/// A row with no last-frame row (`GX_OCC_NO_ROW`).
pub const NO_ROW: u32 = u32::MAX;
/// The uniform rows a frame writes: the first phase, each cascade's second, the camera's final.
pub const OCCLUSION_DISPATCHES: u32 = 2 + MAX_CASCADES as u32;
/// Bytes between two dispatches' uniform rows (WebGPU's dynamic-offset alignment).
pub const OCCLUSION_ROW_STRIDE: u64 = 256;
/// The pool label of the camera's Hi-Z pyramid (its budget-ledger row).
pub const CAMERA_HIZ_LABEL: &str = "instance hi-z";
/// The pool label of the cascades' Hi-Z pyramid, shared by every cascade in turn.
pub const SHADOW_HIZ_LABEL: &str = "shadow hi-z";
/// The renderer's held-resource ledger label of the history buffer.
pub const HISTORY_LEDGER_LABEL: &str = "occlusion history";

/// Whether a game's frames may occlude their instances.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum InstanceOcclusion {
    /// Occlude where [`occlusion_runs`] says it pays (the default).
    #[default]
    Auto,
    /// Never: every copy in a frustum draws.
    Off,
}

/// A cull dispatch's phase (`occ.params.x`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum OcclusionPhase {
    /// Frustum and level of detail only.
    Frustum = 0,
    /// Every view: an occluded cascade keeps what it saw last frame.
    History = 1,
    /// One cascade after its first draws: the copies its Hi-Z shows that the first phase left.
    Second = 2,
    /// The camera after the whole prepass: the copies its Hi-Z shows.
    Final = 3,
}

/// The uniform row of one cull dispatch (`OcclusionCull` in `shaders/cull.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuOcclusionCull {
    /// x the phase, y the dispatch's first view, z the views whose history is usable (bit per
    /// view), w the occluded views.
    pub params: [u32; 4],
    /// x the history slot read, y the slot written, z the history's stride (rows), w 1 under
    /// reverse-Z.
    pub history: [u32; 4],
    /// The Hi-Z's mip 0 size and mips.
    pub hiz: [u32; 4],
    /// The size of the depth the Hi-Z was built from.
    pub render: [f32; 4],
    /// The tested view's projection × view, column-major.
    pub view_proj: [f32; 16],
}

/// Whether a frame of `rows` opaque rows under `setting` occludes its views.
pub const fn occlusion_runs(setting: InstanceOcclusion, rows: u32) -> bool {
    matches!(setting, InstanceOcclusion::Auto) && rows >= INSTANCE_OCCLUSION_MIN_ROWS
}

/// What a frame occludes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameOcclusion {
    /// The camera's final cull runs.
    pub camera: bool,
    /// Bit `1 + c`: cascade `c` runs both phases.
    pub cascades: u32,
    /// Bit per view: its history from last frame is usable.
    pub valid: u32,
    /// The history slot read and the one written.
    pub slots: (u32, u32),
    /// The history's stride, rows.
    pub stride: u32,
}

impl FrameOcclusion {
    /// Whether anything is occluded.
    pub const fn any(&self) -> bool {
        self.camera || self.cascades != 0
    }

    /// Whether cascade `cascade` is occluded.
    pub const fn cascade(&self, cascade: usize) -> bool {
        (self.cascades >> (1 + cascade)) & 1 != 0
    }

    /// The first phase's row: every view, the occluded cascades keeping last frame's set.
    pub fn first_row(&self) -> GpuOcclusionCull {
        let phase = if self.cascades != 0 { OcclusionPhase::History } else { OcclusionPhase::Frustum };
        GpuOcclusionCull {
            params: [phase as u32, 0, self.valid, self.cascades],
            history: [self.slots.0, self.slots.1, self.stride, 0],
            ..GpuOcclusionCull::default()
        }
    }

    /// Cascade `cascade`'s second-phase row against its Hi-Z (`hiz`: mip 0 size and mips) of a
    /// `side`-texel map drawn through `view_proj`.
    pub fn second_row(&self, cascade: usize, view_proj: [f32; 16], hiz: ((u32, u32), u32), side: u32) -> GpuOcclusionCull {
        let ((w, h), mips) = hiz;
        GpuOcclusionCull {
            params: [OcclusionPhase::Second as u32, 1 + cascade as u32, self.valid, self.cascades],
            history: [self.slots.0, self.slots.1, self.stride, 0],
            hiz: [w, h, mips, 0],
            render: [side as f32, side as f32, 0.0, 0.0],
            view_proj,
        }
    }

    /// The camera's final row against its Hi-Z of the `render`-sized prepass drawn through
    /// `view_proj` (`reversed`: reverse-Z).
    pub fn final_row(&self, view_proj: [f32; 16], hiz: ((u32, u32), u32), render: (u32, u32), reversed: bool) -> GpuOcclusionCull {
        let ((w, h), mips) = hiz;
        GpuOcclusionCull {
            params: [OcclusionPhase::Final as u32, 0, 0, 1],
            history: [0, 0, self.stride, u32::from(reversed)],
            hiz: [w, h, mips, 0],
            render: [render.0 as f32, render.1 as f32, 0.0, 0.0],
            view_proj,
        }
    }
}

/// Last frame's rows by identity: each row's packed key ([`crate::motion::packed`]), sorted with
/// its row, so this frame's rows find theirs.
#[derive(Clone, Debug, Default)]
pub struct RowHistory {
    sorted: Vec<(u128, u32)>,
    rows: u32,
}

impl RowHistory {
    /// Each of this frame's rows' last-frame row ([`NO_ROW`] when none matched), then remember
    /// this frame's. Without identities (`motion` empty: a frame that draws no motion vectors)
    /// a row is last frame's row of the same index while the row count stands.
    pub fn advance(&mut self, motion: &[MotionRow], rows: u32) -> Vec<u32> {
        let previous = std::mem::take(&mut self.sorted);
        let prev_rows: Vec<u32> = if motion.len() == rows as usize && !previous.is_empty() {
            motion
                .iter()
                .map(|row| {
                    let key = crate::motion::packed(&row.key);
                    previous.binary_search_by_key(&key, |(key, _)| *key).map_or(NO_ROW, |at| previous[at].1)
                })
                .collect()
        } else if motion.is_empty() && previous.is_empty() && self.rows == rows {
            (0..rows).collect()
        } else {
            vec![NO_ROW; rows as usize]
        };
        if motion.len() == rows as usize {
            let mut sorted: Vec<(u128, u32)> = motion.iter().enumerate().map(|(at, row)| (crate::motion::packed(&row.key), at as u32)).collect();
            sorted.sort_unstable_by_key(|(key, _)| *key);
            self.sorted = sorted;
        }
        self.rows = rows;
        prev_rows
    }

    /// Forget every row.
    pub fn reset(&mut self) {
        self.sorted.clear();
        self.rows = 0;
    }
}

/// The history's words for `stride` rows: each row's last-frame row, then every slot's views,
/// then each view's tested and visible counts.
pub const fn history_words(stride: u32) -> u64 {
    stride as u64 * (1 + HISTORY_SLOTS as u64 * OCCLUSION_VIEWS as u64) + 2 * OCCLUSION_VIEWS as u64
}

/// The byte offset of the views' counts (`gx_occ_count_at`) in a history of `stride` rows.
pub const fn counts_offset(stride: u32) -> u64 {
    stride as u64 * (1 + HISTORY_SLOTS as u64 * OCCLUSION_VIEWS as u64) * 4
}

/// The counts' bytes: a tested and a visible count per view.
pub const COUNTS_BYTES: u64 = 2 * OCCLUSION_VIEWS as u64 * 4;
/// The least share of the rows a view's Hi-Z tested that it must hide for the view to keep
/// occluding: below it the Hi-Z builds and second passes cost more than they save.
pub const OCCLUSION_PAYS_MIN: f32 = 0.2;
/// Frames a view that did not pay stays unoccluded before it measures again.
pub const OCCLUSION_RETRY_FRAMES: u64 = 240;
/// Counts read back at once: one per frame in flight.
const FEEDBACK_RING: usize = 3;

/// Whether a view whose Hi-Z phase tested `tested` rows and found `visible` of them pays for its
/// occlusion: it hid at least [`OCCLUSION_PAYS_MIN`] of them (nothing tested: nothing to decide).
pub fn occlusion_pays(tested: u32, visible: u32) -> Option<bool> {
    (tested > 0).then(|| (tested - visible.min(tested)) as f32 >= OCCLUSION_PAYS_MIN * tested as f32)
}

/// The history's stride for a frame of `rows` rows: room for growth, so a crowd growing a little
/// never starts its history over.
pub const fn history_stride(rows: u32) -> u32 {
    let rows = if rows > INSTANCE_OCCLUSION_MIN_ROWS { rows } else { INSTANCE_OCCLUSION_MIN_ROWS };
    rows.next_power_of_two()
}

/// The history buffer's bytes for a frame of `rows` rows (the budget model's row).
pub const fn history_bytes(rows: u32) -> u64 {
    history_words(history_stride(rows)) * 4
}

/// The byte offset of view `view`'s region of slot `slot`, `stride` rows each.
pub const fn history_region(stride: u32, slot: u32, view: u32) -> u64 {
    stride as u64 * (1 + slot as u64 * OCCLUSION_VIEWS as u64 + view as u64) * 4
}

/// The renderer's occlusion state across frames: the history buffer and its stride, which slot
/// Live wrote last and for which views, the row identities and the uniform rows.
pub(crate) struct OcclusionState {
    pub(crate) setting: InstanceOcclusion,
    history: Option<Buffer>,
    stride: u32,
    /// The slot the last Live frame wrote, and the views it wrote.
    written: Option<(u32, u32)>,
    rows: RowHistory,
    pub(crate) uniform: Buffer,
    /// The counts in flight back to the CPU, and until which frame each view stays unoccluded
    /// because its last measured frame did not pay.
    feedback: Vec<Feedback>,
    next_feedback: usize,
    skip_until: [u64; OCCLUSION_VIEWS as usize],
}

/// One frame's counts on their way back: the staging buffer, whether its map completed, and the
/// views that frame occluded.
struct Feedback {
    buffer: Buffer,
    ready: Arc<AtomicBool>,
    views: Option<u32>,
}

impl OcclusionState {
    pub(crate) fn new(device: &Device) -> Result<OcclusionState, RenderError> {
        let uniform = crate::tables::buffer(device, "occlusion cull", OCCLUSION_ROW_STRIDE * u64::from(OCCLUSION_DISPATCHES), BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let feedback = (0..FEEDBACK_RING)
            .map(|_| {
                let buffer = crate::tables::buffer(device, "occlusion counts", COUNTS_BYTES, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
                Ok(Feedback { buffer, ready: Arc::new(AtomicBool::new(false)), views: None })
            })
            .collect::<Result<Vec<_>, RenderError>>()?;
        let skip_until = [0; OCCLUSION_VIEWS as usize];
        Ok(OcclusionState { setting: InstanceOcclusion::Auto, history: None, stride: 0, written: None, rows: RowHistory::default(), uniform, feedback, next_feedback: 0, skip_until })
    }

    /// Whether view `view` (0 the camera, `1 + c` cascade `c`) may occlude on frame `frame`: its
    /// last measured frame paid, or it is time to measure again.
    pub(crate) fn may_occlude(&self, view: u32, frame: u64) -> bool {
        self.skip_until.get(view as usize).is_none_or(|until| frame >= *until)
    }

    /// After a frame that occluded `views` (bit per view) was submitted: copy its counts back
    /// (cleared for the next frame) in a submission of its own, then map them. A frame whose
    /// staging slot is still in flight skips its readback.
    pub(crate) fn read_back(&mut self, device: &Device, queue: &Queue, views: u32) {
        let Some(history) = self.history.as_ref().filter(|_| views != 0) else { return };
        let slot = &mut self.feedback[self.next_feedback];
        if slot.views.is_some() {
            return;
        }
        self.next_feedback = (self.next_feedback + 1) % FEEDBACK_RING;
        let offset = counts_offset(self.stride);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("occlusion counts") });
        encoder.copy_buffer_to_buffer(history, offset, &slot.buffer, 0, COUNTS_BYTES);
        encoder.clear_buffer(history, offset, Some(COUNTS_BYTES));
        queue.submit([encoder.finish()]);
        slot.views = Some(views);
        slot.ready.store(false, Ordering::SeqCst);
        let ready = Arc::clone(&slot.ready);
        slot.buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| ready.store(result.is_ok(), Ordering::SeqCst));
    }

    /// Read every count that came back: a view that hid less than [`OCCLUSION_PAYS_MIN`] of what
    /// it tested stays unoccluded for [`OCCLUSION_RETRY_FRAMES`] from frame `frame`.
    pub(crate) fn take_feedback(&mut self, device: &Device, frame: u64) {
        let _ = device.poll(wgpu::PollType::Poll);
        for slot in &mut self.feedback {
            let Some(views) = slot.views.filter(|_| slot.ready.load(Ordering::SeqCst)) else { continue };
            let counts: Vec<u32> = match slot.buffer.slice(..).get_mapped_range() {
                Ok(range) => bytemuck::pod_collect_to_vec(&range[..]),
                Err(_) => Vec::new(),
            };
            slot.buffer.unmap();
            slot.views = None;
            for view in (0..OCCLUSION_VIEWS).filter(|view| views >> view & 1 != 0) {
                let at = 2 * view as usize;
                let (Some(tested), Some(visible)) = (counts.get(at), counts.get(at + 1)) else { continue };
                if occlusion_pays(*tested, *visible) == Some(false) {
                    self.skip_until[view as usize] = frame + OCCLUSION_RETRY_FRAMES;
                }
            }
        }
    }


    /// The history buffer (None before an occluded frame).
    pub(crate) fn history(&self) -> Option<&Buffer> {
        self.history.as_ref()
    }

    /// Bytes the history holds (the ledger row).
    pub(crate) fn bytes(&self) -> u64 {
        self.history.as_ref().map_or(0, Buffer::size)
    }

    /// Plan a frame of `rows` opaque rows that occludes the camera (`camera`) and the cascades of
    /// `cascades` (bit `1 + c`) on a Live frame (`live`): room for the history, each row's
    /// last-frame row written, and the slots. A frame occluding nothing forgets the history.
    pub(crate) fn plan(&mut self, device: &Device, queue: &Queue, motion: &[MotionRow], rows: u32, (camera, cascades, live): (bool, u32, bool)) -> Result<FrameOcclusion, RenderError> {
        let cascades = if live { cascades } else { 0 };
        if !camera && cascades == 0 {
            // A settled capture keeps Live's history; a Live frame occluding nothing ends it.
            if live {
                self.written = None;
                self.rows.reset();
            }
            return Ok(FrameOcclusion::default());
        }
        if rows > self.stride || self.history.is_none() {
            let stride = history_stride(rows);
            // COPY_SRC: the views' counts go back to the CPU (`read_back`).
            let usage = BufferUsages::STORAGE | BufferUsages::COPY_DST | BufferUsages::COPY_SRC;
            self.history = Some(crate::tables::buffer(device, "occlusion history", history_words(stride) * 4, usage)?);
            self.stride = stride;
            self.written = None;
            self.rows.reset();
        }
        if !live {
            // The camera's final phase reads no history: a capture leaves Live's alone.
            return Ok(FrameOcclusion { camera, stride: self.stride, ..FrameOcclusion::default() });
        }
        let prev_rows = self.rows.advance(motion, rows);
        let read = self.written.map_or(0, |(slot, _)| slot);
        let write = if cascades == 0 { read } else { 1 - read };
        let valid = self.written.map_or(0, |(_, views)| views) & cascades;
        if let Some(history) = self.history.as_ref() {
            queue.write_buffer(history, 0, bytemuck::cast_slice(&prev_rows));
        }
        self.written = (cascades != 0).then_some((write, cascades));
        Ok(FrameOcclusion { camera, cascades, valid, slots: (read, write), stride: self.stride })
    }

    /// Write the frame's uniform rows: the first phase, each cascade's second, the camera's final.
    pub(crate) fn write_rows(&self, queue: &Queue, rows: &[(u32, GpuOcclusionCull)]) {
        for (at, row) in rows {
            queue.write_buffer(&self.uniform, u64::from(*at) * OCCLUSION_ROW_STRIDE, bytemuck::bytes_of(row));
        }
    }
}

/// The uniform row index of the first phase, of cascade `c`'s second phase and of the camera's final.
pub const fn first_row_index() -> u32 {
    0
}

/// See [`first_row_index`].
pub const fn second_row_index(cascade: usize) -> u32 {
    1 + cascade as u32
}

/// See [`first_row_index`].
pub const fn final_row_index() -> u32 {
    1 + MAX_CASCADES as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motion::{DrawId, MotionKey, MotionScope};
    use crate::scene::MeshId;

    fn row(id: u64) -> MotionRow {
        MotionRow { key: MotionKey { scope: MotionScope::Id { id: DrawId::from(id), skinned: false }, ordinal: 0 }, mesh: MeshId::CUBE, skinned_base: None }
    }

    #[test]
    fn a_row_finds_last_frames_row_by_identity_whatever_its_place() {
        let mut history = RowHistory::default();
        assert_eq!(history.advance(&[row(1), row(2), row(3)], 3), vec![NO_ROW; 3], "a first frame has no history");
        // The rows reorder (a copy changed mesh, so its batch moved) and one is new.
        assert_eq!(history.advance(&[row(3), row(1), row(9), row(2)], 4), vec![2, 0, NO_ROW, 1]);
        // Without identities the row count must stand for rows to keep their places.
        assert_eq!(history.advance(&[], 4), vec![NO_ROW; 4], "identities gone: nothing matches");
        assert_eq!(history.advance(&[], 4), vec![0, 1, 2, 3]);
        assert_eq!(history.advance(&[], 5), vec![NO_ROW; 5]);
    }

    #[test]
    fn a_view_pays_when_its_hi_z_hides_a_fifth_of_what_it_tested() {
        assert_eq!(occlusion_pays(0, 0), None, "nothing tested, nothing decided");
        assert_eq!(occlusion_pays(1000, 1000), Some(false), "an open field");
        assert_eq!(occlusion_pays(1000, 801), Some(false));
        assert_eq!(occlusion_pays(1000, 800), Some(true));
        assert_eq!(occlusion_pays(1000, 3), Some(true), "a walled scene");
        assert_eq!(occlusion_pays(10, 99), Some(false), "a count past the tested rows is read as all visible");
    }

    #[test]
    fn occlusion_runs_for_crowds_unless_turned_off() {
        assert!(!occlusion_runs(InstanceOcclusion::Auto, INSTANCE_OCCLUSION_MIN_ROWS - 1));
        assert!(occlusion_runs(InstanceOcclusion::Auto, INSTANCE_OCCLUSION_MIN_ROWS));
        assert!(!occlusion_runs(InstanceOcclusion::Off, 1 << 20));
    }

    #[test]
    fn the_rows_name_their_phase_view_and_history() {
        let frame = FrameOcclusion { camera: true, cascades: 0b0110, valid: 0b0010, slots: (1, 0), stride: 2048 };
        assert!(frame.cascade(0) && frame.cascade(1) && !frame.cascade(2));
        assert_eq!(frame.first_row().params, [OcclusionPhase::History as u32, 0, 0b0010, 0b0110]);
        let second = frame.second_row(1, [0.0; 16], ((1024, 1024), 11), 2048);
        assert_eq!(second.params[..2], [OcclusionPhase::Second as u32, 2]);
        assert_eq!(second.history, [1, 0, 2048, 0]);
        let last = frame.final_row([0.0; 16], ((960, 540), 11), (1920, 1080), true);
        assert_eq!((last.params[0], last.params[3], last.history[3]), (OcclusionPhase::Final as u32, 1, 1));
        let off = FrameOcclusion { camera: true, ..FrameOcclusion::default() };
        assert_eq!(off.first_row().params[0], OcclusionPhase::Frustum as u32, "no cascade: the first phase culls frustum only");
        assert_eq!(history_region(2048, 1, 2), 2048 * (1 + 5 + 2) * 4);
    }
}
