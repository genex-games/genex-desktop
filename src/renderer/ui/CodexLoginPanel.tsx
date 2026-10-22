import { DialogSurface } from "./dialog.tsx";
import { useEffect, useRef, useState, type JSX } from "react";
import { isCodexLoginActive, type CodexLoginState } from "../../shared/codex-login.ts";
import { Button } from "./Button.tsx";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import { useAsyncEffect } from "../use-async-effect.ts";

/** What the dialog says under its title, for where the sign-in stands. */
function loginDescription(state: CodexLoginState): string {
  if (state.phase === "connected") return t("Your ChatGPT subscription is ready to use in the studio.");
  if (state.phase === "verifying") return t("Checking your ChatGPT connection…");
  if (state.phase === "cancelled") return t("Sign-in was cancelled. You can try again whenever you're ready.");
  if (state.method === "device")
    return t(
      "Open the sign-in page and enter the code below. Device login may need to be enabled in your ChatGPT security settings.",
    );
  return t("Finish signing in with ChatGPT in your browser. Codex handles your credentials on this Mac.");
}

/** The closing button: Done once connected, Cancel while signing in, Close otherwise. */
function dismissLabel(state: CodexLoginState): string {
  if (state.phase === "connected") return t("Done");
  return isCodexLoginActive(state) ? t("Cancel sign-in") : t("Close");
}

/** Main's Codex sign-in state, newest revision first; a late older answer never wins. */
function useCodexLoginState(): CodexLoginState | null {
  const [state, setState] = useState<CodexLoginState | null>(null);
  useAsyncEffect((alive) => {
    const update = (next: CodexLoginState): void => {
      if (alive()) setState((old) => (!old || next.revision >= old.revision ? next : old));
    };
    const unsubscribe = window.studio.onCodexLogin(update);
    void window.studio
      .codexLoginState()
      .then(update)
      .catch(() => {});
    return unsubscribe;
  }, []);
  return state;
}

export function CodexLoginPanel(): JSX.Element | null {
  const state = useCodexLoginState();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    setError(null);
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [state?.revision]);

  if (!state?.visible) return null;
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const connected = state.phase === "connected";
  const settled = state.phase === "failed" || state.phase === "cancelled";
  const offersDeviceCode = !connected && state.phase !== "verifying" && state.method !== "device";
  const shownError = error || state.error;
  return (
    <DialogSurface
      title={connected ? t("ChatGPT connected") : t("Connect ChatGPT")}
      description={<span aria-live="polite">{loginDescription(state)}</span>}
      size="xl"
      testId="codex-login-panel"
      onDismiss={() => void window.studio.codexLoginDismiss().catch(() => {})}
    >
      <div>
        <div className="mt-4 overflow-hidden rounded-control bg-inset shadow-hairline">
          <div className="border-b border-line px-3 py-2 font-mono text-micro text-ink-3">
            $ codex login{state.method === "device" ? " --device-auth" : ""}
          </div>
          <pre
            ref={log}
            aria-label={t("Codex sign-in output")}
            tabIndex={0}
            className="max-h-[220px] min-h-[100px] overflow-auto px-3 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-ink-2"
          >
            {state.lines.join("\n")}
          </pre>
        </div>
        {state.deviceCode && (
          <div className="mt-3 rounded-control bg-accent-tint p-3 text-center">
            <span className="text-micro text-ink-2">{t("Your one-time code")}</span>
            <div className="mt-1 select-all font-mono text-[23px] tracking-widest text-accent-ink">
              {state.deviceCode}
            </div>
          </div>
        )}
        {shownError && (
          <p role="alert" className="mt-3 text-xs leading-relaxed text-orange">
            {shownError}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {state.hasBrowserUrl && (
            <Button
              variant="default"
              disabled={busy}
              onClick={() => void act(() => window.studio.codexLoginOpenBrowser())}
            >
              {t("Open sign-in page")}
            </Button>
          )}
          {settled && (
            <Button
              variant="default"
              disabled={busy}
              onClick={() => void act(() => window.studio.codexLoginRetry("browser"))}
            >
              {t("Try again")}
            </Button>
          )}
          {offersDeviceCode && (
            <Button disabled={busy} onClick={() => void act(() => window.studio.codexLoginRetry("device"))}>
              {t("Use a device code")}
            </Button>
          )}
          <span className="flex-1" />
          <Button
            variant={connected ? "default" : "secondary"}
            disabled={busy}
            onClick={() => void act(() => window.studio.codexLoginDismiss())}
          >
            {dismissLabel(state)}
          </Button>
        </div>
        <p className="mt-3 text-micro text-ink-3">{t("Uses your existing Codex allowance. No API key required.")}</p>
      </div>
    </DialogSurface>
  );
}
