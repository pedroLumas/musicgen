"""Descargador de vídeos (o solo audio) de YouTube a esta misma carpeta (COZY).

Uso:
    python descargar_video.py <url> [<url2> ...]        -> descarga vídeo completo
    python descargar_video.py --audio <url> [<url2> ...] -> descarga solo el audio (mp3)
    python descargar_video.py                             -> lo pregunta interactivamente

Soporta vídeos largos: yt-dlp descarga por fragmentos y ffmpeg fusiona
el mejor vídeo y el mejor audio disponibles (o extrae y convierte el audio).
"""

import sys
from pathlib import Path

import yt_dlp

CARPETA_DESTINO = Path(__file__).parent


def _buscar_ffmpeg():
    """La carpeta bin de ffmpeg instalado con winget; sin él, None y yt-dlp lo busca en el PATH."""
    paquetes = Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Packages"
    for ffmpeg in paquetes.glob("Gyan.FFmpeg*/*/bin/ffmpeg.exe"):
        return str(ffmpeg.parent)
    return None


FFMPEG = _buscar_ffmpeg()


def descargar(url: str, solo_audio: bool = False, destino: Path | None = None,
              plantilla: str = "%(title)s.%(ext)s", extra: dict | None = None, calidad: str = "192"):
    """Descarga y devuelve la info del vídeo (la usa la subapp music/).

    destino/plantilla/extra/calidad son opcionales: sin ellos hace lo de siempre.
    Los postprocessors de `extra` se añaden detrás de los propios.
    """
    destino = destino or CARPETA_DESTINO
    if solo_audio:
        opciones = {
            "outtmpl": str(destino / plantilla),
            "format": "bestaudio/best",
            "ffmpeg_location": FFMPEG,
            "noplaylist": True,
            "concurrent_fragment_downloads": 4,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": calidad,
                }
            ],
        }
    else:
        opciones = {
            "outtmpl": str(destino / plantilla),
            "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "merge_output_format": "mp4",
            "ffmpeg_location": FFMPEG,
            "noplaylist": True,
            "concurrent_fragment_downloads": 4,
        }
    if extra:
        extra = dict(extra)
        opciones.setdefault("postprocessors", []).extend(extra.pop("postprocessors", []))
        opciones.update(extra)
    with yt_dlp.YoutubeDL(opciones) as ydl:
        return ydl.extract_info(url, download=True)


def main() -> None:
    args = sys.argv[1:]

    solo_audio = "--audio" in args
    urls = [a for a in args if a != "--audio"]

    if not urls:
        entrada = input("URL del vídeo de YouTube: ").strip()
        if not entrada:
            print("No se ha dado ninguna URL.")
            return
        urls = [entrada]
        if not solo_audio:
            respuesta = input("¿Solo audio? (s/N): ").strip().lower()
            solo_audio = respuesta == "s"

    for url in urls:
        tipo = "audio" if solo_audio else "vídeo"
        print(f"\nDescargando {tipo}: {url}")
        try:
            descargar(url, solo_audio)
        except Exception as e:
            print(f"Error descargando {url}: {e}")

    print(f"\nListo. Ficheros en: {CARPETA_DESTINO}")


if __name__ == "__main__":
    main()
