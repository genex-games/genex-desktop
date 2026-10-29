/**
 * A file opened over the whole window: the page's own colour behind it, nothing around it but the
 * caller's actions and Close in the top corner. A click on the backdrop closes it, as Escape does.
 */
import * as Dialog from "@radix-ui/react-dialog";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { Icon } from "./icons.tsx";
import { prefersReducedMotion } from "./media-queries.ts";

/** How long the closing fade plays before the lightbox is dismissed (ms). */
const CLOSE_MS = 150;

export function Lightbox({
  title,
  actions,
  children,
  onDismiss,
  testId,
}: {
  /** The file's name, for assistive technology only: nothing names it on screen. */
  title: string;
  /** Buttons beside Close, in the top corner. */
  actions?: ReactNode;
  children: ReactNode;
  onDismiss: () => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(true);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const content = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function close() {
    setOpen(false);
    timer.current = setTimeout(() => dismiss.current(), prefersReducedMotion() ? 0 : CLOSE_MS);
  }
  /** A click on the backdrop itself, not on the file or a control, closes the lightbox. */
  const onBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) close();
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="lightbox-scrim fixed inset-0 z-[210] duration-(--duration-quick) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none" />
        <Dialog.Content
          ref={content}
          aria-label={title}
          data-testid={testId}
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener?.isConnected) opener.focus();
          }}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onClick={onBackdrop}
          className="no-drag fixed inset-0 z-[211] grid place-items-center outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:duration-(--duration-fast) data-[state=closed]:duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:animate-none"
        >
          <div className="sr-only">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description>{title}</Dialog.Description>
          </div>
          {children}
          <div className="absolute top-5 right-5 z-10 flex gap-2">
            {actions}
            <Dialog.Close aria-label={t("Close")} title={t("Close")} data-icon-only className="lightbox-button">
              <Icon name="close" size={18} />
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
