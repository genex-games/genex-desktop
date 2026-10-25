/**
 * The person's "Sell when published" on a game's local item drafts (contract "Local item drafts"),
 * kept in Studio's own app data for the profile (`<userData>/item-approvals.json`), never in the game
 * folder, so an agent can neither write nor forge one (D40). Per game, by local id: the approval
 * (the content hash the person saw, and when), each draft as the CLI last printed it with Studio's
 * fingerprint of the game's bytes for it, the drafts the agent removed, and what became of each once
 * the game was published (`local-items.ts`). An approval names only a hash Studio saw the CLI print
 * for that draft. Pure functions over the document, and a small store that reads and writes it.
 */
import path from "node:path";
import { PROJECT_NAME_RE } from "../../shared/game-folder-name.ts";
import {
  type ItemApproval,
  isContentHash,
  isLocalItemId,
  type LocalItemsView,
  type LocalListingDraft,
  type LocalOutcome,
  LocalOutcomeKind,
  localDraftOf,
} from "../../shared/item-draft.ts";
import { isItemId, storeRefusalOf } from "../../shared/store-items.ts";
import { AsyncLock, atomicWriteJson, readRegularFile } from "../../substrate/fsx.ts";

/** The file's name in the profile's app data. */
export const ITEM_APPROVALS_FILE = "item-approvals.json";
/** The document's version. */
const VERSION = 1;
/** The most the file may hold before it is no file Studio wrote. */
const FILE_BYTES_MAX = 4 * 1024 * 1024;
/** The most games, and drafts per game, the document keeps. */
const GAMES_MAX = 500;
const ENTRIES_MAX = 500;
/** Studio's fingerprint of a draft's bytes (`local-item-files.ts`): sha256 hex. */
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** A field a refused upload names. */
const FIELD = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const OUTCOME_KINDS: ReadonlySet<unknown> = new Set(Object.values(LocalOutcomeKind));

/** A draft as the CLI last printed it, and Studio's fingerprint of the game's bytes for it then. */
export interface KnownDraft {
  draft: LocalListingDraft;
  fingerprint: string | null;
}

/** One game's record. */
interface GameRecord {
  approvals: Record<string, ItemApproval>;
  drafts: Record<string, KnownDraft>;
  removed: string[];
  outcomes: Record<string, LocalOutcome>;
}

/** The whole document. */
export interface ApprovalsDoc {
  version: typeof VERSION;
  games: Record<string, GameRecord>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMoment = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Nothing approved anywhere. */
export const emptyApprovals = (): ApprovalsDoc => ({ version: VERSION, games: {} });

const emptyGame = (): GameRecord => ({ approvals: {}, drafts: {}, removed: [], outcomes: {} });

/** Each entry of `value` whose key is a local id and whose value reads, at most {@link ENTRIES_MAX}. */
function entriesOf<T>(value: unknown, read: (entry: unknown, localId: string) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(value)) return out;
  for (const [localId, entry] of Object.entries(value).slice(0, ENTRIES_MAX)) {
    const read1 = isLocalItemId(localId) ? read(entry, localId) : null;
    if (read1) out[localId] = read1;
  }
  return out;
}

function approvalOf(value: unknown): ItemApproval | null {
  if (!isRecord(value) || !isContentHash(value.contentHash) || !isMoment(value.at)) return null;
  return { contentHash: value.contentHash, at: value.at };
}

function knownOf(value: unknown, localId: string, project: string): KnownDraft | null {
  if (!isRecord(value)) return null;
  const draft = localDraftOf(value.draft, project);
  if (!draft || draft.localId !== localId) return null;
  const fingerprint =
    typeof value.fingerprint === "string" && FINGERPRINT.test(value.fingerprint) ? value.fingerprint : null;
  return { draft, fingerprint };
}

function outcomeOf(value: unknown): LocalOutcome | null {
  if (!isRecord(value) || !OUTCOME_KINDS.has(value.kind) || !isMoment(value.at)) return null;
  const skuId = isItemId(value.skuId) ? value.skuId : null;
  const refusal = value.refusal === null || value.refusal === undefined ? null : storeRefusalOf(value.refusal);
  const field = typeof value.field === "string" && FIELD.test(value.field) ? value.field : null;
  const needsSku = value.kind !== LocalOutcomeKind.Refused;
  if (needsSku && !skuId) return null;
  const contentHash = isContentHash(value.contentHash) ? value.contentHash : null;
  return { kind: value.kind as LocalOutcome["kind"], skuId, contentHash, refusal, field, at: value.at };
}

function gameOf(value: unknown, project: string): GameRecord {
  if (!isRecord(value)) return emptyGame();
  const removed = Array.isArray(value.removed) ? value.removed.filter(isLocalItemId).slice(0, ENTRIES_MAX) : [];
  return {
    approvals: entriesOf(value.approvals, approvalOf),
    drafts: entriesOf(value.drafts, (entry, localId) => knownOf(entry, localId, project)),
    removed,
    outcomes: entriesOf(value.outcomes, outcomeOf),
  };
}

/** The document a file held, read as untrusted: anything that does not read is left out. */
export function readApprovals(raw: unknown): ApprovalsDoc {
  if (!isRecord(raw) || raw.version !== VERSION || !isRecord(raw.games)) return emptyApprovals();
  const games: Record<string, GameRecord> = {};
  for (const [project, game] of Object.entries(raw.games).slice(0, GAMES_MAX))
    if (PROJECT_NAME_RE.test(project)) games[project] = gameOf(game, project);
  return { version: VERSION, games };
}

const gameIn = (doc: ApprovalsDoc, project: string): GameRecord =>
  Object.hasOwn(doc.games, project) ? (doc.games[project] ?? emptyGame()) : emptyGame();

/** `doc` with `project`'s record changed by `change`; a name that is not a game's changes nothing. */
function withGame(doc: ApprovalsDoc, project: string, change: (game: GameRecord) => GameRecord): ApprovalsDoc {
  if (!PROJECT_NAME_RE.test(project)) return doc;
  return { ...doc, games: { ...doc.games, [project]: change(gameIn(doc, project)) } };
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!Object.hasOwn(record, key)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
};

/** The approval of one draft, or null. */
export const approvalFor = (doc: ApprovalsDoc, project: string, localId: string): ItemApproval | null =>
  gameIn(doc, project).approvals[localId] ?? null;

/** The draft as the CLI last printed it, or null. */
export const knownDraftFor = (doc: ApprovalsDoc, project: string, localId: string): KnownDraft | null =>
  gameIn(doc, project).drafts[localId] ?? null;

/**
 * The person approved the draft `localId` as it holds `contentHash`. Only a hash Studio saw the CLI
 * print for that draft (`noteDraft`) is approved; a draft already on genex.games or removed is not.
 */
export function approve(
  doc: ApprovalsDoc,
  project: string,
  localId: string,
  contentHash: string,
  at: number,
): ApprovalsDoc {
  if (!isLocalItemId(localId) || !isContentHash(contentHash) || !isMoment(at)) return doc;
  const game = gameIn(doc, project);
  const uploaded = game.outcomes[localId]?.skuId;
  const shown = game.drafts[localId]?.draft.contentHash === contentHash;
  if (uploaded || !shown || game.removed.includes(localId)) return doc;
  return withGame(doc, project, (g) => ({ ...g, approvals: { ...g.approvals, [localId]: { contentHash, at } } }));
}

/** The person took their approval back. */
export const withdraw = (doc: ApprovalsDoc, project: string, localId: string): ApprovalsDoc =>
  withGame(doc, project, (g) => ({ ...g, approvals: without(g.approvals, localId) }));

/**
 * The CLI printed a local draft (the agent's `shop add|set`, or the person's sharing through main):
 * the card shows it from now on. A refusal of its upload was for what it held before, and goes.
 */
export function noteDraft(doc: ApprovalsDoc, draft: LocalListingDraft, fingerprint: string | null): ApprovalsDoc {
  const print = fingerprint && FINGERPRINT.test(fingerprint) ? fingerprint : null;
  return withGame(doc, draft.project, (g) => {
    const stale = g.outcomes[draft.localId];
    const outcomes = stale && !stale.skuId ? without(g.outcomes, draft.localId) : g.outcomes;
    return {
      ...g,
      drafts: { ...g.drafts, [draft.localId]: { draft, fingerprint: print } },
      removed: g.removed.filter((localId) => localId !== draft.localId),
      outcomes,
    };
  });
}

/** The agent removed these drafts: their approvals and drafts go, and their cards say so. */
export function forget(doc: ApprovalsDoc, project: string, localIds: readonly string[]): ApprovalsDoc {
  const gone = localIds.filter(isLocalItemId);
  return withGame(doc, project, (g) => {
    let { approvals, drafts } = g;
    for (const localId of gone) {
      approvals = without(approvals, localId);
      drafts = without(drafts, localId);
    }
    const removed = [...new Set([...g.removed, ...gone])].slice(-ENTRIES_MAX);
    return { ...g, approvals, drafts, removed };
  });
}

/**
 * What a settle after the publish made of each draft (`outcomes`), and the approvals it used: an
 * uploaded draft is on genex.games now, so its approval goes; its last draft stays, as what its
 * card shows of it.
 */
export function settled(
  doc: ApprovalsDoc,
  project: string,
  outcomes: Readonly<Record<string, LocalOutcome>>,
  used: readonly string[],
): ApprovalsDoc {
  return withGame(doc, project, (g) => {
    let { approvals } = g;
    for (const localId of used) approvals = without(approvals, localId);
    for (const [localId, outcome] of Object.entries(outcomes))
      if (outcome.skuId) approvals = without(approvals, localId);
    return { ...g, approvals, outcomes: { ...g.outcomes, ...outcomes } };
  });
}

/** What the renderer is told of one game. */
export function localItemsView(doc: ApprovalsDoc, project: string): LocalItemsView {
  const game = gameIn(doc, project);
  const drafts: Record<string, LocalListingDraft> = {};
  for (const [localId, known] of Object.entries(game.drafts)) drafts[localId] = known.draft;
  return { project, approvals: game.approvals, drafts, removed: game.removed, outcomes: game.outcomes };
}

/** The approvals file of one profile: read as untrusted, never through a link, written whole, one write at a time. */
export class ItemApprovals {
  readonly file: string;
  readonly #lock = new AsyncLock();
  constructor(file: string) {
    this.file = path.resolve(file);
  }

  /** The document as the file holds it; nothing approved when it is missing, a link or unreadable. */
  async read(): Promise<ApprovalsDoc> {
    try {
      return readApprovals(JSON.parse((await readRegularFile(this.file, FILE_BYTES_MAX)).toString("utf8")));
    } catch {
      return emptyApprovals();
    }
  }

  /** Change the document and write it, after every change before it. */
  update(change: (doc: ApprovalsDoc) => ApprovalsDoc): Promise<ApprovalsDoc> {
    return this.#lock.run(async () => {
      const next = change(await this.read());
      await atomicWriteJson(this.file, next);
      return next;
    });
  }
}
