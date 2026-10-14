//! The send side of the per-run Mach service: look-up and one message per frame
//! (`gxf_sender_connect` and `gxf_send_surface` in `native/genex-frames/sender/gxf_sender.c`).

use std::ffi::CString;

use mach2::bootstrap::{bootstrap_look_up, bootstrap_port};
use mach2::kern_return::{KERN_RESOURCE_SHORTAGE, kern_return_t};
use mach2::mach_port::mach_port_deallocate;
use mach2::message::{
    MACH_MSG_SUCCESS, MACH_SEND_INTERRUPTED, MACH_SEND_MSG, MACH_SEND_TIMED_OUT, MACH_SEND_TIMEOUT, mach_msg,
    mach_msg_destroy, mach_msg_timeout_t,
};
use mach2::port::{MACH_PORT_NULL, mach_port_t};
use mach2::traps::mach_task_self;
use objc2_io_surface::IOSurfaceRef;

use crate::error::{FramesCode, FramesError};
use crate::wire::{FrameMsg, FramePayload, ServiceName};

/// A send right to the run's frames service; dropped with the connection.
#[derive(Debug)]
pub struct Connection {
    service: mach_port_t,
}

impl Connection {
    /// Looks up the run's service. Refuses [`FramesCode::LookupFailed`] with the kernel code
    /// (1102 unknown service, 1100 a sandbox denial) when the name is not this run's.
    pub fn look_up(name: &ServiceName) -> Result<Connection, FramesError> {
        // ServiceName admits only [A-Za-z0-9.-], so there is no interior NUL.
        let c_name = CString::new(name.as_str())
            .map_err(|_| FramesError::new(FramesCode::InvalidServiceName, name.as_str().to_owned()))?;
        let mut service: mach_port_t = MACH_PORT_NULL;
        // SAFETY: a valid NUL-terminated name and out-pointer; bootstrap_port is this task's.
        let kr = unsafe { bootstrap_look_up(bootstrap_port, c_name.as_ptr(), &mut service) };
        if kr != 0 {
            let detail = format!("bootstrap_look_up {}: {kr}", name.as_str());
            return Err(FramesError::new(FramesCode::LookupFailed, detail).with_kern_return(kr));
        }
        Ok(Connection { service })
    }

    /// Adopts a send right this task already owns (a test's own receive port, an inherited right).
    pub fn from_send_right(service: mach_port_t) -> Connection {
        Connection { service }
    }

    /// Sends one frame message moving a send right to `surface`. Returns the `mach_msg` code;
    /// on any failure no right is leaked (the C sender's rules for a pseudo-received message).
    pub fn send_surface(&self, surface: &IOSurfaceRef, payload: FramePayload, timeout_ms: mach_msg_timeout_t) -> kern_return_t {
        let port = surface.create_mach_port();
        if port == MACH_PORT_NULL {
            return KERN_RESOURCE_SHORTAGE;
        }
        let mut message = FrameMsg::new(self.service, port, payload);
        let header = std::ptr::addr_of_mut!(message.header);
        // SAFETY: `message` is a complete 80-byte frame message that outlives the call.
        let kr = unsafe {
            mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, size_of::<FrameMsg>() as u32, 0, MACH_PORT_NULL, timeout_ms, MACH_PORT_NULL)
        };
        if kr == MACH_SEND_TIMED_OUT || kr == MACH_SEND_INTERRUPTED {
            // Pseudo-received: the kernel copied the rights back out into `message` (the surface
            // right under a possibly new name, plus the extra destination right): destroy it.
            // SAFETY: the header is the pseudo-received message the kernel just wrote.
            unsafe { mach_msg_destroy(header) };
        } else if kr != MACH_MSG_SUCCESS {
            // Never copied in: the right is still under its original name.
            // SAFETY: `port` is a send right this task made above.
            unsafe { mach_port_deallocate(mach_task_self(), port) };
        }
        kr
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if self.service != MACH_PORT_NULL {
            // SAFETY: the connection owns one user reference of this send right.
            unsafe { mach_port_deallocate(mach_task_self(), self.service) };
        }
    }
}
