// Conexão da ponte com o Transmissor Elízium, com cifragem de ponta a ponta.
//
// Identidade: cada computador tem um par de chaves X25519 fixo (~/.elizium-ponte/identidade.json).
// Cada iPhone também. Aperto de mão em duas etapas (no estilo do Noise IK), para que o transmissor
// não veja nem qual iPhone está conectando:
//   1. iPhone → {ola, v:2, e: temp iPhone}            computador → {bemvindo, e: temp computador}
//      k1 = HKDF(DH(computador fixa, temp iPhone) ‖ DH(temp computador, temp iPhone), sal, "elizium-v2-hs")
//   2. iPhone → cifrado com k1: {auth, s: chave fixa do iPhone, codigo?, nome}
//      kf = HKDF(k1 ‖ DH(computador fixa, iPhone fixa) ‖ DH(temp computador, iPhone fixa), sal, "elizium-v2")
//      Só quem tem a chave privada fixa do iPhone chega a kf; tudo o mais vai cifrado com kf.
//   sal = SHA256(temp iPhone ‖ temp computador). Cada chave tem 64 bytes: 32 iPhone → computador, 32 de volta.
//   ChaCha20-Poly1305, nonce = 4 zeros + contador de 64 bits little-endian, recomeça em kf.
//
// Pareamento: o computador mostra um código de uso único; na primeira conexão o iPhone manda esse código
// já cifrado, e a chave fixa dele passa a ser reconhecida (~/.elizium-ponte/celulares.json).

import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
         generateKeyPairSync, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

function rawPublic(key) { return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32); }
function publicFromRaw(raw) { return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" }); }
function dh(privateKey, rawPeer) { return diffieHellman({ privateKey, publicKey: publicFromRaw(rawPeer) }); }

export function loadIdentity(dir) {
  const file = join(dir, "identidade.json");
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const privateKey = createPrivateKey({ key: Buffer.from(j.privada, "base64"), format: "der", type: "pkcs8" });
    return { id: j.computadorId, token: j.token, privateKey, publicRaw: fromB64u(j.publica) };
  }
  const { privateKey } = generateKeyPairSync("x25519");
  const publicRaw = rawPublic(privateKey);
  const id = b64u(createHash("sha256").update(publicRaw).digest()).slice(0, 22);
  const token = b64u(randomBytes(32));
  writeFileSync(file, JSON.stringify({
    computadorId: id, token, publica: b64u(publicRaw),
    privada: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  }, null, 2), { mode: 0o600 });
  return { id, token, privateKey, publicRaw };
}

/** One-time pairing code, 8 letters/digits without look-alikes. */
export function newPairingCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function nonce(counter) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64LE(BigInt(counter), 4);
  return n;
}

class SecureChannel {
  constructor(sendKey, recvKey) { this.sendKey = sendKey; this.recvKey = recvKey; this.sendN = 0; this.recvN = 0; }
  seal(obj) {
    const c = createCipheriv("chacha20-poly1305", this.sendKey, nonce(this.sendN++), { authTagLength: 16 });
    const body = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj))), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
  }
  open(buf) {
    const d = createDecipheriv("chacha20-poly1305", this.recvKey, nonce(this.recvN++), { authTagLength: 16 });
    d.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
    return JSON.parse(plain.toString("utf8"));
  }
}

/**
 * Keeps a WebSocket to the relay and serves each phone channel.
 * handle(req) → { status, headers, body: Buffer } runs a request against the local bridge.
 */
export function startRelay({ relayURL, identity, phonesFile, pairing, name, info, handle, log }) {
  let phones = existsSync(phonesFile) ? JSON.parse(readFileSync(phonesFile, "utf8")) : [];
  const savePhones = () => writeFileSync(phonesFile, JSON.stringify(phones, null, 2), { mode: 0o600 });
  const channels = new Map();   // canal → { state, secure, phone }
  let ws;
  let backoff = 1000;

  const send = (c, data, binary) => ws?.readyState === 1 &&
    ws.send(JSON.stringify({ c, d: Buffer.from(data).toString("base64"), b: binary }));
  const sendSecure = (c, ch, obj) => send(c, ch.secure.seal(obj), true);

  async function onFrame(c, frame, binary) {
    const ch = channels.get(c) ?? { state: "novo" };
    channels.set(c, ch);
    try {
      if (ch.state === "novo") {
        const hello = JSON.parse(frame.toString("utf8"));
        if (hello.t !== "ola" || hello.v !== 2) throw new Error("saudação inválida (atualize o app)");
        const phoneEph = fromB64u(hello.e);
        if (phoneEph.length !== 32) throw new Error("chave inválida");
        const { privateKey: ephPriv } = generateKeyPairSync("x25519");
        const ephRaw = rawPublic(ephPriv);
        const salt = createHash("sha256").update(Buffer.concat([phoneEph, ephRaw])).digest();
        const k1 = Buffer.from(hkdfSync("sha256", Buffer.concat([dh(identity.privateKey, phoneEph), dh(ephPriv, phoneEph)]),
                                        salt, Buffer.from("elizium-v2-hs"), 64));
        ch.hs = { k1, salt, ephPriv, secure: new SecureChannel(k1.subarray(32, 64), k1.subarray(0, 32)) };
        ch.state = "aguardando";
        send(c, Buffer.from(JSON.stringify({ t: "bemvindo", e: b64u(ephRaw) })), false);
        return;
      }
      if (!binary) throw new Error("quadro sem cifra");
      if (ch.state === "aguardando") {
        const msg = ch.hs.secure.open(frame);
        if (msg.t !== "auth") throw new Error("esperava auth");
        const phoneStatic = fromB64u(String(msg.s ?? ""));
        if (phoneStatic.length !== 32) throw new Error("chave do iPhone inválida");
        const kf = Buffer.from(hkdfSync("sha256",
          Buffer.concat([ch.hs.k1, dh(identity.privateKey, phoneStatic), dh(ch.hs.ephPriv, phoneStatic)]),
          ch.hs.salt, Buffer.from("elizium-v2"), 64));
        ch.secure = new SecureChannel(kf.subarray(32, 64), kf.subarray(0, 32));
        ch.phone = b64u(phoneStatic);
        delete ch.hs;
        let known = phones.find((p) => p.chave === ch.phone);
        if (!known && msg.codigo && pairing.valid(msg.codigo)) {
          known = { chave: ch.phone, nome: String(msg.nome ?? "iPhone").slice(0, 60), desde: new Date().toISOString() };
          phones.push(known);
          savePhones();
          pairing.used();
          log(`Novo iPhone pareado: ${known.nome}.`);
        }
        if (!known) {
          sendSecure(c, ch, { t: "recusado", motivo: msg.codigo ? "Código de pareamento inválido ou vencido." : "Este iPhone não está pareado com este computador." });
          ws.send(JSON.stringify({ c, t: "fechar" }));
          channels.delete(c);
          return;
        }
        ch.state = "ok";
        sendSecure(c, ch, { t: "ok", computador: name, ...info() });
        return;
      }
      const msg = ch.secure.open(frame);
      if (msg.t === "req") {
        const res = await handle(msg);
        const body = res.body ?? Buffer.alloc(0);
        const size = 384 * 1024;
        const total = Math.max(1, Math.ceil(body.length / size));
        for (let k = 0; k < total; k++) {
          if (!channels.has(c)) return;
          sendSecure(c, ch, { t: "res", i: msg.i, s: res.status, h: res.headers, k, n: total,
                              b: body.subarray(k * size, (k + 1) * size).toString("base64") });
        }
      }
    } catch (e) {
      log(`Canal descartado: ${e.message}`);
      ws?.readyState === 1 && ws.send(JSON.stringify({ c, t: "fechar" }));
      channels.delete(c);
    }
  }

  function connect() {
    const url = `${relayURL.replace(/^http/, "ws").replace(/\/$/, "")}/v1/computador/${identity.id}?token=${identity.token}`;
    ws = new WebSocket(url);
    let pinger;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      backoff = 1000;
      log("Conectado ao transmissor.");
      pinger = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "ping" })), 30000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.t === "abriu") { channels.set(m.c, { state: "novo" }); return; }
      if (m.t === "fechou") { channels.delete(m.c); return; }
      if (m.c && typeof m.d === "string") onFrame(m.c, Buffer.from(m.d, "base64"), !!m.b);
    };
    ws.onclose = (ev) => {
      clearInterval(pinger);
      channels.clear();
      if (ev.code === 1008 || ev.reason?.includes("dono")) { log("O transmissor recusou este computador."); }
      log(`Transmissor desconectado; tentando de novo em ${Math.round(backoff / 1000)} s.`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 60000);
    };
    ws.onerror = () => {};
  }
  connect();
  return { phones: () => phones };
}
