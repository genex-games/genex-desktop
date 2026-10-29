//! Skeletons: joints parent-first, the rest pose, and the skinning palette (ozz-animation's
//! `Skeleton` and `LocalToModelJob`, MIT, ported to AoS glam scalar).
//!
//! A skeleton holds only joints: the skin's joints plus any non-joint node between two of them.
//! Non-joint ancestors above a root joint (the Mixamo "Armature" node at scale 0.01) fold into
//! that root's fixed frame. Because every parent comes before its children, local-to-model is one
//! pass over caller scratch with no allocation. The palette is written in the file's skin order
//! (`skin_order`), so genex-render's `SkinnedMeshData` and `skin.wgsl` read it unchanged; it
//! equals genex-render's `Skeleton::joint_matrices`, `inverse(global(mesh node)) × global(joint)
//! × inverse bind`, with the mesh node and the folded frames at rest. The palette is therefore in
//! the skinned mesh node's space: a draw places it under `transform × mesh_frame()`, so the
//! armature a Mixamo, Meshy or Uthana file turns and scales stands where its joints (and every
//! socket) are, as glTF places it.

use glam::Mat4;

use crate::ids::JointId;
use crate::math::Trs;

/// Joints one skeleton may have (genex-render's skinned draws name at most this many matrices).
pub const MAX_JOINTS: usize = 256;

/// A root joint's parent slot.
const NO_PARENT: u16 = u16::MAX;

/// One joint as the importer hands it over, already parent-first.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct JointParts {
    /// Its name in the file.
    pub(crate) name: String,
    /// Its parent, earlier in the list.
    pub(crate) parent: Option<u16>,
    /// Its rest transform.
    pub(crate) rest: Trs,
    /// For a root: its non-joint ancestors' global transform at rest.
    pub(crate) root_frame: Mat4,
}

/// A joint-only skeleton, parents before children.
#[derive(Clone, Debug, PartialEq)]
pub struct Skeleton {
    names: Vec<String>,
    parents: Vec<u16>,
    rest: Vec<Trs>,
    root_frames: Vec<Mat4>,
    mesh_frame: Mat4,
    unmesh: Mat4,
    skin_order: Vec<JointId>,
    inverse_bind: Vec<Mat4>,
}

impl Skeleton {
    /// A skeleton from parent-first joints, the skinned mesh node's global transform at rest and
    /// its inverse, and the skin's joints with their inverse bind matrices in file order. The
    /// importer checks every bound before calling this.
    pub(crate) fn from_parts(joints: Vec<JointParts>, (mesh_frame, unmesh): (Mat4, Mat4), skin: Vec<(JointId, Mat4)>) -> Skeleton {
        let mut skeleton = Skeleton {
            names: Vec::with_capacity(joints.len()),
            parents: Vec::with_capacity(joints.len()),
            rest: Vec::with_capacity(joints.len()),
            root_frames: Vec::with_capacity(joints.len()),
            mesh_frame,
            unmesh,
            skin_order: Vec::with_capacity(skin.len()),
            inverse_bind: Vec::with_capacity(skin.len()),
        };
        for joint in joints {
            skeleton.names.push(joint.name);
            skeleton.parents.push(joint.parent.unwrap_or(NO_PARENT));
            skeleton.rest.push(joint.rest);
            skeleton.root_frames.push(joint.root_frame);
        }
        for (joint, inverse_bind) in skin {
            skeleton.skin_order.push(joint);
            skeleton.inverse_bind.push(inverse_bind);
        }
        skeleton
    }

    /// Joints, including the non-joint nodes between two skin joints.
    pub fn joint_count(&self) -> usize {
        self.parents.len()
    }

    /// Joints the skin names: the palette's length.
    pub fn skin_joint_count(&self) -> usize {
        self.skin_order.len()
    }

    /// Every joint, parents first.
    pub fn joints(&self) -> impl ExactSizeIterator<Item = JointId> + '_ {
        (0..self.parents.len()).map(|index| JointId(index as u16))
    }

    /// A joint's name in the file.
    pub fn name(&self, joint: JointId) -> &str {
        self.names.get(usize::from(joint.0)).map_or("", String::as_str)
    }

    /// A joint's parent; `None` for a root.
    pub fn parent(&self, joint: JointId) -> Option<JointId> {
        let parent = *self.parents.get(usize::from(joint.0))?;
        (parent != NO_PARENT).then_some(JointId(parent))
    }

    /// The skinned mesh node's global transform at rest (an armature's turn and scale included):
    /// the frame the palette is in, which a draw puts under the character's transform.
    pub fn mesh_frame(&self) -> Mat4 {
        self.mesh_frame
    }

    /// The rest pose, one local transform per joint.
    pub fn rest_pose(&self) -> &[Trs] {
        &self.rest
    }

    /// The joint behind each palette slot, in the file's skin order.
    pub fn skin_order(&self) -> &[JointId] {
        &self.skin_order
    }

    /// The joint called `name`: the exact name first, then the part after the last `|` or `:`
    /// ignoring ASCII case, so "hips" finds "mixamorig:Hips".
    pub fn find(&self, name: &str) -> Option<JointId> {
        if let Some(index) = self.names.iter().position(|n| n == name) {
            return Some(JointId(index as u16));
        }
        let index = self.names.iter().position(|n| short_name(n).eq_ignore_ascii_case(name))?;
        Some(JointId(index as u16))
    }

    /// Model-space transforms of `locals` (one per joint) into `model`, in one pass. Only the
    /// first `min(joint_count, locals.len(), model.len())` joints are written; nothing allocates.
    pub fn local_to_model(&self, locals: &[Trs], model: &mut [Mat4]) {
        let count = self.parents.len().min(locals.len()).min(model.len());
        for index in 0..count {
            let parent = self.parents[index];
            let frame = if parent == NO_PARENT { self.root_frames[index] } else { model[usize::from(parent)] };
            model[index] = frame * locals[index].matrix();
        }
    }

    /// The skinning palette of `model` into `palette`, in skin order, column-major. Only the
    /// first `min(skin_joint_count, palette.len())` slots are written; a slot whose joint has no
    /// model transform is the identity.
    pub fn palette(&self, model: &[Mat4], palette: &mut [[f32; 16]]) {
        for ((slot, joint), inverse_bind) in palette.iter_mut().zip(&self.skin_order).zip(&self.inverse_bind) {
            *slot = match model.get(usize::from(joint.0)) {
                Some(global) => (self.unmesh * *global * *inverse_bind).to_cols_array(),
                None => Mat4::IDENTITY.to_cols_array(),
            };
        }
    }
}

/// The part of a joint name after its last `|` or `:` ("Armature|mixamorig:Hips" → "Hips").
fn short_name(name: &str) -> &str {
    name.rsplit(['|', ':']).next().unwrap_or(name)
}
