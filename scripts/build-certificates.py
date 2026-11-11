#!/usr/bin/env python3
"""Build dist/verify/certificates.json from a CSV exported from the AI Agent Lab tracker.

CSV columns (header row required): id,name,type,date
  id    e.g. AAL-C1-2026-0001  (the Certificate ID column in the tracker)
  name  the name printed on the certificate
  type  Certificate of Completion | Certificate of Achievement
  date  the date printed on the certificate

Usage: python3 scripts/build-certificates.py issued.csv

Records are keyed by the SHA-256 of the upper-case ID, so the IDs themselves are not
published. Names and dates still are, so only include people who have been issued a
certificate. Keep the sample record to test the page.
"""
import csv, hashlib, json, sys

def key(i):
    return hashlib.sha256(i.strip().upper().replace(' ', '').encode()).hexdigest()

records = {
    key('AAL-DEMO-0000'): {
        'name': 'Sample Student',
        'type': 'Certificate of Completion',
        'programme': 'AI Agent Lab (Neural Horizons AI)',
        'date': 'Sample only',
        'note': 'This is a sample record used to test the page. It is not a real certificate.'
    }
}
if len(sys.argv) > 1:
    with open(sys.argv[1], newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            if not row.get('id'):
                continue
            records[key(row['id'])] = {
                'name': row['name'].strip(),
                'type': row['type'].strip(),
                'programme': 'AI Agent Lab (Neural Horizons AI)',
                'date': row['date'].strip(),
            }
json.dump({'records': records}, open('dist/verify/certificates.json', 'w'), indent=1)
print(len(records), 'records written')
