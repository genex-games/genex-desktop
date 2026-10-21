//! The presenter's impostors (game systems LOD-16): a model drawn with `Model::with_impostor`
//! becomes a bake job once its parts are loaded; a job bakes its parts on the GPU with the
//! materials the model draws with and ends their chains with the impostor level
//! (`Renderer::install_impostor`).
//!
//! - **Live bakes lazily**: at most [`LIVE_BAKES_PER_FRAME`] a frame, so the first lit frame is not
//!   held back by bakes; until a model's bake lands its last mesh level draws to the horizon (the
//!   coarsest-mesh fallback).
//! - **A capture waits for bakes**: it bakes every pending job before it draws, so two captures of
//!   one frame are the same picture whatever Live baked before.
//! - **A new renderer bakes again**: a renderer that holds fewer species than were installed (a
//!   device loss, a rebuild, a warmed renderer swapped in) or another atlas class has every job
//!   pending again, so the next frame matches the one before the loss once it baked.
//! - A quality with impostors off takes every installed level off (the last mesh level stays).
//! - A model whose parts have no triangles to bake (a GLB that does not load counts) is refused
//!   `impostor-invalid` and draws whole.
//!
//! The arrays are reserved for the jobs known (never the class cap), so memory follows the game;
//! a new job reserves again and bakes every job again. Host glue, never simulation: update hooks
//! see none of this.

use std::time::Duration;

use genex_render::impostor::{GpuImpostor, ImpostorClass};
use genex_render::renderer::ImpostorInstall;
use genex_render::scene::{Material, MeshId};
use genex_render::timing::Clock;
use genex_render::{Gpu, RenderError, Renderer};

use super::{AssetCache, rgba, surface};
use crate::frame::{Color, Frame};
use crate::lod::{ImpostorLayout, LodRefusalCode};

/// Bakes a Live frame takes at most (the rest wait for later frames).
pub const LIVE_BAKES_PER_FRAME: usize = 1;

/// One model's impostor: its cache key, its path (as `volatile.render.lod` names it), its parts
/// with their materials, its layout, its LOD sphere's radius and its floor, and what its bake did.
#[derive(Clone, Debug, PartialEq)]
struct Job {
    key: String,
    model: String,
    parts: Vec<(MeshId, Material)>,
    layout: ImpostorLayout,
    radius: f32,
    floor: f32,
    state: JobState,
}

/// Where a job stands.
#[derive(Clone, Copy, Debug, PartialEq)]
enum JobState {
    /// Not baked on the renderer in use.
    Pending,
    /// Baked: its row and how long the bake took to encode.
    Baked { row: GpuImpostor, bake_ms: f32 },
    /// Past the reserved species (the class cap): its last mesh level stays (`degraded` budget).
    OverCap,
}

/// One baked impostor as `state().volatile.render.lod.impostors` lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct ImpostorStat {
    /// The model's path.
    pub model: String,
    /// Its layout.
    pub layout: ImpostorLayout,
    /// Frames per side of its atlases.
    pub frames: u32,
    /// Texels per frame side.
    pub frame_px: u32,
    /// Its atlases' bytes (three, mips included).
    pub bytes: u64,
    /// How long its bake took to encode, in milliseconds.
    pub bake_ms: f32,
}

/// How far the impostor bakes are: done and known (the boot's `pipelines` stage counts them).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BakeTally {
    /// Jobs known.
    pub submitted: u32,
    /// Of them, baked (or past the cap, which never bakes).
    pub finished: u32,
}

/// The presenter's impostor jobs (module docs).
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Impostors {
    jobs: Vec<Job>,
    /// Models refused `impostor-invalid` at load, by cache key, with their paths.
    refused: Vec<(String, String)>,
    /// The class and species count the renderer's arrays were reserved for.
    reserved: Option<(ImpostorClass, u32)>,
    /// Bakes run since the presenter opened.
    bakes: u32,
}

impl Impostors {
    /// Add a job for every model `frame` draws with an impostor whose parts are loaded and that
    /// has none yet; a model with nothing to bake is refused `impostor-invalid`.
    pub(super) fn queue(&mut self, frame: &Frame, assets: &AssetCache) {
        for model in super::drawn_models(frame) {
            let Some(impostor) = model.impostor() else { continue };
            let Some(key) = model.key() else { continue };
            let known = self.jobs.iter().any(|job| job.key == key) || self.refused.iter().any(|(known, _)| known == key);
            let members = model.drawn_members();
            let tried = members.iter().all(|member| member.key().is_some_and(|key| assets.tried(key)));
            if known || !tried {
                continue;
            }
            let loaded: Vec<&super::LoadedModel> = members.iter().filter_map(|member| assets.model(member.key()?)).collect();
            let parts: Vec<(MeshId, Material)> = loaded.iter().flat_map(|loaded| loaded.parts.iter()).map(|part| (part.mesh, part_material(part, assets))).collect();
            let triangles: u32 = loaded.iter().map(|loaded| loaded.triangles).sum();
            let path = model.path().unwrap_or_default().to_owned();
            if parts.is_empty() || triangles == 0 {
                self.refused.push((key.to_owned(), path));
                continue;
            }
            let radius = loaded.iter().fold([0.0; 4], |sphere, loaded| super::union_sphere(sphere, loaded.sphere))[3];
            let floor = crate::lod::switch_error(impostor.not_before_m());
            self.jobs.push(Job { key: key.to_owned(), model: path, parts, layout: impostor.layout(), radius, floor, state: JobState::Pending });
        }
    }

    /// Bake up to `budget` pending jobs on `renderer` for `class` (module docs); with `enabled`
    /// off, take every installed level off instead. Answers the bakes run.
    pub(super) fn bake(&mut self, (gpu, renderer): (&Gpu, &mut Renderer), class: ImpostorClass, enabled: bool, (budget, clock): (usize, &Clock)) -> Result<u32, RenderError> {
        if !enabled {
            self.take_off(renderer);
            return Ok(0);
        }
        if self.jobs.is_empty() {
            return Ok(0);
        }
        let held = renderer.impostors().species().len();
        let installed = self.jobs.iter().filter(|job| matches!(job.state, JobState::Baked { .. })).count();
        let wanted = (class, self.jobs.len() as u32);
        let class_held = renderer.impostors().atlases().is_some_and(|atlases| atlases.spec == class.spec());
        // A renderer that lost its species (device loss, rebuild, swap), another class, or a new
        // job: reserve again and bake every job again.
        let stale = held < installed || (installed > 0 && !class_held) || self.reserved != Some(wanted);
        if stale {
            let meshes: Vec<MeshId> = self.jobs.iter().flat_map(|job| job.parts.iter().map(|(mesh, _)| *mesh)).collect();
            renderer.reset_impostors(gpu, class, wanted.1, &meshes);
            self.reserved = Some(wanted);
            for job in &mut self.jobs {
                job.state = JobState::Pending;
            }
        }
        let mut ran = 0;
        for job in self.jobs.iter_mut().filter(|job| job.state == JobState::Pending).take(budget) {
            let started = clock();
            let install = ImpostorInstall { parts: &job.parts, layout: job.layout.render(), class, radius: job.radius, floor: job.floor };
            job.state = match renderer.install_impostor(gpu, &install)? {
                Some(row) => JobState::Baked { row, bake_ms: millis(clock().saturating_sub(started)) },
                None => JobState::OverCap,
            };
            ran += 1;
        }
        self.bakes += ran;
        Ok(ran)
    }

    /// Take every installed level off (impostors off): each job bakes again when they are on.
    fn take_off(&mut self, renderer: &mut Renderer) {
        let installed: Vec<MeshId> = self.jobs.iter().filter(|job| job.state != JobState::Pending).flat_map(|job| job.parts.iter().map(|(mesh, _)| *mesh)).collect();
        if installed.is_empty() {
            return;
        }
        renderer.remove_impostor_levels(&installed);
        for job in &mut self.jobs {
            job.state = JobState::Pending;
        }
    }

    /// Forget every job over one of `meshes` (a reload freed them).
    pub(super) fn forget_meshes(&mut self, meshes: &[MeshId]) {
        self.jobs.retain(|job| !job.parts.iter().any(|(mesh, _)| meshes.contains(mesh)));
    }

    /// How far the bakes are.
    pub(super) fn tally(&self) -> BakeTally {
        let finished = self.jobs.iter().filter(|job| job.state != JobState::Pending).count() as u32;
        BakeTally { submitted: self.jobs.len() as u32, finished }
    }

    /// Bakes run since the presenter opened.
    pub(super) fn bakes(&self) -> u32 {
        self.bakes
    }

    /// The baked impostors, in job order.
    pub(super) fn stats(&self) -> Vec<ImpostorStat> {
        self.jobs
            .iter()
            .filter_map(|job| match job.state {
                JobState::Baked { row, bake_ms } => {
                    let spec = genex_render::impostor::ImpostorSpec { frames: row.frames, frame_px: row.frame_px, layout: job.layout.render(), depth_parallax: false, species_cap: 1 };
                    Some(ImpostorStat { model: job.model.clone(), layout: job.layout, frames: row.frames, frame_px: row.frame_px, bytes: spec.species_bytes(), bake_ms })
                }
                JobState::Pending | JobState::OverCap => None,
            })
            .collect()
    }

    /// Why the model under `key` draws whole, if its impostor was refused at load.
    pub(super) fn refusal(&self, key: &str) -> Option<LodRefusalCode> {
        self.refused.iter().any(|(known, _)| known == key).then_some(LodRefusalCode::ImpostorInvalid)
    }
}

/// The material a part bakes with: its GLB's own (untinted), else the default surface.
fn part_material(part: &super::ModelPart, assets: &AssetCache) -> Material {
    match &part.material {
        Some(glb) => glb.to_material(rgba(Color::WHITE)),
        None => surface(&crate::Material::color(Color::WHITE), Color::WHITE, assets),
    }
}

/// `elapsed` in milliseconds.
fn millis(elapsed: Duration) -> f32 {
    elapsed.as_secs_f32() * 1000.0
}
