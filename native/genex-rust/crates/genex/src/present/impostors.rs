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
//! - **A build-time atlas comes first** (LOD-23): before a pending job bakes, the presenter reads
//!   `assets/baked/impostor/<name>` (`crate::lod::impostor_bake_name` of its key and class) and,
//!   when its digest is the job's (the model's files, the layout and the class row), uploads it
//!   with no GPU bake; it costs no bake budget and counts in [`Impostors::loads`], not bakes. A
//!   streamed model (drawn by the view set) never bakes mid-game: without an atlas it keeps its
//!   coarsest mesh and is refused `impostor-not-baked`.
//!
//! The arrays are reserved for the jobs known (never the class cap), so memory follows the game;
//! a new job reserves again and bakes every job again. Host glue, never simulation: update hooks
//! see none of this.

use std::time::Duration;

use genex_render::impostor::bake::{BakedAtlas, baked_atlas_digest};
use genex_render::impostor::{GpuImpostor, ImpostorClass};
use genex_render::renderer::ImpostorInstall;
use genex_render::scene::{Material, MeshId};
use genex_render::timing::Clock;
use genex_render::{Gpu, RenderError, Renderer};

use super::{AssetCache, ModelSource, rgba, surface};
use crate::frame::{Color, Frame};
use crate::lod::{BAKED_IMPOSTOR_FOLDER, ImpostorLayout, LodRefusalCode, impostor_bake_name};

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
    /// The FNV-1a 64 of the files it is drawn from (None when one did not read): a build-time
    /// atlas loads only when it was baked from the same (LOD-23).
    digest: Option<u64>,
    /// Drawn by the streamed view set: never baked mid-game (LOD-23).
    streamed: bool,
    state: JobState,
}

/// Where a job stands.
#[derive(Clone, Copy, Debug, PartialEq)]
enum JobState {
    /// Not baked on the renderer in use.
    Pending,
    /// Baked: its row, how long the bake took to encode and whether it was a build-time atlas.
    Baked { row: GpuImpostor, bake_ms: f32, prebaked: bool },
    /// Past the reserved species (the class cap): its last mesh level stays (`degraded` budget).
    OverCap,
    /// A streamed model with no build-time atlas: its last mesh level stays (`impostor-not-baked`).
    NotBaked,
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
    /// How long its bake took to encode, in milliseconds (0 for a build-time atlas).
    pub bake_ms: f32,
    /// Whether it was loaded from a build-time atlas instead of baked (LOD-23).
    pub prebaked: bool,
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
    /// Build-time atlases loaded since the presenter opened (LOD-23).
    loads: u32,
}

impl Impostors {
    /// Add a job for every model `frame` draws with an impostor whose parts are loaded and that
    /// has none yet; a model with nothing to bake is refused `impostor-invalid`.
    pub(super) fn queue(&mut self, frame: &Frame, assets: &AssetCache, source: &dyn ModelSource) {
        for (model, streamed) in drawn_models_streamed(frame) {
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
            let digest = model_digest(key, model, source);
            self.jobs.push(Job { key: key.to_owned(), model: path, parts, layout: impostor.layout(), radius, floor, digest, streamed, state: JobState::Pending });
        }
    }

    /// Bake up to `budget` pending jobs on `renderer` for `class` (module docs); with `enabled`
    /// off, take every installed level off instead. Answers the bakes run.
    pub(super) fn bake(&mut self, (gpu, renderer): (&Gpu, &mut Renderer), class: ImpostorClass, enabled: bool, (budget, clock, source): (usize, &Clock, &dyn ModelSource)) -> Result<u32, RenderError> {
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
        let mut ran = 0u32;
        for job in self.jobs.iter_mut().filter(|job| job.state == JobState::Pending) {
            let install = ImpostorInstall { parts: &job.parts, layout: job.layout.render(), class, radius: job.radius, floor: job.floor };
            // LOD-23: a build-time atlas of the same inputs loads without a bake or its budget.
            if let Some(atlas) = prebaked(job, class, source)
                && let Some(row) = renderer.install_baked_impostor(gpu, &install, &atlas)?
            {
                job.state = JobState::Baked { row, bake_ms: 0.0, prebaked: true };
                self.loads += 1;
                continue;
            }
            if job.streamed {
                job.state = JobState::NotBaked;
                continue;
            }
            if ran as usize >= budget {
                continue;
            }
            let started = clock();
            job.state = match renderer.install_impostor(gpu, &install)? {
                Some(row) => JobState::Baked { row, bake_ms: millis(clock().saturating_sub(started)), prebaked: false },
                None => JobState::OverCap,
            };
            ran += 1;
        }
        self.bakes += ran;
        Ok(ran)
    }

    /// Bake the job of `key` alone at `class` and read it back as a build-time atlas (LOD-23, the
    /// dev build's `bakeAssets` kind `impostor`): the renderer's arrays are reserved for it, so
    /// every job bakes (or loads) again at the next frame. None when no job has that key (its
    /// model was refused or never loaded) or nothing could be baked.
    pub(super) fn bake_atlas(&mut self, (gpu, renderer): (&Gpu, &mut Renderer), key: &str, class: ImpostorClass) -> Result<Option<BakedAtlas>, RenderError> {
        let Some(job) = self.jobs.iter().find(|job| job.key == key) else { return Ok(None) };
        let Some(model_digest) = job.digest else { return Ok(None) };
        let meshes: Vec<MeshId> = self.jobs.iter().flat_map(|job| job.parts.iter().map(|(mesh, _)| *mesh)).collect();
        renderer.reset_impostors(gpu, class, 1, &meshes);
        let install = ImpostorInstall { parts: &job.parts, layout: job.layout.render(), class, radius: job.radius, floor: job.floor };
        let baked = renderer.install_impostor(gpu, &install)?;
        let digest = baked_atlas_digest(model_digest, class, job.layout.render());
        let atlas = match baked {
            Some(row) => renderer.read_impostor_species(gpu, row.layer, digest)?,
            None => None,
        };
        self.reserved = None;
        for job in &mut self.jobs {
            job.state = JobState::Pending;
        }
        Ok(atlas)
    }

    /// Take every installed level off (impostors off): each job bakes again when they are on.
    fn take_off(&mut self, renderer: &mut Renderer) {
        let installed: Vec<MeshId> = self.jobs.iter().filter(|job| job.state != JobState::Pending).flat_map(|job| job.parts.iter().map(|(mesh, _)| *mesh)).collect();
        if installed.is_empty() {
            return;
        }
        renderer.remove_impostor_levels(&installed);
        // The renderer's species stay in its arrays: reserve again when impostors come back on,
        // or every job would find the arrays full.
        self.reserved = None;
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

    /// Build-time atlases loaded since the presenter opened (LOD-23).
    pub(super) fn loads(&self) -> u32 {
        self.loads
    }

    /// The baked impostors, in job order.
    pub(super) fn stats(&self) -> Vec<ImpostorStat> {
        self.jobs
            .iter()
            .filter_map(|job| match job.state {
                JobState::Baked { row, bake_ms, prebaked } => {
                    let spec = genex_render::impostor::ImpostorSpec { frames: row.frames, frame_px: row.frame_px, layout: job.layout.render(), depth_parallax: false, species_cap: 1 };
                    Some(ImpostorStat { model: job.model.clone(), layout: job.layout, frames: row.frames, frame_px: row.frame_px, bytes: spec.species_bytes(), bake_ms, prebaked })
                }
                JobState::Pending | JobState::OverCap | JobState::NotBaked => None,
            })
            .collect()
    }

    /// Why the model under `key` draws whole, if its impostor was refused at load.
    pub(super) fn refusal(&self, key: &str) -> Option<LodRefusalCode> {
        if self.refused.iter().any(|(known, _)| known == key) {
            return Some(LodRefusalCode::ImpostorInvalid);
        }
        self.jobs.iter().any(|job| job.key == key && job.state == JobState::NotBaked).then_some(LodRefusalCode::ImpostorNotBaked)
    }
}

/// The material a part bakes with: its GLB's own (untinted), else the default surface.
fn part_material(part: &super::ModelPart, assets: &AssetCache) -> Material {
    match &part.material {
        Some(glb) => glb.to_material(rgba(Color::WHITE)),
        None => surface(&crate::Material::color(Color::WHITE), Color::WHITE, assets),
    }
}

/// Every model `frame` draws (as `super::drawn_models`), each with whether the streamed view set
/// drew it (its draw carries the view set's tag).
fn drawn_models_streamed(frame: &Frame) -> impl Iterator<Item = (&crate::Model, bool)> {
    let shapes = frame.draws().iter().filter_map(|draw| Some((super::shape_model(&draw.shape)?, draw.tag == crate::present_stream::STREAM_TAG)));
    let custom = frame.custom_draws().iter().filter_map(|draw| match &draw.mesh {
        crate::frame::CustomMesh::Model(model) => Some((model, false)),
        crate::frame::CustomMesh::Cube | crate::frame::CustomMesh::Sphere => None,
    });
    shapes.chain(custom)
}

/// The FNV-1a 64 of what `model` (under cache key `key`) is drawn from: the key, then each file
/// its members and their levels read, by path and bytes; None when one does not read.
fn model_digest(key: &str, model: &crate::Model, source: &dyn ModelSource) -> Option<u64> {
    let mut files: Vec<&str> = Vec::new();
    for member in model.drawn_members() {
        files.push(member.path()?);
        if let Some(lod) = member.lod_options() {
            files.extend(lod.levels.iter().filter_map(|(level, _)| level.path()));
        }
    }
    let mut hash = genex_core::digest::fnv1a64(key.as_bytes());
    for path in files {
        let bytes = source.model_bytes(path)?;
        hash = genex_core::digest::fnv1a64_from(path.as_bytes(), hash);
        hash = genex_core::digest::fnv1a64_from(&genex_core::digest::fnv1a64(&bytes).to_le_bytes(), hash);
    }
    Some(hash)
}

/// The build-time atlas of `job` at `class` when the game's assets hold one baked from the same
/// inputs (its digest, class and layout); None otherwise (the job bakes, or stays unbaked).
fn prebaked(job: &Job, class: ImpostorClass, source: &dyn ModelSource) -> Option<BakedAtlas> {
    let digest = baked_atlas_digest(job.digest?, class, job.layout.render());
    let bytes = source.model_bytes(&format!("{BAKED_IMPOSTOR_FOLDER}/{}", impostor_bake_name(&job.key, class)))?;
    let atlas = BakedAtlas::from_ktx2(&bytes).ok()?;
    let matches = atlas.digest == digest && atlas.class == class && atlas.layout == job.layout.render();
    matches.then_some(atlas)
}

/// `elapsed` in milliseconds.
fn millis(elapsed: Duration) -> f32 {
    elapsed.as_secs_f32() * 1000.0
}
