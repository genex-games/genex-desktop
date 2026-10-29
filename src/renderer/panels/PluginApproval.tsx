import { DialogSurface } from "../ui/dialog.tsx";
/**
 * The in-app review a confirmed plugin action shows first: the plugin's message and the images
 * its backend attached (its own evidence of what it is about to do). Continue is held until every
 * image has actually drawn, so nobody approves a picture they have not seen; the native dialog
 * in main is the second step and is not this component's.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { t } from "../../shared/i18n.ts";
import type { PluginReviewRequest } from "../plugin-actions.ts";
import { Button } from "../ui/Button.tsx";

export function PluginApproval({ review, onClose }: { review: PluginReviewRequest; onClose: () => void }): JSX.Element {
  const [loaded, setLoaded] = useState<string[]>([]);
  // A new request has its own images to wait for.
  useEffect(() => {
    setLoaded([]);
  }, [review]);
  const ready = review.images.every((i) => loaded.includes(i.label));
  return (
    <DialogSurface
      title={t("Plugin approval")}
      description={review.message}
      size="xl"
      onDismiss={() => {
        review.resolve(false);
        onClose();
      }}
    >
      {review.images.map((img) => (
        <figure key={img.label}>
          <img src={img.dataUrl} alt={img.label} onLoad={() => setLoaded((items) => [...items, img.label])} />
          <figcaption>{img.label}</figcaption>
        </figure>
      ))}
      <Button
        onClick={() => {
          review.resolve(false);
          onClose();
        }}
      >
        {t("Cancel")}
      </Button>
      <Button
        variant="default"
        disabled={!ready}
        onClick={() => {
          review.resolve(true);
          onClose();
        }}
      >
        {t("Continue to confirmation")}
      </Button>
    </DialogSurface>
  );
}
