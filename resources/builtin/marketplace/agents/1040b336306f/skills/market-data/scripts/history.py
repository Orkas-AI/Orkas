#!/usr/bin/env python3
"""Free daily history adapter for A-share, Hong Kong, and US equities."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.metadata
import json
import re
import socket
import sys
from typing import Any, Mapping, Sequence

from stock import StockError, _emit, normalize_bars, normalize_symbol


PROVIDERS = ("akshare-sina", "akshare-eastmoney")


def _records(frame: Any) -> list[dict[str, Any]]:
    try:
        records = frame.to_dict(orient="records")
    except (AttributeError, TypeError, ValueError) as exc:
        raise StockError("history provider returned an unsupported table") from exc
    if not isinstance(records, list):
        raise StockError("history provider returned an unsupported table")
    return records


def _date_from_row(row: Mapping[str, Any]) -> dt.date | None:
    lower = {str(key).strip().lower(): value for key, value in row.items()}
    value = lower.get("date", lower.get("日期", lower.get("datetime", lower.get("时间"))))
    try:
        return dt.date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _filter_dates(
    rows: list[dict[str, Any]],
    start: dt.date,
    end: dt.date,
) -> list[dict[str, Any]]:
    return [row for row in rows if (value := _date_from_row(row)) is not None and start <= value <= end]


def _sina_symbol(instrument: Mapping[str, str]) -> str:
    if instrument["market"] == "A":
        suffix = instrument["symbol"].rsplit(".", 1)[-1].lower()
        return f"{suffix}{instrument['code']}"
    if instrument["market"] == "HK":
        return instrument["code"].zfill(5)
    return instrument["code"]


def _fetch_sina(
    ak: Any,
    instrument: Mapping[str, str],
    start: dt.date,
    end: dt.date,
    adjust: str,
) -> tuple[list[dict[str, Any]], str]:
    provider_code = _sina_symbol(instrument)
    compact_start, compact_end = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    if instrument["market"] == "A":
        frame = ak.stock_zh_a_daily(
            symbol=provider_code,
            start_date=compact_start,
            end_date=compact_end,
            adjust=adjust,
        )
    elif instrument["market"] == "HK":
        frame = ak.stock_hk_daily(symbol=provider_code, adjust=adjust)
    else:
        frame = ak.stock_us_daily(symbol=provider_code, adjust=adjust)
    return _filter_dates(_records(frame), start, end), provider_code


def _fetch_eastmoney(
    ak: Any,
    instrument: Mapping[str, str],
    start: dt.date,
    end: dt.date,
    adjust: str,
    provider_symbol: str | None,
) -> tuple[list[dict[str, Any]], str]:
    compact_start, compact_end = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    code = instrument["code"]
    if instrument["market"] == "A":
        frame = ak.stock_zh_a_hist(
            symbol=code, period="daily", start_date=compact_start,
            end_date=compact_end, adjust=adjust,
        )
        used_symbol = code
    elif instrument["market"] == "HK":
        used_symbol = code.zfill(5)
        frame = ak.stock_hk_hist(
            symbol=used_symbol, period="daily", start_date=compact_start,
            end_date=compact_end, adjust=adjust,
        )
    else:
        if not provider_symbol:
            raise StockError("Eastmoney US fallback requires --provider-symbol, for example 105.AAPL")
        used_symbol = provider_symbol
        frame = ak.stock_us_hist(
            symbol=used_symbol, period="daily", start_date=compact_start,
            end_date=compact_end, adjust=adjust,
        )
    return _filter_dates(_records(frame), start, end), used_symbol


def _safe_error(exc: Exception) -> str:
    text = re.sub(r"https?://\S+", "provider endpoint", str(exc)).strip()
    return (text or exc.__class__.__name__)[:240]


def fetch(
    symbol: str,
    start: str,
    end: str,
    market: str = "auto",
    provider: str = "auto",
    adjust: str = "qfq",
    provider_symbol: str | None = None,
    timeout: float = 15,
    max_bars: int = 5000,
    *,
    ak_module: Any | None = None,
    retrieved_at: dt.datetime | None = None,
) -> dict[str, Any]:
    instrument = normalize_symbol(symbol, market)
    try:
        first, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    except ValueError as exc:
        raise StockError("start and end must use YYYY-MM-DD") from exc
    if first > last:
        raise StockError("start must not be later than end")
    if provider not in {"auto", *PROVIDERS}:
        raise StockError("provider must be auto, akshare-sina, or akshare-eastmoney")
    if adjust not in {"raw", "qfq", "hfq"}:
        raise StockError("adjust must be raw, qfq, or hfq")
    if timeout <= 0 or timeout > 60:
        raise StockError("timeout must be greater than 0 and at most 60 seconds")
    if max_bars < 2 or max_bars > 20_000:
        raise StockError("max-bars must be between 2 and 20000")
    if ak_module is None:
        try:
            import akshare as ak_module  # type: ignore
        except ImportError as exc:
            raise StockError("AKShare dependency is unavailable; run this adapter through run-skill.cjs") from exc

    candidates = PROVIDERS if provider == "auto" else (provider,)
    attempts: list[dict[str, str]] = []
    rows: list[dict[str, Any]] | None = None
    selected = ""
    used_symbol = ""
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout)
    try:
        for candidate in candidates:
            try:
                if candidate == "akshare-sina":
                    candidate_rows, candidate_symbol = _fetch_sina(
                        ak_module, instrument, first, last, "" if adjust == "raw" else adjust,
                    )
                else:
                    candidate_rows, candidate_symbol = _fetch_eastmoney(
                        ak_module, instrument, first, last, "" if adjust == "raw" else adjust,
                        provider_symbol,
                    )
                if len(candidate_rows) < 2:
                    raise StockError("provider returned fewer than two bars in the requested range")
                rows, selected, used_symbol = candidate_rows, candidate, candidate_symbol
                attempts.append({"provider": candidate, "status": "ok"})
                break
            except Exception as exc:  # bounded provider evidence; auto may continue
                attempts.append({"provider": candidate, "status": "error", "detail": _safe_error(exc)})
    finally:
        socket.setdefaulttimeout(old_timeout)
    if rows is None:
        raise StockError("all history providers failed: " + json.dumps(attempts, ensure_ascii=False))
    if len(rows) > max_bars:
        raise StockError(f"provider returned {len(rows)} bars, exceeding max-bars={max_bars}; narrow the date range")

    retrieved = retrieved_at or dt.datetime.now(dt.timezone.utc)
    if retrieved.tzinfo is None:
        raise StockError("retrieved_at must include a timezone offset")
    version = getattr(ak_module, "__version__", None)
    if not version:
        try:
            version = importlib.metadata.version("akshare")
        except importlib.metadata.PackageNotFoundError:
            version = "test-double"
    normalized = normalize_bars({
        "bars": rows,
        "meta": {
            **instrument,
            "source": selected.replace("-", "_"),
            "provider_symbol": used_symbol,
            "provider_package": "akshare",
            "provider_version": version,
            "adjustment": adjust,
            "requested_start": first.isoformat(),
            "requested_end": last.isoformat(),
            "retrieved_at": retrieved.astimezone(dt.timezone.utc).isoformat(),
            "delay": "best_effort_not_guaranteed",
            "attempts": attempts,
        },
    }, as_of=last.isoformat())
    return {"contract_version": 1, **normalized}


def status() -> dict[str, Any]:
    try:
        version = importlib.metadata.version("akshare")
        available = True
    except importlib.metadata.PackageNotFoundError:
        version, available = None, False
    return {
        "contract_version": 1,
        "providers": {
            "akshare_sina": {"markets": ["A", "HK", "US"], "cost": "free", "role": "primary_history"},
            "akshare_eastmoney": {"markets": ["A", "HK", "US"], "cost": "free", "role": "fallback_history"},
        },
        "dependency": {"name": "akshare", "available": available, "version": version},
        "network_checked": False,
        "credentials_required": False,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    command = commands.add_parser("fetch")
    command.add_argument("--symbol", required=True)
    command.add_argument("--market", default="auto")
    command.add_argument("--provider", choices=["auto", *PROVIDERS], default="auto")
    command.add_argument("--provider-symbol")
    command.add_argument("--start", required=True)
    command.add_argument("--end", required=True)
    command.add_argument("--adjust", choices=["raw", "qfq", "hfq"], default="qfq")
    command.add_argument("--timeout", type=float, default=15)
    command.add_argument("--max-bars", type=int, default=5000)
    command.add_argument("--output")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = status() if args.command == "status" else fetch(
            symbol=args.symbol,
            market=args.market,
            provider=args.provider,
            provider_symbol=args.provider_symbol,
            start=args.start,
            end=args.end,
            adjust=args.adjust,
            timeout=args.timeout,
            max_bars=args.max_bars,
        )
        _emit(result, getattr(args, "output", None))
        return 0
    except (StockError, OSError, ValueError) as exc:
        sys.stderr.write(f"error: {_safe_error(exc)}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
