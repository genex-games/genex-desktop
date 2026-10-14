//! The on-device self-test: the first time a GPU is open the shell runs the game's self-test
//! sequence (genex-platform-web's, so the record matches `pond --self-test` on the Mac byte for
//! byte when the GPU agrees) and writes the record into the records folder before live play
//! starts. The person pulls it (M0a.11 on the iPhone, M2.13 on the emulator) for the parity row.

use crate::mobile::records::Records;
use genex_platform_web::selftest::{self, CaptureDigest, SelfTestError, SelfTestPlan};
use genex_platform_web::{AssetTable, GameHandle, MeshCache, to_scene};
use genex_render::capture::hex64;
use genex_render::{CullPath, Gpu, RenderError, Renderer};
use std::fmt;
use std::path::PathBuf;

/// Ticks the on-device self-test runs after its demo (the parity rows' 600).
pub const SELF_TEST_TICKS: u32 = 600;

/// The plan the shell runs for `game`: the default seed, the game's demo, [`SELF_TEST_TICKS`].
pub fn device_plan(game: &str, demo: &str) -> SelfTestPlan {
    SelfTestPlan { game: game.to_owned(), seed: genex::DEFAULT_SEED, demo: demo.to_owned(), ticks: SELF_TEST_TICKS }
}

/// Why the on-device self-test left no record.
#[derive(Debug)]
pub enum SelfTestFailure {
    /// The sequence stopped (unknown demo, failed capture).
    Run(SelfTestError),
    /// The record could not be written.
    Write(std::io::Error),
}

impl SelfTestFailure {
    /// The typed code's wire spelling.
    pub fn code(&self) -> &'static str {
        match self {
            SelfTestFailure::Run(error) => error.code(),
            SelfTestFailure::Write(_) => "write-failed",
        }
    }
}

impl fmt::Display for SelfTestFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SelfTestFailure::Run(error) => write!(f, "{error}"),
            SelfTestFailure::Write(error) => write!(f, "write-failed: {error}"),
        }
    }
}

impl std::error::Error for SelfTestFailure {}

/// Run `plan` on `game` with `capture` and write the record; answers its path. The game is left
/// paused on the self-test's last tick (the shell reseeds before live play).
pub fn run_and_record(
    game: &mut dyn GameHandle,
    plan: &SelfTestPlan,
    records: &Records,
    capture: impl FnMut(&mut dyn GameHandle) -> Result<CaptureDigest, String>,
) -> Result<PathBuf, SelfTestFailure> {
    let record = selftest::run(game, plan, capture).map_err(SelfTestFailure::Run)?;
    records.write_self_test(&plan.game, plan.ticks, plan.seed, &plan.demo, &record).map_err(SelfTestFailure::Write)
}

/// The GPU capture the device self-test uses: render the game's own view into the world target
/// and read it back (the same steps as `pond --self-test`).
pub fn gpu_capture(
    game: &mut dyn GameHandle,
    gpu: &Gpu,
    renderer: &mut Renderer,
    meshes: &mut MeshCache,
    assets: AssetTable,
) -> Result<CaptureDigest, RenderError> {
    let (frame, camera) = game.frame();
    meshes.load(&frame, assets, |mesh| renderer.add_mesh(gpu, mesh));
    renderer.render(gpu, &to_scene(&frame, &camera, meshes), CullPath::Gpu)?;
    let capture = renderer.capture(gpu)?;
    Ok(CaptureDigest { tick: game.tick(), width: capture.width(), height: capture.height(), digest: hex64(capture.digest()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex::{Runtime, Value, json};

    fn fake_capture(game: &mut dyn GameHandle) -> Result<CaptureDigest, String> {
        let [width, height] = game.world_size();
        Ok(CaptureDigest { tick: game.tick(), width, height, digest: format!("{:016x}", game.tick()) })
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-mobile-selftest-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_shell_writes_the_pond_self_test_record_into_its_records_root() {
        let documents = scratch("pond");
        let records = Records::new(&documents, "ios");
        let plan = device_plan(pond_game::NAME, pond_game::DEFAULT_DEMO);
        let mut game = Runtime::new(pond_game::game()).expect("pond installs");
        let path = run_and_record(&mut game, &plan, &records, fake_capture).expect("recorded");
        assert_eq!(path, documents.join("genex-self-test/pond-600-seed1-cast.ios.json"));
        let record: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(record["format"], json!(genex_platform_web::SELF_TEST_FORMAT));
        assert_eq!(record["game"], json!("pond"));
        assert_eq!(record["ticks"], json!(SELF_TEST_TICKS));
        assert_eq!(record["captures"].as_array().map(Vec::len), Some(4), "0, 200, 400, 600");

        // A second launch overwrites the record with identical bytes.
        let first = std::fs::read(&path).expect("read");
        let mut again = Runtime::new(pond_game::game()).expect("pond installs");
        run_and_record(&mut again, &plan, &records, fake_capture).expect("recorded");
        assert_eq!(std::fs::read(&path).expect("read"), first);
        let _ = std::fs::remove_dir_all(documents);
    }

    #[test]
    fn a_failed_capture_leaves_no_record() {
        let documents = scratch("fail");
        let records = Records::new(&documents, "android");
        let plan = device_plan(pond_game::NAME, pond_game::DEFAULT_DEMO);
        let mut game = Runtime::new(pond_game::game()).expect("pond installs");
        let failure =
            run_and_record(&mut game, &plan, &records, |_| Err("capture-failed: lost".to_owned())).expect_err("refused");
        assert_eq!(failure.code(), "capture-failed");
        assert!(!records.self_test_path("pond", 600, 1, "cast").exists());
        let _ = std::fs::remove_dir_all(documents);
    }
}
