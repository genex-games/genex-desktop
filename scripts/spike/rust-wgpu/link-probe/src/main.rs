//! Link probe (M0a.8): references cpal's ALSA host and gilrs's udev backend so a Linux cross
//! build must resolve libasound and libudev. Run on a machine, it prints what it found.

use cpal::traits::{DeviceTrait, HostTrait};

fn main() {
    let host = cpal::default_host();
    let output = host.default_output_device().and_then(|device| device.description().ok().map(|d| format!("{d:?}")));
    let pads = gilrs::Gilrs::new().map(|gilrs| gilrs.gamepads().count()).unwrap_or(0);
    println!("{{\"audioHost\":{:?},\"output\":{:?},\"gamepads\":{pads}}}", host.id().name(), output);
}
