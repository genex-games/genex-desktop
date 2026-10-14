//! GXF wire v1, as `native/genex-frames/include/gxf_wire.h` defines it under `#pragma pack(4)`.
//! The receive-only addon validates every field; nothing here may drift from the header.

use crate::error::{FramesCode, FramesError};
use crate::ring::RingSpec;

/// Service-name prefix; the run id follows.
pub const SERVICE_PREFIX: &str = "games.genex.frames.";
/// Shortest run id.
pub const RUN_ID_MIN: usize = 8;
/// Longest run id.
pub const RUN_ID_MAX: usize = 64;
/// `msgh_id` of a frame message ('GXF1').
pub const MSG_ID_FRAME: i32 = 0x4758_4631;
/// Payload magic ('GENX').
pub const MAGIC: u32 = 0x4745_4e58;
/// Wire version.
pub const WIRE_VERSION: u16 = 1;
/// The ring never has more than three slots.
pub const MAX_SLOTS: u32 = 3;
/// The only pixel format: 'BGRA' (kCVPixelFormatType_32BGRA), one plane.
pub const PIXEL_FORMAT_BGRA: u32 = 0x4247_5241;
/// Bytes per BGRA pixel.
pub const BYTES_PER_PIXEL: u32 = 4;
/// Longest ring side the host accepts.
pub const MAX_SIDE: u32 = 8192;
/// Largest ring surface the host accepts (32 Mpx: 128 MiB per slot).
pub const MAX_PIXELS: u64 = 33_554_432;
/// Largest `seq` (2^53 - 1), so JavaScript numbers carry it exactly.
pub const MAX_SEQ: u64 = 9_007_199_254_740_991;

/// What the game says about the frame (`gxf_frame_payload`). Every field is checked by the host.
#[repr(C, packed(4))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FramePayload {
    /// [`MAGIC`].
    pub magic: u32,
    /// [`WIRE_VERSION`].
    pub version: u16,
    /// 0 .. slots-1 of the announced ring.
    pub slot: u16,
    /// The ring generation the host chose in the `surface` op.
    pub generation: u32,
    /// The announced ring width.
    pub width: u32,
    /// The announced ring height.
    pub height: u32,
    /// [`PIXEL_FORMAT_BGRA`].
    pub pixel_format: u32,
    /// Strictly increasing per run, at most [`MAX_SEQ`].
    pub seq: u64,
    /// Game clock (CLOCK_REALTIME microseconds); a diagnostic only.
    pub ts_us: u64,
}

const _: () = assert!(size_of::<FramePayload>() == 40, "gxf_frame_payload is 40 bytes");

impl FramePayload {
    /// The payload of frame `seq` in `slot` of `ring` (`gxf_payload_for`).
    pub fn for_ring(ring: &RingSpec, slot: u16, seq: u64, ts_us: u64) -> FramePayload {
        FramePayload {
            magic: MAGIC,
            version: WIRE_VERSION,
            slot,
            generation: ring.generation(),
            width: ring.width(),
            height: ring.height(),
            pixel_format: PIXEL_FORMAT_BGRA,
            seq,
            ts_us,
        }
    }
}

/// A checked per-run service name: [`SERVICE_PREFIX`] and a run id of `[A-Za-z0-9-]`, 8 to 64
/// characters. Anything else is refused before `bootstrap_look_up` sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceName(String);

impl ServiceName {
    /// Checks `name`; refuses [`FramesCode::InvalidServiceName`].
    pub fn parse(name: &str) -> Result<ServiceName, FramesError> {
        let refuse = || FramesError::new(FramesCode::InvalidServiceName, format!("not a frames service: {name:?}"));
        let run_id = name.strip_prefix(SERVICE_PREFIX).ok_or_else(refuse)?;
        let charset = run_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !charset || !(RUN_ID_MIN..=RUN_ID_MAX).contains(&run_id.len()) {
            return Err(refuse());
        }
        Ok(ServiceName(name.to_owned()))
    }

    /// The full name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(target_os = "macos")]
pub use mach_message::FrameMsg;

#[cfg(target_os = "macos")]
mod mach_message {
    use mach2::message::{
        MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MOVE_SEND, MACH_MSGH_BITS_COMPLEX, mach_msg_body_t, mach_msg_header_t,
        mach_msg_port_descriptor_t,
    };
    use mach2::port::mach_port_t;

    use super::{FramePayload, MSG_ID_FRAME};

    /// The complete frame message as sent (`gxf_frame_msg`): header, one port descriptor, payload.
    #[repr(C, packed(4))]
    #[derive(Clone, Copy, Debug)]
    pub struct FrameMsg {
        /// Complex, COPY_SEND to the service, no reply port, no voucher.
        pub header: mach_msg_header_t,
        /// One descriptor.
        pub body: mach_msg_body_t,
        /// MOVE_SEND of the slot's IOSurface port.
        pub surface: mach_msg_port_descriptor_t,
        /// What the game says about the frame.
        pub payload: FramePayload,
    }

    const _: () = assert!(size_of::<FrameMsg>() == 80, "gxf_frame_msg is 80 bytes");

    impl FrameMsg {
        /// The message to `service` moving the send right `surface_port`.
        pub fn new(service: mach_port_t, surface_port: mach_port_t, payload: FramePayload) -> FrameMsg {
            FrameMsg {
                header: mach_msg_header_t {
                    msgh_bits: MACH_MSG_TYPE_COPY_SEND | MACH_MSGH_BITS_COMPLEX,
                    msgh_size: size_of::<FrameMsg>() as u32,
                    msgh_remote_port: service,
                    msgh_local_port: 0,
                    msgh_voucher_port: 0,
                    msgh_id: MSG_ID_FRAME,
                },
                body: mach_msg_body_t { msgh_descriptor_count: 1 },
                surface: mach_msg_port_descriptor_t::new(surface_port, MACH_MSG_TYPE_MOVE_SEND),
                payload,
            }
        }
    }
}
