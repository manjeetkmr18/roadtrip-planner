#!/usr/bin/env bash
# End-to-end smoke test against a running API: register, create a trip, generate it, print a summary.
# Usage: API=http://localhost:4000/api ./scripts/smoke.sh [origin] [destination] [startDate] [endDate]
set -euo pipefail
API="${API:-http://localhost:4000/api}"
ORIGIN="${1:-Mississauga, ON}"
DEST="${2:-Ottawa, ON}"
START="${3:-$(date -d '+2 days' +%F)}"
END="${4:-$(date -d '+4 days' +%F)}"
EMAIL="smoke-$(date +%s)-$RANDOM@example.com"

j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

curl -sf -m 10 "$API/health" | j 'json.dumps(d)'
TOKEN=$(curl -sf -m 10 -X POST "$API/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | j "d['token']")
AUTH=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')

BODY=$(cat <<JSON
{"origin":{"address":"$ORIGIN"},"destination":{"address":"$DEST"},"startDate":"$START","endDate":"$END",
 "departureTime":"07:30","roundTrip":true,
 "vehicle":{"fuelType":"gasoline","consumptionPer100km":8.5,"has407Transponder":false},
 "preferences":{"pace":"balanced","maxDrivingHoursPerDay":6,"interests":["nature","history"]}}
JSON
)
TRIP=$(curl -sf -m 10 -X POST "$API/trips" "${AUTH[@]}" -d "$BODY" | j "d['id']")
echo "trip $TRIP"
curl -sf -m 10 -X POST "$API/trips/$TRIP/generate" "${AUTH[@]}" >/dev/null

for _ in $(seq 1 60); do
  STATUS=$(curl -sf -m 10 "$API/trips/$TRIP" "${AUTH[@]}" | j "d['status']")
  [[ "$STATUS" == ready || "$STATUS" == failed ]] && break
  sleep 2
done
echo "status $STATUS"
curl -sf -m 10 "$API/trips/$TRIP" "${AUTH[@]}" > /tmp/smoke-trip.json
python3 - <<'PY'
import json
t = json.load(open('/tmp/smoke-trip.json'))
if t['status'] != 'ready':
    raise SystemExit(f"FAILED: {t.get('error')}")
p = t['plan']
print(f"sample data: {p['usedSampleData']}  api cost: ${p['apiCostUsd']}")
for r in p['routes']:
    s = r['summary']
    print(f"route {r['label']:<12} {r['distanceMeters']/1000:7.0f} km  {r['durationSeconds']/3600:5.1f} h  "
          f"cost {s['low']:.0f}–{s['high']:.0f} (typical {s['typical']:.0f}) {s['currency']}  unknown={s['unknownLabels']}")
sel = next(r for r in p['routes'] if r['id'] == p['selectedRouteId'])
for c in sel['costs']:
    print(f"   {c['label']:<34} {c['low']} / {c['typical']} / {c['high']} {c['currency']}  [{c['confidence']}]")
for d in p['days']:
    w = d.get('weather') or {}
    print(f"day {d['day']} {d['date']} {d['startPlace']} → {d['endPlace']}  {d['drivingSeconds']/3600:.1f} h  "
          f"weather={w.get('rating')}  stops={[s['name'] + '@' + str(s.get('arrivalTime')) for s in d['stops']]}")
    if w: print(f"      {w.get('headline')}")
for i in p['issues']:
    print(f"issue [{i['severity']}] {i['code']}: {i['message']}")
for a in p['advisories']:
    print(f"advisory {a['country']}: {a['text']}")
for n in p['providerNotes']:
    print(f"note: {n}")
PY
