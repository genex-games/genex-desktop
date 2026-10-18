//! Real Metal rows (macOS). Without a Metal adapter they print a skip, and `GENEX_REQUIRE_METAL=1`
//! turns that skip into a failure:
//!
//!   GENEX_REQUIRE_METAL=1 bash scripts/spike/rust-wgpu/rust-env.sh cargo test -p genex-frames \
//!     --offline --locked
//!
//! The first row is the M0a KILL check: `create_texture_from_hal` adopts the IOSurface, so pixels
//! wgpu draws land in the surface the host will import, bottom-up as `frames.cpp` stores them. The
//! others send through a receive right this process owns (no launchd name), so they prove the
//! message and the ring without the addon; `tests/conformance/rust-frames-real.test.ts` sends to
//! the real receive-only addon.
#![cfg(target_os = "macos")]
#![allow(unsafe_code, reason = "the rows own a mach receive right and lock IOSurfaces to read them back")]

use std::mem::size_of;

use genex_frames::blit::BottomUpBlit;
use genex_frames::connection::Connection;
use genex_frames::gpu::MetalGpu;
use genex_frames::ring::RingSpec;
use genex_frames::sender::FrameSender;
use genex_frames::surface::SlotSurface;
use genex_frames::wire::{FrameMsg, MAGIC, MSG_ID_FRAME, PIXEL_FORMAT_BGRA};
use mach2::kern_return::KERN_SUCCESS;
use mach2::mach_port::{mach_port_allocate, mach_port_deallocate, mach_port_insert_right, mach_port_mod_refs};
use mach2::message::{MACH_MSG_SUCCESS, MACH_MSG_TYPE_MAKE_SEND, MACH_RCV_MSG, MACH_RCV_TIMEOUT, mach_msg};
use mach2::port::{MACH_PORT_NULL, MACH_PORT_RIGHT_RECEIVE, mach_port_t};
use mach2::traps::mach_task_self;
use objc2_io_surface::{IOSurfaceLockOptions, IOSurfaceRef};

const WIDTH: u32 = 64;
const HEIGHT: u32 = 32;
/// How long a row waits for a message it expects.
const RECEIVE_TIMEOUT_MS: u32 = 2_000;

fn gpu() -> Option<MetalGpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match MetalGpu::open() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no Metal device: {error}"),
        Err(error) => {
            eprintln!("skipped: no Metal device ({error})");
            None
        }
    }
}

/// The C test sender's pattern (`pattern_pixel`) for image pixel (x, y), y = 0 the top, as BGRA bytes.
fn pattern(x: u32, y: u32, seq: u32) -> [u8; 4] {
    let r = (x + 3 * seq) & 255;
    let g = (y + 5 * seq) & 255;
    let b = ((x >> 8) * 64 + (y >> 8) * 16 + 7 * seq) & 255;
    [b as u8, g as u8, r as u8, 255]
}

/// A top-down BGRA source texture holding `pattern` for `seq`.
fn source(gpu: &MetalGpu, width: u32, height: u32, seq: u32) -> wgpu::TextureView {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("pattern"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let pixels: Vec<u8> = (0..height).flat_map(|y| (0..width).flat_map(move |x| pattern(x, y, seq))).collect();
    gpu.queue.write_texture(
        texture.as_image_copy(),
        &pixels,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    texture.create_view(&wgpu::TextureViewDescriptor::default())
}

/// Reads the surface's memory rows through `IOSurfaceLock` (the game side may; the addon never does).
fn memory_rows(surface: &IOSurfaceRef) -> Vec<Vec<u8>> {
    let mut seed = 0u32;
    // SAFETY: the seed pointer is valid; the lock is read-only and released below.
    let locked = unsafe { surface.lock(IOSurfaceLockOptions::ReadOnly, &mut seed) };
    assert_eq!(locked, 0, "IOSurfaceLock");
    let (width, height, row_bytes) = (surface.width(), surface.height(), surface.bytes_per_row());
    let base = surface.base_address().as_ptr().cast::<u8>();
    let rows = (0..height)
        .map(|row| {
            // SAFETY: the surface is locked and `row_bytes * height` bytes long from `base`.
            unsafe { std::slice::from_raw_parts(base.add(row * row_bytes), width * 4) }.to_vec()
        })
        .collect();
    // SAFETY: as above; this undoes the lock taken here.
    unsafe { surface.unlock(IOSurfaceLockOptions::ReadOnly, &mut seed) };
    rows
}

fn assert_bottom_up(surface: &IOSurfaceRef, width: u32, height: u32, seq: u32) {
    let rows = memory_rows(surface);
    assert_eq!(rows.len(), height as usize);
    for (memory_row, bytes) in rows.iter().enumerate() {
        let image_row = height - 1 - memory_row as u32;
        let expected: Vec<u8> = (0..width).flat_map(|x| pattern(x, image_row, seq)).collect();
        assert!(bytes == &expected, "memory row {memory_row} is not image row {image_row} (seq {seq})");
    }
}

/// A receive right this process owns and one send right to it (the sender's connection).
struct OwnPort(mach_port_t);

impl OwnPort {
    fn new() -> (OwnPort, Connection) {
        let mut port: mach_port_t = MACH_PORT_NULL;
        // SAFETY: plain mach calls on this task with valid out-pointers.
        unsafe {
            assert_eq!(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &mut port), KERN_SUCCESS);
            assert_eq!(mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND), KERN_SUCCESS);
        }
        (OwnPort(port), Connection::from_send_right(port))
    }

    /// The next frame message, its surface looked up from the moved send right.
    fn receive(&self) -> (FrameMsg, objc2_core_foundation::CFRetained<IOSurfaceRef>) {
        #[repr(C)]
        struct Buffer {
            message: FrameMsg,
            trailer: [u8; 128],
        }
        let mut buffer = Buffer { message: FrameMsg::new(0, 0, Default::default()), trailer: [0; 128] };
        // SAFETY: the buffer is writable for its whole size and outlives the call.
        let kr = unsafe {
            mach_msg(
                &mut buffer.message.header,
                MACH_RCV_MSG | MACH_RCV_TIMEOUT,
                0,
                size_of::<Buffer>() as u32,
                self.0,
                RECEIVE_TIMEOUT_MS,
                MACH_PORT_NULL,
            )
        };
        assert_eq!(kr, MACH_MSG_SUCCESS, "a frame message arrived");
        let message = buffer.message;
        let right = message.surface.name;
        let surface = IOSurfaceRef::lookup_from_mach_port(right).expect("the descriptor is an IOSurface right");
        // SAFETY: the received send right is ours to drop once the surface is looked up.
        unsafe { mach_port_deallocate(mach_task_self(), right) };
        (message, surface)
    }

    /// Whether nothing is queued (the sender skipped the frame).
    fn is_empty(&self) -> bool {
        let mut buffer = [0u8; 256];
        // SAFETY: as in `receive`.
        let kr = unsafe {
            mach_msg(buffer.as_mut_ptr().cast(), MACH_RCV_MSG | MACH_RCV_TIMEOUT, 0, 256, self.0, 50, MACH_PORT_NULL)
        };
        kr != MACH_MSG_SUCCESS
    }
}

impl Drop for OwnPort {
    fn drop(&mut self) {
        // SAFETY: drops the receive right this row allocated.
        unsafe { mach_port_mod_refs(mach_task_self(), self.0, MACH_PORT_RIGHT_RECEIVE, -1) };
    }
}

#[test]
fn kill_check_metal_create_texture_from_hal_adopts_the_iosurface_and_the_blit_is_bottom_up() {
    let Some(gpu) = gpu() else { return };
    assert_eq!(gpu.backend, wgpu::Backend::Metal);
    let slot = SlotSurface::create(&gpu.device, WIDTH, HEIGHT).expect("an IOSurface adopted by wgpu");
    assert!(slot.texture_is_backed_by_surface(), "the adopted MTLTexture's iosurface is the slot's IOSurface");
    assert_eq!((slot.surface().width(), slot.surface().height()), (WIDTH as usize, HEIGHT as usize));

    let blit = BottomUpBlit::new(&gpu.device);
    for seq in [1, 2] {
        blit.draw_and_wait(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, seq), &slot).expect("GPU done");
        assert_bottom_up(slot.surface(), WIDTH, HEIGHT, seq);
    }
}

#[test]
fn metal_frames_cycle_three_slots_hold_until_released_and_carry_their_iosurface() {
    let Some(gpu) = gpu() else { return };
    let (port, connection) = OwnPort::new();
    let mut sender = FrameSender::new(&gpu.device, connection);
    let ring = sender.set_ring(&gpu.device, RingSpec::new(3, WIDTH, HEIGHT, 3).expect("ring")).expect("ring made");
    assert_eq!(ring.iter().map(|s| s.slot).collect::<Vec<_>>(), [0, 1, 2]);

    for (index, expected_slot) in [0u16, 1, 2].into_iter().enumerate() {
        let seq = index as u32 + 1;
        let sent = sender.present(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, seq)).expect("sent");
        let sent = sent.expect("a free slot");
        assert_eq!((sent.slot, sent.seq), (expected_slot, u64::from(seq)));
        let (message, surface) = port.receive();
        let (header, payload) = (message.header, message.payload);
        assert_eq!((header.msgh_id, header.msgh_size), (MSG_ID_FRAME, 80));
        let fields = (payload.magic, payload.slot, payload.generation, payload.seq);
        assert_eq!(fields, (MAGIC, expected_slot, 3, u64::from(seq)));
        let (width, height, format) = (payload.width, payload.height, payload.pixel_format);
        assert_eq!((width, height, format), (WIDTH, HEIGHT, PIXEL_FORMAT_BGRA));
        assert_eq!(surface.id(), ring[usize::from(expected_slot)].surface_id, "the slot's own IOSurface");
        assert_bottom_up(&surface, WIDTH, HEIGHT, seq);
    }
    assert_eq!(sender.held_mask(), 0b111);
    let skipped = sender.present(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 9)).expect("no error");
    assert!(skipped.is_none(), "no free slot: the frame is skipped, nothing is sent");
    assert!(port.is_empty());

    assert!(!sender.release(2, 1), "a release for another generation");
    assert!(sender.release(3, 1));
    let sent = sender.present(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 4)).expect("sent");
    assert_eq!(sent.map(|s| (s.slot, s.seq)), Some((1, 4)), "the released slot, the next seq");
    let (_, surface) = port.receive();
    assert_bottom_up(&surface, WIDTH, HEIGHT, 4);

    let next = sender.set_ring(&gpu.device, RingSpec::new(4, 32, 16, 2).expect("ring")).expect("a new generation");
    assert_eq!(sender.held_mask(), 0, "a new generation owns no held slot");
    // Fresh surfaces of the new size (ids are global and may be recycled once the old ring is freed).
    assert_eq!(next.len(), 2);
    for info in &next {
        let slot = sender.slot(info.slot).expect("a slot of the new ring");
        assert_eq!((slot.surface_id(), slot.surface().width(), slot.surface().height()), (info.surface_id, 32, 16));
    }
    assert!(!sender.release(3, 0), "the retired generation's release is stale");
    let sent = sender.present(&gpu.device, &gpu.queue, &source(&gpu, 32, 16, 5)).expect("sent").expect("free");
    assert_eq!((sent.slot, sent.seq), (0, 5));
    let (message, _) = port.receive();
    let payload = message.payload;
    let (generation, width) = (payload.generation, payload.width);
    assert_eq!((generation, width), (4, 32));
}

#[test]
fn metal_a_frame_without_a_ring_is_refused_no_ring() {
    let Some(gpu) = gpu() else { return };
    let (port, connection) = OwnPort::new();
    let mut sender = FrameSender::new(&gpu.device, connection);
    let refused = sender.present(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 1));
    assert_eq!(refused.err().map(|e| e.code), Some(genex_frames::FramesCode::NoRing));
    assert!(port.is_empty());
}

/// Side of the textures the busy-GPU stand-in copies between.
const BUSY_SIDE: u32 = 4096;
/// Copies in one busy-GPU submission (each moves 128 MiB).
const BUSY_COPIES: u32 = 60;
/// How long a row polls for a submitted frame to be sent.
const SENT_WITHIN: std::time::Duration = std::time::Duration::from_secs(2);

/// A game frame's GPU work as queue order sees it: many large copies submitted before the blit.
fn busy_gpu(gpu: &MetalGpu) {
    let texture = |label| {
        gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: BUSY_SIDE, height: BUSY_SIDE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    };
    let (from, to) = (texture("busy from"), texture("busy to"));
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("busy") });
    for _ in 0..BUSY_COPIES {
        let size = wgpu::Extent3d { width: BUSY_SIDE, height: BUSY_SIDE, depth_or_array_layers: 1 };
        encoder.copy_texture_to_texture(from.as_image_copy(), to.as_image_copy(), size);
    }
    gpu.queue.submit([encoder.finish()]);
}

/// Review F8: the Live ring's send waited on the GPU for every frame (queue order made it wait for
/// the game's whole frame too), so CPU and GPU never overlapped in Studio's Live view. A submitted
/// frame returns at once and goes out on a later poll, once the GPU finished it; until then no
/// other frame is submitted.
#[test]
fn metal_a_submitted_frame_returns_before_the_gpu_finishes_and_is_sent_on_a_later_poll() {
    let Some(gpu) = gpu() else { return };
    let (port, connection) = OwnPort::new();
    let mut sender = FrameSender::new(&gpu.device, connection);
    sender.set_ring(&gpu.device, RingSpec::new(5, WIDTH, HEIGHT, 3).expect("ring")).expect("ring made");
    // Warm both paths' pipelines and the busy textures' allocation once.
    busy_gpu(&gpu);
    sender.present(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 1)).expect("sent").expect("free");
    let _ = port.receive();
    assert!(sender.release(5, 0));

    busy_gpu(&gpu);
    let from = std::time::Instant::now();
    sender.present(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 2)).expect("sent").expect("free");
    let waited = from.elapsed();
    let _ = port.receive();
    assert!(sender.release(5, 1));

    busy_gpu(&gpu);
    let from = std::time::Instant::now();
    let submitted = sender.submit(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 3)).expect("submitted");
    let returned = from.elapsed();
    eprintln!("present waited {waited:?} on a busy GPU; submit returned in {returned:?}");
    assert_eq!(submitted, Some(3), "the frame's sequence number");
    assert!(returned * 4 < waited, "submit returned in {returned:?}, present waited {waited:?}");
    let again = sender.submit(&gpu.device, &gpu.queue, &source(&gpu, WIDTH, HEIGHT, 9)).expect("no error");
    assert_eq!(again, None, "one frame in flight at a time");
    let sent = loop {
        if let Some(sent) = sender.poll_sent(&gpu.device).expect("polled") {
            break sent;
        }
        assert!(from.elapsed() < SENT_WITHIN, "the frame went out once the GPU finished it");
        std::thread::sleep(std::time::Duration::from_millis(1));
    };
    assert_eq!((sent.slot, sent.seq), (2, 3));
    let (message, surface) = port.receive();
    let payload = message.payload;
    let (slot, seq) = (payload.slot, payload.seq);
    assert_eq!((slot, seq), (2, 3));
    assert_bottom_up(&surface, WIDTH, HEIGHT, 3);
    assert_eq!(sender.held_mask(), 0b100, "held once the host has it");
    assert_eq!(sender.poll_sent(&gpu.device).expect("polled"), None, "nothing more in flight");
}
