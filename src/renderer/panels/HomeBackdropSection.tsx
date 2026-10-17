/**
 * Settings → Appearance → Home background: a preview of home drawn as it will be, over the same
 * controls home's Background button opens.
 */
import type { JSX } from "react";
import { useState } from "react";
import { BackdropControls, resetBackdrop } from "../home-backdrop/BackdropControls.tsx";
import { useGenerationModel } from "../home-backdrop/generation-model.ts";
import { BackdropPreview } from "../home-backdrop/HomeBackdrop.tsx";
import { BackdropSource } from "../home-backdrop/settings.ts";
import { useBackdrop, useBackdropPreview } from "../home-backdrop/store.ts";
import type { Rect, Size } from "../home-backdrop/view.ts";
import { Button } from "../ui/Button.tsx";

const MESSAGE = {
  heading: "Home background",
  reset: "Reset",
} as const;

/** Home's share of the window when it is not on screen to measure: the window less the sidebar. */
const HOME_SHARE_OF_WINDOW = 0.8;
/**
 * The window and home's place in it, in points: home measured when it is open beneath Settings,
 * else the window's share for it, at its right.
 */
function homeFrame(): { window: Size; home: Rect } {
  const frame = { width: window.innerWidth, height: window.innerHeight };
  const home = document.querySelector("[data-home]")?.getBoundingClientRect();
  if (home && home.width > 0 && home.height > 0)
    return { window: frame, home: { x: home.left, y: home.top, width: home.width, height: home.height } };
  const width = frame.width * HOME_SHARE_OF_WINDOW;
  return { window: frame, home: { x: frame.width - width, y: 0, width, height: frame.height } };
}

export function HomeBackdropSection(): JSX.Element {
  const settings = useBackdrop();
  const model = useGenerationModel();
  const off = settings.source === BackdropSource.Off;
  // The preview is home in small: its shape, and its part of the window's drawing.
  const [{ window: frame, home }] = useState(homeFrame);
  useBackdropPreview(!off);
  return (
    <section className="backdrop-settings" aria-label={MESSAGE.heading} data-home-backdrop-settings>
      <div className="appearance-theme-heading">
        <h3>{MESSAGE.heading}</h3>
        {!off && (
          <Button
            variant="ghost"
            className="ms-auto bg-foreground/[0.07] hover:bg-foreground/[0.12]"
            onClick={resetBackdrop}
          >
            {MESSAGE.reset}
          </Button>
        )}
      </div>
      {!off && (
        <div className="backdrop-preview" aria-hidden="true" style={{ aspectRatio: `${home.width} / ${home.height}` }}>
          <BackdropPreview settings={settings} window={frame} home={home} />
          <span className="backdrop-preview-composer" />
        </div>
      )}
      <BackdropControls settings={settings} model={model} />
    </section>
  );
}
