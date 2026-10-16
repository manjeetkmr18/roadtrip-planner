"""Rebuild src/data/airports.ts from OurAirports (public domain).

    curl -o /tmp/airports.csv https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv
    python3 scripts/build-airports.py /tmp/airports.csv

Keeps large and medium airports with scheduled passenger service and an IATA code.
"""
import csv
import json
import sys

rows = []
for r in csv.DictReader(open(sys.argv[1], encoding="utf-8")):
    if r["type"] not in ("large_airport", "medium_airport") or r["scheduled_service"] != "yes":
        continue
    iata = r["iata_code"].strip().upper()
    if len(iata) != 3 or not iata.isalpha():
        continue
    rows.append([iata, r["name"], r["municipality"], r["iso_country"], round(float(r["latitude_deg"]), 4),
                 round(float(r["longitude_deg"]), 4), "L" if r["type"] == "large_airport" else "M"])
rows.sort()

with open("src/data/airports.ts", "w", encoding="utf-8") as f:
    f.write("// Airports with scheduled passenger service, from OurAirports (public domain): https://ourairports.com/data/\n")
    f.write("// Rebuild with scripts/build-airports.py. Columns: IATA, name, city, country, lat, lng, size (L = large, M = medium).\n")
    f.write('export type AirportRow = [string, string, string, string, number, number, "L" | "M"];\n')
    f.write("export const AIRPORTS: AirportRow[] = " + json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + ";\n")
print(len(rows), "airports")
