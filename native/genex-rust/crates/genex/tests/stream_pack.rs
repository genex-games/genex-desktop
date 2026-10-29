//! The facade's cell pack reader and digest (release R-8): a game crate that depends only on
//! `genex` reads a compiled cell pack (`genex::pack::CellPacks`) and digests what it read
//! (`genex::digest`), with no `genex_core` or `genex_stream` of its own. The pack read goes
//! through the asset folder's checks (the asset-path rule, no link at a name below the folder),
//! so a hostile folder or file is refused with nothing read past it.
//!
//! The pack is the shared fixture `tests/fixtures/stream/cell-pack-v1.json`, the bytes the host's
//! placement compiler (C-28) writes. Only the fixture's loader below reads it as JSON; everything a
//! game would write uses `genex::` paths alone.

use genex::digest::{FNV_OFFSET_BASIS, fnv1a64, fnv1a64_from, hex64};
use genex::pack::{CellPacks, PackRefusal, StreamViewCode};
use genex::{AssetErrorCode, AssetTable, CellId};
use std::sync::LazyLock;

/// The shared cell pack fixture (held to the host's compiler by both sides' tests).
const FIXTURE: &str = include_str!("../../../../../tests/fixtures/stream/cell-pack-v1.json");
/// The pack's folder under `assets/`.
const FOLDER: &str = "valley";
/// The digest of the fixture's pack and its things, pinned on aarch64-apple-darwin and held equal
/// on x86_64 and wasm32 (release R-8).
const PACK_DIGEST: &str = "bce95da0dceb4661";

/// The fixture's files: `world.json`'s text and each cell body, by its path inside the folder.
fn fixture_files() -> Vec<(String, Vec<u8>)> {
    let value: serde_json::Value = serde_json::from_str(FIXTURE).expect("the fixture is JSON");
    let world = value["world"].as_str().expect("world text").as_bytes().to_vec();
    let mut files = vec![("world.json".to_owned(), world)];
    for cell in value["cells"].as_array().expect("cells") {
        let hex = cell["hex"].as_str().expect("hex");
        let bytes = (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex byte")).collect();
        files.push((cell["file"].as_str().expect("file").to_owned(), bytes));
    }
    files
}

/// The fixture as a game's compiled asset table, under `assets/valley/`.
static TABLE: LazyLock<AssetTable> = LazyLock::new(|| {
    let rows: Vec<(&'static str, &'static [u8])> = fixture_files()
        .into_iter()
        .map(|(file, bytes)| (&*Box::leak(format!("{FOLDER}/{file}").into_boxed_str()), &*Box::leak(bytes.into_boxed_slice())))
        .collect();
    Box::leak(rows.into_boxed_slice())
});

/// What a game digests of the pack: the pack's own digest, then each thing's kind and data text in
/// cell order, through `genex::digest` alone.
fn game_digest(packs: &CellPacks) -> String {
    let mut hash = fnv1a64_from(&packs.digest().to_le_bytes(), FNV_OFFSET_BASIS);
    for cell in packs.cells() {
        for thing in &cell.things {
            hash = fnv1a64_from(&thing.kind.to_le_bytes(), hash);
            hash = fnv1a64_from(thing.data.as_bytes(), hash);
        }
    }
    hex64(hash)
}

#[test]
fn a_game_reads_a_compiled_cell_pack_and_digests_it_through_genex_alone() {
    let packs = CellPacks::from_table(*TABLE, FOLDER).expect("the fixture pack reads");
    assert_eq!(packs.folder(), FOLDER);
    assert_eq!(packs.world().cell_size(), 64);
    let listed: Vec<CellId> = packs.world().cells().iter().map(|entry| entry.cell).collect();
    assert_eq!(listed, [CellId { x: -1, z: 0 }, CellId { x: 0, z: 0 }]);
    assert_eq!(packs.cells().map(|cell| cell.cell).collect::<Vec<_>>(), listed, "every listed cell is read, ascending");
    let first = packs.cell(CellId { x: -1, z: 0 }).expect("a listed cell");
    assert!(!first.things.is_empty(), "the fixture's first cell holds things");
    assert!(packs.cell(CellId { x: 1, z: 1 }).is_none(), "an unlisted cell is empty: no pack");
    assert_eq!(fnv1a64(b""), FNV_OFFSET_BASIS);
    assert_eq!(game_digest(&packs), PACK_DIGEST, "the pack digest is pinned and equal on every target");
}

#[test]
fn the_table_refuses_a_climbing_folder_and_a_missing_pack() {
    let climbing = CellPacks::from_table(*TABLE, "../valley").expect_err("a climbing folder");
    assert_eq!(climbing.refusal, PackRefusal::Asset(AssetErrorCode::UnsafePath));
    let missing = CellPacks::from_table(*TABLE, "elsewhere").expect_err("no such pack");
    assert_eq!((missing.refusal, missing.path.as_str()), (PackRefusal::Asset(AssetErrorCode::Missing), "elsewhere/world.json"));
    assert_eq!(climbing.refusal.wire(), "unsafe-path");
    assert_eq!(PackRefusal::Pack(StreamViewCode::PackDigest).wire(), "stream-pack-digest");
}

/// The asset folder's reads (native destinations): the same pack as the table, and the hostile table.
#[cfg(not(target_arch = "wasm32"))]
mod folder {
    use super::*;
    use genex::AssetFiles;
    use std::path::{Path, PathBuf};

    #[test]
    fn the_table_and_the_asset_folder_read_the_same_pack() {
        let dir = Folder::new("same");
        dir.write_fixture(FOLDER);
        let from_files = CellPacks::read(&AssetFiles::new(&[], Some(dir.path().to_path_buf())), FOLDER).expect("the folder's pack reads");
        let from_table = CellPacks::from_table(*TABLE, FOLDER).expect("the table's pack reads");
        assert_eq!(from_files, from_table);
        assert_eq!(game_digest(&from_files), game_digest(&from_table));
    }

    /// One hostile row: how the folder is spoiled, the folder name read, and the refusal expected.
    struct Hostile {
        name: &'static str,
        folder: &'static str,
        spoil: fn(&Path),
        refusal: PackRefusal,
        path: &'static str,
    }

    fn no_spoil(_: &Path) {}

    /// `valley/` is a link to a real pack folder outside the asset folder.
    fn link_folder(assets: &Path) {
        let outside = assets.parent().expect("parent").join("outside-pack");
        write_pack(&outside);
        std::fs::remove_dir_all(assets.join(FOLDER)).expect("remove the real folder");
        symlink(&outside, &assets.join(FOLDER));
    }

    /// One cell body is a link to a copy of itself outside the asset folder.
    fn link_cell(assets: &Path) {
        let body = assets.join(FOLDER).join("cells/0_0.cell");
        let outside = assets.parent().expect("parent").join("outside-0_0.cell");
        std::fs::copy(&body, &outside).expect("copy the body out");
        std::fs::remove_file(&body).expect("remove the body");
        symlink(&outside, &body);
    }

    /// A cell body cut short (the compile was interrupted).
    fn truncate_cell(assets: &Path) {
        let body = assets.join(FOLDER).join("cells/-1_0.cell");
        let bytes = std::fs::read(&body).expect("body");
        std::fs::write(&body, &bytes[..bytes.len() / 2]).expect("truncate");
    }

    /// `world.json` names a version this reader does not take.
    fn wrong_version(assets: &Path) {
        let world = assets.join(FOLDER).join("world.json");
        let text = std::fs::read_to_string(&world).expect("world");
        std::fs::write(&world, text.replace("\"version\":1", "\"version\":2")).expect("rewrite");
    }

    /// A cell body whose bytes are the right length but not the listed digest.
    fn flip_byte(assets: &Path) {
        let body = assets.join(FOLDER).join("cells/-1_0.cell");
        let mut bytes = std::fs::read(&body).expect("body");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&body, bytes).expect("flip");
    }

    /// A listed cell body that is not there.
    fn remove_cell(assets: &Path) {
        std::fs::remove_file(assets.join(FOLDER).join("cells/0_0.cell")).expect("remove");
    }

    #[cfg(unix)]
    fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    #[cfg(windows)]
    fn symlink(target: &Path, link: &Path) {
        if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link).expect("symlink");
        } else {
            std::os::windows::fs::symlink_file(target, link).expect("symlink");
        }
    }

    const HOSTILE: [Hostile; 9] = [
        Hostile { name: "a link folder", folder: FOLDER, spoil: link_folder, refusal: PackRefusal::Asset(AssetErrorCode::UnsafePath), path: "valley/world.json" },
        Hostile { name: "a link cell body", folder: FOLDER, spoil: link_cell, refusal: PackRefusal::Asset(AssetErrorCode::UnsafePath), path: "valley/cells/0_0.cell" },
        Hostile { name: "a climbing folder", folder: "../valley", spoil: no_spoil, refusal: PackRefusal::Asset(AssetErrorCode::UnsafePath), path: "../valley" },
        Hostile { name: "a climbing inner folder", folder: "valley/../valley", spoil: no_spoil, refusal: PackRefusal::Asset(AssetErrorCode::UnsafePath), path: "valley/../valley" },
        Hostile { name: "an absolute folder", folder: "/valley", spoil: no_spoil, refusal: PackRefusal::Asset(AssetErrorCode::UnsafePath), path: "/valley" },
        Hostile { name: "a truncated cell body", folder: FOLDER, spoil: truncate_cell, refusal: PackRefusal::Pack(StreamViewCode::PackInvalid), path: "valley/cells/-1_0.cell" },
        Hostile { name: "a wrong version", folder: FOLDER, spoil: wrong_version, refusal: PackRefusal::Pack(StreamViewCode::PackInvalid), path: "valley/world.json" },
        Hostile { name: "a body of another digest", folder: FOLDER, spoil: flip_byte, refusal: PackRefusal::Pack(StreamViewCode::PackDigest), path: "valley/cells/-1_0.cell" },
        Hostile { name: "a missing cell body", folder: FOLDER, spoil: remove_cell, refusal: PackRefusal::Asset(AssetErrorCode::Missing), path: "valley/cells/0_0.cell" },
    ];

    #[test]
    fn a_hostile_pack_folder_is_refused_and_nothing_past_the_refusal_is_read() {
        for row in &HOSTILE {
            let dir = Folder::new(row.name);
            dir.write_fixture(FOLDER);
            (row.spoil)(dir.path());
            let before = snapshot(dir.root());
            let refused = CellPacks::read(&AssetFiles::new(&[], Some(dir.path().to_path_buf())), row.folder).expect_err(row.name);
            assert_eq!(refused.refusal, row.refusal, "{}: {refused}", row.name);
            assert_eq!(refused.path, row.path, "{}: the refusal names the file", row.name);
            assert_eq!(snapshot(dir.root()), before, "{}: no side effect on the folder or outside it", row.name);
        }
    }

    /// A temporary asset folder beside room for things outside it, removed when dropped.
    struct Folder {
        root: PathBuf,
        assets: PathBuf,
    }

    impl Folder {
        fn new(name: &str) -> Folder {
            let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
            let root = std::env::temp_dir().join(format!("genex-stream-pack-{slug}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            let assets = root.join("assets");
            std::fs::create_dir_all(&assets).expect("assets");
            Folder { root, assets }
        }

        fn path(&self) -> &Path {
            &self.assets
        }

        fn root(&self) -> &Path {
            &self.root
        }

        fn write_fixture(&self, folder: &str) {
            write_pack(&self.assets.join(folder));
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn write_pack(folder: &Path) {
        for (file, bytes) in fixture_files() {
            let path = folder.join(file);
            std::fs::create_dir_all(path.parent().expect("parent")).expect("folder");
            std::fs::write(path, bytes).expect("write");
        }
    }

    /// Every entry under `root` (links not followed) with its kind and length, sorted.
    fn snapshot(root: &Path) -> Vec<(PathBuf, bool, u64)> {
        let mut seen = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("read_dir") {
                let path = entry.expect("entry").path();
                let meta = std::fs::symlink_metadata(&path).expect("meta");
                if meta.is_dir() {
                    stack.push(path.clone());
                }
                seen.push((path, meta.file_type().is_symlink(), meta.len()));
            }
        }
        seen.sort();
        seen
    }
}
