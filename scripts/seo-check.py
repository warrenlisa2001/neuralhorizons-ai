#!/usr/bin/env python3
"""SEO, meta and AI-readiness check for every page in dist/.
Usage: python3 scripts/seo-check.py [--strict] [path-prefix ...]
Exit 1 when a required check fails on any checked page (with --strict, warnings fail too)."""
import json, re, sys, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent / "dist"
BASE = "https://www.neuralhorizonsai.com"
args = [a for a in sys.argv[1:] if not a.startswith("--")]
strict = "--strict" in sys.argv
sitemap = (ROOT / "sitemap.xml").read_text(encoding="utf-8") if (ROOT / "sitemap.xml").exists() else ""
errors, warns = [], []

def url_of(p):
    rel = p.relative_to(ROOT).as_posix()
    rel = rel[:-len("index.html")] if rel.endswith("index.html") else rel
    return f"{BASE}/{rel}"

def attr(html, pattern):
    m = re.search(pattern, html, re.I | re.S)
    return m.group(1).strip() if m else ""

pages = sorted(ROOT.rglob("index.html"))
for p in pages:
    rel = "/" + p.relative_to(ROOT).as_posix().replace("index.html", "")
    if args and not any(rel.startswith(a) for a in args):
        continue
    if rel.startswith(("/deploy/", "/images/")):
        continue
    h = p.read_text(encoding="utf-8", errors="ignore")
    E = lambda m: errors.append(f"{rel}: {m}")
    W = lambda m: warns.append(f"{rel}: {m}")
    title = attr(h, r"<title>(.*?)</title>")
    desc = attr(h, r'<meta\s+name="description"\s+content="(.*?)"')
    if not title: E("missing <title>")
    elif len(title) > 70: W(f"title long ({len(title)})")
    if not desc: E("missing meta description")
    elif not 70 <= len(desc) <= 320: W(f"description length {len(desc)}")
    canon = attr(h, r'<link\s+rel="canonical"\s+href="(.*?)"')
    if not canon: E("missing canonical")
    elif canon.rstrip("/") != url_of(p).rstrip("/"):
        target = ROOT / canon.replace(BASE, "").strip("/") / "index.html"
        (W if target.exists() else E)(f"canonical points to {canon}" + ("" if target.exists() else " (page not found)"))
    for tag in ("og:title", "og:description", "og:url", "og:image"):
        if not re.search(r'property="%s"' % tag, h): W(f"missing {tag}")
    if not re.search(r'name="twitter:card"', h): W("missing twitter:card")
    n1 = len(re.findall(r"<h1[\s>]", h))
    if n1 != 1: E(f"h1 count {n1}")
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S)
    if not blocks: W("no JSON-LD")
    for b in blocks:
        try: json.loads(b)
        except Exception as e: E(f"invalid JSON-LD ({e})")
    if "noindex" not in h and url_of(p) not in sitemap and rel != "/":
        W("not in sitemap.xml")
    if rel == "/" and BASE + "/" not in sitemap: W("home not in sitemap")
    for t in re.findall(r"<img\b[^>]*>", h):
        if "alt=" not in t: W("img without alt"); break

for f in ("robots.txt", "llms.txt", "sitemap.xml"):
    if not (ROOT / f).exists(): errors.append(f"/{f}: missing")
rb = (ROOT / "robots.txt").read_text() if (ROOT / "robots.txt").exists() else ""
if "Sitemap:" not in rb: errors.append("/robots.txt: no Sitemap line")
print(f"checked {len(pages)} pages: {len(errors)} errors, {len(warns)} warnings")
for m in errors: print("ERROR", m)
for m in warns[:80]: print("warn ", m)
if len(warns) > 80: print(f"... {len(warns)-80} more warnings")
sys.exit(1 if errors or (strict and warns) else 0)
