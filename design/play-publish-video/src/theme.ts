/** The Play dashboard's dark palette and type, as the publish film draws them. */
export const C = {
  page: "#0e0d0f",
  sidebar: "#0b0b0d",
  sidebarLine: "#1d1e1f",
  dialog: "#19191b",
  dialogLine: "#29292b",
  cardLine: "#303030",
  ink: "#dee0e2",
  ink1: "#f5f5f5",
  ink2: "#cdcfd1",
  ink3: "#a8a9ac",
  ink4: "#9c9ca0",
  publish: "#3c44c4",
  cyber: "#1f8fff",
  cyberFill: "rgba(31, 143, 255, 0.24)",
  cyberInk: "#e8f3ff",
  cyberLine: "rgba(31, 143, 255, 0.55)",
  green: "#7cd194",
  chip: "rgba(14, 13, 15, 0.62)",
  /** The desk the app window sits on. */
  desk: "#05060a",
} as const;

export const SANS = '"Zalando Sans SemiExpanded", ui-sans-serif, system-ui, sans-serif';
export const MONO = '"Geist Mono", ui-monospace, monospace';

/** The film's frame: shown at about 224×118 CSS pixels on the card, so the camera zooms in to be read. */
export const W = 760;
export const H = 400;
export const FPS = 30;
/** 12.8 s, one loop. */
export const FRAMES = 384;

/** The app the film draws, in its own pixels: the camera moves over it. */
export const APP = { width: 960, height: 600, sidebar: 200, header: 48, radius: 14 } as const;
