//! A web game names this crate `genex` (the host-written manifest's
//! `genex = { package = "genex-platform-web", … }`), so every public module path of the facade must
//! resolve here to the facade's own module: a shell module of the same name would shadow the
//! facade's through `pub use genex::*` and break the documented calls in Web Live and browser
//! exports (GE: `genex::saves::{SlotInfo, SlotOp, SlotState}` did not resolve). The row compiles
//! the facade's public modules through this crate and checks each is the facade's.

use std::any::TypeId;

/// Red first (GE fix): the documented saves and audio types resolve through the web facade and are
/// the facade's own.
#[test]
fn the_web_facade_resolves_every_public_facade_module_to_the_facades_own() {
    use genex_platform_web as web;
    let same = |web: TypeId, facade: TypeId| assert_eq!(web, facade);
    same(TypeId::of::<web::saves::SlotInfo>(), TypeId::of::<genex::saves::SlotInfo>());
    same(TypeId::of::<web::saves::SlotOp>(), TypeId::of::<genex::saves::SlotOp>());
    same(TypeId::of::<web::saves::SlotState>(), TypeId::of::<genex::saves::SlotState>());
    same(TypeId::of::<web::saves::SaveConfig>(), TypeId::of::<genex::saves::SaveConfig>());
    same(TypeId::of::<web::audio::PlayOpts>(), TypeId::of::<genex::audio::PlayOpts>());
    same(TypeId::of::<web::audio::PoolClass>(), TypeId::of::<genex::audio::PoolClass>());
    same(TypeId::of::<web::audio::AudioLevel>(), TypeId::of::<genex::audio::AudioLevel>());
    same(TypeId::of::<web::net::NetMode>(), TypeId::of::<genex::net::NetMode>());
    same(TypeId::of::<web::render::DeviceClass>(), TypeId::of::<genex::render::DeviceClass>());
    same(TypeId::of::<web::nav::NavAgent>(), TypeId::of::<genex::nav::NavAgent>());
    same(TypeId::of::<web::animation::AnimGraph>(), TypeId::of::<genex::animation::AnimGraph>());
    assert_eq!(web::audio::VOLATILE_AUDIO_KEY, genex::audio::VOLATILE_AUDIO_KEY);
}
