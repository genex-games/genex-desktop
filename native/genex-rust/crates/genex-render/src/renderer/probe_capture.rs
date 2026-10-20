//! Graph node 11's reflection-probe part (renderer pass 2 A.3, `crate::probes`): after the sky's
//! bake, the probes' schedule runs (`EnvironmentMaps::prepare_probes`) and each capture step due
//! this frame is encoded. A face step draws the frame's opaque batches from the probe's capture
//! point into a face of the capture's source cube, through the forward pipeline compiled for the
//! capture (`rgba16float`, one sample, the mirror cube face's clockwise front faces, no screen
//! effects, the legacy light loop, one sun cascade, no probes read, `pre-exposure` 1 so the cube
//! holds radiance as the sky's does). Its visible lists come from a CPU frustum cull of the plan's
//! rows against the face (`cull::cpu_cull`; a tenth GPU cull view is not needed for six faces a
//! few times a second), and its sun shadows from a map of the probe's own box drawn by the casters'
//! pipeline into the probes' shadow map, so a capture never depends on where the camera is. The
//! other steps are the probes' own compute passes and copies.
//!
//! What a capture leaves out (open, recorded with A.3): transparent draws, alpha-masked and
//! double-sided variants, skinned meshes' motion, particles, lines, Level-2 custom materials and
//! Level-3 passes; spot lights unshadowed; the sky's sun disk (the analytic sun lights instead).
//!
//! The irradiance volumes' bake (renderer pass 2 A.4, `crate::irradiance`) runs first in the
//! node, because the probes' table carries the volumes' rows: each cell due this frame is six
//! faces of a small cube drawn the same way from the cell's centre (both sides of every triangle,
//! so a cell inside a wall sees it close by everywhere), the sun's map of the volume's box drawn
//! once per batch, then the batch's reduce and, when it completes the volume, its publish. A
//! settled capture's whole bake submits after each batch, so the per-face rows and the capture
//! targets hold one batch.

use super::*;
use crate::irradiance::{GridBatch, GridPrep};
use crate::probes::{CaptureStep, FaceCapture, ProbePrep};

/// The bytes between two faces' frame rows in the capture's uniform buffer (core's uniform offset
/// alignment).
const FRAME_ROW_STRIDE: u64 = (size_of::<GpuFrame>() as u64).next_multiple_of(256);
/// The view depth the capture's one cascade reaches: every point a face sees.
const CAPTURE_CASCADE_END: f32 = 1.0e9;
/// The capture shadow's normal offset, in its texels (the cascades' `NORMAL_OFFSET_TEXELS`).
const CAPTURE_NORMAL_OFFSET_TEXELS: f32 = 1.5;
/// The capture shadow's comparison bias, in its texels of light depth.
const CAPTURE_BIAS_TEXELS: f32 = 2.0;

impl Renderer {
    /// Graph node 11's probe part, after the environment's bake: the probes' schedule and every
    /// capture step due this frame. Nothing (and the probes released) off the HDR scene or without
    /// binned lights, which carry the probes' bins.
    pub(super) fn encode_probes(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> PassCounters {
        let mut counters = PassCounters::default();
        if !crate::probes::LANDED {
            return counters;
        }
        if crate::irradiance::LANDED {
            let grid = self.encode_irradiance(frame, prep);
            counters.render += grid.render;
            counters.compute += grid.compute;
            counters.submissions += grid.submissions;
        }
        let plan = &prep.plan;
        let binned = plan.binned.as_ref().filter(|_| self.path.hdr);
        let (declared, order): (&[crate::probes::ReflectionProbe], &[u32]) = binned.map_or((&[], &[]), |binned| (&binned.reflection_probes, &binned.bins.probes));
        let sun = plan.frame.sun_dir;
        let probe_prep = ProbePrep {
            declared,
            order,
            quality: &self.quality.environment,
            sky: None,
            frame_index: self.frame_index,
            settle: self.environment_settle,
            sun_dir: [sun[0], sun[1], sun[2]],
            depth_reversed: self.path.depth_reversed,
            volume_rows: &[],
        };
        let (work, passes) = self.environment.borrow_mut().prepare_probes(frame, &probe_prep);
        counters.compute += passes;
        let faces = work.iter().filter(|(_, step)| matches!(step, CaptureStep::Face(_))).count() as u64;
        if faces == 0 {
            for (slot, step) in &work {
                counters.compute += self.environment.borrow_mut().encode_probe_step(frame, *slot, *step);
            }
            return counters;
        }
        let rows = plan.visible_slots.max(1);
        let visible_stride = (u64::from(rows) * 2 * 4).next_multiple_of(256);
        let resources = self.probe_capture_pipeline().and_then(|pipeline| {
            let buffers = self.environment.borrow_mut().probe_store().buffers(&self.device, faces * FRAME_ROW_STRIDE, faces * visible_stride)?;
            Ok((pipeline, buffers))
        });
        let (pipeline, (uniforms, visible)) = match resources {
            Ok(resources) => resources,
            Err(error) => {
                // Nothing is drawn: the probes' last captures stay bound (none yet: no weight).
                log::error!("reflection probe captures skipped: {error}");
                return counters;
            }
        };
        // In the schedule's order: the captures share one source and one staging cube, so a
        // probe's faces, chain, prefilter and publish land before the next probe's faces.
        let mut index = 0u64;
        for (slot, step) in &work {
            if let Some(face) = self.environment.borrow().probe_face(*slot, *step, &probe_prep) {
                let regions = CaptureRegions { uniforms: &uniforms, uniform_at: index * FRAME_ROW_STRIDE, visible: &visible, visible_at: index * visible_stride, visible_bytes: visible_stride };
                self.encode_probe_face(frame, prep, &face, &regions, &pipeline);
                counters.render += 2;
                index += 1;
            }
            counters.compute += self.environment.borrow_mut().encode_probe_step(frame, *slot, *step);
        }
        counters
    }

    /// Graph node 11's irradiance part: the volumes' schedule, then each batch due this frame (its
    /// cells' faces, the reduce, the publish). Nothing (and the volumes released) off the HDR
    /// scene or without binned lights, which carry the volumes' bins.
    fn encode_irradiance(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> PassCounters {
        let mut counters = PassCounters::default();
        let plan = &prep.plan;
        let binned = plan.binned.as_ref().filter(|_| self.path.hdr);
        let declared: &[crate::irradiance::IrradianceVolume] = binned.map_or(&[], |binned| &binned.irradiance_volumes);
        let grid_prep = GridPrep { declared, quality: &self.quality.environment, lit_by: None, frame_index: self.frame_index, settle: self.environment_settle };
        let device = self.device.clone();
        let work = self.environment.borrow_mut().prepare_irradiance(&device, &grid_prep);
        if work.is_empty() {
            return counters;
        }
        let faces = (BATCH_FACES as u64).max(1);
        let rows = plan.visible_slots.max(1);
        let visible_stride = (u64::from(rows) * 2 * 4).next_multiple_of(256);
        let resources = self.capture_pipeline(CaptureKind::Irradiance).and_then(|pipeline| {
            let buffers = self.environment.borrow_mut().irradiance_store().buffers(&self.device, faces * FRAME_ROW_STRIDE, faces * visible_stride)?;
            Ok((pipeline, buffers))
        });
        let (pipeline, (uniforms, visible)) = match resources {
            Ok(resources) => resources,
            Err(error) => {
                // Nothing is drawn: the volumes' last bakes stay bound (none yet: no weight).
                log::error!("irradiance volume bake skipped: {error}");
                return counters;
            }
        };
        let sun = plan.frame.sun_dir;
        let sun = [sun[0], sun[1], sun[2]];
        let reversed = self.path.depth_reversed;
        let last = work.len() - 1;
        for (index, batch) in work.iter().enumerate() {
            let buffers = CaptureRegions { uniforms: &uniforms, uniform_at: 0, visible: &visible, visible_at: 0, visible_bytes: visible_stride };
            // A Live slice reuses the volume's shadow map an earlier slice drew for this sun (the
            // bake holds the scene still); a settled capture draws it again, so it is the same
            // picture after any Live frames.
            let held = !self.environment_settle && self.environment.borrow().irradiance().shadow_held(batch.slot, sun);
            counters.render += self.encode_cell_faces(frame, prep, batch, (&buffers, &pipeline), (sun, reversed, held));
            self.environment.borrow_mut().irradiance_hold_shadow(batch.slot, sun);
            counters.compute += self.environment.borrow_mut().encode_irradiance_batch(frame, batch, reversed);
            if index < last {
                // The next batch rewrites the same per-face rows and capture targets.
                frame.submit();
                counters.submissions += 1;
            }
        }
        counters
    }

    /// The faces of `batch`'s cells: the sun's map of the volume's box with the first face (unless
    /// `held`: the map already holds it), then every face (render passes opened).
    fn encode_cell_faces(&self, frame: &mut FrameEncoder, prep: &FramePrep, batch: &GridBatch, (regions, pipeline): (&CaptureRegions<'_>, &RenderPipeline), (sun, reversed, held): ([f32; 3], bool, bool)) -> u32 {
        let mut passes = 0;
        let mut drawn = 0u64;
        for (index, cell) in batch.cells.iter().enumerate() {
            for face in 0..6 {
                let Some(cell_face) = self.environment.borrow().irradiance().cell_face(batch.slot, index, *cell, face) else { continue };
                let capture = FaceCapture {
                    slot: batch.slot,
                    view_proj: crate::probes::face_view_proj(&cell_face.probe, face, reversed),
                    light: crate::probes::probe_light_view_proj(&cell_face.probe, sun),
                    probe: cell_face.probe,
                    face,
                    color: cell_face.color,
                    depth: cell_face.depth,
                    depth_clear: if reversed { 0.0 } else { 1.0 },
                    shadow: cell_face.shadow,
                    shadow_array: cell_face.shadow_array,
                    shadow_drawn: held || drawn > 0,
                    ambient: false,
                };
                let at = CaptureRegions {
                    uniforms: regions.uniforms,
                    uniform_at: drawn * FRAME_ROW_STRIDE,
                    visible: regions.visible,
                    visible_at: drawn * regions.visible_bytes,
                    visible_bytes: regions.visible_bytes,
                };
                passes += if capture.shadow_drawn { 1 } else { 2 };
                self.encode_probe_face(frame, prep, &capture, &at, pipeline);
                drawn += 1;
            }
        }
        passes
    }

    /// The capture's forward pipeline for this renderer's HDR scene (made once per surface key).
    fn probe_capture_pipeline(&self) -> Result<Compiled<RenderPipeline>, RenderError> {
        self.capture_pipeline(CaptureKind::Probe)
    }

    /// The forward pipeline a capture of `kind` draws with: a probe's culls back faces, an
    /// irradiance cell's draws both sides (so a cell inside a wall sees the wall close by in every
    /// direction and its reach hides it from every point).
    fn capture_pipeline(&self, kind: CaptureKind) -> Result<Compiled<RenderPipeline>, RenderError> {
        let reversed = self.path.depth_reversed;
        let key = SurfaceKey {
            shadow_filter: ShadowFilter::Pcf3x3,
            shadow_temporal: false,
            effects: EffectKey { ao: false, ao_gi: false, contact_shadows: false, fog: self.surface_key(true).effects.fog, aerial: false },
            binned_lights: false,
            sun_soft_edges: false,
            sun_cascades: 1,
            ..self.surface_key(true)
        };
        let mut constants: Vec<(&str, f64)> = surface_constants(reversed, crate::probes::CAPTURE_COLOR_FORMAT, key).to_vec();
        constants.push(("GX_PROBES", 0.0));
        let bits: Vec<u64> = constants.iter().map(|(_, value)| value.to_bits()).collect();
        if let Some(pipeline) = kind.store(&mut self.environment.borrow_mut()).pipeline(&bits) {
            return Ok(pipeline);
        }
        let module = shader(&self.device, "probe capture", crate::shaders::FORWARD)?;
        let layout = pipeline_layout(&self.device, "probe capture", &[&self.layouts.frame, &self.layouts.pass]);
        let buffers = mesh_buffers_layout();
        let options = wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
        let pipeline = crate::compile::render_pipeline(&self.device, &wgpu::RenderPipelineDescriptor {
            label: Some("probe capture"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: options.clone(), buffers: &buffers },
            // A cube face is a mirror image of a right-handed view (`probes::face_basis`): its
            // front faces wind clockwise.
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, cull_mode: kind.cull(), front_face: wgpu::FrontFace::Cw, ..Default::default() },
            depth_stencil: Some(depth_state(true, reversed)),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: options,
                targets: &[Some(wgpu::ColorTargetState { format: crate::probes::CAPTURE_COLOR_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        kind.store(&mut self.environment.borrow_mut()).set_pipeline(bits, pipeline.clone());
        Ok(pipeline)
    }

    /// One face: its frame row and visible lists written, the sun's map of the probe's box drawn
    /// (when the sun casts shadows and the plan has a cascade view), then the face.
    fn encode_probe_face(&self, frame: &mut FrameEncoder, prep: &FramePrep, face: &FaceCapture, regions: &CaptureRegions<'_>, pipeline: &RenderPipeline) {
        let plan = &prep.plan;
        let rows = plan.visible_slots as usize;
        let reversed = self.path.depth_reversed;
        let shadows = plan.frame.cascade_splits[3] > 0.5 && plan.views > 1;
        let lod = plan.cull_lod();
        let face_cull = crate::cull::cpu_cull(&crate::cull::frustum_planes_for(face.view_proj, reversed), &lod, &plan.batches, &plan.instances, rows);
        let light_cull = (shadows && !face.shadow_drawn).then(|| crate::cull::cpu_cull(&crate::cull::frustum_planes(face.light.0), &lod, &plan.batches, &plan.instances, rows));
        let mut lists = face_cull.visible.clone();
        lists.extend(light_cull.as_ref().map_or_else(|| vec![0; rows], |cull| cull.visible.clone()));
        let row = capture_frame(&plan.frame, face, (shadows, reversed), rows as u32);
        let queue = frame.queue().clone();
        queue.write_buffer(regions.uniforms, regions.uniform_at, bytemuck::bytes_of(&row));
        if !lists.is_empty() {
            queue.write_buffer(regions.visible, regions.visible_at, bytemuck::cast_slice(&lists));
        }
        let uniform = wgpu::BufferBinding { buffer: regions.uniforms, offset: regions.uniform_at, size: wgpu::BufferSize::new(size_of::<GpuFrame>() as u64) };
        let visible = wgpu::BufferBinding { buffer: regions.visible, offset: regions.visible_at, size: wgpu::BufferSize::new(regions.visible_bytes) };
        let mut stats = FrameStats::default();
        if let Some(cull) = &light_cull {
            let group = self.probe_shadow_group(&uniform, &visible);
            let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("probe capture shadow"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &face.shadow,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipelines.shadow);
            pass.set_bind_group(0, &group, &[]);
            pass.set_bind_group(1, &prep.groups.pass, &[PASS_VIEW_STRIDE as u32]);
            pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
            self.draw_batches(&mut pass, plan, 1, Some(&cull.counts), None, &mut stats);
        }
        let group = self.probe_frame_group(&uniform, &visible, &face.shadow_array);
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("probe capture face"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &face.color,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &face.depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(face.depth_clear), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.set_bind_group(1, &prep.groups.pass, &[0]);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        self.draw_batches(&mut pass, plan, 0, Some(&face_cull.counts), None, &mut stats);
    }

    /// The forward frame group a capture face draws with: the frame's, with the face's frame row,
    /// its visible lists and the probes' shadow map in place of the camera's.
    fn probe_frame_group(&self, uniform: &wgpu::BufferBinding<'_>, visible: &wgpu::BufferBinding<'_>, shadow_array: &TextureView) -> BindGroup {
        let t = &self.tables;
        let environment = self.environment.borrow();
        let mut entries = vec![
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(uniform.clone()) },
            entry(1, t.instances.get()),
            entry(2, t.materials.get()),
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Buffer(visible.clone()) },
            entry(4, t.slot_base.get()),
            entry(5, t.lights.get()),
            wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(shadow_array) },
            wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(&self.shadow_sampler) },
            wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::TextureView(self.textures.view(TextureClass::S256, TextureKind::Color)) },
            wgpu::BindGroupEntry { binding: 9, resource: wgpu::BindingResource::TextureView(self.textures.view(TextureClass::S256, TextureKind::Data)) },
            wgpu::BindGroupEntry { binding: 10, resource: wgpu::BindingResource::Sampler(&self.texture_sampler) },
        ];
        entries.extend(FRAME_ENV_BOUND.into_iter().filter_map(|(binding, name)| environment.binding(name).map(|resource| wgpu::BindGroupEntry { binding, resource })));
        // A capture reads no screen reflection (its pipelines' `GX_SSR` is off): the zero texel.
        let [ao_term, contact_mask, aerial_volume, _] = self.effect_views();
        let [(fog, _), (ao, _), (aerial, _), (point, _), (contact, _)] = FRAME_EFFECT_BOUND;
        entries.extend([
            entry(fog, &self.fog_row),
            wgpu::BindGroupEntry { binding: point, resource: wgpu::BindingResource::Sampler(&self.point_sampler) },
            wgpu::BindGroupEntry { binding: ao, resource: wgpu::BindingResource::TextureView(&ao_term) },
            wgpu::BindGroupEntry { binding: aerial, resource: wgpu::BindingResource::TextureView(&aerial_volume) },
            wgpu::BindGroupEntry { binding: contact, resource: wgpu::BindingResource::TextureView(&contact_mask) },
        ]);
        let [light_ext, light_bins, material_ext] = FRAME_LIGHT_BINDINGS.map(|(binding, _)| binding);
        entries.extend([entry(light_ext, t.light_ext.get()), entry(light_bins, t.light_bins.get()), entry(material_ext, t.material_ext.get())]);
        let class_views = MATERIAL_CLASS_ARRAYS.map(|(class, kind)| self.textures.view(class, kind));
        entries.extend(FRAME_MATERIAL_CLASS_BINDINGS.into_iter().zip(class_views).map(|((binding, _), view)| wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }));
        let neutral = self.ssr.borrow().neutral().clone();
        entries.push(wgpu::BindGroupEntry { binding: crate::screen_inputs::FRAME_REFLECTIONS_BINDING.0, resource: wgpu::BindingResource::TextureView(&neutral) });
        // A capture draws no faded batch (game systems LOD-04): the table is bound, never read.
        entries.push(entry(crate::layout::FRAME_INSTANCE_FADE_BINDING.0, t.instance_fade.get()));
        self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("probe capture frame"), layout: &self.layouts.frame, entries: &entries })
    }

    /// The casters' group a capture's shadow map draws with: the face's frame row (its one cascade
    /// the probe's box) and its visible lists (the casters' at view 1).
    fn probe_shadow_group(&self, uniform: &wgpu::BufferBinding<'_>, visible: &wgpu::BufferBinding<'_>) -> BindGroup {
        let t = &self.tables;
        let color_classes = TextureClass::ALL.map(|class| self.textures.view(class, TextureKind::Color));
        let mut entries = vec![
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::Buffer(uniform.clone()) },
            entry(1, t.instances.get()),
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Buffer(visible.clone()) },
            entry(3, t.slot_base.get()),
        ];
        entries.extend([entry(SHADOW_MASK_MATERIALS, t.materials.get()), entry(SHADOW_MASK_MATERIAL_EXT, t.material_ext.get())]);
        entries.extend(
            SHADOW_MASK_COLOR_ARRAYS.into_iter().zip(color_classes).map(|(binding, view)| wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }),
        );
        entries.push(wgpu::BindGroupEntry { binding: SHADOW_MASK_SAMPLER, resource: wgpu::BindingResource::Sampler(&self.texture_sampler) });
        entries.push(entry(SHADOW_INSTANCE_FADE, t.instance_fade.get()));
        self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("probe capture shadow"), layout: &self.layouts.shadow, entries: &entries })
    }
}

/// Faces one irradiance batch draws (`irradiance::BATCH_CELLS` cells of six).
const BATCH_FACES: usize = crate::irradiance::BATCH_CELLS * 6;

/// What a capture pipeline draws for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureKind {
    /// A reflection probe's faces (back faces culled).
    Probe,
    /// An irradiance cell's faces (both sides drawn).
    Irradiance,
}

impl CaptureKind {
    fn cull(self) -> Option<wgpu::Face> {
        match self {
            CaptureKind::Probe => Some(wgpu::Face::Back),
            CaptureKind::Irradiance => None,
        }
    }

    /// The store that keeps the pipeline.
    fn store(self, environment: &mut crate::ibl::EnvironmentMaps) -> &mut crate::probes::CaptureStore {
        match self {
            CaptureKind::Probe => environment.probe_store(),
            CaptureKind::Irradiance => environment.irradiance_store(),
        }
    }
}

/// Where one face's rows go in the capture's buffers.
struct CaptureRegions<'a> {
    uniforms: &'a Buffer,
    uniform_at: u64,
    visible: &'a Buffer,
    visible_at: u64,
    visible_bytes: u64,
}

/// The frame row a capture face draws with: the frame's lights, sun, ambient (none when the face's
/// `ambient` is off: the flat path with black) and fog, seen from the capture point along the face,
/// unjittered, at pre-exposure 1 (the cube holds radiance), its one cascade the probe's box
/// (`shadows`) or none, its frustum planes of `reversed` depth, and `rows` visible rows per view.
fn capture_frame(frame: &GpuFrame, face: &FaceCapture, (shadows, reversed): (bool, bool), rows: u32) -> GpuFrame {
    let (forward, _, _) = crate::probes::face_basis(face.face);
    let [x, y, z] = face.probe.capture;
    let mut row = *frame;
    row.view_proj = face.view_proj.to_cols_array();
    row.camera_pos = [x, y, z, 1.0];
    row.camera_forward = [forward.x, forward.y, forward.z, 0.0];
    row.planes = crate::cull::frustum_planes_for(face.view_proj, reversed);
    row.jitter = [0.0; 4];
    row.texture_lod = [0.0; 4];
    row.counts[3] = rows;
    row.cascade_splits = [CAPTURE_CASCADE_END, 0.0, 1.0, if shadows { 1.0 } else { 0.0 }];
    let (light, texel) = face.light;
    let light = light.to_cols_array();
    let depth_range = (light[10]).abs().recip().max(1e-6);
    row.cascade_view_proj = [light, [0.0; 16]];
    row.cascade_matrices = [[0.0; 16]; MAX_CASCADES];
    row.cascade_matrices[0] = light;
    row.cascade_ends = [CAPTURE_CASCADE_END, 0.0, 0.0, 0.0];
    let offset = CAPTURE_NORMAL_OFFSET_TEXELS * texel;
    row.cascade_offsets = [offset, 0.0, 0.0, 0.0];
    row.cascade_texels = [texel, 0.0, 0.0, 0.0];
    row.cascade_bias = [CAPTURE_BIAS_TEXELS * texel / depth_range, 0.0, 0.0, 0.0];
    row.shadow_params = [row.cascade_bias[0], offset, 0.0, 1.0 / crate::probes::CAPTURE_SHADOW_PX as f32];
    row.shadow_soft = [frame.shadow_soft[0], 0.0, 0.0, 0.0];
    row.shadow_counts = [u32::from(shadows), 0, frame.shadow_counts[2], 0];
    if !face.ambient {
        row.ambient = [0.0; 4];
    }
    row
}
