import http.server
import socketserver
import pathlib
import os

PORT = 8766
ROOT = pathlib.Path(__file__).resolve().parent

os.chdir(ROOT)

class Handler(http.server.SimpleHTTPRequestHandler):
    pass

with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"Serving {ROOT} at http://127.0.0.1:{PORT}")
    httpd.serve_forever()
