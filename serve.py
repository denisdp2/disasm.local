#!/usr/bin/env python3
"""
disasm.local launcher.

Serves this folder over HTTP so the browser can fetch the WASM engines
(WebAssembly can't load from a file:// URL). No dependencies — just Python 3.

  python3 serve.py                 # LAN: binds all interfaces, port 8000
  python3 serve.py 9000            # pick a port
  python3 serve.py --local         # localhost only (old behaviour)
  python3 serve.py --host 0.0.0.0 --port 8080

It prints the URL other machines on your network should use. Ctrl+C to stop.
"""
import argparse
import http.server
import os
import socket
import socketserver

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    # Serve .wasm with the right MIME type so the browser can stream-compile it.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".ico": "image/x-icon",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One-line access log so you can see who's connecting on the LAN.
        print(f"  {self.address_string()} - {fmt % args}")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ip():
    """Best-effort detection of this machine's LAN address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packets are actually sent; this just picks the outbound interface.
        s.connect(("192.168.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return None
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--host", default=None,
                    help="bind address (default 0.0.0.0 = whole LAN)")
    ap.add_argument("--port", dest="port_opt", type=int, default=None)
    ap.add_argument("--local", action="store_true",
                    help="bind 127.0.0.1 only (this computer)")
    args = ap.parse_args()

    port = args.port_opt or args.port
    host = args.host or ("127.0.0.1" if args.local else "0.0.0.0")

    with Server((host, port), Handler) as httpd:
        print(f"disasm.local — serving on {host}:{port}\n")
        print("  this machine :  http://localhost:%d/" % port)
        if host != "127.0.0.1":
            ip = lan_ip()
            if ip:
                print("  on your LAN  :  http://%s:%d/   <-- open this on other devices" % (ip, port))
            print("\n  (if other devices can't reach it, open the port in your firewall)")
        print("\nCtrl+C to stop.\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")


if __name__ == "__main__":
    main()
