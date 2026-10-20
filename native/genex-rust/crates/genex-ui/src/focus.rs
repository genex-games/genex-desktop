//! Focus scopes (G6 gameplay UI, UIS-4): a menu, list or grid moves focus among its own items by
//! the arrow keys (which the pad's d-pad and stick become, see [`crate::nav`]), wraps or stays
//! inside at its ends, focuses an item when it opens, and remembers its focused item per menu key
//! in egui memory (which the HUD forgets on seed).
//!
//! egui's own directional focus (a cone search over rects) stays for free layouts; inside a scope
//! the scope's layout decides, so a column menu never jumps to a widget beside it. Tab and
//! Shift+Tab stay egui's drawing-order walk.
//!
//! Only one scope takes focus on a pass: when two open together (a menu beside a grid), the one
//! drawn first wins. A scope behind a modal layer (a dialog) never takes focus.

use egui::{Event, Id, Key, Response};

/// What a scope's focus memory is keyed by.
const SCOPE_ID_SALT: &str = "genex-ui.focus";
/// Where a context records the pass on which a scope last took focus.
const CLAIM_ID: &str = "genex-ui.focus-claim";

/// How a scope's items are laid out, which decides what each arrow does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum FocusLayout {
    /// One item per row: up and down move.
    Column,
    /// One row: left and right move.
    Row,
    /// Rows of `columns` items in drawing order: every arrow moves, and stays at the grid's edges.
    Grid {
        /// Items per row (0 reads as 1).
        columns: usize,
    },
}

/// One arrow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arrow {
    Up,
    Down,
    Left,
    Right,
}

/// What a scope did on one pass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FocusAnswer {
    /// The item that had focus while the pass drew, by registration order.
    pub focused: Option<usize>,
    /// The item focus moves to for the next pass, when the scope moved it.
    pub moved_to: Option<usize>,
    /// Whether the scope was not drawn on the previous pass (it just opened).
    pub opened: bool,
}

/// One pass of a focus scope: register each item's response in drawing order with
/// [`FocusScope::item`], then call [`FocusScope::end`] once after the last item.
#[derive(Clone, Debug)]
pub struct FocusScope {
    id: Id,
    layout: FocusLayout,
    wrap: bool,
    autofocus: bool,
    hold: bool,
    items: Vec<FocusItem>,
}

#[derive(Clone, Copy, Debug)]
struct FocusItem {
    id: Id,
    enabled: bool,
    layer: egui::LayerId,
}

/// A scope's memory between passes.
#[derive(Clone, Copy, Debug, Default)]
struct FocusMemory {
    item: Option<Id>,
    index: usize,
    pass: Option<u64>,
    /// The scope opened but had no enabled item to focus yet (a grid's first, invisible pass).
    autofocus_pending: bool,
}

impl FocusScope {
    /// A column scope named `key` (its focus memory survives closing and reopening), which wraps
    /// at its ends and focuses an item when it opens.
    pub fn new(key: &str) -> FocusScope {
        FocusScope { id: Id::new((SCOPE_ID_SALT, key)), layout: FocusLayout::Column, wrap: true, autofocus: true, hold: false, items: Vec::new() }
    }

    /// How the items are laid out (default [`FocusLayout::Column`]).
    #[must_use]
    pub fn layout(self, layout: FocusLayout) -> FocusScope {
        FocusScope { layout, ..self }
    }

    /// Whether a column or row wraps from its last item to its first (default on; grids never wrap).
    #[must_use]
    pub fn wrap(self, wrap: bool) -> FocusScope {
        FocusScope { wrap, ..self }
    }

    /// Whether the scope focuses its remembered (or first enabled) item when it opens (default on).
    #[must_use]
    pub fn autofocus(self, autofocus: bool) -> FocusScope {
        FocusScope { autofocus, ..self }
    }

    /// Whether the scope takes focus back whenever nothing has focus (default off): a menu or
    /// dialog the player drives with a pad, where Escape (cancel) would otherwise drop focus.
    #[must_use]
    pub fn hold(self, hold: bool) -> FocusScope {
        FocusScope { hold, ..self }
    }

    /// The scope's egui id (its memory key).
    pub fn id(&self) -> Id {
        self.id
    }

    /// Register the next item; answers its index. A disabled item is skipped by every move.
    pub fn item(&mut self, response: &Response) -> usize {
        self.items.push(FocusItem { id: response.id, enabled: response.enabled(), layer: response.layer_id });
        self.items.len() - 1
    }

    /// End the pass: apply this pass's arrows inside the scope, focus an item when the scope opens
    /// (or when nothing has focus and an arrow is pressed), and remember the focused item.
    pub fn end(self, ctx: &egui::Context) -> FocusAnswer {
        let pass = ctx.cumulative_pass_nr();
        let memory = ctx.data(|data| data.get_temp::<FocusMemory>(self.id)).unwrap_or_default();
        let opened = memory.pass.map(|last| last + 1) != Some(pass);
        let autofocus_due = self.autofocus && (opened || memory.autofocus_pending);
        let current = ctx.memory(|m| m.focused());
        let focused = current.and_then(|id| self.items.iter().position(|item| item.id == id));
        let arrows = pressed_arrows(ctx);
        let may_take = self.may_take_focus(ctx, pass);
        let moved_to = match focused {
            Some(index) => {
                let at = arrows.iter().fold(index, |at, arrow| self.step(at, *arrow));
                (at != index).then_some(at)
            }
            None => {
                let wants = autofocus_due || (current.is_none() && (self.hold || !arrows.is_empty()));
                if wants && may_take { self.restore(&memory) } else { None }
            }
        };
        if let Some(target) = moved_to {
            ctx.memory_mut(|m| m.request_focus(self.items[target].id));
            ctx.data_mut(|data| data.insert_temp(Id::new(CLAIM_ID), pass));
        }
        let owns_arrows = !arrows.is_empty() && (focused.is_some() || moved_to.is_some());
        if owns_arrows {
            // The scope's layout decided; egui's cone search must not move focus again this pass.
            ctx.memory_mut(|m| m.move_focus(egui::FocusDirection::None));
        }
        let remembered = moved_to.or(focused);
        let next = FocusMemory {
            item: remembered.map(|index| self.items[index].id).or(memory.item),
            index: remembered.unwrap_or(memory.index),
            pass: Some(pass),
            // Another scope taking focus first settles it; only a scope with nothing to focus yet waits.
            autofocus_pending: autofocus_due && may_take && focused.is_none() && moved_to.is_none(),
        };
        ctx.data_mut(|data| data.insert_temp(self.id, next));
        FocusAnswer { focused, moved_to, opened }
    }

    /// Whether the scope may take focus from outside on this pass: no scope took it yet this pass,
    /// and no modal layer covers the scope's items.
    fn may_take_focus(&self, ctx: &egui::Context, pass: u64) -> bool {
        let claimed = ctx.data(|data| data.get_temp::<u64>(Id::new(CLAIM_ID))) == Some(pass);
        let reachable = self.items.first().is_none_or(|item| ctx.memory(|m| m.allows_interaction(item.layer)));
        !claimed && reachable
    }

    /// The item to focus on opening: the remembered one, else the nearest enabled item at its
    /// index, else the first enabled item.
    fn restore(&self, memory: &FocusMemory) -> Option<usize> {
        let enabled = |index: usize| self.items.get(index).is_some_and(|item| item.enabled);
        if let Some(index) = memory.item.and_then(|id| self.items.iter().position(|item| item.id == id))
            && enabled(index)
        {
            return Some(index);
        }
        let start = memory.index.min(self.items.len().saturating_sub(1));
        (start..self.items.len()).chain((0..start).rev()).find(|index| enabled(*index))
    }

    /// Where `arrow` moves focus from `at`, skipping disabled items; `at` when it cannot move.
    fn step(&self, at: usize, arrow: Arrow) -> usize {
        let mut next = at;
        for _ in 0..self.items.len() {
            match self.neighbour(next, arrow) {
                Some(candidate) if candidate == at => return at,
                Some(candidate) if self.items[candidate].enabled => return candidate,
                Some(candidate) => next = candidate,
                None => return at,
            }
        }
        at
    }

    /// The item next to `at` in the arrow's direction, by the layout; `None` at an edge.
    fn neighbour(&self, at: usize, arrow: Arrow) -> Option<usize> {
        let count = self.items.len();
        match (self.layout, arrow) {
            (FocusLayout::Column, Arrow::Up) | (FocusLayout::Row, Arrow::Left) => self.back(at, count),
            (FocusLayout::Column, Arrow::Down) | (FocusLayout::Row, Arrow::Right) => self.forward(at, count),
            (FocusLayout::Column, _) | (FocusLayout::Row, _) => None,
            (FocusLayout::Grid { columns }, _) => grid_neighbour(at, arrow, columns.max(1), count),
        }
    }

    fn back(&self, at: usize, count: usize) -> Option<usize> {
        match at.checked_sub(1) {
            Some(previous) => Some(previous),
            None if self.wrap && count > 1 => Some(count - 1),
            None => None,
        }
    }

    fn forward(&self, at: usize, count: usize) -> Option<usize> {
        if at + 1 < count {
            return Some(at + 1);
        }
        (self.wrap && count > 1).then_some(0)
    }
}

/// The grid cell next to `at` (rows of `columns` in drawing order), `None` at the grid's edges.
fn grid_neighbour(at: usize, arrow: Arrow, columns: usize, count: usize) -> Option<usize> {
    let column = at % columns;
    let candidate = match arrow {
        Arrow::Up => at.checked_sub(columns)?,
        Arrow::Down => at + columns,
        Arrow::Left if column == 0 => return None,
        Arrow::Left => at - 1,
        Arrow::Right if column + 1 == columns => return None,
        Arrow::Right => at + 1,
    };
    (candidate < count).then_some(candidate)
}

/// The arrows pressed on this pass without modifiers, in event order (egui's own focus rule).
fn pressed_arrows(ctx: &egui::Context) -> Vec<Arrow> {
    ctx.input(|input| {
        input
            .events
            .iter()
            .filter_map(|event| match event {
                Event::Key { key, pressed: true, modifiers, .. } if !modifiers.any() => arrow_of(*key),
                _ => None,
            })
            .collect()
    })
}

fn arrow_of(key: Key) -> Option<Arrow> {
    match key {
        Key::ArrowUp => Some(Arrow::Up),
        Key::ArrowDown => Some(Arrow::Down),
        Key::ArrowLeft => Some(Arrow::Left),
        Key::ArrowRight => Some(Arrow::Right),
        _ => None,
    }
}
