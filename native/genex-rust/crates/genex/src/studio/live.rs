//! Live's embedded frames, game side (`frames.h`'s `Ring` over genex-frames): on a Mac, `surface`
//! looks the run's frames service up once (`GENEX_FRAMES_SERVICE`), opens a
//! [`genex_frames::sender::FrameSender`] on the renderer's device and gives it the ring; after
//! each frame the world target is letterboxed into a ring-sized texture and the sender blits it
//! bottom-up into a free slot, waits for the GPU and sends it. A slot is the studio's until
//! `release`; a frame with no free slot, too soon after the last one, unchanged, or while Live
//! is hidden is skipped, never queued. Elsewhere there is no ring: `surface` answers
//! `no-frames-service`.
#![allow(
    clippy::disallowed_types,
    reason = "host glue (dev flavour only): the frame-rate cap reads the wall clock; the simulation never sees it"
)]

use crate::present::Presenter;
use genex_studio::RingFault;
use genex_studio::wire::SurfaceArgs;

/// The variable the host names the run's frames service in.
// Only the macOS ring reads it; other targets (phones, Linux, Windows) compile the stub.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const FRAMES_SERVICE_ENV: &str = "GENEX_FRAMES_SERVICE";

/// What a present after a frame did.
// The stub off macOS only ever answers `Skipped`, so `Sent` is unbuilt there.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Presented {
    /// No ring, nothing changed, too soon, hidden or no free slot.
    Skipped,
    /// A frame went to the studio.
    Sent,
    /// The studio is gone: the ring is dropped.
    Gone,
}

#[cfg(target_os = "macos")]
pub(crate) use mac::Live;

#[cfg(not(target_os = "macos"))]
pub(crate) use elsewhere::Live;

#[cfg(target_os = "macos")]
mod mac {
    use std::time::{Duration, Instant};

    use super::{FRAMES_SERVICE_ENV, Presented, Presenter, RingFault, SurfaceArgs};
    use genex_frames::connection::Connection;
    use genex_frames::ring::RingSpec;
    use genex_frames::sender::FrameSender;
    use genex_frames::wire::ServiceName;
    use genex_render::WORLD_FORMAT;

    /// The least time between two frames sent: twice the game's 60 Hz, half the studio's cap
    /// (`frames.h` `MIN_FRAME_INTERVAL_US`).
    const MIN_FRAME_INTERVAL: Duration = Duration::from_micros(1_000_000 / 120);

    /// The ring-sized texture the world target is letterboxed into before the sender's blit.
    struct Letterbox {
        _texture: wgpu::Texture,
        view: wgpu::TextureView,
        size: (u32, u32),
    }

    /// One run's ring.
    pub(crate) struct Live {
        service: Option<String>,
        /// The sender, once the service was looked up; `Some(None)` when the look-up failed.
        sender: Option<Option<FrameSender>>,
        letterbox: Option<Letterbox>,
        changed: bool,
        last_sent: Option<Instant>,
    }

    impl Live {
        /// The ring of a run the environment names a frames service for.
        pub(crate) fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Live {
            Live { service: env(FRAMES_SERVICE_ENV), sender: None, letterbox: None, changed: false, last_sent: None }
        }

        fn sender(&mut self, presenter: &Presenter) -> Option<&mut FrameSender> {
            if self.sender.is_none() {
                let looked_up = self.service.as_deref().and_then(|name| {
                    let service = ServiceName::parse(name).ok()?;
                    let connection = Connection::look_up(&service).ok()?;
                    Some(FrameSender::new(&presenter.gpu().device, connection))
                });
                self.sender = Some(looked_up);
            }
            self.sender.as_mut().and_then(Option::as_mut)
        }

        /// `surface`: replace the ring; its first frame goes out at the next present.
        pub(crate) fn make_ring(&mut self, presenter: &Presenter, ring: &SurfaceArgs) -> Result<(), RingFault> {
            self.letterbox = None;
            let device = presenter.gpu().device.clone();
            let sender = self.sender(presenter).ok_or(RingFault::NoService)?;
            let spec =
                RingSpec::new(ring.generation, ring.width, ring.height, ring.slots).map_err(|_| RingFault::Failed)?;
            sender.set_ring(&device, spec).map_err(|_| RingFault::Failed)?;
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("genex live letterbox"),
                size: wgpu::Extent3d { width: ring.width, height: ring.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: WORLD_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.letterbox = Some(Letterbox { _texture: texture, view, size: (ring.width, ring.height) });
            self.changed = true;
            Ok(())
        }

        /// `release` of the current generation's slot.
        pub(crate) fn release(&mut self, generation: u32, slot: u32) {
            if let Some(Some(sender)) = self.sender.as_mut() {
                sender.release(generation, slot);
            }
        }

        /// The world was drawn again: the next present has a frame to send.
        pub(crate) fn changed(&mut self) {
            self.changed = true;
        }

        /// The renderer's device was re-created: the sender and the letterbox were made on the
        /// old one, so the service is looked up again and the ring made again on the new device.
        pub(crate) fn device_changed(&mut self) {
            self.letterbox = None;
            self.sender = None;
            self.changed = true;
        }

        /// After a frame: send it in a free slot when it changed, at most one per
        /// [`MIN_FRAME_INTERVAL`].
        pub(crate) fn present(&mut self, presenter: &mut Presenter, visible: bool) -> Presented {
            let too_soon = self.last_sent.is_some_and(|at| at.elapsed() < MIN_FRAME_INTERVAL);
            if !visible || !self.changed || too_soon {
                return Presented::Skipped;
            }
            let Some(letterbox) = self.letterbox.as_ref() else { return Presented::Skipped };
            let Some(Some(sender)) = self.sender.as_mut() else { return Presented::Skipped };
            if sender.free_slot().is_none() {
                return Presented::Skipped;
            }
            presenter.resilient.present(&letterbox.view, WORLD_FORMAT, letterbox.size);
            let gpu = presenter.gpu();
            match sender.present(&gpu.device, &gpu.queue, &letterbox.view) {
                Ok(Some(_)) => {
                    self.changed = false;
                    self.last_sent = Some(Instant::now());
                    Presented::Sent
                }
                Ok(None) => Presented::Skipped,
                Err(error) => {
                    eprintln!("genex: Live frame not sent: {error:?}");
                    self.close();
                    Presented::Gone
                }
            }
        }

        /// Let the ring go (the studio is gone, or the game is closing).
        pub(crate) fn close(&mut self) {
            self.letterbox = None;
            self.sender = Some(None);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod elsewhere {
    use super::{Presented, Presenter, RingFault, SurfaceArgs};

    /// No ring off a Mac: Windows, Linux and mobile keep their own window (Pop out).
    pub(crate) struct Live;

    impl Live {
        pub(crate) fn from_env(_env: &dyn Fn(&str) -> Option<String>) -> Live {
            Live
        }
        pub(crate) fn make_ring(&mut self, _presenter: &Presenter, _ring: &SurfaceArgs) -> Result<(), RingFault> {
            Err(RingFault::NoService)
        }
        pub(crate) fn release(&mut self, _generation: u32, _slot: u32) {}
        pub(crate) fn changed(&mut self) {}
        pub(crate) fn device_changed(&mut self) {}
        pub(crate) fn present(&mut self, _presenter: &mut Presenter, _visible: bool) -> Presented {
            Presented::Skipped
        }
        pub(crate) fn close(&mut self) {}
    }
}
