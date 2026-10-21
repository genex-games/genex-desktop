//! The KTX2 range reader (STR-18): a prefix holding the header and the level index gives the exact
//! byte range of the smallest k levels (KTX2 stores mip data smallest first, so the range read is
//! tail first), and levels assembled from fetched ranges are bit-equal to `read_ktx2` on the whole
//! file. A hostile level index is refused `texture-invalid` before any level is cut, never a panic.
//!
//! New behaviour (section 0 of the game systems plan): the whole-file reader is unchanged.

use genex_render::RenderCode;
use genex_render::texture::{KTX2_PREFIX_BYTES, Ktx2Index, read_ktx2};

/// The import step's family files (64 texels, 7 levels, smallest stored first).
const FAMILY_FILES: [&str; 4] = ["basis-uastc-64.bc.ktx2", "basis-uastc-64.astc.ktx2", "basis-uastc-64.etc2.ktx2", "basis-uastc-64.rgba8.ktx2"];
const HEADER_BYTES: usize = 80;
const LEVEL_ENTRY_BYTES: usize = 24;

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 bytes"))
}

fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().expect("8 bytes"))
}

/// Each level's (offset, length) as the file's level index lists them, level 0 first.
fn level_index(bytes: &[u8]) -> Vec<(u64, u64)> {
    let count = u32_at(bytes, 40) as usize;
    (0..count).map(|level| (u64_at(bytes, HEADER_BYTES + LEVEL_ENTRY_BYTES * level), u64_at(bytes, HEADER_BYTES + LEVEL_ENTRY_BYTES * level + 8))).collect()
}

/// The bytes the header says the level index ends at.
fn index_end(bytes: &[u8]) -> usize {
    HEADER_BYTES + LEVEL_ENTRY_BYTES * u32_at(bytes, 40) as usize
}

fn set_u64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

#[test]
fn a_prefix_with_only_the_level_index_gives_the_exact_ranges_of_the_smallest_levels() {
    for name in FAMILY_FILES {
        let file = fixture(name);
        let prefix = &file[..index_end(&file)];
        assert_eq!(Ktx2Index::prefix_len(&file[..HEADER_BYTES]).expect("the header names its index"), prefix.len(), "{name}");
        let index = Ktx2Index::parse(prefix, file.len() as u64).expect("the prefix parses");
        let levels = level_index(&file);
        let count = levels.len() as u32;
        assert_eq!(index.level_count(), count);
        assert_eq!(index.side(), 64);
        for k in 1..=count {
            let smallest = &levels[(count - k) as usize..];
            let start = smallest.iter().map(|(offset, _)| *offset).min().expect("a level");
            let end = smallest.iter().map(|(offset, length)| offset + length).max().expect("a level");
            assert_eq!(index.smallest(k).expect("a range"), start..end, "{name} k={k}");
        }
        // Smallest first: each larger chain extends the range only at its end (tail-first reads).
        let ranges: Vec<_> = (1..=count).map(|k| index.smallest(k).expect("a range")).collect();
        assert!(ranges.windows(2).all(|pair| pair[0].start == pair[1].start && pair[0].end < pair[1].end), "{name} {ranges:?}");
        assert_eq!(ranges.last().expect("a range").end, file.len() as u64, "{name}: level 0 ends the file");
        assert_eq!(index.chain(16).expect("a 16 texel level"), index.smallest(5).expect("five levels"));
        assert!(index.chain(48).is_none());
        assert!(KTX2_PREFIX_BYTES >= prefix.len());
    }
}

#[test]
fn levels_assembled_from_ranges_are_bit_equal_to_the_whole_file_reader() {
    for name in FAMILY_FILES {
        let file = fixture(name);
        let whole = read_ktx2(&file).expect("the whole file reads");
        let index = Ktx2Index::parse(&file[..KTX2_PREFIX_BYTES.min(file.len())], file.len() as u64).expect("parses");
        let count = index.level_count();
        for k in 1..=count {
            let range = index.smallest(k).expect("a range");
            let chunk = &file[range.start as usize..range.end as usize];
            let part = index.assemble(k, &[(range.start, chunk)]).expect("assembled");
            assert_eq!(part.levels(), &whole.levels()[(count - k) as usize..], "{name} k={k}");
            assert_eq!(part.side(), whole.side() >> (count - k));
            assert_eq!((part.family(), part.is_srgb()), (whole.family(), whole.is_srgb()));
        }
        // Tail first: the small levels' range, then the rest, as two fetches.
        let small = index.smallest(3).expect("three levels");
        let all = index.smallest(count).expect("every level");
        let chunks = [(small.start, &file[small.start as usize..small.end as usize]), (small.end, &file[small.end as usize..all.end as usize])];
        assert_eq!(index.assemble(count, &chunks).expect("from two ranges"), whole, "{name}");
    }
}

#[test]
fn hostile_level_indexes_and_ranges_are_refused_with_a_typed_code() {
    let file = fixture("basis-uastc-64.bc.ktx2");
    let levels = level_index(&file);
    let len = file.len() as u64;
    let entry = |level: usize| HEADER_BYTES + LEVEL_ENTRY_BYTES * level;
    let mut cases: Vec<(&str, Vec<u8>, u64)> = Vec::new();
    let mut overlap = file.clone();
    set_u64(&mut overlap, entry(1), levels[0].0 + 16);
    cases.push(("level 1 overlaps level 0", overlap, len));
    let mut past = file.clone();
    set_u64(&mut past, entry(0), len - 8);
    cases.push(("level 0 runs past the end", past, len));
    let mut huge = file.clone();
    set_u64(&mut huge, entry(2), u64::MAX - 4);
    cases.push(("an offset that overflows", huge, len));
    let mut larger = file.clone();
    set_u64(&mut larger, entry(3) + 8, levels[2].1 * 2);
    set_u64(&mut larger, entry(3) + 16, levels[2].1 * 2);
    cases.push(("a level larger than its parent", larger, len));
    let mut inside = file.clone();
    set_u64(&mut inside, entry(6), 8);
    cases.push(("a level inside the header", inside, len));
    let mut supercompressed = file.clone();
    set_u64(&mut supercompressed, entry(4) + 16, levels[4].1 + 1);
    cases.push(("an uncompressed length that differs", supercompressed, len));
    let mut fewer = file.clone();
    fewer[40..44].copy_from_slice(&3u32.to_le_bytes());
    cases.push(("fewer levels than the chain", fewer, len));
    let mut magic = file.clone();
    magic[1] ^= 0xFF;
    cases.push(("not a KTX2 file", magic, len));
    cases.push(("a file shorter than its index says", file.clone(), levels[0].0));
    for (name, bytes, file_len) in &cases {
        let prefix = &bytes[..index_end(&file).min(bytes.len())];
        let refused = Ktx2Index::parse(prefix, *file_len).map(|_| ()).expect_err(name);
        assert_eq!(refused.code(), RenderCode::TextureInvalid, "{name}: {refused}");
    }
    assert_eq!(Ktx2Index::parse(&file[..HEADER_BYTES + 10], len).map(|_| ()).expect_err("short").code(), RenderCode::TextureInvalid);
    assert!(Ktx2Index::prefix_len(&file[..40]).is_err());

    let index = Ktx2Index::parse(&file[..index_end(&file)], len).expect("parses");
    assert!(index.smallest(0).is_err() && index.smallest(8).is_err(), "k outside 1..=levels");
    let range = index.smallest(4).expect("a range");
    let chunk = &file[range.start as usize..range.end as usize];
    let short = &chunk[..chunk.len() - 1];
    for (name, chunks) in [
        ("a chunk one byte short", vec![(range.start, short)]),
        ("a chunk at the wrong offset", vec![(range.start + 1, chunk)]),
        ("no chunk", vec![]),
    ] {
        let refused = index.assemble(4, &chunks).map(|_| ()).expect_err(name);
        assert_eq!(refused.code(), RenderCode::TextureInvalid, "{name}");
    }
}
