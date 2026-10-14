//! The refusal screen on Android, drawn without wgpu: the activity's `ANativeWindow` is locked for
//! CPU writing (no swapchain was ever made on it: the shell drops its refused surface first), the
//! shell's pre-rendered [`RefusalImage`] is written in the buffer's layout and stride, and the
//! buffer is posted. A window the CPU cannot lock (or a layout it cannot write) answers `false`,
//! and the shell exits after writing the typed record instead.

use genex_platform_ios::mobile::refusal::{PixelLayout, RefusalImage, encode_into};
use ndk::hardware_buffer_format::HardwareBufferFormat;
use ndk::native_window::NativeWindow;
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::Window;

/// The layout a locked buffer's format is written in, if the CPU path knows it.
fn layout_of(format: HardwareBufferFormat) -> Option<PixelLayout> {
    match format {
        HardwareBufferFormat::R8G8B8A8_UNORM => Some(PixelLayout::Rgba8888),
        HardwareBufferFormat::R8G8B8X8_UNORM => Some(PixelLayout::Rgbx8888),
        HardwareBufferFormat::R5G6B5_UNORM => Some(PixelLayout::Rgb565),
        _ => None,
    }
}

/// The shell's `refusal_screen` hook: blit `image` into `window`; answers whether it is showing.
pub fn draw(window: &Window, image: &RefusalImage) -> bool {
    let Ok(handle) = window.window_handle() else { return false };
    let RawWindowHandle::AndroidNdk(handle) = handle.as_raw() else { return false };
    // SAFETY: winit's handle names the activity's live ANativeWindow while the window exists;
    // `clone_from_ptr` takes a reference of its own and releases it on drop.
    let native = unsafe { NativeWindow::clone_from_ptr(handle.a_native_window.cast()) };
    // Keep the window's size, ask for RGBA (the window may still hand back its own format).
    if let Err(error) = native.set_buffers_geometry(0, 0, Some(HardwareBufferFormat::R8G8B8A8_UNORM)) {
        log::warn!("refusal screen: buffers geometry not set: {error}");
    }
    let Ok(mut buffer) = native.lock(None) else { return false };
    let Some(layout) = layout_of(buffer.format()) else { return false };
    let size = (u32::try_from(buffer.width()).unwrap_or(0), u32::try_from(buffer.height()).unwrap_or(0));
    let stride = u32::try_from(buffer.stride()).unwrap_or(0);
    let Some(bytes) = buffer.bytes() else { return false };
    let mut pixels = vec![0_u8; bytes.len()];
    if !encode_into(image, layout, size, stride, &mut pixels) {
        return false;
    }
    for (slot, byte) in bytes.iter_mut().zip(pixels) {
        slot.write(byte);
    }
    // Dropping the guard unlocks and posts the buffer.
    true
}
