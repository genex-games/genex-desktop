//! Build-time nav bakes (game systems NAV-14): `game.nav_bake(name, |gfx| NavInput)` registers a
//! navmesh the dev flavour bakes offline. After a dev build the studio's bake step sends the
//! headless session `bakeAssets {kind: nav, name}` for every bake its receipt advertises; the
//! session runs the input hook (reading assets as a reset does), bakes it with the game's
//! `game.navigation` config and the studio writes the `.navmesh` bytes into the run's
//! `state/bakes/nav/<name>`. A game loads them with `NavMesh::from_bytes_for`, which takes them
//! as they are when they were baked from the same input and config, and bakes afresh otherwise
//! (`nav-bake-stale`), so a stale bake is never wrong, only slower. An export never links the
//! studio and answers `bakeAssets` `unknown-op`.

use crate::game::Game;
use crate::gfx::Gfx;
use crate::nav::{NavError, NavInput, NavMesh};
use crate::runtime::InstallErrorCode;

/// The longest bake name (`isBakeName` in `shared/native-contract.ts`).
pub(crate) const NAV_BAKE_NAME_MAX: usize = 64;

/// The input hook a bake runs.
type InputHook = Box<dyn Fn(&Gfx) -> NavInput>;

/// One registered bake.
struct Bake {
    name: String,
    input: InputHook,
}

/// `game.nav_bake` registrations, in registration order (the `Game` field `nav_bakes`).
#[derive(Default)]
pub(crate) struct NavBakes {
    list: Vec<Bake>,
}

impl std::fmt::Debug for NavBakes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.list.iter().map(|bake| &bake.name)).finish()
    }
}

impl NavBakes {
    /// Whether the game registered no bake.
    pub(crate) fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// The registered names, in registration order (the receipt's `bakes`).
    pub(crate) fn names(&self) -> Vec<String> {
        self.list.iter().map(|bake| bake.name.clone()).collect()
    }
}

impl<W: Default + 'static> Game<W> {
    /// A navmesh bake named `name` (lowercase letters, digits, `-` and `_`, at most 64, starting
    /// with a letter or digit): `input` builds what it is cut from
    /// (it may read assets, as a reset does). The dev build bakes it with `game.navigation`'s
    /// config; load the result with `NavMesh::from_bytes_for`. `install` refuses a name that is not
    /// a bake name, or one registered twice (`invalid-name`), and any bake in a game built with
    /// `[nav] enabled = false` (`nav-disabled`).
    pub fn nav_bake(&mut self, name: &str, input: impl Fn(&Gfx) -> NavInput + 'static) -> &mut Self {
        self.nav_bakes.list.push(Bake { name: name.to_owned(), input: Box::new(input) });
        self
    }
}

/// Whether `name` is a bake name: one path segment of lowercase ASCII letters, digits, `-` and `_`
/// starting with a letter or digit, at most [`NAV_BAKE_NAME_MAX`].
fn is_bake_name(name: &str) -> bool {
    let allowed = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_';
    let leads = name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    leads && name.len() <= NAV_BAKE_NAME_MAX && name.chars().all(allowed)
}

/// Why `install` refuses the game's nav bakes: a name that is not a bake name, or a repeated one.
pub(crate) fn check<W>(game: &Game<W>) -> Result<(), (InstallErrorCode, String)> {
    let mut seen = std::collections::BTreeSet::new();
    for bake in &game.nav_bakes.list {
        if !is_bake_name(&bake.name) {
            return Err((InstallErrorCode::InvalidName, format!("nav bake {:?}", bake.name)));
        }
        if !seen.insert(bake.name.as_str()) {
            return Err((InstallErrorCode::InvalidName, format!("nav bake {:?} is registered twice", bake.name)));
        }
    }
    Ok(())
}

/// Run the bake `name`: its input built through `gfx` as a reset builds one (asset reads allowed),
/// baked with the game's `game.navigation` config, as `.navmesh` bytes. None for a name the game
/// did not register; refused `nav-config-invalid` without `game.navigation`, and as
/// `NavMesh::bake` refuses.
pub(crate) fn bake<W>(game: &Game<W>, gfx: &Gfx, name: &str) -> Option<Result<Vec<u8>, NavError>> {
    if !crate::nav::NAV_BUILT {
        // `install` refused every bake of a build without navigation: nothing to run.
        return None;
    }
    let bake = game.nav_bakes.list.iter().find(|bake| bake.name == name)?;
    let Some(config) = game.nav_config() else {
        return Some(Err(NavError::config_invalid("a nav bake needs game.navigation's config")));
    };
    gfx.assets().set_at_reset(true);
    let input = (bake.input)(gfx);
    gfx.assets().set_at_reset(false);
    Some(NavMesh::bake(&input, config).map(|mesh| mesh.to_bytes()))
}
