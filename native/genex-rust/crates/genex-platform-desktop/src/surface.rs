//! The window a renderer draws into, as raw handles only: the runtime hands it to wgpu's
//! `create_surface` and never sees winit's window type.

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle,
};
use std::sync::Arc;
use winit::window::Window;

/// A live window surface: valid from `resumed` until `suspended`.
#[derive(Clone, Debug)]
pub struct ShellSurface {
    window: Option<Arc<Window>>,
    size: [u32; 2],
    scale: f64,
}

impl ShellSurface {
    pub(crate) fn new(window: Arc<Window>) -> ShellSurface {
        let size = window.inner_size();
        let scale = window.scale_factor();
        ShellSurface { window: Some(window), size: [size.width, size.height], scale }
    }

    /// A surface with no window behind it (tests and tools); its handles are unavailable.
    pub fn detached(size: [u32; 2], scale: f64) -> ShellSurface {
        ShellSurface { window: None, size, scale }
    }

    /// The window's size in physical pixels when the surface was created.
    pub fn size(&self) -> [u32; 2] {
        self.size
    }

    /// Physical pixels per logical pixel.
    pub fn scale(&self) -> f64 {
        self.scale
    }
}

impl HasWindowHandle for ShellSurface {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        self.window.as_ref().ok_or(HandleError::Unavailable)?.window_handle()
    }
}

impl HasDisplayHandle for ShellSurface {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        self.window.as_ref().ok_or(HandleError::Unavailable)?.display_handle()
    }
}
