//! Wire v1 as `native/genex-frames/include/gxf_wire.h` lays it out under `#pragma pack(4)`: the
//! payload is 40 bytes, the whole message 80, every field at the C offset. The receive-only addon
//! is the other half of this contract (`tests/conformance/rust-frames-real.test.ts` sends it real
//! messages); these rows pin the layout without a kernel.

use std::mem::{offset_of, size_of};

use genex_frames::ring::RingSpec;
use genex_frames::wire::{
    BYTES_PER_PIXEL, FramePayload, MAGIC, MAX_PIXELS, MAX_SEQ, MAX_SIDE, MAX_SLOTS, MSG_ID_FRAME, PIXEL_FORMAT_BGRA,
    RUN_ID_MAX, RUN_ID_MIN, SERVICE_PREFIX, ServiceName, WIRE_VERSION,
};
use genex_frames::{FramesCode, FramesError};

#[test]
fn the_constants_are_the_c_header_values() {
    assert_eq!(SERVICE_PREFIX, "games.genex.frames.");
    assert_eq!((RUN_ID_MIN, RUN_ID_MAX), (8, 64));
    assert_eq!(MSG_ID_FRAME, 0x4758_4631, "'GXF1'");
    assert_eq!(MAGIC, 0x4745_4e58, "'GENX'");
    assert_eq!(WIRE_VERSION, 1);
    assert_eq!(MAX_SLOTS, 3);
    assert_eq!(PIXEL_FORMAT_BGRA, 0x4247_5241, "'BGRA'");
    assert_eq!(BYTES_PER_PIXEL, 4);
    assert_eq!((MAX_SIDE, MAX_PIXELS), (8192, 33_554_432));
    assert_eq!(MAX_SEQ, 9_007_199_254_740_991);
}

#[test]
fn the_payload_is_40_bytes_at_the_c_offsets() {
    assert_eq!(size_of::<FramePayload>(), 40);
    let offsets = [
        offset_of!(FramePayload, magic),
        offset_of!(FramePayload, version),
        offset_of!(FramePayload, slot),
        offset_of!(FramePayload, generation),
        offset_of!(FramePayload, width),
        offset_of!(FramePayload, height),
        offset_of!(FramePayload, pixel_format),
        offset_of!(FramePayload, seq),
        offset_of!(FramePayload, ts_us),
    ];
    assert_eq!(offsets, [0, 4, 6, 8, 12, 16, 20, 24, 32]);
}

#[test]
fn a_payload_repeats_the_announced_ring() {
    let ring = RingSpec::new(7, 320, 180, 3).expect("a valid ring");
    let payload = FramePayload::for_ring(&ring, 2, 41, 1_700_000_000_000_000);
    let (magic, version, slot, generation) = (payload.magic, payload.version, payload.slot, payload.generation);
    let (width, height, format, seq, ts) =
        (payload.width, payload.height, payload.pixel_format, payload.seq, payload.ts_us);
    assert_eq!((magic, version, slot, generation), (MAGIC, WIRE_VERSION, 2, 7));
    assert_eq!((width, height, format, seq, ts), (320, 180, PIXEL_FORMAT_BGRA, 41, 1_700_000_000_000_000));
}

#[test]
fn a_service_name_is_the_prefix_and_a_run_id_of_the_allowed_charset_only() {
    let longest = format!("games.genex.frames.{}", "a".repeat(64));
    let good = ["games.genex.frames.abcdef12", longest.as_str(), "games.genex.frames.A-b-9-Zz0"];
    for name in good {
        assert_eq!(ServiceName::parse(name).map(|n| n.as_str().to_owned()).ok().as_deref(), Some(name), "{name}");
    }
    let too_long = format!("games.genex.frames.{}", "a".repeat(65));
    let hostile = [
        "",
        "games.genex.frames.",
        "games.genex.frames.short",
        too_long.as_str(),
        "games.genex.frames.abc/def12",
        "games.genex.frames.abcdef12\0x",
        "games.genex.frames.abcdef 12",
        "games.genex.frames.abcdéf12",
        "com.apple.windowserver.abcdef12",
        "Games.genex.frames.abcdef12",
        "games.genex.frames.../../etc",
    ];
    for name in hostile {
        let refused: Result<ServiceName, FramesError> = ServiceName::parse(name);
        assert_eq!(refused.err().map(|e| e.code), Some(FramesCode::InvalidServiceName), "{name:?}");
    }
}

#[cfg(target_os = "macos")]
mod mach {
    use std::mem::{offset_of, size_of};

    use genex_frames::ring::RingSpec;
    use genex_frames::wire::{FrameMsg, FramePayload, MSG_ID_FRAME};
    use mach2::message::{
        MACH_MSG_PORT_DESCRIPTOR, MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MOVE_SEND, MACH_MSGH_BITS_COMPLEX,
    };

    #[test]
    fn the_message_is_80_bytes_header_body_descriptor_payload() {
        assert_eq!(size_of::<FrameMsg>(), 80);
        assert_eq!(offset_of!(FrameMsg, header), 0);
        assert_eq!(offset_of!(FrameMsg, body), 24);
        assert_eq!(offset_of!(FrameMsg, surface), 28);
        assert_eq!(offset_of!(FrameMsg, payload), 40);
    }

    #[test]
    fn a_frame_message_is_complex_and_moves_one_send_right_with_no_reply_port() {
        let ring = RingSpec::new(1, 64, 32, 3).expect("a valid ring");
        let message = FrameMsg::new(0x1234, 0x5678, FramePayload::for_ring(&ring, 1, 9, 0));
        let header = message.header;
        assert_eq!(header.msgh_bits, MACH_MSG_TYPE_COPY_SEND | MACH_MSGH_BITS_COMPLEX);
        assert_eq!(header.msgh_size, 80);
        assert_eq!((header.msgh_remote_port, header.msgh_local_port, header.msgh_voucher_port), (0x1234, 0, 0));
        assert_eq!(header.msgh_id, MSG_ID_FRAME);
        let body = message.body;
        assert_eq!(body.msgh_descriptor_count, 1);
        let surface = message.surface;
        assert_eq!(surface.name, 0x5678);
        assert_eq!(u32::from(surface.disposition), MACH_MSG_TYPE_MOVE_SEND);
        assert_eq!(u32::from(surface.type_), MACH_MSG_PORT_DESCRIPTOR);
        let payload = message.payload;
        let (slot, seq) = (payload.slot, payload.seq);
        assert_eq!((slot, seq), (1, 9));
    }
}
