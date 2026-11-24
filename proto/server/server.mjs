// Prototype test server for the Unreal tab question. Plain Node http, no dependencies.
// Serves one test page on 127.0.0.1 and appends every POST from it to proto/out/page-results.jsonl.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "out");
// Windows runs go to their own file so the Mac results stay as they were.
const RESULTS_FILE = join(OUT_DIR, process.platform === "win32" ? "page-results-windows.jsonl" : "page-results.jsonl");
const PORT = Number(process.env.PROTO_PORT ?? 18431);
const PAGE = readFileSync(join(HERE, "page.html"), "utf8");
const PUSH_DELAY_MS = 300;

mkdirSync(OUT_DIR, { recursive: true });

function record(entry) {
	appendFileSync(RESULTS_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function readBody(request) {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
	});
}

function parse(body) {
	try {
		return JSON.parse(body);
	} catch {
		return { raw: body };
	}
}

function serveEvents(request, response) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	record({ kind: "sse-open", ua: request.headers["user-agent"] });
	setTimeout(() => {
		response.write(`data: ${JSON.stringify({ pushed: new Date().toISOString() })}\n\n`);
	}, PUSH_DELAY_MS);
	request.on("close", () => record({ kind: "sse-close" }));
}

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
	if (request.method === "POST" && url.pathname === "/result") {
		const body = await readBody(request);
		record({ kind: "post", ua: request.headers["user-agent"], data: parse(body) });
		response.writeHead(204, { "access-control-allow-origin": "*" });
		response.end();
		return;
	}
	if (url.pathname === "/events") {
		serveEvents(request, response);
		return;
	}
	if (url.pathname === "/" || url.pathname === "/index.html") {
		record({ kind: "get-page", ua: request.headers["user-agent"], query: url.search });
		response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		response.end(PAGE);
		return;
	}
	response.writeHead(404);
	response.end();
});

server.listen(PORT, "127.0.0.1", () => {
	record({ kind: "server-start", port: PORT });
	console.log(`proto server on http://127.0.0.1:${PORT}/`);
});
