//! genex-ui: gameplay UI for genex games, below the facade. Menus, bars, lists and dialogs drawn in
//! the HUD with keyed state and focus a controller can move, text looked up in Fluent catalogs for
//! the player's locale, and the settings menu over a typed schema the runtime stores.
//!
//! Every planned module is declared now so each work package fills one body (G6 gameplay UI,
//! UIS-0); a module that names its work package is still a stub.

pub mod keyed;
pub mod focus;
pub mod nav;
pub mod kit {
    //! The widget kit: bars, dialogs, grids, images, lists, menus, nine-slice frames and toasts.
    pub mod bar;
    pub mod dialog;
    pub mod grid;
    pub mod image;
    pub mod list;
    pub mod menu;
    pub mod nine_slice;
    pub mod toast;
}
pub mod text {
    //! Localized text: Fluent catalogs, arguments, the locale and pseudo-localization.
    pub mod args;
    pub mod catalog;
    pub mod locale;
    pub mod pseudo;
}
pub mod settings {
    //! The settings menu: the typed schema, its store, presets, UI scale and the menu itself.
    pub mod schema;
    pub mod store;
    pub mod presets;
    pub mod scale;
    pub mod menu;
}
