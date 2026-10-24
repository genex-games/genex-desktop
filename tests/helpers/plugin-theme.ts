/** Complete, readable theme offered by disposable customization plugins. */
export function pluginTheme(name = "Test theme") {
  const dark = {
    background: "#111111",
    surface: "#161616",
    sidebar: "#121212",
    popover: "#171717",
    field: "#181818",
    hover: "#222222",
    foreground: "#ffffff",
    muted: "#cccccc",
    border: "#888888",
    controlBorder: "#999999",
    accent: "#aabbff",
    success: "#88ddaa",
    warning: "#ffdd88",
    danger: "#ffaaaa",
  };
  const light = {
    background: "#ffffff",
    surface: "#fafafa",
    sidebar: "#f8f8f8",
    popover: "#ffffff",
    field: "#f5f5f5",
    hover: "#eeeeee",
    foreground: "#111111",
    muted: "#444444",
    border: "#777777",
    controlBorder: "#666666",
    accent: "#223399",
    success: "#145532",
    warning: "#664400",
    danger: "#992233",
  };
  return { name, light, dark, fonts: { uiFont: "system" as const }, geometry: { buttonRadius: 4, cardRadius: 12 } };
}
