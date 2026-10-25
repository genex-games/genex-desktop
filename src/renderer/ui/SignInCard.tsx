import { useEffect, useState, type JSX } from "react";
import { Button } from "./Button.tsx";
import { problemWords } from "../words.ts";
import type { ClaudeLoginState } from "../../shared/claude-login.ts";
import { t } from "../../shared/i18n.ts";
import { EngineId } from "../../shared/providers.ts";
import { signInVendor, useClaudeLogin } from "../subscription-auth.ts";
import { useCliInstall } from "../cli-install.ts";
import { SHOW_TERMINAL_EVENT } from "../panels/terminal-events.ts";

const CODE_FIELD =
  "h-7 w-44 rounded-control bg-field px-2.5 text-xs text-ink shadow-hairline outline-none placeholder:text-ink-3";

type Vendor = ReturnType<typeof signInVendor>;

/**
 * What the Claude sign-in is doing right now, straight from main. Claude's flow can ask for the
 * code the browser shows, which is the one step this card has to be able to take.
 */
/** What asks for the code box while Claude Code waits beside the browser sign-in. */
export const CODE_FALLBACK_LABEL = t("Browser showed a code?");

/**
 * Whether the person asked for the code box. Claude Code offers one beside its browser sign-in,
 * which nearly always finishes on its own, so the box stays hidden until asked; leaving the code
 * step forgets the choice.
 */
export function useCodeFallback(phase: ClaudeLoginState["phase"] | undefined): {
  pasting: boolean;
  pasteCode: () => void;
} {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (phase !== "code") setAsked(false);
  }, [phase]);
  return { pasting: asked && phase === "code", pasteCode: () => setAsked(true) };
}

/** Where the card stands, as its message and its main button read it. */
interface CardState {
  engine: string;
  vendor: Vendor;
  login: ClaudeLoginState | null;
  busy: boolean;
  stalled: boolean;
  flat: boolean;
  missingCli?: boolean;
  installing?: boolean;
}

/** The card's one line: the step the user is on, else why a sign-in is needed. */
function cardMessage({ vendor, login, busy, flat, missingCli, installing }: CardState): string {
  if (login?.phase === "code")
    return t("Finish signing in in the browser window that opened. This card goes away on its own when you're in.");
  if (login?.phase === "terminal") return t("Finish signing in in the terminal below.");
  if (busy) return t("Finish in the browser window that just opened. This card goes away on its own when you're in.");
  if (installing) return t("Installing {name}. This can take a minute.", { name: vendor.name });
  if (missingCli) return t("{name} isn't installed on this computer yet.", { name: vendor.name });
  return flat ? vendor.useLine : vendor.signInLine;
}

/** The sign-in button's label. */
function signInLabel({ engine, busy, stalled, flat }: CardState): string {
  if (busy) return t("Waiting…");
  if (stalled) return t("Try again");
  if (flat) return t("Connect");
  return engine === EngineId.Codex ? t("Connect ChatGPT") : t("Sign in");
}

/** Stop the sign-in under way for `engine`. */
const cancelSignIn = (engine: string): Promise<unknown> =>
  engine === EngineId.Codex ? window.studio.codexLoginCancel() : window.studio.claudeLoginCancel();

/** The Claude sign-in's own steps: its page again, the code box on request, and its terminal. */
function ClaudeSignInSteps({
  login,
  codeFallback,
}: {
  login: ClaudeLoginState | null;
  codeFallback: ReturnType<typeof useCodeFallback>;
}): JSX.Element {
  return (
    <>
      {login?.hasBrowserUrl ? (
        <Button onClick={() => void window.studio.claudeLoginOpenBrowser()}>{t("Open the sign-in page")}</Button>
      ) : null}
      {login?.phase === "code" && !codeFallback.pasting && (
        <Button onClick={codeFallback.pasteCode}>{CODE_FALLBACK_LABEL}</Button>
      )}
      {login?.phase === "terminal" && (
        <Button onClick={() => window.dispatchEvent(new Event(SHOW_TERMINAL_EVENT))}>{t("Show terminal")}</Button>
      )}
    </>
  );
}

export function SignInCard({
  engine = EngineId.ClaudeCode,
  waiting,
  flat = false,
  error,
  missingCli,
  allowLocal,
  onSignIn,
  onRecheck,
  onContinueLocal,
}: {
  /** Which subscription this card is asking for. */
  engine?: string;
  waiting: boolean;
  flat?: boolean;
  error?: string | null;
  missingCli?: boolean;
  allowLocal?: boolean;
  onSignIn: () => void;
  onRecheck?: () => void;
  onContinueLocal?: () => void;
}): JSX.Element {
  const vendor = signInVendor(engine);
  const login = useClaudeLogin(engine);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  // Nothing typed for one subscription belongs to the next one either.
  useEffect(() => {
    setCode("");
    setCodeError(null);
  }, [engine]);
  const codeFallback = useCodeFallback(login?.phase);
  const wantsCode = codeFallback.pasting;
  // A sign-in that failed or was cancelled leaves the engine unready, so the poll never clears
  // `waiting`; the button has to come back to life or the card is a dead end of its own.
  const stalled = login?.phase === "failed" || login?.phase === "cancelled";
  const busy = waiting && !stalled;
  const cliInstall = useCliInstall(engine);
  const card: CardState = { engine, vendor, login, busy, stalled, flat, missingCli, installing: cliInstall.installing };
  /** The nearest trouble wins: the code just refused, then the sign-in's own, then the caller's. */
  const trouble = codeError ?? login?.error ?? (missingCli ? cliInstall.problem : null) ?? error;
  const submitCode = (): void => {
    setCodeError(null);
    void window.studio
      .claudeLoginCode(code)
      .then(() => setCode(""))
      .catch((err: Error) => setCodeError(err.message));
  };
  const primary = (): JSX.Element => {
    if (wantsCode)
      return (
        <>
          <input
            className={CODE_FIELD}
            // The user has just come back from the browser holding a code; the box takes it.
            autoFocus
            aria-label={t("Code from the sign-in page")}
            placeholder={t("Paste the code")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCode();
            }}
          />
          <Button variant="default" onClick={submitCode} disabled={!code.trim()}>
            {t("Continue")}
          </Button>
        </>
      );
    return missingCli ? (
      <Button variant="default" onClick={() => void cliInstall.install()} disabled={cliInstall.installing}>
        {vendor.get}
      </Button>
    ) : (
      <Button variant="default" onClick={onSignIn} disabled={busy}>
        {signInLabel(card)}
      </Button>
    );
  };
  return (
    <div className={flat ? "mb-1.5" : "mb-1.5 rounded-card bg-surface px-3 py-2.5 shadow-card"}>
      {!flat && (
        <div className="text-body-sm font-medium text-ink">{t("{name} needs a sign-in", { name: vendor.name })}</div>
      )}
      <p className="mt-1 text-xs leading-relaxed text-ink-2">{cardMessage(card)}</p>
      {trouble ? <p className="mt-1 text-xs text-orange">{problemWords(trouble)}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {primary()}
        <ClaudeSignInSteps login={login} codeFallback={codeFallback} />
        {busy && <Button onClick={() => void cancelSignIn(engine)}>{t("Cancel sign-in")}</Button>}
        {onRecheck ? (
          <Button onClick={onRecheck} disabled={busy}>
            {flat ? t("Check connection") : t("I'm signed in")}
          </Button>
        ) : null}
        {allowLocal && onContinueLocal ? <Button onClick={onContinueLocal}>{t("Continue on this Mac")}</Button> : null}
      </div>
    </div>
  );
}
