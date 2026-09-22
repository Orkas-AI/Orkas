#!/usr/bin/env python3
"""Free, API-first current quotes for A-share, Hong Kong, and US equities."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from zoneinfo import ZoneInfo

from stock import StockError, _emit, normalize_symbol


TENCENT_URL = "https://qt.gtimg.cn/q={symbol}"
SINA_URL = "https://hq.sinajs.cn/list={symbol}"
USER_AGENT = "Mozilla/5.0 (compatible; Orkas-StockAnalyser/1.0)"
PROVIDERS = ("tencent", "sina")


def provider_symbol(instrument: Mapping[str, str], provider: str) -> str:
    market, code = instrument["market"], instrument["code"]
    if market == "A":
        suffix = instrument["symbol"].rsplit(".", 1)[-1].lower()
        return f"{suffix}{code}"
    if market == "HK":
        prefix = "r_hk" if provider == "tencent" else "rt_hk"
        return f"{prefix}{code.zfill(5)}"
    prefix = "us" if provider == "tencent" else "gb_"
    return f"{prefix}{code}"


def _number(value: Any, *, positive: bool = False) -> float | None:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if positive and number <= 0:
        return None
    return number


def _download(
    url: str,
    timeout: float,
    opener: Callable[..., Any] | None = None,
) -> str:
    referer = (
        "https://finance.sina.com.cn/"
        if "sinajs.cn" in url
        else "https://finance.qq.com/"
    )
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Referer": referer},
    )
    open_url = opener or urllib.request.urlopen
    with open_url(request, timeout=timeout) as response:
        return response.read().decode("gb18030", errors="replace")


def _provider_time(value: str, market: str) -> dt.datetime | None:
    text = value.strip()
    timezone = ZoneInfo({
        "A": "Asia/Shanghai",
        "HK": "Asia/Hong_Kong",
        "US": "America/New_York",
    }[market])
    formats = ["%Y%m%d%H%M%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"]
    for fmt in formats:
        try:
            return dt.datetime.strptime(text, fmt).replace(tzinfo=timezone)
        except ValueError:
            continue
    match = re.fullmatch(
        r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}[AP]M)\s+(?:EDT|EST)",
        text,
    )
    if match:
        try:
            parsed = dt.datetime.strptime(
                f"{dt.datetime.now(timezone).year} {match.group(1)} {match.group(2)} {match.group(3)}",
                "%Y %b %d %I:%M%p",
            )
            return parsed.replace(tzinfo=timezone)
        except ValueError:
            return None
    return None


def _session(market: str, now: dt.datetime) -> str:
    local = now.astimezone(ZoneInfo({
        "A": "Asia/Shanghai",
        "HK": "Asia/Hong_Kong",
        "US": "America/New_York",
    }[market]))
    if local.weekday() >= 5:
        return "closed"
    current = local.time().replace(tzinfo=None)
    if market == "A":
        if dt.time(9, 15) <= current < dt.time(9, 30):
            return "opening_auction"
        if dt.time(9, 30) <= current <= dt.time(11, 30) or dt.time(13) <= current <= dt.time(15):
            return "regular"
        if dt.time(11, 30) < current < dt.time(13):
            return "lunch_break"
        return "closed"
    if market == "HK":
        if dt.time(9) <= current < dt.time(9, 30):
            return "opening_auction"
        if dt.time(9, 30) <= current <= dt.time(12) or dt.time(13) <= current <= dt.time(16):
            return "regular"
        if dt.time(12) < current < dt.time(13):
            return "lunch_break"
        if dt.time(16) < current <= dt.time(16, 10):
            return "closing_auction"
        return "closed"
    if dt.time(4) <= current < dt.time(9, 30):
        return "pre_market"
    if dt.time(9, 30) <= current <= dt.time(16):
        return "regular"
    if dt.time(16) < current <= dt.time(20):
        return "post_market"
    return "closed"


def _parse_tencent(text: str, instrument: Mapping[str, str]) -> dict[str, Any]:
    match = re.search(r'=\s*"(.*?)"\s*;', text, flags=re.DOTALL)
    if not match:
        raise StockError("Tencent quote response did not contain a quote record")
    fields = match.group(1).split("~")
    if len(fields) < 35 or not fields[1].strip():
        raise StockError("Tencent quote record was empty or incomplete")
    market = instrument["market"]
    volume = _number(fields[6], positive=True)
    amount = _number(fields[37], positive=True) if len(fields) > 37 else None
    if market == "A":
        volume = volume * 100 if volume is not None else None
        amount = amount * 10_000 if amount is not None else None
    return {
        "name": fields[1].strip(),
        "last": _number(fields[3], positive=True),
        "previous_close": _number(fields[4], positive=True),
        "open": _number(fields[5], positive=True),
        "volume": volume,
        "bid": _number(fields[9], positive=True),
        "ask": _number(fields[19], positive=True),
        "provider_time": fields[30].strip(),
        "change": _number(fields[31]),
        "change_percent": _number(fields[32]),
        "high": _number(fields[33], positive=True),
        "low": _number(fields[34], positive=True),
        "amount": amount,
    }


def _parse_sina(text: str, instrument: Mapping[str, str]) -> dict[str, Any]:
    match = re.search(r'=\s*"(.*?)"\s*;', text, flags=re.DOTALL)
    if not match:
        raise StockError("Sina quote response did not contain a quote record")
    fields = match.group(1).split(",")
    market = instrument["market"]
    if market == "A" and len(fields) >= 32:
        bid, ask = _number(fields[6], positive=True), _number(fields[7], positive=True)
        last = _number(fields[3], positive=True) or bid or ask
        return {
            "name": fields[0].strip(), "last": last,
            "previous_close": _number(fields[2], positive=True),
            "open": _number(fields[1], positive=True), "high": _number(fields[4], positive=True),
            "low": _number(fields[5], positive=True), "bid": bid, "ask": ask,
            "volume": _number(fields[8], positive=True), "amount": _number(fields[9], positive=True),
            "provider_time": f"{fields[30]} {fields[31]}",
        }
    if market == "HK" and len(fields) >= 19:
        return {
            "name": fields[1].strip() or fields[0].strip(),
            "last": _number(fields[6], positive=True),
            "previous_close": _number(fields[3], positive=True),
            "open": _number(fields[2], positive=True), "high": _number(fields[4], positive=True),
            "low": _number(fields[5], positive=True), "bid": _number(fields[9], positive=True),
            "ask": _number(fields[10], positive=True), "volume": _number(fields[12], positive=True),
            "amount": _number(fields[11], positive=True), "change": _number(fields[7]),
            "change_percent": _number(fields[8]), "provider_time": f"{fields[17]} {fields[18]}",
        }
    if market == "US" and len(fields) >= 31:
        return {
            "name": fields[0].strip(), "last": _number(fields[1], positive=True),
            "previous_close": _number(fields[26], positive=True),
            "open": _number(fields[5], positive=True), "high": _number(fields[6], positive=True),
            "low": _number(fields[7], positive=True), "bid": _number(fields[21], positive=True),
            "ask": None, "volume": _number(fields[10], positive=True),
            "amount": _number(fields[30], positive=True), "change": _number(fields[4]),
            "change_percent": _number(fields[2]), "provider_time": fields[25],
        }
    raise StockError("Sina quote record was empty or incomplete")


def _safe_error(exc: Exception) -> str:
    text = re.sub(r"https?://\S+", "provider endpoint", str(exc)).strip()
    return (text or exc.__class__.__name__)[:240]


def quote(
    symbol: str,
    market: str = "auto",
    provider: str = "auto",
    timeout: float = 10,
    *,
    opener: Callable[..., Any] | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    instrument = normalize_symbol(symbol, market)
    if provider not in {"auto", *PROVIDERS}:
        raise StockError("provider must be auto, tencent, or sina")
    if timeout <= 0 or timeout > 30:
        raise StockError("timeout must be greater than 0 and at most 30 seconds")
    retrieved_at = now or dt.datetime.now(dt.timezone.utc)
    if retrieved_at.tzinfo is None:
        raise StockError("now must include a timezone offset")
    session = _session(instrument["market"], retrieved_at)
    stale_limit = 900 if session in {"regular", "opening_auction", "closing_auction"} else 345_600
    providers = PROVIDERS if provider == "auto" else (provider,)
    attempts: list[dict[str, str]] = []
    record: dict[str, Any] | None = None
    selected = ""
    selected_symbol = ""
    for candidate in providers:
        candidate_symbol = provider_symbol(instrument, candidate)
        url = (TENCENT_URL if candidate == "tencent" else SINA_URL).format(symbol=candidate_symbol)
        try:
            body = _download(url, timeout, opener)
            record = (_parse_tencent if candidate == "tencent" else _parse_sina)(body, instrument)
            selected, selected_symbol = candidate, candidate_symbol
            attempts.append({"provider": candidate, "status": "ok"})
            break
        except Exception as exc:  # provider failures are returned as bounded evidence
            attempts.append({"provider": candidate, "status": "error", "detail": _safe_error(exc)})
    if record is None:
        raise StockError("all quote providers failed: " + json.dumps(attempts, ensure_ascii=False))

    observed_at = _provider_time(str(record.pop("provider_time", "")), instrument["market"])
    flags = ["provider_delay_not_guaranteed", "exchange_calendar_not_verified"]
    if session != "regular":
        flags.append("outside_regular_session")
    quote_kind = "last_trade"
    if session in {"opening_auction", "closing_auction"}:
        quote_kind = "indicative"
        flags.append("indicative_quote")
    elif session != "regular":
        quote_kind = "last_market_snapshot"
    if record.get("last") is None and record.get("previous_close") is not None:
        record["last"] = record["previous_close"]
        flags.append("no_current_trade_used_previous_close")
        quote_kind = "previous_close"
    if record.get("last") is None:
        raise StockError(f"{selected} returned no usable current or previous price")
    age_seconds = None
    if observed_at is None:
        flags.append("provider_timestamp_unavailable")
    else:
        observed_age = (
            retrieved_at.astimezone(dt.timezone.utc)
            - observed_at.astimezone(dt.timezone.utc)
        ).total_seconds()
        age_seconds = max(0.0, observed_age)
        if observed_age < 0:
            flags.append("provider_timestamp_in_future")
        if age_seconds > stale_limit:
            flags.append("stale_quote")

    quote_fields = {
        key: record.get(key)
        for key in (
            "last", "previous_close", "open", "high", "low", "bid", "ask",
            "volume", "amount", "change", "change_percent",
        )
    }
    return {
        "contract_version": 1,
        "instrument": {**instrument, "name": record.get("name") or None},
        "quote": quote_fields,
        "provenance": {
            "source": f"{selected}_quote_api",
            "provider_symbol": selected_symbol,
            "observed_at": observed_at.isoformat() if observed_at else None,
            "retrieved_at": retrieved_at.astimezone(dt.timezone.utc).isoformat(),
            "delay": "best_effort_not_guaranteed",
        },
        "quality": {
            "market_session": session,
            "quote_kind": quote_kind,
            "age_seconds": round(age_seconds, 3) if age_seconds is not None else None,
            "flags": sorted(set(flags)),
            "attempts": attempts,
        },
    }


def status() -> dict[str, Any]:
    return {
        "contract_version": 1,
        "providers": {
            "tencent": {"markets": ["A", "HK", "US"], "cost": "free", "role": "primary_quote"},
            "sina": {"markets": ["A", "HK", "US"], "cost": "free", "role": "fallback_quote"},
        },
        "network_checked": False,
        "credentials_required": False,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    current = commands.add_parser("quote")
    current.add_argument("--symbol", required=True)
    current.add_argument("--market", default="auto")
    current.add_argument("--provider", choices=["auto", *PROVIDERS], default="auto")
    current.add_argument("--timeout", type=float, default=10)
    current.add_argument("--output")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = status() if args.command == "status" else quote(
            args.symbol, args.market, args.provider, args.timeout,
        )
        _emit(result, getattr(args, "output", None))
        return 0
    except (StockError, OSError, ValueError) as exc:
        sys.stderr.write(f"error: {_safe_error(exc)}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
