import http.server
import socketserver
import os
import sys
import urllib.request
import urllib.parse
import re
import json

PORT = 5173

# In-memory cache for EPC and Land Registry lookups
epc_cache = {}
epc_details_cache = {}
lr_cache = {}

def get_landregistry(postcode):
    norm = postcode.strip().replace(' ', '+').upper()
    if norm in lr_cache:
        return lr_cache[norm]

    url = f"https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode={norm}&_pageSize=100"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            content = resp.read()
            lr_cache[norm] = content
            return content
    except Exception as e:
        err_json = json.dumps({"error": str(e), "result": {"items": []}}).encode('utf-8')
        return err_json

def proxy_postcodes(path_and_query):
    # e.g. path_and_query = /api/postcodes/SW111TH or /api/postcodes?lon=...
    subpath = path_and_query.replace('/api/postcodes', '', 1)
    url = f"https://api.postcodes.io/postcodes{subpath}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.read()
    except Exception as e:
        return json.dumps({"status": 500, "error": str(e)}).encode('utf-8')

def get_epc_postcode(postcode):
    norm = postcode.strip().upper()
    if norm in epc_cache:
        return epc_cache[norm]

    encoded = urllib.parse.quote(norm)
    url = f"https://find-energy-certificate.service.gov.uk/find-a-certificate/search-by-postcode?postcode={encoded}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode('utf-8')
    except Exception as e:
        return {'error': str(e), 'certificates': []}

    rows = re.findall(r'<tr class="govuk-table__row">(.*?)</tr>', html, re.DOTALL)
    certs = []
    for r in rows:
        link_m = re.search(r'href="(/energy-certificate/([\d\-]+))"', r)
        addr_m = re.search(r'>([^<]+)</a>', r)
        rating_m = re.search(r'govuk-tag[^>]*>([^<]+)</span>', r)
        if link_m and addr_m:
            certs.append({
                'certId': link_m.group(2),
                'path': link_m.group(1),
                'address': addr_m.group(1).strip().replace('&#39;', "'"),
                'rating': rating_m.group(1).strip() if rating_m else ''
            })

    result = {'postcode': norm, 'total': len(certs), 'certificates': certs}
    epc_cache[norm] = result
    return result

def get_epc_details(cert_id):
    if cert_id in epc_details_cache:
        return epc_details_cache[cert_id]

    url = f"https://find-energy-certificate.service.gov.uk/energy-certificate/{cert_id}"
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode('utf-8')
    except Exception as e:
        return {'error': str(e)}

    floor_m = re.search(r'Total floor area.*?(\d+[\.,]?\d*)\s*square metres', html, re.DOTALL | re.IGNORECASE)
    floor_area = float(floor_m.group(1).replace(',', '')) if floor_m else None

    pt_m = re.search(r'<dt[^>]*>\s*Property type\s*</dt>\s*<dd[^>]*>(.*?)</dd>', html, re.DOTALL | re.IGNORECASE)
    prop_type = re.sub(r'<[^>]+>', '', pt_m.group(1)).strip() if pt_m else None

    rating_m = re.search(r'<span class="govuk-tag[^"]*">([A-G])</span>', html)
    rating = rating_m.group(1).strip() if rating_m else ''

    result = {
        'certId': cert_id,
        'floorAreaM2': floor_area,
        'floorAreaSqFt': round(floor_area * 10.7639) if floor_area else None,
        'propertyType': prop_type,
        'rating': rating,
        'url': url
    }
    epc_details_cache[cert_id] = result
    return result

class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)

            if parsed.path == '/api/landregistry':
                postcode = qs.get('postcode', [''])[0]
                data = get_landregistry(postcode)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
                return

            elif parsed.path.startswith('/api/postcodes'):
                data = proxy_postcodes(self.path)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
                return

            elif parsed.path == '/api/epc':
                postcode = qs.get('postcode', [''])[0]
                data = get_epc_postcode(postcode)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            elif parsed.path == '/api/epc-details':
                cert_id = qs.get('certId', [''])[0]
                data = get_epc_details(cert_id)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(data).encode('utf-8'))
                return

            super().do_GET()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            print("Request error:", e)

    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

def run():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with ThreadedHTTPServer(("", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}"
        print(f"\n=======================================================")
        print(f" UK House Price History App is running!")
        print(f" URL: {url}")
        print(f" Multi-threaded HTTP server with auto connection cleanup.")
        print(f"=======================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == '__main__':
    run()
