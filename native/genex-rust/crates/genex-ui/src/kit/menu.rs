//! A menu (G6 gameplay UI, UIS-5): a column of keyed buttons a pad walks with wrap, which focuses
//! its first enabled item within one tick of opening, remembers its focused item, and answers the
//! picked item's key (its `back` key when the player cancels).

use crate::focus::FocusScope;
use crate::keyed::Keyed;
use crate::nav::{NavButton, pressed};

/// The smallest menu button, in world pixels (a large tap target).
pub const MENU_ITEM_MIN: egui::Vec2 = egui::vec2(220.0, 44.0);

/// A menu: `Menu::new("pause").item("resume", "Resume").back("resume").show(ui)`.
#[derive(Clone, Debug)]
pub struct Menu<'a> {
    key: &'a str,
    items: Vec<MenuItem<'a>>,
    back: Option<&'a str>,
}

#[derive(Clone, Copy, Debug)]
struct MenuItem<'a> {
    key: &'a str,
    label: &'a str,
    enabled: bool,
}

impl<'a> Menu<'a> {
    /// An empty menu keyed `key` (its items are keyed `<key>.<item>`).
    pub fn new(key: &'a str) -> Menu<'a> {
        Menu { key, items: Vec::new(), back: None }
    }

    /// An enabled item.
    #[must_use]
    pub fn item(self, key: &'a str, label: &'a str) -> Menu<'a> {
        self.item_enabled(key, label, true)
    }

    /// An item that may be disabled (drawn, never focused or picked).
    #[must_use]
    pub fn item_enabled(mut self, key: &'a str, label: &'a str, enabled: bool) -> Menu<'a> {
        self.items.push(MenuItem { key, label, enabled });
        self
    }

    /// The key cancel (B, Escape) picks.
    #[must_use]
    pub fn back(self, key: &'a str) -> Menu<'a> {
        Menu { back: Some(key), ..self }
    }

    /// Draw the menu: the key of the item picked on this pass, if any.
    pub fn show(self, ui: &mut egui::Ui) -> Option<&'a str> {
        let mut scope = FocusScope::new(self.key).hold(true);
        let mut picked = None;
        for item in &self.items {
            let button = egui::Button::new(item.label).min_size(MENU_ITEM_MIN);
            let response = ui.add_enabled(item.enabled, button).key(ui, &format!("{}.{}", self.key, item.key));
            scope.item(&response);
            if response.clicked() {
                picked = Some(item.key);
            }
        }
        scope.end(ui.ctx());
        // Behind a modal layer (an open dialog) cancel belongs to the dialog.
        let reachable = ui.ctx().memory(|m| m.allows_interaction(ui.layer_id()));
        picked.or_else(|| self.back.filter(|_| reachable && pressed(ui.ctx(), NavButton::Cancel)))
    }
}
