//! An item grid (G6 gameplay UI, UIS-5): cells of a fixed size in rows, each keyed and labelled,
//! focus moved by the arrows and kept inside at the grid's edges, Enter (A) or a tap activating a
//! cell, and a pointer drag that moves a cell only after it was held [`DRAG_DELAY_TICKS`] ticks,
//! so a tap never drags. Counted in passes, which the HUD runs once per tick.

use crate::focus::{FocusLayout, FocusScope};
use crate::keyed::key_widget;

/// Ticks a pointer holds a cell before dragging it.
pub const DRAG_DELAY_TICKS: u32 = 12;
/// A cell's side when the game names none, in world pixels.
pub const CELL_DEFAULT: f32 = 64.0;
/// The gap between cells, in world pixels.
pub const CELL_GAP: f32 = 6.0;
/// The most cells one grid draws; later ones are not drawn.
pub const CELLS_MAX: usize = 1024;
/// A cell's corner radius and its focus and drag outline width, in world pixels.
const CELL_RADIUS: f32 = 4.0;
const OUTLINE_WIDTH: f32 = 2.0;

/// What a grid or list answered on one pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GridAnswer {
    /// The cell activated (Enter on the focused cell, or a tap).
    pub activated: Option<usize>,
    /// A drag dropped cell `.0` on cell `.1`.
    pub moved: Option<(usize, usize)>,
    /// The cell focused while the pass drew.
    pub focused: Option<usize>,
}

/// A grid: `ItemGrid::new("bag", 4).cell(64.0).show(ui, count, |ui, i, rect| label_of(i))`.
#[derive(Clone, Copy, Debug)]
pub struct ItemGrid<'a> {
    key: &'a str,
    columns: usize,
    cell: egui::Vec2,
}

impl<'a> ItemGrid<'a> {
    /// A grid keyed `key` (its cells are keyed `<key>.<index>`) with `columns` cells per row (0
    /// reads as 1).
    pub fn new(key: &'a str, columns: usize) -> ItemGrid<'a> {
        ItemGrid { key, columns: columns.max(1), cell: egui::Vec2::splat(CELL_DEFAULT) }
    }

    /// Square cells of `side` world pixels.
    #[must_use]
    pub fn cell(self, side: f32) -> ItemGrid<'a> {
        self.cell_size(egui::Vec2::splat(side))
    }

    /// Cells of `size` world pixels (a list's rows).
    #[must_use]
    pub fn cell_size(self, size: egui::Vec2) -> ItemGrid<'a> {
        ItemGrid { cell: size.max(egui::Vec2::splat(1.0)), ..self }
    }

    /// Draw `count` cells; `cell` draws cell `index` inside its rect and answers its label (what
    /// AccessKit and `hud.items` read).
    pub fn show(self, ui: &mut egui::Ui, count: usize, cell: impl FnMut(&mut egui::Ui, usize, egui::Rect) -> String) -> GridAnswer {
        let layout = if self.columns == 1 { FocusLayout::Column } else { FocusLayout::Grid { columns: self.columns } };
        show_cells(ui, self, count.min(CELLS_MAX), FocusScope::new(self.key).layout(layout).wrap(false).hold(true), cell)
    }
}

/// A grid's pointer drag between passes.
#[derive(Clone, Copy, Debug, Default)]
struct DragState {
    from: Option<usize>,
    held_ticks: u32,
    dragging: bool,
}

/// The pointer on one pass, as the grid reads it.
#[derive(Clone, Copy, Debug)]
struct PointerTick {
    pressed: bool,
    released: bool,
    down: bool,
    pos: Option<egui::Pos2>,
}

fn show_cells(
    ui: &mut egui::Ui,
    grid: ItemGrid<'_>,
    count: usize,
    mut scope: FocusScope,
    mut cell: impl FnMut(&mut egui::Ui, usize, egui::Rect) -> String,
) -> GridAnswer {
    let rows = count.div_ceil(grid.columns);
    let size = egui::vec2(span(grid.columns, grid.cell.x), span(rows, grid.cell.y));
    let (area, _) = ui.allocate_exact_size(size, egui::Sense::hover());
    let rect_of = |index: usize| {
        let at = egui::vec2((index % grid.columns) as f32, (index / grid.columns) as f32);
        egui::Rect::from_min_size(area.min + at * (grid.cell + egui::Vec2::splat(CELL_GAP)), grid.cell)
    };
    let cell_at = |pos: egui::Pos2| (0..count).find(|index| rect_of(*index).contains(pos));
    let state_id = egui::Id::new(("genex-ui.grid", grid.key));
    // Behind a modal layer (an open dialog) the pointer belongs to the dialog, and a drag is dropped.
    let reachable = ui.ctx().memory(|m| m.allows_interaction(ui.layer_id()));
    let state = if reachable { ui.ctx().data(|data| data.get_temp::<DragState>(state_id)).unwrap_or_default() } else { DragState::default() };
    let pointer = if reachable { pointer_tick(ui) } else { PointerTick::IDLE };
    let (state, mut answer) = drag_step(state, pointer, pointer.pos.and_then(cell_at));
    let hovered = pointer.pos.and_then(cell_at);
    for index in 0..count {
        let rect = rect_of(index);
        let id = egui::Id::new(("genex-ui.cell", grid.key, index));
        let response = ui.interact(rect, id, egui::Sense::click());
        scope.item(&response);
        let visuals = ui.style().interact(&response);
        ui.painter().rect_filled(rect, CELL_RADIUS, visuals.bg_fill);
        let mut child = ui.new_child(egui::UiBuilder::new().max_rect(rect).id_salt(id));
        let label = cell(&mut child, index, rect);
        response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Button, true, &label));
        key_widget(ui.ctx(), id, &format!("{}.{index}", grid.key));
        let dragging_here = state.dragging && (state.from == Some(index) || hovered == Some(index));
        if response.has_focus() || dragging_here {
            let stroke = egui::Stroke::new(OUTLINE_WIDTH, ui.visuals().selection.stroke.color);
            ui.painter().rect_stroke(rect, CELL_RADIUS, stroke, egui::StrokeKind::Inside);
        }
        if response.has_focus() {
            answer.focused = Some(index);
        }
        let keyboard_activated = response.clicked() && !response.clicked_by(egui::PointerButton::Primary);
        if keyboard_activated {
            answer.activated = Some(index);
        }
    }
    scope.end(ui.ctx());
    ui.ctx().data_mut(|data| data.insert_temp(state_id, state));
    answer
}

impl PointerTick {
    /// No press, no release, nothing held, nowhere.
    const IDLE: PointerTick = PointerTick { pressed: false, released: false, down: false, pos: None };
}

fn pointer_tick(ui: &egui::Ui) -> PointerTick {
    ui.input(|input| PointerTick {
        pressed: input.pointer.primary_pressed(),
        released: input.pointer.primary_released(),
        down: input.pointer.primary_down(),
        pos: input.pointer.interact_pos(),
    })
}

/// One pass of the pointer drag: a press on a cell arms it, holding [`DRAG_DELAY_TICKS`] ticks
/// starts a drag, and the release drops it (a move) or, before the delay and on the same cell,
/// taps it (an activation).
fn drag_step(state: DragState, pointer: PointerTick, under: Option<usize>) -> (DragState, GridAnswer) {
    let mut next = state;
    let mut answer = GridAnswer::default();
    if pointer.pressed {
        next = DragState { from: under, held_ticks: 0, dragging: false };
    } else if next.from.is_some() && pointer.down {
        next.held_ticks = next.held_ticks.saturating_add(1);
        next.dragging |= next.held_ticks >= DRAG_DELAY_TICKS;
    }
    if !pointer.released {
        return (next, answer);
    }
    if let Some(from) = next.from {
        if next.dragging {
            answer.moved = under.filter(|to| *to != from).map(|to| (from, to));
        } else if under == Some(from) {
            answer.activated = Some(from);
        }
    }
    (DragState::default(), answer)
}

/// The length of `cells` cells of `side` with gaps between them.
fn span(cells: usize, side: f32) -> f32 {
    if cells == 0 {
        return 0.0;
    }
    cells as f32 * side + (cells - 1) as f32 * CELL_GAP
}
