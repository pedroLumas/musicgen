// Cifra una carpeta para publicarla en un repositorio público.
//   node cifrar.mjs <carpeta en claro> <salida> <clave> <sal en base64>
//
// Cada fichero va a <salida>/d/<nombre>.bin como iv(12) + cifrado + etiqueta (AES-256-GCM).
// El nombre y el iv salen de un HMAC de la ruta y del contenido: un fichero que no
// cambia da los mismos bytes, así git solo sube lo nuevo. El índice ruta -> nombre
// va también cifrado en <salida>/m.bin. La clave sale de PBKDF2 (600 000 vueltas):
// los 32 primeros bytes cifran (lo mismo deriva el navegador), los 32 últimos firman nombres.
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [entrada, salida, clave, salB64] = process.argv.slice(2);
if (!salB64) { console.error("uso: node cifrar.mjs <entrada> <salida> <clave> <sal>"); process.exit(1); }
export const VUELTAS = 600000;

// la clave no distingue mayúsculas, tildes ni espacios (igual que la pantalla de entrada)
const normalizar = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, "");
const material = pbkdf2Sync(normalizar(clave), Buffer.from(salB64, "base64"), VUELTAS, 64, "sha256");
const kAes = material.subarray(0, 32);
const kMac = material.subarray(32);

function cifrar(datos, iv) {
  const c = createCipheriv("aes-256-gcm", kAes, iv);
  return Buffer.concat([iv, c.update(datos), c.final(), c.getAuthTag()]);
}

function todos(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...todos(p)); else out.push(p);
  }
  return out;
}

mkdirSync(join(salida, "d"), { recursive: true });
const mapa = {};
let nuevos = 0, bytes = 0;
for (const f of todos(entrada)) {
  const ruta = relative(entrada, f).split(sep).join("/");
  const datos = readFileSync(f);
  const huella = createHash("sha256").update(datos).digest();
  const nombre = createHmac("sha256", kMac).update("n\0" + ruta + "\0").update(huella).digest("hex").slice(0, 32);
  mapa[ruta] = nombre;
  const destino = join(salida, "d", nombre + ".bin");
  if (existsSync(destino)) continue;                 // mismo contenido: ya está
  const iv = createHmac("sha256", kMac).update("iv\0" + ruta + "\0").update(huella).digest().subarray(0, 12);
  writeFileSync(destino, cifrar(datos, iv));
  nuevos++; bytes += datos.length;
}

// lo que ya no está en el índice sobra
const usados = new Set(Object.values(mapa).map((n) => n + ".bin"));
let quitados = 0;
for (const n of readdirSync(join(salida, "d"))) {
  if (!usados.has(n)) { rmSync(join(salida, "d", n)); quitados++; }
}

const indice = Buffer.from(JSON.stringify({ v: 1, f: mapa }));
const ivIndice = createHmac("sha256", kMac).update("m\0").update(createHash("sha256").update(indice).digest()).digest().subarray(0, 12);
writeFileSync(join(salida, "m.bin"), cifrar(indice, ivIndice));
writeFileSync(join(salida, "s.json"), JSON.stringify({ sal: salB64, vueltas: VUELTAS }) + "\n");
console.log(`${Object.keys(mapa).length} ficheros · ${nuevos} nuevos (${(bytes / 1048576).toFixed(1)} MB) · ${quitados} quitados`);
