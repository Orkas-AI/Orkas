#!/usr/bin/env python3
"""Bounded SEO/GEO diagnosis orchestrator."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Optional
from urllib.parse import urlsplit


SKILLS_ROOT = Path(__file__).resolve().parents[2]
MAX_SAMPLE_URLS = 5


def _relative_out_dir(raw: str) -> Path:
    path = Path(raw)
    posix_path = PurePosixPath(raw)
    windows_path = PureWindowsPath(raw)
    if (
        not raw
        or posix_path.anchor
        or windows_path.anchor
        or ".." in posix_path.parts
        or ".." in windows_path.parts
    ):
        raise ValueError("--out-dir must be a workspace-relative path")
    return path


def _sample_urls(values: list[str]) -> list[str]:
    result = []
    for value in values:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("--sample-url values must be absolute http(s) URLs")
        if value not in result:
            result.append(value)
        if len(result) > MAX_SAMPLE_URLS:
            raise ValueError("at most {} distinct --sample-url values are allowed".format(MAX_SAMPLE_URLS))
    return result


def _script_path(skill: str, script: str) -> Path:
    path = SKILLS_ROOT / skill / "scripts" / "{}.py".format(script)
    if not path.is_file():
        raise ValueError("missing private skill script: {}/{}".format(skill, script))
    return path


def _run_script(skill: str, script: str, args: list[str], *, timeout: int = 90) -> dict:
    completed = subprocess.run(
        [sys.executable, str(_script_path(skill, script))] + args,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    stream = completed.stdout if completed.returncode == 0 else completed.stderr
    line = next((item for item in reversed(stream.splitlines()) if item.strip()), "")
    try:
        payload = json.loads(line) if line else {}
    except json.JSONDecodeError:
        payload = {}
    if completed.returncode != 0 or payload.get("ok") is False:
        error = payload.get("error") or "script exited {}".format(completed.returncode)
        raise RuntimeError("{} failed: {}".format(skill, error))
    return payload


def _data(payload: dict) -> dict:
    value = payload.get("data", payload)
    return value if isinstance(value, dict) else {}


def _run_root(crawl_path: Path, out_dir: Path, include_cwv: bool) -> tuple[dict, Optional[str]]:
    outputs = {
        "tech": out_dir / "tech.json",
        "content": out_dir / "content.json",
        "schema": out_dir / "schema.json",
        "geo": out_dir / "geo.json",
        "opportunities": out_dir / "opportunities.json",
    }
    _run_script("seo-tech-audit", "audit", ["--input", str(crawl_path), "--out", str(outputs["tech"])])
    _run_script("seo-content", "content", ["--input", str(crawl_path), "--out", str(outputs["content"])])
    _run_script(
        "seo-schema",
        "schema",
        ["--op", "validate", "--input", str(crawl_path), "--out", str(outputs["schema"])],
    )
    _run_script("geo-score", "geo_score", ["--input", str(crawl_path), "--out", str(outputs["geo"])])
    _run_script(
        "seo-opportunity",
        "opportunity",
        ["--crawl", str(crawl_path), "--out", str(outputs["opportunities"])],
    )

    cwv_error = None
    cwv_path = out_dir / "cwv.json"
    if include_cwv:
        with crawl_path.open(encoding="utf-8") as handle:
            crawl = _data(json.load(handle))
        page = (crawl.get("pages") or [{}])[0]
        url = page.get("url") or page.get("final_url")
        if url:
            try:
                _run_script("seo-cwv", "cwv", [url, "--out", str(cwv_path)], timeout=120)
            except (RuntimeError, subprocess.TimeoutExpired) as exc:
                cwv_error = str(exc)
    return outputs, cwv_error


def _run_samples(urls: list[str], out_dir: Path) -> list[dict]:
    rows = []
    for index, url in enumerate(urls, 1):
        page_dir = out_dir / "page-{}".format(index)
        page_dir.mkdir(parents=True, exist_ok=True)
        crawl_path = page_dir / "crawl.json"
        tech_path = page_dir / "tech.json"
        geo_path = page_dir / "geo.json"
        try:
            _run_script("seo-crawl", "crawl", [url, "--out", str(crawl_path)])
            _run_script("seo-tech-audit", "audit", ["--input", str(crawl_path), "--out", str(tech_path)])
            _run_script("geo-score", "geo_score", ["--input", str(crawl_path), "--out", str(geo_path)])
            with crawl_path.open(encoding="utf-8") as handle:
                page = (_data(json.load(handle)).get("pages") or [{}])[0]
            with tech_path.open(encoding="utf-8") as handle:
                tech = _data(json.load(handle))
            with geo_path.open(encoding="utf-8") as handle:
                geo = _data(json.load(handle))
            rows.append({
                "url": url,
                "status_code": page.get("status_code"),
                "title": page.get("title"),
                "health_score": tech.get("health_score"),
                "geo_score": geo.get("geo_score"),
                "critical": (tech.get("summary") or {}).get("critical", 0),
                "high": (tech.get("summary") or {}).get("high", 0),
                "ok": True,
            })
        except (RuntimeError, subprocess.TimeoutExpired) as exc:
            rows.append({"url": url, "ok": False, "error": str(exc)})
    return rows


def main(argv: list[str]) -> dict:
    parser = argparse.ArgumentParser(prog="seo-report diagnose")
    parser.add_argument("--crawl", required=True, help="existing root seo-crawl JSON")
    parser.add_argument("--out-dir", default=".orkas-seo-audit")
    parser.add_argument("--sample-url", action="append", default=[])
    parser.add_argument("--include-cwv", action="store_true")
    args = parser.parse_args(argv)

    crawl_path = Path(args.crawl)
    if not crawl_path.is_file():
        raise ValueError("--crawl file does not exist")
    out_dir = _relative_out_dir(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    samples = _sample_urls(args.sample_url)

    outputs, cwv_error = _run_root(crawl_path, out_dir, args.include_cwv)
    rows = _run_samples(samples, out_dir)
    with (out_dir / "multi-summary.json").open("w", encoding="utf-8") as handle:
        json.dump({"ok": True, "pages": rows}, handle, ensure_ascii=False)

    report_args = [
        "--audit", str(outputs["tech"]),
        "--add", str(outputs["content"]),
        "--add", str(outputs["schema"]),
        "--geo", str(outputs["geo"]),
        "--crawl", str(crawl_path),
        "--opportunities", str(outputs["opportunities"]),
        "--out", str(out_dir / "report.json"),
    ]
    cwv_path = out_dir / "cwv.json"
    if cwv_path.is_file():
        report_args.extend(["--add", str(cwv_path)])
    report = _run_script("seo-report", "report", report_args)
    report["multi_page"] = rows
    report["cwv_error"] = cwv_error
    report["out_dir"] = str(out_dir)
    return report


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))
