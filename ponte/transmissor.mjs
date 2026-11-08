// Conexão da ponte com o Transmissor Elízium, com cifragem de ponta a ponta.
//
// Identidade: cada computador tem um par de chaves X25519 fixo (~/.elizium-ponte/identidade.json).
// Cada iPhone também. A cada conexão os dois combinam uma chave nova:
//   ss1 = DH(computador fixa, iPhone temporária)
//   ss2 = DH(computador fixa, iPhone fixa)
//   ss3 = DH(computador temporária, iPhone temporária)
//   chaves = HKDF-SHA256(ss1‖ss2‖ss3, sal = SHA256(temp iPhone ‖ temp computador), "elizium-v1", 64 bytes)
// Os primeiros 32 bytes cifram iPhone → computador, os outros 32, computador → iPhone (ChaCha20-Poly1305,
// nonce = 4 zeros + contador de 64 bits little-endian, sem repetir). O transmissor só vê bytes cifrados.
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
        if (hello.t !== "ola" || hello.v !== 1) throw new Error("saudação inválida");
        const phoneStatic = fromB64u(hello.s), phoneEph = fromB64u(hello.e);
        if (phoneStatic.length !== 32 || phoneEph.length !== 32) throw new Error("chave inválida");
        const { privateKey: ephPriv } = generateKeyPairSync("x25519");
        const ephRaw = rawPublic(ephPriv);
        const ikm = Buffer.concat([dh(identity.privateKey, phoneEph), dh(identity.privateKey, phoneStatic), dh(ephPriv, phoneEph)]);
        const salt = createHash("sha256").update(Buffer.concat([phoneEph, ephRaw])).digest();
        const okm = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("elizium-v1"), 64));
        ch.secure = new SecureChannel(okm.subarray(32, 64), okm.subarray(0, 32));
        ch.phone = b64u(phoneStatic);
        ch.state = "aguardando";
        send(c, Buffer.from(JSON.stringify({ t: "bemvindo", e: b64u(ephRaw) })), false);
        return;
      }
      if (!binary) throw new Error("quadro sem cifra");
      const msg = ch.secure.open(frame);
      if (ch.state === "aguardando") {
        if (msg.t !== "auth") throw new Error("esperava auth");
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
