"""Mete en la cola de descargas las canciones de una lista de texto y las baja.

Entiende tres tipos de línea (se pueden mezclar):

    2Pac - Dear Mama [4:36]                       la lista que saca la app (con duración)
    1. Nas - I Can  (deezer.com/track/15487960)   la que manda «Enviar» en Descubrir
    Polo G - Pop Out                              una a mano: se busca en Deezer

Y secciones, una por lista:

    BIBLIOTECA (56)
    ----------------------------------------
    Prueba · Swing y crooners (12)
    ----------------------------------------

Cada canción toma de Deezer su portada y su disco (si el artista coincide) y se
apunta como pedido con su duración: al elegir el vídeo gana la versión que dura
lo mismo (la "Full Length", el directo de 1985...).

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
ENLACE = re.compile(r"deezer\.com/(?:\w+/)?track/(\d+)")
SUELTA = re.compile(r"^(?:\d+[.)]\s*)?(.+?)\s+[-–—]\s+(.+?)\s*$")
SECCION = re.compile(r"^(.+?)\s*\(\d+\)\s*$")


def leer_lista(texto: str) -> list[dict]:
    # sin líneas vacías: los finales de línea de Windows (\r\r\n) meten huecos de más
    lineas = [l.strip() for l in re.split(r"[\r\n]+", texto) if l.strip()]
    lista, canciones = "", []
    for i, linea in enumerate(lineas):
        siguiente = lineas[i + 1] if i + 1 < len(lineas) else ""
        if set(linea) == {"-"}:
            continue
        if set(siguiente) == {"-"}:                          # cabecera de sección
            m = SECCION.match(linea)
            nombre = (m.group(1) if m else linea).strip()
            nombre = nombre.split(" · ")[-1].strip()        # "Prueba · Swing y crooners" -> "Swing y crooners"
            lista = "" if nombre.casefold() == "biblioteca" else nombre
            continue
        m = ENLACE.search(linea)
        if m:
            canciones.append({"deezer": int(m.group(1)), "lista": lista})
            continue
        m = CANCION.match(linea)
        if m:
            canciones.append({"artista": m.group(1).strip(), "titulo": m.group(2).strip(),
                              "duracion": int(m.group(3)) * 60 + int(m.group(4)), "lista": lista})
            continue
        m = SUELTA.match(linea)
        if m:
            canciones.append({"artista": m.group(1).strip(), "titulo": m.group(2).strip(), "duracion": 0, "lista": lista})
    return canciones


def _deezer_get(ruta: str):
    try:
        with urllib.request.urlopen("https://api.deezer.com" + ruta, timeout=15) as r:
            datos = json.loads(r.read())
    except (OSError, ValueError):
        return None
    return None if "error" in datos else datos


def deezer(c: dict) -> dict | None:
    """La ficha de Deezer de la canción, si se encuentra una del mismo artista."""
    titulo = re.sub(r"\s*[\(\[].*?[\)\]]", "", c["titulo"])
    titulo = re.split(r"\s+(?:ft\.?|feat\.?)\s+", titulo, flags=re.IGNORECASE)[0]
    artista = re.split(r"\s+(?:x|&|ft\.?|feat\.?)\s+", c["artista"], flags=re.IGNORECASE)[0]
    datos = (_deezer_get("/search?q=" + urllib.parse.quote(f"{artista} {titulo}") + "&limit=10") or {}).get("data") or []
    a, tt = _norm(artista), _norm(titulo)
    buenas = [d for d in datos if a and (a in _norm(d["artist"]["name"]) or _norm(d["artist"]["name"]) in a)
              and tt and tt in _norm(d["title"])]
    if not buenas:
        return None
    if not c["duracion"]:                                    # sin duración: la que Deezer da primero
        return buenas[0]
    return min(buenas, key=lambda d: abs((d.get("duration") or 0) - c["duracion"]))


def pedido_de(c: dict) -> dict | None:
    if "deezer" in c:                                        # ya viene con su ficha de Deezer
        d = _deezer_get(f"/track/{c['deezer']}")
        if not d:
            return None
        p = {"id": f"dz{d['id']}", "deezer": d["id"], "titulo": d["title"], "artista": d["artist"]["name"],
             "duracion": d.get("duration") or 0}
    else:
        d = deezer(c)
        clave = hashlib.md5(f"{c['artista']}|{c['titulo']}".encode()).hexdigest()[:14]
        p = {"id": f"im{clave}", "titulo": c["titulo"], "artista": c["artista"],
             "duracion": c["duracion"] or (d or {}).get("duration") or 0}
        if d and (not c["duracion"] or abs((d.get("duration") or 0) - c["duracion"]) <= 6):
            p["deezer"] = d["id"]                            # es esa versión: así no se baja dos veces
            if not c["duracion"]:                            # a mano: el título bueno es el de Deezer
                p.update(id=f"dz{d['id']}", titulo=d["title"], artista=d["artist"]["name"])
    if d:
        p.update(album=d["album"]["title"], portada=d["album"].get("cover_xl") or "",
                 mini=d["album"].get("cover_medium") or "")
    p["importada"] = True
    if c["lista"]:
        p["lista"] = c["lista"]
    return p


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    canciones = leer_lista(Path(args[0]).read_text(encoding="utf-8-sig"))
    print(f"{len(canciones)} canciones en la lista")
    for c in canciones:
        p = pedido_de(c)
        if not p:
            print(f"  ✗ no está en Deezer: {c}")
            continue
        pedidos.anadir(p)
        print(f"  {'+' if p.get('portada') else '·'} {p['artista']} - {p['titulo']}" + (f"  [{p['lista']}]" if p.get("lista") else ""))
    if "--solo-cola" in args:
        return
    print("\nDescargando...")
    n = pedidos.descargar_todo()
    print(f"\n{n} canciones nuevas.")


if __name__ == "__main__":
    main()
