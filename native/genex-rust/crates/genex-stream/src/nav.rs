//! `StreamNav`: the nav island slot the commit hook fills (STR-11).
//!
//! A streamed world's navigation comes in per sim cell: each cell's island (its nav tiles) is
//! built off the frame (an offline bake read from the cell's assets, or a bake sliced on a
//! worker), carried as a cell part, and added to the game's nav in the commit slot when the cell
//! enters the sim set; it is removed when the cell leaves. A late island holds the frame exactly
//! as a late collider does: the commit waits for the cell's build, so the nav never sees a tick
//! with the cell active and its island missing.
//!
//! The commit order is part of the simulation's initial conditions, as for colliders: leaving
//! cells go out descending, then entering cells come in ascending ([`commit`] applies that order
//! whatever order it is handed). A nav implements [`StreamNav`]; this crate does not know its
//! island type, so any navigation (genex-nav's, or a fake that records the order) plugs in with no
//! change here. Agents standing on an island that leaves go off the mesh and freeze; when it comes
//! back they walk on toward the same target (owner call X1).

use crate::CellId;

/// A navigation the commit slot can stream islands into.
pub trait StreamNav {
    /// What a cell's build carries for the nav: its island.
    type Island;

    /// `cell` leaves the sim set: drop its island. Returns how many tiles went (0 when the cell
    /// had none in).
    fn island_leave(&mut self, cell: CellId) -> usize;

    /// `cell` enters the sim set with `island`: add it (a cell already in leaves first). Returns
    /// how many tiles came in; an island the nav refuses adds nothing and returns 0.
    fn island_enter(&mut self, cell: CellId, island: &Self::Island) -> usize;
}

/// What one [`commit`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NavCommit {
    /// Cells whose islands went out.
    pub left: usize,
    /// Cells whose islands came in.
    pub entered: usize,
    /// Tiles that went out.
    pub tiles_out: usize,
    /// Tiles that came in.
    pub tiles_in: usize,
}

/// One tick's island changes in the canonical order: `left` descending, then `entered`
/// ascending, whatever order they are given in. A cell named twice in a list is applied once.
pub fn commit<N: StreamNav>(nav: &mut N, left: &[CellId], entered: &[(CellId, &N::Island)]) -> NavCommit {
    let mut leaving: Vec<CellId> = left.to_vec();
    leaving.sort_unstable_by(|a, b| b.cmp(a));
    leaving.dedup();
    let mut entering: Vec<(CellId, &N::Island)> = entered.to_vec();
    entering.sort_by_key(|(cell, _)| *cell);
    entering.dedup_by_key(|(cell, _)| *cell);
    let mut out = NavCommit { left: leaving.len(), entered: entering.len(), ..NavCommit::default() };
    for cell in leaving {
        out.tiles_out += nav.island_leave(cell);
    }
    for (cell, island) in entering {
        out.tiles_in += nav.island_enter(cell, island);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{NavCommit, StreamNav, commit};
    use crate::CellId;

    /// Records the slot's calls; an island is its tile count.
    #[derive(Default)]
    struct Recorder(Vec<(bool, CellId)>);

    impl StreamNav for Recorder {
        type Island = usize;

        fn island_leave(&mut self, cell: CellId) -> usize {
            self.0.push((false, cell));
            1
        }

        fn island_enter(&mut self, cell: CellId, island: &usize) -> usize {
            self.0.push((true, cell));
            *island
        }
    }

    const fn cell(x: i32, z: i32) -> CellId {
        CellId { x, z }
    }

    #[test]
    fn a_shuffled_commit_leaves_descending_then_enters_ascending_once_each() {
        let mut recorder = Recorder::default();
        let left = [cell(0, 1), cell(2, 0), cell(-1, 3), cell(2, 0)];
        let four = 4;
        let entered = [(cell(5, 5), &four), (cell(-3, 0), &four), (cell(5, -2), &four), (cell(-3, 0), &four)];
        let done = commit(&mut recorder, &left, &entered);
        assert_eq!(done, NavCommit { left: 3, entered: 3, tiles_out: 3, tiles_in: 12 });
        let expected = vec![
            (false, cell(2, 0)),
            (false, cell(0, 1)),
            (false, cell(-1, 3)),
            (true, cell(-3, 0)),
            (true, cell(5, -2)),
            (true, cell(5, 5)),
        ];
        assert_eq!(recorder.0, expected, "CellId orders by x, then z");
    }
}
