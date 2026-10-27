"""Servidor local de Cozy. Lo usan el lanzador (Cozy.pyw) y servidor_dev.py.

Hace tres cosas que el http.server de serie no hace:

1. RANGE. Sin esto no se puede saltar dentro de una pista: el navegador pide
   un trozo por el medio del fichero y el servidor de serie le manda el
   fichero entero desde el principio. Con pistas de 12 horas eso significa
   que la barra de progreso no sirve para nada.

2. SIN CACHE. Si no, al añadir imagenes o pistas el navegador sigue viendo
   la lista vieja hasta un refresco a lo bruto.

3. MANIFIESTO AL VUELO. La lista de pistas e imagenes se genera al pedirla,
   asi que basta dejar un fichero en la carpeta. Antes habia que acordarse
   de ejecutar generar_manifiesto.py, que es el tipo de paso que se olvida.
"""

import functools
import http.server
import os
import re
from pathlib import Path

import generar_manifiesto

RUTA_MANIFIESTO = "/reproductor/manifiesto.js"
MANIFIESTO_VACIO = ("const PISTAS = [];\n"
                    "const IMAGENES = [];\n"
                    "const CONFIG_IMAGENES = {};\n")


class ManejadorCozy(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.split("?")[0] == RUTA_MANIFIESTO:
            return self._manifiesto()
        rango = self.headers.get("Range")
        if rango:
            return self._con_rango(rango)
        return super().do_GET()

    def do_HEAD(self):
        if self.path.split("?")[0] == RUTA_MANIFIESTO:
            return self._manifiesto(solo_cabecera=True)
        return super().do_HEAD()

    # ---- manifiesto generado al vuelo ------------------------------------
    def _manifiesto(self, solo_cabecera=False):
        try:
            texto, _, _ = generar_manifiesto.construir()
        except Exception:
            # pase lo que pase, el reproductor recibe algo con lo que arrancar
            texto = MANIFIESTO_VACIO
        datos = texto.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        if not solo_cabecera:
            self.wfile.write(datos)

    # ---- peticiones parciales (saltar dentro de una pista) ---------------
    def _con_rango(self, cabecera):
        ruta = self.translate_path(self.path)
        if os.path.isdir(ruta) or not os.path.isfile(ruta):
            return super().do_GET()

        total = os.path.getsize(ruta)
        m = re.match(r"bytes=(\d*)-(\d*)\s*$", cabecera.strip())
        if not m:
            self.send_error(400, "Range mal formado")
            return

        ini, fin = m.group(1), m.group(2)
        if ini == "":                       # "bytes=-500": los ultimos 500
            longitud = min(int(fin or 0), total)
            ini = total - longitud
            fin = total - 1
        else:
            ini = int(ini)
            fin = int(fin) if fin else total - 1

        if ini >= total or ini < 0:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.end_headers()
            return

        fin = min(fin, total - 1)
        longitud = fin - ini + 1

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(ruta))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {ini}-{fin}/{total}")
        self.send_header("Content-Length", str(longitud))
        self.end_headers()

        with open(ruta, "rb") as f:
            f.seek(ini)
            restante = longitud
            while restante > 0:
                trozo = f.read(min(64 * 1024, restante))
                if not trozo:
                    break
                try:
                    self.wfile.write(trozo)
                except (BrokenPipeError, ConnectionResetError):
                    # normal: el navegador corta al saltar a otro punto
                    return
                restante -= len(trozo)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        # hace falta para que el navegador se atreva a pedir trozos sueltos
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, *args):
        pass


def crear(raiz, puerto=8934):
    manejador = functools.partial(ManejadorCozy, directory=str(raiz))
    return http.server.ThreadingHTTPServer(("127.0.0.1", puerto), manejador)


if __name__ == "__main__":
    import sys
    raiz = Path(__file__).parent
    sys.path.insert(0, str(raiz))
    s = crear(raiz)
    print("Sirviendo COZY en http://127.0.0.1:8934 (sin cache, con Range)")
    s.serve_forever()
