/**
 * The app's checkbox: a native box (keyboard, label clicks and screen readers as the platform gives
 * them) drawn small with rounded corners, filled with the accent and a white mark when ticked, a
 * dash when only some of what it stands for are (`indeterminate`). Styled by `.check` in theme.css.
 */
import type { ComponentPropsWithoutRef, JSX } from "react";
import { useEffect, useRef } from "react";
import { cn } from "./cn.ts";

type CheckboxProps = Omit<ComponentPropsWithoutRef<"input">, "type"> & {
  /** Some, not all, of what this box stands for are ticked: it shows a dash. */
  indeterminate?: boolean;
};

/** A small rounded checkbox; every other prop goes to the native input. */
export function Checkbox({ indeterminate = false, className, ...props }: CheckboxProps): JSX.Element {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The DOM's own mixed state: React has no attribute for it.
    if (box.current) box.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={box} type="checkbox" className={cn("check", className)} {...props} />;
}
