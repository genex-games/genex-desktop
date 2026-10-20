//! A dialog (G6 gameplay UI, UIS-5) over egui's `Modal`: a title, a body and a row of keyed
//! buttons. Everything behind it reads no pointer or focus while it is open (the modal layer),
//! focus holds on its buttons, and cancel (B, Escape, a click on the backdrop) picks its `cancel`
//! key.

use crate::focus::{FocusLayout, FocusScope};
use crate::keyed::{Keyed, key_widget};

/// The smallest dialog button, in world pixels (a large tap target).
pub const DIALOG_BUTTON_MIN: egui::Vec2 = egui::vec2(120.0, 44.0);
/// The widest a dialog's body wraps at, in world pixels.
pub const DIALOG_WIDTH_MAX: f32 = 480.0;
/// The gap between the title, the body and the buttons, in world pixels.
pub const DIALOG_GAP: f32 = 12.0;

/// A dialog: `Dialog::new("quit").title("Quit?").button("yes", "Yes").cancel("no").show(ui)`.
#[derive(Clone, Debug)]
pub struct Dialog<'a> {
    key: &'a str,
    title: Option<&'a str>,
    body: Option<&'a str>,
    buttons: Vec<(&'a str, &'a str)>,
    cancel: Option<&'a str>,
}

impl<'a> Dialog<'a> {
    /// An empty dialog keyed `key` (its buttons are keyed `<key>.<button>`).
    pub fn new(key: &'a str) -> Dialog<'a> {
        Dialog { key, title: None, body: None, buttons: Vec::new(), cancel: None }
    }

    /// The title, drawn large (keyed `<key>.title`).
    #[must_use]
    pub fn title(self, title: &'a str) -> Dialog<'a> {
        Dialog { title: Some(title), ..self }
    }

    /// The body text, wrapped (keyed `<key>.body`).
    #[must_use]
    pub fn body(self, body: &'a str) -> Dialog<'a> {
        Dialog { body: Some(body), ..self }
    }

    /// A button, left to right; the first one holds focus when the dialog opens.
    #[must_use]
    pub fn button(mut self, key: &'a str, label: &'a str) -> Dialog<'a> {
        self.buttons.push((key, label));
        self
    }

    /// The key cancel picks.
    #[must_use]
    pub fn cancel(self, key: &'a str) -> Dialog<'a> {
        Dialog { cancel: Some(key), ..self }
    }

    /// Draw the dialog over everything: the key of the button picked on this pass, if any.
    pub fn show(self, ui: &egui::Ui) -> Option<&'a str> {
        let ctx = ui.ctx().clone();
        let modal = egui::Modal::new(egui::Id::new(("genex-ui.dialog", self.key))).show(&ctx, |ui| {
            ui.set_max_width(DIALOG_WIDTH_MAX);
            if let Some(title) = self.title {
                let response = ui.heading(title);
                key_widget(ui.ctx(), response.id, &format!("{}.title", self.key));
                ui.add_space(DIALOG_GAP);
            }
            if let Some(body) = self.body {
                let response = ui.add(egui::Label::new(body).wrap());
                key_widget(ui.ctx(), response.id, &format!("{}.body", self.key));
                ui.add_space(DIALOG_GAP);
            }
            self.buttons_row(ui)
        });
        let cancelled = modal.should_close();
        modal.inner.or_else(|| self.cancel.filter(|_| cancelled))
    }

    fn buttons_row(&self, ui: &mut egui::Ui) -> Option<&'a str> {
        let mut scope = FocusScope::new(self.key).layout(FocusLayout::Row).hold(true);
        let mut picked = None;
        ui.horizontal(|ui| {
            for (key, label) in &self.buttons {
                let response = ui.add(egui::Button::new(*label).min_size(DIALOG_BUTTON_MIN)).key(ui, &format!("{}.{key}", self.key));
                scope.item(&response);
                if response.clicked() {
                    picked = Some(*key);
                }
            }
        });
        scope.end(ui.ctx());
        picked
    }
}
