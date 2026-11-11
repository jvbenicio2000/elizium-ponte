// Claude Code como segundo agente da ponte, ao lado do OpenCode.
//
// O app fala com /claude/... usando o mesmo formato que já usa com o OpenCode (sessões, mensagens,
// prompt_async, status, permissões, lista de provedores), então a mesma tela serve para os dois.
// - Cada mensagem roda "claude -p" na pasta do projeto, com --session-id (sessão nova) ou --resume.
// - As mensagens vêm do histórico que o próprio Claude Code grava em ~/.claude/projects, então as
//   sessões abertas no terminal do computador também aparecem no iPhone.
// - Os pedidos de permissão chegam pelo protocolo do Claude Code (control_request can_use_tool) e
//   viram pedidos no app, como os do OpenCode.
// - Modelos de outros provedores passam pelo tradutor (gateway.mjs), com as chaves do OpenCode.
// - A política da empresa vale aqui também: regras "deny" viram regras de bloqueio do Claude Code e
//   cada pedido de permissão é conferido contra ela; com política não existe "liberar tudo".
// - Trocar de modelo no meio da sessão: o Claude Code guarda as instruções da primeira mensagem e repete as
//   mesmas depois, com o nome do primeiro modelo. A ponte pede as instruções de novo a cada mensagem e diz
//   ao modelo de outro provedor quem ele é (0.10.0).

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const MODES = { pedir: "manual", editar: "acceptEdits", tudo: "bypassPermissions", planejar: "plan" };

/** Nome da pasta do histórico do Claude Code para um projeto: tudo que não é letra ou número vira "-". */
const projectKey = (dir) => dir.replace(/[^a-zA-Z0-9]/g, "-");

/** Curinga do OpenCode: * qualquer coisa (inclusive /), ? um caractere. */
function wildcard(pattern, value) {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".") + "$");
  return re.test(value ?? "");
}

/** Ferramenta do Claude Code → permissão do OpenCode e o valor que as regras da empresa conferem. */
function asOpenCode(tool, input = {}) {
  switch (tool) {
    case "Bash": return ["bash", input.command];
    case "Read": return ["read", input.file_path];
    case "Write": case "Edit": case "MultiEdit": return ["edit", input.file_path];
    case "NotebookEdit": return ["edit", input.notebook_path];
    case "Glob": return ["glob", input.pattern];
    case "Grep": return ["grep", input.pattern];
    case "WebFetch": return ["webfetch", input.url];
    case "WebSearch": return ["websearch", input.query];
    case "Task": case "Agent": return ["task", input.description ?? ""];
    default: return [tool.toLowerCase(), JSON.stringify(input)];
  }
}

/** Regras "deny" da empresa no formato de bloqueio do Claude Code (permissions.deny). */
function denyRules(p) {
  const tools = { bash: ["Bash"], read: ["Read"], edit: ["Edit", "Write", "MultiEdit", "NotebookEdit"], glob: ["Glob"], grep: ["Grep"],
                  webfetch: ["WebFetch"], websearch: ["WebSearch"], task: ["Task", "Agent"] };
  const out = [];
  for (const r of p?.regras ?? []) {
    if (r.action !== "deny") continue;
    const names = r.permission === "*" ? Object.values(tools).flat() : tools[r.permission] ?? [];
    for (const n of names) {
      if (r.pattern === "*") out.push(n);
      else if (n === "Bash") out.push(`Bash(${r.pattern})`);
      else if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(n)) out.push(`${n}(${pathRule(r.pattern)})`);
    }
  }
  return [...new Set(out)];
}

/** Caminho do OpenCode (curinga sobre o caminho inteiro) → regra de caminho do Claude Code (estilo gitignore). */
function pathRule(pattern) {
  if (pattern.startsWith("*")) return "**/" + pattern.replace(/^\*+/, "*");   // em qualquer pasta
  if (pattern.startsWith("/")) return "/" + pattern;                         // "//" = absoluto no Claude Code
  return pattern;
}

/** Resumo curto do que uma ferramenta vai fazer, para o pedido de permissão e a lista de mensagens. */
function describe(tool, input = {}) {
  const p = input.file_path ?? input.notebook_path;
  switch (tool) {
    case "Bash": return { what: "rodar um comando", detail: input.command ?? "" };
    case "Write": return { what: "criar um arquivo", detail: p ?? "" };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { what: "editar um arquivo", detail: p ?? "" };
    case "Read": return { what: "ler um arquivo", detail: p ?? "" };
    case "WebFetch": return { what: "abrir uma página", detail: input.url ?? "" };
    case "WebSearch": return { what: "pesquisar na web", detail: input.query ?? "" };
    case "Glob": case "Grep": return { what: "procurar arquivos", detail: input.pattern ?? "" };
    case "Task": case "Agent": return { what: "chamar um subagente", detail: input.description ?? "" };
    default: return { what: `usar ${tool}`, detail: "" };
  }
}

const textOf = (content) => typeof content === "string" ? content
  : (content ?? []).map((b) => b.type === "text" ? b.text : b.type === "image" ? "[imagem]" : "").filter(Boolean).join("\n");

export function createClaudeCode({ claude, projectDir, infoDir, isWindows, pushEvent, policy, gateway, openCode }) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const historyDir = join(configDir, "projects", projectKey(projectDir));
  const runDir = join(infoDir, "claude");
  mkdirSync(runDir, { recursive: true });
  const metaFile = join(infoDir, "claude-sessoes.json");
  let meta = {};
  try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch {}
  const saveMeta = () => writeFileSync(metaFile, JSON.stringify(meta, null, 2));

  const running = new Map();     // sessão → { child, aborted }
  const asks = new Map();        // id → { id, sessionID, tool, input, answer(reply) }
  const always = new Map();      // sessão → Set(ferramenta)

  let version = null;
  function info() {
    if (!claude) return { instalado: false };
    if (version === null) {
      try { version = execFileSync(claude, ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true, shell: isWindows && /\.cmd$/i.test(claude) }).trim(); }
      catch { version = ""; }
    }
    return { instalado: true, versao: version, aplicado: appliedGlobal() };
  }

  /** Roda o Claude Code só para ler o que ele escreve (ajuda, erro de opção); não manda pedido nenhum. */
  function claudeSays(args) {
    const viaCmd = isWindows && /\.cmd$/i.test(claude);
    try {
      return execFileSync(viaCmd ? "cmd.exe" : claude, viaCmd ? ["/d", "/s", "/c", claude, ...args] : args,
        { encoding: "utf8", timeout: 20000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return String(e.stdout ?? "") + String(e.stderr ?? "");
    }
  }

  let options = null;
  /** Quais opções novas este Claude Code conhece (as dos antigos não têm todas). Confere uma vez só. */
  function known() {
    if (options) return options;
    const help = claudeSays(["--help"]);
    if (!help.includes("--model")) return { snapshot: false, file: false };   // não respondeu: tenta de novo na próxima
    // A opção do arquivo não aparece na ajuda; com um arquivo que não existe, quem conhece reclama do arquivo
    // e quem não conhece reclama da opção, e nenhum dos dois chega a mandar pedido.
    const probe = claudeSays(["-p", "--append-system-prompt-file", join(runDir, "nao-existe.txt"), "x"]);
    options = { snapshot: help.includes("--system-prompt-snapshot"), file: /file not found/i.test(probe) };
    return options;
  }

  /**
   * O que vai no fim das instruções do Claude Code: quem é o modelo, quando ele não é da conta do Claude Code
   * (as instruções do Claude Code dizem a qualquer modelo que ele é o Claude), e o texto que o app mandar.
   */
  function extraInstructions(providerID, modelID, fromApp) {
    const parts = [];
    if (providerID !== "claude") {
      const who = `o modelo ${modelID}, do provedor ${providerID}`;
      parts.push(`Quem responde agora é ${who}, rodando dentro do Claude Code.`
        + (/claude/i.test(modelID) ? "" : " Você não é o Claude nem um modelo da Anthropic.")
        + ` Se perguntarem quem é você ou qual modelo está respondendo, diga que é ${who}.`
        + " As falas anteriores desta sessão podem ter vindo de outro modelo.");
    }
    if (typeof fromApp === "string" && fromApp.trim()) parts.push(fromApp.trim().slice(0, 8000));
    return parts.join("\n\n");
  }

  const historyFile = (id) => {
    const direct = join(historyDir, `${id}.jsonl`);
    if (existsSync(direct)) return direct;
    // Sessões abertas em outra pasta: procura em todas.
    try {
      for (const d of readdirSync(join(configDir, "projects"))) {
        const f = join(configDir, "projects", d, `${id}.jsonl`);
        if (existsSync(f)) return f;
      }
    } catch {}
    return null;
  };

  function readLines(file) {
    if (!file) return [];
    const out = [];
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch {}
    }
    return out;
  }

  /** Histórico do Claude Code → mensagens no formato do OpenCode que o app já lê. */
  function messages(id) {
    const out = [];
    let cur = null;
    const tools = new Map();
    const usage = new Map();       // id da mensagem da API → uso
    for (const j of readLines(historyFile(id))) {
      if ((j.type !== "user" && j.type !== "assistant") || j.isSidechain || j.isMeta || !j.message) continue;
      const c = j.message.content;
      if (j.type === "user") {
        const blocks = typeof c === "string" ? [{ type: "text", text: c }] : (c ?? []);
        for (const r of blocks.filter((b) => b.type === "tool_result")) {
          const part = tools.get(r.tool_use_id);
          if (part) { part.state.status = r.is_error ? "error" : "completed"; part.state.output = textOf(r.content).slice(0, 20000); }
        }
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        // Saídas de comandos internos e avisos do sistema não são falas do usuário.
        if (!text || text.startsWith("<") || j.toolUseResult) continue;
        cur = null;
        out.push({ info: { id: j.uuid, role: "user", time: { created: Date.parse(j.timestamp) || 0 } },
                   parts: [{ id: j.uuid + "-t", type: "text", text }] });
        continue;
      }
      if (!cur) {
        cur = { info: { id: j.message.id ?? j.uuid, role: "assistant", modelID: j.message.model, providerID: meta[id]?.provedor ?? "claude",
                        time: { created: Date.parse(j.timestamp) || 0 }, tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
                parts: [], apiIDs: new Set() };
        out.push(cur);
      }
      if (j.message.model && j.message.model !== "<synthetic>") cur.info.modelID = j.message.model;
      if (j.message.id && j.message.usage) usage.set(j.message.id, { owner: cur, u: j.message.usage });
      (Array.isArray(c) ? c : []).forEach((b, i) => {
        const pid = `${j.uuid}-${i}`;
        if (b.type === "text" && b.text) cur.parts.push({ id: pid, type: "text", text: b.text });
        else if (b.type === "thinking" && b.thinking) cur.parts.push({ id: pid, type: "reasoning", text: b.thinking });
        else if (b.type === "tool_use") {
          const d = describe(b.name, b.input);
          const part = { id: b.id, type: "tool", tool: b.name, state: { status: "running", title: d.detail || d.what } };
          tools.set(b.id, part);
          cur.parts.push(part);
        }
      });
    }
    for (const { owner, u } of usage.values()) {
      owner.info.tokens.input += u.input_tokens ?? 0;
      owner.info.tokens.output += u.output_tokens ?? 0;
      owner.info.tokens.cache.read += u.cache_read_input_tokens ?? 0;
      owner.info.tokens.cache.write += u.cache_creation_input_tokens ?? 0;
    }
    const busy = running.has(id);
    out.forEach((m, i) => {
      if (m.info.role !== "assistant") return;
      delete m.apiIDs;
      if (!busy || i < out.length - 1) m.info.time.completed = m.info.time.created;
      if (!busy) for (const p of m.parts) if (p.type === "tool" && p.state.status === "running") p.state.status = "error";
    });
    const failure = meta[id]?.erro;
    // A fala "<synthetic>" do Claude Code repete o erro: fica só a mensagem de erro.
    if (failure && !busy) while (out.at(-1)?.info.role === "assistant" && out.at(-1).info.modelID === "<synthetic>") out.pop();
    if (failure && !busy) out.push({ info: { id: `erro-${failure.quando}`, role: "assistant", error: { name: "Erro", data: { message: failure.texto } },
                                             time: { created: failure.quando, completed: failure.quando } }, parts: [] });
    return out;
  }

  function firstPrompt(file) {
    for (const j of readLines(file)) {
      if (j.type !== "user" || j.isMeta || j.isSidechain) continue;
      const c = j.message?.content;
      const t = (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ")).trim();
      if (t && !t.startsWith("<")) return t.slice(0, 60);
    }
    return null;
  }

  function sessions() {
    const list = new Map();
    for (const [id, m] of Object.entries(meta)) list.set(id, { id, title: m.titulo, time: { created: m.criado, updated: m.atualizado ?? m.criado } });
    try {
      for (const f of readdirSync(historyDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const id = basename(f, ".jsonl");
        const file = join(historyDir, f);
        const st = statSync(file);
        const known = list.get(id);
        list.set(id, { id, title: known?.title ?? firstPrompt(file) ?? "Sessão do Claude Code",
                       time: { created: known?.time.created ?? st.birthtimeMs, updated: Math.max(st.mtimeMs, known?.time.updated ?? 0) } });
      }
    } catch {}
    return [...list.values()].sort((a, b) => b.time.updated - a.time.updated);
  }

  /** Provedores para o Claude Code: a conta do próprio Claude Code e os do OpenCode que têm chave. */
  async function providers() {
    const providers = [{ id: "claude", name: "Claude Code (conta do computador)", models: {
      padrao: { id: "padrao", name: "Padrão do Claude Code", capabilities: { toolcall: true, input: { image: true, pdf: true } } },
      opus: { id: "opus", name: "Opus", capabilities: { toolcall: true, input: { image: true, pdf: true } } },
      sonnet: { id: "sonnet", name: "Sonnet", capabilities: { toolcall: true, input: { image: true, pdf: true } } },
      haiku: { id: "haiku", name: "Haiku", capabilities: { toolcall: true, input: { image: true, pdf: true } } },
    } }];
    const defaults = { claude: "padrao" };
    try {
      const oc = await openCode("/config/providers");
      for (const p of oc.providers ?? []) {
        // Os modelos grátis do OpenCode só atendem o próprio OpenCode.
        if (p.id === "opencode" || !(await keyFor(p))) continue;
        const models = Object.fromEntries(Object.entries(p.models ?? {}).filter(([, m]) => m.capabilities?.toolcall !== false && m.tool_call !== false));
        if (!Object.keys(models).length) continue;
        providers.push({ ...p, models });
        if (oc.default?.[p.id]) defaults[p.id] = oc.default[p.id];
      }
    } catch {}
    return { providers, default: defaults };
  }

  function authFile() {
    const candidates = [
      join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"),
      join(process.env.LOCALAPPDATA ?? "", "opencode", "auth.json"),
    ];
    return candidates.find((f) => existsSync(f));
  }
  async function keyFor(p) {
    let auth = {};
    try { auth = JSON.parse(readFileSync(authFile(), "utf8")); } catch {}
    const a = auth[p.id];
    if (a?.type === "api" && a.key) return a.key;
    if (p.options?.apiKey) return p.options.apiKey;
    for (const e of p.env ?? []) if (process.env[e]) return process.env[e];
    return null;
  }

  /** Para o tradutor: onde e com qual chave chamar um modelo. */
  async function resolve(providerID, modelID) {
    const oc = await openCode("/config/providers");
    const p = (oc.providers ?? []).find((x) => x.id === providerID);
    if (!p) throw new Error(`O provedor ${providerID} não está no OpenCode deste computador. Envie a chave dele pelo iPhone.`);
    const m = p.models?.[modelID] ?? Object.values(p.models ?? {}).find((x) => x.id === modelID);
    if (!m) throw new Error(`O modelo ${modelID} não existe em ${providerID}.`);
    const key = await keyFor(p);
    if (!key) throw new Error(`Falta a chave de ${providerID} neste computador.`);
    return { kind: m.api?.npm === "@ai-sdk/anthropic" ? "anthropic" : "openai", base: m.api?.url || p.options?.baseURL || "", npm: m.api?.npm ?? "",
             key, model: m.api?.id ?? modelID, maxOutput: m.limit?.output };
  }

  /** Variáveis que mandam o Claude Code para o tradutor com um modelo. */
  function gatewayEnv(providerID, modelID) {
    return {
      ANTHROPIC_BASE_URL: gateway.base(providerID), ANTHROPIC_AUTH_TOKEN: gateway.secret, ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: modelID, ANTHROPIC_DEFAULT_OPUS_MODEL: modelID, ANTHROPIC_DEFAULT_SONNET_MODEL: modelID,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelID, ANTHROPIC_SMALL_FAST_MODEL: modelID, CLAUDE_CODE_SUBAGENT_MODEL: modelID,
    };
  }
  const GATEWAY_KEYS = Object.keys(gatewayEnv("x", "y"));
  // Apontado para um endereço que não é o da Anthropic, o Claude Code manda a cada pedido a descrição de todas as
  // ferramentas dos servidores MCP do computador (num PC eram 220 mil tokens, mais do que cabe em quase todo
  // modelo). Com isto ele manda só os nomes e o modelo busca a ferramenta que quiser; o tradutor entende a busca.
  // Fica fora de GATEWAY_KEYS de propósito: com a conta do Claude Code essas chaves vão vazias, e esta não pode.
  const TOOL_SEARCH = { ENABLE_TOOL_SEARCH: "true" };
  const POINTED_KEYS = [...GATEWAY_KEYS, ...Object.keys(TOOL_SEARCH)];

  function start(id, body) {
    if (running.has(id)) throw new Error("O Claude Code ainda está trabalhando nesta sessão.");
    const p = policy();
    if (p?.claudeCode === false) throw new Error(`A política de ${p.empresa} não libera o Claude Code neste computador.`);
    const text = (body.parts ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
    if (!text) throw new Error("Mensagem vazia.");
    const providerID = body.model?.providerID ?? "claude";
    const modelID = body.model?.modelID ?? "padrao";
    let mode = MODES[body.modo] ?? "manual";
    if (p && mode === "bypassPermissions") mode = "manual";

    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
                  "--permission-prompt-tool", "stdio", "--permission-mode", mode];
    args.push(...(historyFile(id) ? ["--resume", id] : ["--session-id", id]));
    // Com a conta do Claude Code, as variáveis do tradutor ficam vazias, mesmo se o Claude Code do computador
    // estiver apontado para cá. Com outro provedor, apontam para o tradutor.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k) || k === "CLAUDE_CONFIG_DIR"));
    let settingsEnv;
    if (providerID === "claude") {
      // "default" é dito sempre: ao retomar, o Claude Code repetiria o modelo da última resposta da sessão.
      args.push("--model", modelID === "padrao" ? "default" : modelID);
      settingsEnv = Object.fromEntries(GATEWAY_KEYS.map((k) => [k, ""]));
    } else {
      settingsEnv = { ...gatewayEnv(providerID, modelID), ...TOOL_SEARCH };
      Object.assign(env, settingsEnv);
      args.push("--model", modelID);
    }
    const settings = { env: settingsEnv };
    const deny = denyRules(p);
    if (deny.length) settings.permissions = { deny };
    const settingsFile = join(runDir, `${id}.json`);
    writeFileSync(settingsFile, JSON.stringify(settings));
    args.push("--settings", settingsFile);

    const viaCmd = isWindows && /\.cmd$/i.test(claude);
    // Sem isto, o Claude Code repete na sessão inteira as instruções da primeira mensagem, com o nome do
    // primeiro modelo, e o modelo novo responde como se fosse o antigo.
    const can = known();
    if (can.snapshot) args.push("--system-prompt-snapshot", "off");
    const extra = extraInstructions(providerID, modelID, body.system);
    const extraFile = join(runDir, `${id}.txt`);
    if (extra) {
      if (can.file) {
        writeFileSync(extraFile, extra);
        args.push("--append-system-prompt-file", extraFile);
      } else if (!viaCmd) {
        args.push("--append-system-prompt", extra);
      } else {
        // Pelo cmd.exe do Windows só passa texto simples: sem aspas, sem sinais que o cmd interpreta, sem acentos.
        args.push("--append-system-prompt", extra.normalize("NFD").replace(/[^A-Za-z0-9 .,:;\/_@-]/g, "").slice(0, 2000));
      }
    }
    const child = spawn(viaCmd ? "cmd.exe" : claude, viaCmd ? ["/d", "/s", "/c", claude, ...args] : args,
                        { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const run = { child, aborted: false, stderr: "", result: null };
    running.set(id, run);
    meta[id] = { ...(meta[id] ?? { titulo: text.slice(0, 60), criado: Date.now() }), atualizado: Date.now(), provedor: providerID, modelo: modelID };
    delete meta[id].erro;
    saveMeta();
    const ping = (type, extra = {}) => pushEvent({ type, properties: { sessionID: id, ...extra } });
    ping("session.status", { status: { type: "busy" } });

    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let cut;
      while ((cut = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, cut).trim(); buf = buf.slice(cut + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.type === "control_request" && j.request?.subtype === "can_use_tool") { ask(id, run, j); continue; }
        if (j.type === "result") { run.result = j; try { child.stdin.end(); } catch {} }
        if (j.type === "assistant" || j.type === "user" || j.type === "result") ping("message.updated");
      }
    });
    child.stderr.on("data", (d) => { run.stderr = (run.stderr + d).slice(-4000); });
    child.on("error", (e) => { run.stderr += e.message; });
    child.on("close", (code) => {
      running.delete(id);
      for (const [k, a] of asks) if (a.sessionID === id) asks.delete(k);
      rmSync(settingsFile, { force: true });
      rmSync(extraFile, { force: true });
      const r = run.result;
      const failed = !run.aborted && (code !== 0 || r?.is_error);
      if (failed) {
        const texto = r?.result || r?.errors?.join("; ") || run.stderr.split("\n").filter((l) => l.trim() && !/connectors are disabled|unrecognized_model/.test(l)).slice(-3).join(" ")
          || `O Claude Code parou (código ${code}).`;
        meta[id] = { ...meta[id], erro: { texto, quando: Date.now() } };
        ping("session.error", { error: { name: "Erro", data: { message: texto } } });
      }
      meta[id] = { ...meta[id], atualizado: Date.now() };
      saveMeta();
      ping("session.idle");
      ping("session.status", { status: { type: "idle" } });
    });
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  }

  /** Um pedido de permissão do Claude Code: confere a política e, se não for decidido aqui, pergunta ao iPhone. */
  function ask(sessionID, run, j) {
    const { tool_name: tool, input } = j.request;
    const reply = (allow, message) => {
      const response = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: message ?? "O usuário recusou pelo iPhone." };
      try { run.child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: j.request_id, response } }) + "\n"); } catch {}
      pushEvent({ type: "permission.replied", properties: { sessionID } });
    };
    const p = policy();
    if (p) {
      const [perm, value] = asOpenCode(tool, input);
      const rule = [...p.regras].reverse().find((r) => (r.permission === "*" || r.permission === perm) && wildcard(r.pattern, value));
      if (rule?.action === "deny") return reply(false, `Bloqueado pela política de ${p.empresa}.`);
    }
    if (always.get(sessionID)?.has(tool)) return reply(true);
    const id = "per_" + randomUUID();
    asks.set(id, { id, sessionID, tool, input, answer: (r) => {
      asks.delete(id);
      if (r === "always") { if (!always.has(sessionID)) always.set(sessionID, new Set()); always.get(sessionID).add(tool); }
      reply(r === "once" || r === "always");
    } });
    pushEvent({ type: "permission.asked", properties: { sessionID } });
  }

  // --- Claude Code do computador: aplicar ou tirar um modelo no settings.json do usuário ---
  const userSettings = join(configDir, "settings.json");
  const backupFile = join(infoDir, "claude-settings-antes.json");
  function readSettings() { try { return JSON.parse(readFileSync(userSettings, "utf8")); } catch { return {}; } }
  function appliedGlobal() {
    const env = readSettings().env ?? {};
    const m = (env.ANTHROPIC_BASE_URL ?? "").match(/\/p\/([^/]+)$/);
    return m && env.ANTHROPIC_BASE_URL.startsWith(`http://127.0.0.1:${gateway.port}/`) ? { provedor: decodeURIComponent(m[1]), modelo: env.ANTHROPIC_MODEL } : null;
  }
  function applyGlobal(providerID, modelID) {
    const s = readSettings();
    s.env = s.env ?? {};
    // Guarda só o que ainda não está guardado: trocar o modelo já aplicado não pode pôr no "antes" o que a ponte escreveu.
    let before = {};
    if (appliedGlobal()) { try { before = JSON.parse(readFileSync(backupFile, "utf8")); } catch {} }
    for (const k of POINTED_KEYS) if (!(k in before)) before[k] = s.env[k] ?? null;
    writeFileSync(backupFile, JSON.stringify(before));
    Object.assign(s.env, gatewayEnv(providerID, modelID), TOOL_SEARCH);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(userSettings, JSON.stringify(s, null, 2));
  }
  function restoreGlobal() {
    const s = readSettings();
    let before = {};
    try { before = JSON.parse(readFileSync(backupFile, "utf8")); } catch {}
    s.env = s.env ?? {};
    for (const k of POINTED_KEYS) {
      if (!(k in before) && !GATEWAY_KEYS.includes(k)) continue;   // guardado por uma ponte antiga, que não mexia nesta
      if (before[k] == null) delete s.env[k]; else s.env[k] = before[k];
    }
    if (!Object.keys(s.env).length) delete s.env;
    writeFileSync(userSettings, JSON.stringify(s, null, 2));
    rmSync(backupFile, { force: true });
  }

  // --- Rotas /claude/... ---
  async function handle(req, res, path, body, json) {
    if (!claude) return json(res, 404, { erro: "O Claude Code não está instalado neste computador. Instale em claude.com/code e religue a ponte." });
    const parsed = () => { try { return JSON.parse(body.toString("utf8") || "{}"); } catch { return {}; } };
    let m;
    if (path === "/session" && req.method === "GET") return json(res, 200, sessions());
    if (path === "/session" && req.method === "POST") {
      const id = randomUUID();
      meta[id] = { titulo: parsed().title ?? "Sessão do iPhone", criado: Date.now(), atualizado: Date.now() };
      saveMeta();
      return json(res, 200, { id, title: meta[id].titulo, time: { created: meta[id].criado, updated: meta[id].atualizado } });
    }
    if (path === "/session/status") return json(res, 200, Object.fromEntries([...running.keys()].map((k) => [k, { type: "busy" }])));
    if ((m = path.match(/^\/session\/([^/]+)$/))) {
      const id = m[1];
      if (req.method === "PATCH") { meta[id] = { ...(meta[id] ?? { criado: Date.now() }), titulo: parsed().title, atualizado: Date.now() }; saveMeta(); return json(res, 200, { id }); }
      if (req.method === "DELETE") {
        running.get(id)?.child.kill();
        const f = historyFile(id);
        if (f) rmSync(f, { force: true });
        delete meta[id]; saveMeta();
        return json(res, 200, true);
      }
      const s = sessions().find((x) => x.id === id);
      return s ? json(res, 200, s) : json(res, 404, { erro: "Sessão não encontrada." });
    }
    if ((m = path.match(/^\/session\/([^/]+)\/message$/))) return json(res, 200, messages(m[1]));
    if ((m = path.match(/^\/session\/([^/]+)\/(prompt_async|message)$/)) && req.method === "POST") {
      try { start(m[1], parsed()); } catch (e) { return json(res, 400, { erro: e.message }); }
      res.writeHead(204); return res.end();
    }
    if ((m = path.match(/^\/session\/([^/]+)\/abort$/))) {
      const r = running.get(m[1]);
      if (r) { r.aborted = true; r.child.kill(); }
      return json(res, 200, true);
    }
    if (path === "/permission") {
      return json(res, 200, [...asks.values()].map((a) => {
        const d = describe(a.tool, a.input);
        return { id: a.id, sessionID: a.sessionID, permission: d.what, patterns: d.detail ? [d.detail] : [], always: [a.tool] };
      }));
    }
    if ((m = path.match(/^\/permission\/([^/]+)\/reply$/))) {
      const a = asks.get(m[1]);
      if (!a) return json(res, 404, { erro: "Esse pedido já foi respondido." });
      a.answer(parsed().reply);
      return json(res, 200, true);
    }
    if (path === "/config/providers") return json(res, 200, await providers());
    if (path === "/computador") {
      if (req.method === "GET") return json(res, 200, { aplicado: appliedGlobal() });
      const b = parsed();
      if (b.padrao) { restoreGlobal(); return json(res, 200, { aplicado: null }); }
      if (!b.provedor || !b.modelo || b.provedor === "claude") return json(res, 400, { erro: "Escolha um provedor e um modelo de fora da conta do Claude Code." });
      try { await resolve(b.provedor, b.modelo); } catch (e) { return json(res, 400, { erro: e.message }); }
      applyGlobal(b.provedor, b.modelo);
      return json(res, 200, { aplicado: appliedGlobal() });
    }
    return json(res, 404, { erro: `Rota desconhecida do Claude Code: ${path}` });
  }

  return { handle, info, resolve };
}
