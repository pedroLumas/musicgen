/* Music cifrada — service worker.
   Todo lo que la app pide bajo app/ (su HTML, sus scripts, pistas.json, cada mp3 y
   cada portada) se busca en el índice cifrado, se baja de d/<nombre>.bin y se
   descifra aquí, con la clave que guardó la pantalla de entrada. La app no sabe
   nada de esto: ve ficheros normales. Lo cifrado se guarda en caché, así lo ya
   oído suena también sin conexión. Los mp3 responden a Range (saltar en la pista). */

const CACHE = "music-cifrado-v1";
let clave = null;
let mapa = null;
let ultimo = { nombre: null, datos: null };      // el último fichero grande descifrado (la canción que suena)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ---- la clave vive en IndexedDB (la deja ahí index.html)
function bd() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("music", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("k");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function leerClave() {
  if (clave) return clave;
  const db = await bd();
  clave = await new Promise((res) => {
    const g = db.transaction("k").objectStore("k").get("clave");
    g.onsuccess = () => res(g.result || null);
    g.onerror = () => res(null);
  });
  return clave;
}

async function descifrar(buf) {
  const k = await leerClave();
  if (!k) throw new Error("sin clave");
  const iv = new Uint8Array(buf, 0, 12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, new Uint8Array(buf, 12));
}

async function leerMapa(fresco) {
  if (mapa && !fresco) return mapa;
  let r;
  try { r = await fetch("m.bin", { cache: "no-store" }); } catch (_) { r = null; }
  const cache = await caches.open(CACHE);
  if (r && r.ok) await cache.put("m.bin", r.clone());
  else r = await cache.match("m.bin");               // sin conexión: el último índice conocido
  if (!r) throw new Error("sin índice");
  mapa = JSON.parse(new TextDecoder().decode(await descifrar(await r.arrayBuffer()))).f;
  return mapa;
}

async function cifrado(nombre) {
  const url = "d/" + nombre + ".bin";
  const cache = await caches.open(CACHE);
  let r = await cache.match(url);
  if (!r) {
    r = await fetch(url);
    if (!r.ok) throw new Error("no está " + url);
    cache.put(url, r.clone()).catch(() => {});        // sin sitio: se sigue sin guardar
  }
  return r.arrayBuffer();
}

const TIPOS = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", webmanifest: "application/manifest+json", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", mp3: "audio/mpeg", ico: "image/x-icon", svg: "image/svg+xml",
};

async function servir(ruta, peticion) {
  let m;
  try { m = await leerMapa(ruta === "index.html"); } catch (_) {
    // sin clave (o clave vieja): a la pantalla de entrada
    return Response.redirect(new URL("./", self.registration.scope).href, 302);
  }
  const nombre = m[ruta];
  if (!nombre) return new Response("", { status: 404 });
  let datos;
  if (ultimo.nombre === nombre) datos = ultimo.datos;
  else {
    datos = await descifrar(await cifrado(nombre));
    if (datos.byteLength > 512 * 1024) ultimo = { nombre, datos };
  }
  const tipo = TIPOS[ruta.split(".").pop().toLowerCase()] || "application/octet-stream";
  const total = datos.byteLength;
  const rango = peticion.headers.get("range");
  const m2 = rango && /bytes=(\d*)-(\d*)/.exec(rango);
  if (m2) {
    let ini = m2[1] === "" ? Math.max(0, total - Number(m2[2])) : Number(m2[1]);
    let fin = m2[1] === "" || m2[2] === "" ? total - 1 : Math.min(Number(m2[2]), total - 1);
    if (ini >= total) return new Response("", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    return new Response(datos.slice(ini, fin + 1), {
      status: 206,
      headers: { "Content-Type": tipo, "Content-Length": String(fin - ini + 1), "Content-Range": `bytes ${ini}-${fin}/${total}`, "Accept-Ranges": "bytes" },
    });
  }
  return new Response(datos, { headers: { "Content-Type": tipo, "Content-Length": String(total), "Accept-Ranges": "bytes" } });
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== "GET") return;
  const base = new URL("app/", self.registration.scope).pathname;
  if (!url.pathname.startsWith(base)) return;
  let ruta = decodeURIComponent(url.pathname.slice(base.length));
  if (!ruta || ruta.endsWith("/")) ruta += "index.html";
  e.respondWith(servir(ruta, e.request).catch(() => new Response("", { status: 503 })));
});

// index.html avisa cuando cambia la clave (nueva contraseña)
self.addEventListener("message", (e) => {
  if (e.data === "olvidar") { clave = null; mapa = null; ultimo = { nombre: null, datos: null }; }
});
