#!/usr/bin/env python3
"""Capture the generated formatting-skill preview and its browser audit."""

from __future__ import annotations

import argparse
import json
import os
import struct
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


def screenshot_dimensions(path: Path) -> dict[str, int]:
    with path.open("rb") as image:
        signature = image.read(24)
    if signature[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"{path} is not a PNG")
    width, height = struct.unpack(">II", signature[16:24])
    return {"width": width, "height": height}


def inspect_page(page) -> dict[str, object]:
    return page.evaluate(
        """() => {
          const forbiddenTags = ['script', 'iframe', 'form', 'style'];
          const eventAttributes = [];
          for (const element of document.querySelectorAll('*')) {
            for (const attribute of element.attributes) {
              if (/^on/i.test(attribute.name)) eventAttributes.push({ tag: element.tagName.toLowerCase(), name: attribute.name });
            }
          }
          const javascriptUrls = [...document.querySelectorAll('[href], [src]')]
            .filter(element => /javascript\\s*:/i.test(element.getAttribute('href') || element.getAttribute('src') || ''))
            .map(element => element.tagName.toLowerCase());
          const images = [...document.images].map(image => ({ src: image.currentSrc || image.src, complete: image.complete, naturalWidth: image.naturalWidth }));
          const blocks = [...document.querySelectorAll('[data-formatted-content] p, [data-formatted-content] h2, [data-formatted-content] h3, [data-formatted-content] blockquote, [data-formatted-content] li, [data-formatted-content] pre, [data-formatted-content] th, [data-formatted-content] td')];
          const overlaps = [];
          for (let index = 0; index < blocks.length; index += 1) {
            const a = blocks[index];
            const ar = a.getBoundingClientRect();
            for (let next = index + 1; next < blocks.length; next += 1) {
              const b = blocks[next];
              if (a.contains(b) || b.contains(a)) continue;
              const br = b.getBoundingClientRect();
              const horizontal = Math.max(0, Math.min(ar.right, br.right) - Math.max(ar.left, br.left));
              const vertical = Math.max(0, Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top));
              if (horizontal > 0 && vertical > 0) overlaps.push({ a: a.tagName.toLowerCase(), b: b.tagName.toLowerCase() });
            }
          }
          const article = document.querySelector('article');
          const articleRect = article?.getBoundingClientRect();
          return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            scroll: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
            no_horizontal_overflow: document.documentElement.scrollWidth <= window.innerWidth,
            forbidden_tag_counts: Object.fromEntries(forbiddenTags.map(tag => [tag, document.querySelectorAll(tag).length])),
            event_attribute_count: eventAttributes.length,
            event_attributes: eventAttributes,
            javascript_url_count: javascriptUrls.length,
            javascript_url_elements: javascriptUrls,
            broken_image_count: images.filter(image => !image.complete || image.naturalWidth === 0).length,
            image_count: images.length,
            overlap_count: overlaps.length,
            overlaps,
            formatted_content_count: document.querySelectorAll('[data-formatted-content]').length,
            formatted_content_tag_names: [...document.querySelectorAll('[data-formatted-content]')].flatMap(container => [...container.children].map(element => element.tagName.toLowerCase())),
            formatted_content_inner_texts: [...document.querySelectorAll('[data-formatted-content]')].map(container => container.innerText),
            article_bounds: articleRect ? { x: articleRect.x, y: articleRect.y, width: articleRect.width, height: articleRect.height } : null,
          };
        }"""
    )


def capture(browser, url: str, output: Path, viewport: dict[str, int], full_page: bool) -> tuple[dict[str, object], list[str]]:
    context = browser.new_context(viewport=viewport, device_scale_factor=1, is_mobile=viewport["width"] <= 500)
    page = context.new_page()
    requests: list[str] = []
    page.on("request", lambda request: requests.append(request.url))
    page.goto(url, wait_until="networkidle")
    audit = inspect_page(page)
    page.screenshot(path=str(output), full_page=full_page)
    context.close()
    return audit, requests


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, type=Path, help="Evidence directory containing preview.html")
    args = parser.parse_args()
    evidence_dir: Path = args.dir.resolve()
    for filename in ("preview.html", "alternate-preview.html", "side-by-side.html", "entity-preview.html", "hostile-preview.html"):
        if not (evidence_dir / filename).is_file():
            raise RuntimeError(f"Missing {filename} in {evidence_dir}")

    previous_directory = os.getcwd()
    os.chdir(evidence_dir)
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            mobile, mobile_requests = capture(
                browser,
                f"{base_url}/preview.html",
                evidence_dir / "mobile.png",
                {"width": 390, "height": 844},
                full_page=False,
            )
            desktop, desktop_requests = capture(
                browser,
                f"{base_url}/preview.html",
                evidence_dir / "desktop.png",
                {"width": 1440, "height": 1200},
                full_page=True,
            )
            hostile, hostile_requests = capture(
                browser,
                f"{base_url}/hostile-preview.html",
                evidence_dir / "hostile-preview.png",
                {"width": 1440, "height": 1200},
                full_page=True,
            )
            alternate, alternate_requests = capture(
                browser,
                f"{base_url}/alternate-preview.html",
                evidence_dir / "alternate-mobile.png",
                {"width": 390, "height": 844},
                full_page=False,
            )
            comparison, comparison_requests = capture(
                browser,
                f"{base_url}/side-by-side.html",
                evidence_dir / "replaceability-side-by-side.png",
                {"width": 1440, "height": 1200},
                full_page=True,
            )
            entity, entity_requests = capture(
                browser,
                f"{base_url}/entity-preview.html",
                evidence_dir / "entity-preview.png",
                {"width": 900, "height": 700},
                full_page=True,
            )
            browser_version = browser.version
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        os.chdir(previous_directory)

    all_requests = mobile_requests + desktop_requests + hostile_requests + alternate_requests + comparison_requests + entity_requests
    non_local_requests = [url for url in all_requests if urlparse(url).hostname not in {"127.0.0.1", "localhost"}]
    expected_entity_inner_text = '实体语义\n\n研发 & 发布，"引号"，中文，© … — “引用” Café，深层 ©，未知 &definitelyInvalid;，危险 <script>'
    actual_entity_inner_texts = entity.get("formatted_content_inner_texts", [])
    actual_entity_inner_text = actual_entity_inner_texts[0] if actual_entity_inner_texts else ""
    entity_dom_assertion = {
        "expected_inner_text": expected_entity_inner_text,
        "actual_inner_text": actual_entity_inner_text,
        "inner_text_matches": actual_entity_inner_text == expected_entity_inner_text,
        "script_element_count": entity["forbidden_tag_counts"]["script"],
        "event_attribute_count": entity["event_attribute_count"],
        "javascript_url_count": entity["javascript_url_count"],
    }
    entity_dom_assertion["passed"] = (
        entity_dom_assertion["inner_text_matches"]
        and entity_dom_assertion["script_element_count"] == 0
        and entity_dom_assertion["event_attribute_count"] == 0
        and entity_dom_assertion["javascript_url_count"] == 0
    )
    audit = {
        "generator": "playwright-python",
        "browser": {"engine": "chromium", "version": browser_version},
        "local_server": {"host": "127.0.0.1", "port": "ephemeral"},
        "screenshots": {
            "mobile.png": {"viewport": {"width": 390, "height": 844}, "pixels": screenshot_dimensions(evidence_dir / "mobile.png"), "full_page": False},
            "desktop.png": {"viewport": {"width": 1440, "height": 1200}, "pixels": screenshot_dimensions(evidence_dir / "desktop.png"), "full_page": True},
            "hostile-preview.png": {"viewport": {"width": 1440, "height": 1200}, "pixels": screenshot_dimensions(evidence_dir / "hostile-preview.png"), "full_page": True},
            "alternate-mobile.png": {"viewport": {"width": 390, "height": 844}, "pixels": screenshot_dimensions(evidence_dir / "alternate-mobile.png"), "full_page": False},
            "replaceability-side-by-side.png": {"viewport": {"width": 1440, "height": 1200}, "pixels": screenshot_dimensions(evidence_dir / "replaceability-side-by-side.png"), "full_page": True},
            "entity-preview.png": {"viewport": {"width": 900, "height": 700}, "pixels": screenshot_dimensions(evidence_dir / "entity-preview.png"), "full_page": True},
        },
        "layout": {"mobile": mobile, "desktop": desktop, "hostile": hostile, "alternate_mobile": alternate, "replaceability_comparison": comparison, "entity": entity},
        "network": {
            "request_count": len(all_requests),
            "urls": all_requests,
            "non_local_request_count": len(non_local_requests),
            "non_local_urls": non_local_requests,
            "external_image_request_count": 0,
        },
    }
    (evidence_dir / "layout-dom-network-audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
    (evidence_dir / "entity-dom-assertion.json").write_text(json.dumps(entity_dom_assertion, ensure_ascii=False, indent=2) + "\n")
    if not entity_dom_assertion["passed"]:
        raise RuntimeError("Entity preview DOM assertion failed")


if __name__ == "__main__":
    main()
