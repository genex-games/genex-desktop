//! The frame codec: `u32 len | u8 kind | payload`, little-endian, `len` counting the kind byte and
//! the payload. [`read_frame`] reads one frame strictly; [`Reader`] cuts its payload into the
//! protocol's fields and refuses any it cannot read whole; [`Writer`] builds a reply.
//!
//! A field is one of: `u8`, `bool` (one byte, 0 or 1), `u32`, `u64`, `f64`, `str` (`u32` byte
//! length, then UTF-8), `bytes` (`u32` length, then the bytes), an array of `u32`, `f32` or `f64`
//! (`u32` count, then the values) and `opt<T>` (`bool`, then `T` when true). Every length is checked
//! against what is left before anything is allocated, so a lying length costs nothing.

use std::io::{ErrorKind, Read};

/// The largest frame either side sends, kind byte included: a 512 MiB snapshot (the most the
/// TypeScript wrapper hands `restore`, core.js `MAX_SNAPSHOT_BYTES`) with room for its header.
pub const MAX_FRAME_BYTES: u32 = 512 * 1024 * 1024 + 1024 * 1024;
/// The bytes of the length prefix.
pub const LENGTH_BYTES: usize = 4;
/// How much of a long frame is read per chunk: a length is never trusted for one allocation.
const READ_CHUNK_BYTES: usize = 1024 * 1024;

/// Why a frame could not be read: each is a protocol fault, and the process exits 3 before it
/// touches the world (main.rs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fault {
    /// The stream ended inside a frame.
    Truncated,
    /// A length of 0: a frame has at least its kind byte.
    Empty,
    /// A length over [`MAX_FRAME_BYTES`].
    Oversize(u32),
    /// A kind byte this protocol does not name.
    UnknownKind(u8),
    /// A field ran past the payload's end.
    ShortPayload,
    /// Bytes left over after the last field.
    TrailingBytes(usize),
    /// A string field that is not UTF-8.
    BadUtf8,
    /// A bool or option flag other than 0 or 1.
    BadFlag(u8),
    /// A number the protocol never carries there (NaN for a tick).
    BadNumber,
    /// A frame that is well formed but out of order for the session (main.rs's state machine).
    OutOfOrder(&'static str),
    /// A `Call` method this protocol does not name.
    UnknownMethod(u8),
    /// The pipe failed for another reason than its end.
    Io(ErrorKind),
}

/// One frame as read: its kind byte and its payload.
#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    /// The kind byte, still to be named by the protocol.
    pub kind: u8,
    /// Everything after the kind byte.
    pub payload: Vec<u8>,
}

/// Fills `buf` from `input`; `Ok(false)` when the stream ended before the first byte.
fn fill(input: &mut impl Read, buf: &mut [u8]) -> Result<bool, Fault> {
    let mut got = 0;
    while got < buf.len() {
        match input.read(&mut buf[got..]) {
            Ok(0) if got == 0 => return Ok(false),
            Ok(0) => return Err(Fault::Truncated),
            Ok(n) => got += n,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(Fault::Io(error.kind())),
        }
    }
    Ok(true)
}

/// Reads the next frame; `Ok(None)` when the stream ended cleanly between frames (the host closed
/// its end). A length is checked before any byte of the payload is read; the payload is read in
/// chunks as it arrives.
pub fn read_frame(input: &mut impl Read) -> Result<Option<Frame>, Fault> {
    let mut head = [0u8; LENGTH_BYTES];
    if !fill(input, &mut head)? {
        return Ok(None);
    }
    let length = u32::from_le_bytes(head);
    if length == 0 {
        return Err(Fault::Empty);
    }
    if length > MAX_FRAME_BYTES {
        return Err(Fault::Oversize(length));
    }
    let mut kind = [0u8; 1];
    if !fill(input, &mut kind)? {
        return Err(Fault::Truncated);
    }
    let total = length as usize - 1;
    let mut payload = Vec::with_capacity(total.min(READ_CHUNK_BYTES));
    while payload.len() < total {
        let start = payload.len();
        let chunk = (total - start).min(READ_CHUNK_BYTES);
        payload.resize(start + chunk, 0);
        if !fill(input, &mut payload[start..])? {
            return Err(Fault::Truncated);
        }
    }
    Ok(Some(Frame { kind: kind[0], payload }))
}

/// A cursor over one payload, reading the protocol's fields (see the module header).
pub struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    /// A reader at the start of `payload`.
    pub fn new(payload: &'a [u8]) -> Self {
        Self { rest: payload }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], Fault> {
        let Some((head, tail)) = self.rest.split_at_checked(count) else { return Err(Fault::ShortPayload) };
        self.rest = tail;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], Fault> {
        let bytes = self.take(N)?;
        Ok(bytes.try_into().unwrap_or([0; N]))
    }

    /// One byte.
    pub fn u8(&mut self) -> Result<u8, Fault> {
        Ok(self.array::<1>()?[0])
    }

    /// One byte that is 0 or 1.
    pub fn bool(&mut self) -> Result<bool, Fault> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            other => Err(Fault::BadFlag(other)),
        }
    }

    /// A little-endian u32.
    pub fn u32(&mut self) -> Result<u32, Fault> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    /// A little-endian f64, any value.
    pub fn f64(&mut self) -> Result<f64, Fault> {
        Ok(f64::from_le_bytes(self.array()?))
    }

    /// A little-endian f64 that is not NaN: a tick, where any negative means none.
    pub fn tick(&mut self) -> Result<f64, Fault> {
        let value = self.f64()?;
        if value.is_nan() {
            return Err(Fault::BadNumber);
        }
        Ok(value)
    }

    /// A count of items of `width` bytes each, checked against what is left.
    fn count(&mut self, width: usize) -> Result<usize, Fault> {
        let count = self.u32()? as usize;
        if count.checked_mul(width).is_none_or(|bytes| bytes > self.rest.len()) {
            return Err(Fault::ShortPayload);
        }
        Ok(count)
    }

    /// A length-prefixed run of bytes.
    pub fn bytes(&mut self) -> Result<&'a [u8], Fault> {
        let length = self.count(1)?;
        self.take(length)
    }

    /// A length-prefixed UTF-8 string.
    pub fn str(&mut self) -> Result<&'a str, Fault> {
        std::str::from_utf8(self.bytes()?).map_err(|_| Fault::BadUtf8)
    }

    /// An optional string.
    pub fn opt_str(&mut self) -> Result<Option<&'a str>, Fault> {
        if self.bool()? { self.str().map(Some) } else { Ok(None) }
    }

    /// A counted array of little-endian u32s.
    pub fn u32s(&mut self) -> Result<Vec<u32>, Fault> {
        let count = self.count(4)?;
        let bytes = self.take(count * 4)?;
        Ok(bytes.as_chunks::<4>().0.iter().map(|b| u32::from_le_bytes(*b)).collect())
    }

    /// A counted array of little-endian f32s, bit for bit.
    pub fn f32s(&mut self) -> Result<Vec<f32>, Fault> {
        let count = self.count(4)?;
        let bytes = self.take(count * 4)?;
        Ok(bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect())
    }

    /// A counted array of little-endian f64s, bit for bit.
    pub fn f64s(&mut self) -> Result<Vec<f64>, Fault> {
        let count = self.count(8)?;
        let bytes = self.take(count * 8)?;
        Ok(bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect())
    }

    /// Refuses bytes left after the last field.
    pub fn finish(self) -> Result<(), Fault> {
        if self.rest.is_empty() { Ok(()) } else { Err(Fault::TrailingBytes(self.rest.len())) }
    }
}

/// A frame being written: the length is filled in by [`Writer::finish`].
pub struct Writer {
    out: Vec<u8>,
}

impl Writer {
    /// A frame of `kind`.
    pub fn new(kind: u8) -> Self {
        let mut out = Vec::with_capacity(64);
        out.extend_from_slice(&[0; LENGTH_BYTES]);
        out.push(kind);
        Self { out }
    }

    /// One byte.
    pub fn u8(&mut self, value: u8) -> &mut Self {
        self.out.push(value);
        self
    }

    /// A bool as one byte.
    pub fn bool(&mut self, value: bool) -> &mut Self {
        self.u8(u8::from(value))
    }

    /// A little-endian u32.
    pub fn u32(&mut self, value: u32) -> &mut Self {
        self.out.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// A little-endian u64.
    pub fn u64(&mut self, value: u64) -> &mut Self {
        self.out.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// A little-endian f64.
    pub fn f64(&mut self, value: f64) -> &mut Self {
        self.out.extend_from_slice(&value.to_le_bytes());
        self
    }

    /// A length-prefixed run of bytes. A run past `u32::MAX` cannot be framed: its length saturates
    /// and [`Writer::finish`] refuses the frame as oversize.
    pub fn bytes(&mut self, value: &[u8]) -> &mut Self {
        self.u32(u32::try_from(value.len()).unwrap_or(u32::MAX));
        self.out.extend_from_slice(value);
        self
    }

    /// A length-prefixed UTF-8 string.
    pub fn str(&mut self, value: &str) -> &mut Self {
        self.bytes(value.as_bytes())
    }

    /// An optional string.
    pub fn opt_str(&mut self, value: Option<&str>) -> &mut Self {
        self.bool(value.is_some());
        if let Some(text) = value {
            self.str(text);
        }
        self
    }

    /// A counted array of little-endian f32s.
    pub fn f32s(&mut self, values: &[f32]) -> &mut Self {
        self.u32(u32::try_from(values.len()).unwrap_or(u32::MAX));
        for value in values {
            self.out.extend_from_slice(&value.to_le_bytes());
        }
        self
    }

    /// The frame's bytes with its length in place, or `None` when it is over [`MAX_FRAME_BYTES`].
    pub fn finish(mut self) -> Option<Vec<u8>> {
        let length = u32::try_from(self.out.len() - LENGTH_BYTES).ok().filter(|length| *length <= MAX_FRAME_BYTES)?;
        self.out[..LENGTH_BYTES].copy_from_slice(&length.to_le_bytes());
        Some(self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads one field and drops it.
    type FieldRead = fn(&mut Reader) -> Result<(), Fault>;

    /// A frame's bytes: `length` as given, then `body` (kind byte and payload).
    fn raw(length: u32, body: &[u8]) -> Vec<u8> {
        let mut out = length.to_le_bytes().to_vec();
        out.extend_from_slice(body);
        out
    }

    fn read(bytes: &[u8]) -> Result<Option<Frame>, Fault> {
        read_frame(&mut &bytes[..])
    }

    #[test]
    fn reads_a_frame_and_a_clean_end_between_frames() {
        let mut stream = raw(3, &[7, 1, 2]);
        stream.extend(raw(1, &[9]));
        let mut input = &stream[..];
        assert_eq!(read_frame(&mut input), Ok(Some(Frame { kind: 7, payload: vec![1, 2] })));
        assert_eq!(read_frame(&mut input), Ok(Some(Frame { kind: 9, payload: vec![] })));
        assert_eq!(read_frame(&mut input), Ok(None));
    }

    #[test]
    fn refuses_every_hostile_frame_shape() {
        let rows: [(&str, Vec<u8>, Fault); 7] = [
            ("half a length", vec![3, 0], Fault::Truncated),
            ("a length and no kind", raw(2, &[]), Fault::Truncated),
            ("a payload cut short", raw(10, &[1, 2, 3]), Fault::Truncated),
            ("a zero length", raw(0, &[1]), Fault::Empty),
            ("a length past the cap", raw(MAX_FRAME_BYTES + 1, &[1]), Fault::Oversize(MAX_FRAME_BYTES + 1)),
            ("the largest u32", raw(u32::MAX, &[]), Fault::Oversize(u32::MAX)),
            ("a cap-sized length with nothing behind it", raw(MAX_FRAME_BYTES, &[1]), Fault::Truncated),
        ];
        for (name, bytes, fault) in rows {
            assert_eq!(read(&bytes), Err(fault), "{name}");
        }
    }

    #[test]
    fn reads_every_field_and_refuses_each_malformed_one() {
        let mut writer = Writer::new(1);
        writer.u8(5).bool(true).u32(7).f64(-1.5).str("hé").opt_str(None).opt_str(Some("x")).f32s(&[1.5, f32::NAN]);
        let frame = writer.finish().expect("fits");
        let payload = &frame[LENGTH_BYTES + 1..];
        let mut reader = Reader::new(payload);
        assert_eq!(reader.u8(), Ok(5));
        assert_eq!(reader.bool(), Ok(true));
        assert_eq!(reader.u32(), Ok(7));
        assert_eq!(reader.f64(), Ok(-1.5));
        assert_eq!(reader.str(), Ok("hé"));
        assert_eq!(reader.opt_str(), Ok(None));
        assert_eq!(reader.opt_str(), Ok(Some("x")));
        let floats = reader.f32s().expect("floats");
        assert_eq!((floats[0], floats[1].is_nan()), (1.5, true), "f32s cross bit for bit");
        assert_eq!(reader.finish(), Ok(()));

        let hostile: [(&str, Vec<u8>, FieldRead, Fault); 9] = [
            ("a flag of 2", vec![2], |r| r.bool().map(drop), Fault::BadFlag(2)),
            ("a u32 of three bytes", vec![1, 2, 3], |r| r.u32().map(drop), Fault::ShortPayload),
            ("a string longer than the payload", [9u32.to_le_bytes().as_slice(), b"abc"].concat(), |r| r.str().map(drop), Fault::ShortPayload),
            ("a string that is not UTF-8", [2u32.to_le_bytes().as_slice(), &[0xc3, 0x28]].concat(), |r| r.str().map(drop), Fault::BadUtf8),
            ("a float count past the payload", [u32::MAX.to_le_bytes().as_slice(), &[0; 8]].concat(), |r| r.f32s().map(drop), Fault::ShortPayload),
            ("an f64 count whose bytes overflow", [u32::MAX.to_le_bytes().as_slice()].concat(), |r| r.f64s().map(drop), Fault::ShortPayload),
            ("a u32 array cut mid-value", [2u32.to_le_bytes().as_slice(), &[0; 6]].concat(), |r| r.u32s().map(drop), Fault::ShortPayload),
            ("a NaN tick", f64::NAN.to_le_bytes().to_vec(), |r| r.tick().map(drop), Fault::BadNumber),
            ("an option flag of 7", vec![7], |r| r.opt_str().map(drop), Fault::BadFlag(7)),
        ];
        for (name, bytes, read, fault) in hostile {
            assert_eq!(read(&mut Reader::new(&bytes)), Err(fault), "{name}");
        }
        assert_eq!(Reader::new(&[1, 2]).finish(), Err(Fault::TrailingBytes(2)));
    }

    #[test]
    fn a_negative_tick_is_none_and_reads_as_given() {
        assert_eq!(Reader::new(&(-1.0f64).to_le_bytes()).tick(), Ok(-1.0));
        assert_eq!(Reader::new(&f64::INFINITY.to_le_bytes()).tick(), Ok(f64::INFINITY));
    }
}
