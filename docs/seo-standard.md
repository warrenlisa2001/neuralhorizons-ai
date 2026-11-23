# SEO, meta and AI-readiness standard

Every page in `dist/` must have, before it is merged:

1. A unique `<title>` (aim for 70 characters or fewer) and a meta description of 70 to 320 characters.
2. A canonical URL that matches the page's own address.
3. Open Graph tags (title, description, url, image) and `twitter:card`.
4. Exactly one `<h1>`.
5. Valid JSON-LD (Organization or Article, plus FAQPage and BreadcrumbList where the page has them).
6. An entry in `dist/sitemap.xml`, unless the page is `noindex`.
7. An answer-first opening (a short, quotable definition) on product, sector and guide pages, with FAQs written as complete sentences.

Site-wide files that must stay in place: `dist/robots.txt` (AI and search crawlers allowed, sitemap listed), `dist/llms.txt` (key pages with one-line descriptions) and `dist/sitemap.xml`.

Run the check locally: `python3 scripts/seo-check.py` (add `--strict` to fail on warnings). The same check runs on every pull request through `.github/workflows/seo-check.yml`; errors block, warnings are advice.

When you add a page, add it to the sitemap and, if it is a product, sector or guide page, to `llms.txt`.
