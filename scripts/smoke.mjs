// M0 smoke test: drive one real turn through the server's SSE endpoint and
// print the observable mechanics (context size, tool calls, usage / cache).
//
//   node scripts/smoke.mjs "your task"
//
const BASE = process.env.BASE ?? "http://localhost:8787";

function handleFrame(frame) {
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  const e = JSON.parse(data);
  switch (e.type) {
    case "turn.start":
      console.log("▶ turn.start");
      break;
    case "context.compiled":
      console.log(
        `  context: messages=${e.messages.length} tools=[${e.tools.join(", ")}] ` +
          `estTokens=${e.breakdown.estimatedTokens}`,
      );
      break;
    case "request.sent":
      console.log(`  request: model=${e.model}`);
      break;
    case "text.delta":
      process.stdout.write(e.text);
      break;
    case "assistant.message":
      console.log(
        `\n  assistant: tool_calls=${e.message.tool_calls?.length ?? 0}`,
      );
      break;
    case "permission.decision":
      console.log(`  permission: ${e.decision} (${e.reason})`);
      break;
    case "tool.call":
      console.log(`  → tool.call ${e.name} ${JSON.stringify(e.input)}`);
      break;
    case "tool.result":
      console.log(
        `  ← tool.result ${e.name} isError=${e.isError} ` +
          `dur=${e.durationMs}ms\n     ${e.output.slice(0, 400).replace(/\n/g, "\n     ")}`,
      );
      break;
    case "usage": {
      const d = e.usage.prompt_tokens_details ?? {};
      console.log(
        `  usage: prompt=${e.usage.prompt_tokens} completion=${e.usage.completion_tokens} ` +
          `cached=${d.cached_tokens ?? 0} cache_write=${d.cache_write_tokens ?? 0}`,
      );
      break;
    }
    case "turn.end":
      console.log(`■ turn.end ${e.reason}${e.error ? ` error=${e.error}` : ""}`);
      break;
    default:
      console.log(`  ${e.type}`);
  }
}

async function main() {
  const input =
    process.argv.slice(2).join(" ") ||
    "Summarize what this directory contains.";

  const session = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "smoke" }),
  }).then((r) => r.json());
  console.log(`session: ${session.id}`);

  const res = await fetch(`${BASE}/api/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok || !res.body) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
