/**
 * The last line of the renderer: an exception thrown while rendering would otherwise unmount the
 * whole app and leave an empty window while runs carry on unseen. This shows what happened with
 * Reload and Copy error instead. React reports the caught error to the console, which main writes
 * to `studio.log`.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../shared/i18n.ts";
import { Button } from "./ui/Button.tsx";
import { dismissAppLoader } from "./app-loader.ts";
import { errorReport } from "./error-report.ts";

interface State {
  error: unknown;
  componentStack: string | null;
  copied: boolean | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, componentStack: null, copied: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error("Unknown error") };
  }

  override componentDidCatch(_error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // A crash before the first screen must not stay hidden behind the startup loader.
    dismissAppLoader();
    // The native game view sits above the page; it must not cover this screen.
    void window.studio?.previewBounds({ x: 0, y: 0, width: 0, height: 0, watching: false }).catch(() => {});
  }

  #copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(errorReport(this.state.error, this.state.componentStack));
      this.setState({ copied: true });
    } catch {
      this.setState({ copied: false });
    }
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const { copied } = this.state;
    return (
      <div
        data-error-boundary
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 bg-base p-6 text-center"
      >
        <p className="text-ink">{t("Studio hit a problem.")}</p>
        <p className="text-ink-3">{t("Your games and any running build are safe. Reload to continue.")}</p>
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>{t("Reload")}</Button>
          <Button variant="secondary" onClick={() => void this.#copy()}>
            {t("Copy error")}
          </Button>
        </div>
        {copied !== null && (
          <p role="status" className="text-ink-3">
            {copied ? t("Error copied.") : t("Could not copy the error.")}
          </p>
        )}
      </div>
    );
  }
}
