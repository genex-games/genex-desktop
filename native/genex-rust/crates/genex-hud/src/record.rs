//! The widgets one tick drew, read from egui's AccessKit tree in drawing order.

use egui::accesskit::{Node, NodeId, Role, TreeUpdate};
use std::collections::{BTreeMap, BTreeSet};

/// What kind of widget a [`HudWidget`] is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum WidgetRole {
    /// Static text.
    Label,
    /// A button (also collapsing headers and selectable labels).
    Button,
    /// A checkbox.
    CheckBox,
    /// A radio button.
    RadioButton,
    /// A text field.
    TextInput,
    /// A slider or drag value.
    Slider,
    /// A combo box.
    ComboBox,
    /// A hyperlink.
    Link,
}

impl WidgetRole {
    /// The role's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            WidgetRole::Label => "label",
            WidgetRole::Button => "button",
            WidgetRole::CheckBox => "checkbox",
            WidgetRole::RadioButton => "radio",
            WidgetRole::TextInput => "text-input",
            WidgetRole::Slider => "slider",
            WidgetRole::ComboBox => "combo-box",
            WidgetRole::Link => "link",
        }
    }

    fn of(role: Role) -> Option<WidgetRole> {
        Some(match role {
            Role::Label => WidgetRole::Label,
            Role::Button => WidgetRole::Button,
            Role::CheckBox => WidgetRole::CheckBox,
            Role::RadioButton => WidgetRole::RadioButton,
            Role::TextInput => WidgetRole::TextInput,
            Role::Slider | Role::SpinButton => WidgetRole::Slider,
            Role::ComboBox => WidgetRole::ComboBox,
            Role::Link => WidgetRole::Link,
            _ => return None,
        })
    }
}

/// A widget the HUD drew on the last tick.
#[derive(Clone, Debug, PartialEq)]
pub struct HudWidget {
    /// What kind of widget it is.
    pub role: WidgetRole,
    /// Its text: a button's caption, a label's text.
    pub label: String,
    /// `[x0, y0, x1, y1]` in world pixels.
    pub rect: [f32; 4],
}

impl HudWidget {
    /// The widget's centre as a fraction of a `world_size` frame: where an injected click aims.
    pub fn center_fraction(&self, world_size: [u32; 2]) -> [f32; 2] {
        let [x0, y0, x1, y1] = self.rect;
        [(x0 + x1) / 2.0 / world_size[0] as f32, (y0 + y1) / 2.0 / world_size[1] as f32]
    }
}

/// The labelled widgets of an AccessKit update, depth first from the root in child order (the
/// order the UI drew them), at most `cap`.
pub(crate) fn widgets(update: Option<&TreeUpdate>, cap: usize) -> Vec<HudWidget> {
    let Some(update) = update else { return Vec::new() };
    let Some(root) = update.tree.as_ref().map(|tree| tree.root) else { return Vec::new() };
    let nodes: BTreeMap<NodeId, &Node> = update.nodes.iter().map(|(id, node)| (*id, node)).collect();
    let mut found = Vec::new();
    let mut seen = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if found.len() >= cap || !seen.insert(id) {
            continue;
        }
        let Some(node) = nodes.get(&id) else { continue };
        if let Some(widget) = widget(node) {
            found.push(widget);
        }
        stack.extend(node.children().iter().rev());
    }
    found
}

fn widget(node: &Node) -> Option<HudWidget> {
    let role = WidgetRole::of(node.role())?;
    let label = node.label().or_else(|| node.value())?;
    let bounds = node.bounds()?;
    let rect = [bounds.x0 as f32, bounds.y0 as f32, bounds.x1 as f32, bounds.y1 as f32];
    Some(HudWidget { role, label: label.to_owned(), rect })
}
