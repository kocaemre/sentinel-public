#!/usr/bin/env bash
# One-shot Cloudflare named-tunnel provisioning via API token (remotely-managed tunnel).
# Run on the box: ssh ... 'bash -s' < deploy/cf-tunnel-setup.sh
set -euo pipefail
export LC_ALL=C.UTF-8
. /etc/sentinel-cf.env            # CF_API_TOKEN

A=71b8b676a0dfc4e4b6f1ee70176d0d93         # account id
Z=6951a3b9a7500fcf77edf8dd4846d895         # zone id (0xemrek.dev)
HOST=sentinel.0xemrek.dev
SUB=sentinel
SVC=http://localhost:8787
API=https://api.cloudflare.com/client/v4
AUTH="Authorization: Bearer ${CF_API_TOKEN}"
CT="Content-Type: application/json"

pj() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

echo "=== auth/list tunnels named sentinel ==="
LIST=$(curl -s "$API/accounts/$A/cfd_tunnel?name=sentinel&is_deleted=false" -H "$AUTH")
echo "$LIST" | pj "print('success',d['success']);print('errors',d.get('errors'))"
TID=$(echo "$LIST" | pj "r=d.get('result') or [];print(r[0]['id'] if r else '')")

if [ -z "$TID" ]; then
  echo "=== create tunnel 'sentinel' (remotely-managed) ==="
  CREATE=$(curl -s -X POST "$API/accounts/$A/cfd_tunnel" -H "$AUTH" -H "$CT" \
    --data '{"name":"sentinel","config_src":"cloudflare"}')
  echo "$CREATE" | pj "print('success',d['success']);print('errors',d.get('errors'))"
  TID=$(echo "$CREATE" | pj "print((d.get('result') or {}).get('id',''))")
fi
echo "tunnel id: $TID"
[ -n "$TID" ] || { echo "ABORT: no tunnel id"; exit 1; }

echo "=== connector token ==="
TOKRESP=$(curl -s "$API/accounts/$A/cfd_tunnel/$TID/token" -H "$AUTH")
CTOKEN=$(echo "$TOKRESP" | pj "print(d.get('result','') if d.get('success') else '')")
[ -n "$CTOKEN" ] || { echo "ABORT: no connector token: $TOKRESP"; exit 1; }
echo "connector token length: ${#CTOKEN}"

echo "=== set ingress: $HOST -> $SVC ==="
CFG=$(curl -s -X PUT "$API/accounts/$A/cfd_tunnel/$TID/configurations" -H "$AUTH" -H "$CT" \
  --data "{\"config\":{\"ingress\":[{\"hostname\":\"$HOST\",\"service\":\"$SVC\"},{\"service\":\"http_status:404\"}]}}")
echo "$CFG" | pj "print('success',d['success']);print('errors',d.get('errors'))"

echo "=== DNS CNAME $HOST -> $TID.cfargotunnel.com (proxied) ==="
EX=$(curl -s "$API/zones/$Z/dns_records?type=CNAME&name=$HOST" -H "$AUTH")
RID=$(echo "$EX" | pj "r=d.get('result') or [];print(r[0]['id'] if r else '')")
BODY="{\"type\":\"CNAME\",\"name\":\"$SUB\",\"content\":\"$TID.cfargotunnel.com\",\"proxied\":true}"
if [ -z "$RID" ]; then
  DNS=$(curl -s -X POST "$API/zones/$Z/dns_records" -H "$AUTH" -H "$CT" --data "$BODY")
else
  DNS=$(curl -s -X PUT "$API/zones/$Z/dns_records/$RID" -H "$AUTH" -H "$CT" --data "$BODY")
fi
echo "$DNS" | pj "print('success',d['success']);print('errors',d.get('errors'));print('name',(d.get('result') or {}).get('name'))"

echo "=== install cloudflared service (token-run) ==="
sudo cloudflared service install "$CTOKEN" >/tmp/cf_svc.log 2>&1 || true
tail -4 /tmp/cf_svc.log || true
sudo systemctl enable --now cloudflared >/dev/null 2>&1 || true
sleep 6
echo "cloudflared active: $(systemctl is-active cloudflared)"

echo "=== tunnel health ==="
curl -s "$API/accounts/$A/cfd_tunnel/$TID" -H "$AUTH" | pj "r=d.get('result') or {};print('status',r.get('status'),'connections',len(r.get('connections') or []))"
echo "DONE"
