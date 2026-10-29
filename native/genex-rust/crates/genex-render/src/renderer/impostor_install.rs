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
use crate::impostor::bake::{BakeMaterials, BakeMesh, BakePart, BakedAtlas};
use crate::impostor::{GpuImpostor, ImpostorBounds, ImpostorClass, ImpostorLayout};
use crate::layout::{GpuMaterial, GpuMaterialExt};
use crate::mesh::{LOD_IMPOSTOR_MESH_LEVELS, impostor_level_error};
use crate::scene::{Material, MeshId, MeshImpostor};

/// One impostor to install: the model's parts with the materials they draw with, its layout, the
/// radius of the sphere its levels are measured from (the model's, a compound's around all its
/// members) and the least error, in object space, its level may switch at (0 from the facade: the
/// level switches where its error allows).
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
        let bake_materials = BakeMaterials { materials: &materials, material_ext: &material_ext, arrays: self.textures.slot_pairs(), sampler: &self.texture_sampler };
        let mesh = BakeMesh { vertices: &self.meshes.vertices, indices: &self.meshes.indices, parts: &parts };
        let Some(row) = self.impostors.bake(&gpu.device, &gpu.queue, install.class, &mesh, &bake_materials, &bounds, install.layout)? else { return Ok(None) };
        let meshes: Vec<MeshId> = entries.iter().map(|(mesh, _, _)| *mesh).collect();
        self.end_chains(install, &meshes, row)?;
        Ok(Some(row))
    }

    /// Install `atlas`, baked at build time (game systems LOD-23), as the next species for
    /// `install`'s parts and end their chains with its level, with no GPU bake. None, and no level
    /// set, when the atlas is not for `install`'s class and layout, past the reserved species, or
    /// when no part is in the library.
    pub fn install_baked_impostor(&mut self, gpu: &Gpu, install: &ImpostorInstall<'_>, atlas: &BakedAtlas) -> Result<Option<GpuImpostor>, RenderError> {
        if atlas.class != install.class || atlas.layout != install.layout {
            return Ok(None);
        }
        let meshes: Vec<MeshId> = install.parts.iter().map(|(mesh, _)| *mesh).filter(|mesh| self.library.entry(*mesh).is_some()).collect();
        let Some(bounds) = ImpostorBounds::of_spheres(meshes.iter().filter_map(|mesh| self.library.entry(*mesh)).map(|entry| (entry.center, entry.radius))) else { return Ok(None) };
        let Some(row) = self.impostors.install_baked(&gpu.device, &gpu.queue, atlas, &bounds) else { return Ok(None) };
        self.end_chains(install, &meshes, row)?;
        Ok(Some(row))
    }

    /// The species in layer `layer` read back as a build-time atlas carrying `digest` (LOD-23);
    /// None when no species is baked there.
    pub fn read_impostor_species(&self, gpu: &Gpu, layer: u32, digest: u64) -> Result<Option<BakedAtlas>, RenderError> {
        self.impostors.read_species(gpu, layer, digest)
    }

    /// End each of `meshes`' chains with species `row`'s level: the first draws the card.
    fn end_chains(&mut self, install: &ImpostorInstall<'_>, meshes: &[MeshId], row: GpuImpostor) -> Result<(), RenderError> {
        let error = self.impostor_error(install, row.frame_px);
        for (at, mesh) in meshes.iter().enumerate() {
            let level = if at == 0 { MeshImpostor::lead(row.layer, error) } else { MeshImpostor::part(error) };
            self.library.set_impostor(*mesh, Some(level))?;
        }
        Ok(())
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
