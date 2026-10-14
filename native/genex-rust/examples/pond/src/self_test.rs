//! The native `--self-test` mode: genex-platform-web's self-test sequence with a headless capture
//! on the host GPU, drawn as the web build's `studio_self_test` draws it: through the facade's
//! presenter with the game's passes, on the pinned capture profile (pass-1 gate, RX.R8: the native
//! side drew the bare renderer's legacy scene while the web drew the pinned HDR profile, a mean
//! channel difference of 18). `--receipt <file>` also writes the GPU's capability receipt (tier,
//! backend, adapter, offered native-enhanced features) as JSON, for the spike CI rows (M0a.13).

use genex::Runtime;
use genex::present::Presenter;
use genex_platform_web::GameHandle;
use genex_platform_web::selftest::{self, CaptureDigest, SelfTestPlan};
use genex_render::RenderError;
use genex_render::capture::{CaptureFiles, hex64};
use std::path::Path;

/// Exit codes.
const EXIT_REFUSED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const USAGE: &str = "usage: pond [--self-test <ticks> [--seed <n>] [--demo <name>] [--out <file>] [--state-dir <dir>] [--receipt <file>]]";

/// The parsed command line.
struct Options {
    plan: SelfTestPlan,
    out: Option<String>,
    state_dir: Option<String>,
    receipt: Option<String>,
}

fn refuse(code: &str, detail: impl std::fmt::Display) -> i32 {
    let line = genex::json!({ "code": code, "detail": detail.to_string() });
    eprintln!("pond: {line}");
    EXIT_REFUSED
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut plan = SelfTestPlan {
        game: pond_game::NAME.to_owned(),
        seed: genex::DEFAULT_SEED,
        demo: pond_game::DEFAULT_DEMO.to_owned(),
        ticks: 0,
    };
    let (mut ticks, mut out, mut state_dir, mut receipt) = (None, None, None, None);
    let mut rest = args.iter();
    while let Some(flag) = rest.next() {
        let value = rest.next().ok_or_else(|| format!("{flag} needs a value"))?;
        let number = || value.parse::<u32>().map_err(|_| format!("{flag} needs a whole number, not {value:?}"));
        match flag.as_str() {
            "--self-test" => ticks = Some(number()?),
            "--seed" => plan.seed = number()?,
            "--demo" => value.clone_into(&mut plan.demo),
            "--out" => out = Some(value.clone()),
            "--state-dir" => state_dir = Some(value.clone()),
            "--receipt" => receipt = Some(value.clone()),
            _ => return Err(format!("unknown flag {flag}")),
        }
    }
    plan.ticks = ticks.ok_or("--self-test <ticks> is required")?;
    Ok(Options { plan, out, state_dir, receipt })
}

/// Draw the game's own view as a capture (the pinned profile, the game's passes) and read it back.
fn capture(game: &mut dyn GameHandle, presenter: &mut Presenter, files: Option<&mut CaptureFiles>) -> Result<CaptureDigest, RenderError> {
    presenter.set_capturing(true);
    let drawn = game.draw(presenter, None);
    presenter.set_capturing(false);
    if let Some(Err(error)) = drawn {
        return Err(error);
    }
    let capture = presenter.resilient.capture()?;
    if let Some(files) = files {
        files.write(&capture)?;
    }
    Ok(CaptureDigest { tick: game.tick(), width: capture.width(), height: capture.height(), digest: hex64(capture.digest()) })
}

/// Run the self-test for `args`; answers the exit code.
pub fn main(args: &[String]) -> i32 {
    let options = match parse(args) {
        Ok(options) => options,
        Err(problem) => {
            eprintln!("pond: {problem}\n{USAGE}");
            return EXIT_USAGE;
        }
    };
    let mut files = match options.state_dir.as_deref().map(|dir| CaptureFiles::new(Path::new(dir))).transpose() {
        Ok(files) => files,
        Err(error) => return refuse(error.code().wire(), error),
    };
    let mut presenter = match Presenter::open(pond_game::WORLD_SIZE, pond_game::ASSETS) {
        Ok(presenter) => presenter,
        Err(error) => return refuse(error.code().wire(), error),
    };
    if let Some(path) = options.receipt.as_deref()
        && let Err(error) = std::fs::write(path, presenter.gpu().receipt().to_json())
    {
        return refuse("write-failed", format!("{path}: {error}"));
    }
    let mut game = match Runtime::new(pond_game::game()) {
        Ok(runtime) => runtime,
        Err(error) => return refuse(error.code().as_str(), error),
    };
    for (name, error) in GameHandle::install_passes(&mut game, &mut presenter) {
        eprintln!("pond: custom pass {name} refused: {error}");
    }
    let record = selftest::run(&mut game, &options.plan, |game| {
        capture(game, &mut presenter, files.as_mut()).map_err(|error| error.to_string())
    });
    let record = match record {
        Ok(record) => record,
        Err(error) => return refuse(error.code(), error),
    };
    match options.out {
        Some(path) => match std::fs::write(&path, record) {
            Ok(()) => 0,
            Err(error) => refuse("write-failed", format!("{path}: {error}")),
        },
        None => {
            print!("{record}");
            0
        }
    }
}
