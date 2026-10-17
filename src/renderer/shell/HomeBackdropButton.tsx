/**
 * Home's Background button, top right: the background's settings in a panel over home, so each
 * change is seen on home itself, undimmed, as it is made. Until the panel is first opened, a light
 * sweeps across the button's picture now and then, so it is found.
 */
import type { JSX } from "react";
import { useState } from "react";
import { BackdropControls, resetBackdrop } from "../home-backdrop/BackdropControls.tsx";
import { useGenerationModel } from "../home-backdrop/generation-model.ts";
import { BackdropSource } from "../home-backdrop/settings.ts";
import { backdropButtonFound, markBackdropButtonFound, useBackdrop } from "../home-backdrop/store.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";

const MESSAGE = {
  button: "Background",
  heading: "Background",
  reset: "Reset",
} as const;

/** `picked` is the model home's composer shows: the one Make your own writes with. */
export function HomeBackdropButton({ picked }: { picked: string | null }): JSX.Element {
  const settings = useBackdrop();
  const model = useGenerationModel(picked);
  const [found, setFound] = useState(backdropButtonFound);
  const opened = (open: boolean): void => {
    if (!open || found) return;
    markBackdropButtonFound();
    setFound(true);
  };
  return (
    <Popover onOpenChange={opened}>
      <PopoverTrigger
        render={<button type="button" />}
        aria-label={MESSAGE.button}
        data-home-backdrop-button
        data-glint={found ? undefined : true}
        className="home-backdrop-button"
      >
        <Icon name="image" size={16} />
        {!found && (
          <span className="home-backdrop-glint" aria-hidden="true">
            <Icon name="image" size={16} />
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="backdrop-panel" data-home-backdrop-panel>
        <div className="backdrop-panel-heading">
          <h2>{MESSAGE.heading}</h2>
          {settings.source !== BackdropSource.Off && (
            <Button variant="ghost" className="bg-foreground/[0.07] hover:bg-foreground/[0.12]" onClick={resetBackdrop}>
              {MESSAGE.reset}
            </Button>
          )}
        </div>
        <BackdropControls settings={settings} model={model} />
      </PopoverContent>
    </Popover>
  );
}
