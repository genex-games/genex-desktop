//! An item list (G6 gameplay UI, UIS-5): the vertical variant of [`ItemGrid`], one row per item,
//! with the same keys, focus, tap and drag rules and the same [`GridAnswer`].

use crate::kit::grid::{GridAnswer, ItemGrid};

/// A row's height when the game names none, in world pixels (a large tap target).
pub const ROW_DEFAULT: f32 = 44.0;
/// A row's width when the game names none, in world pixels.
pub const ROW_WIDTH_DEFAULT: f32 = 320.0;

/// A list: `ItemList::new("quests").show(ui, count, |ui, i, rect| label_of(i))`.
#[derive(Clone, Copy, Debug)]
pub struct ItemList<'a> {
    grid: ItemGrid<'a>,
}

impl<'a> ItemList<'a> {
    /// A list keyed `key` (its rows are keyed `<key>.<index>`).
    pub fn new(key: &'a str) -> ItemList<'a> {
        ItemList { grid: ItemGrid::new(key, 1).cell_size(egui::vec2(ROW_WIDTH_DEFAULT, ROW_DEFAULT)) }
    }

    /// Rows of `size` world pixels.
    #[must_use]
    pub fn row(self, size: egui::Vec2) -> ItemList<'a> {
        ItemList { grid: self.grid.cell_size(size) }
    }

    /// Draw `count` rows; `row` draws row `index` inside its rect and answers its label.
    pub fn show(self, ui: &mut egui::Ui, count: usize, row: impl FnMut(&mut egui::Ui, usize, egui::Rect) -> String) -> GridAnswer {
        self.grid.show(ui, count, row)
    }
}
