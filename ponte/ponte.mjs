#!/usr/bin/env node
// Ponte Elízium: liga o OpenCode deste computador ao app Elízium do iPhone, de qualquer rede, sem VPN.
//
// Modo transmissor (padrão): iPhone ──WS cifrado de ponta a ponta──> Transmissor Elízium ──> ponte ──> opencode serve
// Modo túnel (--tunel):         iPhone ──HTTPS──> túnel rápido Cloudflare ──> ponte ──> opencode serve
//
// - No modo transmissor, iPhone e computador combinam chaves (X25519) e cifram tudo (ChaCha20-Poly1305);
//   o transmissor só repassa bytes. O endereço é fixo e o pareamento vale para sempre (veja transmissor.mjs).
// - O OpenCode só escuta em 127.0.0.1, com uma senha interna que nunca sai deste computador.
// - O iPhone usa a chave de pareamento da ponte (Authorization: Bearer <chave>).
// - Os eventos ao vivo do OpenCode (SSE) não atravessam o túnel rápido da Cloudflare, então a ponte
//   escuta esses eventos aqui e entrega por consulta longa: GET /ponte/eventos?depois=N&espera=25.
// - Todo o resto é repassado ao OpenCode como está (API documentada em /doc).
//
// Uso:  node ponte.mjs [pasta-do-projeto] [--transmissor URL] [--tunel] [--porta 4096] [--opencode caminho] [--cloudflared caminho]
//       O transmissor também pode vir de ELIZIUM_TRANSMISSOR ou de ~/.elizium-ponte/config.json {"transmissor": "…"}.
// Créditos: OpenCode (anomalyco/opencode, MIT) e cloudflared (Cloudflare). A ponte não altera o OpenCode.

import { spawn, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHTTPServer } from "node:http";
import { createServer } from "node:net";
import { homedir, hostname, platform } from "node:os";
import { join, resolve } from "node:path";
import qrcode from "qrcode-terminal";
import { loadIdentity, newPairingCode, startRelay } from "./transmissor.mjs";

const VERSION = "0.3.0";
/** Transmissor oficial (fica vazio até ser publicado; aí a ponte usa o túnel). */
const DEFAULT_RELAY = "";
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));

const isWindows = platform() === "win32";

if (args.includes("--codigo")) {
  // Shows the pairing link of the bridge that is already running (e.g. started at login).
  try {
    const p = JSON.parse(readFileSync(join(homedir(), ".elizium-ponte", "pareamento.json"), "utf8"));
    try { execFileSync(isWindows ? "clip" : "pbcopy", { input: p.link }); console.log("Link copiado para a área de transferência."); } catch {}
    qrcode.generate(p.link, { small: true });
    console.log(p.codigo ? `Código: ${p.codigo}` : "", p.validoAte ? `(vale até ${new Date(p.validoAte).toLocaleTimeString()})` : "");
  } catch {
    console.error("A ponte ainda não está ligada neste computador.");
  }
  process.exit(0);
}
const projectDir = resolve(positional[0] ?? join(homedir(), "Projetos Elizium"));
if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true });

function findTool(name, extra) {
  const explicit = flag(name);
  if (explicit) return explicit;
  try {
    const lines = execFileSync(isWindows ? "where" : "which", [name], { encoding: "utf8" }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // On Windows, "where" lists an extensionless shell script first; Node can only start .cmd/.exe.
    const out = isWindows ? lines.find((l) => /\.(cmd|exe)$/i.test(l)) : lines[0];
    if (out) return out;
  } catch {}
  for (const p of extra) if (existsSync(p)) return p;
  return null;
}

const opencode = findTool("opencode", [
  join(homedir(), ".local/node/bin/opencode"),
  join(homedir(), ".opencode/bin/opencode"),
  join(process.env.APPDATA ?? "", "npm/opencode.cmd"),
]);
const cloudflared = findTool("cloudflared", [
  join(homedir(), ".local/bin/cloudflared"),
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
]);
if (!opencode) { console.error("Não achei o OpenCode. Instale com: npm install -g opencode-ai"); process.exit(1); }

const infoDir = join(homedir(), ".elizium-ponte");
mkdirSync(infoDir, { recursive: true });
let config = {};
try { config = JSON.parse(readFileSync(join(infoDir, "config.json"), "utf8")); } catch {}
const relayURL = args.includes("--tunel") ? "" : (flag("transmissor") ?? process.env.ELIZIUM_TRANSMISSOR ?? config.transmissor ?? DEFAULT_RELAY);
if (!relayURL && !cloudflared) { console.error("Não achei o cloudflared. Veja github.com/cloudflare/cloudflared/releases"); process.exit(1); }

function freePort(preferred) {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => { const t = createServer(); t.listen(0, "127.0.0.1", () => { const p = t.address().port; t.close(() => ok(p)); }); });
    s.listen(preferred, "127.0.0.1", () => s.close(() => ok(preferred)));
  });
}

const children = [];
function stopAll(code = 0) {
  for (const c of children) { try { c.kill(); } catch {} }
  process.exit(code);
}
process.on("SIGINT", () => { console.log("\nPonte desligada."); stopAll(0); });
process.on("SIGTERM", () => stopAll(0));

// 1. OpenCode, só em localhost, com senha interna.
const ocPort = await freePort(Number(flag("porta") ?? 4096));
const ocPassword = randomBytes(24).toString("base64url");
const ocAuth = "Basic " + Buffer.from(`opencode:${ocPassword}`).toString("base64");
const ocBase = `http://127.0.0.1:${ocPort}`;

console.log(`Ligando o OpenCode na pasta: ${projectDir}`);
// A .cmd on Windows runs through cmd.exe explicitly (shell: true with arguments is deprecated in Node 24).
const ocArgs = ["serve", "--port", String(ocPort), "--hostname", "127.0.0.1"];
const viaCmd = isWindows && /\.cmd$/i.test(opencode);
const server = spawn(viaCmd ? "cmd.exe" : opencode, viaCmd ? ["/d", "/s", "/c", opencode, ...ocArgs] : ocArgs, {
  cwd: projectDir,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: ocPassword, OPENCODE_SERVER_USERNAME: "opencode" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
children.push(server);
server.on("exit", (code) => { console.error(`O OpenCode parou (código ${code}).`); stopAll(1); });

let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  // Each try gives up after 5 s: a request made while OpenCode is still starting can hang forever.
  try { ready = (await fetch(`${ocBase}/session`, { headers: { Authorization: ocAuth }, signal: AbortSignal.timeout(5000) })).ok; } catch {}
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) { console.error("O OpenCode não respondeu em 3 minutos."); stopAll(1); }
console.log(`OpenCode pronto na porta ${ocPort}.`);

// 2. Eventos: escuta o SSE aqui e guarda numa fila numerada.
const events = [];           // { n, e }
let lastN = 0;
let waiters = [];
function pushEvent(e) {
  events.push({ n: ++lastN, e });
  if (events.length > 2000) events.splice(0, events.length - 2000);
  const w = waiters; waiters = [];
  for (const wake of w) wake();
}
async function followEvents() {
  for (;;) {
    try {
      const r = await fetch(`${ocBase}/event`, { headers: { Authorization: ocAuth, Accept: "text/event-stream" } });
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, cut); buf = buf.slice(cut + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (data) { try { pushEvent(JSON.parse(data)); } catch { pushEvent({ type: "raw", data }); } }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));   // reconecta
  }
}
followEvents();

// 3. A ponte: confere a chave de pareamento e repassa ao OpenCode.
const pairingKey = randomBytes(24).toString("base64url");
const keyBuf = Buffer.from(`Bearer ${pairingKey}`);
function authorized(req) {
  const h = Buffer.from(req.headers.authorization ?? "");
  return h.length === keyBuf.length && timingSafeEqual(h, keyBuf);
}
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const bridge = createHTTPServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { erro: "Chave de pareamento inválida." });
  const url = new URL(req.url, "http://ponte");

  if (url.pathname === "/ponte/info") {
    return json(res, 200, { ponte: VERSION, computador: name, sistema: platform(), pasta: projectDir, ultimoEvento: lastN });
  }
  if (url.pathname === "/ponte/eventos") {
    const after = Number(url.searchParams.get("depois") ?? lastN);
    const wait = Math.min(Number(url.searchParams.get("espera") ?? 25), 50) * 1000;
    const pick = () => events.filter((x) => x.n > after);
    if (pick().length === 0 && wait > 0) {
      await new Promise((ok) => {
        const t = setTimeout(ok, wait);
        waiters.push(() => { clearTimeout(t); ok(); });
        req.on("close", () => { clearTimeout(t); ok(); });
      });
    }
    const list = pick();
    return json(res, 200, { ultimo: lastN, eventos: list.map((x) => ({ n: x.n, ...x.e })) });
  }

  // Repasse ao OpenCode.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers, authorization: ocAuth, host: `127.0.0.1:${ocPort}` };
  delete headers["content-length"];
  delete headers["accept-encoding"];
  try {
    const r = await fetch(`${ocBase}${url.pathname}${url.search}`, {
      method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = {};
    r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(r.status, out);
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch (e) {
    json(res, 502, { erro: `O OpenCode não respondeu: ${e.message}` });
  }
});
const bridgePort = await freePort(ocPort + 1);
await new Promise((ok) => bridge.listen(bridgePort, "127.0.0.1", ok));

const name = hostname().replace(/\.local$/, "");

if (relayURL) {
  // 4a. Transmissor Elízium, cifrado de ponta a ponta.
  const identity = loadIdentity(infoDir);
  let code = newPairingCode();
  let codeExpires = Date.now() + 30 * 60 * 1000;
  const relayHTTP = relayURL.replace(/^ws/, "http").replace(/\/$/, "");
  const linkFor = () => `elizium://parear?r=${encodeURIComponent(relayHTTP)}&d=${identity.id}&p=${Buffer.from(identity.publicRaw).toString("base64url")}&c=${code}&n=${encodeURIComponent(name)}`;
  // pareamento.json always holds the current code, so "node ponte.mjs --codigo" can show it while the bridge runs.
  const writePairing = () => writeFileSync(join(infoDir, "pareamento.json"),
    JSON.stringify({ modo: "transmissor", transmissor: relayHTTP, computadorId: identity.id, codigo: code, validoAte: new Date(codeExpires).toISOString(),
                     computador: name, pasta: projectDir, link: linkFor(), criado: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const rotate = () => { code = newPairingCode(); codeExpires = Date.now() + 30 * 60 * 1000; writePairing(); };
  const pairing = {
    valid: (c) => typeof c === "string" && c.toUpperCase().replace(/[^A-Z0-9]/g, "") === code && Date.now() < codeExpires,
    used: rotate,
  };
  setInterval(() => { if (Date.now() >= codeExpires) rotate(); }, 60 * 1000);
  const handle = async (req) => {
    try {
      const r = await fetch(`http://127.0.0.1:${bridgePort}${req.p}`, {
        method: req.m ?? "GET",
        headers: { ...(req.h ?? {}), Authorization: `Bearer ${pairingKey}` },
        body: req.b ? Buffer.from(req.b, "base64") : undefined,
      });
      return { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "" }, body: Buffer.from(await r.arrayBuffer()) };
    } catch (e) {
      return { status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ erro: e.message })) };
    }
  };
  startRelay({
    relayURL: relayHTTP, identity, pairing, name, handle,
    phonesFile: join(infoDir, "celulares.json"),
    info: () => ({ ponte: VERSION, sistema: platform(), pasta: projectDir }),
    log: (m) => console.log(m),
  });
  writePairing();
  const link = linkFor();
  try {
    execFileSync(isWindows ? "clip" : "pbcopy", { input: link });
    console.log("\nO link de pareamento foi copiado. No iPhone, abra o Elízium e cole em Computadores, Parear.");
  } catch {}
  console.log("\nPara parear um iPhone novo, escaneie:\n");
  qrcode.generate(link, { small: true });
  console.log(`\nCódigo de pareamento: ${code} (vale 30 minutos e uma vez).`);
  console.log("iPhones já pareados conectam sozinhos, sem código. A conexão é cifrada de ponta a ponta.");
  console.log("Para encerrar, aperte Control-C.");
} else {
  // 4b. Túnel HTTPS da Cloudflare até a ponte (modo antigo).
  console.log("Abrindo o túnel seguro…");
  const tunnel = spawn(cloudflared, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${bridgePort}`], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(tunnel);
  tunnel.on("exit", (code) => { console.error(`O túnel caiu (código ${code}).`); stopAll(1); });
  const publicURL = await new Promise((ok) => {
    const timer = setTimeout(() => ok(null), 45000);
    const scan = (b) => { const m = b.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); ok(m[0]); } };
    tunnel.stdout.on("data", scan);
    tunnel.stderr.on("data", scan);
  });
  if (!publicURL) { console.error("O túnel não deu endereço em 45 segundos."); stopAll(1); }
  const link = `elizium://parear?u=${encodeURIComponent(publicURL)}&k=${encodeURIComponent(pairingKey)}&n=${encodeURIComponent(name)}`;
  writeFileSync(join(infoDir, "pareamento.json"),
    JSON.stringify({ modo: "tunel", url: publicURL, chave: pairingKey, computador: name, pasta: projectDir, link, local: `http://127.0.0.1:${bridgePort}`, criado: new Date().toISOString() }, null, 2),
    { mode: 0o600 });
  try {
    execFileSync(isWindows ? "clip" : "pbcopy", { input: link });
    console.log("\nO link de pareamento foi copiado. No iPhone, abra o Elízium e cole em Computadores, Parear.");
  } catch {}
  console.log("\nEscaneie com o iPhone para parear:\n");
  qrcode.generate(link, { small: true });
  console.log(`\nEndereço: ${publicURL}`);
  console.log("Quem tiver o link controla o OpenCode deste computador. Para encerrar, aperte Control-C.");
  console.log("A cada vez que a ponte liga, o endereço e a chave mudam.");
}
