//! The impostors' place in the frame (game systems LOD-14; `crate::impostor::draw`): placed
//! with [`Renderer::set_impostors`] and, each frame, the copies the plan's camera draws at their
//! chain's impostor level (game systems LOD-15, [`FramePlan::impostor_instances`]: the cull's
//! CPU twin, equal to the GPU cull slot for slot). They are drawn after the terrain and its grass
//! in the world pass and the prepass (node 7, with their motion on frames writing motion), over
//! the impostor frame group (`impostor_frame_layout_entries`), the pass view and the impostor
//! group.
//!
//! A frame without placed impostors, or before a species was baked, makes no impostor pipeline,
//! group or table and costs what it did before.

use wgpu::RenderPass;

use super::{FrameGroups, FramePrep, FramePrepass, Renderer, ScenePath, depth_state, surface_constants};
use crate::error::RenderError;
use crate::impostor::draw::{IMPOSTOR_MOTION_GROUP, ImpostorDraw, ImpostorInstance, PipelineInputs, PrepassKey, WorldKey, class_of, writes_depth};
use crate::scene::FramePlan;

impl Renderer {
    /// Place `instances` for the next frames, replacing the ones placed before (game systems
    /// LOD-14): each draws its species' baked impostor ([`Renderer::bake_impostor`]'s row,
    /// [`ImpostorInstance::species`]). Returns how many can be drawn: an instance whose model has
    /// no inverse or whose species is past `IMPOSTOR_SPECIES_MAX` is skipped; one whose species
    /// was not baked yet draws nothing until it is.
    pub fn set_impostors(&mut self, instances: &[ImpostorInstance]) -> Result<usize, RenderError> {
        if instances.is_empty() && self.impostor_draw.is_none() {
            return Ok(0);
        }
        if self.impostor_draw.is_none() {
            self.impostor_draw = Some(ImpostorDraw::new(&self.device)?);
        }
        self.impostors_placed = instances.to_vec();
        Ok(self.impostor_draw.as_mut().map_or(0, |draw| draw.set_instances(instances)))
    }

    /// This frame's impostor rows: the placed ones, then the copies `plan`'s camera draws as
    /// impostors (game systems LOD-15), with their cull fades.
    pub(super) fn place_plan_impostors(&mut self, plan: &FramePlan) -> Result<(), RenderError> {
        let planned = plan.impostor_instances();
        if planned.is_empty() && self.impostor_draw.is_none() {
            return Ok(());
        }
        if self.impostor_draw.is_none() {
            self.impostor_draw = Some(ImpostorDraw::new(&self.device)?);
        }
        let rows: Vec<ImpostorInstance> = self.impostors_placed.iter().copied().chain(planned).collect();
        if let Some(draw) = self.impostor_draw.as_mut() {
            draw.set_instances(&rows);
        }
        Ok(())
    }

    /// The impostors placed (their GPU rows; tests and diagnostics).
    pub fn impostor_draw(&self) -> Option<&ImpostorDraw> {
        self.impostor_draw.as_ref()
    }

    /// Whether frames draw impostors: some are placed and a species was baked.
    pub(super) fn draws_impostors(&self) -> bool {
        self.impostor_draw.as_ref().is_some_and(|draw| draw.active(self.impostors.species())) && self.impostors.atlases().is_some()
    }

    /// The baked class's depth and parallax choices (flat depth and no parallax for a spec no
    /// class has).
    fn impostor_choices(&self) -> (bool, bool) {
        let class = self.impostors.atlases().and_then(|atlases| class_of(&atlases.spec));
        (class.is_some_and(writes_depth), class.is_some_and(|class| class.spec().depth_parallax))
    }

    /// This frame's impostor tables and group, and the pipelines `path` and the frame's `prepass`
    /// (motion when `motion`) draw them with.
    pub(super) fn prepare_impostors(&mut self, path: &ScenePath, prepass: Option<&FramePrepass>, motion: bool) -> Result<(), RenderError> {
        if !self.draws_impostors() {
            return Ok(());
        }
        let (depth, parallax) = self.impostor_choices();
        let surface = self.surface_key(path.hdr);
        let constants = surface_constants(path.depth_reversed, path.format, surface);
        let equal = prepass.is_some_and(|prepass| prepass.equal);
        let world = WorldKey { format: path.format, reversed: path.depth_reversed, samples: self.samples, equal, depth, parallax };
        let motion_layout = self.motion_node.as_ref().map(|node| node.layout());
        let (Some(draw), Some(atlases)) = (self.impostor_draw.as_mut(), self.impostors.atlases()) else { return Ok(()) };
        draw.prepare(&self.device, &self.queue, atlases, self.impostors.species())?;
        let equal_depth = wgpu::DepthStencilState { depth_compare: Some(wgpu::CompareFunction::Equal), ..depth_state(false, path.depth_reversed) };
        let inputs = PipelineInputs {
            frame: &self.layouts.impostor_frame,
            pass: &self.layouts.pass,
            motion: motion_layout,
            constants: &constants,
            depth: if equal { equal_depth } else { depth_state(true, path.depth_reversed) },
        };
        draw.ensure_world(&self.device, world, &inputs)?;
        if prepass.is_some() {
            let key = PrepassKey { reversed: path.depth_reversed, motion, depth, parallax };
            let inputs = PipelineInputs { constants: &[], depth: depth_state(true, path.depth_reversed), ..inputs };
            draw.ensure_prepass(&self.device, key, &inputs)?;
        }
        Ok(())
    }

    /// The impostors in the world pass (`pass`) with the frame's `groups`.
    pub(super) fn draw_impostors(&self, pass: &mut RenderPass<'_>, groups: &FrameGroups) -> u32 {
        let (Some(draw), Some(frame)) = (self.impostor_draw.as_ref(), groups.impostor_frame.as_ref()) else { return 0 };
        if !self.draws_impostors() {
            return 0;
        }
        pass.set_bind_group(0, frame, &[]);
        pass.set_bind_group(1, &groups.pass, &[0]);
        draw.draw(pass)
    }

    /// The impostors' depth and normals (and motion: `motion` the motion node's group) into the
    /// prepass (`pass`).
    pub(super) fn draw_impostors_prepass(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, motion: Option<&wgpu::BindGroup>) -> u32 {
        let (Some(draw), Some(frame)) = (self.impostor_draw.as_ref(), prep.groups.impostor_frame.as_ref()) else { return 0 };
        if !self.draws_impostors() || draw.prepass_key().is_none_or(|key| key.motion != motion.is_some()) {
            return 0;
        }
        pass.set_bind_group(0, frame, &[]);
        pass.set_bind_group(1, &prep.groups.pass, &[0]);
        if let Some(group) = motion {
            pass.set_bind_group(IMPOSTOR_MOTION_GROUP, group, &[]);
        }
        draw.draw_prepass(pass, motion.is_some())
    }

    /// The bytes the impostor tables hold on the GPU (0: none).
    pub(super) fn impostor_draw_bytes(&self) -> u64 {
        self.impostor_draw.as_ref().map_or(0, ImpostorDraw::bytes)
    }
}
