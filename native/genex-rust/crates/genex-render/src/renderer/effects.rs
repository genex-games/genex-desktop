//! The forward pass's RQ4 screen effects (RQ4.6): what the renderer binds at the forward frame
//! group's effect slots (`layout::FRAME_EFFECT_BOUND`) and the nodes that make them.
//!
//! - **Fog** (`frame_fog`, binding 15): the renderer's own row (`Renderer::frame_fog`), written
//!   with the frame's tables; density 0 draws no fog at all.
//! - **Ambient occlusion** (`ao_map`, binding 16): graph node 10 ([`AoNode`]) on the prepass's
//!   depth and normals, its term bound for the world pass; AO keeps its own history, reset by
//!   [`ScreenEffects::reset_ao_history`] (a settled capture, a camera cut). A settled capture
//!   puts Live's history aside and Live takes it back after ([`ScreenEffects::stash_live_ao`]).
//! - **Contact shadows** (`contact_shadow_mask`, binding 19): graph node 10a
//!   ([`ContactShadowNode`]) on the prepass depth, through a `GxFrameV2` row of the frame's camera.
//!
//! Both nodes bring their half-resolution result to the render size with the joint-bilateral
//! upsample (post::upsample) and take every target from the renderer's target pool
//! ([`ScreenEffects::prepare`]), so the ledger holds what they hold and a frame that does not run
//! one gives its targets back. A frame whose node does not run binds a 1x1 white texture there
//! (unoccluded, unshadowed), so it draws the picture from before RQ4 byte for byte.

use glam::Mat4;
use wgpu::{Buffer, BufferUsages, CommandEncoder, Device, Queue, TextureView};

use crate::abi::GxFrameV2;
use crate::error::RenderError;
use crate::post::ao::{AoCamera, AoFrameFacts, AoInput, AoNode, AoSettings, depth_mips};
use crate::settings::AoQuality;
use crate::target_pool::TargetPool;
use crate::post::contact_shadow::{ContactShadowCamera, ContactShadowFacts, ContactShadowInput, ContactShadowNode};
use crate::settings::Look;
use crate::tables::buffer;

/// What both effect nodes read about the frame beside the prepass's targets.
pub(super) struct EffectFrame<'a> {
    /// The prepass depth (render size, sampleable).
    pub(super) depth: &'a TextureView,
    /// The prepass's world-space octahedral normals.
    pub(super) normals: &'a TextureView,
    /// The render size.
    pub(super) render: (u32, u32),
    /// World to view.
    pub(super) view: Mat4,
    /// The projection the depth was drawn with (view to clip).
    pub(super) proj: Mat4,
    /// Unit direction towards the sun.
    pub(super) sun_dir: [f32; 3],
    /// Frames drawn since the history's last reset.
    pub(super) frame_index: u64,
    /// Whether depth is reversed (the HDR path).
    pub(super) depth_reversed: bool,
    /// Whether a temporal resolve consumes frame-keyed noise.
    pub(super) taa: bool,
    /// The pooled inputs' identity (bind groups are rebuilt when it moves).
    pub(super) generation: u64,
}

/// The screen effects' resources and the views the forward frame group binds this frame.
pub(super) struct ScreenEffects {
    /// The 1x1 white texture bound where an effect does not run.
    neutral: TextureView,
    /// The 1x1x1 aerial-perspective volume bound where node 11 did not write one: no in-scatter,
    /// full transmittance (`gx_apply_aerial` leaves the colour as it is).
    neutral_volume: TextureView,
    /// A 1x1 black cube: what in-world draws read as the environment if its maps answer none.
    neutral_cube: TextureView,
    /// The `GxFrameV2` row the contact-shadow march reads its camera from.
    march_frame: Buffer,
    ao: Option<AoNode>,
    contact: Option<ContactShadowNode>,
    /// The AO term this frame's world pass binds (None: neutral).
    ao_view: Option<TextureView>,
    /// The contact-shadow mask this frame's world pass binds (None: neutral).
    contact_view: Option<TextureView>,
    /// Whether AO's history starts over at its next frame.
    ao_reset: bool,
}

/// A 1x1 white `rgba8unorm` texture: visibility 1 with no bent normal, an unshadowed mask texel.
fn neutral_white(device: &Device, queue: &Queue) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("screen effect (neutral)"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        texture.as_image_copy(),
        &[u8::MAX; 4],
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
    );
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

/// A 1x1x1 `rgba16float` volume holding (0, 0, 0, 1): the aerial perspective of no air.
fn neutral_volume(device: &Device, queue: &Queue) -> TextureView {
    let size = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("aerial perspective (neutral)"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: crate::fog::AERIAL_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let one = crate::post::tonemap::f32_to_f16(1.0).to_le_bytes();
    let texel = [0, 0, 0, 0, 0, 0, one[0], one[1]];
    queue.write_texture(texture.as_image_copy(), &texel, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(1) }, size);
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D3), ..Default::default() })
}

/// A 1x1 black `rgba16float` cube (zero-initialised: no radiance).
fn neutral_cube(device: &Device) -> TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("environment (neutral)"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 6 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::Cube), ..Default::default() })
}

impl ScreenEffects {
    /// The neutral textures and the march's frame row; the nodes come with the
    /// first frame that asks for them ([`ScreenEffects::prepare`]).
    pub(super) fn new(device: &Device, queue: &Queue) -> Result<ScreenEffects, RenderError> {
        let usage = BufferUsages::UNIFORM | BufferUsages::COPY_DST;
        Ok(ScreenEffects {
            neutral: neutral_white(device, queue),
            neutral_volume: neutral_volume(device, queue),
            neutral_cube: neutral_cube(device),
            march_frame: buffer(device, "contact shadow frame", size_of::<GxFrameV2>() as u64, usage)?,
            ao: None,
            contact: None,
            ao_view: None,
            contact_view: None,
            ao_reset: false,
        })
    }

    /// Start a `render`-sized frame: every effect neutral until its node runs, and the nodes this
    /// frame runs (AO under `ao`, contact shadows when `contact`) made now with their targets
    /// taken from `pool` (so the ledger holds them). A node that does not run gives its targets
    /// back: the ledger counts them freed, and they are.
    pub(super) fn prepare(&mut self, device: &Device, pool: &mut TargetPool, render: (u32, u32), ao: Option<&AoQuality>, contact: bool) -> Result<(), RenderError> {
        self.ao_view = None;
        self.contact_view = None;
        match ao {
            Some(quality) => {
                if self.ao.is_none() {
                    self.ao = Some(AoNode::new(device)?);
                }
                self.ao.as_mut().expect("made above").acquire(device, pool, render, quality)?;
            }
            // The node drops its views as the pool releases the targets.
            None => match self.ao.as_mut() {
                Some(node) => node.release(pool),
                None => crate::post::ao::LABELS.iter().for_each(|label| pool.release(label)),
            },
        }
        if contact {
            if self.contact.is_none() {
                self.contact = Some(ContactShadowNode::new(device)?);
            }
            self.contact.as_mut().expect("made above").acquire(device, pool, render)?;
        } else {
            match self.contact.as_mut() {
                Some(node) => node.release(pool),
                None => crate::post::contact_shadow::LABELS.iter().for_each(|label| pool.release(label)),
            }
        }
        Ok(())
    }

    /// The neutral environment cube.
    pub(super) fn neutral_cube(&self) -> &TextureView {
        &self.neutral_cube
    }

    /// The neutral aerial-perspective volume.
    pub(super) fn neutral_volume(&self) -> &TextureView {
        &self.neutral_volume
    }

    /// The AO term and the contact-shadow mask the world pass binds now (the neutral texture for a
    /// node that did not run).
    pub(super) fn views(&self) -> [TextureView; 2] {
        [self.ao_view.as_ref().unwrap_or(&self.neutral).clone(), self.contact_view.as_ref().unwrap_or(&self.neutral).clone()]
    }

    /// AO's history starts over at its next frame.
    pub(super) fn reset_ao_history(&mut self) {
        self.ao_reset = true;
    }

    /// A settled capture begins: Live's AO history is put aside (RQ5 review), so the capture's
    /// re-renders never become it.
    pub(super) fn stash_live_ao(&mut self, device: &Device, queue: &Queue) {
        if let Some(node) = self.ao.as_mut() {
            node.stash_live(device, queue);
        }
    }

    /// The capture is over: Live's next AO frame takes its history back.
    pub(super) fn restore_live_ao(&mut self) {
        if let Some(node) = self.ao.as_mut() {
            node.restore_live();
        }
    }

    /// Bytes AO keeps beside its pooled targets (Live's history put aside for captures).
    pub(super) fn ao_stash_bytes(&self) -> u64 {
        self.ao.as_ref().map_or(0, AoNode::stash_bytes)
    }

    /// Graph node 10: AO of `settings` for `frame`. The render passes it opened (0: none).
    pub(super) fn encode_ao(&mut self, device: &Device, queue: &Queue, encoder: &mut CommandEncoder, frame: &EffectFrame<'_>, settings: &AoSettings) -> u32 {
        let Some(node) = self.ao.as_mut() else { return 0 };
        if std::mem::take(&mut self.ao_reset) {
            node.reset_history();
        }
        let facts = AoFrameFacts { frame_index: frame.frame_index, depth_reversed: frame.depth_reversed, ..AoFrameFacts::default() };
        let input = AoInput {
            depth: frame.depth,
            normals: frame.normals,
            render: frame.render,
            camera: AoCamera { view: frame.view, proj: frame.proj },
            settings,
            facts,
            generation: frame.generation,
        };
        let Some(output) = node.encode(device, queue, encoder, input) else { return 0 };
        self.ao_view = Some(output.view);
        // The view-depth chain's mips (its top and each downsample), the horizon search, the
        // denoise, and the upsample when the term is smaller than the scene.
        let size = crate::post::ao::ao_size(frame.render, settings.quality.resolution).unwrap_or((1, 1));
        depth_mips(size) + 2 + u32::from(size != frame.render)
    }

    /// Graph node 10a: the sun's contact shadows for `frame` with `look`'s ray length. The render
    /// passes it opened (0: none).
    pub(super) fn encode_contact(&mut self, device: &Device, queue: &Queue, encoder: &mut CommandEncoder, frame: &EffectFrame<'_>, look: &Look) -> u32 {
        let Some(node) = self.contact.as_mut() else { return 0 };
        let facts = ContactShadowFacts { sun_dir: frame.sun_dir, frame_index: frame.frame_index, taa: frame.taa, depth_reversed: frame.depth_reversed };
        let row = ContactShadowCamera { view: frame.view, proj: frame.proj }.frame_row(frame.render, &facts);
        queue.write_buffer(&self.march_frame, 0, bytemuck::bytes_of(&row));
        let input = ContactShadowInput {
            depth: frame.depth,
            frame: &self.march_frame,
            render: frame.render,
            look,
            facts,
            normals: Some(frame.normals),
            proj: frame.proj,
            generation: frame.generation,
        };
        self.contact_view = node.encode(device, queue, encoder, input);
        // The march, and the upsample when the mask is smaller than the scene.
        match &self.contact_view {
            Some(_) if crate::post::contact_shadow::mask_size(frame.render) != frame.render => 2,
            Some(_) => 1,
            None => 0,
        }
    }
}
