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
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open as openFile, readFile, readdir, stat } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createServer } from "node:net";
import { homedir, hostname, platform } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import qrcode from "qrcode-terminal";
import { loadIdentity, newPairingCode, startRelay } from "./transmissor.mjs";
import { createClaudeCode } from "./claudecode.mjs";
import { startGateway } from "./gateway.mjs";
import { createLocais } from "./locais.mjs";

const VERSION = "0.10.0";
/** Transmissor oficial (fica vazio até ser publicado; aí a ponte usa o túnel). */
const DEFAULT_RELAY = "https://elizium-transmissor.elizium-transmissor.workers.dev";
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
// Claude Code (opcional): o segundo agente que o app pode escolher.
const claudeBin = findTool("claude", [
  join(homedir(), ".local/bin/claude"),
  join(homedir(), ".local/bin/claude.exe"),
  join(homedir(), ".claude/local/claude"),
  join(process.env.APPDATA ?? "", "npm/claude.cmd"),
]);
if (!opencode) { console.error("Não achei o OpenCode. Instale com: npm install -g opencode-ai"); process.exit(1); }

const infoDir = process.env.ELIZIUM_PONTE_DIR ?? join(homedir(), ".elizium-ponte");
mkdirSync(infoDir, { recursive: true });
let config = {};
try { config = JSON.parse(readFileSync(join(infoDir, "config.json"), "utf8")); } catch {}

// Política da empresa: regras do administrador que valem para toda sessão aberta pela ponte e ficam por
// último, então vencem as do app (no OpenCode a última regra que casa é a que vale). A cópia do sistema,
// que só o administrador pode gravar, tem prioridade sobre a da pasta do usuário.
const systemPolicy = isWindows
  ? join(process.env.ProgramData ?? "C:\\ProgramData", "Elizium", "politica.json")
  : platform() === "darwin" ? "/Library/Application Support/Elizium/politica.json" : "/etc/elizium/politica.json";
const userPolicy = join(infoDir, "politica.json");
if (flag("politica")) {
  const p = JSON.parse(readFileSync(flag("politica"), "utf8"));
  if (!p.empresa || !Array.isArray(p.regras)) { console.error("A política precisa de \"empresa\" e de uma lista \"regras\"."); process.exit(1); }
  copyFileSync(flag("politica"), userPolicy);
  console.log(`Política de ${p.empresa} instalada (${p.regras.length} regras). Ela vale a partir da próxima mensagem.`);
  process.exit(0);
}
if (args.includes("--sem-politica")) {
  rmSync(userPolicy, { force: true });
  console.log(existsSync(systemPolicy) ? `Ainda vale a política do sistema em ${systemPolicy}.` : "Política removida.");
  process.exit(0);
}
let policyCache = { file: null, mtime: 0, value: null };
function policy() {
  const file = existsSync(systemPolicy) ? systemPolicy : existsSync(userPolicy) ? userPolicy : null;
  if (!file) return null;
  try {
    const mtime = statSync(file).mtimeMs;
    if (policyCache.file !== file || policyCache.mtime !== mtime) {
      const p = JSON.parse(readFileSync(file, "utf8"));
      const regras = (Array.isArray(p.regras) ? p.regras : []).filter((r) => r && r.permission && r.pattern && ["allow", "deny", "ask"].includes(r.action));
      policyCache = { file, mtime, value: { empresa: String(p.empresa ?? ""), administrador: String(p.administrador ?? ""), regras, sistema: file === systemPolicy,
                                           ...(p.claudeCode === false ? { claudeCode: false } : {}), ...(p.memorias === false ? { memorias: false } : {}) } };
    }
    return policyCache.value;
  } catch {
    // Política ilegível: fecha tudo em vez de liberar.
    return { empresa: "?", administrador: "", regras: [{ permission: "*", pattern: "*", action: "deny" }], sistema: file === systemPolicy, erro: "Política ilegível",
             claudeCode: false, memorias: false };
  }
}
const sameRule = (a, b) => a.permission === b.permission && a.pattern === b.pattern && a.action === b.action;
const endsWith = (list, tail) => tail.length <= list.length && tail.every((r, i) => sameRule(list[list.length - tail.length + i], r));
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

// 2b. Claude Code e o tradutor de modelos que ele usa para falar com outros provedores.
const openCodeJSON = async (path) => {
  const r = await fetch(`${ocBase}${path}`, { headers: { Authorization: ocAuth } });
  if (!r.ok) throw new Error(`OpenCode respondeu ${r.status}`);
  return r.json();
};
let claudeCode;
const gateway = await startGateway({ infoDir, resolve: (p, m) => claudeCode.resolve(p, m), log: (m) => console.log(m) });
claudeCode = createClaudeCode({ claude: claudeBin, projectDir, infoDir, isWindows, pushEvent, policy, gateway, openCode: openCodeJSON });
console.log(claudeBin ? `Claude Code: ${claudeBin}` : "Claude Code não encontrado (o app usa só o OpenCode).");

// 2c. Modelos que rodam neste computador (Ollama, LM Studio e parecidos), para a aba Conversas do app.
const locais = createLocais({ config, log: (m) => console.log(m) });

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

// Arquivos que o iPhone manda salvar (relatórios de conversa), em pedaços para caber nas mensagens do transmissor.
// Só grava dentro da pasta do usuário e nunca sobrescreve: acrescenta " (2)", " (3)"…
const uploads = new Map();   // envio → { partes, total, criado }

// No Mac, as pastas Documentos, Mesa e Transferências só abrem depois que a pessoa responde, na tela do computador,
// a uma pergunta do sistema, e até lá a chamada que toca a pasta fica parada. A ponte toca a pasta fora da linha
// principal: quem espera a resposta é só essa sonda, e um arquivo que chegue antes dela é recusado com a explicação,
// em vez de travar a ponte inteira.
const PASTAS_DO_MAC = { Documents: "Documentos", Desktop: "Mesa", Downloads: "Transferências" };
const sondas = new Map();   // pasta → { estado: "esperando" | "liberada" | "negada", fim }
function sondar(raiz) {
  let s = sondas.get(raiz);
  if (s && s.estado !== "negada") return s;   // a negada é tentada de novo: a pessoa pode ter liberado nos Ajustes
  s = { estado: "esperando" };
  s.fim = readdir(raiz).then(() => "liberada", (e) => (e.code === "EPERM" || e.code === "EACCES" ? "negada" : "liberada"))
    .then((estado) => { s.estado = estado; });
  sondas.set(raiz, s);
  return s;
}
async function conferirPastaDoMac(dir) {
  if (platform() !== "darwin") return;
  const [primeira] = relative(homedir(), dir).split(sep);
  if (!Object.hasOwn(PASTAS_DO_MAC, primeira)) return;
  const nome = PASTAS_DO_MAC[primeira];
  const s = sondar(join(homedir(), primeira));
  await Promise.race([s.fim, new Promise((ok) => setTimeout(ok, 1500))]);
  if (s.estado === "esperando") throw new Error(`O Mac está perguntando, na tela dele, se a ponte pode usar a pasta ${nome}. Escolha Permitir no computador e mande o arquivo de novo.`);
  if (s.estado === "negada") throw new Error(`O Mac não deixa a ponte usar a pasta ${nome}. Libere em Ajustes do Sistema, Privacidade e Segurança, Arquivos e Pastas, e mande o arquivo de novo.`);
}

async function receivePiece({ envio, pasta, nome, parte, total, dados, destino }) {
  if (typeof envio !== "string" || typeof nome !== "string" || !Number.isInteger(parte) || !Number.isInteger(total)
      || total < 1 || total > 400 || parte < 0 || parte >= total || typeof dados !== "string") throw new Error("Pedido de arquivo inválido.");
  const home = homedir();
  // Anexos da conversa ficam numa pasta fixa, que o modelo consegue ler (as regras de leitura não bloqueiam).
  if (destino === "anexo") pasta = join(home, "Documents", "Elízium", "Anexos");
  const dir = resolve(isAbsolute(pasta ?? "") ? pasta : join(home, pasta || "Documents/Elízium"));
  const rel = relative(home, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("A pasta precisa ficar dentro da pasta do usuário deste computador.");
  await conferirPastaDoMac(dir);   // antes de aceitar o pedaço: o aviso chega no primeiro, não depois do arquivo inteiro
  for (const [k, u] of uploads) if (Date.now() - u.criado > 10 * 60 * 1000) uploads.delete(k);
  const u = uploads.get(envio) ?? { partes: new Map(), total, criado: Date.now() };
  uploads.set(envio, u);
  u.partes.set(parte, Buffer.from(dados, "base64"));
  if (u.partes.size < u.total) return { recebido: u.partes.size, total: u.total };
  uploads.delete(envio);
  mkdirSync(dir, { recursive: true });
  const clean = basename(nome).replace(/[\/\\?%*:|"<>\x00-\x1f]/g, "-").trim() || "Elizium";
  const ext = extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let path = join(dir, clean);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem} (${n})${ext}`);
  writeFileSync(path, Buffer.concat([...Array(u.total).keys()].map((i) => u.partes.get(i))), { flag: "wx" });
  console.log(`Arquivo salvo pelo iPhone: ${path}`);
  const out = { caminho: path, url: pathToFileURL(path).href };
  // Word, Excel e PowerPoint viram texto ao lado do original, para qualquer modelo conseguir ler.
  if (destino === "anexo") {
    try {
      const text = officeText(readFileSync(path), ext.toLowerCase());
      if (text) {
        const textPath = path + ".txt";
        writeFileSync(textPath, text);
        out.texto = textPath;
        out.textoUrl = pathToFileURL(textPath).href;
      }
    } catch (e) {
      out.avisoTexto = `Não consegui tirar o texto do arquivo: ${e.message}`;
    }
  }
  return out;
}

// Lê um .zip (formato dos arquivos do Office) sem dependências: diretório central + inflate.
function unzip(buf) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = buf.lastIndexOf(sig);
  if (end < 0) throw new Error("não é um arquivo do Office (zip)");
  const count = buf.readUInt16LE(end + 10);
  let off = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, () => (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    off += 46 + nlen + elen + clen;
  }
  return files;
}
const xmlText = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const byNumber = (a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

function officeText(buf, ext) {
  if (![".docx", ".xlsx", ".pptx"].includes(ext)) return null;
  const files = unzip(buf);
  if (ext === ".docx") {
    const xml = files.get("word/document.xml")?.() ?? "";
    return xmlText(xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<w:br\/>/g, "\n")).trim();
  }
  if (ext === ".pptx") {
    const slides = [...files.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
    return slides.map((n, i) => `--- Slide ${i + 1} ---\n` + xmlText(files.get(n)().replace(/<\/a:p>/g, "\n")).trim()).join("\n\n");
  }
  // .xlsx: textos compartilhados + células de cada planilha, separadas por tabulação.
  const shared = [...(files.get("xl/sharedStrings.xml")?.() ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const names = [...(files.get("xl/workbook.xml")?.() ?? "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => xmlText(m[1]));
  const sheets = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
  return sheets.map((n, i) => {
    const rows = [...files.get(n)().matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
      [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const attrs = c[1], inner = c[2] ?? "";
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (/t="s"/.test(attrs) && v !== undefined) return shared[Number(v)] ?? "";
        if (/t="inlineStr"/.test(attrs)) return xmlText(inner);
        return v !== undefined ? xmlText(v) : "";
      }).join("\t"));
    return `--- Planilha: ${names[i] ?? i + 1} ---\n` + rows.join("\n");
  }).join("\n\n");
}

// Memórias dos agentes (0.10.0): os textos que o Claude Code e o OpenCode guardam neste computador sobre a pessoa e
// os projetos (instruções e memória). O app mostra a lista, a pessoa escolhe no celular quais entram nas conversas
// e só então o app pede o texto de cada uma. Só leitura. A política da empresa fecha com "memorias": false.
const MEM_LETRAS_ARQUIVO = 24000;
const MEM_LETRAS_FONTE = 80000;
const MEM_ARQUIVOS = 40;
const MEM_FONTES = 60;

async function memoryFile(path, nome) {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > 2_000_000) return null;
    const full = (await readFile(path, "utf8")).replace(/\u0000/g, "").trim();
    if (!full) return null;
    return { nome, texto: full.slice(0, MEM_LETRAS_ARQUIVO), cortado: full.length > MEM_LETRAS_ARQUIVO, alterado: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

/** A pasta de verdade de um projeto do Claude Code (o nome da pasta do histórico troca tudo por "-"). */
async function claudeProjectFolder(dir, key) {
  try {
    const first = (await readdir(dir)).find((n) => n.endsWith(".jsonl"));
    if (first) {
      const fh = await openFile(join(dir, first), "r");
      try {
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(65536), 0, 65536, 0);
        const m = buffer.toString("utf8", 0, bytesRead).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) {
          const cwd = JSON.parse(`"${m[1]}"`);
          const rel = relative(homedir(), cwd);
          return rel === "" ? "pasta do usuário" : rel.startsWith("..") || isAbsolute(rel) ? cwd : rel;
        }
      } finally {
        await fh.close();
      }
    }
  } catch {}
  return key.replace(/^-+/, "").split("-").filter(Boolean).pop() ?? key;
}

/** Todas as fontes de memória deste computador, cada uma com seus arquivos já cortados no limite. */
async function agentMemories() {
  const fontes = [];
  const add = (id, agente, nome, arquivos) => {
    const list = [];
    let room = MEM_LETRAS_FONTE;
    for (const a of arquivos.filter(Boolean)) {
      if (room <= 0 || list.length >= MEM_ARQUIVOS) break;
      if (a.texto.length > room) { a.texto = a.texto.slice(0, room); a.cortado = true; }
      room -= a.texto.length;
      list.push(a);
    }
    if (list.length) fontes.push({ id, agente, nome, alterado: Math.max(...list.map((a) => a.alterado)), letras: list.reduce((n, a) => n + a.texto.length, 0), arquivos: list });
  };
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const projeto = basename(projectDir);
  add("claude:instrucoes", "claude", "Instruções do Claude Code", [await memoryFile(join(claudeDir, "CLAUDE.md"), "CLAUDE.md")]);
  add("opencode:instrucoes", "opencode", "Instruções do OpenCode", [await memoryFile(join(homedir(), ".config", "opencode", "AGENTS.md"), "AGENTS.md")]);
  // A pasta do projeto pode estar numa pasta que o Mac ainda não liberou: aí fica de fora, sem travar.
  let projectOpen = true;
  try { await conferirPastaDoMac(projectDir); } catch { projectOpen = false; }
  if (projectOpen) {
    add("claude:projeto", "claude", `Instruções do projeto ${projeto} para o Claude Code`,
      [await memoryFile(join(projectDir, "CLAUDE.md"), "CLAUDE.md"), await memoryFile(join(projectDir, ".claude", "CLAUDE.md"), ".claude/CLAUDE.md")]);
    add("opencode:projeto", "opencode", `Instruções do projeto ${projeto} para o OpenCode`, [await memoryFile(join(projectDir, "AGENTS.md"), "AGENTS.md")]);
  }
  let keys = [];
  try { keys = (await readdir(join(claudeDir, "projects"), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  const memorias = [];
  for (const key of keys) {
    const dir = join(claudeDir, "projects", key);
    let names = [];
    try { names = (await readdir(join(dir, "memory"))).filter((n) => /\.md$/i.test(n)); } catch { continue; }
    if (!names.length) continue;
    names.sort((a, b) => (a === "MEMORY.md" ? -1 : b === "MEMORY.md" ? 1 : a.localeCompare(b)));   // o índice primeiro
    const files = [];
    for (const n of names.slice(0, MEM_ARQUIVOS)) files.push(await memoryFile(join(dir, "memory", n), n));
    const before = fontes.length;
    add(`claude:memoria:${key}`, "claude", `Memória do Claude Code: ${await claudeProjectFolder(dir, key)}`, files);
    if (fontes.length > before) memorias.push(fontes.pop());
  }
  memorias.sort((a, b) => b.alterado - a.alterado);   // as mexidas por último vêm primeiro
  return [...fontes, ...memorias].slice(0, MEM_FONTES);
}

const bridge = createHTTPServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, { erro: "Chave de pareamento inválida." });
  const url = new URL(req.url, "http://ponte");

  if (url.pathname === "/ponte/info") {
    const p = policy();
    return json(res, 200, { ponte: VERSION, computador: name, sistema: platform(), pasta: projectDir, ultimoEvento: lastN,
                            agentes: ["opencode", "claude"], claude: claudeCode.info(), locais: true, memorias: p?.memorias !== false,
                            politica: p ? { empresa: p.empresa, administrador: p.administrador, regras: p.regras, sistema: p.sistema } : null });
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
  if (url.pathname.startsWith("/claude/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return await claudeCode.handle(req, res, url.pathname.slice("/claude".length), Buffer.concat(chunks), json);
    } catch (e) {
      return json(res, 500, { erro: e.message });
    }
  }
  if (url.pathname === "/ponte/locais" || url.pathname.startsWith("/ponte/locais/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return await locais.handle(req, res, url, Buffer.concat(chunks), json);
    } catch (e) {
      return json(res, 500, { erro: e.message });
    }
  }
  if (url.pathname === "/ponte/memorias" && req.method === "GET") {
    const p = policy();
    if (p?.memorias === false) return json(res, 403, { erro: `A política de ${p.empresa} não libera as memórias dos agentes neste computador.` });
    try {
      const fontes = await agentMemories();
      const id = url.searchParams.get("fonte");
      if (id === null) return json(res, 200, { fontes: fontes.map(({ arquivos, ...f }) => ({ ...f, arquivos: arquivos.length })) });
      const fonte = fontes.find((f) => f.id === id);
      return fonte ? json(res, 200, { fonte }) : json(res, 404, { erro: "Essa memória não existe mais neste computador." });
    } catch (e) {
      return json(res, 500, { erro: e.message });
    }
  }
  if (url.pathname === "/ponte/arquivo" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try {
      return json(res, 200, await receivePiece(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    } catch (e) {
      return json(res, 400, { erro: e.message });
    }
  }

  // Repasse ao OpenCode.
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers, authorization: ocAuth, host: `127.0.0.1:${ocPort}` };
  delete headers["content-length"];
  delete headers["accept-encoding"];
  let body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
  const p = policy();
  const sessionMatch = url.pathname.match(/^\/session\/([^/]+)(\/(prompt_async|message|command|shell))?$/);
  if (p && p.regras.length && body && body.length) {
    try {
      const j = JSON.parse(body.toString("utf8"));
      // "tools" troca as regras da sessão inteira: com política, ninguém passa por cima dela assim.
      if (sessionMatch?.[2] && "tools" in j) delete j.tools;
      // Regras novas vindas do app: a política vai junto, no fim.
      if (req.method === "PATCH" && sessionMatch && !sessionMatch[2] && Array.isArray(j.permission)) j.permission = [...j.permission, ...p.regras];
      body = Buffer.from(JSON.stringify(j));
    } catch {}
  }
  // Antes de cada mensagem, garante que a política está no fim das regras da sessão.
  if (p && p.regras.length && sessionMatch?.[2] && req.method === "POST") {
    try { await enforcePolicy(sessionMatch[1], p); } catch (e) { return json(res, 502, { erro: `Não consegui aplicar a política da empresa: ${e.message}` }); }
  }
  try {
    const r = await fetch(`${ocBase}${url.pathname}${url.search}`, { method: req.method, headers, body });
    // Sessão nova: já nasce com a política.
    if (p && p.regras.length && req.method === "POST" && url.pathname === "/session" && r.ok) {
      const text = await r.text();
      try { await enforcePolicy(JSON.parse(text).id, p); } catch {}
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      return res.end(text);
    }
    const out = {};
    r.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(r.status, out);
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch (e) {
    json(res, 502, { erro: `O OpenCode não respondeu: ${e.message}` });
  }
});
async function enforcePolicy(id, p) {
  const r = await fetch(`${ocBase}/session/${encodeURIComponent(id)}`, { headers: { Authorization: ocAuth } });
  if (!r.ok) throw new Error(`sessão ${id} não encontrada`);
  const current = (await r.json()).permission ?? [];
  if (endsWith(current, p.regras)) return;
  const u = await fetch(`${ocBase}/session/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { Authorization: ocAuth, "content-type": "application/json" }, body: JSON.stringify({ permission: p.regras }),
  });
  if (!u.ok) throw new Error(`OpenCode recusou (${u.status})`);
}
const bridgePort = await freePort(ocPort + 1);
await new Promise((ok) => bridge.listen(bridgePort, "127.0.0.1", ok));

// A pergunta do Mac sobre a pasta Documentos vem já na partida, com a pessoa ainda no computador, e não quando o
// primeiro arquivo chegar do celular.
if (platform() === "darwin") {
  const s = sondar(join(homedir(), "Documents"));
  setTimeout(() => {
    if (s.estado !== "esperando") return;
    console.log("O Mac está perguntando na tela se a ponte pode usar a pasta Documentos, onde ficam os arquivos que o celular manda. Escolha Permitir.");
    s.fim.then(() => console.log(s.estado === "liberada" ? "Pasta Documentos liberada." : "O Mac negou a pasta Documentos: os arquivos do celular não vão ser gravados nela."));
  }, 2000);
}

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
    info: () => ({ ponte: VERSION, sistema: platform(), pasta: projectDir, empresa: policy()?.empresa ?? null }),
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
