# Zonar CSV profile endpoint

## Endpoint

`POST /api/zonar/profile`

The endpoint is an initial ingestion/profile milestone. It reads a CSV in memory, returns a structural profile and suggested field mappings, and does not persist the upload or call an AI provider.

## Cloudflare secret

Configure a Worker secret named `ZONAR_UPLOAD_TOKEN` for the Neural Horizons AI Worker. Do not put this value in website JavaScript, HTML, GitHub, or a public environment variable.

The endpoint fails closed with HTTP 401 if the secret is absent or the request does not supply the matching bearer token.

## Request

Send a UTF-8 CSV body with:

- `Content-Type: text/csv`
- `Authorization: Bearer <your-token>`
- Optional `X-Filename: orders.csv`

Example using a local environment variable:

```bash
curl -X POST "https://www.neuralhorizonsai.com/api/zonar/profile" \
  -H "Authorization: Bearer $ZONAR_UPLOAD_TOKEN" \
  -H "Content-Type: text/csv" \
  -H "X-Filename: orders.csv" \
  --data-binary @orders.csv
```

## Limits

- 2 MB maximum request body
- 10,000 data rows
- 100 columns
- UTF-8 CSV
- Returns at most five preview rows and a sample of at most twenty malformed rows

## Response

Returns row and column counts, original headers, suggested mappings for common order/delivery/invoice fields, structural validation results, and a preview.

Validation currently covers blank and duplicate headers and rows whose field count differs from the header. It does not yet validate business rules, numeric values, dates, duplicate transactions, cross-file matching, or financial exposure.

## Tests

Run from the repository root with Node.js:

```bash
node --test tests/zonar-profile.test.mjs
```

The tests import the Worker module and exercise the endpoint locally. They do not deploy to Cloudflare.
