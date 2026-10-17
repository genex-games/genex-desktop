//! Uploads replayed from their source (renderer pass 2, review F6): `Resilient` replays every
//! upload after a device loss and onto a rebuilt renderer, and kept a CPU copy of each for it. A
//! mesh or texture added with a source (`add_meshes_from`, `add_texture_from`) keeps only the
//! source, which a replay calls on whichever thread builds the renderer.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test replay_sources -- --include-ignored

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use genex_render::device_loss::{ModelParts, Resilient};
use genex_render::immediate::ImmediateFrame;
use genex_render::mesh::MeshData;
use genex_render::scene::{CameraDesc, Material, translation};
use genex_render::texture::{TextureData, TextureKind};
use genex_render::{CullPath, Gpu, RenderCode, RenderError, RenderOptions};

const WIDTH: u32 = 96;
const HEIGHT: u32 = 64;

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => None,
    }
}

fn parts() -> ModelParts {
    vec![genex_render::scene::ModelPart::whole(MeshData::cube())]
}

fn texture() -> TextureData {
    TextureData::rgba8(2, 2, vec![255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]).expect("a 2x2 texture")
}

/// Counts its calls and fails once `broken` is set.
struct Counted {
    calls: AtomicU32,
    broken: AtomicBool,
}

impl Counted {
    fn new() -> Arc<Counted> {
        Arc::new(Counted { calls: AtomicU32::new(0), broken: AtomicBool::new(false) })
    }

    fn call(&self) -> Result<(), RenderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.broken.load(Ordering::SeqCst) {
            return Err(RenderError::refused(RenderCode::MeshInvalid, "the source is gone"));
        }
        Ok(())
    }

    fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_sourced_uploads_keep_nothing_and_replay_from_their_source_on_a_rebuild_and_a_recovery() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = Resilient::new(gpu, WIDTH, HEIGHT, RenderOptions::default(), Gpu::headless).expect("resilient");
    let (meshes, textures) = (Counted::new(), Counted::new());
    let mesh_source = Arc::clone(&meshes);
    let ids = resilient.add_meshes_from(parts(), Arc::new(move || mesh_source.call().map(|()| parts()))).expect("meshes");
    let texture_source = Arc::clone(&textures);
    let id = resilient.add_texture_from(&texture(), TextureKind::Color, Arc::new(move || texture_source.call().map(|()| texture()))).expect("texture");
    assert_eq!(resilient.kept_bytes(), 0, "a sourced upload keeps no copy");
    assert_eq!((meshes.calls(), textures.calls()), (0, 0), "nothing decodes again until a replay");
    let kept = resilient.add_texture(&texture(), TextureKind::Color).expect("a plain texture");
    assert_eq!(resilient.kept_bytes(), 16, "a plain upload keeps its data");

    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 1.5, 4.0], [0.0, 0.0, 0.0]), [20, 24, 32, 255]);
    frame.mesh(ids[0], translation(-0.8, 0.0, 0.0), Material::color([255, 255, 255, 255]).with_base_texture(id));
    frame.mesh(ids[0], translation(0.8, 0.0, 0.0), Material::color([255, 255, 255, 255]).with_base_texture(kept));
    resilient.render(&frame, CullPath::Gpu, None).expect("frame");
    let before = resilient.capture().expect("capture").digest();

    // A rebuild for other options replays the uploads onto the new renderer.
    let other = RenderOptions { msaa: !RenderOptions::default().msaa };
    assert!(resilient.rebuild_with(other).expect("rebuilt"));
    assert_eq!((meshes.calls(), textures.calls()), (1, 1), "the rebuild decoded each again");
    assert!(resilient.rebuild_with(RenderOptions::default()).expect("rebuilt back"));
    resilient.render(&frame, CullPath::Gpu, None).expect("frame");
    assert_eq!(resilient.capture().expect("capture").digest(), before, "the replayed uploads draw the same picture");

    // A recovery replays them on a new device.
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovered"));
    resilient.render(&frame, CullPath::Gpu, None).expect("frame after recovery");
    assert_eq!(resilient.capture().expect("capture").digest(), before, "and so does a recovery");

    // A source that fails leaves the device lost, with its refusal, to try again later.
    meshes.broken.store(true, Ordering::SeqCst);
    resilient.force_device_loss();
    let refused = resilient.recover().expect_err("the source failed");
    assert_eq!(refused.code(), RenderCode::MeshInvalid);
    assert!(resilient.is_lost(), "still lost: the next recovery tries again");
    meshes.broken.store(false, Ordering::SeqCst);
    assert!(resilient.recover().expect("recovered"));
}
