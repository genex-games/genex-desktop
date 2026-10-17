//! The GPU-visible memory a native platform reports for an adapter (owner decision 2026-10-12
//! (2)): on a native desktop genex-render's memory budget grows with it
//! (`genex_render::presets::class_budget_bytes`). wgpu does not expose it, so the adapter probe asks the
//! backend through wgpu's hal:
//! - Metal: the device's `recommendedMaxWorkingSetSize` (Apple GPUs share the system's memory;
//!   Metal recommends about two thirds to three quarters of it);
//! - DX12: a discrete adapter's dedicated video memory (`DXGI_ADAPTER_DESC1`);
//! - Vulkan: a discrete adapter's largest device-local heap.
//!
//! An integrated GPU off Apple reports no dedicated memory worth reading (its device-local heap is
//! the system's), the web has `deviceMemory`, and an adapter that answers nothing is unknown: each
//! is None, and the class budget stands.
//!
//! Its own crate because the queries are FFI: genex-render stays safe Rust, so an ejected fork of it
//! builds under the lane's `-F unsafe_code`, and an eject leaves this crate the store's. For the
//! same reason it also opens the Vulkan pipeline cache from saved bytes ([`open_pipeline_cache`],
//! renderer pass 2, RC-09): wgpu marks that call `unsafe` for the bytes' provenance.

#![cfg_attr(
    not(target_arch = "wasm32"),
    allow(unsafe_code, reason = "wgpu's hal adapters and the backends' memory queries are FFI; each block says why it holds")
)]

/// Vulkan's `VK_MEMORY_HEAP_DEVICE_LOCAL_BIT`.
#[cfg(any(windows, target_os = "linux", target_os = "android"))]
const VK_MEMORY_HEAP_DEVICE_LOCAL_BIT: u32 = 0x1;

/// The GPU-visible memory of `adapter` in bytes, or None when the platform does not say.
pub fn gpu_visible_memory(adapter: &wgpu::Adapter) -> Option<u64> {
    #[cfg(target_arch = "wasm32")]
    {
        let _ = adapter;
        None
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let info = adapter.get_info();
        let bytes = match info.backend {
            wgpu::Backend::Metal => metal_working_set(adapter),
            wgpu::Backend::Dx12 if info.device_type == wgpu::DeviceType::DiscreteGpu => dx12_dedicated(adapter),
            wgpu::Backend::Vulkan if info.device_type == wgpu::DeviceType::DiscreteGpu => vulkan_device_local(adapter),
            _ => None,
        };
        bytes.filter(|bytes| *bytes > 0)
    }
}

/// Metal's recommended working set for `adapter`'s device.
#[cfg(all(not(target_arch = "wasm32"), target_vendor = "apple"))]
fn metal_working_set(adapter: &wgpu::Adapter) -> Option<u64> {
    // SAFETY: the hal adapter is only read here, while `adapter` keeps it alive; the guard is
    // dropped before this returns.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Metal>() }?;
    let device = hal.raw_device();
    // SAFETY: `recommendedMaxWorkingSetSize` is a read-only `uint64_t` property of every
    // MTLDevice on macOS 10.12 and iOS 16 (the floors this build supports).
    let bytes: u64 = unsafe { objc2::msg_send![device, recommendedMaxWorkingSetSize] };
    Some(bytes)
}

/// No Metal off Apple.
#[cfg(all(not(target_arch = "wasm32"), not(target_vendor = "apple")))]
fn metal_working_set(_adapter: &wgpu::Adapter) -> Option<u64> {
    None
}

/// The dedicated video memory DXGI reports for `adapter`.
#[cfg(target_os = "windows")]
fn dx12_dedicated(adapter: &wgpu::Adapter) -> Option<u64> {
    // SAFETY: the hal adapter is only read here, while `adapter` keeps it alive.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Dx12>() }?;
    // SAFETY: GetDesc1 fills a plain descriptor on a live adapter and has no other effect.
    let desc = unsafe { hal.raw_adapter().GetDesc1() }.ok()?;
    u64::try_from(desc.DedicatedVideoMemory).ok()
}

/// No DX12 off Windows.
#[cfg(all(not(target_arch = "wasm32"), not(target_os = "windows")))]
fn dx12_dedicated(_adapter: &wgpu::Adapter) -> Option<u64> {
    None
}

/// The largest device-local heap of `adapter`'s physical device (wgpu's native Vulkan platforms).
#[cfg(any(windows, target_os = "linux", target_os = "android"))]
fn vulkan_device_local(adapter: &wgpu::Adapter) -> Option<u64> {
    // SAFETY: the hal adapter is only read here, while `adapter` keeps it and its instance alive.
    let hal = unsafe { adapter.as_hal::<wgpu::hal::api::Vulkan>() }?;
    let instance = hal.shared_instance().raw_instance();
    // SAFETY: the physical device belongs to this instance; the query only reads its properties.
    let properties = unsafe { instance.get_physical_device_memory_properties(hal.raw_physical_device()) };
    properties
        .memory_heaps_as_slice()
        .iter()
        .filter(|heap| heap.flags.as_raw() & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT != 0)
        .map(|heap| heap.size)
        .max()
}

/// No native Vulkan backend here (Apple builds draw with Metal).
#[cfg(all(not(target_arch = "wasm32"), not(any(windows, target_os = "linux", target_os = "android"))))]
fn vulkan_device_local(_adapter: &wgpu::Adapter) -> Option<u64> {
    None
}

/// A pipeline cache on `device` (opened with `Features::PIPELINE_CACHE`), started from `data` when
/// wgpu accepts it and empty otherwise (`fallback`: a stale, foreign or truncated file never fails
/// the open); None when the device has no pipeline cache (Metal, D3D12 and the web keep their own).
pub fn open_pipeline_cache(device: &wgpu::Device, data: Option<&[u8]>) -> Option<wgpu::PipelineCache> {
    if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
        return None;
    }
    let descriptor = wgpu::PipelineCacheDescriptor { label: Some("genex pipeline cache"), data, fallback: true };
    // SAFETY: wgpu requires `data` to come from `PipelineCache::get_data` of an adapter with the
    // same `util::pipeline_cache_key`. genex-render's only caller passes the bytes it saved under
    // that key for this game, and wgpu checks the header it wrote (magic, ABI, backend, adapter
    // key, validation key and size) before the driver sees any of it, falling back to an empty
    // cache when they do not match.
    #[allow(unsafe_code, reason = "wgpu marks pipeline-cache creation unsafe for the bytes' provenance; the block says why it holds")]
    let cache = unsafe { device.create_pipeline_cache(&descriptor) };
    Some(cache)
}
