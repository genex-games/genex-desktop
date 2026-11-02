# Recorded `pi --mode json` streams

Each `*.jsonl` here is the stdout of a real `pi --mode json` run, not hand-written:

- Pi: `@earendil-works/pi-coding-agent` 1.4.0, Node 24.22.1, Linux x64, recorded 2026-10-28.
- Command: `pi --mode json --no-extensions --no-session --model <provider>/<model>` with the prompt on stdin,
  `HOME` set to a throwaway folder (no sign-in, no `auth.json` credential).
- Provider: a local stand-in OpenAI-compatible endpoint, `stand-in-endpoint.mjs` in this folder, declared
  in the throwaway `~/.pi/agent/models.json` as provider `stub` (`api: "openai-completions"`, a dummy
  `apiKey`). `stubdown` points at a closed local port for the no-network case. The endpoint's replies are
  scripted; Pi's events, retries, stop reasons and usage are Pi's own.
- Pi exited 0 for every one of these runs, including the failures: in JSON mode the failure is only in
  the events.

| File | Endpoint behaviour | What Pi emitted |
|---|---|---|
| `ok.jsonl` | three text chunks, then usage 120 in / 7 out | `text_delta` ×3 with cumulative `usage`, one `message_end` `stop` |
| `tool.jsonl` | a `bash` tool call (usage 100/5), then a text reply (150/7) | two assistant replies, one tool run |
| `ratelimit.jsonl` | HTTP 429 on every attempt | `message_end` `error` + `agent_end willRetry:true` ×3, then `auto_retry_end success:false` |
| `flaky.jsonl` | HTTP 503 once, then the `ok` reply | `message_end` `error`, retry, `message_end` `stop`, `auto_retry_end success:true` |
| `badmodel.jsonl` | HTTP 404 model not found | `message_end` `error` `404: …`, no retry |
| `auth.jsonl` | HTTP 401 | `message_end` `error` `401: …`, no retry |
| `refusal.jsonl` | `finish_reason: content_filter`, no text | `message_end` `error`, `rawStopReason: content_filter` |
| `nonetwork.jsonl` | nothing listening | `Connection error.` ×4 (retried), `auto_retry_end success:false` |

Only bulky, irrelevant parts were elided after recording (`elide.py`); every event and every other field is verbatim
and in order: the `system` message's text and tool schemas (Pi's own prompt) became `"<elided: Pi system
prompt>"`, `agent_end.messages` became `"<elided>"`, and the session header's `cwd` became `/game`.
