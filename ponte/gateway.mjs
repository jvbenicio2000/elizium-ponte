// Tradutor da ponte: deixa o Claude Code usar modelos de outros provedores.
//
// O Claude Code fala a API de mensagens da Anthropic (POST /v1/messages). Com ANTHROPIC_BASE_URL apontando
// para cá, a ponte recebe cada pedido e:
// - repassa como está a provedores que já falam essa API (Anthropic, MiniMax e outros com @ai-sdk/anthropic);
// - traduz para a API de chat da OpenAI (/chat/completions) e traduz a resposta de volta, para os demais
//   (OpenAI, Google, xAI, Groq, DeepSeek, Kimi, OpenRouter, o OpenCode grátis…).
// As chaves são as que o OpenCode deste computador já guarda (as que o iPhone envia). Só escuta em 127.0.0.1
// e só atende quem traz o segredo guardado em ~/.elizium-ponte/gateway.json.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createHTTPServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

/** Endereço padrão da API de chat de cada pacote do AI SDK, quando o OpenCode não traz um. */
const OPENAI_BASES = {
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta/openai",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@ai-sdk/cohere": "https://api.cohere.ai/compatibility/v1",
  "@ai-sdk/deepseek": "https://api.deepseek.com",
  "@openrouter/ai-sdk-provider": "https://openrouter.ai/api/v1",
};

function portFree(port) {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

/**
 * resolve(providerID, modelID) → { kind: "anthropic" | "openai", base, key, model, npm, maxOutput } ou lança erro.
 * O porto e o segredo ficam guardados: assim o Claude Code do computador pode apontar para cá de forma fixa.
 */
export async function startGateway({ infoDir, resolve, log = () => {} }) {
  const file = join(infoDir, "gateway.json");
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
  const secret = saved.segredo ?? randomBytes(24).toString("base64url");
  let port = saved.porta ?? 47710;
  if (!(await portFree(port))) {
    port = 0;
    for (let p = 47711; p < 47790 && !port; p++) if (await portFree(p)) port = p;
  }
  writeFileSync(file, JSON.stringify({ porta: port, segredo: secret }, null, 2), { mode: 0o600 });

  const server = createHTTPServer(async (req, res) => {
    const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") || req.headers["x-api-key"];
    // O segredo vai no caminho: o Claude Code pode mandar o login dele no cabeçalho em vez do nosso token.
    const path = req.url.split("?")[0];
    const inPath = path.startsWith(`/s/${secret}/`);
    if (!inPath && auth !== secret) return fail(res, 401, "authentication_error", "Segredo da ponte inválido.");
    const m = path.replace(`/s/${secret}`, "").match(/^\/p\/([^/]+)\/v1\/messages(\/count_tokens)?$/);
    if (!m) {
      // Sondagens do Claude Code (HEAD /, GET /v1/models…): responde sem erro.
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [] }));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(res, 400, "invalid_request_error", "JSON inválido."); }
    if (m[2]) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(body).length / 4) }));
    }
    let target;
    try { target = await resolve(decodeURIComponent(m[1]), body.model); } catch (e) { return fail(res, 400, "invalid_request_error", e.message); }
    try {
      if (target.kind === "anthropic") await passThrough(req, res, body, target);
      else await viaOpenAI(res, body, target);
    } catch (e) {
      log(`Tradutor: ${e.message}`);
      if (!res.headersSent) fail(res, 502, "api_error", `O provedor não respondeu: ${e.message}`);
      else res.end();
    }
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return { port, secret, base: (provider) => `http://127.0.0.1:${port}/s/${secret}/p/${encodeURIComponent(provider)}` };
}

function fail(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function passThrough(req, res, body, t) {
  const base = (t.base || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");
  const official = /api\.anthropic\.com/.test(base);
  const headers = {
    "content-type": "application/json",
    "x-api-key": t.key,
    authorization: `Bearer ${t.key}`,
    "anthropic-version": req.headers["anthropic-version"] ?? "2023-06-01",
  };
  if (official && req.headers["anthropic-beta"]) headers["anthropic-beta"] = req.headers["anthropic-beta"];
  // A Anthropic entende as ferramentas adiadas do Claude Code; os outros que falam a API dela, não.
  const sent = official ? body : plainTools(body);
  const r = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ ...sent, model: t.model }) });
  const out = { "content-type": r.headers.get("content-type") ?? "application/json" };
  res.writeHead(r.status, out);
  if (r.body) for await (const c of r.body) res.write(c);
  res.end();
}

// --- Ferramentas adiadas ---
//
// O Claude Code não manda a descrição de todas as ferramentas a cada pedido: as menos usadas, e as dos servidores
// MCP do computador, vão só pelo nome, e o modelo pede a que quiser pela ferramenta ToolSearch. A resposta dessa
// busca não é texto: é um bloco "tool_reference" com o nome da ferramenta, e dali em diante ela vem na lista
// marcada com defer_loading. Quem entende isso é a API da Anthropic. Para os outros provedores a ponte faz o
// mesmo papel: a ferramenta adiada só aparece para o modelo depois que uma busca trouxe o nome dela, e o bloco
// vira uma frase.

/** Só existe para a API da Anthropic aceitar o pedido enquanto nenhuma ferramenta foi buscada. */
const PLACEHOLDER = "DeferredToolPlaceholder";

export function plainTools(b) {
  const defined = new Set((b.tools ?? []).map((x) => x.name));
  const loaded = new Set();
  const messages = (b.messages ?? []).map((m) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content) || !block.content.some((x) => x.type === "tool_reference")) return block;
      changed = true;
      return { ...block, content: block.content.map((x) => {
        if (x.type !== "tool_reference") return x;
        if (!defined.has(x.tool_name)) return { type: "text", text: `Tool found: ${x.tool_name}.` };
        loaded.add(x.tool_name);
        return { type: "text", text: `Tool loaded: ${x.tool_name}. You can call it now.` };
      }) };
    });
    return changed ? { ...m, content } : m;
  });
  const out = { ...b, messages };
  if (b.tools) {
    out.tools = b.tools.filter((x) => x.name !== PLACEHOLDER && (!x.defer_loading || loaded.has(x.name)))
      .map(({ defer_loading, ...x }) => x);
    if (!out.tools.length) { delete out.tools; delete out.tool_choice; }
  }
  return out;
}

// --- Anthropic → OpenAI ---

const textOf = (content) => typeof content === "string" ? content
  : (content ?? []).map((b) => b.type === "text" ? b.text : b.type === "image" ? "[imagem]" : "").filter(Boolean).join("\n");

function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== "$schema") out[k] = cleanSchema(v);
  return out;
}

export function toOpenAI(body, t) {
  const b = plainTools(body);
  const messages = [];
  const system = typeof b.system === "string" ? b.system : (b.system ?? []).map((x) => x.text ?? "").join("\n\n");
  if (system) messages.push({ role: "system", content: system });
  for (const m of b.messages ?? []) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []);
    if (m.role === "user") {
      for (const r of blocks.filter((x) => x.type === "tool_result")) {
        const text = textOf(r.content);
        messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: (r.is_error ? "Erro: " : "") + (text || "(sem saída)") });
      }
      const rest = blocks.filter((x) => x.type === "text" || x.type === "image");
      if (!rest.length) continue;
      if (rest.every((x) => x.type === "text")) messages.push({ role: "user", content: rest.map((x) => x.text).join("\n") });
      else messages.push({ role: "user", content: rest.map((x) => x.type === "text" ? { type: "text", text: x.text }
        : { type: "image_url", image_url: { url: x.source?.type === "base64" ? `data:${x.source.media_type};base64,${x.source.data}` : x.source?.url } }) });
    } else {
      const text = blocks.filter((x) => x.type === "text").map((x) => x.text).join("");
      const calls = blocks.filter((x) => x.type === "tool_use")
        .map((x) => ({ id: x.id, type: "function", function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) } }));
      if (!text && !calls.length) continue;
      // Duas falas seguidas do modelo (o Claude Code às vezes manda assim) viram uma só.
      const prev = messages.at(-1);
      if (prev?.role === "assistant" && !prev.tool_calls) {
        prev.content = [prev.content, text].filter(Boolean).join("\n") || null;
        if (calls.length) prev.tool_calls = calls;
        continue;
      }
      const msg = { role: "assistant", content: text || null };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
    }
  }
  const out = { model: t.model, messages };
  const tools = (b.tools ?? []).filter((x) => x.input_schema && x.name)
    .map((x) => ({ type: "function", function: { name: x.name, description: x.description ?? "", parameters: cleanSchema(x.input_schema) } }));
  if (tools.length) {
    out.tools = tools;
    const c = b.tool_choice;
    if (c?.type === "any") out.tool_choice = "required";
    else if (c?.type === "tool") out.tool_choice = { type: "function", function: { name: c.name } };
    else if (c?.type === "none") out.tool_choice = "none";
  }
  if (b.max_tokens) {
    const max = t.maxOutput ? Math.min(b.max_tokens, t.maxOutput) : b.max_tokens;
    out[t.npm === "@ai-sdk/openai" ? "max_completion_tokens" : "max_tokens"] = max;
  }
  if (typeof b.temperature === "number") out.temperature = b.temperature;
  if (b.stop_sequences?.length) out.stop = b.stop_sequences.slice(0, 4);
  return out;
}

const stopReason = (f) => f === "tool_calls" || f === "function_call" ? "tool_use" : f === "length" ? "max_tokens" : "end_turn";
const msgID = () => "msg_ponte_" + randomBytes(12).toString("hex");

async function viaOpenAI(res, b, t) {
  const req = toOpenAI(b, t);
  const stream = b.stream === true;
  if (stream) { req.stream = true; req.stream_options = { include_usage: true }; }
  const base = (t.base || OPENAI_BASES[t.npm] || "").replace(/\/+$/, "");
  if (!base) throw new Error(`não sei o endereço do provedor (${t.npm})`);
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${t.key}` },
    body: JSON.stringify(req),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 800);
    let message = detail;
    try { const j = JSON.parse(detail); message = j.error?.message ?? j.message ?? detail; } catch {}
    // Cota acabada não passa esperando: devolve como erro comum para o Claude Code não tentar dez vezes.
    const quota = /FreeUsageLimit|insufficient_quota|limit reached|quota/i.test(detail);
    if (quota) return fail(res, 400, "invalid_request_error", `${t.model}: ${message}`);
    const type = r.status === 429 ? "rate_limit_error" : r.status === 401 || r.status === 403 ? "authentication_error" : r.status >= 500 ? "api_error" : "invalid_request_error";
    return fail(res, r.status, type, `${t.model}: ${message}`);
  }
  if (!stream) {
    const j = await r.json();
    const msg = j.choices?.[0]?.message ?? {};
    const content = [];
    if (msg.content) content.push({ type: "text", text: msg.content });
    for (const c of msg.tool_calls ?? []) {
      let input = {};
      try { input = JSON.parse(c.function?.arguments || "{}"); } catch {}
      content.push({ type: "tool_use", id: c.id || "toolu_" + randomBytes(8).toString("hex"), name: c.function?.name, input });
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      id: msgID(), type: "message", role: "assistant", model: t.model, content,
      stop_reason: stopReason(j.choices?.[0]?.finish_reason), stop_sequence: null,
      usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
    }));
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", { message: { id: msgID(), type: "message", role: "assistant", model: t.model, content: [],
                                     stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1;
  let open = null;              // { kind: "text" } | { kind: "tool", call }
  let finish = null;
  let usage = { input: 0, output: 0 };
  const close = () => { if (open) { send("content_block_stop", { index }); open = null; } };
  const handle = (chunk) => {
    if (chunk.usage) usage = { input: chunk.usage.prompt_tokens ?? usage.input, output: chunk.usage.completion_tokens ?? usage.output };
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      if (open?.kind !== "text") { close(); index++; open = { kind: "text" }; send("content_block_start", { index, content_block: { type: "text", text: "" } }); }
      send("content_block_delta", { index, delta: { type: "text_delta", text: d.content } });
    }
    for (const c of d.tool_calls ?? []) {
      const call = c.index ?? 0;
      if (open?.kind !== "tool" || open.call !== call) {
        close(); index++; open = { kind: "tool", call };
        send("content_block_start", { index, content_block: { type: "tool_use", id: c.id || "toolu_" + randomBytes(8).toString("hex"), name: c.function?.name ?? "", input: {} } });
      }
      if (c.function?.arguments) send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: c.function.arguments } });
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const piece of r.body) {
    buf += decoder.decode(piece, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, cut).trim(); buf = buf.slice(cut + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try { handle(JSON.parse(data)); } catch {}
    }
  }
  close();
  send("message_delta", { delta: { stop_reason: stopReason(finish), stop_sequence: null },
                          usage: { input_tokens: usage.input, output_tokens: usage.output } });
  send("message_stop", {});
  res.end();
}
