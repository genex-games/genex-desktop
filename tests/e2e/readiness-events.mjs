/** Correlate the controlled marker's queue receipt, processing and live turn before Stop. */
export function pendingReadinessTurn(entries, before, text) {
  const queued = entries.find(
    (e) =>
      !before.has(e.id) && e.data.event_type === "coordinator_message_queued" && e.data.payload?.action?.text === text,
  );
  if (!queued) return false;
  const processing = entries.findIndex(
    (e) =>
      e.data.event_type === "coordinator_message_processing" &&
      e.data.payload?.messageId === queued.data.payload.messageId,
  );
  if (processing < 0) return false;
  const started = entries.findIndex(
    (e, index) => index > processing && e.thread_id === queued.thread_id && e.data.type === "turn_started",
  );
  if (started < 0) return false;
  const turn = entries[started].turn_id;
  if (!turn || entries.slice(started).some((e) => e.turn_id === turn && e.data.type === "turn_ended")) return false;
  const working = entries
    .slice(started + 1)
    .some(
      (e) =>
        e.thread_id === queued.thread_id &&
        e.data.event_type === "session_activity" &&
        e.data.payload?.phase === "thinking",
    );
  return working ? turn : false;
}
