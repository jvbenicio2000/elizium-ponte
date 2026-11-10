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
//
// O contrato completo, com os campos, está em LOCAIS.md na raiz deste repositório.
//
// O app nunca manda um endereço: manda o "id" de um servidor desta lista. A ponte só chama os endereços
// daqui e os que o dono do computador escreveu em ~/.elizium-ponte/config.json:
//   { "locais": { "contexto": 16384, "servidores": [ { "nome": "vLLM", "url": "http://127.0.0.1:8000", "chave": "" } ] } }

import { randomBytes } from "node:crypto";

const STEPS = [4096, 8192, 16384, 32768, 65536, 131072];
const VISION_HINTS = ["vision", "llava", "bakllava", "-vl", "vl-", "vlm", "minicpm-v", "moondream", "pixtral", "gemma3", "gemma-3",
                      "gemma4", "gemma-4", "qwen2.5vl", "qwen3-vl", "idefics", "paligemma", "smolvlm", "internvl", "llama4", "granite3.2-vision"];
const visionHint = (name) => { const n = name.toLowerCase(); return VISION_HINTS.some((h) => n.includes(h)) && !/gemma-?3[:\-](1b|270m)/.test(n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  ];
  const extra = (Array.isArray(settings.servidores) ? settings.servidores : [])
    .filter((s) => s && typeof s.url === "string" && /^https?:\/\//.test(s.url))
    .map((s, i) => ({
      id: `config${i + 1}`, nome: String(s.nome ?? `Servidor ${i + 1}`),
      tipo: ["ollama", "lmstudio", "openai"].includes(s.tipo) ? s.tipo : "openai",
      url: s.url.replace(/\/+$/, "").replace(/\/v1$/, ""), chave: typeof s.chave === "string" ? s.chave : "",
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
      return {
        id: name, nome: name, tipo: "texto",
        imagem: caps.length ? caps.includes("vision") : visionHint(name),
        raciocinio: caps.includes("thinking"),
        contexto: Number.isInteger(running) && running > 0 ? running : Math.min(show.contexto ?? contextCap, contextCap),
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

  const listers = { ollama: ollamaModels, lmstudio: lmStudioModels, openai: openAIModels };
  async function discover() {
    const found = await Promise.all(servers.map(async (s) => {
      try {
        return { id: s.id, nome: s.nome, tipo: s.tipo, modelos: await listers[s.tipo](s) };
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
