//! Windows: the named pipe the game launcher made for this run (`GENEX_STUDIO_PIPE`), opened
//! overlapped as the C++ `PipeChannel` does: the reader thread waits on a read while the main
//! thread writes (a synchronous handle would make them wait for each other), a wake event ends a
//! blocked read, and a write that stalls past `WRITE_STALL` gives up on the studio.
#![allow(unsafe_code)] // Overlapped pipe I/O is Win32 FFI; std has no overlapped handles.

use std::io;
use std::sync::Arc;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE,
    GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, SECURITY_ANONYMOUS, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects, WaitForSingleObject,
};

use crate::transport::{Channel, WRITE_STALL};

/// The most bytes one pipe read or write asks for (well inside a DWORD).
const PIPE_CHUNK_BYTES: usize = 1 << 20;

/// An owned kernel handle.
struct Owned(HANDLE);

// SAFETY: a kernel handle is a process-wide index, usable from any thread; the pipe's reads and
// writes each use their own event and OVERLAPPED, and writes are serialized by the transport's lock.
unsafe impl Send for Owned {}
// SAFETY: as above.
unsafe impl Sync for Owned {}

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by this module and is closed once, here.
        unsafe { CloseHandle(self.0) };
    }
}

/// The pipe and its three events: a read finished, a write finished, wake the reader.
struct PipeChannel {
    pipe: Owned,
    read_done: Owned,
    write_done: Owned,
    wake: Owned,
}

/// The pipe's end, or a failure: the launcher closing its side is the studio's end of the connection.
fn pipe_ended(error: u32) -> io::Result<usize> {
    if error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED {
        return Ok(0);
    }
    Err(io::Error::from_raw_os_error(error as i32))
}

fn manual_event() -> Option<Owned> {
    // SAFETY: no attributes, manual reset, unsignalled, unnamed.
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() { None } else { Some(Owned(event)) }
}

/// The pipe `name` (already checked to be a run's own), opened as its anonymous client.
pub(crate) fn open(name: &str) -> Option<Arc<dyn Channel>> {
    // The name is ASCII (studio_pipe_name checked it), so each byte widens to its UTF-16 unit.
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // Anonymous to the launcher's end: the pipe's server may not act as the game.
    let flags = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS;
    // SAFETY: `wide` is NUL-terminated and outlives the call; no security attributes or template.
    let pipe = unsafe {
        CreateFileW(wide.as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, std::ptr::null(), OPEN_EXISTING, flags, std::ptr::null_mut())
    };
    if pipe == INVALID_HANDLE_VALUE {
        return None;
    }
    let pipe = Owned(pipe);
    let channel = PipeChannel { pipe, read_done: manual_event()?, write_done: manual_event()?, wake: manual_event()? };
    Some(Arc::new(channel))
}

impl Channel for PipeChannel {
    fn read(&self, into: &mut [u8]) -> io::Result<usize> {
        let mut overlapped = OVERLAPPED { hEvent: self.read_done.0, ..OVERLAPPED::default() };
        let want = into.len().min(PIPE_CHUNK_BYTES) as u32;
        // SAFETY: `into` and `overlapped` outlive the operation: every path below waits for it to
        // finish (or cancels it and waits) before returning.
        let started = unsafe { ReadFile(self.pipe.0, into.as_mut_ptr(), want, std::ptr::null_mut(), &mut overlapped) };
        // SAFETY: plain thread-local error read.
        if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return pipe_ended(unsafe { GetLastError() });
        }
        let waits = [self.read_done.0, self.wake.0];
        let mut got = 0u32;
        // SAFETY: both handles are open events owned by this channel.
        let woke = unsafe { WaitForMultipleObjects(2, waits.as_ptr(), 0, INFINITE) };
        if woke != WAIT_OBJECT_0 {
            // Interrupted: the transport is closing. The read must be over before its buffer goes away.
            // SAFETY: cancels this operation only, then waits for it to complete.
            unsafe {
                CancelIoEx(self.pipe.0, &overlapped);
                GetOverlappedResult(self.pipe.0, &overlapped, &mut got, 1);
            }
            return Ok(0);
        }
        // SAFETY: the operation completed (its event is signalled).
        if unsafe { GetOverlappedResult(self.pipe.0, &overlapped, &mut got, 0) } == 0 {
            return pipe_ended(unsafe { GetLastError() });
        }
        Ok(got as usize)
    }

    fn write_all(&self, bytes: &[u8]) -> bool {
        let stall = WRITE_STALL.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        let mut rest = bytes;
        while !rest.is_empty() {
            let mut overlapped = OVERLAPPED { hEvent: self.write_done.0, ..OVERLAPPED::default() };
            let chunk = rest.len().min(PIPE_CHUNK_BYTES) as u32;
            // SAFETY: `rest` and `overlapped` outlive the operation, as in `read`.
            let started = unsafe { WriteFile(self.pipe.0, rest.as_ptr(), chunk, std::ptr::null_mut(), &mut overlapped) };
            if started == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
                return false; // ERROR_NO_DATA and the like: the studio is gone
            }
            let mut wrote = 0u32;
            // SAFETY: an open event owned by this channel.
            if unsafe { WaitForSingleObject(self.write_done.0, stall) } != WAIT_OBJECT_0 {
                // SAFETY: cancel this write, then wait for it before its buffer goes away.
                unsafe {
                    CancelIoEx(self.pipe.0, &overlapped);
                    GetOverlappedResult(self.pipe.0, &overlapped, &mut wrote, 1);
                }
                return false;
            }
            // SAFETY: the operation completed.
            let done = unsafe { GetOverlappedResult(self.pipe.0, &overlapped, &mut wrote, 0) };
            if done == 0 || wrote == 0 {
                return false;
            }
            rest = &rest[wrote as usize..];
        }
        true
    }

    fn interrupt(&self) {
        // SAFETY: an open event owned by this channel.
        unsafe { SetEvent(self.wake.0) };
    }
}
