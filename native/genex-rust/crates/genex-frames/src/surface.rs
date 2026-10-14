//! One ring slot: a one-plane BGRA IOSurface and the wgpu texture over the same memory.
//!
//! `IOSurfaceCreate` → `newTextureWithDescriptor:iosurface:plane:` → `wgpu_hal::metal::Device::
//! texture_from_raw` → `create_texture_from_hal::<Metal>`. Whatever wgpu renders into the texture
//! is what the host imports from the IOSurface; no pixel is copied on the CPU.

use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained, CFString};
use objc2_io_surface::{
    IOSurfaceRef, kIOSurfaceBytesPerElement, kIOSurfaceHeight, kIOSurfacePixelFormat, kIOSurfaceWidth,
};
use objc2_metal::{
    MTLDevice, MTLPixelFormat, MTLStorageMode, MTLTexture, MTLTextureDescriptor, MTLTextureType, MTLTextureUsage,
};
use wgpu::hal::api::Metal;

use crate::error::{FramesCode, FramesError};
use crate::wire::{BYTES_PER_PIXEL, PIXEL_FORMAT_BGRA};

/// The wgpu format of every slot ('BGRA', not sRGB: the host composites the bytes as they are).
pub const SLOT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Bgra8Unorm;

/// A ring slot: the IOSurface the host imports and wgpu's texture over it.
pub struct SlotSurface {
    surface: CFRetained<IOSurfaceRef>,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
}

impl SlotSurface {
    /// Creates a `width` x `height` BGRA IOSurface and adopts it as a wgpu render target.
    /// Refuses [`FramesCode::NotMetal`], [`FramesCode::SurfaceCreateFailed`] or
    /// [`FramesCode::TextureAdoptFailed`].
    pub fn create(device: &wgpu::Device, width: u32, height: u32) -> Result<SlotSurface, FramesError> {
        let surface = create_iosurface(width, height)?;
        let texture = adopt(device, &surface, width, height)?;
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Ok(SlotSurface { surface, texture, view })
    }

    /// The IOSurface the host imports.
    pub fn surface(&self) -> &IOSurfaceRef {
        &self.surface
    }

    /// The IOSurface's global id (what the `surface` op reports per slot).
    pub fn surface_id(&self) -> u32 {
        self.surface.id()
    }

    /// wgpu's texture over the surface.
    pub fn texture(&self) -> &wgpu::Texture {
        &self.texture
    }

    /// A render-target view of the texture.
    pub fn view(&self) -> &wgpu::TextureView {
        &self.view
    }

    /// Whether the Metal texture wgpu holds is backed by this slot's IOSurface (the M0a KILL check
    /// reads it back through the hal, not from what this module asked for).
    pub fn texture_is_backed_by_surface(&self) -> bool {
        // SAFETY: the hal texture is only read, for the duration of this call.
        let Some(hal) = (unsafe { self.texture.as_hal::<Metal>() }) else { return false };
        let raw: &ProtocolObject<dyn MTLTexture> = hal.raw_handle();
        // SAFETY: `iosurface` is a plain getter returning an unretained IOSurfaceRef or nil.
        let backing: *const IOSurfaceRef = unsafe { msg_send![raw, iosurface] };
        std::ptr::eq(backing, &*self.surface)
    }
}

fn create_iosurface(width: u32, height: u32) -> Result<CFRetained<IOSurfaceRef>, FramesError> {
    let as_number = |value: u32| CFNumber::new_i32(value as i32);
    let values = [as_number(width), as_number(height), as_number(BYTES_PER_PIXEL), as_number(PIXEL_FORMAT_BGRA)];
    // SAFETY: the keys are IOSurface's own immutable CFString constants.
    let keys: [&CFString; 4] =
        unsafe { [kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat] };
    let value_refs: Vec<&CFNumber> = values.iter().map(|value| &**value).collect();
    let properties = CFDictionary::from_slices(&keys, &value_refs);
    // SAFETY: the dictionary holds only the documented keys with CFNumber values.
    let surface = unsafe { IOSurfaceRef::new(properties.as_opaque()) };
    surface.ok_or_else(|| {
        FramesError::new(FramesCode::SurfaceCreateFailed, format!("IOSurfaceCreate {width}x{height} BGRA failed"))
    })
}

fn texture_descriptor(width: u32, height: u32) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: Some("genex-frames slot"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: SLOT_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    }
}

/// The Metal texture over `surface`, in the storage modes Metal accepts for IOSurfaces (shared on
/// Apple silicon, managed on Intel Macs with a discrete GPU).
fn metal_texture(
    device: &ProtocolObject<dyn MTLDevice>,
    surface: &IOSurfaceRef,
    width: u32,
    height: u32,
) -> Option<Retained<ProtocolObject<dyn MTLTexture>>> {
    [MTLStorageMode::Shared, MTLStorageMode::Managed].into_iter().find_map(|storage| {
        // SAFETY: a plain 2D descriptor; width and height are the ring's checked sides.
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                width as usize,
                height as usize,
                false,
            )
        };
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        descriptor.setStorageMode(storage);
        // SAFETY: plane 0 of a one-plane BGRA surface of the descriptor's size and format. Called
        // by selector because objc2-metal gates the method behind a feature the lock does not use.
        unsafe { msg_send![device, newTextureWithDescriptor: &*descriptor, iosurface: surface, plane: 0usize] }
    })
}

fn adopt(device: &wgpu::Device, surface: &IOSurfaceRef, width: u32, height: u32) -> Result<wgpu::Texture, FramesError> {
    // SAFETY: the hal device is only read while the Metal texture is made.
    let hal_device = unsafe { device.as_hal::<Metal>() }
        .ok_or_else(|| FramesError::new(FramesCode::NotMetal, "the wgpu device is not on the Metal backend"))?;
    let raw = metal_texture(hal_device.raw_device(), surface, width, height).ok_or_else(|| {
        FramesError::new(FramesCode::TextureAdoptFailed, format!("newTextureWithDescriptor:iosurface: {width}x{height}"))
    })?;
    drop(hal_device);
    let extent = wgpu::hal::CopyExtent { width, height, depth: 1 };
    // SAFETY: `raw` is a 2D BGRA8Unorm texture with one layer and one mip of `extent`, made on
    // this device; the IOSurface it wraps outlives it (the slot keeps both).
    let hal_texture = unsafe {
        wgpu::hal::metal::Device::texture_from_raw(raw, SLOT_FORMAT, MTLTextureType::Type2D, 1, 1, extent, None)
    };
    // SAFETY: the hal texture respects `texture_descriptor`; its contents may be discarded.
    let texture = unsafe {
        device.create_texture_from_hal::<Metal>(
            hal_texture,
            &texture_descriptor(width, height),
            wgpu::wgt::TextureUses::UNINITIALIZED,
        )
    };
    Ok(texture)
}
