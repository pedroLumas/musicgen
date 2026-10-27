"""Lanzador de Music: levanta su servidor y abre la app en una ventana de móvil.

Se ejecuta con pythonw.exe (extension .pyw), igual que Cozy.pyw. Al cerrar la
ventana, el servidor se apaga solo; si quedan canciones elegidas en «Descubrir»
(y la opcion esta puesta), se bajan en un proceso aparte que sigue sin ventana.

    Music.pyw          solo en este ordenador
    Music.pyw --lan    ademas abierto a la red local, para oirlo desde el movil
                       (http://<IP de este PC>:8935; Windows pedira permiso la 1a vez)
"""

import socket
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

RAIZ = Path(__file__).parent
sys.path.insert(0, str(RAIZ / "music"))
import servidor_music  # noqa: E402  (necesita music/ en sys.path)
import pedidos  # noqa: E402

PUERTO = servidor_music.PUERTO
URL = f"http://127.0.0.1:{PUERTO}/index.html"

CANDIDATOS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    str(Path.home() / r"AppData\Local\Google\Chrome\Application\chrome.exe"),
]


def puerto_ocupado(puerto):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", puerto)) == 0


def abrir_ventana():
    for ruta in CANDIDATOS:
        if Path(ruta).exists():
            return subprocess.Popen([
                ruta,
                f"--app={URL}",
                "--window-size=430,880",
                # perfil aparte y FUERA de music/, que es lo unico que se sirve
                f"--user-data-dir={RAIZ / '.navegador_music'}",
            ])
    webbrowser.open(URL)
    return None


def main():
    srv = None
    if not puerto_ocupado(PUERTO):
        try:
            srv = servidor_music.crear(PUERTO, lan="--lan" in sys.argv)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        except OSError:
            pass  # lo ha levantado otro justo ahora; seguimos igual

    proceso = abrir_ventana()
    if proceso is not None:
        proceso.wait()
    else:
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass

    if srv is not None:
        srv.shutdown()
        try:
            if pedidos.leer()["al_cerrar"]:
                pedidos.lanzar()
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
