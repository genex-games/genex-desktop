//! GPU → CPU readback. [`map_read`] is a future: on the web the browser maps the buffer and wakes
//! it (a wasm page can never block on the device), natively the device is polled until the map
//! lands. The blocking forms ([`map_read_blocking`]) are native only.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use wgpu::{Buffer, BufferAsyncError, BufferUsages};

use crate::error::{RenderCode, RenderError};
use crate::gpu::Gpu;
use crate::tables::{aligned, buffer};

pub(crate) fn capture_failed(detail: impl Into<String>) -> RenderError {
    RenderError::refused(RenderCode::CaptureFailed, detail)
}

#[derive(Default)]
struct MapState {
    result: Option<Result<(), BufferAsyncError>>,
    waker: Option<Waker>,
}

/// Resolves when wgpu calls the map callback.
struct MapFuture {
    state: Arc<Mutex<MapState>>,
}

impl Future for MapFuture {
    type Output = Result<(), RenderError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let Ok(mut state) = self.state.lock() else { return Poll::Ready(Err(capture_failed("readback state poisoned"))) };
        match state.result.take() {
            Some(result) => Poll::Ready(result.map_err(|e| capture_failed(e.to_string()))),
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

/// Map `buffer`'s first `bytes` for reading, after the queue's work so far, and copy them out.
pub(crate) async fn map_read(gpu: &Gpu, buffer: &Buffer, bytes: u64) -> Result<Vec<u8>, RenderError> {
    // A map covers whole words; the extra bytes are dropped after the copy.
    let slice = buffer.slice(..bytes.div_ceil(4) * 4);
    let state = Arc::new(Mutex::new(MapState::default()));
    let callback_state = Arc::clone(&state);
    slice.map_async(wgpu::MapMode::Read, move |result| {
        if let Ok(mut state) = callback_state.lock() {
            state.result = Some(result);
            if let Some(waker) = state.waker.take() {
                waker.wake();
            }
        }
    });
    #[cfg(not(target_arch = "wasm32"))]
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| capture_failed(e.to_string()))?;
    #[cfg(target_arch = "wasm32")]
    let _ = gpu;
    MapFuture { state }.await?;
    let mut data = slice.get_mapped_range().map_err(|e| capture_failed(e.to_string()))?.to_vec();
    buffer.unmap();
    data.truncate(bytes as usize);
    Ok(data)
}

/// A mappable copy of `source`'s first `bytes`, queued.
pub(crate) fn stage_buffer(gpu: &Gpu, source: &Buffer, offset: u64, bytes: u64) -> Result<Buffer, RenderError> {
    let staging = buffer(&gpu.device, "readback", aligned(bytes), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
    encoder.copy_buffer_to_buffer(source, offset, &staging, 0, bytes.div_ceil(4) * 4);
    gpu.queue.submit([encoder.finish()]);
    Ok(staging)
}

/// [`map_read`], blocking (native only: a web page answers its captures asynchronously).
pub(crate) fn map_read_blocking(gpu: &Gpu, buffer: &Buffer, bytes: u64) -> Result<Vec<u8>, RenderError> {
    #[cfg(not(target_arch = "wasm32"))]
    return pollster::block_on(map_read(gpu, buffer, bytes));
    #[cfg(target_arch = "wasm32")]
    {
        let _ = (gpu, buffer, bytes);
        Err(capture_failed("a blocking readback cannot run on the web: use the async capture"))
    }
}
