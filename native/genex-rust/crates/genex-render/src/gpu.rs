//! The device a renderer draws with, opened through the WebGPU-core floor, with the
//! renderer-owned optional features the adapter offers (`floor::RENDERER_FEATURES`).

use wgpu::{Adapter, Device, DeviceDescriptor, Dx12Compiler, Features, Instance, InstanceDescriptor, Limits, Queue};

use crate::device_class::DeviceFacts;
use crate::error::{RenderCode, RenderError};
use crate::floor::{
    AdapterFacts, CapabilityReceipt, INSTANCE_BACKENDS, check_declared, check_floor, core_limits, receipt, requested_features,
};

/// What the floor check reads from a wgpu adapter.
pub fn adapter_facts(adapter: &Adapter) -> AdapterFacts {
    let info = adapter.get_info();
    AdapterFacts {
        name: info.name,
        backend: info.backend,
        limits: adapter.limits(),
        downlevel: adapter.get_downlevel_capabilities(),
        features: adapter.features(),
    }
}

fn device_descriptor(limits: &Limits, features: Features) -> DeviceDescriptor<'static> {
    DeviceDescriptor {
        label: Some("genex-render"),
        required_features: features,
        required_limits: limits.clone(),
        ..Default::default()
    }
}

fn device_failed(error: wgpu::RequestDeviceError) -> RenderError {
    RenderError::refused(RenderCode::DeviceFailed, error.to_string())
}

/// A wgpu adapter behind the [`crate::floor::GpuAdapter`] seam (blocking; native only).
#[cfg(not(target_arch = "wasm32"))]
pub struct WgpuAdapter(pub Adapter);

#[cfg(not(target_arch = "wasm32"))]
impl crate::floor::GpuAdapter for WgpuAdapter {
    type Device = (Device, Queue);

    fn facts(&self) -> AdapterFacts {
        adapter_facts(&self.0)
    }

    fn open(&self, limits: &Limits, features: Features) -> Result<Self::Device, RenderError> {
        pollster::block_on(self.0.request_device(&device_descriptor(limits, features))).map_err(device_failed)
    }
}

/// The instance options: the WebGPU-class backends only, and FXC for D3D12 shaders. Nothing is
/// read from the environment (`WGPU_*` variables never change a game's backend or compiler).
pub fn core_instance_descriptor() -> InstanceDescriptor {
    let mut descriptor =
        InstanceDescriptor { backends: INSTANCE_BACKENDS, ..InstanceDescriptor::new_without_display_handle() };
    // wgpu's default `Auto` loads any `dxcompiler.dll` on PATH; FXC ships with Windows (plan:
    // "`Dx12Compiler::Fxc` set explicitly, never `from_env`").
    descriptor.backend_options.dx12.shader_compiler = Dx12Compiler::Fxc;
    descriptor
}

/// An instance on the WebGPU-class backends only.
pub fn core_instance() -> Instance {
    Instance::new(core_instance_descriptor())
}

/// The open device, its queue and its capability receipt.
pub struct Gpu {
    /// The device, opened with `Limits::defaults()` and only the game's declared native features.
    pub device: Device,
    /// Its queue.
    pub queue: Queue,
    receipt: CapabilityReceipt,
    /// What the device-class probe reads (backend, device type, vendor id, limits, features,
    /// transient-attachment savings), taken when the device was opened.
    facts: DeviceFacts,
    /// The adapter the device came from: a window's surface asks it which formats it takes.
    adapter: Adapter,
    /// The instance that found the adapter, when this opened it ([`Gpu::headless`]): a window's
    /// surface must come from the same one.
    instance: Option<Instance>,
}

impl Gpu {
    /// Another handle on this device, its queue and its facts (wgpu's handles are shared): a
    /// renderer built and warmed on another thread draws with it.
    pub fn share(&self) -> Gpu {
        Gpu {
            device: self.device.clone(),
            queue: self.queue.clone(),
            receipt: self.receipt.clone(),
            facts: self.facts.clone(),
            adapter: self.adapter.clone(),
            instance: self.instance.clone(),
        }
    }

    /// Open the high-performance adapter without a surface (headless runs, captures, tests).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn headless() -> Result<Gpu, RenderError> {
        Gpu::headless_with(Features::empty())
    }

    /// [`Gpu::headless`] for a game that declares the native-enhanced features `declared`: the
    /// device is opened with exactly those, or refused `native-feature-missing`.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn headless_with(declared: Features) -> Result<Gpu, RenderError> {
        let instance = core_instance();
        pollster::block_on(async {
            let options =
                wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() };
            let adapter = instance.request_adapter(&options).await.map_err(|error| RenderError::GpuUnsupported {
                reason: crate::error::UnsupportedReason::NoAdapter,
                detail: error.to_string(),
            })?;
            let mut gpu = Gpu::open_with(adapter, declared).await?;
            gpu.instance = Some(instance);
            Ok(gpu)
        })
    }

    /// Check `adapter` against the floor, then open a device with core limits and no features.
    pub async fn open(adapter: Adapter) -> Result<Gpu, RenderError> {
        Gpu::open_with(adapter, Features::empty()).await
    }

    /// Check `adapter` against the floor and the game's declared native-enhanced features, then
    /// open a device with core limits, exactly `declared` and the renderer-owned features the
    /// adapter offers (`native-feature-missing` when it lacks a declared one).
    pub async fn open_with(adapter: Adapter, declared: Features) -> Result<Gpu, RenderError> {
        let facts = adapter_facts(&adapter);
        check_floor(&facts)?;
        check_declared(&facts, declared)?;
        let features = requested_features(declared, facts.features);
        let (device, queue) = adapter.request_device(&device_descriptor(&core_limits(), features)).await.map_err(device_failed)?;
        let probed = DeviceFacts::probe(&adapter.get_info(), &facts).with_gpu_visible_memory(genex_gpu_memory::gpu_visible_memory(&adapter));
        Ok(Gpu { device, queue, receipt: receipt(&facts), facts: probed, adapter, instance: None })
    }

    /// The adapter the device was opened on.
    pub fn adapter(&self) -> &Adapter {
        &self.adapter
    }

    /// The instance that found the adapter, when [`Gpu::headless`] opened it (a window's surface
    /// is made from it); None for a device opened on a caller's adapter.
    pub fn instance(&self) -> Option<&Instance> {
        self.instance.as_ref()
    }

    /// What `ready` reports about this GPU.
    pub fn receipt(&self) -> &CapabilityReceipt {
        &self.receipt
    }

    /// What the device-class probe reads about this GPU.
    pub fn device_facts(&self) -> &DeviceFacts {
        &self.facts
    }
}
