//! The presenter's node-posed models (game systems AN-27): `frame.model_posed` draws its GLB as a
//! rigid-node skinned model (`SkinnedModel::rigid_from_glb`: every vertex bound to its node at
//! weight 1) posed by the palette the frame recorded, through the characters' skinned draw (one
//! logical draw, its parts with the materials the GLB names).
//!
//! The first frame naming a file uploads it once. A file the presenter does not have draws the
//! magenta checker; one the renderer refuses, or a model drawn with another file's animator, draws
//! as `frame.model` does (its rest pose), logged once.

use genex_render::skin::{SkinId, SkinnedModel};
use genex_render::{RenderCode, RenderError};

use super::{AssetCache, ModelSource, Uploads, WorldSink, push_shape, rgba, surface};
use crate::frame::{Color, Frame, Shape, Transform};
use crate::gfx::Model;

/// A node-posed GLB on the renderer: its skinned model and triangles.
#[derive(Clone, Copy, Debug, PartialEq)]
struct LoadedRigid {
    skin: SkinId,
    triangles: u32,
}

/// The rigid skins by path (`None`: refused).
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Posed {
    skins: Vec<(String, Option<LoadedRigid>)>,
}

impl Posed {
    /// Upload every node-posed GLB `frame` draws that was never tried. A lost device stops the load
    /// and leaves the rest to be tried again.
    pub(super) fn load(&mut self, frame: &Frame, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<(), RenderError> {
        for draw in frame.draws() {
            let Shape::Posed { nodes, .. } = &draw.shape else { continue };
            if self.skins.iter().any(|(known, _)| **known == **nodes) {
                continue;
            }
            let loaded = load_rigid(nodes, source, uploads, log)?;
            self.skins.push((nodes.to_string(), loaded));
        }
        Ok(())
    }

    /// Forget the skins of every path `touched` names (a dev build's `reloadAssets`).
    pub(super) fn forget(&mut self, touched: impl Fn(&str) -> bool) {
        self.skins.retain(|(path, _)| !touched(path));
    }

    fn skin(&self, path: &str) -> Option<LoadedRigid> {
        self.skins.iter().find(|(known, _)| known == path).and_then(|(_, loaded)| *loaded)
    }
}

/// `path` uploaded as a rigid-node skinned model; None (logged) when the file is not there (its
/// model load says so) or the GLB or the renderer refuses it. A lost device is passed on.
fn load_rigid(path: &str, source: &dyn ModelSource, uploads: &mut dyn Uploads, log: &mut dyn FnMut(&str)) -> Result<Option<LoadedRigid>, RenderError> {
    let Some(bytes) = source.model_bytes(path) else { return Ok(None) };
    let model = match SkinnedModel::rigid_from_glb(&bytes) {
        Ok(model) => model,
        Err(error) => {
            log(&format!("posed model {path:?} drawn at rest: {error}"));
            return Ok(None);
        }
    };
    match uploads.add_skinned_model(&model) {
        Ok(skin) => Ok(Some(LoadedRigid { skin, triangles: u32::try_from(model.data.mesh.indices.len() / 3).unwrap_or(u32::MAX) })),
        Err(error) if error.code() == RenderCode::DeviceLost => Err(error),
        Err(error) => {
            log(&format!("posed model {path:?} drawn at rest: {error}"));
            Ok(None)
        }
    }
}

/// A model as `frame.model_posed` drew it.
pub(super) struct PosedShape<'a> {
    pub(super) model: &'a Model,
    pub(super) nodes: &'a str,
    pub(super) palette: &'a [[f32; 16]],
    pub(super) transform: Transform,
    pub(super) tint: Color,
}

/// Add one posed model to `sink`: skinned at its pose when its file's rigid skin is held and is
/// the model's own, else as `frame.model` draws it. Answers its triangles.
pub(super) fn push(sink: &mut impl WorldSink, assets: &AssetCache, missing: &mut Vec<String>, posed: PosedShape<'_>) -> u32 {
    let PosedShape { model, nodes, palette, transform, tint } = posed;
    let own = model.path() == Some(nodes);
    let skin = assets.posed.skin(nodes).filter(|skin| own && skin.skin.joint_count() as usize == palette.len());
    let Some(skin) = skin else {
        return push_shape(sink, assets, missing, &Shape::Model { model: model.clone(), transform, tint, material: None });
    };
    let loaded = assets.model(nodes);
    let materials = (0..skin.skin.part_count() as usize)
        .map(|part| match loaded.and_then(|model| model.parts.get(part)).and_then(|part| part.material.as_ref()) {
            Some(glb) => glb.to_material(rgba(tint)),
            None => surface(&crate::Material::color(tint), Color::WHITE, assets),
        })
        .collect();
    sink.skinned(skin.skin, transform.to_cols_array(), palette.to_vec(), materials);
    skin.triangles
}
