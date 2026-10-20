// A game built without physics has no colliders to cut a navmesh from: `with_colliders` is not
// there to call (NAV-11; NAV-5 adds it behind the physics feature).
use genex::nav::{NavArea, NavInput};

fn main() {
    let world = genex::PhysicsWorld::default();
    let _input = NavInput::new().with_colliders(&world, |_| Some(NavArea::WALK));
}
