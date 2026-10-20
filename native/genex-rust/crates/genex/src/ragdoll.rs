//! Ragdolls on the facade: genex-anim's humanoid ragdoll, re-exported (physics only). A world
//! holds its ragdolls; `on_update` follows the animator and switches bodies (`go_limp`, `power`,
//! `recover`) before the runtime's physics step, and a draw reads `ragdoll.view(&sim.physics)`.

pub use genex_anim::humanoid::HumanoidBone;
pub use genex_anim::ragdoll::{
    RAGDOLL_GROUP, RAGDOLL_LIMP_DAMPING, RAGDOLL_MOTOR_DAMPING, RAGDOLL_MOTOR_STIFFNESS, Ragdoll, RagdollMode, RagdollPart, RagdollView,
};
pub use genex_anim::ragdoll_profile::{RAGDOLL_DEFAULT_MASS, RAGDOLL_PARTS_MAX, RagdollBody, RagdollJoint, RagdollProfile};
