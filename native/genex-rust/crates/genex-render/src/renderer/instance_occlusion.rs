//! The renderer's half of instance occlusion ([`crate::occlusion`]): each frame decides which views
//! occlude, keeps their Hi-Z pyramids in the target pool, writes the cull's uniform rows, then
//! runs a cascade's second phase after its first draws and the camera's final phase after the
//! prepass.

use wgpu::{CommandEncoder, LoadOp};

use super::shadow_cache_draw::depth_pass;
use super::{FramePrep, FrameStats, HizPyramid, Renderer};
use crate::cull::{CullBuffers, CullOcclusion};
use crate::error::RenderError;
use crate::graph::FrameEncoder;
use crate::hiz::{HizInput, HizNode};
use crate::layout::MAX_CASCADES;
use crate::occlusion::{
    CAMERA_HIZ_LABEL, FrameOcclusion, GpuOcclusionCull, InstanceOcclusion, SHADOW_HIZ_LABEL, final_row_index, first_row_index, history_region, occlusion_runs,
    second_row_index,
};
use crate::scene::FramePlan;
use crate::settings::ShadowFormat;
use crate::shadow_cache::LayerUse;
use crate::tables::PASS_VIEW_STRIDE;
use crate::{CullPath, hiz};

impl Renderer {
    /// Draw the instance path's copies with Hi-Z occlusion where it pays (`Auto`, the default) or
    /// never (`Off`): [`crate::occlusion`]. Either way the pictures are the same.
    pub fn set_instance_occlusion(&mut self, setting: InstanceOcclusion) {
        self.occlusion.setting = setting;
    }

    /// Whether the instance path may occlude ([`Renderer::set_instance_occlusion`]).
    pub fn instance_occlusion(&self) -> InstanceOcclusion {
        self.occlusion.setting
    }

    /// Decide what this frame of `plan` on `path` occludes (`prepass`: the frame runs one;
    /// `reversed`: its camera depth is reversed), keep the pyramids it needs and write the
    /// cull's uniform rows. Called once the frame's targets and the shadow cache's plan are known.
    pub(super) fn prepare_occlusion(&mut self, plan: &FramePlan, path: CullPath, prepass: bool, reversed: bool) -> Result<FrameOcclusion, RenderError> {
        let rows = plan.instances.len() as u32;
        let gpu = path == CullPath::Gpu && !plan.batches.is_empty();
        let runs = gpu && occlusion_runs(self.occlusion.setting, rows);
        // What came back of earlier frames' counts: a view that did not pay sits out a while.
        self.occlusion.take_feedback(&self.device, self.frame_index);
        let frame_index = self.frame_index;
        let camera = runs && prepass && self.samples == 1 && self.occlusion.may_occlude(0, frame_index);
        let live = !self.environment_settle;
        // Meshlet casters draw outside the instance lists: a frame drawing them occludes no cascade.
        let meshlets = self.meshlet_game.drawn(&self.quality).0;
        let mut cascades = 0;
        if runs && live && !meshlets {
            for cascade in (0..plan.cascades_drawn().min(MAX_CASCADES)).filter(|c| self.shadow_draws.draws(*c)) {
                if self.shadow_cache.layer(cascade).0 == LayerUse::Draw && self.occlusion.may_occlude(1 + cascade as u32, frame_index) {
                    cascades |= 1 << (1 + cascade);
                }
            }
        }
        let frame = self.occlusion.plan(&self.device, &self.queue, &plan.motion, rows, (camera, cascades, live))?;
        self.keep_occlusion_pyramids(&frame)?;
        let mut rows = vec![(first_row_index(), frame.first_row())];
        if frame.cascades != 0
            && let Some(set) = plan.cascades.as_ref()
        {
            let side = self.shadow_desc.side;
            let base = hiz::base_size((side, side));
            for cascade in (0..MAX_CASCADES).filter(|c| frame.cascade(*c)) {
                rows.push((second_row_index(cascade), frame.second_row(cascade, set.view_proj[cascade], (base, hiz::mip_count(base)), side)));
            }
        }
        if frame.camera {
            let render = self.targets.render_size;
            let base = hiz::base_size(render);
            rows.push((final_row_index(), frame.final_row(plan.frame.view_proj, (base, hiz::mip_count(base)), render, reversed)));
        }
        self.occlusion.write_rows(&self.queue, &rows);
        Ok(frame)
    }

    /// Keep the camera's and the cascades' pyramids (and their builds) while `frame` occludes
    /// them, and give their bytes back to the pool when it does not.
    fn keep_occlusion_pyramids(&mut self, frame: &FrameOcclusion) -> Result<(), RenderError> {
        if frame.camera {
            let desc = crate::target_pool::TargetDesc { label: CAMERA_HIZ_LABEL, ..hiz::target(self.targets.render_size) };
            let target = self.pool.acquire(&self.device, desc)?;
            self.occlusion_pyramid = Some(HizPyramid { texture: target.texture().clone(), view: target.view().clone() });
            if self.occlusion_hiz.get_mut().is_none() {
                *self.occlusion_hiz.get_mut() = Some(HizNode::new(&self.device)?);
            }
        } else if self.occlusion_pyramid.take().is_some() {
            self.pool.release(CAMERA_HIZ_LABEL);
        }
        if frame.cascades != 0 {
            let side = self.shadow_desc.side;
            let desc = crate::target_pool::TargetDesc { label: SHADOW_HIZ_LABEL, ..hiz::target((side, side)) };
            let target = self.pool.acquire(&self.device, desc)?;
            self.shadow_pyramid = Some(HizPyramid { texture: target.texture().clone(), view: target.view().clone() });
            let builds = self.shadow_hiz.get_mut();
            while builds.len() < MAX_CASCADES {
                builds.push(HizNode::new(&self.device)?);
            }
        } else if self.shadow_pyramid.take().is_some() {
            self.pool.release(SHADOW_HIZ_LABEL);
        }
        Ok(())
    }

    /// After a frame that occluded (`frame`): its views' counts on their way back.
    pub(super) fn read_back_occlusion(&mut self, frame: &FrameOcclusion) {
        let views = frame.cascades | u32::from(frame.camera);
        self.occlusion.read_back(&self.device, &self.queue, views);
    }

    /// One cull dispatch over `plan` with `occlusion`.
    pub(super) fn encode_cull_dispatch(&self, encoder: &mut CommandEncoder, plan: &FramePlan, occlusion: CullOcclusion<'_>, timestamps: Option<wgpu::ComputePassTimestampWrites<'_>>) {
        let buffers = CullBuffers {
            views: &self.cull_views,
            instances: self.tables.instances.get(),
            batches: self.tables.batches.get(),
            visible: self.tables.visible.get(),
            args: self.tables.args.get(),
            scratch: self.tables.cull_scratch.get(),
            lod_rows: self.tables.lod_rows.get(),
            fades: self.tables.instance_fade.get(),
            far_rules: self.tables.far_rules.get(),
        };
        self.cull.encode(&self.device, encoder, &buffers, plan.visible_slots, occlusion, timestamps);
    }

    /// The first phase's occlusion inputs: every view, the history to read.
    pub(super) fn first_occlusion(&self, plan: &FramePlan) -> CullOcclusion<'_> {
        CullOcclusion { uniform: &self.occlusion.uniform, row: first_row_index(), hiz: None, history: self.occlusion.history(), views: plan.views }
    }

    /// After occluded cascade `cascade`'s first draws: its Hi-Z, the second phase and the second
    /// draws over the first; answers the render passes opened. A Hi-Z that cannot be built draws
    /// every copy the first phase left, so the map is whole either way.
    pub(super) fn encode_cascade_second(&self, encoder: &mut CommandEncoder, prep: &FramePrep, cascade: usize, stats: &mut FrameStats) -> u32 {
        let frame = &prep.occlusion;
        let (Some(pyramid), Some(history)) = (self.shadow_pyramid.as_ref(), self.occlusion.history()) else { return 0 };
        if !frame.cascade(cascade) || cascade >= self.shadow_maps.layers.len() {
            return 0;
        }
        let side = self.shadow_desc.side;
        let view = 1 + cascade as u32;
        let built = self.shadow_hiz.borrow_mut().get_mut(cascade).is_some_and(|build| {
            let input = HizInput { depth: &self.shadow_maps.layers[cascade], pyramid: &pyramid.texture, render: (side, side), reduce: hiz::reduction(false) };
            build.encode(&self.device, &self.queue, encoder, input).is_ok()
        });
        if !built {
            // This frame's row, rewritten before the frame is submitted: the frustum only.
            let row = GpuOcclusionCull { params: [crate::occlusion::OcclusionPhase::Second as u32, view, frame.valid, 0], ..GpuOcclusionCull::default() };
            self.occlusion.write_rows(&self.queue, &[(second_row_index(cascade), row)]);
        }
        let region = history_region(frame.stride, frame.slots.1, view);
        encoder.clear_buffer(history, region, Some(u64::from(frame.stride) * 4));
        let occlusion = CullOcclusion { uniform: &self.occlusion.uniform, row: second_row_index(cascade), hiz: Some(&pyramid.view), history: Some(history), views: 1 };
        self.encode_cull_dispatch(encoder, &prep.plan, occlusion, None);
        let (groups, plan) = (&prep.groups, &prep.plan);
        let mut pass = depth_pass(encoder, "shadow cascade second", &self.shadow_maps.layers[cascade], LoadOp::Load);
        let pipeline = if self.shadow_desc.format == ShadowFormat::Depth16.texture_format() { &self.pipelines.shadow16 } else { &self.pipelines.shadow };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &groups.shadow, &[]);
        pass.set_bind_group(1, &groups.pass, &[(u64::from(view) * PASS_VIEW_STRIDE) as u32]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        self.draw_batches(&mut pass, plan, view, None, None, stats);
        self.draw_caster_variants(&mut pass, (&groups.pass, &groups.pass_fade), (plan, view), self.shadow_desc.format, None, stats);
        stats.occluded_views |= 1 << view;
        1
    }

    /// After the prepass: the camera's Hi-Z of its depth and the final phase, which leaves the
    /// camera's lists the copies something can see; answers whether it ran.
    pub(super) fn encode_camera_final(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> bool {
        if !prep.occlusion.camera {
            return false;
        }
        let (Some(targets), Some(pyramid)) = (self.targets.prepass.as_ref(), self.occlusion_pyramid.as_ref()) else { return false };
        let queue = frame.queue().clone();
        let built = self.occlusion_hiz.borrow_mut().as_mut().is_some_and(|build| {
            let input = HizInput { depth: &targets.depth_view, pyramid: &pyramid.texture, render: self.targets.render_size, reduce: hiz::reduction(self.path.depth_reversed) };
            build.encode(&self.device, &queue, frame.encoder(), input).is_ok()
        });
        // Without its Hi-Z the camera keeps the first phase's lists: every copy in view.
        if !built {
            return false;
        }
        let occlusion = CullOcclusion { uniform: &self.occlusion.uniform, row: final_row_index(), hiz: Some(&pyramid.view), history: self.occlusion.history(), views: 1 };
        self.encode_cull_dispatch(frame.encoder(), &prep.plan, occlusion, None);
        true
    }
}
