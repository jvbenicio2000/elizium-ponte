// Teste do corte de modelo empacado: o Claude Code de verdade → o tradutor da ponte → um provedor de mentira que repete.
// Uso: node teste-repeticao.mjs <caminho do claude> [uma|sempre]
//   uma (padrão): o provedor repete só no primeiro pedido e responde direito no seguinte.
//   sempre: repete em todos os pedidos.
// Não chama serviço nenhum e não toca na configuração do Claude Code (usa uma pasta de configuração vazia, à parte).
// Mostra como o Claude Code instalado reage ao corte; não prova nada sobre um provedor de verdade.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [claude, modo = "uma"] = process.argv.slice(2);
if (!claude) { console.log("Uso: node teste-repeticao.mjs <caminho do claude> [uma|sempre]"); process.exit(2); }
const { startGateway, loopWatch } = await import(new URL("./gateway.mjs", import.meta.url).href);

// O detector sozinho: texto comum não corta, repetição corta.
const cut = (text) => { const w = loopWatch(); for (let i = 0; i < text.length; i += 7) if (w(text.slice(i, i + 7))) return true; return false; };
const comum = Array.from({ length: 900 }, (_, i) => `Esta é a frase número ${i} de um texto comum, que muda a cada linha.`).join(" ");
const lista = Array.from({ length: 600 }, (_, i) => `- item ${i}: ok`).join("\n");
const laco = "Vou responder. " + Array.from({ length: 3000 }, (_, i) => ["Ok.", "Done.", "Emit.", "Final.", "Output."][i % 5]).join(" ");
console.log(`detector: texto comum ${cut(comum) ? "CORTOU (errado)" : "passa"}, lista ${cut(lista) ? "CORTOU (errado)" : "passa"}, repetição ${cut(laco) ? "corta" : "NÃO CORTOU (errado)"}`);

const seen = [];
const fake = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let b = {};
  try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
  const entry = { fluxo: b.stream === true, repetiu: false, pedacos: 0, cortadoPeloTradutor: false };
  const n = seen.push(entry);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const text = (t) => send({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
  if (modo === "sempre" || n === 1) {
    entry.repetiu = true;
    let closed = false;
    res.on("close", () => { closed = true; });
    text("Vou pensar no que foi pedido. O usuário quer uma resposta curta. ");
    for (let i = 0; i < 6000 && !closed; i++) {
      text(["Ok. ", "Done. ", "Emit. ", "Final. ", "Output.\n"][i % 5]);
      entry.pedacos = i + 1;
      if (i % 20 === 0) await new Promise((ok) => setTimeout(ok, 2));
    }
    entry.cortadoPeloTradutor = closed;
    if (closed) return;
    send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
  } else {
    text("Resposta limpa da segunda tentativa.");
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  }
  send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
const dir = mkdtempSync(join(tmpdir(), "teste-repeticao-"));
const gateway = await startGateway({ infoDir: dir, log: (t) => console.log("tradutor diz:", t),
  resolve: async () => ({ kind: "openai", base: `http://127.0.0.1:${fake.address().port}`, npm: "x", key: "teste", model: "modelo-de-teste", maxOutput: 16384 }) });

const model = "modelo-de-teste";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|ENABLE_TOOL_SEARCH)/.test(k)));
env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "teste-repeticao-config-"));
const settingsEnv = { ANTHROPIC_BASE_URL: gateway.base("prova"), ANTHROPIC_AUTH_TOKEN: gateway.secret, ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: model,
  ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model, ENABLE_TOOL_SEARCH: "true" };
Object.assign(env, settingsEnv);
const settings = join(dir, "ajustes.json");
writeFileSync(settings, JSON.stringify({ env: settingsEnv }));
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio",
              "--permission-mode", "default", "--session-id", randomUUID(), "--model", model, "--settings", settings];
const viaCmd = process.platform === "win32" && /\.cmd$/i.test(claude);
const started = Date.now();
const child = spawn(viaCmd ? "cmd.exe" : claude, viaCmd ? ["/d", "/s", "/c", claude, ...args] : args, { cwd: dir, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Diga ok." } }) + "\n");
child.stdin.end();
const code = await new Promise((ok) => { child.on("close", ok); child.on("error", () => ok(-1)); setTimeout(() => { try { child.kill(); } catch {} }, 240000); });
console.log(`modo ${modo}: Claude Code saiu com ${code} depois de ${Math.round((Date.now() - started) / 1000)} s; o provedor de mentira recebeu ${seen.length} pedido(s)`);
seen.forEach((s, i) => console.log(`pedido ${i + 1}: ${s.repetiu ? `repetiu, ${s.pedacos} pedaços enviados, ${s.cortadoPeloTradutor ? "cortado pelo tradutor" : "foi até o fim"}` : "respondeu direito"}`));
const lines = out.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
for (const j of lines.filter((j) => j.type === "assistant")) {
  const texts = (j.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
  console.log(`fala do agente: ${texts.join("").length} letras; começo ${JSON.stringify(texts.join("").slice(0, 70))}; fim ${JSON.stringify(texts.join("").slice(-160))}`);
}
const result = lines.find((j) => j.type === "result");
console.log("resultado final do Claude Code:", result ? `${result.subtype}, erro ${result.is_error}, texto ${JSON.stringify(String(result.result).slice(0, 220))}` : "nenhum");
fake.close();
process.exit(0);
