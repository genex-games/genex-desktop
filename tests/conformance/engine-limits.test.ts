/**
 * Limits as the run must see them: the CLI names a session
 * limit only in result text — "You've hit your session limit · resets 9:50pm" — and a run once
 * ended as a plain "error" because that text was never read. The engine classifies the text
 * and reads the reset time; the harness decides between waiting, pausing and landing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { limitKind, limitResetMs } from "../../src/substrate/engines/claude-code.ts";
import { classifyHttpFailure, classifyLocalFailure } from "../../src/substrate/engines/types.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { isTransientProviderError } from "../../src/harness-seed/loop/outage.ts";

describe("engine limits", () => {
  it("classifies session, usage and rate limits by their text, and nothing else", () => {
    assert.equal(limitKind("You've hit your session limit · resets 9:50pm (Europe/Belgrade)"), "rate_limit");
    assert.equal(limitKind("Rate limit reached, retry in 30s"), "rate_limit");
    assert.equal(limitKind("429 Too Many Requests"), "rate_limit");
    assert.equal(limitKind("You've hit your weekly limit · resets Sep 9, 3pm"), "usage_limit");
    assert.equal(limitKind("Your monthly limit is exhausted"), "usage_limit");
    assert.equal(limitKind("TypeError: x is not a function"), null);
    assert.equal(limitKind(""), null);
  });

  it("reads the reset time against the machine's clock", () => {
    const now = new Date("2026-09-07T19:56:00").getTime(); // local wall clock of the test machine
    const ms = limitResetMs("You've hit your session limit · resets 9:50pm (Europe/Belgrade)", now)!;
    assert.ok(ms > 0, "a reset later today is positive");
    assert.equal(Math.round(ms / 60_000), 114, "9:50pm is 114 minutes after 7:56pm");
    const tomorrow = limitResetMs("resets 9:50am", now)!;
    assert.ok(
      tomorrow > 12 * 3_600_000 && tomorrow < 24 * 3_600_000,
      `a clock time already behind is tomorrow's: ${tomorrow}`,
    );
    assert.equal(limitResetMs("resets in 3 hours", now), 3 * 3_600_000);
    assert.equal(limitResetMs("resets in 45 min", now), 45 * 60_000);
    assert.equal(limitResetMs("no reset named here", now), null);
  });

  it("reads the wait a Codex limit names, and a Claude reset said with 'at'", () => {
    const now = new Date("2026-09-07T19:56:00").getTime(); // local wall clock of the test machine
    const rows: Array<[text: string, ms: number | null]> = [
      [
        "You've hit your usage limit. Try again in 4 days 20 hours 9 minutes.",
        4 * DAY_MS + 20 * HOUR_MS + 9 * MINUTE_MS,
      ],
      [
        "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 1 hour 30 minutes.",
        90 * MINUTE_MS,
      ],
      ["Rate limit reached for gpt-5 on tokens per min. Please try again in 1.5s.", 1.5 * SECOND_MS],
      ["Rate limit reached. Please try again in 1m12s.", 72 * SECOND_MS],
      ["You've hit your usage limit. Try again in less than a minute.", MINUTE_MS],
      ["You've hit your usage limit. Try again at 9:50 PM.", 114 * MINUTE_MS],
      ["You've hit your usage limit. Try again at 21:50.", 114 * MINUTE_MS],
      [
        "You've hit your usage limit. Try again at Sep 12th, 2026 3:45 PM.",
        new Date("2026-09-12T15:45:00").getTime() - now,
      ],
      ["Claude usage limit reached; resets at 9:50pm", 114 * MINUTE_MS],
      // Nothing to read: no number, a date with no time, an unknown month, a wait in the past.
      ["Something went wrong, try again in a moment.", null],
      ["You've hit your weekly limit. It resets Nov 3.", null],
      ["You've hit your usage limit. Try again at Foo 12th, 2026 3:45 PM.", null],
    ];
    for (const [text, ms] of rows) assert.equal(limitResetMs(text, now), ms, text);
    const tomorrow = limitResetMs("You've hit your usage limit. Try again at 9:50 AM.", now)!;
    assert.ok(tomorrow > 12 * HOUR_MS && tomorrow < DAY_MS, `a clock time already behind is tomorrow's: ${tomorrow}`);
    assert.equal(
      limitResetMs("You've hit your usage limit. Try again at Sep 1st, 2026 3:45 PM.", now),
      MINUTE_MS,
      "a dated reset already past is a minute away, never negative",
    );
  });
});

describe("HTTP failures of an API engine", () => {
  it("classifies each status by its code, never by the body's words", () => {
    const rows: Array<[number, string, string]> = [
      [429, "slow down", "rate_limit"],
      [401, "bad key", "auth"],
      [403, "forbidden", "auth"],
      // A metered account out of credits: no in-run wait refills it, so the run ends rather than retrying.
      [402, "Insufficient credits", "usage_limit"],
      [500, "boom", "unavailable"],
      [503, "overloaded", "unavailable"],
      [400, "rate limit exceeded", "other"],
    ];
    for (const [status, body, kind] of rows)
      assert.equal(classifyHttpFailure("openrouter", status, body).kind, kind, `${status}`);
    assert.equal(classifyHttpFailure("openrouter", 429, "retry-after: 7").retryAfterMs, 7000);
  });
});

describe("a local model out of the computer's memory", () => {
  // Live, 2026-11-21: Inkling 2 Mini on a Mac's Ollama crashed on Metal's memory, and the chat said
  // Ollama was unreachable and to wait and resend.
  it("is its own failure, whatever runtime said it, and a hosted provider's words stay an outage", () => {
    const outOfMemory = [
      '{"error":{"message":"mlx runner failed: panic: mlx: [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)"}}',
      '{"error":"model requires more system memory (23.4 GiB) than is available (10.1 GiB)"}',
      '{"error":"llama runner process has terminated: cudaMalloc failed: out of memory"}',
      '{"error":"llama runner process has terminated: error loading model: unable to allocate CUDA0 buffer"}',
      '{"error":{"message":"ggml_vulkan: Device memory allocation failed: ErrorOutOfDeviceMemory"}}',
      '{"error":{"code":500,"message":"failed to allocate compute buffers"}}',
    ];
    for (const body of outOfMemory) {
      const failure = classifyLocalFailure("ollama", 500, body, "inkling-2-mini");
      assert.equal(failure.kind, "out_of_memory", body);
      assert.match(failure.message, /inkling-2-mini needs more memory than this computer has free/);
      assert.equal(isTransientProviderError(failure), false, `no wait fits the model in: ${body}`);
    }
    const otherwise: Array<[number, string, string]> = [
      [500, '{"error":"llama runner process has terminated: exit status 2"}', "unavailable"],
      [503, '{"error":"loading model"}', "unavailable"],
      [500, "error parsing tool call", "unavailable"],
      [400, '{"error":"memory is a feature of this model"}', "other"],
      [500, '{"error":"failed to allocate a port for the runner"}', "unavailable"],
    ];
    for (const [status, body, kind] of otherwise)
      assert.equal(classifyLocalFailure("ollama", status, body).kind, kind, body);
    assert.equal(
      classifyHttpFailure("openrouter", 500, "CUDA out of memory").kind,
      "unavailable",
      "a hosted provider's memory is its own outage: a wait mends it",
    );
  });
});
