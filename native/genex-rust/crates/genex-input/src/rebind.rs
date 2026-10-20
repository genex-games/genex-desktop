//! Rebinding: the player moves bindings between actions, never the map's shape. Every change is
//! checked against the whole map and applied all or nothing: a refused rebind leaves the map as
//! it was. A conflict names the action that already reads the input, so the controls panel can
//! offer to swap.

use crate::access::Access;
use crate::binding::{Binding, ChordInput, KeyCode};
use crate::error::{InputError, InputErrorCode};
use crate::id::ActionId;
use crate::map::{ActionMap, BINDINGS_PER_ACTION_MAX, check_binding, clash_in, conflict};

impl ActionMap {
    /// Put `binding` in `action`'s slot `slot` (one past the last slot appends). Refused when the
    /// action or slot does not exist, the binding cannot drive the action, the system keeps it,
    /// or another action of the same context reads it (`clash` names that action).
    pub fn rebind(&mut self, action: ActionId, slot: usize, binding: Binding) -> Result<(), InputError> {
        let (context_at, index) = self.locate(action)?;
        let context = &self.contexts[context_at];
        let def = &context.actions[index];
        if slot > def.bindings.len() || slot >= BINDINGS_PER_ACTION_MAX {
            let detail = format!("{} has no binding slot {slot}", action.name());
            return Err(InputError::new(InputErrorCode::ActionInvalid, detail));
        }
        check_binding(context, def, &binding)?;
        let others = |at: usize, other_slot: usize| (at, other_slot) != (index, slot);
        if let Some(holder) = clash_in(context, index, &binding, others) {
            return Err(conflict(action, &binding, holder));
        }
        let bindings = &mut self.contexts[context_at].actions[index].bindings;
        if slot == bindings.len() {
            bindings.push(binding);
        } else {
            bindings[slot] = binding;
        }
        Ok(())
    }

    /// Exchange two binding slots (of one action or two). Refused whole when either slot does not
    /// exist or the result does not validate.
    pub fn swap(&mut self, a: (ActionId, usize), b: (ActionId, usize)) -> Result<(), InputError> {
        let first = self.binding_at(a)?;
        let second = self.binding_at(b)?;
        let mut candidate = self.clone();
        candidate.set_binding(a, second);
        candidate.set_binding(b, first);
        candidate.validate()?;
        *self = candidate;
        Ok(())
    }

    /// [`ActionMap::rebind`], and on a conflict hand the clashing action the input this slot gave
    /// up (inside a composite binding, the clashing key is replaced): the controls panel's swap.
    /// Answers the action that gave the input up, if any.
    pub fn rebind_swap(
        &mut self,
        action: ActionId,
        slot: usize,
        binding: Binding,
    ) -> Result<Option<ActionId>, InputError> {
        let refused = match self.rebind(action, slot, binding) {
            Ok(()) => return Ok(None),
            Err(refused) => refused,
        };
        let Some(holder) = refused.clash.filter(|_| refused.code == InputErrorCode::BindingConflict) else {
            return Err(refused);
        };
        let given_up = self.bindings(action).get(slot).copied();
        let mut candidate = self.clone();
        let held = candidate.bindings(holder).to_vec();
        let mut changed = false;
        let mut kept = Vec::with_capacity(held.len());
        for old in held {
            if !old.clashes(&binding) && old != binding {
                kept.push(old);
                continue;
            }
            changed = true;
            match (handed_over(old, binding, given_up), given_up) {
                (Some(replacement), _) => kept.push(replacement),
                // Appending: an identical binding simply moves; a composite is never torn apart.
                (None, None) if old == binding => {}
                _ => return Err(refused),
            }
        }
        if !changed {
            return Err(refused);
        }
        if let Some(def) = candidate.action_mut(holder) {
            def.bindings = kept;
        }
        candidate.set_binding((action, slot), binding);
        candidate.validate()?;
        *self = candidate;
        Ok(Some(holder))
    }

    /// Back to the bindings the game declared and the default accessibility settings.
    pub fn reset(&mut self) {
        for context in &mut self.contexts {
            for def in &mut context.actions {
                def.bindings = def.defaults.clone();
            }
        }
        self.access = Access::default();
    }

    /// The context index and action index of `action`.
    fn locate(&self, action: ActionId) -> Result<(usize, usize), InputError> {
        for (context_at, context) in self.contexts.iter().enumerate() {
            if let Some(index) = context.actions.iter().position(|def| def.id == action) {
                return Ok((context_at, index));
            }
        }
        let detail = format!("{} is not an action of this map", action.name());
        Err(InputError::new(InputErrorCode::ActionInvalid, detail))
    }

    fn binding_at(&self, (action, slot): (ActionId, usize)) -> Result<Binding, InputError> {
        self.locate(action)?;
        self.bindings(action).get(slot).copied().ok_or_else(|| {
            let detail = format!("{} has no binding slot {slot}", action.name());
            InputError::new(InputErrorCode::ActionInvalid, detail)
        })
    }

    /// Replace or append (the slot was checked by the caller).
    fn set_binding(&mut self, (action, slot): (ActionId, usize), binding: Binding) {
        if let Some(def) = self.action_mut(action) {
            match def.bindings.get_mut(slot) {
                Some(held) => *held = binding,
                None => def.bindings.push(binding),
            }
        }
    }
}

/// What the holder's `old` binding becomes when it gives up `taken` and receives `given_up`: the
/// whole binding when they are equal, else the one key swapped inside a composite. `None` when
/// there is nothing to hand over or the shapes cannot exchange.
fn handed_over(old: Binding, taken: Binding, given_up: Option<Binding>) -> Option<Binding> {
    let given = given_up?;
    if old == taken {
        return Some(given);
    }
    let (Binding::Key(taken_key), Binding::Key(given_key)) = (taken, given) else { return None };
    let swap = |key: KeyCode| if key == taken_key { given_key } else { key };
    match old {
        Binding::Keys2 { negative, positive } => {
            Some(Binding::Keys2 { negative: swap(negative), positive: swap(positive) })
        }
        Binding::Keys4 { up, down, left, right } => {
            Some(Binding::Keys4 { up: swap(up), down: swap(down), left: swap(left), right: swap(right) })
        }
        Binding::Chord(members) => {
            let swapped = members.map(|member| match member {
                Some(ChordInput::Key(key)) => Some(ChordInput::Key(swap(key))),
                other => other,
            });
            Some(Binding::Chord(swapped))
        }
        _ => None,
    }
}
