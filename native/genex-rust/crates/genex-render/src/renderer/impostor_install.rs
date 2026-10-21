//! A model's impostor installed from its library parts (game systems LOD-16): its parts baked as
//! one species with the materials the model draws with (not the last frame's material table, so
//! a bake never depends on what a frame drew before it), then every part's chain ended by its
//! impostor level ([`MeshLibrary::set_impostor`]): the lead part draws the species' card, the
//! others stop drawing there. The facade's presenter calls it from its bake jobs, again after a
//! device loss or a renderer rebuild (a new renderer holds no species).
//!
//! [`MeshLibrary::set_impostor`]: crate::scene::MeshLibrary::set_impostor

use wgpu::BufferUsages;

use super::Renderer;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::impostor::bake::{BakeMaterials, BakeMesh, BakePart};
use crate::impostor::{GpuImpostor, ImpostorBounds, ImpostorClass, ImpostorLayout};
use crate::layout::{GpuMaterial, GpuMaterialExt};
use crate::mesh::{LOD_IMPOSTOR_MESH_LEVELS, impostor_level_error};
use crate::scene::{Material, MeshId, MeshImpostor};
use crate::settings::TextureClass;
use crate::texture::TextureKind;

/// One impostor to install: the model's parts with the materials they draw with, its layout, the
/// radius of the sphere its levels are measured from (the model's, a compound's around all its
/// members) and the least error, in object space, its level may switch at (the game's
/// `not_before`, converted).
#[derive(Clone, Debug)]
pub struct ImpostorInstall<'a> {
    /// The parts, the lead (whose card draws) first.
    pub parts: &'a [(MeshId, Material)],
    /// Its layout.
    pub layout: ImpostorLayout,
    /// The class's atlas row.
    pub class: ImpostorClass,
    /// The radius of the LOD sphere every part measures from.
    pub radius: f32,
    /// The least object-space error of the impostor level.
    pub floor: f32,
}

impl Renderer {
    /// Make `class`'s impostor arrays for `species` species, dropping every species baked before,
    /// and take the impostor level off each of `installed` (they are installed again, game
    /// systems LOD-16).
    pub fn reset_impostors(&mut self, gpu: &Gpu, class: ImpostorClass, species: u32, installed: &[MeshId]) {
        self.impostors.reserve(&gpu.device, class, species);
        self.remove_impostor_levels(installed);
    }

    /// Take the impostor level off each of `meshes` (their last mesh level draws to the horizon);
    /// a mesh the library no longer holds is skipped.
    pub fn remove_impostor_levels(&mut self, meshes: &[MeshId]) {
        for mesh in meshes {
            // A freed mesh has no level to take off.
            let _ = self.library.set_impostor(*mesh, None);
        }
    }

    /// Bake `install`'s parts as the next species and end their chains with its level (module
    /// docs). None, and no level set, past the reserved species (the model keeps its last mesh
    /// level) or when no part is in the library.
    pub fn install_impostor(&mut self, gpu: &Gpu, install: &ImpostorInstall<'_>) -> Result<Option<GpuImpostor>, RenderError> {
        let entries: Vec<(MeshId, &crate::scene::MeshEntry, u32)> =
            install.parts.iter().enumerate().filter_map(|(row, (mesh, _))| Some((*mesh, self.library.entry(*mesh)?, row as u32))).collect();
        let Some(bounds) = ImpostorBounds::of_spheres(entries.iter().map(|(_, entry, _)| (entry.center, entry.radius))) else { return Ok(None) };
        let parts: Vec<BakePart> =
            entries.iter().map(|(_, entry, row)| BakePart { first_index: entry.first_index, index_count: entry.index_count, base_vertex: entry.base_vertex, material: *row }).collect();
        let rows: Vec<GpuMaterial> = install.parts.iter().map(|(_, material)| material.to_gpu()).collect();
        let ext: Vec<GpuMaterialExt> = install.parts.iter().map(|(_, material)| material.to_gpu_ext()).collect();
        let materials = storage_rows(gpu, "impostor bake materials", bytemuck::cast_slice(&rows));
        let material_ext = storage_rows(gpu, "impostor bake material ext", bytemuck::cast_slice(&ext));
        let arrays = TextureClass::ALL.map(|class| [TextureKind::Color, TextureKind::Data].map(|kind| self.textures.view(class, kind)));
        let [[c256, d256], [c512, d512], [c1024, d1024], [c2048, d2048]] = arrays;
        let bake_materials = BakeMaterials { materials: &materials, material_ext: &material_ext, arrays: [c256, d256, c512, d512, c1024, d1024, c2048, d2048], sampler: &self.texture_sampler };
        let mesh = BakeMesh { vertices: &self.meshes.vertices, indices: &self.meshes.indices, parts: &parts };
        let Some(row) = self.impostors.bake(&gpu.device, &gpu.queue, install.class, &mesh, &bake_materials, &bounds, install.layout)? else { return Ok(None) };
        let error = self.impostor_error(install, row.frame_px);
        let meshes: Vec<MeshId> = entries.iter().map(|(mesh, _, _)| *mesh).collect();
        for (at, mesh) in meshes.iter().enumerate() {
            let level = if at == 0 { MeshImpostor::lead(row.layer, error) } else { MeshImpostor::part(error) };
            self.library.set_impostor(*mesh, Some(level))?;
        }
        Ok(Some(row))
    }

    /// The impostor level's error over the LOD sphere's radius: one atlas texel a pixel, never
    /// finer than any part's last kept mesh level, never before the game's floor.
    fn impostor_error(&self, install: &ImpostorInstall<'_>, frame_px: u32) -> f32 {
        let radius = install.radius.max(f32::MIN_POSITIVE);
        let last_mesh = install
            .parts
            .iter()
            .filter_map(|(mesh, _)| self.library.lods(*mesh))
            .filter_map(|lods| lods.errors.iter().take(LOD_IMPOSTOR_MESH_LEVELS).next_back().copied())
            .fold(0.0_f32, f32::max);
        impostor_level_error(frame_px, last_mesh / radius).max(install.floor / radius)
    }
}

/// A storage buffer holding `bytes` (at least one row's worth, so an empty table still binds).
fn storage_rows(gpu: &Gpu, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    let size = (bytes.len() as u64).max(16);
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size, usage: BufferUsages::STORAGE | BufferUsages::COPY_DST, mapped_at_creation: false });
    gpu.queue.write_buffer(&buffer, 0, bytes);
    buffer
}
