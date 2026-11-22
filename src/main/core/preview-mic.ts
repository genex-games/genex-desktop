/**
 * The microphone in Live (docs/product/builds-live.md). A game that declares the microphone
 * (`"genex": {"capabilities": ["microphone"]}`) and asks for it (`getUserMedia({ audio: true })`)
 * waits while Live's bar asks the person; once they allow it, the game has it for this app session
 * (the system asks first, once, as for Play's mic). An undeclared game is refused with no prompt.
 * Agents' windows never get here (`preview-permissions.ts`).
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import { PreviewMicAsk } from "../../shared/preview-ai.ts";

/** How long a game's ask waits for the person before it is refused. */
const MIC_ASK_TIMEOUT_MS = 2 * MINUTE_MS;

/** What the microphone's gate needs: the game's declaration, the system's word, and the bar. */
export interface PreviewMicDeps {
  /** Whether the game declares the microphone. */
  declares: (project: string) => Promise<boolean>;
  /** Whether the system lets the app use the microphone; macOS asks the person the first time. */
  access: () => Promise<boolean>;
  /** The bar's microphone state for a game changed. */
  show: (project: string, ask: PreviewMicAsk) => void;
  askTimeoutMs?: number;
}

/** The games the person allowed the microphone in Live this app session, and the asks waiting on them. */
export class PreviewMicService {
  readonly #deps: PreviewMicDeps;
  readonly #allowed = new Set<string>();
  readonly #waiting = new Map<string, Promise<boolean>>();
  readonly #answers = new Map<string, (allow: boolean) => void>();

  constructor(deps: PreviewMicDeps) {
    this.#deps = deps;
  }

  /** Whether the person allowed `project` the microphone this app session. */
  allowed(project: string): boolean {
    return this.#allowed.has(project);
  }

  /**
   * The game in Live asked for the microphone: refused at once when it declares none; granted when
   * the person allowed it this session; otherwise the bar asks and the answer (or the timeout) decides.
   */
  async ask(project: string): Promise<boolean> {
    if (!(await this.#deps.declares(project))) return false;
    if (this.#allowed.has(project)) return this.#deps.access();
    const pending = this.#waiting.get(project);
    if (pending) return pending;
    const asked = this.#askPerson(project).finally(() => this.#waiting.delete(project));
    this.#waiting.set(project, asked);
    return asked;
  }

  /** Show the ask and wait for the person's answer; past the timeout it is a no for now. */
  async #askPerson(project: string): Promise<boolean> {
    const answered = new Promise<boolean>((resolve) => this.#answers.set(project, resolve));
    this.#deps.show(project, PreviewMicAsk.Asking);
    const timer = setTimeout(() => this.#answers.get(project)?.(false), this.#deps.askTimeoutMs ?? MIC_ASK_TIMEOUT_MS);
    const allow = await answered.finally(() => clearTimeout(timer));
    this.#answers.delete(project);
    if (!allow) {
      this.#deps.show(project, PreviewMicAsk.Refused);
      return false;
    }
    this.#allowed.add(project);
    const granted = await this.#deps.access();
    this.#deps.show(project, granted ? PreviewMicAsk.Allowed : PreviewMicAsk.Refused);
    return granted;
  }

  /** The person's answer in Live's bar; with no ask waiting, Allow still allows the game from now on. */
  answer(project: string, allow: boolean): void {
    const waiting = this.#answers.get(project);
    if (waiting) {
      waiting(allow);
      return;
    }
    if (allow) this.#allowed.add(project);
    else this.#allowed.delete(project);
    this.#deps.show(project, allow ? PreviewMicAsk.Allowed : PreviewMicAsk.Refused);
  }
}
