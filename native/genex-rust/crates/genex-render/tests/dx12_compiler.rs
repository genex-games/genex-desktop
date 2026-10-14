//! D3D12 compiles shaders with FXC, chosen explicitly (plan "Toolchain and build store": never
//! `from_env`). wgpu's default is `Auto`, which loads a `dxcompiler.dll` found on PATH, so a decoy
//! DLL beside a Windows export would otherwise run inside the game (M4.1 adds the decoy row).

use genex_render::gpu::core_instance_descriptor;
use wgpu::Dx12Compiler;

#[test]
fn the_instance_compiles_d3d12_shaders_with_fxc() {
    let descriptor = core_instance_descriptor();
    let compiler = &descriptor.backend_options.dx12.shader_compiler;
    assert!(matches!(compiler, Dx12Compiler::Fxc), "D3D12 shader compiler is {compiler:?}, not Fxc");
}
