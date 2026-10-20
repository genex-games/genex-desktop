//! Names: actions, contexts and touch controls are `&'static str` ids a game declares once as
//! consts (`const JUMP: ActionId = ActionId::new("jump")`). Their spelling is checked when the
//! map is validated, not when the const is built, so a bad name is a refusal and never a panic.

/// The longest action, context or control name, in bytes.
pub const NAME_MAX: usize = 32;

/// Whether `name` is a legal id: 1 to `NAME_MAX` bytes of lowercase ASCII letters, digits and `_`.
pub fn name_ok(name: &str) -> bool {
    let legal = |byte: u8| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_';
    !name.is_empty() && name.len() <= NAME_MAX && name.bytes().all(legal)
}

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(&'static str);

        impl $name {
            /// The id named `name` (validated with the map, see [`name_ok`]).
            pub const fn new(name: &'static str) -> $name {
                $name(name)
            }

            /// Its name.
            pub const fn name(self) -> &'static str {
                self.0
            }

            /// Whether its name is legal.
            pub fn is_valid(self) -> bool {
                name_ok(self.0)
            }
        }
    };
}

id_type!(
    /// An action a game reads (`jump`, `move`): a button, a 1D axis or a 2D axis.
    ActionId
);
id_type!(
    /// A context: a set of actions turned on and off together (`play`, `vehicle`, `ui`).
    ContextId
);
id_type!(
    /// An on-screen touch control (`jump`, `stick`), read through `Binding::Touch`.
    ControlId
);
