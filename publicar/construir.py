"""Arma la versión cifrada de Music (la app con tu música, tras una contraseña) para GitHub Pages.

    python publicar/construir.py                   con la clave guardada en publicar/clave.json
    python publicar/construir.py --clave "frase"   pone (o cambia) la contraseña; cada dispositivo la vuelve a pedir

El sitio queda en DESTINO, un repositorio git aparte y fuera de OneDrive (cientos de MB
de mp3 cifrados no pintan nada sincronizándose). Después: git add -A, commit y push.

Qué se publica: index.html (la puerta que pide la contraseña), sw.js (descifra al
vuelo), s.json (la sal), m.bin (el índice cifrado) y d/*.bin (cada fichero cifrado).
Ni títulos, ni nombres de fichero, ni la clave: clave.json se queda aquí, fuera de git.
"""

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
APP = AQUI.parent / "music"
DESTINO = Path.home() / "mimusica"
CLAVE = AQUI / "clave.json"
FICHEROS_APP = ("index.html", "music.css", "music.js", "textos.js", "manifest.webmanifest", "icono.png", "icono-180.png")

sys.path.insert(0, str(APP))
import servidor_music  # noqa: E402  (la misma lista de pistas que sirve el servidor)


def leer_clave(nueva: str | None) -> dict:
    if nueva:
        datos = {"clave": nueva, "sal": base64.b64encode(os.urandom(16)).decode()}
        CLAVE.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")
        return datos
    if not CLAVE.exists():
        sys.exit("Falta la contraseña: python publicar/construir.py --clave \"...\"")
    return json.loads(CLAVE.read_text(encoding="utf-8"))


def preparar_en_claro(dir_: Path) -> int:
    """Lo que verá la app bajo app/: sus ficheros, pistas.json, listas.json y las canciones."""
    for n in FICHEROS_APP:
        shutil.copy2(APP / n, dir_ / n)
    pistas = servidor_music.listar_pistas()
    (dir_ / "pistas.json").write_text(json.dumps(pistas, ensure_ascii=False), encoding="utf-8")
    listas = servidor_music.leer_listas()
    if listas:
        (dir_ / "listas.json").write_text(json.dumps(listas, ensure_ascii=False), encoding="utf-8")
    (dir_ / "pistas").mkdir()
    for p in pistas:
        for n in (p["audio"], p["portada"]):
            if n:
                shutil.copy2(servidor_music.PISTAS / n, dir_ / "pistas" / n)
    return len(pistas)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clave", help="contraseña nueva")
    args = ap.parse_args()
    clave = leer_clave(args.clave)

    DESTINO.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="music-claro-") as tmp:
        n = preparar_en_claro(Path(tmp))
        print(f"{n} canciones")
        subprocess.run(["node", str(AQUI / "cifrar.mjs"), tmp, str(DESTINO), clave["clave"], clave["sal"]], check=True)

    # la puerta, el descifrador y el icono para la pantalla de inicio (lo único en claro)
    shutil.copy2(AQUI / "entrada.html", DESTINO / "index.html")
    shutil.copy2(AQUI / "sw.js", DESTINO / "sw.js")
    for n in ("icono.png", "icono-180.png"):
        shutil.copy2(APP / n, DESTINO / n)
    (DESTINO / "manifest.webmanifest").write_text(json.dumps({
        "name": "Music", "short_name": "Music", "start_url": "./", "scope": "./", "display": "standalone",
        "orientation": "portrait", "background_color": "#0d1020", "theme_color": "#0d1020",
        "icons": [{"src": "icono-180.png", "sizes": "180x180", "type": "image/png"},
                  {"src": "icono.png", "sizes": "512x512", "type": "image/png"}],
    }, indent=2) + "\n", encoding="utf-8")
    (DESTINO / ".nojekyll").write_text("")
    (DESTINO / "README.md").write_text(
        "# Music\n\nReproductor personal. Todo el contenido está cifrado (AES-256-GCM) y se abre con contraseña.\n",
        encoding="utf-8")
    print(f"Listo en {DESTINO}")


if __name__ == "__main__":
    main()
