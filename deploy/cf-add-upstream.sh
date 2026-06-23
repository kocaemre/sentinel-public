#!/usr/bin/env bash
# Add a second public hostname (upstream.0xemrek.dev -> localhost:4021 mock x402)
# to the existing Sentinel cloudflared tunnel, keeping the sentinel.0xemrek.dev rule.
set -euo pipefail
export LC_ALL=C.UTF-8
. /etc/sentinel-cf.env            # CF_API_TOKEN

A=71b8b676a0dfc4e4b6f1ee70176d0d93
TID=de079e57-eb56-4442-b055-bc8044d6e3ef
API=https://api.cloudflare.com/client/v4
AUTH="Authorization: Bearer ${CF_API_TOKEN}"
CT="Content-Type: application/json"

echo "=== set ingress: sentinel->8787 + upstream->4021 + 404 ==="
RESP=$(curl -s -X PUT "$API/accounts/$A/cfd_tunnel/$TID/configurations" -H "$AUTH" -H "$CT" --data '{
  "config": {
    "ingress": [
      { "hostname": "sentinel.0xemrek.dev", "service": "http://localhost:8787" },
      { "hostname": "upstream.0xemrek.dev", "service": "http://localhost:4021" },
      { "service": "http_status:404" }
    ]
  }
}')
echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print('success',d['success']);print('errors',d.get('errors'));ing=((d.get('result') or {}).get('config') or {}).get('ingress');print('ingress',[ (r.get('hostname'),r.get('service')) for r in (ing or [])])"
echo "DONE"
