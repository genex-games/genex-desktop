/**
 * How it works, beside the Harness chat's title: a short guide to how Harness learns from builds
 * and what the person decides, with a way into Settings → Harness.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { type JSX, useRef, useState } from "react";
import { Button } from "../ui/Button.tsx";
import { DialogSurface } from "../ui/dialog.tsx";
import { Icon } from "../ui/icons.tsx";
import { openSettings, SettingsOpenedFrom, SettingsSection } from "../settings-navigation.ts";
import { HARNESS_GUIDE_WORDS } from "../words.ts";

/** The guide's body: the four steps of the loop, two honest limits, and its two ways out. */
function HarnessGuideBody({ onSettings }: { onSettings: () => void }): JSX.Element {
  const last = HARNESS_GUIDE_WORDS.steps.length - 1;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <ol className="flex flex-col gap-3.5" data-harness-steps>
        {HARNESS_GUIDE_WORDS.steps.map((step, index) => (
          <li key={step.title} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3">
            <span
              aria-hidden
              className={`flex size-6 items-center justify-center rounded-full text-body-sm font-medium ${index === last ? "bg-green-tint text-green" : "bg-inset text-ink-2"}`}
            >
              {index === last ? <Icon name="check" size={12} strokeWidth={3} /> : index + 1}
            </span>
            <p className="text-ink-2">
              <span className="font-medium text-ink">{step.title}</span> {step.body}
            </p>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1.5 rounded-control bg-inset px-4 py-3 text-chat-sub text-ink-2">
        {HARNESS_GUIDE_WORDS.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <Dialog.Close asChild>
          <Button variant="ghost" className="-ms-3.5 text-chat-sub" onClick={onSettings}>
            {HARNESS_GUIDE_WORDS.settings}
          </Button>
        </Dialog.Close>
        <Dialog.Close asChild>
          <Button variant="default" className="text-chat-sub">
            {HARNESS_GUIDE_WORDS.done}
          </Button>
        </Dialog.Close>
      </div>
    </div>
  );
}

/** The header's How it works button, and the guide it opens. */
export function HarnessGuideButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        variant="secondary"
        className="no-drag ms-1 h-7 px-2.5 text-chat-sub"
        aria-haspopup="dialog"
        data-harness-guide-open=""
        onClick={() => setOpen(true)}
      >
        {HARNESS_GUIDE_WORDS.open}
      </Button>
      {open && (
        <DialogSurface
          title={HARNESS_GUIDE_WORDS.title}
          description={HARNESS_GUIDE_WORDS.lead}
          size="xl"
          testId="harness-guide"
          returnFocus={trigger}
          onDismiss={() => setOpen(false)}
        >
          <HarnessGuideBody
            onSettings={() => openSettings(SettingsSection.Harness, trigger.current, SettingsOpenedFrom.HarnessGuide)}
          />
        </DialogSurface>
      )}
    </>
  );
}
