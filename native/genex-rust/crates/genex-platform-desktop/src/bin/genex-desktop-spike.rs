//! Q1 spike: one binary, two modes. `--headless` (or `GENEX_HEADLESS=1`) runs the frame loop with
//! no window and no EventLoop; without it the same binary opens a winit window. `--frames N`
//! bounds the run. Prints one JSON line: the mode, frames run, whether an EventLoop was created
//! and how many surfaces the game was given.

use genex_platform_desktop::{FrameControl, ShellFrame, ShellGame, ShellMode, ShellSurface, event_loop_created, run};

/// Frames a run lasts without `--frames`.
const DEFAULT_FRAMES: u64 = 120;
const FRAMES_FLAG: &str = "--frames";

#[derive(Default)]
struct Spike {
    surfaces: u32,
    presented: u64,
}

impl ShellGame for Spike {
    fn title(&self) -> String {
        "genex desktop spike".to_owned()
    }

    fn world_size(&self) -> [u32; 2] {
        [320, 180]
    }

    fn surface_created(&mut self, _surface: &ShellSurface) {
        self.surfaces += 1;
    }

    fn frame(&mut self, frame: ShellFrame) -> FrameControl {
        if frame.present {
            self.presented += 1;
        }
        FrameControl::Continue
    }
}

fn frames_arg(args: &[String]) -> Result<u64, String> {
    let Some(at) = args.iter().position(|arg| arg == FRAMES_FLAG) else { return Ok(DEFAULT_FRAMES) };
    let value = args.get(at + 1).ok_or_else(|| format!("{FRAMES_FLAG} needs a count"))?;
    value.parse().map_err(|_| format!("{FRAMES_FLAG} {value:?} is not a count"))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let frames = frames_arg(&args).unwrap_or_else(|error| {
        eprintln!("genex-desktop-spike: {error}");
        std::process::exit(2);
    });
    let mode = ShellMode::from_process();
    match run(Spike::default(), mode, Some(frames)) {
        Ok((spike, exit)) => println!(
            r#"{{"mode":"{}","frames":{},"eventLoop":{},"surfaces":{},"presented":{}}}"#,
            mode.as_str(),
            exit.frames,
            event_loop_created(),
            spike.surfaces,
            spike.presented
        ),
        Err(error) => {
            eprintln!("genex-desktop-spike: {error}");
            std::process::exit(1);
        }
    }
}
