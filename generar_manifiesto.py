"""Genera la lista de mp3 e imagenes que usa el reproductor (reproductor/manifiesto.js).

Ejecuta este script cada vez que añadas o quites mp3 de COZY, o imagenes en
reproductor/imagenes, para que el reproductor se entere.

Uso:
    python generar_manifiesto.py
"""

import json
from pathlib import Path

RAIZ = Path(__file__).parent
CARPETA_IMAGENES = RAIZ / "reproductor" / "imagenes"
CONFIG_IMAGENES = CARPETA_IMAGENES / "config.json"
SALIDA = RAIZ / "reproductor" / "manifiesto.js"

EXT_AUDIO = {".mp3"}
EXT_IMAGEN = {".webp", ".png", ".jpg", ".jpeg", ".gif"}


def listar_pistas():
    return sorted(
        p.name for p in RAIZ.iterdir() if p.is_file() and p.suffix.lower() in EXT_AUDIO
    )


def listar_imagenes():
    if not CARPETA_IMAGENES.exists():
        return []
    return sorted(
        p.name
        for p in CARPETA_IMAGENES.iterdir()
        if p.is_file() and p.suffix.lower() in EXT_IMAGEN
    )


def leer_config():
    """Devuelve la config de efectos. Si el JSON esta roto NO revienta:
    el reproductor debe seguir sonando aunque alguien deje una coma de mas
    editando el fichero a mano. Sin config, las imagenes salen sin efectos."""
    if not CONFIG_IMAGENES.exists():
        return {}
    try:
        datos = json.loads(CONFIG_IMAGENES.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(datos, dict):
        return {}
    datos.pop("_ayuda", None)
    return datos


def construir():
    """El contenido de manifiesto.js como texto.

    Lo usan dos sitios: este script (que lo escribe a fichero) y el servidor
    del lanzador (que lo sirve al vuelo). Una sola fuente de verdad, para que
    no puedan decir cosas distintas.
    """
    pistas = listar_pistas()
    imagenes = listar_imagenes()
    config = leer_config()
    texto = (
        "// Generado automaticamente -- no editar a mano\n"
        f"const PISTAS = {json.dumps(pistas, ensure_ascii=False, indent=2)};\n"
        f"const IMAGENES = {json.dumps(imagenes, ensure_ascii=False, indent=2)};\n"
        f"const CONFIG_IMAGENES = {json.dumps(config, ensure_ascii=False, indent=2)};\n"
    )
    return texto, len(pistas), len(imagenes)


def main():
    contenido, n_pistas, n_imagenes = construir()
    SALIDA.write_text(contenido, encoding="utf-8")
    print(f"{n_pistas} pistas y {n_imagenes} imagenes escritas en {SALIDA}")


if __name__ == "__main__":
    main()
