"""Descarga canciones a music/pistas/ con el descargador de Cozy (descargar_video.py).

Cada canción queda como tres ficheros con el mismo nombre (el id del vídeo):
    <id>.mp3    el audio
    <id>.jpg    la portada, recortada a cuadrado
    <id>.json   título, artista y duración limpios

Uso:
    python descargar_musica.py "Nombre - Canción" "https://youtu.be/..." ...
    python descargar_musica.py --lista "Prueba" "Nombre - Canción" ...   (a una lista aparte)
    python descargar_musica.py --pedidos     (lo elegido en «Descubrir», ver pedidos.py)

Lo que no sea una URL se busca en YouTube y se baja el primer resultado.
Una canción ya descargada se salta (queda anotada en .archivo.txt).

Los pedidos van mejor: traen de Deezer el título, el artista, el álbum, la
duración y la portada buenos. Se elige entre varios vídeos el que más se
parece (misma duración, canal oficial, sin «live» ni «cover») y la portada
es la del disco, no un fotograma del vídeo.
"""

import json
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).parent
sys.path.insert(0, str(RAIZ.parent))
import descargar_video  # noqa: E402  (necesita la carpeta de Cozy en sys.path)

PISTAS = RAIZ / "pistas"
ARCHIVO = RAIZ / ".archivo.txt"

# Ruido típico de los títulos de YouTube: "(Official Video)", "[Lyrics]", "HD"...
RUIDO = re.compile(
    r"\s*[\(\[][^\)\]]*(official|video|lyric|audio|visuali[sz]er|hd|4k|remaster|mv)[^\)\]]*[\)\]]",
    re.IGNORECASE,
)


def _limpiar(texto: str) -> str:
    texto = RUIDO.sub("", texto or "")
    # lo que cuelga detrás: "#spanishdrill", "@productor", "Prod by ..."
    texto = re.split(r"\s+[-–—]?\s*[#@]|\s+prod\.?\s+by\b", texto, maxsplit=1, flags=re.IGNORECASE)[0]
    return re.sub(r"\s+", " ", texto).strip(" -–—")


def titulo_y_artista(info: dict) -> tuple[str, str]:
    """El artista y la canción, lo mejor que se pueda sacar de lo que da YouTube."""
    if info.get("track"):
        artista = info.get("artist") or info.get("creator") or ""
        return _limpiar(info["track"]), _limpiar(artista.split(",")[0])
    titulo = _limpiar(info.get("title", ""))
    m = re.match(r"^(.+?)\s*[-–—]\s+(.+)$", titulo)      # "Artista - Canción" y "Artista- Canción"
    if m:
        cancion, artista = m.group(2).strip(), m.group(1).strip()
        if cancion.lower().startswith(artista.lower() + " "):   # "B10 - B10 No Que..."
            cancion = cancion[len(artista):].strip()
        return cancion, artista
    canal = (info.get("channel") or info.get("uploader") or "").replace(" - Topic", "")
    # "Artista: Canción" en un canal que se llama como el artista ("Artista Archive", "ArtistaVEVO")
    m = re.match(r"^(.+?)\s*:\s+(.+)$", titulo)
    if m and canal.lower().startswith(m.group(1).lower()):
        return m.group(2).strip(), m.group(1).strip()
    return titulo, _limpiar(canal)


def descargar(consulta: str, lista: str | None = None) -> bool:
    es_url = consulta.startswith(("http://", "https://"))
    objetivo = consulta if es_url else f"ytsearch1:{consulta}"
    extra = {
        "download_archive": str(ARCHIVO),
        "writethumbnail": True,
        "postprocessors": [
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
        ],
        # portada cuadrada y de tamaño razonable para el móvil
        "postprocessor_args": {
            "thumbnailsconvertor": ["-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=600:600"],
        },
    }
    info = descargar_video.descargar(
        objetivo, solo_audio=True, destino=PISTAS, plantilla="%(id)s.%(ext)s", extra=extra,
    )
    if info and info.get("entries"):          # una búsqueda devuelve una lista
        info = next((e for e in info["entries"] if e), None)
    if not info:
        return False

    pista = PISTAS / f"{info['id']}.mp3"
    if not pista.exists():
        return False
    ficha = PISTAS / f"{info['id']}.json"
    if not ficha.exists():                    # si ya estaba, se respeta lo que hubiera
        titulo, artista = titulo_y_artista(info)
        ficha.write_text(json.dumps({
            "id": info["id"],
            "titulo": titulo,
            "artista": artista,
            "duracion": info.get("duration"),
            "origen": info.get("webpage_url"),
            "anadida": time.time(),
            **({"lista": lista} if lista else {}),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  OK  {artista_titulo(ficha)}")
    return True


def artista_titulo(ficha: Path) -> str:
    d = json.loads(ficha.read_text(encoding="utf-8"))
    return f"{d['artista']} - {d['titulo']}" if d["artista"] else d["titulo"]


# ------------------------------------------------------------------ pedidos
class _Callado:
    """yt-dlp sin ruido; los errores van al registro (stderr) por si hay que mirar."""
    def debug(self, msg): pass
    def info(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): print(msg, file=sys.stderr)


def _norm(texto: str) -> str:
    texto = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", " ", texto.lower()).strip()


# versiones que casi nunca son la que se pidió (salvo que el título lo diga)
OTRAS_VERSIONES = ("live", "en vivo", "en directo", "cover", "karaoke", "remix", "slowed",
                   "sped up", "speed up", "8d", "reaction", "reaccion", "instrumental",
                   "1 hour", "1 hora", "loop", "nightcore", "tutorial", "acustico", "acoustic")


def _puntos(video: dict, pedido: dict, puesto: int) -> float:
    titulo = _norm(video.get("title"))
    canal = _norm(video.get("channel") or video.get("uploader"))
    cancion = re.sub(r"\s*[\(\[].*?[\)\]]", "", pedido["titulo"])            # sin "(feat. X)"
    cancion = _norm(re.split(r"\s+(?:ft\.?|feat\.?)\s+", cancion, flags=re.IGNORECASE)[0])   # ni "ft. X"
    artista = _norm(pedido["artista"])
    pedido_n = _norm(pedido["titulo"])
    puntos = -0.4 * puesto
    if cancion and cancion in titulo:
        puntos += 3
    elif cancion and all(p in titulo for p in cancion.split()):
        puntos += 2
    if artista and (artista in titulo or artista in canal):
        puntos += 2
    if canal.endswith(" topic") and artista and artista in canal:
        puntos += 3                                   # "Artista - Topic": el audio del disco
    if "vevo" in canal:
        puntos += 1
    d, objetivo = video.get("duration"), pedido.get("duracion")
    if d and objetivo:
        dif = abs(d - objetivo)
        puntos += 3 if dif <= 3 else 2 if dif <= 8 else 0.5 if dif <= 20 else -2 if dif <= 60 else -5
    if d and d > 1200:
        puntos -= 5
    for marca in OTRAS_VERSIONES:
        if re.search(rf"\b{marca}\b", titulo) and marca not in pedido_n:
            puntos -= 4
    return puntos


def elegir_video(pedido: dict) -> str | None:
    """De los primeros resultados de YouTube, el que más se parece a lo pedido."""
    consulta = f"{pedido['artista']} - {pedido['titulo']}"
    opciones = {"quiet": True, "no_warnings": True, "extract_flat": "in_playlist",
                "skip_download": True, "logger": _Callado()}
    with descargar_video.yt_dlp.YoutubeDL(opciones) as ydl:
        info = ydl.extract_info(f"ytsearch8:{consulta}", download=False)
    videos = [v for v in (info or {}).get("entries") or [] if v and v.get("id")]
    if not videos:
        return None
    mejor = max(enumerate(videos), key=lambda iv: _puntos(iv[1], pedido, iv[0]))[1]
    return mejor["id"]


def _olvidar(id_: str):
    """Saca el id de .archivo.txt: si estaba anotado pero el mp3 ya no está, yt-dlp lo saltaría."""
    if not ARCHIVO.exists():
        return
    lineas = ARCHIVO.read_text(encoding="utf-8").splitlines()
    quedan = [l for l in lineas if l.strip() != f"youtube {id_}"]
    if len(quedan) != len(lineas):
        ARCHIVO.write_text("\n".join(quedan) + ("\n" if quedan else ""), encoding="utf-8")


def _bajar_portada(url: str, destino: Path) -> bool:
    # las portadas de Deezer salen al tamaño que se pida cambiando el NxN de la URL
    url = re.sub(r"/\d+x\d+-", "/720x720-", url)
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            datos = r.read()
    except OSError:
        return False
    if len(datos) < 2000 or not datos.startswith(b"\xff\xd8"):
        return False
    destino.write_bytes(datos)
    return True


def descargar_pedido(pedido: dict, avance=None) -> str | None:
    """Baja una canción elegida en «Descubrir». Devuelve el id de la pista o None."""
    avance = avance or (lambda f: None)
    PISTAS.mkdir(exist_ok=True)

    # ¿ya la tenemos? (bajada antes desde Deezer)
    if pedido.get("deezer"):
        for ficha in PISTAS.glob("*.json"):
            try:
                d = json.loads(ficha.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                continue
            if d.get("deezer") == pedido["deezer"] and ficha.with_suffix(".mp3").exists():
                return ficha.stem

    avance(0.02)
    vid = elegir_video(pedido)
    if not vid:
        return None
    pista = PISTAS / f"{vid}.mp3"
    if not pista.exists():
        _olvidar(vid)

        def al_bajar(d):
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                if total:
                    avance(0.05 + 0.8 * min(1, d.get("downloaded_bytes", 0) / total))
            elif d.get("status") == "finished":
                avance(0.88)

        def al_procesar(d):
            if d.get("status") == "started" and d.get("postprocessor") == "ExtractAudio":
                avance(0.92)

        extra = {
            "download_archive": str(ARCHIVO),
            "writethumbnail": True,
            "postprocessors": [
                {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"},
            ],
            "postprocessor_args": {
                "thumbnailsconvertor": ["-vf", "crop='min(iw,ih)':'min(iw,ih)',scale=600:600"],
            },
            "quiet": True, "no_warnings": True, "noprogress": True, "logger": _Callado(),
            "progress_hooks": [al_bajar], "postprocessor_hooks": [al_procesar],
        }
        import pedidos                                    # la calidad se elige en Ajustes
        calidad = "320" if pedidos.leer().get("calidad") == "alta" else "192"
        descargar_video.descargar(f"https://www.youtube.com/watch?v={vid}", solo_audio=True,
                                  destino=PISTAS, plantilla="%(id)s.%(ext)s", extra=extra,
                                  calidad=calidad)
    if not pista.exists():
        return None

    # la portada del disco pisa el fotograma del vídeo; si no baja, se queda el fotograma
    if pedido.get("portada"):
        _bajar_portada(pedido["portada"], PISTAS / f"{vid}.jpg")

    ficha = PISTAS / f"{vid}.json"
    if not ficha.exists():
        ficha.write_text(json.dumps({
            "id": vid,
            "titulo": pedido["titulo"],
            "artista": pedido["artista"],
            "album": pedido.get("album") or "",
            "duracion": pedido.get("duracion"),
            "origen": f"https://www.youtube.com/watch?v={vid}",
            "deezer": pedido.get("deezer"),
            "anadida": time.time(),
            # de Descubrir, salvo lo que llega de una lista importada (importar_lista.py)
            **({"lista": pedido["lista"]} if pedido.get("lista") else {}),
            **({} if pedido.get("importada") else {"descubierta": True}),
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    avance(1)
    return vid


def main() -> None:
    args = sys.argv[1:]
    if "--pedidos" in args:
        import pedidos
        n = pedidos.descargar_todo()
        print(f"\n{n} canciones nuevas.")
        return
    lista = None
    if "--lista" in args:                     # --lista "Nombre": las canciones van a esa lista aparte
        i = args.index("--lista")
        lista = args[i + 1] if i + 1 < len(args) else None
        args = args[:i] + args[i + 2:]
    consultas = args
    if not consultas:
        print(__doc__)
        return
    PISTAS.mkdir(exist_ok=True)
    fallos = []
    for c in consultas:
        print(f"\n== {c}")
        try:
            if not descargar(c, lista):
                fallos.append(c)
        except Exception as e:
            print(f"  ERROR {e}")
            fallos.append(c)
    print(f"\n{len(consultas) - len(fallos)} de {len(consultas)} descargadas.")
    for c in fallos:
        print(f"  falló: {c}")


if __name__ == "__main__":
    main()
