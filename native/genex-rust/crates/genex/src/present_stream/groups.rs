//! Streamed instance groups (game systems STR-20): the retained groups a cell's builders draw
//! (`CellBuild::group`, often a `CellInputs::scatter` of the cell's bounds), kept while the cell is
//! in the view set.
//!
//! - A cell's groups arrive with its view build (built on the job pool, inline on the web) and are
//!   appended to every frame while the cell stays wanted. Their rows are computed and uploaded once
//!   (renderer pass 2 A.0b); a cell that leaves the view drops its groups, so their rows stop
//!   uploading and the renderer's table lets them go.
//! - A model group takes a `View` reference on its model in the residency policy, as a cell's
//!   model draws do: it draws once the model is resident (or refused: the checker), and nothing
//!   while it loads.
//! - A cell whose groups hold more than [`STREAM_CELL_INSTANCES_MAX`] instances together is
//!   refused, as a cell with too many models is.

use std::collections::BTreeMap;

use genex_core::cell::CellId;

use crate::frame::Frame;
use crate::group::{GroupShape, InstanceGroup};
use crate::stream::STREAM_CELL_INSTANCES_MAX;

/// One group a built cell draws, with the residency key of its model (None for cubes, spheres and
/// a model with no path, which never wait).
pub(super) struct ViewGroup {
    pub(super) group: InstanceGroup,
    pub(super) key: Option<u32>,
}

/// What the groups drew in the last frame.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct GroupsDrawn {
    /// Groups appended to the frame.
    pub(super) groups: u32,
    /// Their instances together.
    pub(super) instances: u64,
    /// Model groups left out because their model was loading.
    pub(super) loading: u32,
}

/// The view set's groups, by cell (module doc).
#[derive(Default)]
pub(super) struct CellGroups {
    cells: BTreeMap<CellId, Vec<ViewGroup>>,
}

impl CellGroups {
    /// A built cell's groups, keyed: they draw from the next frame on.
    pub(super) fn insert(&mut self, cell: CellId, groups: Vec<ViewGroup>) {
        if !groups.is_empty() {
            self.cells.insert(cell, groups);
        }
    }

    /// A cell left the view (or its build was dropped): its groups go, and the residency keys their
    /// models held are handed back for release.
    pub(super) fn remove(&mut self, cell: CellId) -> Vec<u32> {
        self.cells.remove(&cell).into_iter().flatten().filter_map(|entry| entry.key).collect()
    }

    /// Whether any group waits on `waiting` (a model key still loading).
    pub(super) fn any_waiting(&self, waiting: impl Fn(u32) -> bool) -> bool {
        self.cells.values().flatten().filter_map(|entry| entry.key).any(waiting)
    }

    /// Append every group of every cell, ascending, whose model `drawable` lets draw; answers what
    /// was drawn and what waited.
    pub(super) fn draw_into(&self, frame: &mut Frame, drawable: impl Fn(u32) -> bool) -> GroupsDrawn {
        let mut drawn = GroupsDrawn::default();
        for entry in self.cells.values().flatten() {
            if entry.key.is_some_and(|key| !drawable(key)) {
                drawn.loading += 1;
                continue;
            }
            frame.group(&entry.group);
            drawn.groups += 1;
            drawn.instances += entry.group.len() as u64;
        }
        drawn
    }
}

/// The model path a group draws, when it draws a model that has one.
pub(super) fn model_path(group: &InstanceGroup) -> Option<&str> {
    match group.shape() {
        GroupShape::Model(model) => model.path(),
        GroupShape::Cube | GroupShape::Sphere => None,
    }
}

/// Whether a cell's groups pass the cell's instance cap together ([`STREAM_CELL_INSTANCES_MAX`]).
pub(super) fn over_cap(groups: &[InstanceGroup]) -> bool {
    let instances: usize = groups.iter().map(InstanceGroup::len).sum();
    instances > STREAM_CELL_INSTANCES_MAX as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{Color, Material, Shape, Transform};

    fn cubes(count: usize) -> InstanceGroup {
        let transforms = (0..count).map(|i| Transform::from_xyz(i as f32, 0.0, 0.0)).collect();
        InstanceGroup::cubes(transforms, &Material::color(Color::WHITE)).expect("group")
    }

    fn groups_in(frame: &Frame) -> usize {
        frame.draws().iter().filter(|draw| matches!(draw.shape, Shape::Group { .. })).count()
    }

    #[test]
    fn a_removed_cell_stops_drawing_its_groups_and_gives_back_its_model_keys() {
        let mut groups = CellGroups::default();
        groups.insert(CellId::new(0, 0), vec![ViewGroup { group: cubes(3), key: None }, ViewGroup { group: cubes(2), key: Some(7) }]);
        groups.insert(CellId::new(1, 0), vec![ViewGroup { group: cubes(4), key: None }]);
        let mut frame = Frame::default();
        let drawn = groups.draw_into(&mut frame, |key| key != 7);
        assert_eq!(drawn, GroupsDrawn { groups: 2, instances: 7, loading: 1 }, "the loading model's group waits");
        assert_eq!(groups_in(&frame), 2);
        assert!(groups.any_waiting(|key| key == 7));
        assert_eq!(groups.remove(CellId::new(0, 0)), vec![7]);
        assert!(!groups.any_waiting(|key| key == 7));
        let mut frame = Frame::default();
        let drawn = groups.draw_into(&mut frame, |_| true);
        assert_eq!(drawn, GroupsDrawn { groups: 1, instances: 4, loading: 0 });
        assert!(groups.remove(CellId::new(5, 5)).is_empty());
    }

    #[test]
    fn a_cell_past_its_instance_cap_is_over() {
        let half = STREAM_CELL_INSTANCES_MAX as usize / 2;
        assert!(!over_cap(&[cubes(half), cubes(half)]));
        assert!(over_cap(&[cubes(half), cubes(half + 1)]));
    }
}
