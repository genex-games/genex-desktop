//! Rust test sender: the stand-in for a Rust game in embedded play, speaking the C test sender's
//! JSON-lines subset of the fd-3 protocol (`native/genex-frames/sender/gxf_test_sender.c`):
//!
//!   host -> game  {"id":1,"op":"surface","arg":{"w":1280,"h":720,"generation":1,"slots":3}}
//!                 {"id":2,"op":"start","arg":{"frames":600,"fps":60}}      fps 0 = unpaced
//!                 {"id":3,"op":"release","arg":{"generation":1,"slot":0}}
//!                 {"id":4,"op":"quit"}
//!   game -> host  {"op":"ready","pid":N,"lookup":0,"backend":"metal","adapter":"..."}
//!                 {"id":1,"ok":true,"op":"surface","result":{"ring":[{"slot":0,"surfaceId":N},...]},"adopted":true}
//!                 {"op":"frame","seq":N,"slot":N,"ts":N,"kr":0}
//!                 {"op":"done","frames":N,"releases":N,"elapsedMs":N}
//!                 {"op":"error","step":"...","code":"..."}
//!
//! Each frame is the C sender's pattern, uploaded top-down to a wgpu texture and presented through
//! `FrameSender` (bottom-up blit into the IOSurface slot, GPU wait, Mach send).
//!
//! Usage: gxf-rust-test-sender --service NAME [--fd 3]
#![cfg_attr(target_os = "macos", allow(unsafe_code, reason = "adopts the inherited control descriptor"))]

#[cfg(target_os = "macos")]
fn main() {
    std::process::exit(mac::main());
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("gxf-rust-test-sender: macOS only");
    std::process::exit(64);
}

#[cfg(target_os = "macos")]
mod mac {
    use std::fs::File;
    use std::io::{BufRead, BufReader, Write};
    use std::os::fd::FromRawFd;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::time::{Duration, Instant};

    use genex_frames::FramesError;
    use genex_frames::connection::Connection;
    use genex_frames::gpu::MetalGpu;
    use genex_frames::ring::RingSpec;
    use genex_frames::sender::FrameSender;
    use genex_frames::surface::SlotSurface;
    use genex_frames::wire::ServiceName;

    /// The sender exits when the host says nothing for this long.
    const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
    const DEFAULT_FD: i32 = 3;
    const USAGE_EXIT: i32 = 64;
    const LOOKUP_EXIT: i32 = 2;
    const GPU_EXIT: i32 = 4;
    const IDLE_EXIT: i32 = 3;

    /// The C sender's pattern for image pixel (x, y), y = 0 the top, as BGRA bytes.
    fn pattern(x: u32, y: u32, seq: u32) -> [u8; 4] {
        let r = x.wrapping_add(seq.wrapping_mul(3)) & 255;
        let g = y.wrapping_add(seq.wrapping_mul(5)) & 255;
        let b = ((x >> 8) * 64 + (y >> 8) * 16).wrapping_add(seq.wrapping_mul(7)) & 255;
        [b as u8, g as u8, r as u8, 255]
    }

    /// The number after `"key":` in a line, as the C sender reads it.
    fn number(line: &str, key: &str) -> Option<u64> {
        let needle = format!("\"{key}\":");
        let at = line.find(&needle)? + needle.len();
        let digits: String = line[at..].chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    }

    fn has_op(line: &str, op: &str) -> bool {
        line.contains(&format!("\"op\":\"{op}\""))
    }

    struct Control {
        out: File,
    }

    impl Control {
        fn emit(&mut self, line: &str) {
            if self.out.write_all(format!("{line}\n").as_bytes()).is_err() {
                std::process::exit(5);
            }
        }

        fn error(&mut self, step: &str, error: &FramesError) {
            let code = error.code.as_str();
            self.emit(&format!("{{\"op\":\"error\",\"step\":\"{step}\",\"code\":\"{code}\"}}"));
        }
    }

    /// The source frame the "game" renders: a top-down BGRA texture of the ring size.
    struct Source {
        texture: wgpu::Texture,
        view: wgpu::TextureView,
    }

    impl Source {
        fn new(gpu: &MetalGpu, width: u32, height: u32) -> Source {
            let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("test frame"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Bgra8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            Source { texture, view }
        }

        fn draw(&self, gpu: &MetalGpu, seq: u64) {
            let size = self.texture.size();
            let seq = seq as u32;
            let pixels: Vec<u8> =
                (0..size.height).flat_map(|y| (0..size.width).flat_map(move |x| pattern(x, y, seq))).collect();
            gpu.queue.write_texture(
                self.texture.as_image_copy(),
                &pixels,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.width * 4), rows_per_image: None },
                size,
            );
        }
    }

    struct Session {
        gpu: MetalGpu,
        sender: FrameSender,
        control: Control,
        source: Option<Source>,
        target: u64,
        sent: u64,
        releases: u64,
        frame_interval: Option<Duration>,
        next_at: Instant,
        started_at: Instant,
        running: bool,
    }

    impl Session {
        fn surface(&mut self, line: &str) {
            let id = number(line, "id").unwrap_or(0);
            let field = |key| number(line, key).and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
            let spec = RingSpec::new(field("generation"), field("w"), field("h"), number(line, "slots").map_or(3, |n| n as u32));
            let made = spec.and_then(|spec| self.sender.set_ring(&self.gpu.device, spec).map(|info| (spec, info)));
            match made {
                Ok((spec, info)) => {
                    let adopted = (0..spec.slots() as u16)
                        .all(|slot| self.sender.slot(slot).is_some_and(SlotSurface::texture_is_backed_by_surface));
                    self.source = Some(Source::new(&self.gpu, spec.width(), spec.height()));
                    let ring: Vec<String> =
                        info.iter().map(|s| format!("{{\"slot\":{},\"surfaceId\":{}}}", s.slot, s.surface_id)).collect();
                    let ring = ring.join(",");
                    let line = format!(
                        "{{\"id\":{id},\"ok\":true,\"op\":\"surface\",\"result\":{{\"ring\":[{ring}]}},\"adopted\":{adopted}}}"
                    );
                    self.control.emit(&line);
                }
                Err(error) => {
                    let code = error.code.as_str();
                    self.control.emit(&format!("{{\"id\":{id},\"ok\":false,\"op\":\"surface\",\"error\":\"{code}\"}}"));
                }
            }
        }

        fn start(&mut self, line: &str) {
            self.target = number(line, "frames").unwrap_or(1);
            let fps = number(line, "fps").unwrap_or(0);
            self.frame_interval = (fps > 0).then(|| Duration::from_secs(1) / fps as u32);
            self.sent = 0;
            self.running = self.source.is_some();
            self.started_at = Instant::now();
            self.next_at = self.started_at;
            let id = number(line, "id").unwrap_or(0);
            self.control.emit(&format!("{{\"id\":{id},\"ok\":{},\"op\":\"start\",\"result\":{{}}}}", self.running));
        }

        fn handle(&mut self, line: &str) -> bool {
            if has_op(line, "surface") {
                self.surface(line);
            } else if has_op(line, "start") {
                self.start(line);
            } else if has_op(line, "release") {
                let generation = number(line, "generation").and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
                let slot = number(line, "slot").and_then(|n| u32::try_from(n).ok()).unwrap_or(u32::MAX);
                if self.sender.release(generation, slot) {
                    self.releases += 1;
                }
            } else if has_op(line, "quit") {
                return false;
            }
            true
        }

        fn can_send(&self) -> bool {
            self.running && self.sent < self.target && self.sender.free_slot().is_some()
        }

        fn send_next(&mut self) {
            let Some(source) = &self.source else { return };
            let seq = self.sent + 1;
            source.draw(&self.gpu, seq);
            match self.sender.present(&self.gpu.device, &self.gpu.queue, &source.view) {
                Ok(Some(sent)) => {
                    self.sent += 1;
                    let line =
                        format!("{{\"op\":\"frame\",\"seq\":{},\"slot\":{},\"ts\":{},\"kr\":0}}", sent.seq, sent.slot, sent.ts_us);
                    self.control.emit(&line);
                }
                Ok(None) => {}
                Err(error) => {
                    self.control.error("present", &error);
                    self.running = false;
                }
            }
            if let Some(interval) = self.frame_interval {
                // Pace like raylib's SetTargetFPS: after a stall, do not burst to catch up.
                self.next_at = (self.next_at + interval).max(Instant::now());
            }
        }

        fn finish_if_done(&mut self) {
            if self.running && self.sent == self.target && self.sender.held_mask() == 0 {
                let elapsed = self.started_at.elapsed().as_secs_f64() * 1000.0;
                let line = format!(
                    "{{\"op\":\"done\",\"frames\":{},\"releases\":{},\"elapsedMs\":{elapsed:.3}}}",
                    self.sent, self.releases
                );
                self.control.emit(&line);
                self.running = false;
            }
        }

        /// How long to wait for the host before the next frame is due.
        fn wait(&self) -> Duration {
            if !self.can_send() {
                return IDLE_TIMEOUT;
            }
            self.next_at.saturating_duration_since(Instant::now())
        }

        fn run(&mut self, lines: &Receiver<String>) -> i32 {
            let mut idle_since = Instant::now();
            loop {
                match lines.recv_timeout(self.wait()) {
                    Ok(line) => {
                        if !self.handle(&line) {
                            return 0;
                        }
                        idle_since = Instant::now();
                    }
                    Err(RecvTimeoutError::Disconnected) => return 0,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                if self.can_send() && Instant::now() >= self.next_at {
                    self.send_next();
                    idle_since = Instant::now();
                }
                self.finish_if_done();
                if idle_since.elapsed() > IDLE_TIMEOUT {
                    self.control.emit("{\"op\":\"error\",\"step\":\"idle\",\"code\":\"idle\"}");
                    return IDLE_EXIT;
                }
            }
        }
    }

    fn args() -> Option<(String, i32)> {
        let mut service = None;
        let mut fd = DEFAULT_FD;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--service" => service = args.next(),
                "--fd" => fd = args.next()?.parse().ok()?,
                _ => return None,
            }
        }
        Some((service?, fd))
    }

    /// Reads control lines on their own thread so frames keep their pace.
    fn reader(input: File) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(input).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        rx
    }

    pub fn main() -> i32 {
        let Some((service, fd)) = args() else {
            eprintln!("usage: gxf-rust-test-sender --service NAME [--fd 3]");
            return USAGE_EXIT;
        };
        // SAFETY: the host passes `fd` open both ways for this process's lifetime; it is owned here.
        let out = unsafe { File::from_raw_fd(fd) };
        let Ok(input) = out.try_clone() else { return USAGE_EXIT };
        let mut control = Control { out };
        let gpu = match MetalGpu::open() {
            Ok(gpu) => gpu,
            Err(error) => {
                control.error("gpu", &error);
                return GPU_EXIT;
            }
        };
        let connection = ServiceName::parse(&service).and_then(|name| Connection::look_up(&name));
        let lookup = match &connection {
            Ok(_) => 0,
            Err(error) => error.kern_return.unwrap_or(-1),
        };
        let backend = format!("{:?}", gpu.backend).to_lowercase();
        let adapter = gpu.adapter_name.replace(['"', '\\'], "");
        let pid = std::process::id();
        control.emit(&format!(
            "{{\"op\":\"ready\",\"pid\":{pid},\"lookup\":{lookup},\"backend\":\"{backend}\",\"adapter\":\"{adapter}\"}}"
        ));
        let Ok(connection) = connection else { return LOOKUP_EXIT };
        let sender = FrameSender::new(&gpu.device, connection);
        let now = Instant::now();
        let mut session = Session {
            gpu,
            sender,
            control,
            source: None,
            target: 0,
            sent: 0,
            releases: 0,
            frame_interval: None,
            next_at: now,
            started_at: now,
            running: false,
        };
        session.run(&reader(input))
    }
}
