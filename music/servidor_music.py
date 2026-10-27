"""Servidor de Music. Sirve SOLO la carpeta music/, nunca el resto de COZY.

Reutiliza el manejador de Cozy (servidor.py): Range para saltar dentro de una
pista y sin caché. Añade /pistas.json, que se arma al pedirlo: basta dejar un
mp3 en pistas/ para que aparezca, sin regenerar nada.

Y lo que la app no puede hacer sola desde el navegador:
    GET  /api/estado          hay servidor + los pedidos de «Descubrir» y su avance
    GET  /api/deezer?p=/...   la API pública de Deezer (recomendaciones), con caché
    GET  /api/letra?...       la letra de LRCLIB (sincronizada si la hay), con caché
    GET  /api/listas          las listas hechas en la app (POST: guardarlas enteras)
    POST /api/pedidos         añadir, quitar, reintentar, limpiar, al_cerrar, calidad
    POST /api/descargar       arranca el descargador (proceso aparte, ver pedidos.py)
    POST /api/ficha           corregir título, artista o lista de una canción
    POST /borrar, /restaurar  mover a la cuarentena y de vuelta
"""

import functools
import http.server
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).parent
sys.path.insert(0, str(RAIZ.parent))
import servidor  # noqa: E402  (el manejador con Range y sin caché)
import pedidos  # noqa: E402

PISTAS = RAIZ / "pistas"
PUERTO = 8935


def listar_pistas() -> list[dict]:
    """Una ficha por mp3. Sin .json al lado, el nombre del fichero hace de título."""
    pistas = []
    if not PISTAS.exists():
        return pistas
    for mp3 in PISTAS.glob("*.mp3"):
        ficha = {}
        try:
            # utf-8-sig: una ficha editada con el Bloc de notas o PowerShell trae BOM
            ficha = json.loads(mp3.with_suffix(".json").read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            pass                              # una ficha rota no tira la lista
        portada = mp3.with_suffix(".jpg")
        hay_portada = portada.exists()
        pistas.append({
            "id": mp3.stem,
            "audio": mp3.name,
            "portada": portada.name if hay_portada else None,
            "pv": int(portada.stat().st_mtime) if hay_portada else None,   # ?v= para la caché
            "titulo": ficha.get("titulo") or mp3.stem,
            "artista": ficha.get("artista") or "",
            "album": ficha.get("album") or "",
            "duracion": ficha.get("duracion"),
            "lista": ficha.get("lista") or "",    # "" = la biblioteca principal
            "orden": ficha.get("anadida") or mp3.stat().st_mtime,
            "deezer": ficha.get("deezer"),
            "descubierta": bool(ficha.get("descubierta")),
        })
    # por artista y, dentro de cada uno, en el orden en que se fueron añadiendo
    pistas.sort(key=lambda p: (p["artista"].casefold() or "￿", p["orden"]))
    return pistas


ARCHIVO = RAIZ / ".archivo.txt"                 # ids ya descargados (lo lee descargar_musica.py)
CUARENTENA = RAIZ.parent / "_CUARENTENA" / "music"   # fuera de music/: lo borrado no se sirve
EXTENSIONES = (".mp3", ".jpg", ".json")


def _id_valido(id_) -> bool:
    return (isinstance(id_, str) and id_ and not id_.startswith(".")
            and not any(c in id_ for c in '\\/:*?"<>|'))


def _mover(id_: str, desde: Path, hacia: Path) -> bool:
    """Mueve los ficheros de una canción. Archivar, no borrar."""
    if not (desde / f"{id_}.mp3").exists():
        return False
    hacia.mkdir(parents=True, exist_ok=True)
    for ext in EXTENSIONES:
        origen = desde / f"{id_}{ext}"
        if origen.exists():
            os.replace(origen, hacia / origen.name)   # pisa si ya había una vieja
    return True


def _archivo_ids(id_: str, anotar: bool):
    """Quita (o vuelve a poner) el id del registro de descargas, para poder bajarla otra vez."""
    linea = f"youtube {id_}"
    try:
        lineas = ARCHIVO.read_text(encoding="utf-8").splitlines() if ARCHIVO.exists() else []
        lineas = [l for l in lineas if l.strip() != linea]
        if anotar:
            lineas.append(linea)
        ARCHIVO.write_text("\n".join(lineas) + ("\n" if lineas else ""), encoding="utf-8")
    except OSError:
        pass


def editar_ficha(id_: str, cambios: dict) -> bool:
    """Título, artista y lista se corrigen desde la app; el resto de la ficha no se toca."""
    if not (PISTAS / f"{id_}.mp3").exists():
        return False
    ruta = PISTAS / f"{id_}.json"
    try:
        ficha = json.loads(ruta.read_text(encoding="utf-8-sig")) if ruta.exists() else {"id": id_}
    except (OSError, json.JSONDecodeError):
        ficha = {"id": id_}
    for campo in ("titulo", "artista", "album", "lista"):
        valor = cambios.get(campo)
        if isinstance(valor, str):
            valor = re.sub(r"\s+", " ", valor).strip()[:200]
            if valor:
                ficha[campo] = valor
            elif campo != "titulo":
                ficha.pop(campo, None)            # lista vacía = vuelve a la biblioteca
    ruta.write_text(json.dumps(ficha, ensure_ascii=False, indent=2), encoding="utf-8")
    return True


# ---- Deezer: solo lectura, solo estas rutas, con caché en memoria ----------
DEEZER_RUTAS = re.compile(
    r"^/(search(/artist|/track|/album)?|artist/\d+(/related|/top)?|track/\d+|album/\d+(/tracks)?"
    r"|chart/\d+(/tracks|/artists)?)$")
_cache_deezer: dict[str, tuple[float, bytes]] = {}
_cache_cerrojo = threading.Lock()


def deezer(ruta: str) -> bytes | None:
    partes = urllib.parse.urlsplit(ruta)
    if not DEEZER_RUTAS.match(partes.path):
        return None
    url = "https://api.deezer.com" + partes.path + ("?" + partes.query if partes.query else "")
    fresca = partes.path.startswith("/track/")     # trae la URL de la muestra, que caduca
    with _cache_cerrojo:
        guardada = _cache_deezer.get(url)
    if guardada and not fresca and time.time() - guardada[0] < 3600:
        return guardada[1]
    peticion = urllib.request.Request(url, headers={"Accept-Language": "es"})
    with urllib.request.urlopen(peticion, timeout=12) as r:
        datos = r.read()
    if b'"error"' not in datos[:40]:               # el límite de Deezer no se guarda
        with _cache_cerrojo:
            if len(_cache_deezer) > 2000:
                _cache_deezer.clear()
            _cache_deezer[url] = (time.time(), datos)
    return datos


# ---- letras: LRCLIB (gratis, sin clave). Pide que se diga quién pregunta. --
_cache_letras: dict[tuple, dict] = {}


def _lrclib(ruta: str, params: dict):
    url = "https://lrclib.net/api/" + ruta + "?" + urllib.parse.urlencode(params)
    peticion = urllib.request.Request(url, headers={"User-Agent": "Music (reproductor personal)"})
    try:
        with urllib.request.urlopen(peticion, timeout=12) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def letra(artista: str, titulo: str, album: str, duracion: float) -> dict:
    clave = (artista.casefold(), titulo.casefold())
    if clave in _cache_letras:
        return _cache_letras[clave]
    params = {"artist_name": artista, "track_name": titulo}
    if album:
        params["album_name"] = album
    if duracion:
        params["duration"] = int(duracion)
    d = _lrclib("get", params)
    if not d:                                   # sin coincidencia exacta: buscar y quedarse con la más parecida
        candidatas = _lrclib("search", {"artist_name": artista, "track_name": titulo}) or []
        candidatas = [c for c in candidatas if c.get("syncedLyrics") or c.get("plainLyrics") or c.get("instrumental")]
        if candidatas:
            d = min(candidatas, key=lambda c: (not c.get("syncedLyrics"),
                                               abs((c.get("duration") or 0) - (duracion or 0))))
    res = {"sincronizada": (d or {}).get("syncedLyrics") or "", "normal": (d or {}).get("plainLyrics") or "",
           "instrumental": bool((d or {}).get("instrumental"))}
    if len(_cache_letras) > 500:
        _cache_letras.clear()
    _cache_letras[clave] = res
    return res


# ---- listas hechas en la app (varias por canción, con su orden) -------------
LISTAS = RAIZ / ".listas.json"


def leer_listas() -> list:
    try:
        datos = json.loads(LISTAS.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    return datos if isinstance(datos, list) else []


def guardar_listas(listas) -> bool:
    if not isinstance(listas, list):
        return False
    limpias = []
    for l in listas[:500]:
        if not (isinstance(l, dict) and isinstance(l.get("id"), str) and isinstance(l.get("nombre"), str)):
            continue
        ids = [i for i in l.get("ids", []) if isinstance(i, str) and _id_valido(i)][:5000]
        limpias.append({"id": l["id"][:40], "nombre": l["nombre"].strip()[:100] or "Lista",
                        "ids": ids, "creada": l.get("creada") if isinstance(l.get("creada"), (int, float)) else 0})
    tmp = LISTAS.with_name(LISTAS.name + ".tmp")
    tmp.write_text(json.dumps(limpias, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, LISTAS)
    return True


class ManejadorMusic(servidor.ManejadorCozy):

    def end_headers(self):
        ruta = self.path.split("?")[0]
        if ruta.startswith("/pistas/") and ruta.endswith(".jpg"):
            # la app pide las portadas con ?v=<fecha del fichero>: se pueden guardar sin miedo,
            # y así una lista larga no vuelve a bajar todas las imágenes cada vez que se pinta
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            return http.server.SimpleHTTPRequestHandler.end_headers(self)
        super().end_headers()

    def _json(self, obj, codigo=200, solo_cabecera=False):
        datos = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        if not solo_cabecera:
            self.wfile.write(datos)

    def _api_post(self, ruta: str, cuerpo: dict):
        if ruta == "/api/pedidos":
            accion = cuerpo.get("accion")
            id_ = cuerpo.get("id") if isinstance(cuerpo.get("id"), str) else ""
            if accion == "anadir":
                pedidos.anadir(cuerpo.get("pedido"))
            elif accion == "quitar":
                pedidos.quitar(id_)
            elif accion == "reintentar":
                pedidos.reintentar(id_)
            elif accion == "limpiar":
                pedidos.limpiar()
            elif accion == "al_cerrar":
                pedidos.poner_al_cerrar(bool(cuerpo.get("valor")))
            elif accion == "calidad":
                pedidos.poner_calidad(cuerpo.get("valor"))
            else:
                return self.send_error(400)
            return self._json(pedidos.estado())
        if ruta == "/api/descargar":
            if pedidos.lanzar():
                limite = time.monotonic() + 4     # que el estado ya diga "descargando"
                while not pedidos.trabajando() and time.monotonic() < limite:
                    time.sleep(0.1)
            return self._json(pedidos.estado())
        if ruta == "/api/ficha":
            id_ = cuerpo.get("id")
            if not _id_valido(id_):
                return self.send_error(400)
            ok = editar_ficha(id_, cuerpo)
            return self._json({"ok": ok}, 200 if ok else 404)
        if ruta == "/api/listas":
            ok = guardar_listas(cuerpo.get("listas"))
            return self._json({"ok": ok}, 200 if ok else 400)
        return self.send_error(404)

    def do_POST(self):
        ruta = self.path.split("?")[0]
        # la cabecera propia impide que otra web abierta en el navegador dispare esto
        if self.headers.get("X-Music") != "1":
            return self.send_error(403)
        try:
            tope = 2_000_000 if ruta == "/api/listas" else 16384     # una lista larga ocupa
            n = min(int(self.headers.get("Content-Length", 0)), tope)
            cuerpo = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_error(400)
        if not isinstance(cuerpo, dict):
            return self.send_error(400)
        if ruta.startswith("/api/"):
            return self._api_post(ruta, cuerpo)
        if ruta not in ("/borrar", "/restaurar"):
            return self.send_error(404)
        id_ = cuerpo.get("id")
        if not _id_valido(id_):
            return self.send_error(400)
        if ruta == "/borrar":
            ok = _mover(id_, PISTAS, CUARENTENA)
            if ok:
                _archivo_ids(id_, anotar=False)
        else:
            ok = _mover(id_, CUARENTENA, PISTAS)
            if ok:
                _archivo_ids(id_, anotar=True)
        datos = json.dumps({"ok": ok}).encode("utf-8")
        self.send_response(200 if ok else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        ruta = self.path.split("?")[0]
        if ruta == "/pistas.json":
            return self._pistas()
        if ruta == "/api/estado":
            return self._json({"servidor": True, **pedidos.estado()})
        if ruta == "/api/deezer":
            consulta = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            try:
                datos = deezer(consulta.get("p", [""])[0])
            except OSError:
                return self._json({"error": {"message": "sin conexión"}}, 502)
            if datos is None:
                return self.send_error(400)
            return self._json(datos)
        if ruta == "/api/letra":
            q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).items()}
            try:
                duracion = float(q.get("duracion") or 0)
            except ValueError:
                duracion = 0
            if not q.get("titulo"):
                return self.send_error(400)
            try:
                return self._json(letra(q.get("artista", ""), q["titulo"], q.get("album", ""), duracion))
            except (OSError, ValueError):
                return self._json({"error": "sin conexión"}, 502)
        if ruta == "/api/listas":
            return self._json({"listas": leer_listas()})
        if ruta.startswith("/.") or ruta.startswith("/api/"):
            return self.send_error(404)            # ni registros ni pedidos por HTTP
        return super().do_GET()

    def do_HEAD(self):
        if self.path.split("?")[0] == "/pistas.json":
            return self._pistas(solo_cabecera=True)
        return super().do_HEAD()

    def _pistas(self, solo_cabecera=False):
        try:
            datos = json.dumps(listar_pistas(), ensure_ascii=False).encode("utf-8")
        except Exception:
            datos = b"[]"                     # el reproductor arranca igualmente
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        if not solo_cabecera:
            self.wfile.write(datos)


def crear(puerto=PUERTO, lan=False):
    """lan=True lo abre a la red local (para oírlo desde el móvil)."""
    manejador = functools.partial(ManejadorMusic, directory=str(RAIZ))
    host = "0.0.0.0" if lan else "127.0.0.1"
    return http.server.ThreadingHTTPServer((host, puerto), manejador)


if __name__ == "__main__":
    lan = "--lan" in sys.argv
    s = crear(lan=lan)
    print(f"Music en http://127.0.0.1:{PUERTO}" + (" (abierto a la red local)" if lan else ""))
    s.serve_forever()
