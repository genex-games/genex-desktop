/** Native core palette vocabulary shared by Appearance and plugin theme validation. */
export const COLOR_ROLES = [
  "background",
  "foreground",
  "surface",
  "sidebar",
  "popover",
  "field",
  "hover",
  "muted",
  "border",
  "controlBorder",
  "accent",
  "success",
  "warning",
  "danger",
] as const;
/** Every theme supplies each core role in both schemes. */
export type CorePalette = Record<(typeof COLOR_ROLES)[number], string>;
