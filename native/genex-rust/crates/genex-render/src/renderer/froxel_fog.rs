//! Graph node 11's froxel part (renderer pass 2 A.5, `crate::froxel`): after the sky's aerial
//! volume and the environment's bake, the froxel fog reads the frame's uniforms, the sun's shadow
//! array (node 6), the binned lights (node 4) and the sky's cube, folds the aerial volume in and
//! is bound in its place (`SkyState::aerial_view`), so the world pass's `aerial_perspective` slot
//! holds it. Nothing (and the volumes released) where the quality, the look or the environment do
//! not ask for it.

use super::*;

impl Renderer {
    /// Graph node 11's froxel fog for the frame `prep` draws: its compute pass, or none.
    pub(super) fn encode_froxels(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> PassCounters {
        let fog = self.frame_fog();
        let wanted = crate::froxel::runs(&self.look.fog, &self.quality).filter(|_| self.path.hdr && fog.color[3] > 0.0);
        let Some(grid) = wanted else {
            self.sky.borrow_mut().release_froxels();
            return PassCounters::default();
        };
        let environment = self.environment.borrow();
        let (Some(wgpu::BindingResource::TextureView(env_probes)), Some(wgpu::BindingResource::Sampler(env_sampler))) =
            (environment.binding(crate::probes::ENV_PROBES), environment.binding("env_sampler"))
        else {
            return PassCounters::default();
        };
        let (Some(wgpu::BindingResource::Buffer(rooms)), Some(wgpu::BindingResource::TextureView(room_cells))) =
            (environment.binding(crate::probes::ENV_PROBE_ROWS), environment.binding(crate::irradiance::ENV_IRRADIANCE))
        else {
            return PassCounters::default();
        };
        let effects = self.effects.borrow();
        let mut sky = self.sky.borrow_mut();
        let aerial = sky.sky_aerial_view().cloned().unwrap_or_else(|| effects.neutral_volume().clone());
        let t = &self.tables;
        let inputs = crate::froxel::FroxelInputs {
            frame_uniforms: &self.frame_uniforms,
            shadow_array: &self.shadow_maps.array,
            shadow_sampler: &self.shadow_sampler,
            lights: t.lights.get(),
            light_ext: t.light_ext.get(),
            light_bins: t.light_bins.get(),
            env_probes,
            env_sampler,
            aerial: &aerial,
            rooms: rooms.buffer,
            room_cells,
        };
        let plan_frame = &prep.plan.frame;
        let froxel_frame = crate::froxel::FroxelFrame {
            view_proj: plan_frame.view_proj,
            camera: [plan_frame.camera_pos[0], plan_frame.camera_pos[1], plan_frame.camera_pos[2]],
            render_size: self.targets.render_size,
            frame_index: self.frame_index,
            history_set: set_index(self.temporal.set) as u32,
            reset: self.temporal.reset,
            depth_reversed: self.path.depth_reversed,
            environment_lights: self.environment_choice.lights_scene(),
            binned: self.quality.lights.clustered && prep.plan.binned.is_some(),
            fog,
        };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        sky.encode_froxels(&device, &queue, frame.encoder(), (grid, &inputs, &froxel_frame))
    }
}
