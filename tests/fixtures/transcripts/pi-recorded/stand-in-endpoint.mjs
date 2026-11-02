// Local stand-in for an OpenAI-compatible endpoint (no real provider, no credentials).
// Behaviour chosen by the requested model id.
import http from "node:http";
const counts = new Map();
const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};
const chunk = (model, delta, extra = {}) => ({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: null }], ...extra });
http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let model = "";
    let hasToolResult = false;
    try { const b = JSON.parse(body); model = b.model; hasToolResult = (b.messages ?? []).some((m) => m.role === "tool"); } catch {}
    const n = (counts.get(model) ?? 0) + 1; counts.set(model, n);
    process.stderr.write(`${req.method} ${req.url} model=${model} attempt=${n}\n`);
    const ok = () => sse(res, [
      chunk(model, { role: "assistant", content: "" }),
      chunk(model, { content: "Hello " }),
      chunk(model, { content: "from " }),
      chunk(model, { content: "Pi." }),
      { ...chunk(model, {}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 } },
    ]);
    const fail = (status, message, type) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message, type, code: type } })); };
    if (model === "stub-ok") return ok();
    if (model === "stub-tool" && !hasToolResult) return sse(res, [
      chunk(model, { role: "assistant", content: "" }),
      chunk(model, { content: "Listing." }),
      chunk(model, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }),
      chunk(model, { tool_calls: [{ index: 0, function: { arguments: "{\"command\":" } }] }),
      chunk(model, { tool_calls: [{ index: 0, function: { arguments: "\"echo genex\"}" } }] }),
      { ...chunk(model, {}), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
    ]);
    if (model === "stub-tool") return sse(res, [
      chunk(model, { role: "assistant", content: "" }),
      chunk(model, { content: "Done: " }),
      chunk(model, { content: "genex." }),
      { ...chunk(model, {}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 150, completion_tokens: 7, total_tokens: 157 } },
    ]);
    if (model === "stub-ratelimit") return fail(429, "Rate limit reached for requests", "rate_limit_exceeded");
    if (model === "stub-badmodel") return fail(404, "The model `stub-badmodel` does not exist", "model_not_found");
    if (model === "stub-auth") return fail(401, "Incorrect API key provided", "invalid_api_key");
    if (model === "stub-flaky") return n === 1 ? fail(503, "Service temporarily unavailable", "server_error") : ok();
    if (model === "stub-refusal") return sse(res, [
      chunk(model, { role: "assistant", content: "" }),
      { ...chunk(model, {}), choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] },
    ]);
    fail(400, "unknown stub model", "invalid_request_error");
  });
}).listen(Number(process.env.PORT ?? 18787), "127.0.0.1", () => process.stderr.write("stub ready\n"));
