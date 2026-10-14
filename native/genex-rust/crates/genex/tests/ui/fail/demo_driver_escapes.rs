// A demo's driver lives only for that demo: it cannot be stashed for an update hook to use later.
use genex::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Default)]
struct World;

fn main() {
    let mut game = Game::new(World);
    let slot: Rc<RefCell<Option<&mut DemoDriver<'static, World>>>> = Rc::default();
    let stash = Rc::clone(&slot);
    game.demo("escape", move |driver| {
        *stash.borrow_mut() = Some(driver);
        json!(null)
    });
    genex::install(game);
}
