# Neural Horizons AI — Site Mirror

Downloaded from Cloudflare Pages deployment on $(date -u +%Y-%m-%d).

## Source
- **Deployment URL**: https://27ae112d.neuralhorizons-ai.pages.dev
- **Production aliases**: www.neuralhorizonsai.com, neuralhorizons-ai.pages.dev
- **Cloudflare Pages project**: neuralhorizons-ai
- **Build output dir**: /dist (matches this folder)

## Contents
- **36 HTML pages** — every URL listed in sitemap.xml, each saved as `<path>/index.html`
- **15 images** — all images referenced from page `<img>` tags and `og:image` meta tags
- **1 third-party JS** (Cloudflare email-decode helper)
- **robots.txt** + **sitemap.xml**

## Important Notes
1. **This is the SERVED output**, not the original source code.
   - If your original site was built from React/Vue/Astro/Next/etc., this mirror contains the *compiled HTML* only.
   - To restore full source, you need: (a) Git repo, (b) original VM filesystem (lost), or (c) reconstruct from the rendered HTML.
2. **Image file extensions are misleading**: Cloudflare's image-optimization layer transcoded several `.png` files to JPEG on the wire — the bytes are JPEG but the filename keeps `.png`. Browsers handle this via Content-Type, but if you process them locally, check with `file <name>`.
3. **Inline tracking code is preserved**: GTM (`GTM-583T68TS`), GA4 (`G-369867907`), HubSpot (`146667855`) tags are embedded in every page.
4. **Forms / dynamic widgets**: The HubSpot chat widget is intentionally suppressed in favor of a custom "Nova" chat. Any form actions point to the production domain.

## How to redeploy this exact mirror
- Upload this `site/` folder via Cloudflare Pages → "Direct upload" to create a new deployment.
- Or `wrangler pages deploy site/` if you have the Cloudflare CLI.
