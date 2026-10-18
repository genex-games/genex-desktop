//! The cached shadow layers' passes (renderer pass 2, B.6; [`crate::shadow_cache`]): a layer the
//! frame's cache plan draws from the cache gets, on a rebuild, its static casters drawn into the
//! cache layer; then the cache layer copied into the shadow map's layer; then the overlay (the
//! terrain's and grass's casters, every batch the cache does not hold, skinned ones included)
//! drawn over the copy, when an overlay caster reaches the layer. A held layer opens no pass; a
//! layer the plan draws whole takes the uncached pass.

use std::ops::Range;

use wgpu::{BindGroup, CommandEncoder, LoadOp, RenderPass, RenderPipeline, TextureView};

use super::{FramePrep, FrameStats, Renderer};
use crate::scene::FramePlan;
use crate::settings::ShadowFormat;
use crate::shadow_cache::{LayerUse, copy_layer};
use crate::tables::{ARGS_STRIDE, PASS_VIEW_STRIDE, variant_pass_entry};

/// A depth-only pass over `view`, cleared or loaded.
fn depth_pass<'e>(encoder: &'e mut CommandEncoder, label: &'static str, view: &TextureView, load: LoadOp<f32>) -> RenderPass<'e> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view,
            depth_ops: Some(wgpu::Operations { load, store: wgpu::StoreOp::Store }),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    })
}

impl Renderer {
    /// Cascade `cascade`'s map as the frame's cache plan says (held, from the cache with the
    /// overlay, or the uncached pass, [`Renderer::encode_shadow`]); answers the render passes opened.
    pub(super) fn encode_shadow_layer(&self, encoder: &mut CommandEncoder, prep: &FramePrep, cascade: usize, counts: Option<&[u32]>, stats: &mut FrameStats) -> u32 {
        let (used, cache) = if counts.is_none() { self.shadow_cache.layer(cascade) } else { (LayerUse::Draw, None) };
        let cache = match (used, cache) {
            (LayerUse::Hold, _) => {
                stats.shadow_layers_cached += 1;
                return 0;
            }
            (LayerUse::Rebuild | LayerUse::Reuse, Some(cache)) => cache,
            _ => {
                self.encode_shadow(encoder, prep, cascade, counts, stats);
                return 1;
            }
        };
        let mut passes = 0;
        if used == LayerUse::Rebuild {
            let mut pass = depth_pass(encoder, "shadow cascade cache", &cache.layers[cascade], LoadOp::Clear(1.0));
            self.draw_cascade_batches(&mut pass, prep, cascade, true, stats);
            passes += 1;
        }
        copy_layer(encoder, cache, &self.shadow_maps.texture, cascade as u32);
        stats.shadow_layers_cached += 1;
        if !self.shadow_cache.plan.reached(cascade) {
            return passes;
        }
        let mut pass = depth_pass(encoder, "shadow cascade overlay", &self.shadow_maps.layers[cascade], LoadOp::Load);
        self.draw_terrain_casters(&mut pass, prep, cascade);
        self.draw_grass_casters(&mut pass, prep, cascade);
        self.draw_cascade_batches(&mut pass, prep, cascade, false, stats);
        passes + 1
    }

    /// The spot atlas layer as the frame's cache plan says (held, from the cache with the
    /// overlay, or the uncached pass, [`Renderer::encode_spot_shadows`]); answers the render
    /// passes opened.
    pub(super) fn encode_spot_layer(&self, encoder: &mut CommandEncoder, prep: &FramePrep, counts: &[Option<&[u32]>], stats: &mut FrameStats) -> u32 {
        let layer = crate::spot_shadow::spot_layer(prep.plan.cascades_drawn() as u32);
        let uncached = counts.iter().any(Option::is_some);
        let (used, cache) = if uncached { (LayerUse::Draw, None) } else { self.shadow_cache.layer(layer as usize) };
        let cache = match (used, cache) {
            (LayerUse::Hold, _) => {
                stats.shadow_layers_cached += 1;
                return 0;
            }
            (LayerUse::Rebuild | LayerUse::Reuse, Some(cache)) => cache,
            _ => {
                self.encode_spot_shadows(encoder, prep, counts, stats);
                return 1;
            }
        };
        let mut passes = 0;
        if used == LayerUse::Rebuild {
            let mut pass = depth_pass(encoder, "spot shadows cache", &cache.layers[layer as usize], LoadOp::Clear(1.0));
            self.draw_spot_batches(&mut pass, prep, true, stats);
            passes += 1;
        }
        copy_layer(encoder, cache, &self.shadow_maps.texture, layer);
        stats.shadow_layers_cached += 1;
        let Some(target) = self.shadow_maps.layers.get(layer as usize).filter(|_| self.shadow_cache.plan.reached(layer as usize)) else { return passes };
        let mut pass = depth_pass(encoder, "spot shadows overlay", target, LoadOp::Load);
        self.draw_spot_batches(&mut pass, prep, false, stats);
        passes + 1
    }

    /// Cascade `cascade`'s plain and variant batches the cache holds (`cached`) or not.
    fn draw_cascade_batches(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, cascade: usize, cached: bool, stats: &mut FrameStats) {
        let (groups, plan) = (&prep.groups, &prep.plan);
        if plan.batches.is_empty() {
            return;
        }
        let view = 1 + cascade as u32;
        let depth16 = self.shadow_desc.format == ShadowFormat::Depth16.texture_format();
        let pipeline = if depth16 { &self.pipelines.shadow16 } else { &self.pipelines.shadow };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &groups.shadow, &[]);
        pass.set_bind_group(1, &groups.pass, &[(u64::from(view) * PASS_VIEW_STRIDE) as u32]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        self.draw_plain_runs(pass, plan, view, cached, stats);
        for run in &plan.variants {
            let Some(caster) = self.variants.caster(run.variant.index(), depth16) else { continue };
            self.draw_variant_runs(pass, (&groups.pass, caster), (plan, run), view, cached, stats);
        }
    }

    /// Every shadowed spot's batches the cache holds (`cached`) or not, each in its atlas tile.
    fn draw_spot_batches(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, cached: bool, stats: &mut FrameStats) {
        let (groups, plan) = (&prep.groups, &prep.plan);
        let Some(pipelines) = self.spot_shadow.as_ref() else { return };
        if plan.batches.is_empty() {
            return;
        }
        let t = &self.tables;
        let inputs = crate::spot_shadow::SpotShadowInputs {
            frame: &self.frame_uniforms,
            instances: t.instances.get(),
            visible: t.visible.get(),
            slot_base: t.slot_base.get(),
            light_ext: t.light_ext.get(),
        };
        let pipeline = pipelines.pipeline(self.shadow_desc.format);
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &pipelines.bind_group(&self.device, &inputs), &[]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        let cascades = plan.cascades_drawn() as u32;
        for spot in &plan.spot_shadows {
            let (x, y, side) = crate::spot_shadow::tile_rect(spot.slot, self.shadow_desc.side);
            pass.set_viewport(x as f32, y as f32, side as f32, side as f32, 0.0, 1.0);
            pass.set_scissor_rect(x, y, side, side);
            let view = crate::spot_shadow::spot_view(cascades, spot.slot);
            pass.set_bind_group(1, &groups.pass, &[(u64::from(view) * PASS_VIEW_STRIDE) as u32]);
            self.draw_plain_runs(pass, plan, view, cached, stats);
            // Spot casters draw a variant's batches with the plain spot pipeline (variants.rs).
            for run in &plan.variants {
                self.draw_variant_runs(pass, (&groups.pass, pipeline), (plan, run), view, cached, stats);
            }
        }
    }

    /// The plain batches of view `view` the cache holds (`cached`) or not, through the indirect
    /// arguments (the pipeline and groups bound).
    fn draw_plain_runs(&self, pass: &mut RenderPass<'_>, plan: &FramePlan, view: u32, cached: bool, stats: &mut FrameStats) {
        let sources = [
            (0..plan.static_batches, &self.meshes.vertices, &self.meshes.slots),
            (plan.static_batches..plan.plain_batches, self.tables.skinned.get(), self.tables.skinned_slots.get()),
        ];
        for (range, vertices, slots) in sources {
            let runs = self.shadow_cache.plan.runs(range, cached);
            self.draw_runs(pass, (vertices, slots), plan, view, &runs, stats);
        }
    }

    /// A variant run's batches of view `view` the cache holds (`cached`) or not, with `pipeline`
    /// through its rows of `pass_views`.
    fn draw_variant_runs(
        &self,
        pass: &mut RenderPass<'_>,
        (pass_views, pipeline): (&BindGroup, &RenderPipeline),
        (plan, run): (&FramePlan, &crate::scene::VariantRun),
        view: u32,
        cached: bool,
        stats: &mut FrameStats,
    ) {
        let library = self.shadow_cache.plan.runs(run.batches.start..run.skinned_from, cached);
        // Skinned batches are never cached.
        let skinned = if cached { run.batches.end..run.batches.end } else { run.skinned_from..run.batches.end };
        if library.is_empty() && skinned.is_empty() {
            return;
        }
        pass.set_pipeline(pipeline);
        pass.set_bind_group(1, pass_views, &[(variant_pass_entry(plan, view, run.variant.index()) * PASS_VIEW_STRIDE) as u32]);
        self.draw_runs(pass, (&self.meshes.vertices, &self.meshes.slots), plan, view, &library, stats);
        self.draw_runs(pass, (self.tables.skinned.get(), self.tables.skinned_slots.get()), plan, view, std::slice::from_ref(&skinned), stats);
    }

    /// `runs` of batches of view `view` from `vertices` and `slots`, one multi-draw each.
    fn draw_runs(&self, pass: &mut RenderPass<'_>, (vertices, slots): (&wgpu::Buffer, &wgpu::Buffer), plan: &FramePlan, view: u32, runs: &[Range<u32>], stats: &mut FrameStats) {
        let runs: Vec<&Range<u32>> = runs.iter().filter(|run| !run.is_empty()).collect();
        if runs.is_empty() {
            return;
        }
        let total = plan.batches.len() as u32;
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.set_vertex_buffer(1, slots.slice(..));
        for run in runs {
            let offset = (u64::from(view) * u64::from(total) + u64::from(run.start)) * ARGS_STRIDE;
            pass.multi_draw_indexed_indirect(self.tables.args.get(), offset, run.len() as u32);
            stats.multi_draws += 1;
            stats.indirect_draws += run.len() as u32;
        }
    }
}
