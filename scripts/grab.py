#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal readable-text extractor. Usage: python3 grab.py URL [maxchars]"""
import re, sys, urllib.request, gzip, io, ssl

def fetch(url, timeout=30):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/pdf,*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    })
    raw = urllib.request.urlopen(req, timeout=timeout, context=ctx).read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    text = None
    for enc in ("utf-8", "gb18030", "gbk", "big5"):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    if text is None:
        text = raw.decode("utf-8", "ignore")
    return text

def clean(html, maxchars=12000):
    t = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", html)
    t = re.sub(r"(?is)<!--.*?-->", " ", t)
    t = re.sub(r"(?i)<br\s*/?>", "\n", t)
    t = re.sub(r"(?i)</(p|div|li|tr|h[1-6]|table|section)>", "\n", t)
    t = re.sub(r"(?i)</t[dh]>", " | ", t)
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&#39;", "'"), ("&ldquo;", "“"), ("&rdquo;", "”"),
                 ("&mdash;", "—"), ("&hellip;", "…")):
        t = t.replace(a, b)
    t = re.sub(r"&#\d+;", " ", t)
    t = re.sub(r"[ \t\u3000]+", " ", t)
    lines = [ln.strip() for ln in t.split("\n")]
    out, blank = [], 0
    for ln in lines:
        if not ln:
            blank += 1
            if blank > 1 or not out:
                continue
        else:
            blank = 0
        out.append(ln)
    text = "\n".join(out)
    # drop long runs of pure punctuation / css leftovers
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text[:maxchars]

if __name__ == "__main__":
    url = sys.argv[1]
    mx = int(sys.argv[2]) if len(sys.argv) > 2 else 12000
    try:
        print(clean(fetch(url), mx))
    except Exception as e:
        print("FETCH_FAIL: %s: %s" % (type(e).__name__, e))
