//! The action map: contexts of actions with their bindings, conditions and modifiers, plus the
//! player's accessibility settings. A game builds it once (`ActionMap::new().context(..)`); the
//! player's rebinding changes only bindings and settings, never its shape.
//!
//! Contexts follow bevy_enhanced_input's model (priority, consume by default, pass-through):
//! a higher-priority context that is on takes the inputs its actions read, so a lower one does
//! not see them, unless it passes them through. Semantics ported (no code copied) from
//! <https://github.com/simgine/bevy_enhanced_input>, tag v0.27.0, commit
//! d7be47fd91184c1bb1ff1f5a40d073d36a18547e, MIT (dual MIT OR Apache-2.0, MIT
//! side taken).

use crate::access::{Access, HoldMode};
use crate::binding::{ActionKind, Binding};
use crate::condition::Condition;
use crate::error::{InputError, InputErrorCode};
use crate::id::{ActionId, ContextId};
use crate::modifier::Modifier;
use crate::ui;

/// The most actions one map declares, the built-in `ui` actions included.
pub const ACTIONS_MAX: usize = 64;
/// The most contexts one map declares, the built-in `ui` context included.
pub const CONTEXTS_MAX: usize = 8;
/// The most bindings one action holds.
pub const BINDINGS_PER_ACTION_MAX: usize = 8;

/// One action as the map holds it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ActionDef {
    pub(crate) id: ActionId,
    pub(crate) kind: ActionKind,
    pub(crate) bindings: Vec<Binding>,
    /// What the game declared, for reset and for the bindings file's missing rows.
    pub(crate) defaults: Vec<Binding>,
    pub(crate) conditions: Vec<Condition>,
    pub(crate) modifiers: Vec<Modifier>,
}

/// A set of actions turned on and off together, with a priority (higher reads first).
#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub(crate) id: ContextId,
    pub(crate) priority: i8,
    pub(crate) actions: Vec<ActionDef>,
    pub(crate) pass_through: bool,
    pub(crate) starts_off: bool,
    /// The `ui` context reads confirm and back by the pad family's convention.
    pub(crate) family_confirm: bool,
    /// The first builder call that had no action to apply to.
    pub(crate) misuse: Option<InputError>,
}

impl Context {
    /// An empty context. Higher `priority` reads first; equal priorities read in declaration order.
    pub fn new(id: ContextId, priority: i8) -> Context {
        Context {
            id,
            priority,
            actions: Vec::new(),
            pass_through: false,
            starts_off: false,
            family_confirm: false,
            misuse: None,
        }
    }

    /// Add a button action.
    pub fn button(self, id: ActionId, bindings: &[Binding]) -> Context {
        self.action(id, ActionKind::Button, bindings)
    }

    /// Add a 1D axis action.
    pub fn axis1(self, id: ActionId, bindings: &[Binding]) -> Context {
        self.action(id, ActionKind::Axis1, bindings)
    }

    /// Add a 2D axis action.
    pub fn axis2(self, id: ActionId, bindings: &[Binding]) -> Context {
        self.action(id, ActionKind::Axis2, bindings)
    }

    /// Add a condition to the last action added.
    pub fn when(mut self, condition: Condition) -> Context {
        match self.actions.last_mut() {
            Some(action) => action.conditions.push(condition),
            None => self.misused("when() before any action"),
        }
        self
    }

    /// Add a modifier to the last action added.
    pub fn modify(mut self, modifier: Modifier) -> Context {
        match self.actions.last_mut() {
            Some(action) => action.modifiers.push(modifier),
            None => self.misused("modify() before any action"),
        }
        self
    }

    /// Let lower contexts read the inputs this one reads too.
    pub fn pass_through(self) -> Context {
        Context { pass_through: true, ..self }
    }

    /// Start turned off (turn it on with the action state's `enable`).
    pub fn starts_off(self) -> Context {
        Context { starts_off: true, ..self }
    }

    /// Its id.
    pub fn id(&self) -> ContextId {
        self.id
    }

    /// Its priority.
    pub fn priority(&self) -> i8 {
        self.priority
    }

    fn action(mut self, id: ActionId, kind: ActionKind, bindings: &[Binding]) -> Context {
        let bindings = bindings.to_vec();
        self.actions.push(ActionDef {
            id,
            kind,
            defaults: bindings.clone(),
            bindings,
            conditions: Vec::new(),
            modifiers: Vec::new(),
        });
        self
    }

    fn misused(&mut self, what: &str) {
        if self.misuse.is_none() {
            self.misuse = Some(InputError::new(InputErrorCode::ActionInvalid, what.to_owned()));
        }
    }
}

/// Every context and action a game reads, plus the player's settings.
#[derive(Clone, Debug, PartialEq)]
pub struct ActionMap {
    pub(crate) contexts: Vec<Context>,
    pub(crate) access: Access,
}

impl Default for ActionMap {
    fn default() -> Self {
        ActionMap::new()
    }
}

impl ActionMap {
    /// A map holding only the built-in `ui` context (off until a menu turns it on, priority 100).
    pub fn new() -> ActionMap {
        ActionMap { contexts: vec![ui::context()], access: Access::default() }
    }

    /// Add a context.
    pub fn context(mut self, context: Context) -> ActionMap {
        self.contexts.push(context);
        self
    }

    /// Check names, caps, binding kinds, reserved bindings, clashes and settings.
    pub fn validate(&self) -> Result<(), InputError> {
        self.validate_caps()?;
        let mut contexts: Vec<ContextId> = Vec::new();
        let mut actions: Vec<ActionId> = Vec::new();
        for context in &self.contexts {
            if let Some(misuse) = &context.misuse {
                return Err(misuse.clone());
            }
            if !context.id.is_valid() {
                return Err(invalid_name("context", context.id.name()));
            }
            if contexts.contains(&context.id) {
                let detail = format!("context {} is declared twice", context.id.name());
                return Err(InputError::new(InputErrorCode::ContextDuplicate, detail));
            }
            contexts.push(context.id);
            for action in &context.actions {
                if !action.id.is_valid() {
                    return Err(invalid_name("action", action.id.name()));
                }
                if actions.contains(&action.id) {
                    let detail = format!("action {} is declared twice", action.id.name());
                    return Err(InputError::new(InputErrorCode::ActionDuplicate, detail));
                }
                actions.push(action.id);
            }
        }
        for context in &self.contexts {
            for action in &context.actions {
                self.validate_action(context, action)?;
            }
            validate_clashes(context)?;
        }
        self.validate_access(&self.access)
    }

    /// The bindings `action` holds now (empty for an action the map does not declare).
    pub fn bindings(&self, action: ActionId) -> &[Binding] {
        self.action(action).map_or(&[], |def| def.bindings.as_slice())
    }

    /// The bindings the game declared for `action`.
    pub fn default_bindings(&self, action: ActionId) -> &[Binding] {
        self.action(action).map_or(&[], |def| def.defaults.as_slice())
    }

    /// The kind of `action`, when the map declares it.
    pub fn kind(&self, action: ActionId) -> Option<ActionKind> {
        self.action(action).map(|def| def.kind)
    }

    /// The context `action` belongs to.
    pub fn context_of(&self, action: ActionId) -> Option<ContextId> {
        self.contexts.iter().find(|context| context.actions.iter().any(|def| def.id == action)).map(|c| c.id)
    }

    /// Every context, in declaration order.
    pub fn contexts(&self) -> impl Iterator<Item = ContextId> + '_ {
        self.contexts.iter().map(|context| context.id)
    }

    /// Every action and its kind, in declaration order.
    pub fn actions(&self) -> impl Iterator<Item = (ActionId, ActionKind)> + '_ {
        self.slots().map(|def| (def.id, def.kind))
    }

    /// The player's accessibility settings.
    pub fn access(&self) -> &Access {
        &self.access
    }

    /// Replace the accessibility settings (refused whole when a value is out of range).
    pub fn set_access(&mut self, access: Access) -> Result<(), InputError> {
        self.validate_access(&access)?;
        self.access = access;
        Ok(())
    }

    /// Every action in declaration order (the action state's slot order).
    pub(crate) fn slots(&self) -> impl Iterator<Item = &ActionDef> {
        self.contexts.iter().flat_map(|context| context.actions.iter())
    }

    /// Context indices, highest priority first, ties in declaration order.
    pub(crate) fn priority_order(&self) -> Vec<usize> {
        let mut order: Vec<usize> = (0..self.contexts.len()).collect();
        // Stable, so equal priorities keep declaration order.
        order.sort_by_key(|&at| std::cmp::Reverse(self.contexts[at].priority));
        order
    }

    pub(crate) fn action(&self, action: ActionId) -> Option<&ActionDef> {
        self.slots().find(|def| def.id == action)
    }

    pub(crate) fn action_mut(&mut self, action: ActionId) -> Option<&mut ActionDef> {
        self.contexts.iter_mut().flat_map(|context| context.actions.iter_mut()).find(|def| def.id == action)
    }

    fn validate_caps(&self) -> Result<(), InputError> {
        let too_large = |detail: String| Err(InputError::new(InputErrorCode::MapTooLarge, detail));
        if self.contexts.len() > CONTEXTS_MAX {
            return too_large(format!("{} contexts (at most {CONTEXTS_MAX})", self.contexts.len()));
        }
        let count = self.slots().count();
        if count > ACTIONS_MAX {
            return too_large(format!("{count} actions (at most {ACTIONS_MAX})"));
        }
        match self.slots().find(|def| def.bindings.len() > BINDINGS_PER_ACTION_MAX) {
            Some(def) => too_large(format!("{} has more than {BINDINGS_PER_ACTION_MAX} bindings", def.id.name())),
            None => Ok(()),
        }
    }

    fn validate_action(&self, context: &Context, action: &ActionDef) -> Result<(), InputError> {
        for binding in &action.bindings {
            check_binding(context, action, binding)?;
        }
        if let Some(bad) = action.modifiers.iter().find(|modifier| !modifier.is_valid()) {
            let detail = format!("{}: modifier {bad:?} has parameters that cannot work", action.id.name());
            return Err(InputError::new(InputErrorCode::ActionInvalid, detail));
        }
        for blocker in action.conditions.iter().filter_map(|condition| condition.blocker()) {
            if blocker == action.id || self.action(blocker).is_none() {
                let detail =
                    format!("{} is blocked by {}, which is not another action", action.id.name(), blocker.name());
                return Err(InputError::new(InputErrorCode::ActionInvalid, detail));
            }
        }
        Ok(())
    }

    fn validate_access(&self, access: &Access) -> Result<(), InputError> {
        access.validate()?;
        for (action, mode) in &access.hold_mode {
            let button = self.kind(*action) == Some(ActionKind::Button);
            if *mode == HoldMode::Toggle && !button {
                let detail = format!("toggle mode needs a button action, not {}", action.name());
                return Err(InputError::new(InputErrorCode::AccessInvalid, detail));
            }
        }
        Ok(())
    }
}

fn invalid_name(what: &str, name: &str) -> InputError {
    let detail = format!("{what} name {name:?} is not 1-32 bytes of a-z, 0-9 and _");
    InputError::new(InputErrorCode::ActionInvalid, detail)
}

/// One binding's own checks: kind, reserved inputs, chord shape and touch control name.
pub(crate) fn check_binding(context: &Context, action: &ActionDef, binding: &Binding) -> Result<(), InputError> {
    let name = action.id.name();
    if !binding.accepts(action.kind) {
        let detail = format!("{} cannot drive {name}, a {} action", binding.wire(), action.kind.as_str());
        return Err(InputError::new(InputErrorCode::BindingMismatch, detail));
    }
    if let Binding::Chord(_) = binding {
        let inputs = binding.chord_inputs();
        Binding::chord(&inputs)?;
    }
    if let Binding::Touch(control) = binding
        && !control.is_valid()
    {
        return Err(invalid_name("touch control", control.name()));
    }
    if binding.is_reserved() && context.id != ui::UI {
        let detail = format!("{} stays the system menu's; {name} cannot take it", binding.wire());
        return Err(InputError::new(InputErrorCode::BindingReserved, detail));
    }
    Ok(())
}

/// No two actions of one context read the same input, and no action holds one binding twice.
fn validate_clashes(context: &Context) -> Result<(), InputError> {
    for (at, action) in context.actions.iter().enumerate() {
        for (slot, binding) in action.bindings.iter().enumerate() {
            let earlier = |other: usize, other_slot: usize| (other, other_slot) < (at, slot);
            if let Some(holder) = clash_in(context, at, binding, earlier) {
                return Err(conflict(action.id, binding, holder));
            }
        }
    }
    Ok(())
}

/// The refusal for `action` taking `binding` that `holder` already reads.
pub(crate) fn conflict(action: ActionId, binding: &Binding, holder: ActionId) -> InputError {
    let detail = format!("{} reads {}, which {} already reads", action.name(), binding.wire(), holder.name());
    InputError::new(InputErrorCode::BindingConflict, detail).with_clash(holder)
}

/// The first action of `context`, among the (action index, slot) pairs `consider` accepts, whose
/// binding clashes with `binding` held by the action at index `owner`. Within one action only an
/// identical binding clashes.
pub(crate) fn clash_in(
    context: &Context,
    owner: usize,
    binding: &Binding,
    consider: impl Fn(usize, usize) -> bool,
) -> Option<ActionId> {
    for (at, other) in context.actions.iter().enumerate() {
        for (slot, held) in other.bindings.iter().enumerate() {
            if !consider(at, slot) {
                continue;
            }
            let clash = if at == owner { held == binding } else { held.clashes(binding) };
            if clash {
                return Some(other.id);
            }
        }
    }
    None
}
