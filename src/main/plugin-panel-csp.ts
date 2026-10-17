/**
 * A plugin panel is inert HTML: inline script and style only, no network, no navigation. Fonts load
 * only as data the panel carries, which is how a panel gets Genex's type (`inlinePanelFonts`).
 */
export const PLUGIN_PANEL_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
