"""Mete en la cola de descargas las canciones de una lista de texto y las baja.

El formato es el de la lista que saca la app (una sección por lista):

    BIBLIOTECA (56)
    ----------------------------------------
    2Pac - Dear Mama [4:36]
    ...
    Prueba · Swing y crooners (12)
    ----------------------------------------
    Glenn Miller - In the Mood [3:22]

Cada canción busca en Deezer su portada y su disco (si el artista coincide) y se
apunta como pedido, con la duración de la lista: así, al elegir el vídeo, gana
la versión que dura lo mismo (la "Full Length", el directo de 1985...).

Uso:
    python importar_lista.py lista.txt              apunta y descarga
    python importar_lista.py lista.txt --solo-cola  solo apunta (se bajan con la app)
"""

import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import pedidos
from descargar_musica import _norm

CANCION = re.compile(r"^(.+?)\s+-\s+(.+?)\s*\[(\d+):(\d{2})\]\s*$")
SECCION = re.compile(r"^(.+?)\s*\(\d+\)\s*$")


def leer_lista(texto: str) -> list[dict]:
    # sin líneas vacías: los finales de línea de Windows (\r\r\n) meten huecos de más
    lineas = [l.strip() for l in re.split(r"[\r\n]+", texto) if l.strip()]
    lista, canciones = "", []
    for i, linea in enumerate(lineas):
        siguiente = lineas[i + 1] if i + 1 < len(lineas) else ""
        if linea and set(siguiente) == {"-"}:              # cabecera de sección
            m = SECCION.match(linea)
            nombre = (m.group(1) if m else linea).strip()
            nombre = nombre.split(" · ")[-1].strip()        # "Prueba · Swing y crooners" -> "Swing y crooners"
            lista = "" if nombre.casefold() == "biblioteca" else nombre
            continue
        m = CANCION.match(linea)
        if m:
            canciones.append({"artista": m.group(1).strip(), "titulo": m.group(2).strip(),
                              "duracion": int(m.group(3)) * 60 + int(m.group(4)), "lista": lista})
    return canciones


def deezer(c: dict) -> dict | None:
    """La ficha de Deezer de la canción, si se encuentra una del mismo artista."""
    titulo = re.sub(r"\s*[\(\[].*?[\)\]]", "", c["titulo"])
    titulo = re.split(r"\s+(?:ft\.?|feat\.?)\s+", titulo, flags=re.IGNORECASE)[0]
    artista = re.split(r"\s+(?:x|ft\.?|feat\.?)\s+", c["artista"], flags=re.IGNORECASE)[0]
    q = urllib.parse.quote(f"{artista} {titulo}")
    try:
        with urllib.request.urlopen(f"https://api.deezer.com/search?q={q}&limit=10", timeout=15) as r:
            datos = json.loads(r.read()).get("data") or []
    except (OSError, ValueError):
        return None
    a, tt = _norm(artista), _norm(titulo)
    buenas = [d for d in datos if a and (a in _norm(d["artist"]["name"]) or _norm(d["artist"]["name"]) in a)
              and tt and tt in _norm(d["title"])]
    if not buenas:
        return None
    return min(buenas, key=lambda d: abs((d.get("duration") or 0) - c["duracion"]))


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    canciones = leer_lista(Path(args[0]).read_text(encoding="utf-8-sig"))
    print(f"{len(canciones)} canciones en la lista")
    for c in canciones:
        d = deezer(c)
        clave = hashlib.md5(f"{c['artista']}|{c['titulo']}".encode()).hexdigest()[:14]
        pedido = {"id": f"im{clave}", "titulo": c["titulo"], "artista": c["artista"],
                  "duracion": c["duracion"], "importada": True}
        if c["lista"]:
            pedido["lista"] = c["lista"]
        if d:
            pedido.update(album=d["album"]["title"], portada=d["album"].get("cover_xl") or "",
                          mini=d["album"].get("cover_medium") or "")
            if abs((d.get("duration") or 0) - c["duracion"]) <= 6:
                pedido["deezer"] = d["id"]               # es esa versión: así no se baja dos veces
        pedidos.anadir(pedido)
        print(f"  {'+' if d else '·'} {c['artista']} - {c['titulo']}" + (f"  [{c['lista']}]" if c["lista"] else ""))
    if "--solo-cola" in args:
        return
    print("\nDescargando...")
    n = pedidos.descargar_todo()
    print(f"\n{n} canciones nuevas.")


if __name__ == "__main__":
    main()
