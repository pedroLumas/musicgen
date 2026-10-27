"""Pedidos: las canciones elegidas en «Descubrir» que esperan a bajarse.

Se apuntan en music/.pedidos.json en cuanto se tocan, así que cerrar la app no
pierde nada. Las baja un proceso aparte (descargar_musica.py --pedidos) que se
lanza con el botón «Descargar» o al cerrar la ventana: va por libre, de modo que
cerrar o volver a abrir la app no corta una descarga a medias.

Dos cerrojos del sistema (se sueltan solos si el proceso muere):
    .pedidos.lock       lo tiene quien está descargando; uno solo a la vez
    .pedidos.json.lock  alrededor de cada lectura-escritura del fichero, que tocan
                        a la vez el servidor (añadir, quitar) y el descargador (avance)
"""

import contextlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

RAIZ = Path(__file__).parent
FICHERO = RAIZ / ".pedidos.json"
CERROJO_TRABAJO = RAIZ / ".pedidos.lock"
CERROJO_FICHERO = RAIZ / ".pedidos.json.lock"
REGISTRO = RAIZ / ".descargas.log"

_hilos = threading.RLock()            # el cerrojo de fichero no separa hilos del mismo proceso

if os.name == "nt":
    import msvcrt

    def _bloquear(f, esperar: bool) -> bool:
        limite = time.monotonic() + 15
        while True:
            try:
                f.seek(0)
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
                return True
            except OSError:
                if not esperar or time.monotonic() > limite:
                    return False
                time.sleep(0.04)

    def _soltar(f):
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _bloquear(f, esperar: bool) -> bool:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | (0 if esperar else fcntl.LOCK_NB))
            return True
        except OSError:
            return False

    def _soltar(f):
        fcntl.flock(f, fcntl.LOCK_UN)


# ------------------------------------------------------------------ el fichero
@contextlib.contextmanager
def _fichero_bloqueado():
    with _hilos, open(CERROJO_FICHERO, "a+") as f:
        _bloquear(f, esperar=True)
        try:
            yield
        finally:
            _soltar(f)


def _leer_sin_cerrojo() -> dict:
    try:
        datos = json.loads(FICHERO.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        datos = {}
    if not isinstance(datos, dict):
        datos = {}
    if not isinstance(datos.get("pedidos"), list):
        datos["pedidos"] = []
    datos.setdefault("al_cerrar", True)
    if datos.get("calidad") not in ("normal", "alta"):
        datos["calidad"] = "normal"
    return datos


def leer() -> dict:
    with _fichero_bloqueado():
        return _leer_sin_cerrojo()


def cambiar(funcion) -> dict:
    """Lee, aplica funcion(datos) y guarda, todo bajo los dos cerrojos."""
    with _fichero_bloqueado():
        datos = _leer_sin_cerrojo()
        funcion(datos)
        tmp = FICHERO.with_name(FICHERO.name + ".tmp")
        tmp.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")
        for intento in range(20):          # OneDrive o el antivirus pueden tenerlo abierto un instante
            try:
                os.replace(tmp, FICHERO)
                break
            except PermissionError:
                time.sleep(0.05 * (intento + 1))
        return datos


def _poner(datos: dict, id_: str, **campos):
    for p in datos["pedidos"]:
        if p.get("id") == id_:
            p.update(campos)


# ------------------------------------------------------------------ operaciones
ID_VALIDO = re.compile(r"^[\w-]{1,40}$")
TEXTOS = ("titulo", "artista", "album", "portada", "mini", "lista")


def _limpio(p) -> dict | None:
    """Solo los campos conocidos y con el tipo esperado: esto llega del navegador."""
    if not isinstance(p, dict):
        return None
    out = {k: p[k].strip()[:300] for k in TEXTOS if isinstance(p.get(k), str) and p[k].strip()}
    for k in ("deezer", "duracion"):
        if isinstance(p.get(k), (int, float)) and not isinstance(p.get(k), bool):
            out[k] = int(p[k])
    if not out.get("titulo") or not out.get("artista"):
        return None
    if p.get("importada") is True:            # viene de importar_lista.py, no de Descubrir
        out["importada"] = True
    for k in ("portada", "mini"):             # solo imágenes de verdad, nada de javascript: ni rutas locales
        if not out.get(k, "https://").startswith("https://"):
            out.pop(k)
    id_ = p.get("id") if isinstance(p.get("id"), str) else ""
    out["id"] = id_ if ID_VALIDO.match(id_) else f"dz{out.get('deezer', int(time.time() * 1000))}"
    return out


def anadir(pedido) -> dict:
    p = _limpio(pedido)
    if not p:
        return leer()

    def f(d):
        for q in d["pedidos"]:
            if q.get("id") == p["id"]:
                if q.get("estado") == "error":
                    q.update(estado="pendiente", error="")
                return
        d["pedidos"].append({**p, "estado": "pendiente", "anadido": time.time()})
    return cambiar(f)


def quitar(id_: str) -> dict:
    return cambiar(lambda d: d.update(pedidos=[
        p for p in d["pedidos"] if p.get("id") != id_ or p.get("estado") == "descargando"]))


def reintentar(id_: str) -> dict:
    return cambiar(lambda d: [p.update(estado="pendiente", error="")
                              for p in d["pedidos"] if p.get("id") == id_ and p.get("estado") == "error"])


def limpiar() -> dict:
    """Quita de la lista lo ya terminado (bien o mal)."""
    return cambiar(lambda d: d.update(pedidos=[
        p for p in d["pedidos"] if p.get("estado") not in ("hecho", "error")]))


def poner_al_cerrar(valor: bool) -> dict:
    return cambiar(lambda d: d.update(al_cerrar=bool(valor)))


def poner_calidad(valor) -> dict:
    """normal = mp3 a 192 kbps; alta = 320 kbps (casi el doble de espacio)."""
    return cambiar(lambda d: d.update(calidad="alta" if valor == "alta" else "normal"))


def hay_pendientes(datos: dict | None = None) -> bool:
    datos = datos or leer()
    return any(p.get("estado") == "pendiente" for p in datos["pedidos"])


def trabajando() -> bool:
    """¿Hay un descargador en marcha (en este proceso o en otro)?"""
    try:
        with open(CERROJO_TRABAJO, "a+") as f:
            if _bloquear(f, esperar=False):
                _soltar(f)
                return False
            return True
    except OSError:
        return False


def estado() -> dict:
    """Lo que pinta la app. De paso, recoge lo que quedó a medias si el descargador murió."""
    activo = trabajando()
    datos = leer()
    if not activo and any(p.get("estado") == "descargando" for p in datos["pedidos"]):
        datos = cambiar(lambda d: [p.update(estado="pendiente", progreso=0)
                                   for p in d["pedidos"] if p.get("estado") == "descargando"])
    return {"pedidos": datos["pedidos"], "al_cerrar": datos["al_cerrar"], "calidad": datos["calidad"],
            "descargando": activo}


# ------------------------------------------------------------------ descargar
def lanzar() -> bool:
    """Arranca el descargador en un proceso aparte, si hay algo pendiente y nadie está ya."""
    if trabajando() or not hay_pendientes():
        return False
    exe = Path(sys.executable)
    flags = 0
    if os.name == "nt":
        sin_consola = exe.with_name("pythonw.exe")
        if sin_consola.exists():
            exe = sin_consola
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        if REGISTRO.exists() and REGISTRO.stat().st_size > 1_000_000:
            os.replace(REGISTRO, REGISTRO.with_suffix(".old"))
    except OSError:
        pass
    with open(REGISTRO, "a", encoding="utf-8") as log:
        subprocess.Popen(
            [str(exe), "-X", "utf8", "-u", str(RAIZ / "descargar_musica.py"), "--pedidos"],
            cwd=str(RAIZ), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=flags, close_fds=True,
        )
    return True


def descargar_todo(eco=print) -> int:
    """Baja los pendientes de uno en uno; lo que se añada mientras tanto también entra."""
    import descargar_musica  # aquí y no arriba: descargar_musica también importa este módulo

    with open(CERROJO_TRABAJO, "a+") as f:
        if not _bloquear(f, esperar=False):
            eco("Ya hay una descarga en marcha.")
            return 0
        try:
            # lo que quedó "descargando" es de un descargador que murió
            cambiar(lambda d: [p.update(estado="pendiente") for p in d["pedidos"]
                               if p.get("estado") == "descargando"])
            hechas = 0
            while True:
                actual = {}

                def tomar(d):
                    viejo = time.time() - 3 * 86400       # lo terminado hace días ya no se enseña
                    d["pedidos"] = [p for p in d["pedidos"]
                                    if p.get("estado") != "hecho" or p.get("terminado", viejo) > viejo]
                    for p in d["pedidos"]:
                        if p.get("estado") == "pendiente":
                            p.update(estado="descargando", progreso=0, error="")
                            actual.update(p)
                            return
                cambiar(tomar)
                if not actual:
                    return hechas

                eco(f"\n== {actual['artista']} - {actual['titulo']}")
                ultimo = [0.0, -1.0]

                def avance(fraccion: float):
                    ahora = time.monotonic()
                    if ahora - ultimo[0] < 0.9 or abs(fraccion - ultimo[1]) < 0.03:
                        return
                    ultimo[:] = [ahora, fraccion]
                    cambiar(lambda d: _poner(d, actual["id"], progreso=round(fraccion, 3)))

                try:
                    pista = descargar_musica.descargar_pedido(actual, avance)
                    error = "" if pista else "No se encontró en YouTube"
                except Exception as e:  # una canción que falla no para las demás
                    pista, error = None, (str(e).splitlines() or ["Error"])[0][:200]
                cambiar(lambda d: _poner(d, actual["id"], estado="hecho" if pista else "error",
                                         pista=pista, error=error, progreso=1 if pista else 0,
                                         terminado=time.time()))
                eco(f"  OK  {pista}" if pista else f"  ERROR  {error}")
                hechas += bool(pista)
        finally:
            _soltar(f)
