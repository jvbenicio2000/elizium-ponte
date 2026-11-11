// Modelos locais: servidores de modelo que rodam neste computador (Ollama, LM Studio, llama.cpp, Jan e
// qualquer outro que fale a API de chat da OpenAI), usados pelo app como modelo de conversa, sem chave.
//
// Esses servidores só escutam em 127.0.0.1, e a resposta ao vivo deles não atravessa o transmissor nem o
// túnel. Então a ponte faz a chamada aqui, guarda o que vai chegando e entrega por consulta longa, do mesmo
// jeito que já faz com os eventos do OpenCode.
//
//   GET    /ponte/locais                                     servidores encontrados e os modelos de cada um
//   POST   /ponte/locais/conversa                            começa uma resposta → { id }
//   GET    /ponte/locais/conversa/<id>?depois=N&espera=20    pedaços novos da resposta
//   DELETE /ponte/locais/conversa/<id>                       cancela
//   POST   /ponte/locais/pesquisar                           modelos para baixar, pelo que o usuário escreveu
//   POST   /ponte/locais/opcoes                              o que dá para baixar de um resultado da pesquisa
//   POST   /ponte/locais/consultar                           tamanho de um modelo antes de baixar
//   POST   /ponte/locais/baixar                              começa a baixar um modelo → { id }
//   GET    /ponte/locais/baixar                              downloads em andamento e os que acabaram há pouco
//   GET    /ponte/locais/baixar/<id>?depois=N&espera=20      andamento de um download
//   DELETE /ponte/locais/baixar/<id>                         cancela o download
//   POST   /ponte/locais/remover                             apaga um modelo do computador
//   POST   /ponte/locais/imagem                              começa a gerar uma imagem (ComfyUI) → { id }
//   GET    /ponte/locais/imagem/<id>?depois=N&espera=20      andamento da imagem
//   GET    /ponte/locais/imagem/<id>/arquivo                 a imagem pronta, em bytes
//   DELETE /ponte/locais/imagem/<id>                         cancela
//
// O contrato completo, com os campos, está em LOCAIS.md na raiz deste repositório.
//
// O app nunca manda um endereço: manda o "id" de um servidor desta lista. A ponte só chama os endereços
// daqui e os que o dono do computador escreveu em ~/.elizium-ponte/config.json:
//   { "locais": { "contexto": 16384, "servidores": [ { "nome": "vLLM", "url": "http://127.0.0.1:8000", "chave": "" } ] } }

import { randomBytes, randomInt } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { readdir, rename, statfs, unlink } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const STEPS = [4096, 8192, 16384, 32768, 65536, 131072];
const VISION_HINTS = ["vision", "llava", "bakllava", "-vl", "vl-", "vlm", "minicpm-v", "moondream", "pixtral", "gemma3", "gemma-3",
                      "gemma4", "gemma-4", "qwen2.5vl", "qwen3-vl", "idefics", "paligemma", "smolvlm", "internvl", "llama4", "granite3.2-vision"];
const visionHint = (name) => { const n = name.toLowerCase(); return VISION_HINTS.some((h) => n.includes(h)) && !/gemma-?3[:\-](1b|270m)/.test(n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

function ollamaURL() {
  const h = (process.env.OLLAMA_HOST ?? "").trim();
  if (!h) return "http://127.0.0.1:11434";
  try {
    const u = new URL(/^https?:\/\//.test(h) ? h : `http://${h}`);
    if (u.hostname === "0.0.0.0") u.hostname = "127.0.0.1";
    if (!u.port && u.protocol === "http:") u.port = "11434";
    return u.origin;
  } catch { return "http://127.0.0.1:11434"; }
}

async function getJSON(url, { timeout = 2000, headers, method = "GET", body } = {}) {
  const r = await fetch(url, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers ?? {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Divide o corpo de uma resposta em linhas, conforme vão chegando. */
async function* lines(stream) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, cut).replace(/\r$/, "");
      buf = buf.slice(cut + 1);
      if (line.trim()) yield line;
    }
  }
  if (buf.trim()) yield buf;
}

export function createLocais({ config = {}, log = () => {} }) {
  const settings = config.locais ?? {};
  /** Contexto que a ponte anuncia ao app quando o modelo aguenta mais do que cabe bem na memória de vídeo. */
  const contextCap = Number.isInteger(settings.contexto) && settings.contexto >= 2048 ? settings.contexto : 16384;

  const known = [
    { id: "ollama", nome: "Ollama", tipo: "ollama", url: ollamaURL() },
    { id: "lmstudio", nome: "LM Studio", tipo: "lmstudio", url: "http://127.0.0.1:1234" },
    { id: "llamacpp", nome: "llama.cpp", tipo: "openai", url: "http://127.0.0.1:8080" },
    { id: "jan", nome: "Jan", tipo: "openai", url: "http://127.0.0.1:1337" },
    { id: "comfyui", nome: "ComfyUI", tipo: "comfyui", url: "http://127.0.0.1:8188" },
  ];
  const extra = (Array.isArray(settings.servidores) ? settings.servidores : [])
    .filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url))
    .map((s, i) => ({
      id: `config${i + 1}`, nome: String(s.nome ?? `Servidor ${i + 1}`),
      tipo: ["ollama", "lmstudio", "openai", "comfyui"].includes(s.tipo) ? s.tipo : "openai",
      url: s.url.replace(/\/+$/, "").replace(/\/v1$/, ""), chave: typeof s.chave === "string" ? s.chave : "",
      pasta: typeof s.pasta === "string" ? s.pasta : "",
    }));
  // Um endereço escrito no config.json vale no lugar do conhecido com o mesmo endereço.
  const servers = [...known.filter((k) => !extra.some((e) => e.url === k.url)), ...extra];
  const auth = (s) => (s.chave ? { Authorization: `Bearer ${s.chave}` } : {});

  // ---- Lista de modelos -------------------------------------------------------------------------------

  const showCache = new Map();   // endereço|modelo|digest → { capacidades, contexto }
  async function ollamaShow(s, name, digest = "") {
    const key = `${s.url}|${name}|${digest}`;
    if (showCache.has(key)) return showCache.get(key);
    let out = { capacidades: [], contexto: null };
    try {
      const j = await getJSON(`${s.url}/api/show`, { method: "POST", body: { model: name }, timeout: 4000 });
      const info = j.model_info ?? {};
      const ctxKey = Object.keys(info).find((k) => k.endsWith(".context_length"));
      out = { capacidades: Array.isArray(j.capabilities) ? j.capabilities : [], contexto: ctxKey ? Number(info[ctxKey]) || null : null };
      showCache.set(key, out);
    } catch {}
    return out;
  }
  async function ollamaLoaded(s) {
    try {
      const j = await getJSON(`${s.url}/api/ps`, { timeout: 1500 });
      return new Map((j.models ?? []).map((m) => [m.name ?? m.model, m]));
    } catch { return new Map(); }
  }
  async function ollamaModels(s) {
    const tags = await getJSON(`${s.url}/api/tags`);
    if (!Array.isArray(tags?.models)) throw new Error("não é o Ollama");
    const loaded = await ollamaLoaded(s);
    const list = await Promise.all(tags.models.map(async (m) => {
      const name = m.name ?? m.model;
      if (typeof name !== "string") return null;
      const show = await ollamaShow(s, name, m.digest);
      const caps = show.capacidades;
      // Modelos só de vetores (embedding) não conversam.
      if (caps.length && !caps.includes("completion")) return null;
      const running = loaded.get(name)?.context_length;
      // O que a ponte vai até pedir sozinha; aberto com menos, ela recarrega maior quando a conversa crescer.
      const offered = Math.min(show.contexto ?? contextCap, contextCap);
      return {
        id: name, nome: name, tipo: "texto",
        imagem: caps.length ? caps.includes("vision") : visionHint(name),
        raciocinio: caps.includes("thinking"),
        contexto: Number.isInteger(running) && running > offered ? running : offered,
        contextoMaximo: show.contexto,
        tamanho: Number.isFinite(m.size) ? m.size : null,
        detalhe: [m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(" · "),
        carregado: loaded.has(name),
      };
    }));
    return list.filter(Boolean);
  }

  async function lmStudioModels(s) {
    let j;
    try { j = await getJSON(`${s.url}/api/v0/models`, { headers: auth(s) }); } catch { return openAIModels(s); }
    if (!Array.isArray(j?.data)) return openAIModels(s);
    return j.data.filter((m) => typeof m.id === "string" && m.type !== "embeddings").map((m) => ({
      id: m.id, nome: m.id, tipo: "texto",
      imagem: m.type ? m.type === "vlm" : visionHint(m.id),
      raciocinio: false,
      // O LM Studio decide o contexto ao carregar o modelo; sem saber, vale o padrão dele (4096).
      contexto: Number.isInteger(m.loaded_context_length) ? m.loaded_context_length : 4096,
      contextoMaximo: Number.isInteger(m.max_context_length) ? m.max_context_length : null,
      tamanho: null,
      detalhe: [m.arch, m.quantization].filter(Boolean).join(" · "),
      carregado: m.state === "loaded",
    }));
  }

  async function openAIModels(s) {
    const j = await getJSON(`${s.url}/v1/models`, { headers: auth(s) });
    if (!Array.isArray(j?.data)) throw new Error("não fala a API de modelos");
    // llama.cpp conta o contexto e se enxerga imagem em /props; os outros não têm isso.
    let props = null;
    try { props = await getJSON(`${s.url}/props`, { headers: auth(s), timeout: 1200 }); } catch {}
    const ctx = Number(props?.default_generation_settings?.n_ctx) || null;
    const vision = typeof props?.modalities?.vision === "boolean" ? props.modalities.vision : null;
    return j.data.filter((m) => typeof m.id === "string" && !/embed/i.test(m.id)).map((m) => ({
      id: m.id, nome: m.id.split(/[\\/]/).pop().replace(/\.gguf$/i, ""), tipo: "texto",
      imagem: vision ?? visionHint(m.id),
      raciocinio: false,
      contexto: ctx ?? 8192,
      contextoMaximo: Number(m.meta?.n_ctx_train) || null,
      tamanho: Number(m.meta?.size) || null,
      detalhe: "",
      carregado: true,
    }));
  }

  // ---- ComfyUI: modelos que geram imagem -------------------------------------------------------------

  const isLocal = (u) => { try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname); } catch { return false; } };
  const folderCache = new Map();   // endereço → { pastas, quando }
  /** Pastas de checkpoints do ComfyUI neste computador. Vazio quando não dá para saber (aí não se baixa nem se apaga). */
  async function comfyFolders(s) {
    if (!isLocal(s.url)) return [];
    const hit = folderCache.get(s.url);
    if (hit && Date.now() - hit.quando < 60000) return hit.pastas;
    let list = s.pasta ? [s.pasta] : [];
    if (!list.length) {
      try {
        const v = (await getJSON(`${s.url}/internal/folder_paths`))?.checkpoints;
        list = Array.isArray(v) ? v.flat() : [v];
      } catch {}
    }
    if (!list.length) {
      try {
        const j = await getJSON(`${s.url}/experiment/models`);
        list = (Array.isArray(j) ? j : []).find((x) => x?.name === "checkpoints")?.folders ?? [];
      } catch {}
    }
    const pastas = list.filter((p) => typeof p === "string" && isAbsolute(p) && existsSync(p));
    folderCache.set(s.url, { pastas, quando: Date.now() });
    return pastas;
  }
  /** O arquivo de um checkpoint, só se estiver dentro de uma das pastas de checkpoints. */
  function comfyFile(folders, name) {
    for (const f of folders) {
      const p = resolve(f, name);
      const rel = relative(f, p);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
      try { const st = statSync(p); if (st.isFile()) return { path: p, size: st.size }; } catch {}
    }
    return null;
  }
  async function comfyCheckpoints(s) {
    const names = await getJSON(`${s.url}/models/checkpoints`, { timeout: 4000 });
    if (!Array.isArray(names)) throw new Error("não é o ComfyUI");
    return names.filter((n) => typeof n === "string");
  }
  async function comfyModels(s) {
    const stats = await getJSON(`${s.url}/system_stats`);
    if (!stats?.system || !Array.isArray(stats?.devices)) throw new Error("não é o ComfyUI");
    const names = await comfyCheckpoints(s);
    const folders = await comfyFolders(s);
    return names.map((n) => ({
      id: n, nome: n.split(/[\\/]/).pop().replace(/\.(safetensors|sft|ckpt|pt|pth|bin)$/i, ""), tipo: "imagem",
      imagem: false, raciocinio: false, contexto: null, contextoMaximo: null,
      tamanho: comfyFile(folders, n)?.size ?? null, detalhe: "", carregado: false,
      proporcoes: RATIOS,
    }));
  }

  const listers = { ollama: ollamaModels, lmstudio: lmStudioModels, openai: openAIModels, comfyui: comfyModels };
  /** Como o app pede um modelo novo a este servidor: pelo nome, por um endereço, ou não pede (null). E se dá para pesquisar. */
  async function abilities(s) {
    if (s.tipo === "ollama") return { baixa: "nome", remove: true, pesquisa: true };
    if (s.tipo === "comfyui") { const ok = (await comfyFolders(s)).length > 0; return { baixa: ok ? "endereco" : null, remove: ok, pesquisa: ok }; }
    return { baixa: null, remove: false, pesquisa: false };
  }
  async function discover() {
    const found = await Promise.all(servers.map(async (s) => {
      try {
        const modelos = await listers[s.tipo](s);
        return { id: s.id, nome: s.nome, tipo: s.tipo, ...(await abilities(s)), modelos };
      } catch { return null; }     // desligado, ou outra coisa usando a mesma porta
    }));
    return found.filter(Boolean);
  }

  // ---- Conversa ---------------------------------------------------------------------------------------

  const jobs = new Map();   // id → { eventos, fim, erro, uso, waiters, abort, visto, criado, terminou }
  const wake = (job) => { const w = job.waiters; job.waiters = []; for (const f of w) f(); };
  const push = (job, tipo, texto) => { job.eventos.push({ tipo, texto }); wake(job); };

  // Sem ninguém consultando há 5 minutos, a resposta é cancelada; pronta, fica guardada por 10 minutos.
  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (!job.fim && (now - job.visto > 5 * 60 * 1000 || now - job.criado > 30 * 60 * 1000)) {
        job.erro = "A resposta foi cancelada porque o celular parou de acompanhar.";
        job.abort.abort();
      } else if (job.fim && now - job.terminou > 10 * 60 * 1000) jobs.delete(id);
    }
    // Imagem que ninguém acompanha há 5 minutos é cancelada; pronta, fica 10 minutos. Download acabado fica 30 na lista.
    for (const [id, job] of images) {
      if (!job.fim && (now - job.visto > 5 * 60 * 1000 || now - job.criado > 30 * 60 * 1000)) {
        job.erro = "A imagem foi cancelada porque o celular parou de acompanhar.";
        cancelImage(job);
      } else if (job.fim && now - job.terminou > 10 * 60 * 1000) images.delete(id);
    }
    for (const [id, d] of downloads) if (d.fim && now - d.terminou > 30 * 60 * 1000) downloads.delete(id);
  }, 15000).unref();

  /** Contexto pedido ao Ollama: o que este pedido precisa, em degraus, sem recarregar o modelo à toa. */
  async function ollamaContext(s, { modelo, mensagens, maxTokens }) {
    const chars = mensagens.reduce((n, m) => n + m.texto.length, 0);
    const images = mensagens.reduce((n, m) => n + m.imagens.length, 0);
    const need = Math.ceil(chars / 3) + images * 800 + (maxTokens ?? 1024) + 256;
    const max = (await ollamaShow(s, modelo)).contexto ?? STEPS.at(-1);
    const running = (await ollamaLoaded(s)).get(modelo)?.context_length;
    if (Number.isInteger(running) && running >= need) return running;
    return Math.min(Math.max(STEPS.find((n) => n >= need) ?? STEPS.at(-1), 8192), max);
  }

  async function failure(r, s) {
    let text = "";
    try { text = await r.text(); } catch {}
    try { const j = JSON.parse(text); text = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? text; } catch {}
    return new Error(`${s.nome} respondeu ${r.status}: ${String(text).slice(0, 400)}`);
  }

  async function runOllama(job, s, p) {
    const options = { num_ctx: await ollamaContext(s, p) };
    if (p.temperatura !== null) options.temperature = p.temperatura;
    if (p.maxTokens !== null) options.num_predict = p.maxTokens;
    const messages = p.mensagens.map((m) => ({ role: m.papel, content: m.texto, ...(m.imagens.length ? { images: m.imagens } : {}) }));
    const r = await fetch(`${s.url}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json", ...auth(s) }, signal: job.abort.signal,
      body: JSON.stringify({ model: p.modelo, messages, stream: true, options }),
    });
    if (!r.ok) throw await failure(r, s);
    for await (const line of lines(r.body)) {
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new Error(`${s.nome}: ${j.error}`);
      if (j.message?.thinking) push(job, "raciocinio", j.message.thinking);
      if (j.message?.content) push(job, "texto", j.message.content);
      if (j.done) {
        const entrada = j.prompt_eval_count ?? 0, saida = j.eval_count ?? 0;
        if (entrada + saida > 0) job.uso = { entrada, saida };
        break;
      }
    }
  }

  async function runOpenAI(job, s, p) {
    const messages = p.mensagens.map((m) => m.imagens.length
      ? { role: m.papel, content: [{ type: "text", text: m.texto },
                                   ...m.imagens.map((b) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b}` } }))] }
      : { role: m.papel, content: m.texto });
    const body = { model: p.modelo, messages, stream: true, stream_options: { include_usage: true } };
    if (p.temperatura !== null) body.temperature = p.temperatura;
    if (p.maxTokens !== null) body.max_tokens = p.maxTokens;
    const r = await fetch(`${s.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...auth(s) }, signal: job.abort.signal, body: JSON.stringify(body),
    });
    if (!r.ok) throw await failure(r, s);
    for await (const line of lines(r.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new Error(`${s.nome}: ${typeof j.error === "string" ? j.error : j.error.message ?? JSON.stringify(j.error)}`);
      const u = j.usage;
      if (u && (u.prompt_tokens || u.completion_tokens)) job.uso = { entrada: u.prompt_tokens ?? 0, saida: u.completion_tokens ?? 0 };
      const delta = j.choices?.[0]?.delta;
      if (!delta) continue;
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (typeof thinking === "string" && thinking) push(job, "raciocinio", thinking);
      if (typeof delta.content === "string" && delta.content) push(job, "texto", delta.content);
    }
  }

  function parseRequest(j) {
    const s = servers.find((x) => x.id === j.servidor);
    if (!s) throw new Error("Servidor de modelos desconhecido. Atualize a lista de modelos no app.");
    if (s.tipo === "comfyui") throw new Error("Este modelo só gera imagem. Use-o em Criar mídia.");
    if (typeof j.modelo !== "string" || !j.modelo) throw new Error("Faltou dizer o modelo.");
    if (!Array.isArray(j.mensagens) || !j.mensagens.length) throw new Error("Faltaram as mensagens.");
    const mensagens = j.mensagens.map((m) => {
      if (!m || !["system", "user", "assistant"].includes(m.papel) || typeof m.texto !== "string") throw new Error("Mensagem inválida.");
      const imagens = Array.isArray(m.imagens) ? m.imagens : [];
      if (imagens.some((b) => typeof b !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b))) throw new Error("Imagem inválida.");
      return { papel: m.papel, texto: m.texto, imagens };
    });
    return {
      server: s, modelo: j.modelo, mensagens,
      temperatura: typeof j.temperatura === "number" ? j.temperatura : null,
      maxTokens: Number.isInteger(j.maxTokens) && j.maxTokens > 0 ? j.maxTokens : null,
    };
  }

  function start(p) {
    const job = { eventos: [], fim: false, erro: null, uso: null, waiters: [], abort: new AbortController(),
                  visto: Date.now(), criado: Date.now(), terminou: 0 };
    const id = randomBytes(9).toString("base64url");
    jobs.set(id, job);
    const s = p.server;
    (s.tipo === "ollama" ? runOllama : runOpenAI)(job, s, p).catch((e) => {
      if (job.erro) return;                              // cancelada: o motivo já está escrito
      const refused = e.cause?.code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed/.test(String(e.message));
      job.erro = refused ? `O ${s.nome} não está respondendo neste computador. Abra o ${s.nome} e tente de novo.` : String(e.message ?? e);
    }).finally(() => {
      job.fim = true; job.terminou = Date.now();
      if (job.erro && !job.cancelada) log(`Modelo local (${s.nome}, ${p.modelo}): ${job.erro}`);
      wake(job);
    });
    return id;
  }

  // Um pedido grande (conversa longa, imagens) chega em pedaços, para caber nas mensagens do transmissor.
  const uploads = new Map();   // envio → { partes, total, criado }
  function assemble({ envio, parte, total, dados }) {
    if (typeof envio !== "string" || !Number.isInteger(parte) || !Number.isInteger(total) || total < 1 || total > 400
        || parte < 0 || parte >= total || typeof dados !== "string") throw new Error("Pedido em pedaços inválido.");
    for (const [k, u] of uploads) if (Date.now() - u.criado > 10 * 60 * 1000) uploads.delete(k);
    const u = uploads.get(envio) ?? { partes: new Map(), total, criado: Date.now() };
    uploads.set(envio, u);
    u.partes.set(parte, Buffer.from(dados, "base64"));
    if (u.partes.size < u.total) return null;
    uploads.delete(envio);
    return Buffer.concat([...Array(u.total).keys()].map((i) => u.partes.get(i)));
  }

  // ---- Baixar e remover modelos -----------------------------------------------------------------------

  const findServer = (id) => {
    const s = servers.find((x) => x.id === id);
    if (!s) throw new Error("Servidor de modelos desconhecido. Atualize a lista de modelos no app.");
    return s;
  };
  const offline = (s) => new Error(`O ${s.nome} não está respondendo neste computador. Abra o ${s.nome} e tente de novo.`);
  const refused = (e) => e?.cause?.code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed/.test(String(e?.message));
  const gb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace(".", ",")} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
  /** Espaço livre no disco da pasta (ou da primeira pasta acima dela que já exista). null quando não dá para saber. */
  async function freeSpace(dir) {
    for (let d = dir, i = 0; d && i < 8; i++) {
      try { const st = await statfs(d); return Number(st.bavail) * Number(st.bsize); } catch {}
      const up = dirname(d);
      if (up === d) break;
      d = up;
    }
    return null;
  }
  /** O disco do Ollama só é este quando o Ollama roda neste computador. */
  const ollamaFree = (s) => (isLocal(s.url) ? freeSpace(ollamaDir()) : null);
  function roomFor(size, free) {
    if (size && free !== null && size + 1e9 > free) {
      throw new Error(`Não há espaço neste computador: o modelo tem ${gb(size)} e o disco tem ${gb(free)} livres.`);
    }
  }

  function ollamaName(raw) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.length > 200 || !/^[A-Za-z0-9._\-/:]+$/.test(name) || /^[-/:.]|[/:]$/.test(name)) {
      throw new Error("Nome de modelo inválido. Escreva como aparece no site do Ollama, por exemplo gemma3:4b.");
    }
    return name;
  }
  const ollamaTagged = (name) => (name.lastIndexOf(":") > name.lastIndexOf("/") ? name : `${name}:latest`);
  const ollamaDir = () => (process.env.OLLAMA_MODELS ?? "").trim() || join(homedir(), ".ollama", "models");
  const HF_HOST = /^(hf\.co|huggingface\.co)$/i;
  const unknownOllama = (name) => new Error(HF_HOST.test(name.split("/")[0]) && name.includes("/")
    ? `Não achei o modelo ${name} no Hugging Face. Confira o nome em huggingface.co.`
    : `Não achei o modelo ${name} na biblioteca do Ollama. Confira o nome em ollama.com/library.`);
  // O Ollama baixa do Hugging Face pelo nome hf.co/pessoa/repositório:variante. Ele só aceita nomes assim: a pessoa
  // sem ponto, e cada parte com até 80 letras (conferido no Ollama 0.40.16).
  const HF_GGUF = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
  const OLLAMA_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;
  const MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
  const manifestSize = (j) => [j?.config, ...(Array.isArray(j?.layers) ? j.layers : [])].reduce((n, l) => n + (Number(l?.size) || 0), 0) || null;
  /**
   * Tamanho do que o Ollama vai baixar do Hugging Face. O site de lá responde como o registro do Ollama, e a soma
   * já inclui a peça de imagem (mmproj) quando o modelo tem uma. Uma variante que não existe é recusada aqui, antes
   * de o download começar.
   */
  async function hfSize(repo, tag) {
    if (!HF_GGUF.test(repo) || !OLLAMA_TAG.test(tag)) return null;
    let r;
    try {
      r = await fetch(`https://huggingface.co/v2/${repo}/manifests/${encodeURIComponent(tag)}`,
        { headers: { accept: MANIFEST, "user-agent": "elizium-ponte" }, signal: AbortSignal.timeout(10000) });
    } catch { return null; }
    // O Hugging Face responde 401 tanto a um modelo que não existe quanto a um modelo fechado.
    if (r.status === 401 || r.status === 403) throw new Error(`Não achei ${repo} aberto no Hugging Face: ele não existe ou pede login.`);
    if (r.status === 400 || r.status === 404) {
      const why = await r.text().catch(() => "");
      if (/sharded/i.test(why)) throw new Error("Esse modelo está partido em vários arquivos, e o Ollama não baixa assim. Escolha outra variante.");
      if (/not GGUF|not compatible/i.test(why)) throw new Error("Esse repositório do Hugging Face não tem um modelo no formato GGUF, que é o que o Ollama baixa.");
      if (/tag|quantization/i.test(why)) throw new Error("O Hugging Face não tem essa variante nesse modelo. Escolha uma da lista.");
      return null;
    }
    if (!r.ok) return null;
    try { return manifestSize(await r.json()); } catch { return null; }
  }
  /** Tamanho de um modelo na biblioteca do Ollama, sem baixar nada. null quando não dá para saber de antemão. */
  async function ollamaSize(name) {
    const full = ollamaTagged(name);
    const cut = full.lastIndexOf(":");
    const parts = full.slice(0, cut).split("/");
    // Com três partes o nome traz o registro (hf.co/pessoa/modelo). Só o do Hugging Face a ponte sabe consultar; nos
    // outros o Ollama resolve na hora. Um ponto no nome não quer dizer registro: llama3.2 e qwen3.8 são da biblioteca.
    if (parts.length === 3 && HF_HOST.test(parts[0])) return hfSize(`${parts[1]}/${parts[2]}`, full.slice(cut + 1));
    if (parts.length > 2) return null;
    let r;
    try {
      r = await fetch(`https://registry.ollama.ai/v2/${parts.length === 1 ? `library/${parts[0]}` : parts.join("/")}/manifests/${full.slice(cut + 1)}`,
        { headers: { accept: MANIFEST }, signal: AbortSignal.timeout(10000) });
    } catch { return null; }
    if (r.status === 404) throw unknownOllama(name);
    if (!r.ok) return null;
    try { return manifestSize(await r.json()); } catch { return null; }
  }

  const decode = (t) => { try { return decodeURIComponent(t); } catch { return t; } };
  function modelURL(raw) {
    let u;
    try { u = new URL(String(raw ?? "").trim()); } catch { throw new Error("Endereço inválido. Cole o endereço completo do arquivo do modelo."); }
    if (u.protocol !== "https:") throw new Error("O endereço precisa começar com https://");
    if (isLocal(u.href) || /^[\d.]+$|^\[/.test(u.hostname)) throw new Error("Endereço inválido. Use o endereço do site onde o modelo está.");
    // No Hugging Face, o endereço da página do arquivo (…/blob/…) vira o do arquivo em si (…/resolve/…).
    if (/(^|\.)huggingface\.co$/.test(u.hostname)) u.pathname = u.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/resolve/");
    return u;
  }
  function refuseAnswer(r) {
    if (r.status === 401 || r.status === 403) throw new Error("Esse modelo pede login no site. Escolha um modelo aberto, ou ponha o arquivo na pasta do ComfyUI pelo próprio computador.");
    if (r.status === 404) throw new Error("Não achei esse arquivo. Confira o endereço.");
    if (!r.ok) throw new Error(`O site respondeu ${r.status} ao pedir o arquivo.`);
    if ((r.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
      throw new Error("Esse endereço abre uma página, não o arquivo do modelo. Use o endereço direto do arquivo .safetensors.");
    }
  }
  function fileName(r, u, wanted) {
    const disp = r.headers.get("content-disposition") ?? "";
    const sent = /filename\*=UTF-8''([^;]+)/i.exec(disp)?.[1] ?? /filename="?([^";]+)"?/i.exec(disp)?.[1];
    let name = typeof wanted === "string" && wanted.trim() ? wanted.trim() : decode(sent ?? u.pathname.split("/").pop() ?? "").trim();
    if (typeof wanted === "string" && wanted.trim() && !/\.safetensors$/i.test(name)) name += ".safetensors";
    if (!/\.safetensors$/i.test(name)) throw new Error("Só baixo arquivos .safetensors. Use o endereço direto do arquivo do modelo.");
    if (name.length > 150 || name.startsWith(".") || !/^[A-Za-z0-9._ \-()]+$/.test(name)) {
      throw new Error("O nome desse arquivo tem sinais que não aceito. Baixe pelo próprio computador.");
    }
    return name;
  }
  /** O que o site diz do arquivo, sem baixar: nome e tamanho. */
  async function probe(u, wanted) {
    let r;
    try { r = await fetch(u, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error("Este computador não conseguiu abrir esse endereço. Confira o endereço e a internet do computador."); }
    if (r.status === 405 || r.status === 501) return { nome: fileName(new Response(null), u, wanted), tamanho: null };   // site que não aceita HEAD
    refuseAnswer(r);
    return { nome: fileName(r, u, wanted), tamanho: Number(r.headers.get("content-length")) || Number(r.headers.get("x-linked-size")) || null };
  }

  /**
   * Abre o arquivo de um endereço https para baixar, seguindo os redirecionamentos (só para outro endereço https).
   * Devolve o que o refuseAnswer espera (status, ok, headers.get) e o corpo como stream do Node.
   * Não usa o fetch do Node: medido em 10/11/2026 (Node 26.13, macOS), o fetch trazia o arquivo a 1 MB/s e o
   * módulo https, como o curl, a 7 MB/s, na mesma rede e na mesma hora.
   */
  function openFile(address, signal, hops = 0) {
    return new Promise((ok, no) => {
      const u = new URL(address);
      if (u.protocol !== "https:") return no(new Error("O site mandou o download para um endereço sem https. Use outro endereço."));
      const req = httpsGet(u, { signal, headers: { "accept-encoding": "identity", "user-agent": "elizium-ponte" } }, (res) => {
        const to = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && to) {
          res.resume();
          if (hops >= 10) return no(new Error("O site redirecionou o download vezes demais. Use o endereço direto do arquivo."));
          let next;
          try { next = new URL(to, u).href; } catch { return no(new Error("O site mandou o download para um endereço inválido.")); }
          return ok(openFile(next, signal, hops + 1));
        }
        const head = (name) => { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v.join(", ") : v ?? null; };
        ok({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: { get: head }, body: res });
      });
      req.on("error", no);
    });
  }

  async function consult(j) {
    const s = findServer(j?.servidor);
    if (s.tipo === "ollama") {
      const modelo = ollamaName(j.modelo);
      let tags;
      try { tags = await getJSON(`${s.url}/api/tags`); } catch { throw offline(s); }
      // Sem diferença de maiúsculas: no Hugging Face a variante vale como Q4_K_M ou q4_k_m, e o Ollama guarda uma delas.
      const wanted = ollamaTagged(modelo).toLowerCase();
      const instalado = (tags.models ?? []).some((m) => String(m.name ?? m.model).toLowerCase() === wanted);
      return { servidor: s.id, modelo, tamanho: await ollamaSize(modelo), livre: await ollamaFree(s), instalado };
    }
    if (s.tipo === "comfyui") {
      const folder = (await comfyFolders(s))[0];
      if (!folder) throw new Error(`Não sei onde o ${s.nome} guarda os modelos neste computador.`);
      const info = await probe(modelURL(j.endereco), j.nome);
      return { servidor: s.id, modelo: info.nome, tamanho: info.tamanho, livre: await freeSpace(folder), instalado: existsSync(join(folder, info.nome)) };
    }
    throw new Error(`O ${s.nome} não deixa baixar modelos por aqui.`);
  }

  // ---- Pesquisar modelos para baixar ------------------------------------------------------------------
  //
  // O Ollama não tem uma API de pesquisa: a ponte lê a página pública de pesquisa do site (ollama.com/search) e a
  // página do modelo (ollama.com/library/<nome>). Se o site mudar essas páginas, a pesquisa volta vazia e o app
  // continua aceitando o nome escrito à mão. No ComfyUI a pesquisa usa a API pública do Hugging Face.
  // A pesquisa do Ollama traz também os modelos publicados por quem tem conta no site (pessoa/modelo), que ficam em
  // ollama.com/<pessoa>/<modelo>: variações que a biblioteca não tem, como as "abliterated". O Ollama não confere esses.
  // Junto vêm os modelos GGUF do Hugging Face, que o Ollama baixa pelo nome hf.co/<pessoa>/<repositório>:<variante>.
  // A ponte só abre esses dois sites; o que o app escreve entra na pesquisa como texto, nunca como endereço.

  const HF = "https://huggingface.co";
  const searchCache = new Map();   // chave → { quando, valor }
  async function remembered(key, make) {
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.quando < 10 * 60000) return hit.valor;
    const valor = await make();
    if (searchCache.size >= 300) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { quando: Date.now(), valor });
    return valor;
  }
  /** Abre uma página de um dos sites da pesquisa. Devolve null quando ela não existe (404, ou os códigos de "missing"). */
  async function sitePage(url, site, missing = [404]) {
    let r;
    try { r = await fetch(url, { headers: { "user-agent": "elizium-ponte" }, signal: AbortSignal.timeout(12000) }); }
    catch { throw new Error(`Este computador não conseguiu abrir o ${site}. Confira a internet do computador.`); }
    if (missing.includes(r.status)) return null;
    if (!r.ok) throw new Error(`O ${site} respondeu ${r.status} à pesquisa. Tente de novo daqui a pouco.`);
    try { return await r.text(); } catch { throw new Error(`O ${site} demorou demais para responder. Tente de novo.`); }
  }
  const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const unescapeHTML = (t) => t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? all;
    const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
  });
  const plainText = (html) => unescapeHTML(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  const countText = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",").replace(",0", "")} mi de downloads`
    : n >= 1000 ? `${Math.round(n / 1000)} mil downloads` : n === 1 ? "1 download" : `${n} downloads`);

  /** Tamanhos de modelo como o site do Ollama escreve (1.7b, 270m, e2b). A contagem de downloads usa maiúscula (6.2M). */
  const SIZE_TAG = /^(e?\d+(\.\d+)?[mb]|\d+x\d+(\.\d+)?b)$/;
  /** Os modelos de uma página de pesquisa do Ollama. Lê pelo conteúdo, não pelas classes, que mudam a cada versão do site. */
  function ollamaResults(html) {
    const out = [], seen = new Set();
    for (const block of html.split(/<li\b/i).slice(1)) {
      const link = /href="\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)"/.exec(block);
      const comunidade = !!link && link[1] !== "library";
      const name = !link ? "" : comunidade ? `${link[1]}/${link[2]}` : link[2];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const spans = [...block.matchAll(/<span\b[^>]*>([^<]*)<\/span>/gi)].map((m) => unescapeHTML(m[1]).trim()).filter(Boolean);
      const marks = spans.map((t) => t.toLowerCase());
      // Modelos que só rodam na nuvem do Ollama não têm o que baixar; os de vetores não conversam.
      if (marks.includes("cloud") && !marks.some((t) => /^\d+ tags?$/.test(t))) continue;
      if (marks.includes("embedding")) continue;
      const tamanhos = spans.filter((t) => SIZE_TAG.test(t));
      const downloads = Number(/title="([\d,.]+) downloads?"/i.exec(block)?.[1]?.replace(/[,.]/g, "")) || null;
      const imagem = marks.includes("vision"), raciocinio = marks.includes("thinking");
      out.push({
        id: name, nome: name, descricao: plainText(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "").slice(0, 300),
        detalhe: [comunidade ? "da comunidade" : "", tamanhos.join(", "), imagem ? "vê imagem" : "", raciocinio ? "raciocina" : "",
          downloads ? countText(downloads) : ""].filter(Boolean).join(" · "),
        imagem, raciocinio, downloads, comunidade, origem: "ollama",
      });
    }
    return out;
  }
  async function ollamaSearch(texto) {
    const html = await sitePage(`https://ollama.com/search${texto ? `?q=${encodeURIComponent(texto)}` : ""}`, "site do Ollama");
    const found = ollamaResults(html ?? "");
    if (!found.length && !/data-result-count="0"/.test(html ?? "")) log("A página de pesquisa do Ollama veio sem modelos que eu saiba ler; o site pode ter mudado.");
    return found;
  }

  const UNITS = { kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
  const INPUTS = { text: "texto", image: "imagem", audio: "áudio", video: "vídeo" };
  /** Nome de um modelo no site do Ollama: da biblioteca (gemma3) ou de quem o publicou (pessoa/modelo). */
  const OLLAMA_PAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
  /** As variantes de um modelo, como a página dele no site do Ollama mostra: nome com a etiqueta, tamanho e contexto. */
  function ollamaVariants(html, name) {
    const out = new Map();
    for (const part of html.split(`href="/${name.includes("/") ? name : `library/${name}`}:`).slice(1)) {
      const tag = /^([A-Za-z0-9._-]+)"/.exec(part)?.[1];
      if (!tag || /cloud/i.test(tag)) continue;
      const full = `${name}:${tag}`;
      if (out.get(full)?.tamanho) continue;
      const text = plainText(part.slice(part.indexOf(">") + 1, 4000));
      const size = /(\d+(?:\.\d+)?)\s?(KB|MB|GB|TB)\b/i.exec(text);
      const context = /(\d+(?:\.\d+)?[KM]?)\s+context/i.exec(text)?.[1];
      const input = (/context window\s*[·•]\s*([^·•]+?)\s*[·•]/i.exec(text)?.[1] ?? "").split(/[,\s]+/).filter((w) => w && !/^input$/i.test(w))
        .map((w) => INPUTS[w.toLowerCase()] ?? w.toLowerCase()).slice(0, 4);
      out.set(full, {
        nome: full, alvo: full, tamanho: size ? Math.round(Number(size[1]) * UNITS[size[2].toLowerCase()]) : null,
        detalhe: [context ? `contexto ${context}` : "", input.join(", ")].filter(Boolean).join(" · "),
      });
    }
    return [...out.values()].slice(0, 40);
  }
  async function ollamaOptions(name) {
    // Um modelo da comunidade costuma ter várias compressões e a página dele só mostra uma ou duas: a lista inteira
    // está em /tags. Na biblioteca, a página do modelo já traz os tamanhos principais.
    const html = await sitePage(`https://ollama.com/${name.includes("/") ? `${name}/tags` : `library/${name}`}`, "site do Ollama");
    if (html === null) throw unknownOllama(name);
    const found = ollamaVariants(html, name);
    if (found.length) return found;
    log(`A página do modelo ${name} no site do Ollama veio sem variantes que eu saiba ler; o site pode ter mudado.`);
    return [{ nome: name, alvo: name, tamanho: null, detalhe: "" }];
  }

  /** Arquivo que parece um modelo inteiro (checkpoint), e não uma peça: LoRA, VAE, ControlNet, codificador de texto. */
  const NOT_CHECKPOINT = /lora|unet|vae|clip|t5|text_encoder|controlnet|adapter|embedding|diffusion_pytorch_model|inpaint|refiner/i;
  const checkpointFile = (f) => typeof f === "string" && !f.includes("/") && /\.safetensors$/i.test(f) && !NOT_CHECKPOINT.test(f)
    && f.length <= 150 && !f.startsWith(".") && /^[A-Za-z0-9._ \-()]+$/.test(f);
  const OTHER_BASE = /flux|qwen|z-image|krea|wan|hunyuan|stable-diffusion-3|sd3|pixart|kolors|lumina|hidream|chroma|cascade|auraflow|sana/;
  /**
   * A pesquisa só sugere modelos da família Stable Diffusion (1.x, 2.x e XL), que é a que o fluxo de imagem da ponte
   * sabe rodar a partir de um arquivo só. Outros modelos continuam entrando pelo endereço do arquivo.
   */
  function imageFamily(m) {
    const tags = (Array.isArray(m.tags) ? m.tags : []).map((t) => String(t).toLowerCase());
    const bases = tags.filter((t) => t.startsWith("base_model:"));
    if (tags.some((t) => ["lora", "controlnet", "gguf"].includes(t)) || bases.some((t) => OTHER_BASE.test(t))) return null;
    if (tags.some((t) => ["stable-diffusion-xl", "sdxl", "diffusers:stablediffusionxlpipeline"].includes(t))
        || bases.some((t) => /xl|illustrious|noobai|animagine|pony/.test(t)) || /xl/i.test(m.id)) return "Stable Diffusion XL";
    return tags.some((t) => ["stable-diffusion", "stable-diffusion-diffusers", "diffusers:stablediffusionpipeline",
                             "diffusers:latentconsistencymodelpipeline"].includes(t))
        || bases.some((t) => /stable-diffusion|sd-turbo/.test(t)) ? "Stable Diffusion" : null;
  }
  const HF_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
  /** Conteúdo adulto fica fora das sugestões (o próprio Hugging Face marca esses modelos). */
  const adult = (m) => (Array.isArray(m.tags) ? m.tags : []).some((t) => /^(not-for-all-audiences|nsfw)$/i.test(String(t))) || /nsfw|porn|hentai/i.test(m.id);
  async function imageSearch(texto) {
    const q = new URLSearchParams({ pipeline_tag: "text-to-image", sort: "downloads", direction: "-1", limit: "50", full: "true" });
    if (texto) q.set("search", texto);
    let list;
    try { list = JSON.parse((await sitePage(`${HF}/api/models?${q}`, "Hugging Face")) ?? "[]"); } catch (e) {
      if (e instanceof SyntaxError) throw new Error("O Hugging Face respondeu algo que não entendi. Tente de novo daqui a pouco.");
      throw e;
    }
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (typeof m?.id !== "string" || !HF_REPO.test(m.id) || m.gated || m.private || adult(m)) continue;
      const family = imageFamily(m);
      const files = (Array.isArray(m.siblings) ? m.siblings : []).filter((f) => checkpointFile(f?.rfilename)).length;
      if (!family || !files) continue;
      const downloads = Number(m.downloads) || null;
      out.push({
        id: m.id, nome: m.id, descricao: "",
        detalhe: [family, files === 1 ? "1 arquivo" : `${files} arquivos`, downloads ? countText(downloads) : ""].filter(Boolean).join(" · "),
        imagem: false, raciocinio: false, downloads, origem: "huggingface",
      });
    }
    return out.slice(0, 30);
  }
  async function imageOptions(id) {
    // O Hugging Face responde 401 tanto a um modelo que não existe quanto a um modelo fechado.
    const body = await sitePage(`${HF}/api/models/${id}?blobs=true`, "Hugging Face", [401, 403, 404]);
    if (body === null) throw new Error(`Não achei ${id} aberto no Hugging Face.`);
    let m;
    try { m = JSON.parse(body); } catch { throw new Error("O Hugging Face respondeu algo que não entendi. Tente de novo daqui a pouco."); }
    if (m?.gated || m?.private) throw new Error("Esse modelo pede login no Hugging Face. Escolha um modelo aberto.");
    const repo = typeof m?.id === "string" && HF_REPO.test(m.id) ? m.id : id;
    // Um modelo inteiro tem mais de 1,3 GB; menor que isso é peça (LoRA, VAE). Sem tamanho informado, fica.
    const files = (Array.isArray(m?.siblings) ? m.siblings : []).filter((f) => checkpointFile(f?.rfilename) && !(Number(f.size) < 1.3e9)).slice(0, 40);
    if (!files.length) throw new Error("Não achei um arquivo de modelo inteiro nesse repositório.");
    return files.map((f) => ({ nome: f.rfilename, alvo: `${HF}/${repo}/resolve/main/${encodeURIComponent(f.rfilename)}`, tamanho: Number(f.size) || null, detalhe: "" }));
  }

  // ---- Modelos GGUF do Hugging Face, para o Ollama ----
  //
  // Um repositório GGUF traz o mesmo modelo em várias compressões, um arquivo para cada. O Ollama escolhe o arquivo
  // pela etiqueta: o nome da compressão (Q4_K_M) ou o nome inteiro do arquivo. A lista de compressões abaixo é a que
  // o registro do Hugging Face reconhece; conferida em 11/11/2026 contra 130 arquivos de 8 repositórios: quando só um
  // arquivo do repositório tem a compressão, ela escolhe esse arquivo. Quando dois arquivos têm a mesma (Q4_0 e
  // Q4_0_4_4, ou um modelo e a versão "mtp" dele), ou quando o nome não tem uma compressão da lista (Q4_K_L), vale o
  // nome do arquivo.
  const QUANT = new RegExp("(?:F32|F16|Q4_0|Q4_1|Q4_1_SOME_F16|Q4_2|Q4_3|Q8_0|Q5_0|Q5_1|Q2_K|Q3_K_S|Q3_K_M|Q3_K_L|Q4_K_S|Q4_K_M|Q5_K_S|Q5_K_M"
    + "|Q6_K|IQ2_XXS|IQ2_XS|Q2_K_S|IQ3_XS|IQ3_XXS|IQ1_S|IQ4_NL|IQ3_S|IQ3_M|IQ2_S|IQ2_M|IQ4_XS|IQ1_M|BF16|Q4_0_4_4|Q4_0_4_8|Q4_0_8_8"
    + "|TQ1_0|TQ2_0|MXFP4_MOE|Q2_K_XL|Q3_K_XL|Q4_K_XL|Q5_K_XL|Q6_K_XL|Q8_K_XL)(?:_[A-Z]+)?", "g");
  const quantOf = (file) => file.toUpperCase().match(QUANT)?.at(-1) ?? null;
  /** Modelo partido em vários arquivos (…-00001-of-00003.gguf): o Ollama não baixa assim. */
  const SHARD = /-\d{5}-of-\d{5}\.gguf$/i;
  const rootGGUF = (f) => typeof f === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]*\.gguf$/i.test(f);
  /** Arquivo que é um modelo inteiro: fica na raiz, não é pedaço nem a peça de imagem (mmproj) ou de medida (imatrix). */
  const modelGGUF = (f) => rootGGUF(f) && !SHARD.test(f) && !/mmproj|imatrix/i.test(f);
  /** As variantes de um repositório que o Ollama consegue pedir, cada uma com a etiqueta que escolhe o arquivo dela. */
  function ggufVariants(siblings) {
    const files = (Array.isArray(siblings) ? siblings : []).filter((f) => modelGGUF(f?.rfilename));
    const times = new Map();
    for (const f of files) { const q = quantOf(f.rfilename); if (q) times.set(q, (times.get(q) ?? 0) + 1); }
    const out = [];
    for (const f of files) {
      const q = quantOf(f.rfilename);
      const etiqueta = q && times.get(q) === 1 ? q : f.rfilename;
      if (OLLAMA_TAG.test(etiqueta)) out.push({ etiqueta, tamanho: Number(f.size) || null });
    }
    return out;
  }
  /** Tipos de modelo que conversam. Muito repositório GGUF não diz o tipo; esses ficam, a não ser que as marcas digam outra coisa. */
  const HF_CHAT = new Set(["text-generation", "image-text-to-text", "video-text-to-text", "audio-text-to-text", "any-to-any"]);
  const HF_NOT_CHAT = /^(text-to-image|image-to-image|text-to-video|image-to-video|diffusers|comfyui|stable-diffusion.*|flux|lora|controlnet|sentence-transformers|feature-extraction|sentence-similarity|embeddings?|reranker|text-ranking|text-to-speech|tts|automatic-speech-recognition)$/i;
  async function hfJSON(url, missing) {
    const body = await sitePage(url, "Hugging Face", missing);
    if (body === null) return null;
    try { return JSON.parse(body); } catch { throw new Error("O Hugging Face respondeu algo que não entendi. Tente de novo daqui a pouco."); }
  }
  async function hfSearch(texto) {
    const q = new URLSearchParams({ search: texto, filter: "gguf", sort: "downloads", direction: "-1", limit: "40", full: "true" });
    const list = await hfJSON(`${HF}/api/models?${q}`);
    const out = [];
    for (const m of Array.isArray(list) ? list : []) {
      // Fora das sugestões: modelo que pede login, o marcado como conteúdo adulto e o que o Ollama não aceita pelo nome.
      if (typeof m?.id !== "string" || !HF_GGUF.test(m.id) || m.gated || m.private || adult(m)) continue;
      if (m.pipeline_tag != null && !HF_CHAT.has(m.pipeline_tag)) continue;
      if ((Array.isArray(m.tags) ? m.tags : []).some((t) => HF_NOT_CHAT.test(String(t)))) continue;
      const files = Array.isArray(m.siblings) ? m.siblings : [];
      const variantes = ggufVariants(files).length;
      if (!variantes) continue;
      const imagem = files.some((f) => rootGGUF(f?.rfilename) && /mmproj/i.test(f.rfilename));
      const downloads = Number(m.downloads) || null;
      out.push({
        id: `hf.co/${m.id}`, nome: m.id, descricao: "",
        detalhe: ["do Hugging Face", variantes === 1 ? "1 variante" : `${variantes} variantes`, imagem ? "vê imagem" : "",
          downloads ? countText(downloads) : ""].filter(Boolean).join(" · "),
        imagem, raciocinio: false, downloads, comunidade: true, origem: "huggingface",
      });
    }
    return out.slice(0, 20);
  }
  /** Quantas variantes de um repositório vão para o celular. */
  const HF_MAX = 60;
  const contextText = (n) => (n >= 1024 * 1000 ? `${Math.round(n / 1024 / 102.4) / 10}M`.replace(".", ",") : n >= 1024 ? `${Math.round(n / 1024)}K` : String(n));
  async function hfOptions(repo) {
    const m = await hfJSON(`${HF}/api/models/${repo}?blobs=true`, [401, 403, 404]);
    if (m === null) throw new Error(`Não achei ${repo} aberto no Hugging Face.`);
    if (m?.gated || m?.private) throw new Error("Esse modelo pede login no Hugging Face. Escolha um modelo aberto.");
    const id = typeof m?.id === "string" && HF_GGUF.test(m.id) ? m.id : repo;
    const files = Array.isArray(m?.siblings) ? m.siblings : [];
    const found = ggufVariants(files);
    if (!found.length) {
      throw new Error(files.some((f) => typeof f?.rfilename === "string" && SHARD.test(f.rfilename))
        ? "Esse modelo está partido em vários arquivos, e o Ollama não baixa assim. Escolha outro modelo."
        : "Não achei um arquivo de modelo no formato GGUF nesse repositório.");
    }
    const context = Number(m?.gguf?.context_length) || 0;
    const vision = files.some((f) => rootGGUF(f?.rfilename) && /mmproj/i.test(f.rfilename));
    const detalhe = [context ? `contexto ${contextText(context)}` : "", vision ? "texto, imagem" : "texto"].filter(Boolean).join(" · ");
    // Repositório com variantes demais: ficam primeiro as que têm etiqueta de compressão; as pedidas pelo nome do
    // arquivo são as repetidas e as fora do padrão.
    const byFile = (v) => /\.gguf$/i.test(v.etiqueta);
    const kept = found.length > HF_MAX ? [...found.filter((v) => !byFile(v)), ...found.filter(byFile)].slice(0, HF_MAX) : found;
    // Do menor para o maior, com a Q4_K_M na frente: é a compressão que o próprio Ollama usa na biblioteca dele.
    kept.sort((a, b) => (b.etiqueta === "Q4_K_M") - (a.etiqueta === "Q4_K_M") || (a.tamanho ?? Infinity) - (b.tamanho ?? Infinity));
    // O tamanho aqui é o do arquivo do modelo. Num modelo que vê imagem o Ollama baixa junto a peça de imagem
    // (mmproj), e o total certo é o que /consultar informa antes do download.
    return kept.map((v) => ({ nome: v.etiqueta, alvo: `hf.co/${id}:${v.etiqueta}`, tamanho: v.tamanho, detalhe }));
  }

  async function search(j) {
    const s = findServer(j?.servidor);
    const texto = (typeof j.texto === "string" ? j.texto : "").trim().replace(/\s+/g, " ").slice(0, 80);
    const key = texto.toLowerCase();
    if (s.tipo === "ollama") {
      // Quem escreve hf.co/pessoa/modelo, ou o endereço da página do modelo, quer só o Hugging Face.
      const direto = /^(?:https?:\/\/)?(?:www\.)?(?:hf\.co|huggingface\.co)\/(.*)$/i.exec(texto);
      // "qwen3:0.6b" é o modelo qwen3 com a etiqueta 0.6b; a pesquisa dos sites só conhece o nome, sem a etiqueta.
      const nome = (direto ? direto[1] : texto).split(":")[0].trim();
      const asked = [];
      if (!direto) asked.push(remembered(`ollama|${nome.toLowerCase()}`, () => ollamaSearch(nome)));
      // Sem texto, a lista é a dos mais baixados do Ollama; o Hugging Face entra quando há o que procurar.
      if (nome.length >= 2) asked.push(remembered(`hf|${nome.toLowerCase()}`, () => hfSearch(nome)));
      // Um dos dois sites fora do ar não esconde o que o outro achou.
      const got = await Promise.allSettled(asked);
      if (got.length && got.every((g) => g.status === "rejected")) throw got[0].reason;
      return { servidor: s.id, texto, resultados: got.flatMap((g) => (g.status === "fulfilled" ? g.value : [])) };
    }
    if (s.tipo === "comfyui") return { servidor: s.id, texto, resultados: await remembered(`imagem|${key}`, () => imageSearch(texto)) };
    throw new Error(`O ${s.nome} não tem pesquisa de modelos por aqui.`);
  }
  /** O que dá para baixar de um resultado da pesquisa. O "alvo" de cada opção é o que o app manda a /consultar e /baixar. */
  async function options(j) {
    const s = findServer(j?.servidor);
    const modelo = typeof j.modelo === "string" ? j.modelo.trim() : "";
    if (s.tipo === "ollama") {
      // Um resultado do Hugging Face chega como hf.co/pessoa/repositório; os outros são nomes do site do Ollama.
      const hf = /^hf\.co\/(.*)$/i.exec(modelo)?.[1];
      if (hf === undefined ? !OLLAMA_PAGE.test(modelo) : !HF_GGUF.test(hf)) throw new Error("Nome de modelo inválido. Escolha um modelo da pesquisa.");
      const list = hf === undefined ? await remembered(`ollama-opcoes|${modelo}`, () => ollamaOptions(modelo))
        : await remembered(`hf-opcoes|${hf.toLowerCase()}`, () => hfOptions(hf));
      let have = new Set();
      try { have = new Set(((await getJSON(`${s.url}/api/tags`)).models ?? []).map((m) => String(m.name ?? m.model).toLowerCase())); } catch {}
      return { servidor: s.id, modelo, opcoes: list.map((o) => ({ ...o, instalado: have.has(ollamaTagged(o.alvo).toLowerCase()) })) };
    }
    if (s.tipo === "comfyui") {
      if (!HF_REPO.test(modelo) || modelo.includes("..")) throw new Error("Nome de modelo inválido. Escolha um modelo da pesquisa.");
      const list = await remembered(`imagem-opcoes|${modelo}`, () => imageOptions(modelo));
      const folder = (await comfyFolders(s))[0];
      return { servidor: s.id, modelo, opcoes: list.map((o) => ({ ...o, instalado: folder ? existsSync(join(folder, o.nome)) : false })) };
    }
    throw new Error(`O ${s.nome} não tem pesquisa de modelos por aqui.`);
  }

  const downloads = new Map();   // id → { id, servidor, modelo, estado, total, baixado, n, fim, erro, waiters, abort, avisado, terminou }
  /** Avisa quem está esperando; o andamento em bytes avisa no máximo a cada 700 ms. */
  function bump(job, force = true) {
    const now = Date.now();
    if (!force && now - job.avisado < 700) return;
    job.avisado = now; job.n += 1; wake(job);
  }
  const downloadView = (d) => ({ id: d.id, servidor: d.servidor, modelo: d.modelo, estado: d.estado, total: d.total, baixado: d.baixado,
                                 proximo: d.n, fim: d.fim, erro: d.erro });

  /**
   * O Ollama guarda o que já baixou de um download interrompido (arquivos "sha256-…-partial" na pasta dele,
   * com o tamanho inteiro reservado) para continuar depois. Quem cancelou pelo celular não vai continuar:
   * esses arquivos saem, senão ocupam o disco sem aparecer em lista nenhuma. Só os das camadas deste download.
   */
  async function dropPartials(digests) {
    const heads = digests.filter((x) => /^sha256:[0-9a-f]{64}$/.test(x)).map((x) => `${x.replace(":", "-")}-partial`);
    if (!heads.length) return;
    const dir = join(ollamaDir(), "blobs");
    // O Ollama leva um instante para largar os arquivos (no Windows eles ficam presos até lá).
    for (let pass = 0; pass < 6; pass++) {
      await sleep(pass ? 1500 : 700);
      let names;
      try { names = await readdir(dir); } catch { return; }
      const left = names.filter((n) => heads.some((h) => n === h || n.startsWith(`${h}-`)));
      if (!left.length) return;
      for (const n of left) await unlink(join(dir, n)).catch(() => {});
    }
  }

  async function pullOllama(d, s) {
    const known = await ollamaSize(d.modelo);
    roomFor(known, await ollamaFree(s));
    if (known) { d.total = known; bump(d); }
    const r = await fetch(`${s.url}/api/pull`, {
      method: "POST", headers: { "content-type": "application/json", ...auth(s) }, signal: d.abort.signal,
      body: JSON.stringify({ model: d.modelo, stream: true }),
    });
    if (!r.ok) throw await failure(r, s);
    const layers = new Map();
    d.camadas = layers;
    let done = false;
    try {
      for await (const line of lines(r.body)) {
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.error) throw (/file does not exist|not found|manifest unknown/i.test(j.error) ? unknownOllama(d.modelo) : new Error(`${s.nome}: ${String(j.error).slice(0, 300)}`));
        const before = d.estado;
        if (j.digest && Number.isFinite(j.total)) {
          layers.set(j.digest, { total: j.total, completed: Number(j.completed) || 0 });
          let total = 0, got = 0;
          for (const l of layers.values()) { total += l.total; got += Math.min(l.completed, l.total); }
          d.total = Math.max(d.total, total); d.baixado = got; d.estado = "baixando";
        } else if (/^verifying|^writing|^removing/.test(j.status ?? "")) {
          d.estado = "conferindo"; if (d.total) d.baixado = d.total;
        } else if (j.status === "success") done = true;
        bump(d, d.estado !== before);
      }
    } catch (e) {
      // Cancelado pelo celular: o que ficou pela metade sai do disco. Queda de outro tipo fica, para continuar depois.
      if (d.abort.signal.aborted && isLocal(s.url)) {
        // Uma camada que outro download em andamento também está baixando fica.
        const shared = (x) => [...downloads.values()].some((o) => o !== d && !o.fim && !o.cancelado && o.camadas?.has(x));
        await dropPartials([...layers.keys()].filter((x) => !shared(x))).catch(() => {});
      }
      throw e;
    }
    if (!done) throw new Error(`O ${s.nome} parou o download antes do fim. Tente de novo: ele continua de onde parou.`);
  }

  async function pullFile(d, s) {
    const folder = (await comfyFolders(s))[0];
    if (!folder) throw new Error(`Não sei onde o ${s.nome} guarda os modelos neste computador.`);
    const final = join(folder, d.modelo), temp = `${final}.baixando`;
    if (existsSync(final)) throw new Error(`Já existe um modelo chamado ${d.modelo} neste computador.`);
    let r;
    try { r = await openFile(d.endereco, d.abort.signal); }
    catch (e) {
      if (d.abort.signal.aborted) throw e;
      if (/^O site /.test(e?.message ?? "")) throw e;
      throw new Error("Este computador não conseguiu abrir esse endereço. Confira o endereço e a internet do computador.");
    }
    try {
      refuseAnswer(r);
      d.total = Number(r.headers.get("content-length")) || d.total;
      roomFor(d.total, await freeSpace(folder));
    } catch (e) {
      r.body.destroy();
      throw e;
    }
    bump(d);
    const count = new Transform({ transform(chunk, _enc, next) { d.baixado += chunk.length; bump(d, false); next(null, chunk); } });
    try {
      await pipeline(r.body, count, createWriteStream(temp), { signal: d.abort.signal });
      if (d.total && d.baixado !== d.total) throw new Error("O download veio incompleto. Tente de novo.");
      d.estado = "conferindo"; bump(d);
      await rename(temp, final);
    } catch (e) {
      await unlink(temp).catch(() => {});
      throw e;
    }
  }

  async function startDownload(j) {
    const s = findServer(j?.servidor);
    let modelo, endereco = null;
    if (s.tipo === "ollama") modelo = ollamaName(j.modelo);
    else if (s.tipo === "comfyui") {
      const u = modelURL(j.endereco);
      modelo = (await probe(u, j.nome)).nome; endereco = u.href;
    } else throw new Error(`O ${s.nome} não deixa baixar modelos por aqui.`);
    // Um download cancelado agora mesmo ainda pode estar apagando o arquivo pela metade: espera ele sair.
    await [...downloads.values()].find((d) => d.cancelado && d.servidor === s.id && d.modelo === modelo)?.acabou;
    const running = [...downloads.values()].filter((d) => !d.fim && !d.cancelado);
    const same = running.find((d) => d.servidor === s.id && d.modelo === modelo);
    if (same) return same.id;
    if (running.length >= 3) throw new Error("Já há 3 downloads em andamento neste computador. Espere um terminar.");
    const d = { id: randomBytes(9).toString("base64url"), servidor: s.id, modelo, endereco, estado: "baixando", total: 0, baixado: 0,
                n: 1, fim: false, erro: null, waiters: [], abort: new AbortController(), avisado: 0, terminou: 0 };
    downloads.set(d.id, d);
    log(`Baixando ${modelo} (${s.nome}).`);
    d.acabou = (s.tipo === "ollama" ? pullOllama : pullFile)(d, s).then(() => { d.estado = "pronto"; if (d.total) d.baixado = d.total; }).catch((e) => {
      if (d.abort.signal.aborted) { d.estado = "cancelado"; d.erro = "Download cancelado."; return; }
      d.estado = "erro";
      d.erro = refused(e) ? offline(s).message : String(e.message ?? e);
    }).finally(() => {
      d.fim = true; d.terminou = Date.now();
      if (d.cancelado && d.estado !== "pronto") downloads.delete(d.id);
      log(d.estado === "pronto" ? `Modelo ${modelo} baixado (${s.nome}).` : `Download de ${modelo} (${s.nome}): ${d.erro}`);
      bump(d);
    });
    return d.id;
  }

  async function removeModel(j) {
    const s = findServer(j?.servidor);
    if (s.tipo === "ollama") {
      const modelo = ollamaName(j.modelo);
      let r;
      try {
        r = await fetch(`${s.url}/api/delete`, { method: "DELETE", headers: { "content-type": "application/json", ...auth(s) },
                                                 body: JSON.stringify({ model: modelo }), signal: AbortSignal.timeout(20000) });
      } catch { throw offline(s); }
      if (r.status === 404) throw new Error(`O modelo ${modelo} não está neste computador.`);
      if (!r.ok) throw await failure(r, s);
      log(`Modelo ${modelo} removido (${s.nome}).`);
      return;
    }
    if (s.tipo === "comfyui") {
      let names;
      try { names = await comfyCheckpoints(s); } catch { throw offline(s); }
      // Só apaga o que o próprio ComfyUI lista como modelo, e só de dentro da pasta de modelos dele.
      const file = typeof j.modelo === "string" && names.includes(j.modelo) ? comfyFile(await comfyFolders(s), j.modelo) : null;
      if (!file) throw new Error(`O modelo ${String(j.modelo).slice(0, 150)} não está neste computador.`);
      try { await unlink(file.path); } catch {
        // No Windows o arquivo fica preso enquanto o ComfyUI está com o modelo na memória.
        await fetch(`${s.url}/free`, { method: "POST", headers: { "content-type": "application/json" },
                                       body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(5000) }).catch(() => {});
        await sleep(2500);
        try { await unlink(file.path); } catch { throw new Error(`O ${s.nome} está usando esse modelo agora. Tente de novo daqui a pouco.`); }
      }
      log(`Modelo ${j.modelo} removido (${s.nome}).`);
      return;
    }
    throw new Error(`O ${s.nome} não deixa remover modelos por aqui.`);
  }

  // ---- Gerar imagem (ComfyUI) -------------------------------------------------------------------------

  const images = new Map();   // id → { server, estado, passo, passos, semente, largura, altura, n, fim, erro, waiters, abort, visto, criado, terminou, dados, formato, pedido }

  /** Tamanho base, passos e amostrador que combinam com o modelo, pelo nome e pelo tamanho do arquivo. */
  function imageDefaults(name, size) {
    const n = name.toLowerCase();
    const flux = /flux/.test(n);
    const fast = /turbo|lightning|schnell|hyper|lcm|dmd/.test(n);
    const old = /v1-5|v1\.5|sd15|sd_15|sd-?1\.5|v2-1|sd21/.test(n) && !/xl/.test(n);
    const big = /xl|flux|sd3|sd_3|pony|illustrious|noob|playground|kolors/.test(n);
    const base = old ? 512 : big ? 1024 : size && size < 5.2e9 ? 512 : 1024;
    if (fast) return { base, passos: 6, cfg: 1, amostrador: "euler", agenda: flux ? "simple" : "sgm_uniform" };
    if (flux) return { base, passos: 20, cfg: 1, amostrador: "euler", agenda: "simple" };
    return { base, passos: 25, cfg: 7, amostrador: "dpmpp_2m", agenda: "karras" };
  }
  const side = (v) => Math.max(256, Math.min(2048, Math.round(v / 64) * 64));

  async function imageRequest(j) {
    const s = findServer(j?.servidor);
    if (s.tipo !== "comfyui") throw new Error(`O ${s.nome} não gera imagem por aqui.`);
    if (typeof j.modelo !== "string" || !j.modelo) throw new Error("Faltou dizer o modelo.");
    const texto = typeof j.texto === "string" ? j.texto.trim() : "";
    if (!texto) throw new Error("Faltou descrever a imagem.");
    const d = imageDefaults(j.modelo, comfyFile(await comfyFolders(s), j.modelo)?.size ?? null);
    let largura, altura;
    if (Number.isInteger(j.largura) && Number.isInteger(j.altura)) { largura = side(j.largura); altura = side(j.altura); }
    else {
      const [a, b] = String(j.proporcao ?? "1:1").split(":").map(Number);
      const ratio = Math.max(1 / 3, Math.min(3, a > 0 && b > 0 ? a / b : 1));
      largura = side(d.base * Math.sqrt(ratio)); altura = side(d.base / Math.sqrt(ratio));
    }
    return {
      server: s, modelo: j.modelo, texto, negativo: typeof j.negativo === "string" ? j.negativo : "", largura, altura,
      passos: Number.isInteger(j.passos) && j.passos > 0 ? Math.min(j.passos, 150) : d.passos,
      semente: Number.isInteger(j.semente) && j.semente >= 0 ? j.semente : randomInt(0, 2 ** 48 - 1),
      cfg: d.cfg, amostrador: d.amostrador, agenda: d.agenda,
    };
  }

  /** O ComfyUI avisa o andamento por WebSocket. Se não abrir, a imagem sai do mesmo jeito, só sem contar os passos. */
  async function watchImage(job, s, client) {
    if (typeof WebSocket !== "function") return null;
    let ws;
    try { ws = new WebSocket(`${s.url.replace(/^http/, "ws")}/ws?clientId=${client}`); } catch { return null; }
    ws.addEventListener("error", () => {});
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const d = m.data ?? {};
      if (d.prompt_id && job.pedido && d.prompt_id !== job.pedido) return;
      if (m.type === "execution_start" && job.estado === "fila") { job.estado = "carregando"; job.aoVivo = true; bump(job); }
      else if (m.type === "progress" && Number.isFinite(d.value) && Number.isFinite(d.max)) {
        job.estado = "gerando"; job.passo = d.value; job.passos = d.max; job.aoVivo = true; bump(job);
      }
    });
    await Promise.race([new Promise((ok) => ws.addEventListener("open", ok, { once: true })),
                        new Promise((ok) => ws.addEventListener("error", ok, { once: true })), sleep(1500)]);
    return ws;
  }

  function comfyRefusal(j, status, p) {
    const first = Object.values(j?.node_errors ?? {})[0]?.errors?.[0];
    if (first?.type === "value_not_in_list" && /ckpt_name/.test(first.details ?? "")) {
      return `O modelo ${p.modelo} não está mais no ComfyUI. Atualize a lista de modelos no app.`;
    }
    const parts = [j?.error?.message, first?.message, first?.details].filter((t) => typeof t === "string" && t);
    return `O ComfyUI recusou o pedido: ${(parts.join(": ") || `resposta ${status}`).slice(0, 400)}`;
  }
  function comfyFailure(status) {
    const messages = Array.isArray(status?.messages) ? status.messages : [];
    const err = messages.find((m) => m?.[0] === "execution_error")?.[1];
    if (!err && messages.some((m) => m?.[0] === "execution_interrupted")) return "A geração foi interrompida no computador.";
    if (/OutOfMemory|out of memory/i.test(`${err?.exception_type} ${err?.exception_message}`)) {
      return "Faltou memória de vídeo para gerar a imagem. Feche programas pesados no computador ou escolha um modelo menor.";
    }
    return `O ComfyUI falhou ao gerar a imagem: ${String(err?.exception_message ?? "erro sem descrição").trim().slice(0, 300)}`;
  }

  async function runImage(job, s, p) {
    const client = randomBytes(12).toString("hex");
    const ws = await watchImage(job, s, client);
    try {
      const graph = {
        1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.modelo } },
        2: { class_type: "CLIPTextEncode", inputs: { text: p.texto, clip: ["1", 1] } },
        3: { class_type: "CLIPTextEncode", inputs: { text: p.negativo, clip: ["1", 1] } },
        4: { class_type: "EmptyLatentImage", inputs: { width: p.largura, height: p.altura, batch_size: 1 } },
        5: { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
                                               seed: p.semente, steps: p.passos, cfg: p.cfg, sampler_name: p.amostrador, scheduler: p.agenda, denoise: 1 } },
        6: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
        // Imagem de prévia: fica na pasta temporária do ComfyUI, que ele mesmo limpa, e não enche a pasta de saída do dono.
        7: { class_type: "PreviewImage", inputs: { images: ["6", 0] } },
      };
      // Sem o sinal de cancelar aqui: se o pedido já entrou na fila, é preciso saber o número dele para tirar de lá.
      const r = await fetch(`${s.url}/prompt`, { method: "POST", headers: { "content-type": "application/json" },
                                                 body: JSON.stringify({ prompt: graph, client_id: client }), signal: AbortSignal.timeout(30000) });
      let j = null;
      try { j = await r.json(); } catch {}
      if (!r.ok || typeof j?.prompt_id !== "string") throw new Error(comfyRefusal(j, r.status, p));
      job.pedido = j.prompt_id;
      if (job.abort.signal.aborted) throw new Error("cancelada");

      let misses = 0;
      while (true) {
        await sleep(1000);
        if (job.abort.signal.aborted) throw new Error("cancelada");
        let entry;
        try { entry = (await getJSON(`${s.url}/history/${job.pedido}`, { timeout: 5000 }))?.[job.pedido]; misses = 0; }
        catch { if (++misses >= 20) throw new Error(`O ${s.nome} parou de responder no meio da imagem.`); continue; }
        if (!entry) {
          if (!job.aoVivo) {
            // Sem aviso ao vivo, a fila diz ao menos se a imagem já começou.
            try {
              const q = await getJSON(`${s.url}/queue`);
              const running = (q.queue_running ?? []).some((e) => e?.[1] === job.pedido);
              if (running && job.estado === "fila") { job.estado = "gerando"; bump(job); }
            } catch {}
          }
          continue;
        }
        if (entry.status?.status_str === "error") throw new Error(comfyFailure(entry.status));
        const img = Object.values(entry.outputs ?? {}).flatMap((o) => (Array.isArray(o?.images) ? o.images : []))[0];
        if (!img?.filename) throw new Error("O ComfyUI terminou sem devolver imagem.");
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "temp" });
        // channel=rgb devolve um PNG limpo, sem o pedido inteiro gravado dentro do arquivo.
        let v = await fetch(`${s.url}/view?${q}&channel=rgb`, { signal: AbortSignal.timeout(60000) });
        if (!v.ok) v = await fetch(`${s.url}/view?${q}`, { signal: AbortSignal.timeout(60000) });
        if (!v.ok) throw new Error(`O ComfyUI gerou a imagem mas não entregou o arquivo (resposta ${v.status}).`);
        job.dados = Buffer.from(await v.arrayBuffer());
        job.formato = (v.headers.get("content-type") ?? "image/png").split(";")[0].trim() || "image/png";
        return;
      }
    } finally {
      try { ws?.close(); } catch {}
    }
  }

  async function cancelImage(job) {
    job.abort.abort();
    if (job.fim || !job.pedido || job.desfeito) return;
    job.desfeito = true;
    const s = job.server, post = (path, body) => fetch(`${s.url}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }).catch(() => {});
    await post("/queue", { delete: [job.pedido] });            // se ainda estava na fila
    await post("/interrupt", { prompt_id: job.pedido });       // se já estava gerando; só interrompe este pedido
  }

  // Cinco minutos depois da última imagem, pede ao ComfyUI para soltar a memória de vídeo, que é a mesma dos modelos de conversa.
  let release = null;
  function releaseLater(s) {
    clearTimeout(release);
    release = setTimeout(() => {
      if ([...images.values()].some((j) => !j.fim)) return;
      fetch(`${s.url}/free`, { method: "POST", headers: { "content-type": "application/json" },
                               body: JSON.stringify({ unload_models: true, free_memory: true }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }, 5 * 60 * 1000);
    release.unref();
  }

  function startImage(p) {
    const s = p.server;
    const job = { server: s, estado: "fila", passo: 0, passos: p.passos, semente: p.semente, largura: p.largura, altura: p.altura,
                  n: 1, fim: false, erro: null, waiters: [], abort: new AbortController(), avisado: 0,
                  visto: Date.now(), criado: Date.now(), terminou: 0, dados: null, formato: null, pedido: null, aoVivo: false };
    const id = randomBytes(9).toString("base64url");
    images.set(id, job);
    runImage(job, s, p).then(() => { job.estado = "pronta"; job.passo = job.passos; }).catch(async (e) => {
      if (job.abort.signal.aborted) {
        job.estado = "cancelada"; job.erro = job.erro ?? "Cancelada.";
        if (job.pedido) await cancelImage(job);
        return;
      }
      job.estado = "erro";
      job.erro = refused(e) ? offline(s).message : String(e.message ?? e);
      log(`Imagem local (${s.nome}, ${p.modelo}): ${job.erro}`);
    }).finally(() => {
      job.fim = true; job.terminou = Date.now();
      releaseLater(s);
      bump(job);
    });
    return id;
  }

  /** Consulta longa: espera até o trabalho mudar depois de "depois", ou o tempo acabar. */
  async function settle(job, req, url) {
    const after = Number(url.searchParams.get("depois") ?? 0) || 0;
    const wait = Math.max(0, Math.min(Number(url.searchParams.get("espera") ?? 20) || 0, 50)) * 1000;
    if (job.n > after || job.fim || wait <= 0) return;
    await new Promise((ok) => {
      const t = setTimeout(ok, wait);
      job.waiters.push(() => { clearTimeout(t); ok(); });
      req.on("close", () => { clearTimeout(t); ok(); });
    });
  }
  const parse = (body) => { try { return JSON.parse(body.toString("utf8")); } catch { throw new Error("Pedido inválido."); } };

  async function handle(req, res, url, body, json) {
    const path = url.pathname.slice("/ponte/locais".length);
    if (path === "" && req.method === "GET") return json(res, 200, { servidores: await discover() });

    if (path === "/conversa" && req.method === "POST") {
      let j;
      try {
        j = JSON.parse(body.toString("utf8"));
        if (typeof j.envio === "string") {
          const whole = assemble(j);
          if (!whole) return json(res, 200, { recebido: j.parte + 1, total: j.total });
          j = JSON.parse(whole.toString("utf8"));
        }
        return json(res, 200, { id: start(parseRequest(j)) });
      } catch (e) {
        return json(res, 400, { erro: e.message });
      }
    }

    if (path === "/consultar" && req.method === "POST") {
      try { return json(res, 200, await consult(parse(body))); } catch (e) { return json(res, 400, { erro: e.message }); }
    }
    if (path === "/pesquisar" && req.method === "POST") {
      try { return json(res, 200, await search(parse(body))); } catch (e) { return json(res, 400, { erro: e.message }); }
    }
    if (path === "/opcoes" && req.method === "POST") {
      try { return json(res, 200, await options(parse(body))); } catch (e) { return json(res, 400, { erro: e.message }); }
    }
    if (path === "/baixar" && req.method === "POST") {
      try { return json(res, 200, { id: await startDownload(parse(body)) }); } catch (e) { return json(res, 400, { erro: e.message }); }
    }
    if (path === "/baixar" && req.method === "GET") {
      return json(res, 200, { baixando: [...downloads.values()].filter((d) => !d.cancelado || d.fim).map(downloadView) });
    }
    const downloadID = path.match(/^\/baixar\/([A-Za-z0-9_-]+)$/)?.[1];
    if (downloadID) {
      const d = downloads.get(downloadID);
      if (!d || (d.cancelado && !d.fim)) return json(res, 404, { erro: "Este download não existe mais neste computador." });
      if (req.method === "DELETE") {
        // Cancelado no meio, o download some da lista assim que parar de vez; terminado, some na hora.
        if (d.fim) downloads.delete(downloadID);
        else { d.cancelado = true; d.abort.abort(); bump(d); }
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET") { await settle(d, req, url); return json(res, 200, downloadView(d)); }
    }
    if (path === "/remover" && req.method === "POST") {
      try { await removeModel(parse(body)); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { erro: e.message }); }
    }

    if (path === "/imagem" && req.method === "POST") {
      try { return json(res, 200, { id: startImage(await imageRequest(parse(body))) }); } catch (e) { return json(res, 400, { erro: e.message }); }
    }
    const image = path.match(/^\/imagem\/([A-Za-z0-9_-]+)(\/arquivo)?$/);
    if (image) {
      const job = images.get(image[1]);
      if (!job) return json(res, 404, { erro: "Esta imagem não existe mais neste computador." });
      job.visto = Date.now();
      if (image[2] && req.method === "GET") {
        if (!job.dados) return json(res, 404, { erro: "A imagem ainda não está pronta." });
        res.writeHead(200, { "content-type": job.formato, "content-length": job.dados.length });
        return res.end(job.dados);
      }
      if (!image[2] && req.method === "DELETE") {
        if (!job.fim) await cancelImage(job);
        images.delete(image[1]);
        return json(res, 200, { ok: true });
      }
      if (!image[2] && req.method === "GET") {
        await settle(job, req, url);
        job.visto = Date.now();
        return json(res, 200, {
          estado: job.estado, passo: job.passo, passos: job.passos, semente: job.semente, largura: job.largura, altura: job.altura,
          proximo: job.n, fim: job.fim, erro: job.fim ? job.erro : null,
          imagem: job.dados ? { tipo: job.formato, tamanho: job.dados.length } : null,
        });
      }
    }

    const id = path.match(/^\/conversa\/([A-Za-z0-9_-]+)$/)?.[1];
    const job = id ? jobs.get(id) : null;
    if (id && !job) return json(res, 404, { erro: "Esta resposta não existe mais neste computador." });
    if (job && req.method === "DELETE") {
      if (!job.fim) { job.cancelada = true; job.erro = "Cancelada."; job.abort.abort(); }
      jobs.delete(id);
      return json(res, 200, { ok: true });
    }
    if (job && req.method === "GET") {
      const after = Math.max(0, Math.min(Number(url.searchParams.get("depois") ?? 0) || 0, job.eventos.length));
      const wait = Math.max(0, Math.min(Number(url.searchParams.get("espera") ?? 20) || 0, 50)) * 1000;
      job.visto = Date.now();
      if (job.eventos.length <= after && !job.fim && wait > 0) {
        await new Promise((ok) => {
          const t = setTimeout(ok, wait);
          job.waiters.push(() => { clearTimeout(t); ok(); });
          req.on("close", () => { clearTimeout(t); ok(); });
        });
        // Espera um instante para juntar mais texto na mesma entrega (cada entrega é uma ida e volta).
        if (!job.fim) await sleep(150);
      }
      const fresh = job.eventos.slice(after);
      const pedacos = [];
      for (const e of fresh) {
        const last = pedacos.at(-1);
        if (last && last.tipo === e.tipo) last.texto += e.texto; else pedacos.push({ ...e });
      }
      job.visto = Date.now();
      return json(res, 200, { pedacos, proximo: after + fresh.length, fim: job.fim, erro: job.fim ? job.erro : null, uso: job.fim ? job.uso : null });
    }
    return json(res, 404, { erro: "Endereço desconhecido." });
  }

  return { handle, discover };
}
