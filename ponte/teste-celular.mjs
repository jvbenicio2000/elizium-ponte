// Teste: faz o papel do iPhone. Conecta ao transmissor, faz a troca de chaves, pareia com o código
// e manda pedidos à ponte, tudo cifrado. Uso: node teste-celular.mjs "<link elizium://parear?...>" [caminho]
import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman,
         generateKeyPairSync, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const raw = (k) => createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32);
const pub = (r) => createPublicKey({ key: Buffer.concat([SPKI, r]), format: "der", type: "spki" });
const dh = (priv, r) => diffieHellman({ privateKey: priv, publicKey: pub(r) });
const nonce = (n) => { const b = Buffer.alloc(12); b.writeBigUInt64LE(BigInt(n), 4); return b; };

const link = new URL(process.argv[2]);
const q = Object.fromEntries(link.searchParams);
const path = process.argv[3] ?? "/ponte/info";

// Fixed phone identity for the test, so a second run proves "paired forever".
const idFile = "/tmp/elizium-celular-teste.json";
let phone;
if (existsSync(idFile)) {
  const { privateKey } = JSON.parse(readFileSync(idFile, "utf8"));
  const { createPrivateKey } = await import("node:crypto");
  phone = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
} else {
  phone = generateKeyPairSync("x25519").privateKey;
  writeFileSync(idFile, JSON.stringify({ privateKey: phone.export({ format: "der", type: "pkcs8" }).toString("base64") }));
}
const eph = generateKeyPairSync("x25519").privateKey;
const devStatic = Buffer.from(q.p, "base64url");

const ws = new WebSocket(`${q.r.replace(/^http/, "ws")}/v1/app/${q.d}`);
ws.binaryType = "arraybuffer";
let send, recv, sendN = 0, recvN = 0, state = "ola";
const seal = (o) => { const c = createCipheriv("chacha20-poly1305", send, nonce(sendN++), { authTagLength: 16 });
  const b = Buffer.concat([c.update(Buffer.from(JSON.stringify(o))), c.final()]); return Buffer.concat([b, c.getAuthTag()]); };
const open = (buf) => { const d = createDecipheriv("chacha20-poly1305", recv, nonce(recvN++), { authTagLength: 16 });
  d.setAuthTag(buf.subarray(buf.length - 16)); return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString()); };

ws.onopen = () => ws.send(JSON.stringify({ t: "ola", v: 2, e: raw(eph).toString("base64url") }));
ws.onclose = (e) => { console.log("fechou:", e.code, e.reason); process.exit(state === "fim" ? 0 : 1); };
let body = [];
ws.onmessage = (ev) => {
  if (typeof ev.data === "string") {
    const m = JSON.parse(ev.data);
    const devEph = Buffer.from(m.e, "base64url");
    const salt = createHash("sha256").update(Buffer.concat([raw(eph), devEph])).digest();
    const k1 = Buffer.from(hkdfSync("sha256", Buffer.concat([dh(eph, devStatic), dh(eph, devEph)]), salt, Buffer.from("elizium-v2-hs"), 64));
    send = k1.subarray(0, 32); recv = k1.subarray(32, 64);
    // FINGIR=1: announce the paired phone's public key while holding a different private key (an impostor).
    const impostor = process.env.FINGIR ? generateKeyPairSync("x25519").privateKey : phone;
    ws.send(seal({ t: "auth", s: raw(phone).toString("base64url"), codigo: q.c, nome: "iPhone de teste" }));
    const kf = Buffer.from(hkdfSync("sha256", Buffer.concat([k1, dh(impostor, devStatic), dh(impostor, devEph)]), salt, Buffer.from("elizium-v2"), 64));
    send = kf.subarray(0, 32); recv = kf.subarray(32, 64); sendN = 0; recvN = 0;
    return;
  }
  let m;
  try { m = open(Buffer.from(ev.data)); } catch { console.log("não consegui decifrar a resposta (chave errada)"); ws.send(seal({ t: "req", i: 1, m: "GET", p: path })); return; }
  if (m.t === "ok") { console.log("pareado com", m.computador, "ponte", m.ponte); ws.send(seal({ t: "req", i: 1, m: "GET", p: path })); return; }
  if (m.t === "recusado") { console.log("recusado:", m.motivo); process.exit(0); }
  if (m.t === "res") {
    body.push(Buffer.from(m.b, "base64"));
    if (m.k === m.n - 1) {
      console.log("resposta", m.s, Buffer.concat(body).toString().slice(0, 300));
      process.exit(0);
    }
  }
};
setTimeout(() => { console.log("sem resposta em 20 s"); process.exit(1); }, 20000);
