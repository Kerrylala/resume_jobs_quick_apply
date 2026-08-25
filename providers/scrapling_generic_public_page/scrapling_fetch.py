#!/usr/bin/env python3
"""Scrapling-based public metadata fallback.

Safety boundaries:
- public page metadata only
- no login/session/cookies beyond default fetcher behavior
- no form submission
- no CAPTCHA/OTP/451/private/upload/apply flow handling
"""
import json
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

BLOCK_PATTERNS = re.compile(
    r"\b(login|log in|sign in|captcha|recaptcha|hcaptcha|otp|one[- ]time|two[- ]factor|2fa|451|unavailable for legal reasons|upload|submit application|apply now|application flow|continue application)\b|登录|验证码|投递|提交|上传|申请职位",
    re.IGNORECASE,
)


def emit(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    raise SystemExit(code)


class MetadataParser(HTMLParser):
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title = ""
        self.meta = {}
        self.links = []
        self.text_parts = []
        self._tag_stack = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        attrs_dict = {str(k).lower(): (v or "") for k, v in attrs}
        self._tag_stack.append(tag)
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag == "meta":
            key = attrs_dict.get("name") or attrs_dict.get("property") or attrs_dict.get("http-equiv")
            content = attrs_dict.get("content")
            if key and content and len(self.meta) < 80:
                self.meta[key[:120]] = clean(content, 1000)
        if tag == "a":
            href = attrs_dict.get("href", "").strip()
            if href and len(self.links) < 50:
                absolute = safe_urljoin(self.base_url, href)
                if absolute:
                    self.links.append({"href": absolute, "text": ""})

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if self._tag_stack:
            self._tag_stack.pop()

    def handle_data(self, data):
        text = clean(data, 2000)
        if not text:
            return
        if self._in_title:
            self.title = clean(f"{self.title} {text}", 300)
            return
        if self._skip_depth:
            return
        if len(self.text_parts) < 600:
            self.text_parts.append(text)
        if self.links and not self.links[-1].get("text") and self._tag_stack and self._tag_stack[-1] == "a":
            self.links[-1]["text"] = clean(text, 200)


def clean(value, max_len=4000):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:max_len]


def safe_urljoin(base, href):
    try:
        value = urljoin(base, href)
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"}:
            return ""
        return value.split("#", 1)[0]
    except Exception:
        return ""


def fetch_html(url):
    try:
        from scrapling.fetchers import Fetcher
    except Exception as exc:  # import should already be checked by Node side, but keep explicit JSON output.
        emit({"ok": False, "status": "scrapling_not_installed", "error": str(exc)})

    fetcher = Fetcher()
    page = fetcher.get(url, timeout=15)
    status = getattr(page, "status", None) or getattr(page, "status_code", None)
    html = getattr(page, "html", None) or getattr(page, "body", None) or str(page)
    if isinstance(html, bytes):
        html = html.decode("utf-8", errors="replace")
    return status, str(html or "")


def main(argv):
    if len(argv) != 2:
        emit({"ok": False, "status": "usage_error", "usage": "scrapling_fetch.py <url>"}, 2)
    url = argv[1].strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        emit({"ok": False, "status": "invalid_url"})

    try:
        http_status, html = fetch_html(url)
    except Exception as exc:
        emit({"ok": False, "status": "fetch_failed", "error": str(exc)})

    visible_probe = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", html, flags=re.I)[:200000]
    visible_probe = re.sub(r"<[^>]+>", " ", visible_probe)
    if http_status == 451 or BLOCK_PATTERNS.search(visible_probe):
        emit({"ok": False, "status": "blocked", "reason": "login_captcha_otp_451_upload_submit_apply_flow_detected", "http_status": http_status})

    parser = MetadataParser(url)
    parser.feed(html[:2_000_000])
    text = clean(" ".join(parser.text_parts), 2500)
    if BLOCK_PATTERNS.search(text):
        emit({"ok": False, "status": "blocked", "reason": "blocked_flow_terms_detected", "http_status": http_status})

    emit({
        "ok": True,
        "status": "ok",
        "http_status": http_status,
        "url": url,
        "title": parser.title or parser.meta.get("og:title", "") or parser.meta.get("twitter:title", ""),
        "text_snippet": text,
        "links": parser.links[:30],
        "meta": parser.meta,
    })


if __name__ == "__main__":
    main(sys.argv)
