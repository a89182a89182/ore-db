from __future__ import annotations

import json
import re
from datetime import datetime
from html import unescape
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BASE_URL = "http://game.tinycafe.com/ore/ore.cgi"
OUT_DIR = Path(__file__).resolve().parent / "rules"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Codex Ore Rules Saver"


def fetch_rules_page() -> str:
    body = urlencode({"rule": "規則"}).encode("ascii")
    req = Request(
        BASE_URL,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    with urlopen(req, timeout=30) as resp:
        return resp.read().decode("cp950", errors="ignore")


def clean_html_text(text: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</p>|</tr>|</table>|<hr\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = unescape(text).replace("\xa0", " ")
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def extract_sections(html: str) -> list[dict[str, str]]:
    pattern = re.compile(
        r'<a name="([^"]+)">\s*<font[^>]*class="?bigtom"?[^>]*>(.*?)</font><BR>(.*?)(?=<a name="[^"]+">\s*<font[^>]*class="?bigtom"?|<a name="PAGEBOTTOM")',
        re.I | re.S,
    )
    sections = []
    for anchor, title, body in pattern.findall(html):
        sections.append(
            {
                "anchor": anchor,
                "title": clean_html_text(title),
                "content": clean_html_text(body),
            }
        )
    return sections


def main() -> None:
    html = fetch_rules_page()
    sections = extract_sections(html)
    scraped_at = datetime.now().astimezone().isoformat(timespec="seconds")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "rules.html").write_text(html, encoding="utf-8")
    (OUT_DIR / "rules.txt").write_text(clean_html_text(html), encoding="utf-8")
    (OUT_DIR / "rules.json").write_text(
        json.dumps(
            {
                "source": BASE_URL,
                "entry": "POST rule=規則",
                "scraped_at": scraped_at,
                "title": "遊戲規則說明",
                "sections": sections,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"saved={OUT_DIR}")
    print(f"sections={len(sections)}")


if __name__ == "__main__":
    main()
