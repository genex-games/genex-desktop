/**
 * Whether the native view is shown: the stage or an observer asks for it, no HTML modal occludes
 * it, and its slot is on the stage. A view whose slot the stage hides stays where it was last
 * shown (`placedBounds`) and is hidden here, so it never paints over what took its place.
 */
export function previewVisibility(apply: (visible: boolean) => void) {
  let requested = true;
  let occluded = false;
  let placed = true;
  const refresh = () => apply(requested && !occluded && placed);
  return {
    refresh,
    setVisible(visible: boolean) {
      requested = visible;
      refresh();
    },
    setOccluded(hidden: boolean) {
      occluded = hidden;
      refresh();
    },
    /** Whether the view's slot is on the stage (a rectangle with an area) or full screen. */
    setPlaced(onStage: boolean) {
      placed = onStage;
      refresh();
    },
  };
}
