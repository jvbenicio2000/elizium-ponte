// Transmissor Elízium: liga o app do iPhone à ponte de cada computador, por WebSocket.
//
// Ele só repassa pacotes. O conteúdo vai cifrado de ponta a ponta (X25519 + ChaCha20-Poly1305)
// entre o iPhone e a ponte, então o transmissor não consegue ler nada do que passa.
//
//   ponte   ──WS──> /v1/computador/<id>?token=…  ┐
//                                                ├─ um Durable Object por computador
//   iPhone  ──WS──> /v1/app/<id>                 ┘
//
// Para a ponte, cada conexão de app vira um canal numerado:
//   transmissor → ponte: {"c":"<canal>","t":"abriu"} | {"c":…,"t":"fechou"} | {"c":…,"d":"<base64>","b":true|false}
//   ponte → transmissor: {"c":…,"d":"<base64>","b":true|false} | {"c":…,"t":"fechar"}
// Para o app, o que a ponte manda no canal chega como quadro de texto (b=false) ou binário (b=true).

const COMPUTER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // v1, computador|app, id
    if (parts.length === 0) {
      return new Response("Transmissor Elízium: funcionando.\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (parts.length !== 3 || parts[0] !== "v1" || !["computador", "app"].includes(parts[1]) || !COMPUTER_ID.test(parts[2])) {
      return new Response("Caminho inválido.\n", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Use WebSocket.\n", { status: 426 });
    }
    const stub = env.COMPUTADORES.get(env.COMPUTADORES.idFromName(parts[2]));
    return stub.fetch(request);
  },
};

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Computador {
  constructor(state) {
    this.state = state;
  }

  device() {
    return this.state.getWebSockets("computador")[0];
  }

  app(channel) {
    return this.state.getWebSockets(`app:${channel}`)[0];
  }

  async fetch(request) {
    const url = new URL(request.url);
    const kind = url.pathname.split("/")[2];
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (kind === "computador") {
      // The first token seen owns this computer id (trust on first use); later ones must match.
      const token = url.searchParams.get("token") ?? "";
      if (token.length < 32) return new Response("Token curto.", { status: 400 });
      const hash = await sha256(token);
      const saved = await this.state.storage.get("token");
      if (saved && saved !== hash) return new Response("Este computador já tem dono.", { status: 403 });
      if (!saved) await this.state.storage.put("token", hash);
      for (const old of this.state.getWebSockets("computador")) old.close(4000, "Outra ponte conectou com este id.");
      this.state.acceptWebSocket(server, ["computador"]);
      // Apps already waiting get a fresh channel announcement.
      for (const ws of this.state.getWebSockets()) {
        const tag = this.state.getTags(ws).find((t) => t.startsWith("app:"));
        if (tag) server.send(JSON.stringify({ c: tag.slice(4), t: "abriu" }));
      }
    } else {
      const channel = crypto.randomUUID();
      this.state.acceptWebSocket(server, ["app", `app:${channel}`]);
      const dev = this.device();
      if (dev) dev.send(JSON.stringify({ c: channel, t: "abriu" }));
      else server.close(4404, "O computador está desligado ou a ponte não está ligada.");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const tags = this.state.getTags(ws);
    if (tags.includes("computador")) {
      let m;
      try { m = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)); } catch { return; }
      if (m.t === "ping") { ws.send(JSON.stringify({ t: "pong" })); return; }
      const app = m.c && this.app(m.c);
      if (!app) return;
      if (m.t === "fechar") { app.close(4001, "A ponte encerrou esta conexão."); return; }
      if (typeof m.d === "string") app.send(m.b ? fromBase64(m.d) : new TextDecoder().decode(fromBase64(m.d)));
      return;
    }
    const tag = tags.find((t) => t.startsWith("app:"));
    const dev = this.device();
    if (!tag) return;
    if (!dev) { ws.close(4404, "O computador está desligado ou a ponte não está ligada."); return; }
    dev.send(JSON.stringify({ c: tag.slice(4), d: toBase64(message), b: typeof message !== "string" }));
  }

  async webSocketClose(ws) {
    const tags = this.state.getTags(ws);
    if (tags.includes("computador")) {
      for (const app of this.state.getWebSockets("app")) app.close(4404, "A ponte desconectou.");
      return;
    }
    const tag = tags.find((t) => t.startsWith("app:"));
    const dev = this.device();
    if (tag && dev) dev.send(JSON.stringify({ c: tag.slice(4), t: "fechou" }));
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
}
