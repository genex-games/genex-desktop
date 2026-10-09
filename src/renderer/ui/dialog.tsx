/** Genex desktop dialog, adapted from the source Radix branch (no mobile drawer). */
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";
import { cn } from "./cn.ts";
import { prefersReducedMotion } from "./media-queries.ts";

/** How long the close animation plays before the dialog is dismissed (ms). */
const CLOSE_MS = 150;
const sizes = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-[30rem]", xl: "max-w-xl", "2xl": "max-w-2xl" };
export function DialogSurface({
  title,
  titleIcon,
  description,
  children,
  onDismiss,
  size = "md",
  testId,
  className = "",
  initialFocus,
  returnFocus,
  showClose = true,
  dismissible = true,
  headerHidden = false,
}: {
  title: string;
  /** A glyph after the title's words, such as Publish to the web's globe. */
  titleIcon?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  onDismiss: () => void;
  size?: keyof typeof sizes;
  testId?: string;
  className?: string;
  initialFocus?: React.RefObject<HTMLElement | null>;
  returnFocus?: React.RefObject<HTMLElement | null>;
  showClose?: boolean;
  dismissible?: boolean;
  headerHidden?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
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
    if (!dismissible) return;
    setOpen(false);
    timer.current = setTimeout(() => dismiss.current(), prefersReducedMotion() ? 0 : CLOSE_MS);
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[210] bg-black/45 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-(--duration-quick) motion-reduce:animate-none" />
        <Dialog.Content
          aria-label={title}
          data-slot="dialog-content"
          data-testid={testId}
          onOpenAutoFocus={(event) => {
            if (initialFocus?.current) {
              event.preventDefault();
              initialFocus.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus?.current ?? opener;
            if (target?.isConnected) target.focus();
          }}
          onEscapeKeyDown={(event) => {
            // An embedded terminal or a search with a query uses Escape itself: the dialog stays
            // open and lets the key through to it, which stopping it here would swallow.
            if (event.target instanceof Element && event.target.closest("[data-keeps-escape]")) {
              event.preventDefault();
              return;
            }
            event.stopPropagation();
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-[211] grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:duration-(--duration-fast) data-[state=closed]:duration-(--duration-quick) ease-(--ease-smooth-out) motion-reduce:animate-none",
            sizes[size],
            className,
          )}
        >
          <div className={headerHidden ? "sr-only" : cn("flex min-w-0 flex-col gap-1.5", showClose && "pr-8")}>
            <Dialog.Title
              className={cn("text-title font-medium text-foreground", titleIcon && "flex items-center gap-2")}
            >
              {title}
              {titleIcon}
            </Dialog.Title>
            <Dialog.Description className={description ? "text-dialog-body text-muted-foreground" : "sr-only"}>
              {description ?? title}
            </Dialog.Description>
          </div>
          {children}
          {showClose && (
            <Dialog.Close
              disabled={!dismissible}
              aria-label="Close"
              className="absolute top-3.5 right-3.5 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-control-text-hover"
            >
              <Icon name="close" />
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
