//! AN-24: vertex-animation-texture crowds, the CPU rows. A bake's frames encode into the two
//! rgba16f textures' layout and decode within the half-float tolerance; the layout wraps rows at
//! 2048 texels; hostile frames are refused `mesh-invalid`; a crowd of 1,000 holds no skinned
//! output. The GPU rows (`metal_*`, against the compute-skinned golden) are in `src/vat.rs`.
//! (New behaviour: the module was a stub.)

use genex_render::RenderCode;
use genex_render::vat::{VAT_INSTANCE_BYTES, VAT_ROW_TEXELS, VAT_ROWS_MAX, VatImage, crowd_memory};

/// Frame-major rows, as `VatImage::encode` takes them.
type Rows<'a> = &'a [[f32; 3]];

/// `frames` frames of a ring of `vertices` vertices far from the origin, turning a little each
/// frame.
fn ring(vertices: u32, frames: u32) -> (Vec<[f32; 3]>, Vec<[f32; 3]>) {
    let mut out = (Vec::new(), Vec::new());
    for f in 0..frames {
        for v in 0..vertices {
            let angle = v as f32 / vertices as f32 * std::f32::consts::TAU + 0.05 * f as f32;
            let (sin, cos) = (libm::sinf(angle), libm::cosf(angle));
            out.0.push([120.0 + 0.8 * cos, 1.0 + 0.1 * f as f32, -60.0 + 0.8 * sin]);
            out.1.push([cos, 0.0, sin]);
        }
    }
    out
}

#[test]
fn frames_decode_within_the_half_float_tolerance() {
    let (positions, normals) = ring(64, 12);
    let image = VatImage::encode(64, &positions, &normals).expect("encodes");
    assert_eq!((image.vertex_count(), image.frames()), (64, 12));
    let tolerance = image.tolerance();
    assert!(tolerance < 2e-3, "relative to the origin, a 120 m crowd keeps millimetres: {tolerance}");
    for f in 0..12 {
        for v in 0..64 {
            let want = positions[(f * 64 + v) as usize];
            let got = image.decode_position(f, v);
            for axis in 0..3 {
                assert!((got[axis] - want[axis]).abs() <= tolerance, "frame {f} vertex {v}: {got:?} vs {want:?}");
            }
            let n = image.decode_normal(f, v);
            let wanted = normals[(f * 64 + v) as usize];
            assert!((0..3).all(|axis| (n[axis] - wanted[axis]).abs() <= 1e-3), "{n:?} vs {wanted:?}");
        }
    }
}

#[test]
fn the_layout_is_frame_major_and_wraps_rows_at_2048_texels() {
    let (positions, normals) = ring(1000, 5);
    let image = VatImage::encode(1000, &positions, &normals).expect("encodes");
    assert_eq!(image.size(), (VAT_ROW_TEXELS, 3), "5,000 texels in rows of 2,048");
    assert_eq!(image.texel(0, 0), (0, 0));
    assert_eq!(image.texel(2, 47), (2047, 0), "texel 2,047 ends the first row");
    assert_eq!(image.texel(2, 48), (0, 1));
    assert_eq!(image.texel(4, 999), (4999 - 2 * 2048, 2));
    assert_eq!(image.position_texels().len(), 5000);
    let small = VatImage::encode(10, &positions[..30], &normals[..30]).expect("encodes");
    assert_eq!(small.size(), (30, 1), "a bake under one row is as wide as its texels");
    assert_eq!(image.texture_bytes(), 2 * 8 * 2048 * 3);
}

#[test]
fn hostile_frames_are_refused_mesh_invalid() {
    let (positions, normals) = ring(8, 2);
    let mut nan = positions.clone();
    nan[3][1] = f32::NAN;
    let mut infinite = normals.clone();
    infinite[0][0] = f32::INFINITY;
    let too_many = vec![[0.0; 3]; (VAT_ROW_TEXELS * VAT_ROWS_MAX) as usize + 8];
    let rows: [(&str, u32, Rows<'_>, Rows<'_>); 7] = [
        ("no vertex per frame", 0, &positions, &normals),
        ("no frame", 8, &[], &[]),
        ("not a whole frame", 5, &positions, &normals),
        ("short normals", 8, &positions, &normals[..8]),
        ("a NaN position", 8, &nan, &normals),
        ("an infinite normal", 8, &positions, &infinite),
        ("past the texel cap", 8, &too_many, &too_many),
    ];
    for (name, count, p, n) in rows {
        let error = VatImage::encode(count, p, n).expect_err(name);
        assert_eq!(error.code(), RenderCode::MeshInvalid, "{name}");
    }
}

/// AN-24 red row: 1,000 crowd instances hold 0 skinned-output bytes, where compute skinning the
/// same crowd would hold two outputs of every instance's vertices; the VAT crowd is its shared
/// textures and one instance row each.
#[test]
fn a_crowd_of_1000_holds_no_skinned_output() {
    let (positions, normals) = ring(1200, 31);
    let image = VatImage::encode(1200, &positions, &normals).expect("encodes");
    let memory = crowd_memory(&image, 1000);
    assert_eq!(memory.skinned_output, 0);
    assert_eq!(memory.instances, 1000 * VAT_INSTANCE_BYTES);
    assert_eq!(memory.textures, image.texture_bytes());
    assert_eq!(memory.compute_skinned_output, 1000 * 1200 * 48 * 2);
    assert!(memory.textures + memory.instances < memory.compute_skinned_output / 100, "{memory:?}");
}
