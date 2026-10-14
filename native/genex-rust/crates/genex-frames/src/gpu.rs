//! A Metal device for standalone senders and tests. A game hands the sender genex-render's own
//! device instead; this one opens the same way (WebGPU-core limits, no features) on Metal only.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use crate::error::{FramesCode, FramesError};

/// An open Metal device and its queue.
pub struct MetalGpu {
    /// The device.
    pub device: wgpu::Device,
    /// Its queue.
    pub queue: wgpu::Queue,
    /// Always [`wgpu::Backend::Metal`].
    pub backend: wgpu::Backend,
    /// The adapter's name, for receipts.
    pub adapter_name: String,
}

impl MetalGpu {
    /// Opens the high-performance Metal adapter with `Limits::defaults()`; refuses
    /// [`FramesCode::NotMetal`] when there is none.
    pub fn open() -> Result<MetalGpu, FramesError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::METAL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let options =
            wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() };
        let adapter = block_on(instance.request_adapter(&options))
            .map_err(|error| FramesError::new(FramesCode::NotMetal, format!("no Metal adapter: {error}")))?;
        let info = adapter.get_info();
        let descriptor = wgpu::DeviceDescriptor {
            label: Some("genex-frames"),
            required_limits: wgpu::Limits::defaults(),
            ..Default::default()
        };
        let (device, queue) = block_on(adapter.request_device(&descriptor))
            .map_err(|error| FramesError::new(FramesCode::NotMetal, format!("no Metal device: {error}")))?;
        Ok(MetalGpu { device, queue, backend: info.backend, adapter_name: info.name })
    }
}

/// Drives a native wgpu future to completion on this thread (they resolve without an executor).
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let mut context = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
            return value;
        }
        std::thread::yield_now();
    }
}
