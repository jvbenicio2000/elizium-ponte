// Teste: chama a parte de modelos locais da ponte direto neste computador, sem celular e sem pareamento,
// contra os servidores de verdade que estiverem ligados aqui (Ollama, ComfyUI…). Usa o mesmo config.json da ponte.
//
//   node teste-locais.mjs lista
//   node teste-locais.mjs consultar ollama gemma3:270m
//   node teste-locais.mjs consultar comfyui https://…/modelo.safetensors
//   node teste-locais.mjs baixar ollama gemma3:270m            (acompanha até o fim; Ctrl+C cancela o download)
//   node teste-locais.mjs baixar comfyui https://…/modelo.safetensors
//   node teste-locais.mjs remover ollama gemma3:270m
//   node teste-locais.mjs imagem comfyui sd_xl_base_1.0.safetensors "um veleiro vermelho" 16:9 saida.png
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLocais } from "./locais.mjs";

let config = {};
try { config = JSON.parse(readFileSync(join(process.env.ELIZIUM_PONTE_DIR ?? join(homedir(), ".elizium-ponte"), "config.json"), "utf8")); } catch {}
const locais = createLocais({ config, log: (m) => console.log(`[ponte] ${m}`) });

/** Faz o papel do servidor HTTP da ponte: entrega o pedido ao mesmo roteador e devolve o que ele respondeu. */
function call(method, path, body) {
  return new Promise((ok) => {
    const url = new URL(`http://ponte/ponte/locais${path}`);
    const req = { method, on() {} };
    const res = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(data) { ok({ status: this.status, headers: this.headers, data }); },
    };
    const json = (_res, status, obj) => ok({ status, json: obj });
    locais.handle(req, res, url, Buffer.from(body ? JSON.stringify(body) : ""), json).catch((e) => ok({ status: 500, json: { erro: e.message } }));
  });
}
const show = (r) => console.log(r.status, JSON.stringify(r.json, null, 2));
const [action, server, what, ...rest] = process.argv.slice(2);
const target = server === "comfyui" || /^https:/.test(what ?? "") ? { servidor: server, endereco: what } : { servidor: server, modelo: what };

if (action === "lista") show(await call("GET", ""));
else if (action === "consultar") show(await call("POST", "/consultar", target));
else if (action === "remover") show(await call("POST", "/remover", { servidor: server, modelo: what }));
else if (action === "baixar") {
  const started = await call("POST", "/baixar", target);
  show(started);
  const id = started.json?.id;
  if (id) {
    process.on("SIGINT", async () => { show(await call("DELETE", `/baixar/${id}`)); });
    let next = 0;
    while (true) {
      const r = await call("GET", `/baixar/${id}?depois=${next}&espera=20`);
      if (r.status !== 200) { show(r); break; }
      const d = r.json;
      next = d.proximo;
      console.log(`${d.estado} ${d.baixado}/${d.total}${d.erro ? ` — ${d.erro}` : ""}`);
      if (d.fim) break;
    }
    show(await call("GET", "/baixar"));
  }
} else if (action === "imagem") {
  const [texto, proporcao, out = "teste-imagem.png"] = rest;
  const began = Date.now();
  const started = await call("POST", "/imagem", { servidor: server, modelo: what, texto, proporcao });
  show(started);
  const id = started.json?.id;
  if (id) {
    let next = 0;
    while (true) {
      const r = await call("GET", `/imagem/${id}?depois=${next}&espera=20`);
      if (r.status !== 200) { show(r); break; }
      const j = r.json;
      next = j.proximo;
      console.log(`${j.estado} ${j.passo}/${j.passos} ${j.largura}x${j.altura} semente ${j.semente}${j.erro ? ` — ${j.erro}` : ""}`);
      if (!j.fim) continue;
      if (j.imagem) {
        const file = await call("GET", `/imagem/${id}/arquivo`);
        writeFileSync(out, file.data);
        console.log(`${file.status} ${file.headers?.["content-type"]} ${file.data?.length} bytes em ${out}, ${((Date.now() - began) / 1000).toFixed(1)} s`);
      }
      break;
    }
  }
} else {
  console.log("Uso: node teste-locais.mjs lista | consultar | baixar | remover | imagem   (veja o começo deste arquivo)");
}
process.exit(0);
