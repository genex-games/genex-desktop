//! GPU bounds: ProcessSandbox does not bound GPU work, so the renderer refuses oversize WGSL,
//! buffers, textures, per-frame uploads and captures with typed codes before touching the GPU.

use genex_render::caps::{
    MAX_WORLD_PX, NATIVE_MAX_WORLD_PX, NATIVE_TEXTURE_MAX_BYTES, UploadBudget, WEB_MAX_WORLD_PX, WEB_TEXTURE_MAX_BYTES, check_buffer,
    check_texture, check_wgsl, world_size,
};
use genex_render::{
    BUFFER_MAX_BYTES, CAPTURE_MAX_BYTES, RenderCode, TEXTURE_MAX_BYTES, UPLOAD_MAX_BYTES_PER_FRAME, WGSL_MAX_BYTES,
};

#[test]
fn the_caps_fit_inside_webgpu_default_limits() {
    let core = wgpu::Limits::defaults();
    assert!(BUFFER_MAX_BYTES <= core.max_storage_buffer_binding_size);
    assert!(BUFFER_MAX_BYTES <= core.max_buffer_size);
    // WP-9 flipped 4096 -> 8192 on native: the caps split by destination, the web keeps its own.
    assert_eq!(WEB_MAX_WORLD_PX, 4096);
    assert_eq!(WEB_TEXTURE_MAX_BYTES, 4096 * 4096 * 4);
    assert_eq!(NATIVE_MAX_WORLD_PX, 8192);
    assert_eq!(NATIVE_TEXTURE_MAX_BYTES, 8192 * 8192 * 4);
    assert!(NATIVE_MAX_WORLD_PX <= core.max_texture_dimension_2d, "an 8K target fits WebGPU's default texture side");
    assert_eq!(MAX_WORLD_PX, NATIVE_MAX_WORLD_PX, "these tests run natively");
    assert_eq!(TEXTURE_MAX_BYTES, NATIVE_TEXTURE_MAX_BYTES);
    assert_eq!(CAPTURE_MAX_BYTES, 8192 * 8192 * 4, "NATIVE_CAPTURE_MAX_BYTES of the host contract");
    const { assert!(UPLOAD_MAX_BYTES_PER_FRAME <= BUFFER_MAX_BYTES) };
    const { assert!(WGSL_MAX_BYTES >= 64 * 1024) };
}

#[test]
fn oversize_inputs_are_refused_with_typed_codes() {
    let wgsl = "a".repeat(WGSL_MAX_BYTES + 1);
    let rows: [(RenderCode, &str, Result<(), genex_render::RenderError>); 5] = [
        (RenderCode::WgslTooLarge, "wgsl-too-large", check_wgsl(&wgsl)),
        (RenderCode::BufferTooLarge, "buffer-too-large", check_buffer(BUFFER_MAX_BYTES + 1)),
        (RenderCode::BufferTooLarge, "buffer-too-large", check_buffer(0)),
        (RenderCode::TextureTooLarge, "texture-too-large", check_texture(8193, 8192, 4)),
        (RenderCode::TextureTooLarge, "texture-too-large", check_texture(u32::MAX, u32::MAX, 16)),
    ];
    for (code, wire, result) in rows {
        let error = result.expect_err(wire);
        assert_eq!(error.code(), code);
        assert_eq!(error.code().wire(), wire);
    }
    assert_eq!(check_wgsl(&"a".repeat(WGSL_MAX_BYTES)), Ok(()));
    assert_eq!(check_buffer(BUFFER_MAX_BYTES), Ok(()));
    assert_eq!(check_texture(8192, 8192, 4), Ok(()), "an 8K texture on native");
}

#[test]
fn the_upload_budget_refuses_the_charge_that_crosses_it_and_keeps_the_previous_total() {
    let mut budget = UploadBudget::new();
    budget.charge(UPLOAD_MAX_BYTES_PER_FRAME - 10).expect("under the cap");
    let error = budget.charge(11).expect_err("over the cap");
    assert_eq!(error.code(), RenderCode::UploadBudget);
    assert_eq!(error.code().wire(), "upload-budget");
    assert_eq!(budget.used(), UPLOAD_MAX_BYTES_PER_FRAME - 10, "a refused charge is not counted");
    budget.charge(10).expect("exactly at the cap");
    assert_eq!(budget.charge(u64::MAX).expect_err("overflow").code(), RenderCode::UploadBudget);
}

#[test]
fn the_world_size_is_clamped_like_the_cpp_runtime() {
    assert_eq!(world_size(960, 540), (960, 540));
    assert_eq!(world_size(0, 10), (64, 64));
    assert_eq!(world_size(100_000, 5000), (8192, 5000), "native targets reach 8K (WP-9 flipped 4096)");
}
