/**
 * The bottom of the chat: whatever is waiting on the user sits right above the composer — a
 * sign-in, then one at a time Claude's own permission requests, a plugin's permission request,
 * the plan to approve and the intake's question — and the composer itself (`children`) is last,
 * told what the card on show makes of its words.
 */
import { type ComponentProps, type JSX, type ReactNode, useId, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { CONFIRMATION_INPUT_MAX_CHARS } from "../../shared/plugins.ts";
import type { PlanReviewRecord } from "../../shared/composer.ts";
import { hostPlatform } from "../platform.ts";
import { openSettings, SettingsSection } from "../settings-navigation.ts";
import { Button } from "../ui/Button.tsx";
import { Input } from "../ui/input.tsx";
import { AnimateHeight } from "../ui/animate-height.tsx";
import { Presence } from "../ui/Presence.tsx";
import { SignInCard } from "../ui/SignInCard.tsx";
import { CHAT_WORDS, computerNeverWords } from "../words.ts";
import type { EntryKind } from "../chat-entries.ts";
import type { ConversationEntry } from "./conversation-entries.ts";
import { ChatQuestion, choiceLabel } from "./ChatQuestion.tsx";
import { ConsentChoice, consentChoices, consentIsStudios, consentLine, consentTitle } from "./consent-card.ts";
import { ExportReview } from "./ExportReview.tsx";
import { PermissionRequest, permissionOwnAnswer } from "./PermissionRequest.tsx";
import { PlanQuestion } from "./PlanQuestion.tsx";
import { type OwnAnswer, type WaitingCard, waitingHead } from "./waiting-cards.ts";
import type { PermissionMode, ToolPermissionAnswer } from "../../shared/permissions.ts";

type Question = Extract<ConversationEntry, { kind: typeof EntryKind.Question }>;
type Consent = Extract<ConversationEntry, { kind: typeof EntryKind.Action }>;

export interface PlanPrompt {
  review: PlanReviewRecord;
  busy: boolean;
  revising: boolean;
  onAnswer: (approved: boolean) => Promise<void>;
  onRetry: () => Promise<void>;
  onChooseModel: () => void;
  onRevise: () => void;
}

/** What answering a consent card sends: approved or not, Always allow, and the edit of its field. */
type OnConsent = (consentId: string, approved: boolean, always: boolean, input?: string) => Promise<void>;

/** A card's field the person may edit before Allow, filled with what the agent asked for. */
function ConsentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div data-consent-input className="mt-2 flex flex-col gap-1">
      <label htmlFor={id} className="text-chat-sub text-ink-2">
        {label}
      </label>
      <Input
        id={id}
        className="text-chat text-ink"
        value={value}
        maxLength={CONFIRMATION_INPUT_MAX_CHARS}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * A plugin's or connector's permission request: Allow once, Always allow (a connector's only) or
 * Don't allow, with the request itself (the tool and what it was given) under Details. The studio's
 * own cards say what a yes lets the agent do in the line under the question; a plugin tool's own
 * question is subtitled with the plugin. A card with a field shows it under the question, filled,
 * and Allow sends what it holds.
 */
function ConsentCard({
  consentId,
  entry,
  onConsent,
}: {
  consentId: string;
  entry: Omit<Consent, "consentId" | "permission">;
  onConsent: OnConsent;
}): JSX.Element {
  const field = entry.consentInput;
  const [typed, setTyped] = useState(field?.value ?? "");
  const studio = consentIsStudios(entry);
  return (
    <ChatQuestion
      title={consentTitle(entry)}
      description={consentLine(entry)}
      details={
        <>
          <span className="block [overflow-wrap:anywhere]">{entry.text}</span>
          {studio && <span className="block">{computerNeverWords(hostPlatform())}</span>}
        </>
      }
      reopenLabel={t("Review permission request")}
      choices={consentChoices(entry)}
      onConfirm={(choice) =>
        onConsent(
          consentId,
          choice !== ConsentChoice.Decline,
          choice === ConsentChoice.Always,
          field ? typed : undefined,
        )
      }
    >
      {field && <ConsentField label={field.label} value={typed} onChange={setTyped} />}
      {entry.consentExport && <ExportReview review={entry.consentExport} />}
    </ChatQuestion>
  );
}

/** What the dock is given: the composer, and everything waiting on the user above it. */
interface ComposerDockProps {
  /** The chat the dock belongs to: another chat's cards are simply there, they do not arrive. */
  conversationKey?: string;
  /** The chat is loading: the cards it opens with are simply there. */
  loading?: boolean;
  /** Studio has no model it can chat with. */
  connectModel: boolean;
  /** The selected subscription is signed out: its card instead of a send that would fail. */
  signIn: ComponentProps<typeof SignInCard> | null;
  /** The intake's questions still waiting for an answer. */
  questions: Question[];
  /** A pressed answer's words, sent as the person's next message. */
  onAnswerQuestion: (answer: string) => Promise<void>;
  questionsDisabled: boolean;
  /** A plan that is waiting for approval, or failed to be written. */
  plan: PlanPrompt | null;
  /** Plugins' permission requests that are still waiting. */
  consents: Consent[];
  onConsent: OnConsent;
  /** Claude's own permission requests (and plans to approve) that are still waiting. */
  permissions: Consent[];
  onPermission: (requestId: string, answer: ToolPermissionAnswer) => Promise<void>;
  /** The modes a plan card offers to continue in: the chat's engine's, without an Auto its model cannot use. */
  planModes: readonly PermissionMode[];
  /** A quiet card an engine plugin offers (its steps), shown while nothing else waits on the user. */
  steps?: ReactNode;
  /** The composer, told what the card on show makes of its words (null: nothing, the chat as ever). */
  children: (own: OwnAnswer | null) => ReactNode;
}

/** A card waiting on the user, what it draws, and what it makes of the composer's words. */
type DockCard = WaitingCard & { node: ReactNode; own?: OwnAnswer };

/** What the composer invites while an agent's question waits: its words are the answer. */
const QUESTION_OWN_ANSWER: OwnAnswer = { placeholder: t("Write your own answer…") };

/**
 * Everything waiting on the user, most pressing first: permission requests hold up work already
 * running, in the order they were asked (entry ids are time-ordered); then the plan to approve;
 * then the intake's questions, which cannot be answered while the chat works.
 */
function waitingCards(props: ComposerDockProps): DockCard[] {
  const { questions, questionsDisabled, onAnswerQuestion, plan, onConsent, onPermission } = props;
  const asks = [...props.consents, ...props.permissions].sort((a, b) => a.id.localeCompare(b.id));
  return [
    ...asks.map(({ permission, consentId, ...entry }) => ({
      key: permission ? `permission:${permission.requestId}` : `consent:${consentId}`,
      blocked: false,
      ...(permission
        ? { own: permissionOwnAnswer(permission, (answer) => onPermission(permission.requestId, answer)) }
        : {}),
      node: permission ? (
        <PermissionRequest
          event={permission}
          planModes={props.planModes}
          onAnswer={(answer) => onPermission(permission.requestId, answer)}
        />
      ) : (
        consentId && <ConsentCard consentId={consentId} entry={entry} onConsent={onConsent} />
      ),
    })),
    ...(plan
      ? [
          {
            key: `plan:${plan.review.id}`,
            blocked: false,
            node: (
              <PlanQuestion
                review={plan.review}
                busy={plan.busy}
                revising={plan.revising}
                onAnswer={plan.onAnswer}
                onRetry={plan.onRetry}
                onChooseModel={plan.onChooseModel}
                onSettings={() => openSettings(SettingsSection.Providers)}
                onRevise={plan.onRevise}
              />
            ),
          },
        ]
      : []),
    ...questions.map((entry) => ({
      key: `question:${entry.id}`,
      blocked: questionsDisabled,
      own: QUESTION_OWN_ANSWER,
      node: (
        <ChatQuestion
          title={entry.text}
          {...(entry.recap ? { recap: entry.recap } : {})}
          choices={entry.choices}
          disabled={questionsDisabled}
          onConfirm={async (choice) => {
            const answer = entry.choices.find((item) => item.id === choice);
            if (answer) await onAnswerQuestion(choiceLabel(answer));
          }}
        />
      ),
    })),
  ];
}

/**
 * The card on show, remembered across renders so a card that arrives later does not take its
 * place; another chat starts afresh.
 */
function useWaitingHead(cards: readonly WaitingCard[], conversation: string | undefined): string | null {
  const shown = useRef<{ conversation: string | undefined; head: string | null }>({ conversation, head: null });
  if (shown.current.conversation !== conversation) shown.current = { conversation, head: null };
  shown.current.head = waitingHead(cards, shown.current.head);
  return shown.current.head;
}

/**
 * One waiting card at a time, and how many more wait behind it. The others stay mounted but
 * hidden, so a field half filled on one survives another taking its place. The cards open above
 * the composer and close once answered; the next one fades in as their height glides to its own.
 */
function WaitingCards({ cards, head, still }: { cards: DockCard[]; head: string | null; still: boolean }): JSX.Element {
  const block = (
    <AnimateHeight>
      <div data-pending-questions className="mb-2">
        {cards.map((card) => (
          <div key={card.key} hidden={card.key !== head} className="chat-waiting-card">
            {card.node}
          </div>
        ))}
        {cards.length > 1 && (
          <p role="status" data-waiting-count className="mt-1.5 px-1.5 text-chat-sub text-ink-3">
            {CHAT_WORDS.moreWaiting(cards.length - 1)}
          </p>
        )}
      </div>
    </AnimateHeight>
  );
  return <Presence still={still}>{cards.length > 0 ? [{ key: "cards", node: block }] : []}</Presence>;
}

export function ComposerDock(props: ComposerDockProps): JSX.Element {
  const { connectModel, signIn, children } = props;
  const cards = waitingCards(props);
  const head = useWaitingHead(cards, props.conversationKey);
  const own = cards.find((card) => card.key === head)?.own ?? null;
  return (
    <div data-chat-composer className="max-h-full min-w-0 shrink-0 overflow-y-auto px-3.5 pb-3.5">
      {connectModel && (
        <div className="mb-2 text-chat-sub text-ink-3">
          {t("Connect a model to chat with Studio.")}
          <Button variant="ghost" onClick={() => openSettings(SettingsSection.Providers)}>
            {t("Model Providers")}
          </Button>
        </div>
      )}
      {signIn ? <SignInCard {...signIn} /> : null}
      <WaitingCards key={props.conversationKey} cards={cards} head={head} still={Boolean(props.loading)} />
      {cards.length === 0 && !signIn ? props.steps : null}
      {children(own)}
    </div>
  );
}
