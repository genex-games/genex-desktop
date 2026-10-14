//! Admitting the phone's GPU: the adapter is checked against WebGPU core, and against the
//! native-enhanced features the game declares, before a device is ever asked for. Below core (or
//! with no adapter), or without a declared feature, the shell shows the designed refusal screen,
//! drawn without wgpu ([`crate::mobile::refusal`]), and records the typed `gpu-unsupported` or
//! `native-feature-missing` refusal; a device is never created on an adapter that failed the
//! check. A device that passed the check but could not be created is no verdict on the phone: it
//! fails with its own code and shows no refusal screen. iOS 16 devices are expected to pass (Apple
//! GPUs from the A9 on are Metal 2 / WebGPU-class), but the check still runs.
//!
//! genex-render's [`GpuAdapter`] is the seam: the shell's adapter is [`ShellAdapter`] (a real
//! `wgpu::Adapter`, opened through [`Gpu::open_with`]), tests use a double that counts devices.

use crate::mobile::refusal::lines_for;
use genex_render::floor::{AdapterFacts, GpuAdapter, open_device_with};
use genex_render::gpu::adapter_facts;
use genex_render::{Gpu, RenderError};
use wgpu::{Features, Limits};

/// What the shell does with an adapter.
#[derive(Debug)]
pub enum Admission<D> {
    /// The adapter is WebGPU-core and has every declared feature: play on its device.
    Play(D),
    /// Below core, or a declared feature missing: show the refusal screen and write the typed
    /// record.
    RefusalScreen(RenderError),
    /// The check passed but the device could not be created: fail with the error's own code.
    Failed(RenderError),
}

impl<D> Admission<D> {
    /// What a refusal is: the refusal screen for a verdict on the device, a failure otherwise.
    pub fn of_error(error: RenderError) -> Admission<D> {
        if lines_for(error.code()).is_some() { Admission::RefusalScreen(error) } else { Admission::Failed(error) }
    }
}

/// Check `adapter` against WebGPU core and the `declared` native-enhanced features, then open its
/// device with exactly those features (never before the check passed).
pub fn admit<A: GpuAdapter>(adapter: &A, declared: Features) -> Admission<A::Device> {
    match open_device_with(adapter, declared) {
        Ok((device, _receipt)) => Admission::Play(device),
        Err(error) => Admission::of_error(error),
    }
}

/// The phone's adapter: [`Gpu::open_with`] requests the device with core limits and the features
/// `open_device_with` passes (the game's declared ones).
pub struct ShellAdapter(pub wgpu::Adapter);

impl GpuAdapter for ShellAdapter {
    type Device = Gpu;

    fn facts(&self) -> AdapterFacts {
        adapter_facts(&self.0)
    }

    fn open(&self, _limits: &Limits, features: Features) -> Result<Gpu, RenderError> {
        pollster::block_on(Gpu::open_with(self.0.clone(), features))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_render::UnsupportedReason;
    use std::cell::Cell;

    use genex_render::RenderCode;

    /// An adapter double: its facts, a count of the devices asked of it, the features the last
    /// one was asked with, and whether the device request fails.
    struct Double<'a> {
        facts: AdapterFacts,
        devices: &'a Cell<u32>,
        asked: &'a Cell<Features>,
        fails: bool,
    }

    impl<'a> Double<'a> {
        fn new(facts: AdapterFacts, devices: &'a Cell<u32>, asked: &'a Cell<Features>) -> Double<'a> {
            Double { facts, devices, asked, fails: false }
        }
    }

    impl GpuAdapter for Double<'_> {
        type Device = &'static str;

        fn facts(&self) -> AdapterFacts {
            self.facts.clone()
        }

        fn open(&self, _limits: &Limits, features: Features) -> Result<&'static str, RenderError> {
            self.devices.set(self.devices.get() + 1);
            self.asked.set(features);
            if self.fails {
                return Err(RenderError::refused(RenderCode::DeviceFailed, "the device request failed"));
            }
            Ok("device")
        }
    }

    fn facts(backend: wgpu::Backend, compliant: bool) -> AdapterFacts {
        let flags = if compliant { wgpu::DownlevelFlags::compliant() } else { wgpu::DownlevelFlags::empty() };
        AdapterFacts {
            name: "double".into(),
            backend,
            limits: wgpu::Limits::defaults(),
            downlevel: wgpu::DownlevelCapabilities { flags, ..Default::default() },
            features: wgpu::Features::empty(),
        }
    }

    #[test]
    fn an_adapter_below_core_selects_the_refusal_and_never_creates_a_device() {
        for backend in [wgpu::Backend::Vulkan, wgpu::Backend::Metal] {
            let (devices, asked) = (Cell::new(0), Cell::new(Features::empty()));
            let admission = admit(&Double::new(facts(backend, false), &devices, &asked), Features::empty());
            let Admission::RefusalScreen(error) = admission else { panic!("below core must be refused on {backend:?}") };
            assert_eq!(error.code().wire(), "gpu-unsupported");
            assert!(matches!(error, RenderError::GpuUnsupported { reason: UnsupportedReason::NotWebGpuCompliant, .. }));
            assert_eq!(devices.get(), 0, "no device on a refused adapter");
        }
    }

    #[test]
    fn a_gl_adapter_is_refused_before_any_device() {
        let (devices, asked) = (Cell::new(0), Cell::new(Features::empty()));
        let admission = admit(&Double::new(facts(wgpu::Backend::Gl, true), &devices, &asked), Features::empty());
        assert!(matches!(admission, Admission::RefusalScreen(RenderError::GpuUnsupported { reason: UnsupportedReason::Backend, .. })));
        assert_eq!(devices.get(), 0);
    }

    #[test]
    fn a_core_adapter_opens_exactly_one_device() {
        let (devices, asked) = (Cell::new(0), Cell::new(Features::empty()));
        let admission = admit(&Double::new(facts(wgpu::Backend::Vulkan, true), &devices, &asked), Features::empty());
        assert!(matches!(admission, Admission::Play("device")));
        assert_eq!(devices.get(), 1);
    }

    #[test]
    fn the_declared_features_reach_the_device_request() {
        let (devices, asked) = (Cell::new(0), Cell::new(Features::empty()));
        let mut offered = facts(wgpu::Backend::Metal, true);
        offered.features = Features::SUBGROUP | Features::SHADER_F16;
        let admission = admit(&Double::new(offered, &devices, &asked), Features::SUBGROUP);
        assert!(matches!(admission, Admission::Play("device")));
        assert_eq!(asked.get(), Features::SUBGROUP, "exactly the declared features, never an offered undeclared one");
    }

    #[test]
    fn a_declared_feature_the_adapter_lacks_is_refused_before_any_device() {
        let (devices, asked) = (Cell::new(0), Cell::new(Features::empty()));
        let admission = admit(&Double::new(facts(wgpu::Backend::Vulkan, true), &devices, &asked), Features::SUBGROUP);
        let Admission::RefusalScreen(error) = admission else { panic!("a missing declared feature shows the refusal screen") };
        assert_eq!(error.code(), RenderCode::NativeFeatureMissing);
        assert_eq!(devices.get(), 0, "no device on a refused adapter");
    }

    #[test]
    fn a_failed_device_request_is_no_refusal_screen() {
        let (devices, asked) = (Cell::new(0), Cell::new(Features::empty()));
        let mut adapter = Double::new(facts(wgpu::Backend::Vulkan, true), &devices, &asked);
        adapter.fails = true;
        let Admission::Failed(error) = admit(&adapter, Features::empty()) else { panic!("a failed request is a failure") };
        assert_eq!(error.code(), RenderCode::DeviceFailed);
        let renderer_refusal = RenderError::refused(RenderCode::TextureTooLarge, "world target");
        assert!(matches!(Admission::<()>::of_error(renderer_refusal), Admission::Failed(_)));
    }
}
