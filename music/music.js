/* Music — reproductor. Sin dependencias.
   La lista sale de /pistas.json (la arma el servidor al pedirlo; sin servidor
   vale un pistas.json fijo al lado). Lo que solo puede hacer el servidor
   (borrar, editar, descargar) se enciende si responde /api/estado.
   Todo va por id de canción, nunca por índice: la lista cambia por debajo
   (borrar, descargar) sin que se pierda lo que suena ni la cola.
   Los textos salen de textos.js (español e inglés) con t("clave"). */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const audio = $("audio");
  const muestra = $("muestra");

  // ------------------------------------------------------------ almacén
  const almacen = {
    leer(k, def) {
      try { const v = JSON.parse(localStorage.getItem("music." + k)); return v ?? def; } catch (_) { return def; }
    },
    poner(k, v) {
      try { localStorage.setItem("music." + k, JSON.stringify(v)); } catch (_) { /* sin almacenamiento también funciona */ }
    },
  };
  // "estado" lo lee también index.html (tema y animaciones, antes de pintar)
  const estado = almacen.leer("estado", {});
  const guardarEstado = (cambios = {}) => { Object.assign(estado, cambios); almacen.poner("estado", estado); };

  const favoritas = new Set(almacen.leer("fav", []));
  const escuchas = almacen.leer("escuchas", {});          // id -> { n: veces, u: última, s: segundos }
  const diario = almacen.leer("diario", {});              // "AAAA-MM-DD" -> segundos escuchados ese día
  const perfil = almacen.leer("perfil", { nombre: "", foto: "" });
  const letras = almacen.leer("letras", {});              // id -> { s: sincronizada, p: normal, i: instrumental, f: fecha }
  let misListas = almacen.leer("listas", []);             // [{ id, nombre, ids, creada }]
  let rec = almacen.leer("rec", { fecha: 0, grupos: [] });
  let descartadas = new Set(almacen.leer("descartadas", []));
  const artistasDz = almacen.leer("artistasdz", {});      // nombre normalizado -> { id, m, b } | null

  // ------------------------------------------------------------ idioma
  const TEXTOS = window.MUSIC_TEXTOS || { es: {} };
  let idioma = "es";
  function t(k, ...a) {
    const v = TEXTOS[idioma]?.[k] ?? TEXTOS.es?.[k] ?? k;
    if (typeof v === "function") return v(...a);
    return a.length ? v.replace(/\{(\d)\}/g, (_, i) => a[i]) : v;
  }
  const local = () => (idioma === "es" ? "es-ES" : "en-US");
  function elegirIdioma() {
    const pref = estado.idioma || "auto";
    idioma = pref === "auto" ? ((navigator.language || "es").toLowerCase().startsWith("es") ? "es" : "en") : pref;
    if (!TEXTOS[idioma]) idioma = "es";
    document.documentElement.lang = idioma;
  }
  function traducirPagina() {
    document.querySelectorAll("[data-t]").forEach((e) => { e.textContent = t(e.dataset.t); });
    document.querySelectorAll("[data-t-ph]").forEach((e) => { e.placeholder = t(e.dataset.tPh); });
    document.querySelectorAll("[data-t-aria]").forEach((e) => { e.setAttribute("aria-label", t(e.dataset.tAria)); });
    document.querySelector('[data-t="vacioTexto"]').innerHTML = t(servidor ? "vacioTexto" : "vacioTextoWeb");
  }
  // nombres de contexto ("Tu música", "Favoritas"...) se guardan como clave y se traducen al pintar
  const nombreDe = (n) => (n && typeof n === "object" ? t(n.k) : n || t("tuMusica"));

  // ------------------------------------------------------------ estado
  let pistas = [];
  let porId = new Map();
  let servidor = false;

  let actual = null;                // id de lo que suena
  let contexto = { nombre: { k: "tuMusica" }, ids: [] };
  let orden = [];                   // ids en el orden en que van a sonar (barajado si aleatorio)
  let pos = -1;
  let colaUsuario = [];             // lo que el usuario pone "a continuación": va antes que el resto
  let historial = [];
  let mezcla = false;
  let repite = "no";                // no | todo | uno
  let contada = false;              // esta escucha ya cuenta para "lo que más escuchas"

  let pestana = "musica";
  let consulta = "";
  let pedidos = [];
  let descargando = false;
  let alCerrar = true;
  let calidad = "normal";
  let generando = false;

  // ------------------------------------------------------------ utilidades
  const mm = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const duracionLarga = (s) => {
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? t("horasMin", h, m) : t("minutos", m);
  };
  const hace = (ms) => {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return t("ahoraMismo");
    if (s < 3600) return t("haceMin", Math.floor(s / 60));
    if (s < 86400) return t("haceHoras", Math.floor(s / 3600));
    const d = Math.floor(s / 86400);
    return d === 1 ? t("ayer") : t("haceDias", d);
  };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // "Canción (feat. X) - Remastered 2011" -> "Canción"
  const limpiarTitulo = (s) => String(s || "").replace(/\s*[([].*?[)\]]/g, "").replace(/\s[-–—]\s.*$/, "").trim();
  const normTitulo = (s) => norm(limpiarTitulo(s));
  const artistaPrincipal = (a) => String(a || "").split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\by\b)\s*/i)[0].trim();
  const barajar = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const icono = (id, clase = "") => `<svg${clase ? ` class="${clase}"` : ""}><use href="#${id}"/></svg>`;
  const nodo = (tag, clase, texto) => {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto != null) e.textContent = texto;
    return e;
  };
  const dosCifras = (n) => String(n).padStart(2, "0");
  const diaDe = (d) => `${d.getFullYear()}-${dosCifras(d.getMonth() + 1)}-${dosCifras(d.getDate())}`;
  const movimientoReducido = () => estado.animaciones === "reducidas" || matchMedia("(prefers-reduced-motion: reduce)").matches;

  // el tono de cada canción sale de su id: siempre el mismo, sin guardar nada
  const tono = (id) => {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  };

  const urlAudio = (p) => "pistas/" + encodeURIComponent(p.audio);
  const urlPortada = (p) => (p.portada ? "pistas/" + encodeURIComponent(p.portada) + (p.pv ? "?v=" + p.pv : "") : null);

  // una portada: degradado con el tono de la canción y la imagen encima cuando carga
  function portada(semilla, url, clase = "") {
    const s = nodo("span", ("portada " + clase).trim());
    ponerImagen(s, semilla, url);
    return s;
  }
  function ponerImagen(s, semilla, url) {
    s.style.setProperty("--h", tono(semilla || "x"));
    s.querySelectorAll("img").forEach((i) => i.remove());
    s.classList.toggle("con-nota", !url);
    if (!url) return;
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.loading = "lazy";
    img.onload = () => img.classList.add("cargada");
    img.onerror = () => { img.remove(); s.classList.add("con-nota"); };
    img.src = url;
    s.prepend(img);
  }
  const portadaPista = (p, clase) => portada(p.id, urlPortada(p), clase);

  // ------------------------------------------------------------ hápticos
  // Android tiene vibrate(). iOS no, pero un interruptor nativo (Safari 17.4+)
  // da un toque del motor háptico al cambiar: se crea uno invisible y se pulsa.
  const esIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const PATRONES = { suave: 5, toque: 8, medio: 12, fuerte: 18, exito: [10, 60, 16], error: [24, 50, 24] };
  function haptica(tipo = "toque") {
    if (estado.vibracion === false) return;
    const p = PATRONES[tipo] ?? tipo;
    if (navigator.vibrate) { try { navigator.vibrate(p); } catch (_) {} return; }
    if (!esIOS) return;
    try {
      const l = document.createElement("label");
      l.setAttribute("aria-hidden", "true");
      l.style.display = "none";
      const i = document.createElement("input");
      i.type = "checkbox";
      i.setAttribute("switch", "");
      l.append(i);
      document.head.append(l);
      l.click();
      l.remove();
    } catch (_) {}
  }

  // ------------------------------------------------------------ aviso
  let temporizadorAviso = 0;
  function aviso(texto, accion, etiqueta) {
    clearTimeout(temporizadorAviso);
    const caja = $("aviso");
    $("aviso-texto").textContent = texto;
    const btn = $("aviso-accion");
    btn.hidden = !accion;
    btn.textContent = etiqueta || t("deshacer");
    btn.onclick = accion ? () => { clearTimeout(temporizadorAviso); caja.hidden = true; haptica("suave"); accion(); } : null;
    caja.hidden = true;
    void caja.offsetWidth;                 // reinicia la animación de entrada
    caja.hidden = false;
    temporizadorAviso = setTimeout(() => { caja.hidden = true; }, accion ? 7000 : 3200);
  }

  // ------------------------------------------------------------ servidor
  async function post(ruta, cuerpo) {
    const r = await fetch(ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Music": "1" },
      body: JSON.stringify(cuerpo || {}),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json().catch(() => ({}));
  }

  async function cargarPistas() {
    let datos = [];
    try {
      datos = await (await fetch("pistas.json?_=" + Date.now(), { cache: "no-store" })).json();
    } catch (_) { return false; }
    pistas = (Array.isArray(datos) ? datos : []).filter((p) => p && p.id && p.audio).map((p) => ({
      ...p,
      titulo: p.titulo || p.id,
      artista: p.artista || "",
      album: p.album || "",
      lista: p.lista || "",
      orden: Number(p.orden) || 0,
    }));
    porId = new Map(pistas.map((p) => [p.id, p]));
    return true;
  }

  // ------------------------------------------------------------ capas (atrás del móvil)
  // Cada cosa que se abre encima (detalle, reproductor, hojas, selección) mete un
  // paso en el historial: el botón atrás del móvil la cierra en vez de salir.
  const capas = [];
  const esperasCierre = [];
  if (history.state && history.state.capa) history.replaceState(null, "");
  function abrirCapa(nombre, cerrar) {
    capas.push({ nombre, cerrar });
    history.pushState({ capa: capas.length }, "");
  }
  const capaAbierta = (nombre) => capas.some((c) => c.nombre === nombre);
  function cerrarCapas(hasta) {
    hasta = Math.max(0, hasta);
    const n = capas.length - hasta;
    if (n <= 0) return Promise.resolve();
    return new Promise((res) => {
      esperasCierre.push(res);
      history.go(-n);
      setTimeout(() => {                    // por si el navegador no avisa...
        const r = esperasCierre.indexOf(res);
        if (r < 0) return;                  // ...si avisó, lo abierto después ya no es cosa de este cierre
        esperasCierre.splice(r, 1);
        while (capas.length > hasta) capas.pop().cerrar();
        res();
      }, 600);
    });
  }
  const cerrarCapa = () => cerrarCapas(capas.length - 1);
  const cerrarHasta = (nombre) => cerrarCapas(capas.findIndex((c) => c.nombre === nombre));
  window.addEventListener("popstate", (e) => {
    const prof = (e.state && e.state.capa) || 0;
    while (capas.length > prof) capas.pop().cerrar();
    esperasCierre.splice(0).forEach((r) => r());
  });

  // ------------------------------------------------------------ hojas modales
  const velo = $("velo-modal");
  function abrirModal(m) {
    velo.hidden = false;
    requestAnimationFrame(() => velo.classList.add("visible"));
    m.style.zIndex = 31 + capas.length;        // una hoja abierta desde otra queda encima
    m.scrollTop = 0;
    m.classList.add("abierta");
    m.setAttribute("aria-hidden", "false");
    abrirCapa("modal:" + m.id, () => soltarModal(m));
  }
  function soltarModal(m) {
    m.classList.remove("abierta", "siguiendo");
    m.style.transform = "";
    m.setAttribute("aria-hidden", "true");
    if (document.activeElement && m.contains(document.activeElement)) document.activeElement.blur();
    if (!document.querySelector(".modal.abierta")) {
      velo.classList.remove("visible");
      setTimeout(() => { if (!document.querySelector(".modal.abierta")) velo.hidden = true; }, 350);
    }
  }
  velo.addEventListener("click", () => cerrarCapa());
  // con el dedo, solo desde la cabecera (el resto de la hoja se desplaza); con ratón, desde cualquier sitio
  document.querySelectorAll(".modal").forEach((m) => {
    arrastre(m, {
      empieza: (e) => e.pointerType === "mouse"
        ? m.scrollTop <= 0 && !e.target.closest("input, button, .lista-pedidos, .elegibles")
        : !!e.target.closest(".asa, .menu-cabeza, .modal-cabeza, .modal-titulo, .perfil-cabeza"),
      vertical: (dy) => { m.classList.add("siguiendo"); m.style.transform = `translateY(${Math.max(0, dy)}px)`; },
      suelta: (dy, vy) => {
        m.classList.remove("siguiendo");
        m.style.transform = "";
        if (dy > 110 || vy > 0.6) cerrarCapa();
      },
    });
  });

  function abrirMenu({ cabeza, acciones }) {
    const c = $("menu-cabeza");
    c.textContent = "";
    c.className = "menu-cabeza";
    if (cabeza && cabeza.pista) {
      const p = cabeza.pista;
      const tx = nodo("span", "textos");
      tx.append(nodo("b", "", p.titulo), nodo("small", "", p.artista || "—"));
      c.append(portadaPista(p), tx);
    } else if (cabeza && cabeza.titulo) {
      c.classList.add("solo-titulo");
      c.append(nodo("b", "", cabeza.titulo));
      if (cabeza.sub) c.append(nodo("small", "", cabeza.sub));
    }
    const lista = $("menu-acciones");
    lista.textContent = "";
    for (const a of acciones.filter(Boolean)) {
      const b = nodo("button", "menu-accion" + (a.peligro ? " peligro" : "") + (a.marcada ? " marcada" : ""));
      b.innerHTML = icono(a.icono);
      b.append(nodo("span", "", a.texto));
      if (a.detalle) b.append(nodo("span", "detalle", a.detalle));
      b.addEventListener("click", async () => { haptica(a.peligro ? "medio" : "toque"); await cerrarCapa(); a.accion(); });
      lista.append(b);
    }
    abrirModal($("menu"));
  }
  // pregunta con dos botones; devuelve true si se confirma
  function confirmar(titulo, sub, boton) {
    return new Promise((res) => {
      let hecho = false;
      abrirMenu({
        cabeza: { titulo, sub },
        acciones: [{ icono: "i-papelera", texto: boton, peligro: true, accion: () => { hecho = true; res(true); } }],
      });
      const capa = capas[capas.length - 1];
      const antes = capa.cerrar;
      capa.cerrar = () => { antes(); setTimeout(() => { if (!hecho) res(false); }, 0); };
    });
  }

  // ------------------------------------------------------------ gestos
  // Un arrastre que decide en los primeros píxeles si es vertical u horizontal.
  // Si no se mueve, no hace nada y el clic sigue su curso.
  function arrastre(zona, { empieza, vertical, horizontal, suelta, toque }) {
    zona.addEventListener("pointerdown", (e) => {
      if (e.button || (empieza && !empieza(e))) return;
      const x0 = e.clientX, y0 = e.clientY, t0 = performance.now();
      let modo = null, dx = 0, dy = 0;
      const mover = (ev) => {
        dx = ev.clientX - x0; dy = ev.clientY - y0;
        if (!modo) {
          if (vertical && Math.abs(dy) > 9 && Math.abs(dy) > Math.abs(dx)) modo = "v";
          else if (horizontal && Math.abs(dx) > 9 && Math.abs(dx) > Math.abs(dy)) modo = "h";
          else if (Math.abs(dx) > 9 || Math.abs(dy) > 9) return fin(null, true);
          else return;
          try { zona.setPointerCapture(ev.pointerId); } catch (_) {}
        }
        ev.preventDefault();
        if (modo === "v") vertical(dy, dx); else horizontal(dx, dy);
      };
      const fin = (ev, cancelado) => {
        zona.removeEventListener("pointermove", mover);
        zona.removeEventListener("pointerup", fin);
        zona.removeEventListener("pointercancel", cancelar);
        if (cancelado) return;
        const dt = Math.max(1, performance.now() - t0);
        if (modo) {
          zona._sinClic = true;
          setTimeout(() => { zona._sinClic = false; }, 50);
          suelta && suelta(modo === "v" ? dy : dx, (modo === "v" ? dy : dx) / dt, modo);
        } else if (toque && ev) toque(ev);
      };
      const cancelar = () => {
        if (modo && suelta) suelta(0, 0, modo);
        fin(null, true);
      };
      zona.addEventListener("pointermove", mover);
      zona.addEventListener("pointerup", fin);
      zona.addEventListener("pointercancel", cancelar);
    });
    zona.addEventListener("click", (e) => { if (zona._sinClic) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  // ------------------------------------------------------------ color de la portada
  const colores = new Map();
  function colorDe(p) {
    if (colores.has(p.id)) return colores.get(p.id);
    const prom = new Promise((res) => {
      const neutro = { h: tono(p.id), s: 65, l: 62 };
      const u = urlPortada(p);
      if (!u) return res(neutro);
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 24;
          const g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(img, 0, 0, 24, 24);
          const d = g.getImageData(0, 0, 24, 24).data;
          let x = 0, y = 0, ss = 0, ll = 0, peso = 0;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255;
            const max = Math.max(r, gg, b), min = Math.min(r, gg, b), l = (max + min) / 2;
            const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
            let h = 0;
            if (max !== min) {
              if (max === r) h = ((gg - b) / (max - min)) % 6;
              else if (max === gg) h = (b - r) / (max - min) + 2;
              else h = (r - gg) / (max - min) + 4;
              h *= 60;
            }
            // pesan los píxeles con color de verdad, ni casi negros ni casi blancos
            const w = Math.max(0.02, s * s * (1 - Math.abs(l - 0.5) * 1.7));
            x += Math.cos(h * Math.PI / 180) * w; y += Math.sin(h * Math.PI / 180) * w;
            ss += s * w; ll += l * w; peso += w;
          }
          const h = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
          const s = Math.min(92, Math.max(40, (ss / peso) * 110));
          const l = Math.min(72, Math.max(56, (ll / peso) * 100 + 8));
          res({ h: Math.round(h), s: Math.round(s), l: Math.round(l) });
        } catch (_) { res(neutro); }
      };
      img.onerror = () => res(neutro);
      img.src = u;
    });
    colores.set(p.id, prom);
    return prom;
  }
  function aplicarColores(p) {
    colorDe(p).then((c) => {
      if (actual !== p.id) return;
      const raiz = document.documentElement.style;
      raiz.setProperty("--c1", `hsl(${c.h} ${c.s}% ${c.l}%)`);
      raiz.setProperty("--c2", `hsl(${(c.h + 38) % 360} ${c.s}% ${c.l - 6}%)`);
      raiz.setProperty("--c3", `hsl(${(c.h + 320) % 360} ${c.s}% ${c.l - 10}%)`);
      if (estado.acento !== false) raiz.setProperty("--acento-cancion", `hsl(${c.h} ${c.s}% ${c.l}%)`);
      else raiz.removeProperty("--acento-cancion");
    });
  }

  // ------------------------------------------------------------ fondo
  let capa = 0;
  function ponerFondo(p) {
    const siguiente = $(capa ? "fondo-a" : "fondo-b");
    const vieja = $(capa ? "fondo-b" : "fondo-a");
    const u = urlPortada(p);
    const h = tono(p.id);
    const imagen = u ? `url("${u}")`
      : `radial-gradient(circle at 30% 25%, hsl(${h} 75% 58%), hsl(${(h + 40) % 360} 65% 24%) 70%)`;
    siguiente.style.backgroundImage = imagen;
    siguiente.classList.add("visible");
    vieja.classList.remove("visible");
    capa = 1 - capa;
    $("hoja-fondo-img").style.backgroundImage = imagen;
  }

  // ============================================================ PERFIL
  const iniciales = (n) => String(n || "").trim().split(/\s+/).slice(0, 2).map((x) => x[0] || "").join("").toUpperCase();
  function pintarAvatares() {
    document.querySelectorAll(".avatar-img").forEach((e) => {
      e.style.backgroundImage = perfil.foto ? `url("${perfil.foto}")` : "";
      e.classList.toggle("sin-foto", !perfil.foto);
      if (perfil.foto) e.textContent = "";
      else if (iniciales(perfil.nombre)) e.textContent = iniciales(perfil.nombre);
      else e.innerHTML = icono("i-persona");
    });
    $("aj-perfil-nombre").textContent = perfil.nombre || t("tuPerfil");
    $("perfil-quitar-foto").hidden = !perfil.foto;
    pintarSaludo();
  }
  function pintarSaludo() {
    const h = new Date().getHours();
    const base = h >= 5 && h < 12 ? t("buenosDias") : h >= 12 && h < 20 ? t("buenasTardes") : t("buenasNoches");
    $("saludo").textContent = perfil.nombre ? `${base}, ${perfil.nombre.split(" ")[0]}` : base;
  }
  document.querySelectorAll(".avatar:not(#perfil-foto)").forEach((b) => b.addEventListener("click", () => { haptica(); abrirPerfil(); }));
  $("aj-perfil").addEventListener("click", () => { haptica(); abrirPerfil(); });

  function abrirPerfil() {
    $("perfil-nombre").value = perfil.nombre || "";
    const dias = Object.keys(diario).sort();
    $("perfil-desde").textContent = dias.length
      ? t("escuchandoDesde", new Intl.DateTimeFormat(local(), { month: "long", year: "numeric" }).format(new Date(dias[0] + "T12:00")))
      : t("perfilSub");
    pintarEstadisticas();
    abrirModal($("perfil-hoja"));
  }
  $("perfil-nombre").addEventListener("input", (e) => {
    perfil.nombre = e.target.value.trim();
    almacen.poner("perfil", perfil);
    pintarAvatares();
  });
  $("perfil-nombre").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
  $("perfil-foto").addEventListener("click", () => { haptica(); $("perfil-archivo").click(); });
  $("perfil-quitar-foto").addEventListener("click", () => {
    perfil.foto = "";
    almacen.poner("perfil", perfil);
    pintarAvatares();
    haptica("medio");
  });
  // la foto se recorta en cuadrado y se guarda pequeña (cabe de sobra en el almacén del navegador)
  $("perfil-archivo").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const lado = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = c.height = 320;
      c.getContext("2d").drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, 320, 320);
      perfil.foto = c.toDataURL("image/jpeg", 0.86);
      almacen.poner("perfil", perfil);
      URL.revokeObjectURL(url);
      pintarAvatares();
      haptica("exito");
      aviso(t("fotoGuardada"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); aviso(t("fotoNoValida")); };
    img.src = url;
  });

  // ---- tu música en números
  const tiempoBonito = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? t("horasMinCorto", h, m) : t("minCorto", Math.max(m, s > 0 ? 1 : 0));
  };
  function racha() {
    let n = 0;
    const d = new Date();
    if ((diario[diaDe(d)] || 0) < 60) d.setDate(d.getDate() - 1);      // hoy aún no cuenta: se mira desde ayer
    while ((diario[diaDe(d)] || 0) >= 60) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function pintarEstadisticas() {
    const cont = $("estadisticas");
    cont.textContent = "";
    const total = Object.values(diario).reduce((s, x) => s + x, 0);
    if (total < 30) {
      cont.innerHTML = `<div class="stats-vacio">${icono("i-musica")}<p>${t("statsVacias")}</p></div>`;
      return;
    }
    const hoy = new Date();
    const mes = diaDe(hoy).slice(0, 7);
    const delMes = Object.entries(diario).filter(([k]) => k.startsWith(mes)).reduce((s, [, v]) => s + v, 0);

    const fila = nodo("div", "stats-fila");
    const grande = nodo("div", "stat-tarjeta grande");
    grande.append(nodo("small", "", t("esteMes")), nodo("b", "", tiempoBonito(delMes)), nodo("span", "", t("enTotal", tiempoBonito(total))));
    const fuego = nodo("div", "stat-tarjeta");
    const r = racha();
    fuego.innerHTML = icono("i-fuego", "stat-fuego" + (r ? " vivo" : ""));
    fuego.append(nodo("b", "", String(r)), nodo("span", "", t("diasSeguidos", r)));
    fila.append(grande, fuego);
    cont.append(fila);

    // la semana
    const semana = nodo("div", "stat-tarjeta semana");
    semana.append(nodo("small", "", t("ultimos7")));
    const barras = nodo("div", "barras");
    const dias = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(hoy); d.setDate(d.getDate() - i); dias.push(d); }
    const valores = dias.map((d) => diario[diaDe(d)] || 0);
    const max = Math.max(60, ...valores);
    const fmt = new Intl.DateTimeFormat(local(), { weekday: "narrow" });
    dias.forEach((d, i) => {
      const col = nodo("div", "barra" + (i === 6 ? " hoy" : ""));
      const v = nodo("i");
      v.style.setProperty("--alto", Math.max(4, (valores[i] / max) * 100) + "%");
      col.append(nodo("em", "", valores[i] >= 60 ? Math.round(valores[i] / 60) + "′" : ""), v, nodo("span", "", fmt.format(d)));
      barras.append(col);
    });
    semana.append(barras);
    cont.append(semana);

    // artistas y canciones
    const porArtista = new Map();
    for (const [id, e] of Object.entries(escuchas)) {
      const p = porId.get(id);
      if (!p || !e.s) continue;
      const nombre = artistaPrincipal(p.artista) || p.artista;
      if (!nombre) continue;
      const k = norm(nombre);
      const a = porArtista.get(k) || { nombre, s: 0, pistas: [] };
      a.s += e.s; a.pistas.push(p);
      porArtista.set(k, a);
    }
    const topArtistas = [...porArtista.values()].sort((a, b) => b.s - a.s).slice(0, 5);
    if (topArtistas.length) {
      cont.append(nodo("h3", "titulo-grupo", t("tusArtistas")));
      const ul = nodo("ul", "lista-canciones top");
      topArtistas.forEach((a, i) => {
        const li = nodo("li", "top-fila");
        const f = nodo("span", "portada artista-foto");
        fotoArtista(f, a.nombre, a.pistas);
        const tx = nodo("span", "textos");
        tx.append(nodo("b", "", a.nombre), nodo("small", "", tiempoBonito(a.s)));
        li.append(nodo("span", "puesto", String(i + 1)), f, tx);
        li.addEventListener("click", async () => { await cerrarCapas(0); irAArtista(a.nombre); });
        ul.append(li);
      });
      cont.append(ul);
    }
    const topCanciones = Object.entries(escuchas).filter(([id, e]) => porId.has(id) && e.n > 0)
      .sort((a, b) => b[1].n - a[1].n || (b[1].s || 0) - (a[1].s || 0)).slice(0, 5);
    if (topCanciones.length) {
      cont.append(nodo("h3", "titulo-grupo", t("tusCanciones")));
      const ul = nodo("ul", "lista-canciones top");
      const ids = topCanciones.map(([id]) => id);
      topCanciones.forEach(([id, e], i) => {
        const p = porId.get(id);
        const li = nodo("li", "top-fila");
        const tx = nodo("span", "textos");
        tx.append(nodo("b", "", p.titulo), nodo("small", "", `${p.artista} · ${t("nVeces", e.n)}`));
        li.append(nodo("span", "puesto", String(i + 1)), portadaPista(p), tx);
        li.addEventListener("click", async () => { haptica(); await cerrarCapa(); reproducirDesde(ids, id, { k: "loQueMasEscuchas" }); });
        ul.append(li);
      });
      cont.append(ul);
    }
  }

  // ---- contar el tiempo escuchado (reloj de pared, no la posición: saltar no suma)
  let relojEscucha = 0;
  let sinGuardar = 0;
  function contarTiempo() {
    const ahora = performance.now();
    if (relojEscucha && !audio.paused && actual) {
      const d = (ahora - relojEscucha) / 1000;
      if (d > 0 && d < 2.5) {
        const k = diaDe(new Date());
        diario[k] = (diario[k] || 0) + d;
        const e = escuchas[actual] || (escuchas[actual] = { n: 0 });
        e.s = (e.s || 0) + d;
        sinGuardar += d;
        if (sinGuardar > 15) guardarTiempo();
      }
    }
    relojEscucha = audio.paused ? 0 : ahora;
  }
  function guardarTiempo() {
    sinGuardar = 0;
    const claves = Object.keys(diario).sort();
    claves.slice(0, Math.max(0, claves.length - 400)).forEach((k) => delete diario[k]);
    almacen.poner("escuchas", escuchas);
    almacen.poner("diario", diario);
  }

  // ============================================================ BIBLIOTECA
  const ORDENES = { recientes: "recientes", titulo: "titulo", artista: "artista" };
  const principal = () => pistas.filter((p) => !p.lista);

  function ordenar(lista, como) {
    const a = lista.slice();
    const cmp = (x, y) => x.localeCompare(y, local(), { sensitivity: "base", numeric: true });
    if (como === "titulo") a.sort((x, y) => cmp(x.titulo, y.titulo));
    else if (como === "artista") a.sort((x, y) => cmp(x.artista || "￿", y.artista || "￿") || x.orden - y.orden);
    else a.sort((x, y) => y.orden - x.orden);
    return a;
  }
  const palabras = (q) => norm(q).split(" ").filter(Boolean);
  const coincide = (p, ps) => {
    const texto = norm(`${p.titulo} ${p.artista} ${p.album} ${p.lista}`);
    return ps.every((w) => texto.includes(w));
  };
  const esNueva = (p) => p.orden > Date.now() / 1000 - 2 * 86400;

  function filaCancion(p, i, { animar = false, numero = 0 } = {}) {
    const li = nodo("li", "cancion" + (animar ? " entra" : ""));
    li.dataset.id = p.id;
    if (animar) li.style.setProperty("--n", i);
    const cuerpo = nodo("div", "cancion-cuerpo");
    cuerpo.setAttribute("role", "button");
    cuerpo.tabIndex = 0;
    const marca = nodo("span", "marca-seleccion");
    marca.innerHTML = icono("i-check");
    if (numero) cuerpo.append(nodo("span", "numero", numero));
    else cuerpo.append(portadaPista(p));

    const textos = nodo("span", "textos");
    const sub = nodo("small");
    if (esNueva(p)) sub.append(nodo("span", "nueva-marca", t("nueva") + " · "));
    sub.append(document.createTextNode([p.artista || "—", p.lista && consulta ? p.lista : ""].filter(Boolean).join(" · ")));
    textos.append(nodo("b", "", p.titulo), sub);

    const lado = nodo("span", "lado");
    if (favoritas.has(p.id)) lado.insertAdjacentHTML("beforeend", icono("i-corazon", "fav-mini"));
    lado.append(nodo("span", "dur", p.duracion ? mm(p.duracion) : ""));
    const eq = nodo("span", "ecualizador");
    eq.innerHTML = "<i></i><i></i><i></i>";
    lado.append(eq);

    const mas = nodo("button", "mas");
    mas.setAttribute("aria-label", t("masOpcionesDe", p.titulo));
    mas.innerHTML = icono("i-mas");
    cuerpo.append(textos, lado, mas, marca);
    if (numero) cuerpo.style.gridTemplateColumns = "26px minmax(0, 1fr) auto 34px";
    li.append(cuerpo);
    return li;
  }

  // pinta una lista de canciones; tocar una hace sonar esa lista desde ahí
  function pintarCanciones(ul, lista, nombre, opciones = {}) {
    ul.textContent = "";
    ul._ids = lista.map((p) => p.id);
    ul._nombre = nombre;
    ul._lista = opciones.listaPropia || null;
    const frag = document.createDocumentFragment();
    lista.forEach((p, i) => frag.append(filaCancion(p, i, { ...opciones, numero: opciones.numerado ? i + 1 : 0 })));
    ul.append(frag);
    marcarActiva();
    if (seleccion && seleccion.ul === ul) pintarSeleccion();
  }

  // ---- escuchado hace poco
  function pintarCarrusel(visible) {
    const bloque = $("bloque-recientes");
    const ids = Object.entries(escuchas).filter(([id, e]) => porId.has(id) && e.u)
      .sort((a, b) => b[1].u - a[1].u).slice(0, 14).map(([id]) => id);
    bloque.hidden = !visible || ids.length < 3;
    if (bloque.hidden) return;
    const c = $("carrusel");
    if (c._firma === ids.join()) return;      // igual que antes: no repintar (no salta el scroll)
    c._firma = ids.join();
    c._ids = ids;
    c.textContent = "";
    ids.forEach((id) => {
      const p = porId.get(id);
      const b = nodo("button", "tarjeta-carrusel");
      b.dataset.id = id;
      b.append(portadaPista(p), nodo("b", "", p.titulo), nodo("small", "", p.artista || "—"));
      c.append(b);
    });
  }
  $("carrusel").addEventListener("click", (e) => {
    const b = e.target.closest(".tarjeta-carrusel");
    if (!b) return;
    haptica();
    if (b.dataset.id === actual) return abrirHoja();
    reproducirDesde($("carrusel")._ids, b.dataset.id, { k: "escuchadoHacePoco" });
  });

  function pintarMusica({ animar = false } = {}) {
    const vista = estado.vista || "canciones";
    const ps = palabras(consulta);
    const vistas = ["canciones", "artistas", "listas"];
    const seg = $("seg-musica");
    seg.style.setProperty("--i", vistas.indexOf(vista));
    seg.querySelectorAll(".segmento").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.vista === vista)));
    vistas.forEach((v) => { $("v-" + v).hidden = v !== vista; });

    const hay = pistas.length > 0;
    $("vacio").hidden = hay;
    seg.hidden = !hay;
    $("buscar").closest(".buscador").hidden = !hay;

    let resultados = 0;
    if (vista === "canciones") {
      const base = ps.length ? pistas.filter((p) => coincide(p, ps)) : principal();
      const lista = ordenar(base, estado.orden || "recientes");
      pintarCarrusel(!ps.length);
      pintarCanciones($("lista"), lista, ps.length ? `«${consulta.trim()}»` : { k: "tuMusica" }, { animar });
      resultados = lista.length;
      $("cuenta-canciones").textContent = ps.length ? t("nResultados", lista.length) : t("nCanciones", lista.length);
      $("orden-texto").textContent = t("orden_" + (estado.orden || "recientes"));
      $("v-canciones").querySelector(".fila-acciones").hidden = !lista.length;
      $("v-canciones").querySelector(".barra-orden").hidden = !hay;
      $("btn-seleccionar").hidden = !lista.length;
    } else if (vista === "artistas") {
      resultados = pintarArtistas(ps, animar);
    } else {
      resultados = pintarListas(ps, animar);
    }
    $("sin-resultados").hidden = !(hay && ps.length && !resultados);
    $("sin-resultados-texto").textContent = t("nadaCon", consulta.trim());

    const lib = principal();
    const total = lib.reduce((s, p) => s + (p.duracion || 0), 0);
    $("resumen").textContent = hay
      ? `${t("nCanciones", lib.length)}${total ? " · " + duracionLarga(total) : ""}`
      : t("aunVacia");
    pintarAjustesBiblioteca();
  }

  // ---- artistas
  function grupoArtistas() {
    const m = new Map();
    for (const p of pistas) {
      if (!p.artista) continue;
      const nombre = artistaPrincipal(p.artista) || p.artista;
      const k = norm(nombre);
      if (!m.has(k)) m.set(k, { clave: k, nombre, pistas: [] });
      m.get(k).pistas.push(p);
    }
    return [...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, local(), { sensitivity: "base" }));
  }
  const pistasDeArtista = (nombre) => {
    const k = norm(artistaPrincipal(nombre) || nombre);
    return pistas.filter((p) => norm(artistaPrincipal(p.artista) || p.artista) === k);
  };

  function fotoArtista(span, nombre, pistasArtista, grande = false) {
    const ultima = pistasArtista.slice().sort((a, b) => b.orden - a.orden)[0];
    ponerImagen(span, nombre, ultima ? urlPortada(ultima) : null);
    const guardada = artistasDz[norm(nombre)];
    if (guardada) return ponerImagen(span, nombre, grande ? guardada.b : guardada.m);
    if (guardada === null) return;
    span._artista = nombre;
    span._grande = grande;
    observadorFotos.observe(span);
  }
  // la foto de Deezer solo se pide cuando la tarjeta asoma en pantalla
  const observadorFotos = "IntersectionObserver" in window ? new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      observadorFotos.unobserve(e.target);
      const span = e.target;
      artistaDz(span._artista).then((a) => { if (a) ponerImagen(span, span._artista, span._grande ? a.b : a.m); }).catch(() => {});
    }
  }, { rootMargin: "200px" }) : { observe() {}, unobserve() {} };

  function pintarArtistas(ps, animar) {
    const rej = $("rejilla-artistas");
    rej.textContent = "";
    const lista = grupoArtistas().filter((a) => !ps.length || ps.every((w) => a.clave.includes(w)));
    lista.forEach((a, i) => {
      const b = nodo("button", "artista-tarjeta" + (animar ? " entra" : ""));
      b.style.setProperty("--n", i);
      const foto = nodo("span", "portada artista-foto");
      fotoArtista(foto, a.nombre, a.pistas);
      b.append(foto, nodo("b", "", a.nombre), nodo("small", "", t("nCanciones", a.pistas.length)));
      b.addEventListener("click", () => { haptica(); abrirDetalle({ tipo: "artista", valor: a.nombre }); });
      rej.append(b);
    });
    return lista.length;
  }

  // ---- listas: las propias, las "inteligentes" y las de la ficha de cada canción
  function listas() {
    const ahora = Date.now() / 1000;
    const res = [];
    for (const l of misListas) {
      res.push({ clave: "mi:" + l.id, nombre: l.nombre, pistas: l.ids.map((id) => porId.get(id)).filter(Boolean), propia: l });
    }
    res.push(
      { clave: "favoritas", nombre: t("favoritas"), icono: "i-corazon", pistas: pistas.filter((p) => favoritas.has(p.id)).sort((a, b) => b.orden - a.orden), siempre: true },
      { clave: "recientes", nombre: t("recienAnadidas"), icono: "i-reloj", pistas: pistas.filter((p) => p.orden > ahora - 30 * 86400).sort((a, b) => b.orden - a.orden).slice(0, 50) },
      { clave: "escuchadas", nombre: t("loQueMasEscuchas"), icono: "i-musica", pistas: pistas.filter((p) => escuchas[p.id]?.n > 0).sort((a, b) => escuchas[b.id].n - escuchas[a.id].n).slice(0, 50), numerado: true },
      { clave: "descubiertas", nombre: t("deDescubrir"), icono: "i-chispas", pistas: pistas.filter((p) => p.descubierta).sort((a, b) => b.orden - a.orden) },
    );
    const nombres = [...new Set(pistas.map((p) => p.lista).filter(Boolean))].sort((a, b) => a.localeCompare(b, local()));
    for (const n of nombres) {
      res.push({ clave: "lista:" + n, nombre: n, pistas: pistas.filter((p) => p.lista === n).sort((a, b) => a.orden - b.orden) });
    }
    return res.filter((l) => l.siempre || l.propia || l.pistas.length);
  }
  function arteLista(l, clase = "") {
    if (l.icono) {
      const m = nodo("span", `mosaico solo lista-icono ${l.clave} ${clase}`);
      m.innerHTML = icono(l.icono);
      return m;
    }
    const conPortada = l.pistas.filter((p) => p.portada);
    const cuatro = (conPortada.length >= 4 ? conPortada : l.pistas).slice(0, 4);
    if (!cuatro.length) {                         // lista propia vacía
      const m = nodo("span", `mosaico solo lista-icono vacia ${clase}`);
      m.innerHTML = icono("i-musica");
      return m;
    }
    const m = nodo("span", "mosaico " + clase + (cuatro.length < 4 ? " solo" : ""));
    (cuatro.length < 4 ? cuatro.slice(0, 1) : cuatro).forEach((p) => m.append(portadaPista(p)));
    return m;
  }
  function pintarListas(ps, animar) {
    const rej = $("rejilla-listas");
    rej.textContent = "";
    if (!ps.length) {
      const nueva = nodo("button", "lista-tarjeta nueva" + (animar ? " entra" : ""));
      const m = nodo("span", "mosaico solo lista-icono crear");
      m.innerHTML = icono("i-plus");
      nueva.append(m, nodo("b", "", t("nuevaLista")), nodo("small", "", t("nuevaListaSub")));
      nueva.addEventListener("click", () => { haptica(); abrirNuevaLista({}); });
      rej.append(nueva);
    }
    const todas = listas().filter((l) => !ps.length || ps.every((w) => norm(l.nombre).includes(w)));
    todas.forEach((l, i) => {
      const b = nodo("button", "lista-tarjeta" + (animar ? " entra" : ""));
      b.style.setProperty("--n", i + 1);
      b.append(arteLista(l), nodo("b", "", l.nombre), nodo("small", "", t("nCanciones", l.pistas.length)));
      b.addEventListener("click", () => { haptica(); abrirDetalle({ tipo: "lista", valor: l.clave }); });
      rej.append(b);
    });
    return todas.length;
  }

  // ============================================================ LISTAS PROPIAS
  // Varias por canción y con su orden. Se guardan en el navegador y, con
  // servidor, también en music/.listas.json (así no se pierden ni cambian de un sitio a otro).
  const listaPropia = (id) => misListas.find((l) => l.id === id);
  let esperaListas = 0;
  function guardarListas() {
    almacen.poner("listas", misListas);
    if (!servidor) return;
    clearTimeout(esperaListas);
    esperaListas = setTimeout(() => post("api/listas", { listas: misListas }).catch(() => {}), 400);
  }
  function crearLista(nombre, ids = []) {
    const l = { id: "l" + Date.now().toString(36), nombre: nombre.trim() || t("nuevaLista"), ids: [...new Set(ids)], creada: Date.now() };
    misListas.unshift(l);
    guardarListas();
    return l;
  }
  function anadirALista(l, ids) {
    const nuevas = [...new Set(ids)].filter((id) => !l.ids.includes(id));
    l.ids.push(...nuevas);
    guardarListas();
    return nuevas.length;
  }
  function quitarDeLista(l, ids) {
    const antes = l.ids.slice();
    l.ids = l.ids.filter((id) => !ids.includes(id));
    guardarListas();
    refrescarVistas();
    haptica("medio");
    aviso(ids.length === 1 ? t("quitadaDe", l.nombre) : t("nQuitadasDe", ids.length, l.nombre), () => {
      l.ids = antes;
      guardarListas();
      refrescarVistas();
    });
  }

  // nueva lista / renombrar
  let modoLista = null;                // { ids, renombrar: lista, abrir }
  function abrirNuevaLista(modo) {
    modoLista = modo;
    const f = $("lista-nueva-form");
    f.nombre.value = modo.renombrar ? modo.renombrar.nombre : "";
    $("lista-nueva-titulo").textContent = modo.renombrar ? t("renombrarLista") : t("nuevaLista");
    $("lista-nueva-ok").textContent = modo.renombrar ? t("guardar") : t("crear");
    abrirModal($("lista-nueva"));
    setTimeout(() => f.nombre.focus(), 350);
  }
  $("lista-nueva-cancelar").addEventListener("click", () => cerrarCapa());
  $("lista-nueva-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = e.target.nombre.value.trim();
    if (!nombre) return;
    const modo = modoLista || {};
    await cerrarCapa();
    haptica("exito");
    if (modo.renombrar) {
      modo.renombrar.nombre = nombre;
      guardarListas();
      refrescarVistas();
      return;
    }
    const l = crearLista(nombre, modo.ids || []);
    if (modo.ids && modo.ids.length) {
      aviso(modo.ids.length === 1 ? t("anadidaA", l.nombre) : t("nAnadidasA", modo.ids.length, l.nombre));
      if (modo.alAcabar) modo.alAcabar();
      refrescarVistas();
      return;
    }
    irPestana("musica");
    if (!capaAbierta("detalle")) abrirDetalle({ tipo: "lista", valor: "mi:" + l.id });
    else { detalle = { tipo: "lista", valor: "mi:" + l.id }; pintarDetalle({ animar: true }); }
    refrescarVistas();
    setTimeout(() => abrirElegirCanciones(l), 450);
  });

  // elegir a qué lista se añade
  function abrirElegirLista(ids, alAcabar) {
    const cont = $("elegir-lista-filas");
    cont.textContent = "";
    const nueva = nodo("button", "fila-lista");
    const m = nodo("span", "mosaico solo lista-icono crear");
    m.innerHTML = icono("i-plus");
    nueva.append(m, nodo("b", "", t("nuevaLista")));
    nueva.addEventListener("click", async () => { haptica(); await cerrarCapa(); abrirNuevaLista({ ids, alAcabar }); });
    cont.append(nueva);
    for (const l of misListas) {
      const datos = { pistas: l.ids.map((id) => porId.get(id)).filter(Boolean) };
      const todas = ids.every((id) => l.ids.includes(id));
      const b = nodo("button", "fila-lista" + (todas ? " ya" : ""));
      const tx = nodo("span", "textos");
      tx.append(nodo("b", "", l.nombre), nodo("small", "", todas ? t("yaEsta") : t("nCanciones", datos.pistas.length)));
      b.append(arteLista(datos), tx);
      if (todas) b.insertAdjacentHTML("beforeend", icono("i-check", "fila-lista-check"));
      b.addEventListener("click", async () => {
        const n = anadirALista(l, ids);
        haptica(n ? "exito" : "suave");
        await cerrarCapa();
        aviso(!n ? t("yaEstabaEn", l.nombre) : n === 1 ? t("anadidaA", l.nombre) : t("nAnadidasA", n, l.nombre));
        refrescarVistas();
        if (alAcabar) alAcabar();
      });
      cont.append(b);
    }
    abrirModal($("elegir-lista"));
  }

  // elegir canciones para una lista
  let eligiendo = null;                // { lista, ids:Set }
  function abrirElegirCanciones(l) {
    eligiendo = { lista: l, ids: new Set() };
    $("elegir-buscar").value = "";
    pintarElegibles();
    abrirModal($("elegir-canciones"));
  }
  function pintarElegibles() {
    const ul = $("elegir-filas");
    ul.textContent = "";
    const ps = palabras($("elegir-buscar").value);
    const lista = ordenar(pistas.filter((p) => !ps.length || coincide(p, ps)), "recientes");
    lista.forEach((p) => {
      const li = filaCancion(p, 0);
      li.classList.add("elegible");
      if (eligiendo.lista.ids.includes(p.id)) li.classList.add("ya");
      if (eligiendo.ids.has(p.id)) li.classList.add("elegida");
      ul.append(li);
    });
    const n = eligiendo.ids.size;
    $("elegir-ok").querySelector("span").textContent = n ? t("anadirN", n) : t("anadir");
    $("elegir-ok").disabled = !n;
  }
  $("elegir-buscar").addEventListener("input", pintarElegibles);
  $("elegir-filas").addEventListener("click", (e) => {
    const li = e.target.closest(".cancion");
    if (!li || li.classList.contains("ya")) return;
    haptica("suave");
    const id = li.dataset.id;
    if (eligiendo.ids.has(id)) eligiendo.ids.delete(id); else eligiendo.ids.add(id);
    li.classList.toggle("elegida", eligiendo.ids.has(id));
    const n = eligiendo.ids.size;
    $("elegir-ok").querySelector("span").textContent = n ? t("anadirN", n) : t("anadir");
    $("elegir-ok").disabled = !n;
  });
  $("elegir-cancelar").addEventListener("click", () => cerrarCapa());
  $("elegir-ok").addEventListener("click", async () => {
    const { lista, ids } = eligiendo;
    const n = anadirALista(lista, [...ids]);
    haptica("exito");
    await cerrarCapa();
    aviso(n === 1 ? t("anadidaA", lista.nombre) : t("nAnadidasA", n, lista.nombre));
    refrescarVistas();
  });

  // ============================================================ DETALLE (artista o lista)
  let detalle = null;
  function datosDetalle(d) {
    if (d.tipo === "artista") {
      const ps = pistasDeArtista(d.valor).sort((a, b) => b.orden - a.orden);
      return { titulo: d.valor, pistas: ps, redonda: true };
    }
    const l = listas().find((x) => x.clave === d.valor);
    if (!l) return null;
    return { titulo: l.nombre, pistas: l.pistas, lista: l };
  }
  function pintarDetalle({ animar = false } = {}) {
    const datos = datosDetalle(detalle);
    if (!datos) return cerrarHasta("detalle");
    const total = datos.pistas.reduce((s, p) => s + (p.duracion || 0), 0);
    const propia = datos.lista && datos.lista.propia;
    $("detalle-titulo").textContent = datos.titulo;
    $("detalle-barra").textContent = datos.titulo;
    $("detalle-sub").textContent = datos.pistas.length
      ? `${t("nCanciones", datos.pistas.length)}${total ? " · " + duracionLarga(total) : ""}`
      : detalle.valor === "favoritas" ? t("favoritasVacia") : propia ? t("listaVacia") : t("nadaTodavia");
    const arte = $("detalle-arte");
    arte.textContent = "";
    if (datos.redonda) {
      const f = nodo("span", "portada artista-foto");
      fotoArtista(f, datos.titulo, datos.pistas, true);
      arte.append(f);
    } else arte.append(arteLista(datos.lista));
    $("detalle-play").parentElement.hidden = !datos.pistas.length;
    const nombre = detalle.valor === "favoritas" ? { k: "favoritas" } : datos.titulo;
    pintarCanciones($("detalle-lista"), datos.pistas, nombre, { animar, numerado: datos.lista && datos.lista.numerado, listaPropia: propia || null });
    $("detalle-anadir").hidden = !propia;
    $("detalle-mas").hidden = detalle.tipo !== "artista";
    $("detalle-mas").querySelector("span").textContent = t("buscarMasDe", datos.titulo);
  }
  function abrirDetalle(d) {
    detalle = d;
    const pant = $("detalle");
    pant.scrollTop = 0;
    pant.classList.remove("plegada");
    pintarDetalle({ animar: true });
    if (capaAbierta("detalle")) return;
    pant.classList.add("abierta");
    pant.setAttribute("aria-hidden", "false");
    $("pantallas").classList.add("empujada");
    abrirCapa("detalle", soltarDetalle);
    pintarBandeja();
  }
  function soltarDetalle() {
    const pant = $("detalle");
    pant.classList.remove("abierta", "siguiendo");
    pant.style.transform = "";
    pant.setAttribute("aria-hidden", "true");
    const p = $("pantallas");
    p.classList.remove("empujada", "siguiendo");
    p.style.transform = p.style.opacity = "";
    detalle = null;
    pintarBandeja();
  }
  $("detalle-atras").addEventListener("click", () => cerrarCapa());
  $("detalle-play").addEventListener("click", () => tocarLista($("detalle-lista"), false));
  $("detalle-mezcla").addEventListener("click", () => tocarLista($("detalle-lista"), true));
  $("detalle-anadir").addEventListener("click", () => {
    const l = detalle && listaPropia(detalle.valor.slice(3));
    if (l) { haptica(); abrirElegirCanciones(l); }
  });
  $("detalle-mas").addEventListener("click", async () => {
    const nombre = detalle && detalle.valor;
    await cerrarCapas(0);
    irPestana("descubrir");
    buscarEnDeezer(nombre);
  });
  $("detalle-opciones").addEventListener("click", () => {
    if (!detalle) return;
    haptica();
    const ul = $("detalle-lista");
    const l = detalle.tipo === "lista" && detalle.valor.startsWith("mi:") ? listaPropia(detalle.valor.slice(3)) : null;
    abrirMenu({
      cabeza: { titulo: $("detalle-titulo").textContent },
      acciones: [
        ul._ids.length && { icono: "i-a-continuacion", texto: t("reproducirDespues"), accion: () => { ul._ids.slice().reverse().forEach((id) => ponerSiguiente(id, true)); aviso(t("sonaranDespues", ul._ids.length)); } },
        ul._ids.length && { icono: "i-seleccionar", texto: t("seleccionar"), accion: () => empezarSeleccion(ul) },
        ul._ids.length && { icono: "i-lista-mas", texto: t("anadirTodasALista"), accion: () => abrirElegirLista(ul._ids.slice()) },
        l && { icono: "i-plus", texto: t("anadirCanciones"), accion: () => abrirElegirCanciones(l) },
        l && { icono: "i-lapiz", texto: t("renombrarLista"), accion: () => abrirNuevaLista({ renombrar: l }) },
        l && { icono: "i-papelera", texto: t("borrarLista"), peligro: true, accion: () => borrarLista(l) },
      ],
    });
  });
  function borrarLista(l) {
    const i = misListas.indexOf(l);
    misListas.splice(i, 1);
    guardarListas();
    cerrarHasta("detalle");
    refrescarVistas();
    haptica("medio");
    aviso(t("listaBorrada", l.nombre), () => {
      misListas.splice(i, 0, l);
      guardarListas();
      refrescarVistas();
    });
  }
  // deslizar desde el borde izquierdo: atrás, como en iOS
  arrastre($("detalle"), {
    empieza: (e) => e.clientX < 30,
    horizontal: (dx) => {
      const pant = $("detalle"), p = $("pantallas"), f = Math.max(0, dx) / innerWidth;
      pant.classList.add("siguiendo"); p.classList.add("siguiendo");
      pant.style.transform = `translateX(${Math.max(0, dx)}px)`;
      p.style.transform = `translateX(${-28 * (1 - f)}%)`;
      p.style.opacity = f;
    },
    suelta: (dx, v) => {
      const pant = $("detalle"), p = $("pantallas");
      pant.classList.remove("siguiendo"); p.classList.remove("siguiendo");
      pant.style.transform = ""; p.style.transform = ""; p.style.opacity = "";
      if (dx > innerWidth * 0.33 || v > 0.5) cerrarCapa();
    },
  });

  // ============================================================ TOCAR EN LISTAS
  // fila = sonar; ⋯ = menú; pulsación larga = menú; deslizar = a continuación / borrar
  function tocarLista(ul, aleatorio) {
    if (!ul._ids || !ul._ids.length) return;
    haptica();
    reproducirDesde(ul._ids, null, ul._nombre, { aleatorio });
  }
  function prepararLista(ul) {
    ul.addEventListener("click", (e) => {
      const li = e.target.closest(".cancion");
      if (!li || li._sinClic) return;
      if (seleccion && seleccion.ul === ul) return alternarElegida(li);
      if (e.target.closest(".mas")) return menuCancion(li.dataset.id, ul);
      haptica("suave");
      if (li.dataset.id === actual) return abrirHoja();
      reproducirDesde(ul._ids, li.dataset.id, ul._nombre);
    });
    ul.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.classList.contains("cancion-cuerpo")) e.target.click();
    });
    ul.addEventListener("contextmenu", (e) => {
      const li = e.target.closest(".cancion");
      if (li && !seleccion) { e.preventDefault(); menuCancion(li.dataset.id, ul); }
    });
    // pulsación larga = menú
    let largo = 0;
    ul.addEventListener("pointerdown", (e) => {
      const li = e.target.closest(".cancion");
      if (!li || e.pointerType === "mouse" || seleccion) return;
      const x0 = e.clientX, y0 = e.clientY;
      const quieto = (ev) => { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) parar(); };
      const parar = () => { clearTimeout(largo); ul.removeEventListener("pointermove", quieto); };
      ul.addEventListener("pointermove", quieto);
      ul.addEventListener("pointerup", parar, { once: true });
      ul.addEventListener("pointercancel", parar, { once: true });
      largo = setTimeout(() => {
        parar();
        li._sinClic = true;
        setTimeout(() => { li._sinClic = false; }, 600);
        haptica("fuerte");
        menuCancion(li.dataset.id, ul);
      }, 480);
    });
    // deslizar una fila
    ul.addEventListener("pointerdown", (e) => {
      const li = e.target.closest(".cancion");
      if (!li || e.button || seleccion) return;
      const cuerpo = li.querySelector(".cancion-cuerpo");
      const x0 = e.clientX, y0 = e.clientY;
      const quitar = !!ul._lista;                        // en una lista propia, izquierda = quitar de la lista
      let modo = null, dx = 0, revelado = null, listo = false;
      const mover = (ev) => {
        dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (!modo) {
          if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return fin(true);
          if (Math.abs(dx) < 12) return;
          modo = "h";
          clearTimeout(largo);
          try { li.setPointerCapture(ev.pointerId); } catch (_) {}
          li.classList.add("arrastrando");
        }
        if (dx < 0 && !servidor && !quitar) dx = 0;      // sin servidor no se borra
        if (!dx) { cuerpo.style.transform = ""; return; }
        const lejos = Math.abs(dx);
        const d = lejos < 90 ? dx : Math.sign(dx) * (90 + (lejos - 90) * 0.35);
        cuerpo.style.transform = `translateX(${d}px)`;
        const tipo = dx > 0 ? "cola" : "borrar";
        if (!revelado || !revelado.classList.contains(tipo)) {
          revelado && revelado.remove();
          revelado = nodo("div", "revelado " + tipo);
          revelado.innerHTML = tipo === "cola"
            ? icono("i-a-continuacion") + `<span>${t("aContinuacion")}</span>`
            : `<span>${quitar ? t("quitar") : t("borrar")}</span>` + icono("i-papelera");
          li.prepend(revelado);
        }
        const ahora = lejos > 85;
        if (ahora !== listo) { listo = ahora; revelado.classList.toggle("listo", listo); if (listo) haptica("medio"); }
      };
      const fin = (cancelado) => {
        ul.removeEventListener("pointermove", mover);
        ul.removeEventListener("pointerup", soltar);
        ul.removeEventListener("pointercancel", cancelar);
        if (cancelado || !modo) return;
        li._sinClic = true;
        setTimeout(() => { li._sinClic = false; }, 60);
        li.classList.remove("arrastrando");
        cuerpo.style.transform = "";
        const r = revelado;
        setTimeout(() => r && r.remove(), 400);
        if (!listo) return;
        const p = porId.get(li.dataset.id);
        if (!p) return;
        if (dx > 0) ponerSiguiente(p.id);
        else if (quitar) quitarDeLista(ul._lista, [p.id]);
        else borrar([p]);
      };
      const soltar = () => fin(false);
      const cancelar = () => { listo = false; fin(false); };
      ul.addEventListener("pointermove", mover);
      ul.addEventListener("pointerup", soltar);
      ul.addEventListener("pointercancel", cancelar);
    });
  }
  prepararLista($("lista"));
  prepararLista($("detalle-lista"));

  function marcarActiva() {
    document.querySelectorAll(".cancion.activa").forEach((e) => e.classList.remove("activa"));
    if (actual) document.querySelectorAll(`.cancion[data-id="${CSS.escape(actual)}"]`).forEach((e) => e.classList.add("activa"));
  }

  // ============================================================ SELECCIÓN MÚLTIPLE
  let seleccion = null;                // { ul, ids:Set }
  function empezarSeleccion(ul, id) {
    if (seleccion) return;
    seleccion = { ul, ids: new Set(id ? [id] : []) };
    document.body.classList.add("seleccionando");
    $("barra-seleccion").hidden = false;
    haptica("medio");
    pintarSeleccion();
    abrirCapa("seleccion", soltarSeleccion);
  }
  function soltarSeleccion() {
    document.body.classList.remove("seleccionando");
    $("barra-seleccion").hidden = true;
    document.querySelectorAll(".cancion.elegida").forEach((e) => e.classList.remove("elegida"));
    seleccion = null;
  }
  function alternarElegida(li) {
    const id = li.dataset.id;
    if (seleccion.ids.has(id)) seleccion.ids.delete(id); else seleccion.ids.add(id);
    haptica("suave");
    pintarSeleccion();
  }
  function pintarSeleccion() {
    const { ul, ids } = seleccion;
    ul.querySelectorAll(".cancion").forEach((li) => li.classList.toggle("elegida", ids.has(li.dataset.id)));
    $("sel-n").textContent = ids.size ? t("nSeleccionadas", ids.size) : t("tocaParaElegir");
    $("sel-todas").textContent = ids.size && ids.size === ul._ids.length ? t("ninguna") : t("todas");
    const quitar = !!ul._lista;
    $("sel-borrar").querySelector("span").textContent = quitar ? t("quitar") : t("borrar");
    $("sel-borrar").hidden = !quitar && !servidor;
    const todasFav = ids.size && [...ids].every((x) => favoritas.has(x));
    $("sel-fav").querySelector("use").setAttribute("href", todasFav ? "#i-corazon" : "#i-corazon-v");
    $("barra-seleccion").querySelectorAll(".sel-acciones button").forEach((b) => { b.disabled = !ids.size; });
  }
  const elegidas = () => seleccion.ul._ids.filter((id) => seleccion.ids.has(id));
  $("btn-seleccionar").addEventListener("click", () => empezarSeleccion($("lista")));
  $("sel-listo").addEventListener("click", () => cerrarHasta("seleccion"));
  $("sel-todas").addEventListener("click", () => {
    const { ul, ids } = seleccion;
    if (ids.size === ul._ids.length) ids.clear(); else ul._ids.forEach((id) => ids.add(id));
    haptica();
    pintarSeleccion();
  });
  $("sel-lista").addEventListener("click", () => {
    const ids = elegidas();
    abrirElegirLista(ids, () => cerrarHasta("seleccion"));
  });
  $("sel-cola").addEventListener("click", async () => {
    const ids = elegidas();
    await cerrarHasta("seleccion");
    if (!actual) return reproducirDesde(ids, ids[0], { k: "tuMusica" });
    colaUsuario.push(...ids);
    haptica("exito");
    aviso(t("nALaCola", ids.length));
  });
  $("sel-fav").addEventListener("click", async () => {
    const ids = elegidas();
    const quitarlas = ids.every((x) => favoritas.has(x));
    ids.forEach((id) => (quitarlas ? favoritas.delete(id) : favoritas.add(id)));
    almacen.poner("fav", [...favoritas]);
    if (ids.includes(actual)) pintarFav();
    await cerrarHasta("seleccion");
    haptica("exito");
    aviso(quitarlas ? t("nQuitadasFav", ids.length) : t("nAFav", ids.length));
    refrescarVistas();
  });
  $("sel-borrar").addEventListener("click", async () => {
    const ul = seleccion.ul;
    const ids = elegidas();
    if (ul._lista) { await cerrarHasta("seleccion"); return quitarDeLista(ul._lista, ids); }
    const ok = await confirmar(t("borrarNCanciones", ids.length), t("borrarNTexto"), t("borrar"));
    if (!ok) return;
    await cerrarHasta("seleccion");
    borrar(ids.map((id) => porId.get(id)).filter(Boolean));
  });

  // ============================================================ MENÚ DE UNA CANCIÓN
  function menuCancion(id, ul) {
    const p = porId.get(id);
    if (!p) return;
    const fav = favoritas.has(id);
    const lista = ul && ul._lista;
    abrirMenu({
      cabeza: { pista: p },
      acciones: [
        { icono: "i-a-continuacion", texto: t("reproducirDespues"), accion: () => ponerSiguiente(id) },
        { icono: "i-cola", texto: t("anadirALaCola"), accion: () => ponerEnCola(id) },
        { icono: "i-lista-mas", texto: t("anadirAUnaLista"), accion: () => abrirElegirLista([id]) },
        { icono: fav ? "i-corazon" : "i-corazon-v", texto: fav ? t("quitarDeFavoritas") : t("anadirAFavoritas"), accion: () => alternarFav(id) },
        p.artista && { icono: "i-persona", texto: t("irA", artistaPrincipal(p.artista)), accion: () => irAArtista(p.artista) },
        p.artista && { icono: "i-chispas", texto: t("buscarMasComoEsta"), accion: async () => { await cerrarCapas(0); irPestana("descubrir"); buscarEnDeezer(artistaPrincipal(p.artista)); } },
        ul && !capaAbierta("hoja") && { icono: "i-seleccionar", texto: t("seleccionarVarias"), accion: () => empezarSeleccion(ul, id) },
        servidor && { icono: "i-lapiz", texto: t("editarDatos"), accion: () => abrirEditor(id) },
        lista && { icono: "i-x", texto: t("quitarDeEstaLista"), peligro: true, accion: () => quitarDeLista(lista, [id]) },
        servidor && { icono: "i-papelera", texto: t("borrarDeTuMusica"), peligro: true, accion: () => borrar([p]) },
      ],
    });
  }
  async function irAArtista(artista) {
    await cerrarCapas(0);
    irPestana("musica");
    abrirDetalle({ tipo: "artista", valor: artistaPrincipal(artista) || artista });
  }
  function ponerSiguiente(id, callado) {
    if (!actual) return reproducirDesde([id], id, { k: "tuMusica" });
    colaUsuario = colaUsuario.filter((x) => x !== id);
    colaUsuario.unshift(id);
    if (!callado) { haptica("exito"); aviso(t("sonaraDespues", porId.get(id).titulo)); }
    if (!$("cola-vista").hidden) pintarCola();
  }
  function ponerEnCola(id) {
    if (!actual) return reproducirDesde([id], id, { k: "tuMusica" });
    colaUsuario.push(id);
    haptica("exito");
    aviso(t("anadidaALaCola", porId.get(id).titulo));
    if (!$("cola-vista").hidden) pintarCola();
  }
  function alternarFav(id) {
    if (favoritas.has(id)) favoritas.delete(id); else favoritas.add(id);
    almacen.poner("fav", [...favoritas]);
    haptica(favoritas.has(id) ? "exito" : "suave");
    if (id === actual) pintarFav();
    refrescarVistas();
  }

  // ---- borrar (con deshacer; el servidor lo archiva en _CUARENTENA/music)
  async function borrar(lista) {
    const hechas = [];
    for (const p of lista) {
      try { await post("borrar", { id: p.id }); hechas.push(p); } catch (_) {}
    }
    if (!hechas.length) return aviso(t("noSePudoBorrar"));
    haptica("fuerte");
    await recargar();
    const texto = hechas.length === 1 ? t("borrada", hechas[0].titulo) : t("nBorradas", hechas.length);
    aviso(texto, async () => {
      let bien = 0;
      for (const p of hechas) { try { await post("restaurar", { id: p.id }); bien++; } catch (_) {} }
      await recargar();
      aviso(bien === 1 ? t("recuperada") : t("nRecuperadas", bien));
    });
  }

  // ---- editar ficha
  let editando = null;
  function abrirEditor(id) {
    const p = porId.get(id);
    if (!p) return;
    editando = id;
    const f = $("editor-form");
    f.titulo.value = p.titulo;
    f.artista.value = p.artista;
    f.album.value = p.album || "";
    $("artistas-datos").innerHTML = "";
    grupoArtistas().forEach((a) => $("artistas-datos").append(new Option(a.nombre)));
    abrirModal($("editor"));
  }
  $("editor-cancelar").addEventListener("click", () => cerrarCapa());
  $("editor-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const datos = { id: editando, titulo: f.titulo.value, artista: f.artista.value, album: f.album.value };
    try { await post("api/ficha", datos); } catch (_) { return aviso(t("noSePudoGuardar")); }
    await cerrarCapa();
    await recargar();
    haptica("exito");
    aviso(t("guardado"));
  });

  // vuelve a leer la lista sin perder lo que suena
  async function recargar() {
    if (!(await cargarPistas())) return;
    if (actual && !porId.has(actual)) soltarActual();
    contexto.ids = contexto.ids.filter((id) => porId.has(id));
    orden = orden.filter((id) => porId.has(id));
    pos = actual ? orden.indexOf(actual) : -1;
    colaUsuario = colaUsuario.filter((id) => porId.has(id));
    historial = historial.filter((id) => porId.has(id));
    if (actual) {
      const p = porId.get(actual);
      $("mini-titulo").textContent = $("grande-titulo").textContent = p.titulo;
      $("mini-artista").textContent = $("grande-artista").textContent = p.artista || "";
    }
    refrescarVistas();
  }
  function refrescarVistas() {
    pintarMusica();
    if (detalle) pintarDetalle();
    if (!$("cola-vista").hidden) pintarCola();
    marcarEnBiblioteca();
  }

  function soltarActual() {            // se ha borrado lo que sonaba
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    actual = null;
    $("mini").hidden = true;
    document.body.classList.remove("con-mini");
    if (capaAbierta("hoja")) cerrarHasta("hoja");
    document.title = "Music";
    guardarEstado({ id: null, t: 0 });
  }

  // ============================================================ NAVEGACIÓN
  const PESTANAS = ["musica", "descubrir", "ajustes"];
  function irPestana(nombre) {
    const boton = document.querySelector(`.pestana[data-pestana="${nombre}"]`);
    boton.classList.remove("toque"); void boton.offsetWidth; boton.classList.add("toque");
    if (nombre === pestana) {               // otra vez la misma: a la raíz y arriba del todo
      if (capaAbierta("detalle")) cerrarCapas(0);
      else $("p-" + nombre).scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (capaAbierta("detalle")) cerrarCapas(0);
    pestana = nombre;
    document.querySelectorAll(".pantalla[data-pestana]").forEach((p) => p.classList.toggle("activa", p.dataset.pestana === nombre));
    document.querySelectorAll(".pestana").forEach((b) => {
      if (b.dataset.pestana === nombre) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelector(".pestana-luz").style.setProperty("--i", PESTANAS.indexOf(nombre));
    if (nombre === "descubrir") {
      if (rec.nuevas) { rec.nuevas = false; almacen.poner("rec", rec); pintarGlobo(); }
      if (generando) pintarEsqueleto();
      else if (!rec.fecha) recomendar();
      else pintarRecs();
    }
    pintarBandeja();
  }
  document.querySelectorAll(".pestana").forEach((b) => b.addEventListener("click", () => { haptica("suave"); irPestana(b.dataset.pestana); }));

  // el título grande se pliega en la barra de arriba al bajar
  document.querySelectorAll(".pantalla").forEach((p) => {
    p.addEventListener("scroll", () => p.classList.toggle("plegada", p.scrollTop > 60), { passive: true });
  });

  // segmentos de Música
  $("seg-musica").addEventListener("click", (e) => {
    const b = e.target.closest(".segmento");
    if (!b || b.dataset.vista === (estado.vista || "canciones")) return;
    haptica("suave");
    guardarEstado({ vista: b.dataset.vista });
    pintarMusica({ animar: true });
  });

  // búsqueda en tu música
  const buscar = $("buscar");
  buscar.addEventListener("input", () => {
    consulta = buscar.value;
    $("buscar-borrar").hidden = !consulta;
    pintarMusica();
  });
  $("buscar-borrar").addEventListener("click", () => { buscar.value = ""; consulta = ""; $("buscar-borrar").hidden = true; pintarMusica(); buscar.focus(); });
  buscar.addEventListener("keydown", (e) => { if (e.key === "Enter") buscar.blur(); });
  $("buscar-fuera").addEventListener("click", () => { const q = consulta; irPestana("descubrir"); buscarEnDeezer(q); });
  $("vacio-descubrir").addEventListener("click", () => irPestana("descubrir"));

  $("btn-todo-play").addEventListener("click", () => tocarLista($("lista"), false));
  $("btn-todo-mezcla").addEventListener("click", () => tocarLista($("lista"), true));
  $("btn-orden").addEventListener("click", () => {
    haptica();
    const ahora = estado.orden || "recientes";
    abrirMenu({
      cabeza: { titulo: t("ordenarPor") },
      acciones: Object.keys(ORDENES).map((k) => ({
        icono: { recientes: "i-reloj", titulo: "i-orden", artista: "i-persona" }[k], texto: t("orden_" + k), marcada: k === ahora,
        accion: () => { guardarEstado({ orden: k }); pintarMusica({ animar: true }); },
      })),
    });
  });

  // ============================================================ REPRODUCTOR
  function construirOrden(empezarEn) {
    const ids = contexto.ids.filter((id) => porId.has(id));
    if (mezcla) {
      const resto = barajar(ids.filter((x) => x !== empezarEn));
      orden = empezarEn && ids.includes(empezarEn) ? [empezarEn, ...resto] : resto;
    } else orden = ids;
    pos = empezarEn ? orden.indexOf(empezarEn) : -1;
  }

  function reproducirDesde(ids, id, nombre, { aleatorio } = {}) {
    if (!ids.length) return;
    contexto = { nombre: nombre || { k: "tuMusica" }, ids: ids.slice() };
    if (aleatorio !== undefined) { mezcla = aleatorio; pintarModos(); }
    if (!id) id = mezcla ? ids[Math.floor(Math.random() * ids.length)] : ids[0];
    construirOrden(id);
    reproducir(id);
    guardarEstado({ contexto, mezcla });
  }

  let direccion = 0;                  // para la animación de la portada al cambiar
  function reproducir(id, { sinHistorial = false } = {}) {
    const p = porId.get(id);
    if (!p) return;
    if (!sinHistorial && actual && actual !== id) {
      historial.push(actual);
      if (historial.length > 200) historial.shift();
    }
    const i = orden.indexOf(id);
    if (i >= 0) pos = i;
    cargar(p);
    pararMuestra(false);
    cancelarRampa();
    audio.volume = 1;
    audio.play().catch(() => {});
    guardarEstado({ id, t: 0 });
  }

  function cargar(p) {
    mostrar(p);
    audio.src = urlAudio(p);
    contada = false;
  }

  function mostrar(p) {
    const cambia = actual !== p.id;
    actual = p.id;
    document.body.classList.add("con-mini");
    $("mini").hidden = false;
    $("mini-titulo").textContent = p.titulo;
    $("mini-artista").textContent = p.artista || "";
    $("grande-titulo").textContent = p.titulo;
    $("grande-artista").textContent = p.artista || "";
    ponerImagen($("mini-portada"), p.id, urlPortada(p));
    const g = $("grande-portada");
    ponerImagen(g, p.id, urlPortada(p));
    if (cambia && direccion && capaAbierta("hoja") && !movimientoReducido()) {
      const clase = direccion > 0 ? "entra-izq" : "entra-dcha";
      g.classList.remove("entra-izq", "entra-dcha");
      void g.offsetWidth;
      g.classList.add(clase);
      setTimeout(() => g.classList.remove(clase), 520);
    }
    direccion = 0;
    $("hoja-contexto").textContent = nombreDe(contexto.nombre);
    if (cambia) { ponerFondo(p); aplicarColores(p); }
    marcarActiva();
    pintarFav();
    document.title = p.artista ? `${p.titulo} · ${p.artista}` : p.titulo;
    sesionMedia(p);
    ponerProgreso(0, p.duracion || 0);
    if (!$("cola-vista").hidden) pintarCola();
    if (!$("letra-vista").hidden) mostrarLetra();
  }

  function siguiente(porFin = false) {
    direccion = 1;
    if (colaUsuario.length) return reproducir(colaUsuario.shift());
    if (!orden.length) return;
    let n = pos + 1;
    if (n >= orden.length) {
      if (repite === "todo" || !porFin) {
        if (mezcla) orden = barajar(orden.filter((x) => x !== actual)).concat(actual ? [actual] : []);
        n = 0;
      } else {                                   // fin de la lista
        audio.pause();
        audio.currentTime = 0;
        return;
      }
    }
    reproducir(orden[n]);
  }

  function anterior() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    direccion = -1;
    if (historial.length) return reproducir(historial.pop(), { sinHistorial: true });
    if (!orden.length) return;
    reproducir(orden[(pos - 1 + orden.length) % orden.length], { sinHistorial: true });
  }

  // ---- fundidos: al pausar baja el volumen en vez de cortar en seco (iOS no deja tocar el volumen: corta)
  let rampaT = 0;
  const cancelarRampa = () => clearInterval(rampaT);
  function rampa(objetivo, ms) {
    return new Promise((res) => {
      cancelarRampa();
      const v0 = audio.volume, t0 = performance.now();
      rampaT = setInterval(() => {
        const f = Math.min(1, (performance.now() - t0) / ms);
        audio.volume = Math.max(0, Math.min(1, v0 + (objetivo - v0) * f));
        if (f >= 1) { cancelarRampa(); res(); }
      }, 16);
    });
  }
  const conFundidos = () => estado.fundidos !== false && !document.hidden;
  async function pausar() {
    if (!conFundidos()) return audio.pause();
    await rampa(0, 240);
    audio.pause();
    audio.volume = 1;
  }
  function sonar() {
    cancelarRampa();
    if (conFundidos()) audio.volume = 0;
    audio.play().then(() => { if (conFundidos()) rampa(1, 420); else audio.volume = 1; }).catch(() => { audio.volume = 1; });
  }
  function alternar() {
    if (!actual) {
      const lib = ordenar(principal(), estado.orden || "recientes");
      if (!lib.length) return;
      return reproducirDesde(lib.map((p) => p.id), null, { k: "tuMusica" });
    }
    if (audio.paused) sonar(); else pausar();
  }

  // ---- progreso
  let arrastrando = false;
  function ponerProgreso(tt, total) {
    const f = total > 0 ? Math.min(1, tt / total) : 0;
    const pct = (f * 100).toFixed(2) + "%";
    $("relleno").style.setProperty("--avance", pct);
    $("mini-avance").style.setProperty("--avance", pct);
    $("t-actual").textContent = mm(tt);
    $("t-resta").textContent = total > 0 ? "-" + mm(total - tt) : "";
    $("progreso").setAttribute("aria-valuenow", Math.round(f * 100));
  }
  const duracionReal = () =>
    isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (porId.get(actual)?.duracion || 0);

  let ultimoGuardado = 0;
  audio.addEventListener("timeupdate", () => {
    if (!arrastrando) ponerProgreso(audio.currentTime, duracionReal());
    contarTiempo();
    const ahora = Date.now();
    if (ahora - ultimoGuardado > 5000 && actual) {
      ultimoGuardado = ahora;
      guardarEstado({ id: actual, t: audio.currentTime });
    }
    // cuenta como escuchada al pasar de 30 s (o de la mitad, si es corta)
    if (!contada && actual && audio.currentTime > Math.min(30, duracionReal() * 0.5 || 30)) {
      contada = true;
      const e = escuchas[actual] || (escuchas[actual] = { n: 0 });
      e.n++;
      e.u = Date.now();
      almacen.poner("escuchas", escuchas);
    }
  });
  let fallosSeguidos = 0;
  audio.addEventListener("loadedmetadata", () => {
    fallosSeguidos = 0;
    ponerProgreso(audio.currentTime, duracionReal());
    posicionMedia();
  });

  const prog = $("progreso");
  const fraccionEn = (x) => {
    const r = prog.querySelector(".progreso-pista").getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  let decimaTocada = -1;
  const moverProgreso = (x) => {
    const total = duracionReal(), f = fraccionEn(x);
    ponerProgreso(f * total, total);
    const decima = Math.floor(f * 10);                 // un toquecito cada 10 %
    if (decima !== decimaTocada) { if (decimaTocada >= 0) haptica("suave"); decimaTocada = decima; }
  };
  prog.addEventListener("pointerdown", (e) => {
    if (e.button || !actual) return;
    arrastrando = true;
    decimaTocada = -1;
    prog.setPointerCapture(e.pointerId);
    prog.classList.add("tocando");
    haptica("suave");
    moverProgreso(e.clientX);
  });
  prog.addEventListener("pointermove", (e) => { if (arrastrando) moverProgreso(e.clientX); });
  const soltarProgreso = (e) => {
    if (!arrastrando) return;
    const total = duracionReal();
    if (total > 0 && e.type === "pointerup") audio.currentTime = fraccionEn(e.clientX) * total;
    arrastrando = false;
    prog.classList.remove("tocando");
    posicionMedia();
    if (!$("letra-vista").hidden) { usuarioMueveHasta = 0; sincronizarLetra(true); }
  };
  prog.addEventListener("pointerup", soltarProgreso);
  prog.addEventListener("pointercancel", soltarProgreso);
  prog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { audio.currentTime += 5; e.preventDefault(); e.stopPropagation(); }
    if (e.key === "ArrowLeft") { audio.currentTime -= 5; e.preventDefault(); e.stopPropagation(); }
  });

  // ---- sonido
  const iconos = (suena) => {
    const href = suena ? "#i-pausa" : "#i-play";
    for (const id of ["mini-play", "btn-play"]) $(id).querySelector("use").setAttribute("href", href);
    document.body.classList.toggle("suena", suena);
  };
  audio.addEventListener("play", () => {
    if (muestraId) pararMuestra(false);
    iconos(true);
    relojEscucha = performance.now();
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    if (!$("letra-vista").hidden && capaAbierta("hoja")) pantallaEncendida(true);
  });
  audio.addEventListener("pause", () => {
    contarTiempo();
    relojEscucha = 0;
    guardarTiempo();
    iconos(false);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    if (actual) guardarEstado({ id: actual, t: audio.currentTime });
    pantallaEncendida(false);
  });
  audio.addEventListener("ended", () => {
    if (sueno && sueno.cancion) { quitarSueno(); return; }
    if (repite === "uno") { audio.currentTime = 0; audio.play(); }
    else siguiente(true);
  });
  audio.addEventListener("error", () => {
    // un mp3 estropeado no debe dejar la música parada: se pasa a la siguiente
    if (!audio.getAttribute("src")) return;
    if (orden.length > 1 && ++fallosSeguidos < orden.length) siguiente();
  });

  // ---- mandos
  const pulsar = (id, f, tipo = "toque") => $(id).addEventListener("click", () => { haptica(tipo); f(); });
  pulsar("mini-play", alternar, "medio");
  pulsar("btn-play", alternar, "medio");
  pulsar("mini-sig", () => siguiente());
  pulsar("btn-sig", () => { empujon("btn-sig", "empuja-dcha"); siguiente(); });
  pulsar("btn-ant", () => { empujon("btn-ant", "empuja-izq"); anterior(); });
  function empujon(id, clase) {
    const b = $(id);
    b.classList.remove(clase); void b.offsetWidth; b.classList.add(clase);
  }

  function pintarModos() {
    $("btn-mezcla").setAttribute("aria-pressed", String(mezcla));
    const r = $("btn-repite");
    r.setAttribute("aria-pressed", String(repite !== "no"));
    r.dataset.modo = repite;
  }
  pulsar("btn-mezcla", () => {
    mezcla = !mezcla;
    if (actual) construirOrden(actual);
    pintarModos();
    guardarEstado({ mezcla });
    aviso(mezcla ? t("aleatorioSi") : t("aleatorioNo"));
    if (!$("cola-vista").hidden) pintarCola();
  });
  pulsar("btn-repite", () => {
    repite = { no: "todo", todo: "uno", uno: "no" }[repite];
    pintarModos();
    guardarEstado({ repite });
    aviso(t("repite_" + repite));
  });

  function pintarFav() {
    const b = $("btn-fav");
    const si = favoritas.has(actual);
    b.setAttribute("aria-pressed", String(si));
    b.querySelector("use").setAttribute("href", si ? "#i-corazon" : "#i-corazon-v");
  }
  $("btn-fav").addEventListener("click", () => actual && alternarFav(actual));

  // ============================================================ HOJA "AHORA SUENA"
  const hoja = $("hoja");
  const rectDe = (el, radio) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, radio };
  };
  // la portada vuela del mini al reproductor (y de vuelta): se pinta al tamaño grande y se escala, así no se ve borrosa
  function volarPortada(de, a) {
    return new Promise((res) => {
      if (movimientoReducido() || !de.width || !a.width) return res();
      const p = porId.get(actual);
      const u = p && urlPortada(p);
      const g = de.width >= a.width ? de : a;
      const c = nodo("div", "portada-voladora");
      Object.assign(c.style, {
        left: g.left + "px", top: g.top + "px", width: g.width + "px", height: g.height + "px",
        backgroundImage: u ? `url("${u}")` : `linear-gradient(145deg, hsl(${tono(actual)} 70% 62%), hsl(${tono(actual) + 40} 65% 34%))`,
      });
      document.body.append(c);
      const tr = (r) => `translate(${r.left - g.left}px, ${r.top - g.top}px) scale(${r.width / g.width})`;
      const rad = (r) => (r.radio * g.width) / r.width;           // el radio también se escala
      const anim = c.animate(
        [{ transform: tr(de), borderRadius: rad(de) + "px" }, { transform: tr(a), borderRadius: rad(a) + "px" }],
        { duration: 540, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" });
      anim.finished.then(() => { c.remove(); res(); }, () => { c.remove(); res(); });
    });
  }
  function abrirHoja() {
    if (!actual || capaAbierta("hoja")) return;
    const mini = $("mini-portada"), grande = $("grande-portada");
    const de = rectDe(mini, 12);
    const rg = grande.getBoundingClientRect(), rh = hoja.getBoundingClientRect();
    const escala = grande.offsetWidth ? rg.width / grande.offsetWidth : 1;
    const a = { left: rg.left, top: rg.top - rh.top, width: rg.width, height: rg.height, radio: 26 * escala };
    const vuela = rg.width > 0 && !$("mini").hidden;
    if (vuela) { grande.style.visibility = "hidden"; mini.style.visibility = "hidden"; }
    hoja.classList.add("abierta");
    hoja.setAttribute("aria-hidden", "false");
    document.body.classList.add("hoja-abierta");
    abrirCapa("hoja", soltarHoja);
    haptica("medio");
    if (vuela) volarPortada(de, a).then(() => { grande.style.visibility = ""; mini.style.visibility = ""; });
    if (!$("letra-vista").hidden) { mostrarLetra(); arrancarBucleLetra(); if (!audio.paused) pantallaEncendida(true); }
  }
  function soltarHoja() {
    const mini = $("mini-portada"), grande = $("grande-portada");
    const de = rectDe(grande, 26 * (grande.offsetWidth ? grande.getBoundingClientRect().width / grande.offsetWidth : 1));
    const vuela = de.width > 0 && !$("mini").hidden && grande.offsetParent;
    hoja.classList.remove("abierta", "siguiendo");
    hoja.style.transform = "";
    hoja.setAttribute("aria-hidden", "true");
    document.body.classList.remove("hoja-abierta");
    pararBucleLetra();
    pantallaEncendida(false);
    if (vuela) {
      grande.style.visibility = "hidden";
      mini.style.visibility = "hidden";
      volarPortada(de, rectDe(mini, 12)).then(() => { grande.style.visibility = ""; mini.style.visibility = ""; });
    }
  }
  $("hoja-cerrar").addEventListener("click", () => { haptica(); cerrarHasta("hoja"); });
  $("hoja-mas").addEventListener("click", () => { haptica(); actual && menuCancion(actual); });
  $("grande-artista").addEventListener("click", () => {
    const p = porId.get(actual);
    if (p && p.artista) irAArtista(p.artista);
  });

  // arrastrar la hoja hacia abajo la cierra
  const bajarHoja = {
    vertical: (dy) => { hoja.classList.add("siguiendo"); hoja.style.transform = `translateY(${Math.max(0, dy)}px)`; },
    suelta: (dy, v) => {
      hoja.classList.remove("siguiendo");
      if (dy > 130 || v > 0.6) { cerrarHasta("hoja"); return; }
      hoja.style.transform = "";
    },
  };
  arrastre($("hoja-agarre"), bajarHoja);

  // la portada: abajo cierra, a los lados cambia de canción, doble toque = favorita
  let ultimoToque = 0;
  const portadaGrande = $("grande-portada");
  arrastre($("escenario"), {
    empieza: (e) => !e.target.closest(".panel-vista"),
    vertical: bajarHoja.vertical,
    horizontal: (dx) => {
      portadaGrande.classList.add("siguiendo");
      portadaGrande.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`;
      portadaGrande.style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 500));
    },
    suelta: (d, v, modo) => {
      if (modo === "v") return bajarHoja.suelta(d, v);
      portadaGrande.classList.remove("siguiendo");
      portadaGrande.style.transform = portadaGrande.style.opacity = "";
      if (Math.abs(d) > 80 || Math.abs(v) > 0.5) {
        haptica("medio");
        if (d < 0) siguiente(); else anterior();
      }
    },
    toque: () => {
      const ahora = Date.now();
      if (ahora - ultimoToque < 320 && actual) {
        ultimoToque = 0;
        if (!favoritas.has(actual)) alternarFav(actual); else haptica("medio");
        const e = $("estallido");
        e.classList.remove("va"); void e.getBoundingClientRect(); e.classList.add("va");
      } else ultimoToque = ahora;
    },
  });

  // mini: tocar abre, arriba abre, a los lados cambia de canción
  const miniToque = $("mini-abrir");
  miniToque.addEventListener("click", abrirHoja);
  miniToque.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrirHoja(); } });
  arrastre(miniToque, {
    vertical: () => {},
    horizontal: (dx) => {
      const tx = miniToque.querySelector(".textos");
      tx.style.transform = `translateX(${dx}px)`;
      tx.style.opacity = String(1 - Math.min(0.8, Math.abs(dx) / 160));
    },
    suelta: (d, v, modo) => {
      const tx = miniToque.querySelector(".textos");
      tx.style.transform = tx.style.opacity = "";
      if (modo === "v") { if (d < -30 || v < -0.4) abrirHoja(); return; }
      if (Math.abs(d) > 60 || Math.abs(v) > 0.5) { haptica("medio"); if (d < 0) siguiente(); else anterior(); }
    },
  });

  // ---- paneles del reproductor: cola o letra en el sitio de la portada
  function verPanel(cual) {
    const abierto = $("cola-vista").hidden ? ($("letra-vista").hidden ? null : "letra") : "cola";
    if (cual === abierto) cual = null;
    $("cola-vista").hidden = cual !== "cola";
    $("letra-vista").hidden = cual !== "letra";
    $("escenario").classList.toggle("con-panel", !!cual);
    $("btn-cola").setAttribute("aria-pressed", String(cual === "cola"));
    $("btn-letra").setAttribute("aria-pressed", String(cual === "letra"));
    if (cual === "cola") { pintarCola(); $("cola-vista").scrollTop = 0; }
    if (cual === "letra") {
      mostrarLetra();
      arrancarBucleLetra();
      if (!audio.paused) pantallaEncendida(true);
    } else {
      pararBucleLetra();
      pantallaEncendida(false);
    }
  }
  pulsar("btn-cola", () => verPanel("cola"));
  pulsar("btn-letra", () => verPanel("letra"));

  // ---- cola ("a continuación")
  function filaCola(p, clase, quitar) {
    const li = nodo("li", "cola-item " + (clase || ""));
    li.dataset.id = p.id;
    const tx = nodo("span", "textos");
    tx.append(nodo("b", "", p.titulo), nodo("small", "", p.artista || "—"));
    li.append(portadaPista(p), tx);
    if (quitar) {
      const x = nodo("button", "mas");
      x.setAttribute("aria-label", t("quitarDeLaCola"));
      x.innerHTML = icono("i-x");
      x.dataset.quitar = quitar;
      li.append(x);
    }
    return li;
  }
  function pintarCola() {
    const ul = $("cola-lista");
    ul.textContent = "";
    const p = porId.get(actual);
    if (!p) return;
    const titulo = (texto, sub) => {
      const h = nodo("li", "cola-titulo", texto);
      if (sub) h.append(nodo("small", "", sub));
      return h;
    };
    ul.append(titulo(t("sonandoAhora")), filaCola(p, "ahora"));
    if (colaUsuario.length) {
      ul.append(titulo(t("enTuCola"), t("nCanciones", colaUsuario.length)));
      colaUsuario.forEach((id, i) => { const q = porId.get(id); if (q) ul.append(filaCola(q, "", "u" + i)); });
    }
    let resto = orden.slice(pos + 1);
    if (repite === "todo") resto = resto.concat(orden.slice(0, Math.max(0, pos)));
    if (resto.length) {
      ul.append(titulo(t("aContinuacion"), `${t("de")} ${nombreDe(contexto.nombre)}${mezcla ? " · " + t("aleatorio").toLowerCase() : ""}`));
      resto.slice(0, 80).forEach((id) => { const q = porId.get(id); if (q) ul.append(filaCola(q)); });
    } else if (!colaUsuario.length) {
      ul.append(nodo("li", "cola-titulo", repite === "uno" ? t("seRepiteEsta") : t("colaVacia")));
    }
  }
  $("cola-lista").addEventListener("click", (e) => {
    const x = e.target.closest("[data-quitar]");
    if (x) {
      colaUsuario.splice(Number(x.dataset.quitar.slice(1)), 1);
      haptica("suave");
      return pintarCola();
    }
    const li = e.target.closest(".cola-item");
    if (!li || li.classList.contains("ahora")) return;
    haptica("suave");
    const id = li.dataset.id;
    const enCola = colaUsuario.indexOf(id);
    if (enCola >= 0) colaUsuario.splice(enCola, 1);
    reproducir(id);
  });

  // ============================================================ LETRA
  // De LRCLIB (gratis, abierta). Si viene sincronizada, la línea que suena se
  // ilumina y la vista la sigue; tocar una línea salta a ese momento.
  let letra = null;                    // { id, lineas:[{t, texto}] | null }
  let lineaActual = -1;
  let usuarioMueveHasta = 0;
  const vistaLetra = $("letra-vista");
  function parsearLrc(texto) {
    const out = [];
    for (const linea of String(texto).split(/\r?\n/)) {
      const marcas = [...linea.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!marcas.length) continue;
      const frase = linea.replace(/\[[^\]]*\]/g, "").trim();
      for (const m of marcas) out.push({ t: Number(m[1]) * 60 + Number(m[2]), texto: frase });
    }
    return out.sort((a, b) => a.t - b.t);
  }
  async function letraDirecta(artista, titulo, duracion) {
    const base = "https://lrclib.net/api/";
    const q = new URLSearchParams({ artist_name: artista, track_name: titulo });
    if (duracion) q.set("duration", Math.round(duracion));
    let r = await fetch(base + "get?" + q);
    if (r.ok) { const d = await r.json(); return { sincronizada: d.syncedLyrics, normal: d.plainLyrics, instrumental: d.instrumental }; }
    if (r.status !== 404) throw new Error("red");
    r = await fetch(base + "search?" + new URLSearchParams({ artist_name: artista, track_name: titulo }));
    const lista = r.ok ? await r.json() : [];
    const mejor = lista.filter((c) => c.syncedLyrics || c.plainLyrics || c.instrumental)
      .sort((a, b) => (!a.syncedLyrics - !b.syncedLyrics) || Math.abs((a.duration || 0) - (duracion || 0)) - Math.abs((b.duration || 0) - (duracion || 0)))[0];
    return mejor ? { sincronizada: mejor.syncedLyrics, normal: mejor.plainLyrics, instrumental: mejor.instrumental } : {};
  }
  async function pedirLetra(p) {
    const g = letras[p.id];
    if (g && (g.s || g.p || g.i || Date.now() - g.f < 3 * 864e5)) return g;   // "no hay" se vuelve a mirar a los 3 días
    const artista = artistaPrincipal(p.artista) || p.artista, titulo = limpiarTitulo(p.titulo) || p.titulo;
    let d;
    if (servidor) {
      const r = await fetch("api/letra?" + new URLSearchParams({ artista, titulo, duracion: p.duracion || "" }));
      if (!r.ok) throw new Error("red");
      d = await r.json();
    } else d = await letraDirecta(artista, titulo, p.duracion);
    const res = { s: d.sincronizada || "", p: d.normal || "", i: !!d.instrumental, f: Date.now() };
    letras[p.id] = res;
    const claves = Object.keys(letras);
    if (claves.length > 150) claves.sort((a, b) => letras[a].f - letras[b].f).slice(0, claves.length - 150).forEach((k) => delete letras[k]);
    almacen.poner("letras", letras);
    return res;
  }
  async function mostrarLetra() {
    const p = porId.get(actual);
    if (!p) return;
    const cont = $("letra");
    if (letra && letra.id === p.id) return sincronizarLetra(true);
    letra = { id: p.id, cargando: true };
    lineaActual = -1;
    cont.className = "";
    cont.innerHTML = `<p class="letra-aviso cargando">${t("buscandoLetra")}</p>`;
    let d;
    try { d = await pedirLetra(p); } catch (_) {
      if (letra && letra.id === p.id) { cont.innerHTML = `<p class="letra-aviso">${t("letraSinConexion")}</p>`; letra = null; }
      return;
    }
    if (actual !== p.id || !letra || letra.id !== p.id) return;
    const lineas = d.s ? parsearLrc(d.s) : null;
    letra = { id: p.id, lineas: lineas && lineas.length ? lineas : null };
    cont.textContent = "";
    if (letra.lineas) {
      letra.lineas.forEach((l, i) => {
        const e = nodo("p", "linea" + (l.texto ? "" : " pausa"), l.texto || "• • •");
        e.dataset.i = i;
        cont.append(e);
      });
      cont.append(nodo("p", "letra-fuente", t("letraFuente")));
      vistaLetra.scrollTop = 0;
      sincronizarLetra(true);
    } else if (d.p) {
      cont.classList.add("normal");
      d.p.split(/\n/).forEach((l) => cont.append(nodo("p", "linea", l || " ")));
      cont.append(nodo("p", "letra-fuente", t("letraFuente")));
      vistaLetra.scrollTop = 0;
    } else {
      cont.innerHTML = `<p class="letra-aviso">${d.i ? t("instrumental") : t("sinLetra")}</p>`;
    }
  }
  function sincronizarLetra(salto = false) {
    if (!letra || !letra.lineas || vistaLetra.hidden) return;
    const ahora = audio.currentTime + 0.25;
    let i = lineaActual;
    if (i < 0 || i >= letra.lineas.length || letra.lineas[i].t > ahora) i = -1;
    while (i + 1 < letra.lineas.length && letra.lineas[i + 1].t <= ahora) i++;
    if (i === lineaActual && !salto) return;
    lineaActual = i;
    const ps = $("letra").querySelectorAll(".linea");
    ps.forEach((e, k) => { e.classList.toggle("actual", k === i); e.classList.toggle("pasada", k < i); });
    if (Date.now() < usuarioMueveHasta) return;
    const objetivo = ps[Math.max(0, i)];
    if (objetivo) vistaLetra.scrollTo({ top: objetivo.offsetTop - vistaLetra.clientHeight * 0.3, behavior: salto || movimientoReducido() ? "auto" : "smooth" });
  }
  let bucleLetra = 0;
  function arrancarBucleLetra() {
    cancelAnimationFrame(bucleLetra);
    const paso = () => { sincronizarLetra(); bucleLetra = requestAnimationFrame(paso); };
    bucleLetra = requestAnimationFrame(paso);
  }
  const pararBucleLetra = () => cancelAnimationFrame(bucleLetra);
  ["touchstart", "wheel"].forEach((ev) => vistaLetra.addEventListener(ev, () => { usuarioMueveHasta = Date.now() + 4000; }, { passive: true }));
  $("letra").addEventListener("click", (e) => {
    const l = e.target.closest(".linea");
    if (!l || !letra || !letra.lineas || l.dataset.i == null) return;
    haptica("suave");
    audio.currentTime = letra.lineas[Number(l.dataset.i)].t;
    usuarioMueveHasta = 0;
    if (audio.paused) sonar();
    sincronizarLetra(true);
  });

  // con la letra delante, que el móvil no apague la pantalla
  let candado = null;
  async function pantallaEncendida(si) {
    try {
      if (si && estado.despierta !== false && "wakeLock" in navigator && !candado) {
        candado = await navigator.wakeLock.request("screen");
        candado.addEventListener("release", () => { candado = null; });
      } else if (!si && candado) {
        const c = candado;
        candado = null;
        await c.release();
      }
    } catch (_) { candado = null; }
  }

  // ============================================================ TEMPORIZADOR
  let sueno = null;                   // { fin } o { cancion: true }
  let relojSueno = 0;
  function pintarSueno() {
    const b = $("btn-sueno");
    b.classList.toggle("activo", !!sueno);
    $("sueno-texto").textContent = !sueno ? "" : sueno.cancion ? t("alAcabar") : mm((sueno.fin - Date.now()) / 1000);
  }
  function quitarSueno(parar = true) {
    clearInterval(relojSueno);
    if (parar && sueno) fundirYParar();
    sueno = null;
    pintarSueno();
  }
  function fundirYParar() {
    rampa(0, 8000).then(() => { audio.pause(); audio.volume = 1; });
  }
  function ponerSueno(min) {
    clearInterval(relojSueno);
    sueno = min === "cancion" ? { cancion: true } : { fin: Date.now() + min * 60000 };
    if (!sueno.cancion) {
      relojSueno = setInterval(() => {
        if (Date.now() >= sueno.fin) quitarSueno(true); else pintarSueno();
      }, 1000);
    }
    pintarSueno();
    haptica("exito");
    aviso(sueno.cancion ? t("pararaAlAcabar") : t("pararaEn", min));
  }
  pulsar("btn-sueno", () => {
    const op = (m, texto) => ({ icono: "i-reloj", texto, accion: () => ponerSueno(m) });
    abrirMenu({
      cabeza: { titulo: t("pararLaMusica") },
      acciones: [
        sueno && { icono: "i-x", texto: t("quitarTemporizador"), accion: () => { quitarSueno(false); aviso(t("temporizadorQuitado")); } },
        op(15, t("enMin", 15)), op(30, t("enMin", 30)), op(45, t("enMin", 45)), op(60, t("enUnaHora")),
        actual && { icono: "i-musica", texto: t("alAcabarEsta"), accion: () => ponerSueno("cancion") },
      ],
    });
  });

  // ============================================================ DESCUBRIR
  // La API pública de Deezer da artistas parecidos, sus canciones más oídas, las
  // portadas buenas y una muestra de 30 s. Con servidor va por /api/deezer (con
  // caché); sin él, por JSONP, que Deezer admite y no choca con CORS.
  let jsonpN = 0;
  function jsonp(ruta) {
    return new Promise((res, rej) => {
      const cb = "_dz" + (++jsonpN);
      const s = document.createElement("script");
      const fin = () => { delete window[cb]; s.remove(); clearTimeout(tt); };
      window[cb] = (d) => { fin(); res(d); };
      s.onerror = () => { fin(); rej(new Error("red")); };
      const tt = setTimeout(() => { fin(); rej(new Error("tiempo")); }, 12000);
      s.src = `https://api.deezer.com${ruta}${ruta.includes("?") ? "&" : "?"}output=jsonp&callback=${cb}`;
      document.head.append(s);
    });
  }
  const dz = (() => {
    const cache = new Map();
    let ocupados = 0;
    const espera = [];
    const turno = () => new Promise((r) => { if (ocupados < 4) { ocupados++; r(); } else espera.push(r); });
    const libre = () => { const r = espera.shift(); if (r) r(); else ocupados--; };
    async function crudo(ruta) {
      if (servidor) return (await fetch("api/deezer?p=" + encodeURIComponent(ruta))).json();
      return jsonp(ruta);
    }
    return function pedir(ruta, { fresco = false } = {}) {
      if (!fresco && cache.has(ruta)) return cache.get(ruta);
      const p = (async () => {
        for (let intento = 0; intento < 4; intento++) {
          await turno();
          let d;
          try { d = await crudo(ruta); } finally { libre(); }
          if (d && d.error) {
            if (d.error.code === 4 || d.error.code === 700) { await dormir(1100 * (intento + 1)); continue; }   // límite de Deezer
            throw new Error(d.error.message || "Deezer");
          }
          return d;
        }
        throw new Error("Deezer");
      })();
      if (!fresco) { cache.set(ruta, p); p.catch(() => cache.delete(ruta)); }
      return p;
    };
  })();

  async function artistaDz(nombre) {
    const k = norm(nombre);
    if (k in artistasDz) return artistasDz[k];
    const d = await dz(`/search/artist?q=${encodeURIComponent(nombre)}&limit=10`);
    // con el mismo nombre suele haber perfiles duplicados: el bueno es el que más seguidores tiene
    const a = (d.data || []).filter((x) => norm(x.name) === k).sort((x, y) => (y.nb_fan || 0) - (x.nb_fan || 0))[0] || null;
    artistasDz[k] = a ? { id: a.id, m: a.picture_medium, b: a.picture_big } : null;
    almacen.poner("artistasdz", artistasDz);
    return artistasDz[k];
  }

  const deTrack = (tr) => ({
    id: "dz" + tr.id,
    deezer: tr.id,
    titulo: tr.title || tr.title_short || "",
    artista: (tr.artist && tr.artist.name) || "",
    album: (tr.album && tr.album.title) || "",
    portada: (tr.album && (tr.album.cover_xl || tr.album.cover_big)) || "",
    mini: (tr.album && (tr.album.cover_medium || tr.album.cover)) || "",
    duracion: tr.duration || 0,
    explicita: !!tr.explicit_lyrics,
  });

  // ¿esta canción ya está en tu música? por id de Deezer o por título y artista parecidos
  function indiceBiblioteca() {
    const ids = new Set();
    const titulos = new Map();
    for (const p of pistas) {
      if (p.deezer) ids.add(p.deezer);
      const k = normTitulo(p.titulo);
      if (!titulos.has(k)) titulos.set(k, []);
      titulos.get(k).push(norm(p.artista));
    }
    return (deezer, titulo, artista) => {
      if (ids.has(deezer)) return true;
      const arts = titulos.get(normTitulo(titulo));
      if (!arts) return false;
      const a = norm(artista);
      return arts.some((x) => !x || !a || x.includes(a) || a.includes(x));
    };
  }

  // de qué artistas tirar: los que más tienes, más escuchas y más marcas como favoritas
  function semillas(max) {
    const pesos = new Map();
    const reciente = Date.now() / 1000 - 21 * 86400;
    for (const p of pistas) {
      const nombre = artistaPrincipal(p.artista);
      if (!nombre) continue;
      const k = norm(nombre);
      const e = escuchas[p.id] || {};
      const w = 1 + (e.n || 0) * 0.6 + (e.s || 0) / 600 + (favoritas.has(p.id) ? 2.5 : 0) + (p.orden > reciente ? 0.8 : 0);
      const x = pesos.get(k) || { nombre, w: 0 };
      x.w += w;
      pesos.set(k, x);
    }
    const bolsa = [...pesos.values()];
    const elegidas = [];
    while (elegidas.length < max && bolsa.length) {
      const total = bolsa.reduce((s, x) => s + x.w, 0);
      let r = Math.random() * total, i = 0;
      while (r > bolsa[i].w && i < bolsa.length - 1) r -= bolsa[i++].w;
      elegidas.push(bolsa.splice(i, 1)[0]);
    }
    return { elegidas, conocidos: new Set(pesos.keys()) };
  }

  async function recomendar({ silencioso = false } = {}) {
    if (generando) return;
    generando = true;
    const pant = $("p-descubrir");
    pant.classList.add("generando");
    $("btn-recomendar").querySelector("span").textContent = t("buscando");
    if (!silencioso || pestana === "descubrir") pintarEsqueleto();
    let bien = false;
    try {
      const enBiblioteca = indiceBiblioteca();
      const vetadas = new Set([...descartadas, ...pedidos.map((p) => p.deezer)]);
      const usadas = new Set();
      const valida = (tr) => tr && tr.id && tr.readable !== false && !usadas.has(tr.id) && !vetadas.has(tr.id)
        && tr.duration >= 60 && tr.duration <= 900 && !(estado.sinExplicitas && tr.explicit_lyrics)
        && !enBiblioteca(tr.id, tr.title, tr.artist && tr.artist.name);
      const tomar = (lista, n) => {
        const out = [];
        for (const tr of lista) {
          if (out.length >= n) break;
          if (valida(tr)) { usadas.add(tr.id); out.push(deTrack(tr)); }
        }
        return out;
      };
      const grupos = [];
      const { elegidas, conocidos } = semillas(6);
      if (!elegidas.length) {
        const top = (await dz("/chart/0/tracks?limit=80")).data || [];
        const items = tomar(barajar(top), 24);
        if (items.length) grupos.push({ tituloK: "loMasEscuchado", subK: "paraEmpezar", items });
      } else {
        const res = await Promise.all(elegidas.map(async (s) => {
          try {
            const a = await artistaDz(s.nombre);
            if (!a) return null;
            const [rel, suyos] = await Promise.all([dz(`/artist/${a.id}/related?limit=25`), dz(`/artist/${a.id}/top?limit=25`)]);
            const nuevos = barajar((rel.data || []).filter((r) => !conocidos.has(norm(r.name))).slice(0, 12)).slice(0, 4);
            const tops = await Promise.all(nuevos.map((r) => dz(`/artist/${r.id}/top?limit=10`).then((d) => d.data || []).catch(() => [])));
            return { s, a, suyos: suyos.data || [], tops };
          } catch (_) { return null; }
        }));
        for (const r of res) {
          if (!r) continue;
          const items = [];
          for (const top of r.tops) items.push(...tomar(barajar(top.slice(0, 6)), Math.random() < 0.35 ? 2 : 1));
          items.push(...tomar(barajar(r.suyos.slice(0, 15)), items.length < 3 ? 3 : 2));
          if (items.length) grupos.push({ semilla: r.s.nombre, foto: r.a.m, items: barajar(items) });
        }
      }
      if (!grupos.length) throw new Error("sin resultados");
      rec = { fecha: Date.now(), grupos, nuevas: pestana !== "descubrir" };
      almacen.poner("rec", rec);
      bien = true;
    } catch (_) {
      if (!silencioso) { haptica("error"); aviso(navigator.onLine === false ? t("sinConexion") : t("noSeConectoDeezer")); }
    }
    generando = false;
    pant.classList.remove("generando");
    pintarRecs({ animar: bien });
    pintarGlobo();
    if (bien && !silencioso) haptica("exito");
  }
  $("btn-recomendar").addEventListener("click", () => { haptica("medio"); recomendar(); });

  function quizaRecomendar() {
    const dias = estado.frecuencia ?? 3;
    if (!dias || generando || navigator.onLine === false) return;
    if (!rec.fecha || Date.now() - rec.fecha > dias * 864e5) recomendar({ silencioso: true });
  }

  function pintarEsqueleto(cont = $("recs"), n = 6) {
    cont.textContent = "";
    const ul = cont.tagName === "UL" ? cont : cont.appendChild(nodo("ul", "lista-recs"));
    for (let i = 0; i < n; i++) {
      const li = nodo("li", "rec esqueleto");
      li.innerHTML = '<i class="e-portada"></i><span><i class="e-linea"></i><i class="e-linea corta"></i></span><span></span><i class="e-boton"></i>';
      ul.append(li);
    }
  }

  const visibles = new Map();                 // id -> item de Deezer pintado ahora mismo
  const estadoPedido = (id) => pedidos.find((p) => p.id === id);

  function filaRec(item, i, enBiblioteca, animar) {
    visibles.set(item.id, item);
    const ped = estadoPedido(item.id);
    const dentro = enBiblioteca(item.deezer, item.titulo, item.artista) || (ped && ped.estado === "hecho");
    const li = nodo("li", "rec" + (animar ? " entra" : "") + (dentro ? " en-biblioteca" : ped ? " anadida" : ""));
    li.dataset.id = item.id;
    li.style.setProperty("--n", i);
    const b = nodo("button", "rec-portada");
    b.setAttribute("aria-label", t("escucharTrozo", item.titulo));
    b.append(portada(item.id, item.mini || item.portada));
    b.insertAdjacentHTML("beforeend", `<span class="icono-muestra">${icono("i-play")}</span><svg class="rec-anillo" viewBox="0 0 48 48"><circle cx="24" cy="24" r="23"/></svg>`);
    const tx = nodo("span", "textos");
    const album = normTitulo(item.album) === normTitulo(item.titulo) ? "" : item.album;   // sencillos: el disco se llama igual
    const titulo = nodo("b", "", item.titulo);
    const sub = nodo("small");
    if (item.explicita) sub.append(nodo("span", "explicita", "E"));
    sub.append(document.createTextNode([item.artista, album].filter(Boolean).join(" · ")));
    tx.append(titulo, sub);
    li.append(b, tx);
    if (dentro) {
      li.append(nodo("span", "etiqueta", t("enTuMusica")), nodo("span"));
    } else {
      const x = nodo("button", "rec-quitar");
      x.setAttribute("aria-label", t("noMeInteresa"));
      x.innerHTML = icono("i-x");
      const mas = nodo("button", "rec-anadir");
      mas.setAttribute("aria-label", t("anadir"));
      mas.innerHTML = icono(ped ? "i-check" : "i-plus");
      li.append(x, mas);
    }
    return li;
  }

  function pintarRecs({ animar = false } = {}) {
    const cont = $("recs");
    pintarInfoRec();
    if (generando) return;
    cont.textContent = "";
    const enBiblioteca = indiceBiblioteca();
    const grupos = (rec.grupos || []).map((g) => ({
      ...g, items: g.items.filter((it) => !descartadas.has(it.deezer) && !(estado.sinExplicitas && it.explicita)),
    })).filter((g) => g.items.length);
    if (!grupos.length) {
      cont.innerHTML = `<p class="desc-vacio">${rec.fecha ? t("yaRevisadoTodo") : t("pulsaRecomendar")}<br>${t("tambienBuscar")}</p>`;
      return;
    }
    let n = 0;
    for (const g of grupos) {
      const div = nodo("div", "grupo-rec");
      const cab = nodo("div", "grupo-cabeza");
      const textos = nodo("div");
      if (g.semilla) {
        cab.append(portada(g.semilla, g.foto));
        textos.append(nodo("small", "", t("porqueEscuchas")), nodo("b", "", g.semilla));
      } else {
        textos.append(nodo("small", "", g.subK ? t(g.subK) : ""), nodo("b", "", g.tituloK ? t(g.tituloK) : ""));
      }
      cab.append(textos);
      const ul = nodo("ul", "lista-recs");
      g.items.forEach((it) => ul.append(filaRec(it, n++, enBiblioteca, animar)));
      div.append(cab, ul);
      cont.append(div);
    }
  }
  function pintarInfoRec() {
    const dias = estado.frecuencia ?? 3;
    const cuando = { 1: t("cadaDiaMin"), 3: t("cada3Dias"), 7: t("cadaSemana") }[dias];
    $("rec-info").textContent = rec.fecha
      ? `${t("actualizadas", hace(rec.fecha))}${cuando ? " · " + t("seRenuevan", cuando) : ""}`
      : pistas.length ? t("segunTusArtistas") : t("empiezaConLoMas");
    $("btn-recomendar").querySelector("span").textContent = generando ? t("buscando") : rec.fecha ? t("nuevasRecomendaciones") : t("recomendar");
    const n = pedidos.filter((p) => p.estado !== "hecho").length;
    $("desc-sub").textContent = n ? t("nElegidas", n) : t("elegidasParaTi");
  }

  // tras una descarga o un cambio en la biblioteca, las filas se enteran
  function marcarEnBiblioteca() {
    if (!visibles.size) return;
    const enBiblioteca = indiceBiblioteca();
    document.querySelectorAll(".rec[data-id]").forEach((li) => {
      const it = visibles.get(li.dataset.id);
      if (!it) return;
      const ped = estadoPedido(it.id);
      const dentro = enBiblioteca(it.deezer, it.titulo, it.artista) || (ped && ped.estado === "hecho");
      if (dentro && !li.classList.contains("en-biblioteca")) li.replaceWith(filaRec(it, 0, () => true, false));
      else if (!dentro) {
        li.classList.toggle("anadida", !!ped);
        const b = li.querySelector(".rec-anadir use");
        if (b) b.setAttribute("href", ped ? "#i-check" : "#i-plus");
      }
    });
  }

  // tocar en Descubrir (recomendaciones y resultados de búsqueda)
  function tocarRec(e) {
    const li = e.target.closest(".rec");
    if (!li || li.classList.contains("esqueleto")) return;
    const item = visibles.get(li.dataset.id);
    if (!item) return;
    if (e.target.closest(".rec-portada")) return escucharMuestra(item, li);
    if (e.target.closest(".rec-anadir")) return alternarPedido(item, li);
    if (e.target.closest(".rec-quitar")) return descartar(item, li);
  }
  $("recs").addEventListener("click", tocarRec);
  $("resultados").addEventListener("click", tocarRec);

  function descartar(item, li) {
    haptica("suave");
    descartadas.add(item.deezer);
    almacen.poner("descartadas", [...descartadas].slice(-1000));
    li.classList.add("yendo");
    setTimeout(() => {
      li.remove();
      document.querySelectorAll(".grupo-rec").forEach((g) => { if (!g.querySelector(".rec")) g.remove(); });
    }, 330);
    pintarAjustesDescubrir();
    aviso(t("noVolveraASalir"), () => {
      descartadas.delete(item.deezer);
      almacen.poner("descartadas", [...descartadas]);
      pintarRecs();
      pintarAjustesDescubrir();
    });
  }

  // ---- muestra de 30 s
  let muestraId = null;
  let reanudar = false;
  async function escucharMuestra(item, li) {
    if (muestraId === item.id) return pararMuestra(true);
    const volverLuego = reanudar || !audio.paused;   // al saltar de una muestra a otra no se olvida
    pararMuestra(false);
    reanudar = volverLuego;
    muestraId = item.id;
    li.classList.add("sonando");
    li.querySelector(".icono-muestra use").setAttribute("href", "#i-pausa");
    haptica("suave");
    let url = "";
    try { url = (await dz(`/track/${item.deezer}`, { fresco: true })).preview; } catch (_) {}
    if (muestraId !== item.id) return;
    if (!url) { aviso(t("sinMuestra")); return pararMuestra(true); }
    if (!audio.paused) audio.pause();
    muestra.src = url;
    muestra.play().catch(() => pararMuestra(true));
  }
  function pararMuestra(volver = true) {
    if (!muestraId) return;
    const id = muestraId;
    muestraId = null;
    muestra.pause();
    muestra.removeAttribute("src");
    document.querySelectorAll(`.rec[data-id="${CSS.escape(id)}"]`).forEach((li) => {
      li.classList.remove("sonando");
      li.style.removeProperty("--p");
      const u = li.querySelector(".icono-muestra use");
      if (u) u.setAttribute("href", "#i-play");
    });
    if (volver && reanudar) sonar();
    reanudar = false;
  }
  muestra.addEventListener("timeupdate", () => {
    if (!muestraId) return;
    const f = muestra.duration ? muestra.currentTime / muestra.duration : 0;
    document.querySelectorAll(`.rec[data-id="${CSS.escape(muestraId)}"]`).forEach((li) => li.querySelector(".rec-anillo")?.style.setProperty("--p", f.toFixed(3)));
  });
  muestra.addEventListener("ended", () => pararMuestra(true));

  // ---- buscar cualquier canción
  const buscarDz = $("buscar-dz");
  let busquedaDz = "";
  let esperaBusqueda = 0;
  function buscarEnDeezer(q) {
    buscarDz.value = q || "";
    $("buscar-dz-borrar").hidden = !buscarDz.value;
    lanzarBusqueda();
  }
  function lanzarBusqueda() {
    clearTimeout(esperaBusqueda);
    const q = buscarDz.value.trim();
    busquedaDz = q;
    $("desc-busqueda").hidden = !q;
    $("desc-recs").hidden = !!q;
    if (!q) return;
    $("busqueda-titulo").textContent = t("buscando");
    pintarEsqueleto($("resultados"), 5);
    esperaBusqueda = setTimeout(async () => {
      let d;
      try { d = await dz(`/search?q=${encodeURIComponent(q)}&limit=30`); } catch (_) {
        if (q === busquedaDz) { $("busqueda-titulo").textContent = t("sinConexionDeezer"); $("resultados").textContent = ""; }
        return;
      }
      if (q !== busquedaDz) return;
      const items = (d.data || []).filter((tr) => tr.readable !== false && !(estado.sinExplicitas && tr.explicit_lyrics)).map(deTrack);
      $("busqueda-titulo").textContent = items.length ? t("nResultados", items.length) : t("nadaCon", q);
      const ul = $("resultados");
      ul.textContent = "";
      const enBiblioteca = indiceBiblioteca();
      items.forEach((it, i) => ul.append(filaRec(it, i, enBiblioteca, true)));
    }, 380);
  }
  buscarDz.addEventListener("input", () => { $("buscar-dz-borrar").hidden = !buscarDz.value; lanzarBusqueda(); });
  buscarDz.addEventListener("keydown", (e) => { if (e.key === "Enter") buscarDz.blur(); });
  $("buscar-dz-borrar").addEventListener("click", () => { buscarEnDeezer(""); buscarDz.focus(); });

  // ============================================================ PEDIDOS
  // Lo elegido se guarda al instante: en el servidor (y lo baja un proceso aparte)
  // o, sin servidor, en este dispositivo para enviarlo como lista.
  const activos = () => pedidos.filter((p) => p.estado !== "hecho");
  const guardarLocales = () => { if (!servidor) almacen.poner("pedidos", pedidos); };

  async function alternarPedido(item, li) {
    const ya = estadoPedido(item.id);
    if (ya && ya.estado !== "hecho" && ya.estado !== "descargando") return quitarPedido(item.id);
    if (ya) return;
    haptica("exito");
    const p = { id: item.id, deezer: item.deezer, titulo: item.titulo, artista: item.artista, album: item.album, portada: item.portada, duracion: item.duracion, mini: item.mini };
    pedidos.push({ ...p, estado: "pendiente", anadido: Date.now() / 1000 });
    guardarLocales();
    pintarPedidos();
    const desde = li && li.querySelector(".rec-portada .portada");
    if (desde) volar(desde);
    if (servidor) {
      try { aplicarEstado(await post("api/pedidos", { accion: "anadir", pedido: p })); } catch (_) { aviso(t("noSePudoGuardarPedido")); }
    }
  }
  async function quitarPedido(id) {
    haptica("suave");
    pedidos = pedidos.filter((p) => p.id !== id);
    guardarLocales();
    pintarPedidos();
    if (servidor) { try { aplicarEstado(await post("api/pedidos", { accion: "quitar", id })); } catch (_) {} }
  }

  // la portada vuela hasta la bandeja
  function volar(desde) {
    const destino = $("bandeja");
    if (destino.hidden || movimientoReducido()) return;
    const a = desde.getBoundingClientRect();
    const b = $("bandeja-portadas").getBoundingClientRect();
    const c = desde.cloneNode(true);
    c.classList.add("volando");
    Object.assign(c.style, { left: a.left + "px", top: a.top + "px", width: a.width + "px", height: a.height + "px" });
    document.body.append(c);
    const dx = b.left - a.left, dy = b.top - a.top;
    c.animate([
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.45}px, ${Math.min(dy * 0.45, dy - 140)}px) scale(0.9)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.4 },
    ], { duration: 650, easing: "cubic-bezier(.45,0,.55,1)" }).finished.then(() => {
      c.remove();
      destino.classList.remove("bote"); void destino.offsetWidth; destino.classList.add("bote");
    });
  }

  let antes = new Map();               // estado previo de cada pedido, para notar lo recién bajado
  let sondeo = 0;
  let vigilarHasta = 0;                // tras pulsar Descargar, mirar aunque el proceso aún no haya arrancado
  function aplicarEstado(e) {
    if (!e || !Array.isArray(e.pedidos)) return;
    const nuevas = [];
    for (const p of e.pedidos) {
      const previo = antes.get(p.id);
      if (p.estado === "hecho" && previo && previo !== "hecho") nuevas.push(p);
    }
    antes = new Map(e.pedidos.map((p) => [p.id, p.estado]));
    const minis = new Map(pedidos.map((p) => [p.id, p.mini]));
    pedidos = e.pedidos.map((p) => ({ ...p, mini: p.mini || minis.get(p.id) }));
    descargando = !!e.descargando;
    alCerrar = e.al_cerrar !== false;
    calidad = e.calidad === "alta" ? "alta" : "normal";
    $("aj-cerrar").checked = alCerrar;
    pintarSegmento($("aj-calidad"), calidad);
    pintarPedidos();
    if (nuevas.length) {
      recargar();
      haptica("exito");
      const primera = nuevas[0];
      aviso(nuevas.length === 1 ? t("yaEstaEnTuMusica", primera.titulo) : t("nNuevasEnTuMusica", nuevas.length), () => {
        if (primera.pista && porId.has(primera.pista)) { reproducirDesde([primera.pista], primera.pista, { k: "deDescubrir" }); abrirHoja(); }
      }, t("escuchar"));
    }
    clearTimeout(sondeo);
    const pendientes = pedidos.some((p) => p.estado === "pendiente");
    if (servidor && (descargando || pedidos.some((p) => p.estado === "descargando") || (pendientes && Date.now() < vigilarHasta))) {
      sondeo = setTimeout(sondear, 1500);
    }
  }
  async function sondear() {
    try { aplicarEstado(await (await fetch("api/estado", { cache: "no-store" })).json()); } catch (_) { sondeo = setTimeout(sondear, 4000); }
  }

  async function descargarAhora() {
    if (!servidor) return enviarLista();
    if (!pedidos.some((p) => p.estado === "pendiente")) return;
    haptica("medio");
    vigilarHasta = Date.now() + 20000;
    try { aplicarEstado(await post("api/descargar")); aviso(t("descargandoSigue")); } catch (_) { aviso(t("noSeEmpezoDescarga")); }
  }

  function textoLista() {
    const lista = pedidos.filter((p) => p.estado === "pendiente" || p.estado === "error");
    return t("ponMasMusica") + "\n" + lista.map((p, i) => `${i + 1}. ${p.artista} - ${p.titulo}${p.deezer ? `  (deezer.com/track/${p.deezer})` : ""}`).join("\n");
  }
  async function copiar(texto) {
    try { await navigator.clipboard.writeText(texto); return true; } catch (_) {
      const ta = nodo("textarea");
      ta.value = texto;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }
  async function enviarLista() {
    const texto = textoLista();
    if (navigator.share) {
      try { await navigator.share({ title: t("musicaParaAnadir"), text: texto }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    aviso((await copiar(texto)) ? t("listaCopiadaPegala") : t("noSePudoCopiar"));
  }

  function pintarPedidos() {
    pintarBandeja();
    pintarGlobo();
    marcarEnBiblioteca();
    pintarInfoRec();
    if (capaAbierta("modal:pedidos-hoja")) pintarHojaPedidos();
  }

  function pintarBandeja() {
    const b = $("bandeja");
    const lista = activos();
    const visible = pestana === "descubrir" && lista.length > 0 && !detalle;
    b.hidden = !visible;
    document.body.classList.toggle("con-bandeja", visible);
    if (!visible) return;
    const port = $("bandeja-portadas");
    port.textContent = "";
    lista.slice(-3).forEach((p) => port.append(portada(p.id, p.mini || p.portada)));
    const pend = lista.filter((p) => p.estado === "pendiente").length;
    const errores = lista.filter((p) => p.estado === "error").length;
    const bajando = lista.find((p) => p.estado === "descargando");
    $("bandeja-n").textContent = t("nElegidas", lista.length);
    let texto;
    if (bajando) texto = t("bajando", bajando.titulo, Math.round((bajando.progreso || 0) * 100));
    else if (!servidor) texto = t("enviamelas");
    else if (pend) texto = alCerrar ? t("seBajanAlCerrar") : t("listasParaDescargar");
    else if (errores) texto = t("nNoEncontradas", errores);
    else texto = "";
    $("bandeja-estado").textContent = texto;
    $("bandeja-accion").textContent = bajando || (!pend && servidor) ? t("ver") : servidor ? t("descargar") : t("enviar");
    const hechas = pedidos.filter((p) => p.estado === "hecho").length;
    const total = hechas + lista.length;
    const avance = bajando || descargando ? (hechas + (bajando ? bajando.progreso || 0 : 0)) / Math.max(1, total) : 0;
    $("bandeja-avance").style.setProperty("--avance", (avance * 100).toFixed(1) + "%");
  }
  $("bandeja").addEventListener("click", (e) => {
    haptica();
    const enAccion = e.target.closest("#bandeja-accion");
    const pend = pedidos.some((p) => p.estado === "pendiente");
    if (enAccion && pend && !pedidos.some((p) => p.estado === "descargando")) return servidor ? descargarAhora() : enviarLista();
    abrirPedidos();
  });

  function pintarGlobo() {
    const g = $("globo-descubrir");
    const bajando = pedidos.find((p) => p.estado === "descargando");
    const n = activos().length;
    g.className = "globo";
    g.textContent = "";
    g.style.removeProperty("--p");
    if (bajando) {
      g.classList.add("girando");
      g.style.setProperty("--p", Math.round((bajando.progreso || 0.05) * 100) + "%");
    } else if (n) g.textContent = n > 99 ? "99+" : n;
    else if (rec.nuevas) g.classList.add("punto");
    g.hidden = !(bajando || n || rec.nuevas);
  }

  function abrirPedidos() {
    pintarHojaPedidos();
    abrirModal($("pedidos-hoja"));
  }
  function pintarHojaPedidos() {
    const ul = $("pedidos-lista");
    ul.textContent = "";
    const prioridad = { descargando: 0, pendiente: 1, error: 2, hecho: 3 };
    pedidos.slice().sort((a, b) => prioridad[a.estado] - prioridad[b.estado] || a.anadido - b.anadido).forEach((p) => {
      const li = nodo("li", "pedido " + p.estado);
      const tx = nodo("span", "textos");
      tx.append(nodo("b", "", p.titulo), nodo("small", "", p.estado === "error" ? (p.error || t("error")) : p.artista));
      const est = nodo("span", "pedido-estado");
      if (p.estado === "descargando") est.textContent = Math.round((p.progreso || 0) * 100) + "%";
      else if (p.estado === "hecho") est.innerHTML = icono("i-check") + t("lista");
      else if (p.estado === "error") {
        const r = nodo("button", "enlace", t("reintentar"));
        r.addEventListener("click", async () => { haptica(); try { aplicarEstado(await post("api/pedidos", { accion: "reintentar", id: p.id })); } catch (_) {} });
        est.append(r);
      }
      if (p.estado === "pendiente" || p.estado === "error") {
        const x = nodo("button", "rec-quitar");
        x.setAttribute("aria-label", t("quitar"));
        x.innerHTML = icono("i-x");
        x.addEventListener("click", () => quitarPedido(p.id));
        est.append(x);
      }
      li.append(portada(p.id, p.mini || p.portada), tx, est);
      if (p.estado === "descargando") {
        const barra = nodo("span", "pedido-barra");
        barra.innerHTML = `<i style="--p:${Math.round((p.progreso || 0) * 100)}%"></i>`;
        li.append(barra);
      }
      if (p.estado === "hecho" && p.pista && porId.has(p.pista)) {
        li.style.cursor = "pointer";
        li.addEventListener("click", async () => { await cerrarCapa(); reproducirDesde([p.pista], p.pista, { k: "deDescubrir" }); abrirHoja(); });
      }
      ul.append(li);
    });
    const pend = pedidos.filter((p) => p.estado === "pendiente").length;
    const bajando = pedidos.some((p) => p.estado === "descargando");
    $("pedidos-limpiar").hidden = !pedidos.some((p) => p.estado === "hecho" || p.estado === "error");
    $("pedidos-nota").textContent = servidor
      ? bajando ? t("notaBajando") : pend ? (alCerrar ? t("notaAlCerrar") : t("notaPulsa")) : t("notaTodo")
      : t("notaSinServidor");
    const acc = $("pedidos-accion");
    acc.querySelector("span").textContent = servidor ? (bajando ? t("descargandoPuntos") : pend ? t("descargarN", pend) : t("descargar")) : t("enviarLista");
    acc.querySelector("use").setAttribute("href", servidor ? "#i-descarga" : "#i-compartir");
    acc.disabled = servidor ? (bajando || !pend) : !pedidos.some((p) => p.estado === "pendiente");
    $("pedidos-copiar").disabled = !pedidos.some((p) => p.estado === "pendiente" || p.estado === "error");
  }
  $("pedidos-accion").addEventListener("click", () => descargarAhora());
  $("pedidos-copiar").addEventListener("click", async () => { haptica(); aviso((await copiar(textoLista())) ? t("listaCopiada") : t("noSePudoCopiar")); });
  $("pedidos-limpiar").addEventListener("click", async () => {
    haptica("suave");
    if (servidor) { try { aplicarEstado(await post("api/pedidos", { accion: "limpiar" })); } catch (_) {} }
    else { pedidos = pedidos.filter((p) => p.estado === "pendiente"); guardarLocales(); pintarPedidos(); }
    pintarHojaPedidos();
  });

  // ============================================================ AJUSTES
  const TEMAS = ["medianoche", "oceano", "orquidea", "bosque", "brasa", "grafito", "portada"];
  function ponerTema(tema, { guardarlo = true } = {}) {
    if (!TEMAS.includes(tema)) tema = "medianoche";
    document.documentElement.dataset.tema = tema;
    document.querySelectorAll("#temas .muestra").forEach((m) => m.setAttribute("aria-pressed", String(m.dataset.tema === tema)));
    const color = getComputedStyle(document.documentElement).getPropertyValue("--base").trim();
    document.querySelector('meta[name="theme-color"]').content = color;
    if (guardarlo) guardarEstado({ tema });
  }
  // cada muestra se pinta con su propio tema
  document.querySelectorAll("#temas .muestra").forEach((m) => {
    m.querySelector("i").dataset.tema = m.dataset.tema;
    m.addEventListener("click", () => { haptica("medio"); ponerTema(m.dataset.tema); });
  });

  // interruptores: todos guardan un sí/no en estado (por defecto, sí salvo que se diga)
  function interruptor(id, clave, porDefecto, alCambiar) {
    const e = $(id);
    e.checked = estado[clave] === undefined ? porDefecto : !!estado[clave];
    e.addEventListener("change", () => {
      guardarEstado({ [clave]: e.checked });
      haptica(e.checked ? "medio" : "suave");
      alCambiar && alCambiar(e.checked);
    });
  }
  interruptor("aj-acento", "acento", true, (si) => {
    if (actual) aplicarColores(porId.get(actual));
    if (!si) document.documentElement.style.removeProperty("--acento-cancion");
  });
  interruptor("aj-fondo", "fondoVivo", true, (si) => document.documentElement.classList.toggle("quieto", !si));
  interruptor("aj-fundidos", "fundidos", true);
  interruptor("aj-despierta", "despierta", true, (si) => { if (!si) pantallaEncendida(false); });
  interruptor("aj-vibracion", "vibracion", true, (si) => { if (si) haptica("exito"); });
  interruptor("aj-explicitas", "sinExplicitas", false, () => pintarRecs());
  $("aj-cerrar").addEventListener("change", async (e) => {
    haptica(e.target.checked ? "medio" : "suave");
    try { aplicarEstado(await post("api/pedidos", { accion: "al_cerrar", valor: e.target.checked })); } catch (_) {}
  });

  // segmentos de Ajustes: data-v en cada botón
  function pintarSegmento(cont, valor) {
    const botones = [...cont.querySelectorAll(".segmento")];
    botones.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(valor))));
    cont.style.setProperty("--i", Math.max(0, botones.findIndex((b) => b.dataset.v === String(valor))));
  }
  function segmento(id, valor, alCambiar) {
    const cont = $(id);
    pintarSegmento(cont, valor);
    cont.addEventListener("click", (e) => {
      const b = e.target.closest(".segmento");
      if (!b) return;
      haptica("suave");
      pintarSegmento(cont, b.dataset.v);
      alCambiar(b.dataset.v);
    });
  }
  segmento("aj-animaciones", estado.animaciones || "completas", (v) => {
    guardarEstado({ animaciones: v });
    document.documentElement.classList.toggle("reducido", v === "reducidas");
  });
  segmento("aj-idioma", estado.idioma || "auto", (v) => {
    guardarEstado({ idioma: v });
    elegirIdioma();
    repintarTodo();
  });
  segmento("aj-frecuencia", String(estado.frecuencia ?? 3), (v) => {
    guardarEstado({ frecuencia: Number(v) });
    pintarInfoRec();
  });
  segmento("aj-calidad", calidad, async (v) => {
    try { aplicarEstado(await post("api/pedidos", { accion: "calidad", valor: v })); } catch (_) {}
  });

  $("aj-olvidar").addEventListener("click", () => {
    if (!descartadas.size) return;
    haptica();
    descartadas = new Set();
    almacen.poner("descartadas", []);
    pintarAjustesDescubrir();
    pintarRecs();
    aviso(t("descartadasVuelven"));
  });
  $("aj-releer").addEventListener("click", async () => {
    haptica();
    await recargar();
    aviso(t("nEnLaCarpeta", pistas.length));
  });
  $("aj-historial").addEventListener("click", async () => {
    haptica();
    if (!(await confirmar(t("borrarHistorial"), t("borrarHistorialPregunta"), t("borrar")))) return;
    for (const k of Object.keys(escuchas)) delete escuchas[k];
    for (const k of Object.keys(diario)) delete diario[k];
    guardarTiempo();
    refrescarVistas();
    aviso(t("historialBorrado"));
  });
  $("aj-restablecer").addEventListener("click", async () => {
    haptica();
    if (!(await confirmar(t("restablecer"), t("restablecerPregunta"), t("restablecer")))) return;
    for (const k of ["tema", "acento", "fondoVivo", "fundidos", "despierta", "vibracion", "animaciones", "idioma", "frecuencia", "sinExplicitas", "orden", "vista"]) delete estado[k];
    guardarEstado();
    location.reload();
  });

  function pintarAjustesDescubrir() {
    $("aj-descartadas").textContent = descartadas.size ? t("nDescartadas", descartadas.size) : t("ninguna");
  }
  function pintarAjustesBiblioteca() {
    $("aj-n").textContent = pistas.length;
    const total = pistas.reduce((s, p) => s + (p.duracion || 0), 0);
    $("aj-dur").textContent = total >= 3600 ? Math.round(total / 3600) + " h" : Math.round(total / 60) + " min";
    $("aj-fav").textContent = [...favoritas].filter((id) => porId.has(id)).length;
  }

  function repintarTodo() {
    traducirPagina();
    pintarAvatares();
    pintarMusica();
    if (detalle) pintarDetalle();
    pintarRecs();
    pintarPedidos();
    pintarAjustesDescubrir();
    pintarSueno();
    if (actual) $("hoja-contexto").textContent = nombreDe(contexto.nombre);
    if (!$("cola-vista").hidden) pintarCola();
    if (seleccion) pintarSeleccion();
    $("aj-modo").textContent = servidor
      ? (["127.0.0.1", "localhost"].includes(location.hostname) ? t("modoPC") : t("modoRed"))
      : t("modoSoloEscuchar");
  }

  // ============================================================ MEDIA SESSION Y TECLADO
  function sesionMedia(p) {
    if (!("mediaSession" in navigator)) return;
    const u = urlPortada(p);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: p.titulo,
      artist: p.artista || "",
      album: p.album || "Music",
      artwork: u
        ? [{ src: new URL(u, location.href).href, sizes: "600x600", type: "image/jpeg" }]
        : [{ src: new URL("icono.png", location.href).href, sizes: "512x512", type: "image/png" }],
    });
  }
  function posicionMedia() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = duracionReal();
    if (d > 0) {
      try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 }); } catch (_) {}
    }
  }
  audio.addEventListener("seeked", () => { posicionMedia(); sincronizarLetra(true); });
  if ("mediaSession" in navigator) {
    const m = navigator.mediaSession;
    const poner = (a, f) => { try { m.setActionHandler(a, f); } catch (_) {} };
    poner("play", () => audio.play());
    poner("pause", () => audio.pause());
    poner("previoustrack", anterior);
    poner("nexttrack", () => siguiente());
    poner("seekto", (d) => { audio.currentTime = d.seekTime; posicionMedia(); });
    poner("seekbackward", (d) => { audio.currentTime -= d.seekOffset || 10; });
    poner("seekforward", (d) => { audio.currentTime += d.seekOffset || 10; });
  }

  document.addEventListener("keydown", (e) => {
    const tg = e.target.tagName;
    if (e.key === "Escape" && capas.length) return cerrarCapa();
    if (tg === "INPUT" || tg === "TEXTAREA") return;
    if (e.key === "/") { e.preventDefault(); irPestana("musica"); buscar.focus(); return; }
    if (tg === "BUTTON" && (e.code === "Space" || e.key === "Enter")) return;
    if (e.code === "Space") { e.preventDefault(); alternar(); }
    else if (e.key === "ArrowRight") audio.currentTime += 10;
    else if (e.key === "ArrowLeft") audio.currentTime -= 10;
    else if (e.key.toLowerCase() === "n") siguiente();
    else if (e.key.toLowerCase() === "p") anterior();
    else if (e.key.toLowerCase() === "l" && actual) alternarFav(actual);
  });

  // al volver a la app: descargas al día, saludo a la hora y, si toca, recomendaciones nuevas
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) {
      if (actual) guardarEstado({ id: actual, t: audio.currentTime });
      guardarTiempo();
      return;
    }
    pintarSaludo();
    if (servidor) sondear();
    if (!$("letra-vista").hidden && capaAbierta("hoja") && !audio.paused) pantallaEncendida(true);
    quizaRecomendar();
  });

  // ============================================================ ARRANQUE
  async function arrancar() {
    elegirIdioma();
    traducirPagina();
    mezcla = !!estado.mezcla;
    repite = ["no", "todo", "uno"].includes(estado.repite) ? estado.repite : "no";
    pintarModos();
    ponerTema(estado.tema, { guardarlo: false });
    pintarAvatares();
    pintarAjustesDescubrir();

    const [est] = await Promise.all([
      fetch("api/estado", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      cargarPistas(),
    ]);
    servidor = !!(est && est.servidor);
    document.body.classList.toggle("con-servidor", servidor);
    if (servidor) {
      aplicarEstado(est);
      // las listas del servidor mandan; si aún no tiene, se le pasan las de este navegador
      try {
        const r = await (await fetch("api/listas", { cache: "no-store" })).json();
        if (Array.isArray(r.listas) && r.listas.length) { misListas = r.listas; almacen.poner("listas", misListas); }
        else if (misListas.length) guardarListas();
      } catch (_) {}
    } else {
      pedidos = almacen.leer("pedidos", []);
      // la versión publicada trae las listas del PC en listas.json: sirven de punto de partida
      if (!misListas.length) {
        try {
          const l = await (await fetch("listas.json", { cache: "no-store" })).json();
          if (Array.isArray(l) && l.length) { misListas = l; almacen.poner("listas", misListas); }
        } catch (_) {}
      }
    }

    // volver donde se quedó, en pausa: el navegador no deja arrancar solo
    const c = estado.contexto;
    if (c && Array.isArray(c.ids)) contexto = { nombre: c.nombre || { k: "tuMusica" }, ids: c.ids.filter((id) => porId.has(id)) };
    if (!contexto.ids.length) contexto = { nombre: { k: "tuMusica" }, ids: ordenar(principal(), estado.orden || "recientes").map((p) => p.id) };
    if (estado.id && porId.has(estado.id)) {
      if (!contexto.ids.includes(estado.id)) contexto.ids.unshift(estado.id);
      construirOrden(estado.id);
      cargar(porId.get(estado.id));
      if (estado.t > 0) audio.addEventListener("loadedmetadata", () => { audio.currentTime = estado.t; }, { once: true });
    }

    repintarTodo();
    pintarMusica({ animar: true });
    quizaRecomendar();
  }
  arrancar();
})();
