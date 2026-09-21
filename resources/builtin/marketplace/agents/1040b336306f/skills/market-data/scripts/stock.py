#!/usr/bin/env python3
"""Deterministic, dependency-free financial calculations for StockAnalyser.

This module never submits orders and never reads or prints credentials.
Provider access lives in the dedicated market.py and history.py adapters.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


TRADING_DAYS = 252
SUPPORTED_MARKETS = {"A", "HK", "US"}
MARKET_META = {
    "A": {"currency": "CNY", "timezone": "Asia/Shanghai"},
    "HK": {"currency": "HKD", "timezone": "Asia/Hong_Kong"},
    "US": {"currency": "USD", "timezone": "America/New_York"},
}


class StockError(ValueError):
    """A user-actionable data or analysis contract error."""


def _finite(value: Any, field: str, *, optional: bool = False) -> float | None:
    if value is None or value == "":
        if optional:
            return None
        raise StockError(f"missing numeric field: {field}")
    if isinstance(value, bool):
        raise StockError(f"invalid numeric field: {field}")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise StockError(f"invalid numeric field: {field}") from exc
    if not math.isfinite(number):
        raise StockError(f"non-finite numeric field: {field}")
    return number


def _rounded(value: float | None, digits: int = 8) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(value, digits)


def _read(path: str) -> Any:
    source = Path(path)
    if not source.is_file():
        raise StockError(f"input file not found: {source}")
    if source.suffix.lower() == ".csv":
        with source.open("r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    try:
        return json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise StockError(f"invalid JSON at line {exc.lineno}, column {exc.colno}") from exc


def _emit(payload: Any, output: str | None = None) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if output:
        target = Path(output)
        if not target.parent.is_dir():
            raise StockError(f"output directory does not exist: {target.parent}")
        target.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)


def _parse_date(value: Any, field: str = "date") -> dt.date:
    text = str(value or "").strip()
    if not text:
        raise StockError(f"missing {field}")
    try:
        return dt.date.fromisoformat(text[:10])
    except ValueError as exc:
        raise StockError(f"{field} must be ISO-8601: {text}") from exc


def _parse_timestamp(value: Any, field: str) -> dt.datetime:
    text = str(value or "").strip().replace("Z", "+00:00")
    if not text:
        raise StockError(f"missing {field}")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError as exc:
        raise StockError(f"{field} must be ISO-8601: {text}") from exc
    if parsed.tzinfo is None:
        raise StockError(f"{field} must include a timezone offset")
    return parsed


def normalize_symbol(symbol: str, market: str = "auto") -> dict[str, str]:
    raw = str(symbol or "").strip().upper().replace(" ", "")
    if not raw:
        raise StockError("symbol is required")
    requested = str(market or "auto").strip().upper()
    if requested not in SUPPORTED_MARKETS | {"AUTO"}:
        raise StockError("market must be auto, A, HK, or US")

    for old, new in ((".XSHG", ".SH"), (".XSHE", ".SZ"), (".XHKG", ".HK")):
        if raw.endswith(old):
            raw = raw[: -len(old)] + new
    if raw.startswith("SH") and raw[2:].isdigit():
        raw = raw[2:] + ".SH"
    elif raw.startswith("SZ") and raw[2:].isdigit():
        raw = raw[2:] + ".SZ"
    elif raw.startswith("BJ") and raw[2:].isdigit():
        raw = raw[2:] + ".BJ"
    elif raw.startswith("HK") and raw[2:].isdigit():
        raw = str(int(raw[2:])) + ".HK"

    suffix_market = None
    if raw.endswith((".SH", ".SZ", ".BJ")):
        suffix_market = "A"
    elif raw.endswith(".HK"):
        suffix_market = "HK"
    elif raw.endswith(".US"):
        suffix_market = "US"
    if suffix_market:
        if requested != "AUTO" and requested != suffix_market:
            raise StockError(f"symbol suffix conflicts with market {requested}")
        if suffix_market == "HK":
            raw = str(int(raw[:-3])) + ".HK"
        code = raw.rsplit(".", 1)[0]
        return {"symbol": raw, "code": code, "market": suffix_market, **MARKET_META[suffix_market]}

    resolved = requested
    if resolved == "AUTO":
        if raw.isdigit() and len(raw) == 6:
            resolved = "A"
        elif raw.isdigit() and len(raw) <= 5:
            resolved = "HK"
        else:
            resolved = "US"

    if resolved == "A":
        if not (raw.isdigit() and len(raw) == 6):
            raise StockError("A-share symbols must contain six digits")
        if raw[0] in {"6", "9"}:
            suffix = "SH"
        elif raw[0] in {"0", "2", "3"}:
            suffix = "SZ"
        elif raw[0] in {"4", "8"}:
            suffix = "BJ"
        else:
            raise StockError("cannot infer A-share exchange from symbol")
        canonical = f"{raw}.{suffix}"
    elif resolved == "HK":
        if not (raw.isdigit() and 1 <= len(raw) <= 5):
            raise StockError("Hong Kong symbols must contain one to five digits")
        canonical = f"{int(raw)}.HK"
    else:
        if not all(char.isalnum() or char in {".", "-"} for char in raw):
            raise StockError("invalid US ticker")
        canonical = f"{raw}.US"
    return {"symbol": canonical, "code": canonical.rsplit(".", 1)[0], "market": resolved, **MARKET_META[resolved]}


ALIASES = {
    "date": ("date", "datetime", "日期", "时间"),
    "open": ("open", "开盘"),
    "high": ("high", "最高"),
    "low": ("low", "最低"),
    "close": ("close", "收盘"),
    "volume": ("volume", "vol", "成交量"),
    "amount": ("amount", "turnover", "成交额"),
    "adjusted_close": ("adjusted_close", "adj_close", "复权收盘"),
}


def _lookup(row: Mapping[str, Any], field: str) -> Any:
    lower = {str(key).strip().lower(): value for key, value in row.items()}
    for alias in ALIASES[field]:
        if alias.lower() in lower:
            return lower[alias.lower()]
    return None


def normalize_bars(payload: Any, *, as_of: str | None = None) -> dict[str, Any]:
    if isinstance(payload, list):
        rows, meta = payload, {}
    elif isinstance(payload, Mapping) and isinstance(payload.get("bars"), list):
        rows, meta = payload["bars"], dict(payload.get("meta") or {})
    else:
        raise StockError("history input must be a row array or an object with bars")
    if len(rows) < 2:
        raise StockError("at least two price bars are required")

    clean = []
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping):
            raise StockError(f"bar {index} must be an object")
        date = _parse_date(_lookup(row, "date"), f"bar {index} date")
        item = {"date": date.isoformat()}
        for field in ("open", "high", "low", "close", "volume"):
            item[field] = _finite(_lookup(row, field), f"bar {index} {field}")
        for field in ("amount", "adjusted_close"):
            value = _finite(_lookup(row, field), f"bar {index} {field}", optional=True)
            if value is not None:
                item[field] = value
        if min(item["open"], item["high"], item["low"], item["close"]) <= 0:
            raise StockError(f"bar {index} prices must be positive")
        if item["high"] < max(item["open"], item["low"], item["close"]):
            raise StockError(f"bar {index} high is below another OHLC value")
        if item["low"] > min(item["open"], item["high"], item["close"]):
            raise StockError(f"bar {index} low is above another OHLC value")
        if item["volume"] < 0:
            raise StockError(f"bar {index} volume must be non-negative")
        clean.append(item)

    clean.sort(key=lambda row: row["date"])
    dates = [row["date"] for row in clean]
    if len(set(dates)) != len(dates):
        raise StockError("duplicate bar dates are not allowed")
    adjusted = ["adjusted_close" in row for row in clean]
    if any(adjusted) and not all(adjusted):
        raise StockError("adjusted_close must cover every bar or none")

    reference = _parse_date(as_of, "as_of") if as_of else dt.datetime.now(dt.timezone.utc).date()
    last = _parse_date(dates[-1])
    age = (reference - last).days
    if age < 0:
        raise StockError("last bar is later than as_of")
    gaps = sum(
        1 for left, right in zip(clean, clean[1:])
        if (_parse_date(right["date"]) - _parse_date(left["date"])).days > 10
    )
    flags = []
    if age > 7:
        flags.append("stale_daily_history")
    if gaps:
        flags.append("calendar_gaps_over_10_days")
    if not all(row["volume"] > 0 for row in clean):
        flags.append("zero_volume_bars")
    return {
        "bars": clean,
        "meta": meta,
        "quality": {
            "bar_count": len(clean),
            "first_date": dates[0],
            "last_date": dates[-1],
            "age_days": age,
            "gap_count": gaps,
            "price_field": "adjusted_close" if all(adjusted) else "close",
            "flags": flags,
        },
    }


def select_history_cutoff(payload: Any, cutoff: str) -> tuple[Any, list[dict[str, Any]]]:
    """Explicit price-history selection, separate from strict as-of validation.

    Preserve input metadata and never manufacture point-in-time fundamentals.
    The same selection applies to analysis, screening and backtesting.
    """
    date = _parse_date(cutoff, "cutoff").isoformat()
    if isinstance(payload, Mapping) and "securities" in payload:
        if not isinstance(payload["securities"], list):
            raise StockError("securities must be an array")
        selected, audit = [], []
        for security in payload["securities"]:
            item, records = select_history_cutoff(security, date)
            selected.append(item)
            audit.extend(records)
        return {**payload, "securities": selected}, audit
    rows = payload if isinstance(payload, list) else payload.get("bars") if isinstance(payload, Mapping) else None
    if not isinstance(rows, list):
        raise StockError("cutoff selection requires price bars")
    dates = []
    for row in rows:
        if not isinstance(row, Mapping):
            raise StockError("cutoff bar must be an object")
        dates.append(_parse_date(_lookup(row, "date")).isoformat())
    if len(set(dates)) != len(dates):
        raise StockError("duplicate bar dates are not allowed")
    retained = [dict(row) for row, observed in zip(rows, dates) if observed <= date]
    if len(retained) < 2:
        raise StockError("cutoff leaves fewer than two price bars")
    record = {"symbol": payload.get("symbol") if isinstance(payload, Mapping) else None,
              "cutoff": date, "input_bars": len(rows), "retained_bars": len(retained),
              "excluded_bars": len(rows) - len(retained)}
    return (retained if isinstance(payload, list) else {**payload, "bars": retained}), [record]


def _returns(values: Sequence[float]) -> list[float]:
    return [values[index] / values[index - 1] - 1 for index in range(1, len(values))]


def _sma(values: Sequence[float], window: int, end: int | None = None) -> float | None:
    stop = len(values) if end is None else end + 1
    if stop < window:
        return None
    return statistics.fmean(values[stop - window:stop])


def _ema(values: Sequence[float], window: int) -> list[float]:
    alpha = 2 / (window + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append(alpha * value + (1 - alpha) * output[-1])
    return output


def _rsi_series(values: Sequence[float], window: int = 14) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    if len(values) <= window:
        return output
    changes = [values[index] - values[index - 1] for index in range(1, len(values))]
    gains = [max(change, 0) for change in changes]
    losses = [max(-change, 0) for change in changes]
    avg_gain = statistics.fmean(gains[:window])
    avg_loss = statistics.fmean(losses[:window])
    output[window] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for index in range(window + 1, len(values)):
        avg_gain = (avg_gain * (window - 1) + gains[index - 1]) / window
        avg_loss = (avg_loss * (window - 1) + losses[index - 1]) / window
        output[index] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return output


def _max_drawdown(returns: Sequence[float]) -> float:
    equity = peak = 1.0
    worst = 0.0
    for value in returns:
        equity *= 1 + value
        peak = max(peak, equity)
        worst = min(worst, equity / peak - 1)
    return worst


def _annual_volatility(returns: Sequence[float]) -> float | None:
    if len(returns) < 2:
        return None
    return statistics.stdev(returns) * math.sqrt(TRADING_DAYS)


def _ratio(value: Any) -> float | None:
    number = _finite(value, "fundamental", optional=True)
    if number is None:
        return None
    return number / 100 if abs(number) > 2 else number


def _scale(value: float | None, low: float, high: float, *, inverse: bool = False) -> float | None:
    if value is None:
        return None
    score = max(0.0, min(1.0, (value - low) / (high - low))) * 100
    return 100 - score if inverse else score


def _mean_present(values: Iterable[float | None]) -> float | None:
    present = [value for value in values if value is not None]
    return statistics.fmean(present) if present else None


def _fundamental_profile(raw: Mapping[str, Any]) -> dict[str, Any]:
    values = {
        "roe": _ratio(raw.get("roe")),
        "net_margin": _ratio(raw.get("net_margin")),
        "free_cash_flow_margin": _ratio(raw.get("free_cash_flow_margin")),
        "revenue_growth": _ratio(raw.get("revenue_growth")),
        "net_income_growth": _ratio(raw.get("net_income_growth")),
        "debt_to_equity": _finite(raw.get("debt_to_equity"), "debt_to_equity", optional=True),
        "current_ratio": _finite(raw.get("current_ratio"), "current_ratio", optional=True),
        "pe": _finite(raw.get("pe"), "pe", optional=True),
        "pb": _finite(raw.get("pb"), "pb", optional=True),
    }
    profitability = _mean_present([
        _scale(values["roe"], 0, 0.25),
        _scale(values["net_margin"], 0, 0.25),
        _scale(values["free_cash_flow_margin"], 0, 0.20),
    ])
    growth = _mean_present([
        _scale(values["revenue_growth"], -0.20, 0.30),
        _scale(values["net_income_growth"], -0.30, 0.40),
    ])
    balance = _mean_present([
        _scale(values["debt_to_equity"], 0, 2, inverse=True),
        _scale(values["current_ratio"], 0.5, 2.0),
    ])
    pe_score = None if values["pe"] is None or values["pe"] <= 0 else _scale(values["pe"], 5, 50, inverse=True)
    pb_score = None if values["pb"] is None or values["pb"] <= 0 else _scale(values["pb"], 0.5, 10, inverse=True)
    valuation = _mean_present([pe_score, pb_score])
    available = sum(value is not None for value in values.values())
    return {
        "values": {key: _rounded(value) for key, value in values.items()},
        "dimensions": {
            "profitability": _rounded(profitability, 4),
            "growth": _rounded(growth, 4),
            "balance_sheet": _rounded(balance, 4),
            "valuation_heuristic": _rounded(valuation, 4),
        },
        "coverage": {"available": available, "possible": len(values)},
        "caveat": "Heuristic dimensions are for evidence organization, not a universal rating.",
    }


def analyze_payload(payload: Any, *, symbol: str | None, source: str | None, as_of: str | None) -> dict[str, Any]:
    if isinstance(payload, Mapping) and "securities" in payload:
        securities = payload["securities"]
        if not isinstance(securities, list):
            raise StockError("analysis universe requires a securities array")
        if not symbol:
            raise StockError("analysis universe requires --symbol to select one security")
        target = normalize_symbol(symbol)["symbol"]
        matches = []
        for index, security in enumerate(securities):
            if not isinstance(security, Mapping):
                raise StockError(f"security {index} must be an object")
            if normalize_symbol(security.get("symbol"))["symbol"] == target:
                matches.append(security)
        if not matches:
            raise StockError(f"analysis symbol not found in securities: {target}")
        if len(matches) != 1:
            raise StockError(f"analysis symbol is ambiguous in securities: {target}")
        # Keep the selected record intact; extracting only bars loses the
        # declared adjustment, cutoff, source and fundamental coverage.
        payload = matches[0]
        selected_meta = payload.get("meta") or {}
        if not isinstance(selected_meta, Mapping):
            raise StockError("security meta must be an object")
        if selected_meta.get("symbol") and normalize_symbol(selected_meta["symbol"])["symbol"] != target:
            raise StockError("security symbol conflicts with meta.symbol")
    meta = (payload.get("meta") or {}) if isinstance(payload, Mapping) else {}
    if not isinstance(meta, Mapping):
        raise StockError("history meta must be an object")
    as_of = as_of or meta.get("as_of")
    normalized = normalize_bars(payload, as_of=as_of)
    bars = normalized["bars"]
    price_field = normalized["quality"]["price_field"]
    prices = [float(row[price_field]) for row in bars]
    daily = _returns(prices)
    ema12, ema26 = _ema(prices, 12), _ema(prices, 26)
    macd_line = [left - right for left, right in zip(ema12, ema26)]
    signal = _ema(macd_line, 9)
    true_ranges = []
    for index, row in enumerate(bars):
        previous = prices[index - 1] if index else float(row["close"])
        true_ranges.append(max(row["high"] - row["low"], abs(row["high"] - previous), abs(row["low"] - previous)))
    rsi = _rsi_series(prices)

    returns_by_window = {}
    for window in (20, 60, 252):
        returns_by_window[str(window)] = _rounded(prices[-1] / prices[-1 - window] - 1) if len(prices) > window else None
    average_turnover = statistics.fmean(
        row.get("amount", row["close"] * row["volume"]) for row in bars[-20:]
    )
    meta = normalized["meta"]
    inferred_symbol = symbol or meta.get("symbol")
    instrument = normalize_symbol(inferred_symbol) if inferred_symbol else None
    fundamentals = payload.get("fundamentals", {}) if isinstance(payload, Mapping) else {}
    return {
        "contract_version": 1,
        "instrument": instrument,
        "provenance": {
            "source": source or (payload.get("source") if isinstance(payload, Mapping) else None)
            or meta.get("source") or "user-file",
            "as_of": as_of or normalized["quality"]["last_date"],
            "adjustment": meta.get("adjustment", "unspecified"),
            "evidence_type": "calculated_from_price_history",
        },
        "quality": normalized["quality"],
        "technical": {
            "last_price": _rounded(prices[-1]),
            "return_20": returns_by_window["20"],
            "return_60": returns_by_window["60"],
            "return_252": returns_by_window["252"],
            "sma_20": _rounded(_sma(prices, 20)),
            "sma_60": _rounded(_sma(prices, 60)),
            "rsi_14": _rounded(rsi[-1], 4),
            "macd": _rounded(macd_line[-1]),
            "macd_signal": _rounded(signal[-1]),
            "atr_14": _rounded(statistics.fmean(true_ranges[-14:]) if len(true_ranges) >= 14 else None),
            "annualized_volatility": _rounded(_annual_volatility(daily)),
            "max_drawdown": _rounded(_max_drawdown(daily)),
            "average_turnover_20": _rounded(average_turnover, 2),
        },
        "fundamental": _fundamental_profile(fundamentals if isinstance(fundamentals, Mapping) else {}),
    }


def _percentile(values: Mapping[str, float], key: str) -> float | None:
    if key not in values:
        return None
    ordered = sorted(values.values())
    if len(ordered) == 1:
        return 50.0
    rank = sum(item < values[key] for item in ordered) + 0.5 * sum(item == values[key] for item in ordered) - 0.5
    return 100 * rank / (len(ordered) - 1)


def screen_payload(payload: Any, *, as_of: str | None) -> dict[str, Any]:
    if not isinstance(payload, Mapping) or not isinstance(payload.get("securities"), list):
        raise StockError("screen input requires a securities array")
    # All peers share the screen cutoff, even when their records carry older
    # observation dates. A historical record must not refresh itself.
    as_of = as_of or dt.datetime.now(dt.timezone.utc).date().isoformat()
    filters = payload.get("filters") or {}
    weights = payload.get("weights") or {
        "momentum": 0.30, "quality": 0.30, "valuation": 0.15,
        "low_volatility": 0.15, "liquidity": 0.10,
    }
    if not isinstance(filters, Mapping) or not isinstance(weights, Mapping):
        raise StockError("filters and weights must be objects")
    allowed_factors = {"momentum", "quality", "valuation", "low_volatility", "liquidity"}
    factor_weights = {}
    for name, value in weights.items():
        if name not in allowed_factors:
            raise StockError(f"unsupported factor weight: {name}")
        number = _finite(value, f"weight {name}")
        if number <= 0:
            raise StockError("factor weights must be positive")
        factor_weights[name] = number

    rows = []
    for index, security in enumerate(payload["securities"]):
        if not isinstance(security, Mapping):
            raise StockError(f"security {index} must be an object")
        symbol = str(security.get("symbol") or "")
        analysis = analyze_payload(
            {"bars": security.get("bars"), "meta": security.get("meta", {}), "fundamentals": security.get("fundamentals", {})},
            symbol=symbol, source=str(security.get("source") or "screen-input"), as_of=as_of,
        )
        tech = analysis["technical"]
        fund = analysis["fundamental"]
        fvalues = fund["values"]
        quality = _mean_present([fund["dimensions"][name] for name in ("profitability", "growth", "balance_sheet")])
        raw_factors = {
            "momentum": tech["return_60"] if tech["return_60"] is not None else tech["return_20"],
            "quality": quality,
            "valuation": fund["dimensions"]["valuation_heuristic"],
            "low_volatility": -tech["annualized_volatility"] if tech["annualized_volatility"] is not None else None,
            "liquidity": math.log1p(tech["average_turnover_20"]) if tech["average_turnover_20"] is not None else None,
        }
        reasons = []
        checks = {
            "min_roe": fvalues["roe"],
            "max_pe": fvalues["pe"],
            "min_momentum_60": tech["return_60"],
            "max_volatility": tech["annualized_volatility"],
            "min_avg_turnover": tech["average_turnover_20"],
        }
        for name, threshold in filters.items():
            if name not in checks:
                raise StockError(f"unsupported screen filter: {name}")
            actual = checks[name]
            limit = _finite(threshold, name)
            if actual is None:
                reasons.append(f"missing:{name}")
            elif name.startswith("min_") and actual < limit:
                reasons.append(f"below:{name}")
            elif name.startswith("max_") and actual > limit:
                reasons.append(f"above:{name}")
        rows.append({
            "symbol": analysis["instrument"]["symbol"],
            "eligible": not reasons,
            "exclusion_reasons": reasons,
            "quality_flags": analysis["quality"]["flags"],
            "factor_raw": {key: _rounded(value) for key, value in raw_factors.items()},
            "factor_coverage": sum(value is not None for value in raw_factors.values()),
        })

    eligible = [row for row in rows if row["eligible"]]
    universes = {
        factor: {row["symbol"]: row["factor_raw"][factor] for row in eligible if row["factor_raw"][factor] is not None}
        for factor in allowed_factors
    }
    for row in eligible:
        components = {factor: _percentile(universes[factor], row["symbol"]) for factor in factor_weights}
        present_weight = sum(factor_weights[name] for name, value in components.items() if value is not None)
        row["factor_percentiles"] = {key: _rounded(value, 4) for key, value in components.items()}
        row["score"] = _rounded(sum(factor_weights[name] * value for name, value in components.items() if value is not None) / present_weight, 4) if present_weight else None
        row["score_weight_coverage"] = _rounded(present_weight / sum(factor_weights.values()), 4)
    eligible.sort(key=lambda row: (row.get("score") is not None, row.get("score") or -1), reverse=True)
    for rank, row in enumerate(eligible, 1):
        row["rank"] = rank
    excluded = [row for row in rows if not row["eligible"]]
    return {
        "contract_version": 1,
        "as_of": as_of,
        "eligible_count": len(eligible),
        "excluded_count": len(excluded),
        "ranking": eligible,
        "excluded": excluded,
        "caveats": [
            "Scores are cross-sectional research priorities, not investment instructions.",
            "Missing factors are excluded and lower score_weight_coverage.",
        ],
    }


def _performance(returns: Sequence[float]) -> dict[str, Any]:
    equity = math.prod(1 + value for value in returns)
    annual = equity ** (TRADING_DAYS / len(returns)) - 1 if returns and equity > 0 else None
    volatility = _annual_volatility(returns)
    sharpe = None
    if len(returns) >= 2 and statistics.stdev(returns) > 0:
        sharpe = statistics.fmean(returns) / statistics.stdev(returns) * math.sqrt(TRADING_DAYS)
    return {
        "total_return": _rounded(equity - 1),
        "annualized_return": _rounded(annual),
        "annualized_volatility": _rounded(volatility),
        "sharpe_zero_rate": _rounded(sharpe),
        "max_drawdown": _rounded(_max_drawdown(returns)),
    }


def backtest_payload(payload: Any, args: argparse.Namespace) -> dict[str, Any]:
    normalized = normalize_bars(payload, as_of=args.as_of)
    bars = normalized["bars"]
    field = normalized["quality"]["price_field"]
    prices = [row[field] for row in bars]
    if len(prices) < 10:
        raise StockError("backtest requires at least ten bars")
    signals = [0.0] * len(prices)
    parameters: dict[str, Any]
    if args.strategy == "sma_cross":
        if args.fast < 2 or args.slow <= args.fast:
            raise StockError("sma_cross requires 2 <= fast < slow")
        for index in range(len(prices)):
            fast, slow = _sma(prices, args.fast, index), _sma(prices, args.slow, index)
            signals[index] = 1.0 if fast is not None and slow is not None and fast > slow else 0.0
        parameters = {"fast": args.fast, "slow": args.slow}
    elif args.strategy == "momentum":
        if args.lookback < 2:
            raise StockError("momentum lookback must be at least two")
        for index in range(args.lookback, len(prices)):
            signals[index] = 1.0 if prices[index] / prices[index - args.lookback] - 1 > args.threshold else 0.0
        parameters = {"lookback": args.lookback, "threshold": args.threshold}
    else:
        if not (0 < args.rsi_entry < args.rsi_exit < 100):
            raise StockError("rsi_reversion requires 0 < entry < exit < 100")
        rsi = _rsi_series(prices)
        held = 0.0
        for index, value in enumerate(rsi):
            if value is not None and value < args.rsi_entry:
                held = 1.0
            elif value is not None and value > args.rsi_exit:
                held = 0.0
            signals[index] = held
        parameters = {"entry": args.rsi_entry, "exit": args.rsi_exit}

    rate = (args.cost_bps + args.slippage_bps) / 10_000
    net_returns, benchmark_returns, applied_positions, trades = [], [], [], []
    previous_position = 0.0
    equity = benchmark_equity = 1.0
    series = []
    for index in range(1, len(prices)):
        position = signals[index - 1]
        gross = prices[index] / prices[index - 1] - 1
        turnover = abs(position - previous_position)
        net = position * gross - turnover * rate
        net_returns.append(net)
        benchmark_returns.append(gross)
        applied_positions.append(position)
        trades.append(turnover)
        equity *= 1 + net
        benchmark_equity *= 1 + gross
        if args.include_series:
            series.append({
                "date": bars[index]["date"], "equity": _rounded(equity),
                "benchmark_equity": _rounded(benchmark_equity), "position": position,
                "signal_date": bars[index - 1]["date"],
                "previous_position": previous_position, "turnover_units": turnover,
                "asset_return": _rounded(gross), "gross_return": _rounded(position * gross),
                "cost_return": _rounded(turnover * rate), "net_return": _rounded(net),
            })
        previous_position = position

    result = {
        "contract_version": 1,
        "strategy": args.strategy,
        "parameters": parameters,
        "sample": {"start": bars[0]["date"], "end": bars[-1]["date"], "bars": len(bars)},
        "data_quality": normalized["quality"],
        "execution": {
            "cost_bps": args.cost_bps,
            "slippage_bps": args.slippage_bps,
            "lookahead_guard": "signal_at_close_t_is_applied_to_return_t_plus_1",
            "dividends_taxes_borrow_market_impact": "not_modeled",
        },
        "performance": {
            **_performance(net_returns),
            "turnover_units": _rounded(sum(trades)),
            "trade_entries": sum(1 for left, right in zip([0.0] + applied_positions, applied_positions) if left == 0 and right > 0),
            "exposure": _rounded(statistics.fmean(applied_positions)),
            "active_period_hit_rate": _rounded(statistics.fmean([value > 0 for value, position in zip(net_returns, applied_positions) if position > 0])) if any(applied_positions) else None,
        },
        "benchmark": {"name": "buy_and_hold_same_price_series", **_performance(benchmark_returns)},
        "limitations": ["No out-of-sample claim is created by this command.", "Corporate-action accuracy follows the supplied adjustment metadata."],
    }
    if args.include_series:
        result["series"] = series
    return result


def portfolio_payload(payload: Any, confidence: float, *, mode: str = "historical") -> dict[str, Any]:
    if not isinstance(payload, Mapping) or not isinstance(payload.get("positions"), list):
        raise StockError("portfolio input requires a positions array")
    if not 0.5 < confidence < 1:
        raise StockError("confidence must be between 0.5 and 1")
    if mode not in ("historical", "scenario"):
        raise StockError("portfolio mode must be historical or scenario")
    positions = payload["positions"]
    if not positions:
        raise StockError("portfolio requires at least one position")
    clean = []
    lengths = set()
    for index, item in enumerate(positions):
        if not isinstance(item, Mapping):
            raise StockError(f"position {index} must be an object")
        weight = _finite(item.get("weight"), f"position {index} weight")
        if weight < 0:
            raise StockError("long-only portfolio weights must be non-negative")
        raw_returns = item.get("returns")
        if mode == "historical" and (not isinstance(raw_returns, list) or len(raw_returns) < 2):
            raise StockError(f"position {index} requires at least two returns")
        returns = [_finite(value, f"position {index} return") for value in raw_returns] if mode == "historical" else []
        lengths.add(len(returns))
        clean.append({
            "symbol": normalize_symbol(str(item.get("symbol") or ""))["symbol"],
            "weight": weight,
            "currency": str(item.get("currency") or "UNKNOWN").upper(),
            "sector": str(item.get("sector") or "UNKNOWN"),
            "returns": returns,
        })
    if len(lengths) != 1:
        raise StockError("position return arrays must be aligned and equal length")
    if len({item["symbol"] for item in clean}) != len(clean):
        raise StockError("portfolio contains duplicate securities")
    weight_sum = sum(item["weight"] for item in clean)
    if not 0.99 <= weight_sum <= 1.01:
        raise StockError(f"portfolio weights must sum to one, got {weight_sum:.6f}")
    for item in clean:
        item["weight"] /= weight_sum
    count = lengths.pop()
    daily = [sum(item["weight"] * item["returns"][index] for item in clean) for index in range(count)]
    losses = sorted(-value for value in daily)
    quantile_index = min(len(losses) - 1, max(0, math.ceil(confidence * len(losses)) - 1))
    var = max(0.0, losses[quantile_index]) if losses else None
    tail = [loss for loss in losses if loss >= var] if losses else []

    def exposure(field: str) -> dict[str, float]:
        values: dict[str, float] = {}
        for item in clean:
            values[item[field]] = values.get(item[field], 0) + item["weight"]
        return {key: _rounded(value) for key, value in sorted(values.items())}

    scenario_results = {}
    scenarios = payload.get("scenarios") or {}
    if not isinstance(scenarios, Mapping):
        raise StockError("scenarios must be an object")
    for name, spec in scenarios.items():
        if not isinstance(spec, Mapping):
            raise StockError(f"scenario {name} must be an object")
        if "local" in spec or "fx" in spec:
            # Explicit compound scenario protocol; legacy linear scenarios below
            # retain their existing semantics. Weights must be in base NAV.
            base = payload.get("base_currency")
            if not isinstance(base, str) or not base or base != base.upper():
                raise StockError("compound scenarios require uppercase base_currency and base-NAV weights")
            local, fx = spec.get("local", {}), spec.get("fx", {})
            if not isinstance(local, Mapping) or not isinstance(fx, Mapping):
                raise StockError("scenario local and fx must be objects")
            if set(spec) - {"local", "fx"}:
                raise StockError("compound scenario supports only local and fx")
            symbols = {item["symbol"] for item in clean}
            currencies = {item["currency"] for item in clean}
            if set(local) - symbols or set(fx) - currencies or "UNKNOWN" in currencies:
                raise StockError("scenario shocks must reference declared securities and currencies")
            if base in fx and _finite(fx[base], "base currency shock") != 0:
                raise StockError("base currency cannot have an FX shock against itself")
            contributions, local_total, fx_total = {}, 0.0, 0.0
            for item in clean:
                price_shock = _finite(local.get(item["symbol"], 0), "local shock")
                fx_shock = _finite(fx.get(item["currency"], 0), "FX shock")
                if price_shock < -1 or fx_shock < -1:
                    raise StockError("scenario price and FX returns cannot be below -100 percent")
                local_total += item["weight"] * price_shock
                fx_total += item["weight"] * fx_shock
                contributions[item["symbol"]] = _rounded(item["weight"] * ((1 + price_shock) * (1 + fx_shock) - 1))
            scenario_results[str(name)] = {"portfolio_return": _rounded(sum(contributions.values())),
                "local_only_return": _rounded(local_total), "fx_only_return": _rounded(fx_total),
                "contributions": contributions, "base_currency": base,
                "method": "base_nav_weight_times_compound_local_and_fx_return"}
            continue
        result = 0.0
        contributions = {}
        for item in clean:
            shock = None
            for bucket in ("symbol", "sector", "currency"):
                nested = spec.get(bucket)
                if isinstance(nested, Mapping) and item[bucket] in nested:
                    shock = _finite(nested[item[bucket]], f"scenario {name} {bucket}")
                    break
            if shock is None:
                for key in (item["symbol"], item["sector"], item["currency"]):
                    if key in spec:
                        shock = _finite(spec[key], f"scenario {name} shock")
                        break
            shock = shock if shock is not None else 0.0
            contribution = item["weight"] * shock
            contributions[item["symbol"]] = _rounded(contribution)
            result += contribution
        scenario_results[str(name)] = {"portfolio_return": _rounded(result), "contributions": contributions}

    sorted_positions = sorted(clean, key=lambda item: item["weight"], reverse=True)
    return {
        "contract_version": 1,
        "analysis_mode": mode,
        "observations": count,
        "performance": _performance(daily) if daily else None,
        "tail_risk": {
            "method": "historical_daily",
            "confidence": confidence,
            "var": _rounded(var),
            "cvar": _rounded(statistics.fmean(tail) if tail else var),
            "caveat": "Historical VaR/CVaR are sample statistics, not maximum-loss estimates.",
        } if daily else None,
        "concentration": {
            "hhi": _rounded(sum(item["weight"] ** 2 for item in clean)),
            "largest_position": {"symbol": sorted_positions[0]["symbol"], "weight": _rounded(sorted_positions[0]["weight"])},
            "top_5_weight": _rounded(sum(item["weight"] for item in sorted_positions[:5])),
        },
        "exposure": {"sector": exposure("sector"), "currency": exposure("currency")},
        "scenarios": scenario_results,
        "limitations": ["Returns must be pre-aligned by the caller." if daily else "No historical risk statistics are estimated in scenario mode.",
                         "Unspecified scenario shocks are zero assumptions, not forecasts.",
                         "Derivatives, leverage, liquidity, taxes, and nonlinear payoffs are not inferred."],
    }


def _order_quote(raw: Mapping[str, Any], instrument: Mapping[str, str]) -> dict[str, Any]:
    """Adapt the shipped quote envelope or a flat quote without inventing facts."""
    if "quote" in raw:
        if raw.get("contract_version") != 1 or not all(
            isinstance(raw.get(key), Mapping) for key in ("quote", "provenance", "quality", "instrument")
        ):
            raise StockError("unsupported quote contract")
        quote = dict(raw["quote"])
        quote["observed_at"] = raw["provenance"].get("observed_at")
        quote["market_session"] = raw["quality"].get("market_session")
        quote["symbol"] = raw["instrument"].get("symbol")
        quote["currency"] = raw["instrument"].get("currency")
    else:
        quote = dict(raw)
    if quote.get("symbol") and normalize_symbol(str(quote["symbol"]))["symbol"] != instrument["symbol"]:
        raise StockError("quote symbol does not match order")
    if quote.get("currency") and quote["currency"] != instrument["currency"]:
        raise StockError("quote currency does not match order")
    # Retrieval time never refreshes a stale observation. Accept equivalent
    # timezone representations but reject conflicting provider observations.
    if quote.get("as_of") is not None and quote.get("observed_at") is not None:
        if _parse_timestamp(quote["as_of"], "quote.as_of") != _parse_timestamp(quote["observed_at"], "quote.observed_at"):
            raise StockError("conflicting quote timestamps")
    elif quote.get("as_of") is None:
        quote["as_of"] = quote.get("observed_at")
    return quote


def validate_order_payload(payload: Any, *, as_of: str | None) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        raise StockError("order input must be an object")
    order = payload.get("order") or {}
    quote = payload.get("quote") or {}
    account = payload.get("account") or {}
    policy = payload.get("policy") or {}
    if not all(isinstance(item, Mapping) for item in (order, quote, account, policy)):
        raise StockError("order, quote, account, and policy must be objects")
    instrument = normalize_symbol(str(order.get("symbol") or ""), str(order.get("market") or "auto"))
    quote = _order_quote(quote, instrument)
    unknown_policy = set(policy) - {"allow_live", "stale_after_seconds", "estimated_fees_bps", "max_order_value", "max_position_weight"}
    if unknown_policy:
        raise StockError("unsupported policy fields: " + ", ".join(sorted(unknown_policy)))
    side = str(order.get("side") or "").upper()
    order_type = str(order.get("order_type") or "MARKET").upper()
    mode = str(order.get("mode") or "paper").lower()
    violations, warnings = [], []
    if side not in {"BUY", "SELL"}:
        violations.append("side_must_be_buy_or_sell")
    if order_type not in {"MARKET", "LIMIT"}:
        violations.append("unsupported_order_type")
    try:
        quantity_number = _finite(order.get("quantity"), "quantity")
        quantity = int(quantity_number)
        if quantity_number != quantity or quantity <= 0:
            violations.append("quantity_must_be_positive_integer")
    except StockError:
        quantity = 0
        violations.append("quantity_must_be_positive_integer")
    last = _finite(quote.get("last"), "quote.last", optional=True)
    limit_price = _finite(order.get("limit_price"), "limit_price", optional=True)
    if order_type == "LIMIT" and (limit_price is None or limit_price <= 0):
        violations.append("positive_limit_price_required")
    price = limit_price if order_type == "LIMIT" else last
    if price is None or price <= 0:
        violations.append("usable_order_price_required")

    now = _parse_timestamp(as_of, "as_of") if as_of else dt.datetime.now(dt.timezone.utc)
    try:
        quote_time = _parse_timestamp(quote.get("as_of"), "quote.as_of")
        age_seconds = (now.astimezone(dt.timezone.utc) - quote_time.astimezone(dt.timezone.utc)).total_seconds()
        if age_seconds < 0:
            violations.append("quote_timestamp_is_in_the_future")
        stale_after = _finite(policy.get("stale_after_seconds", 120), "stale_after_seconds")
        if age_seconds > stale_after:
            violations.append("stale_quote")
    except StockError as exc:
        quote_time, age_seconds = None, None
        violations.append(str(exc).replace(" ", "_"))

    instrument_data = payload.get("instrument") or {}
    lot_size = order.get("lot_size", instrument_data.get("lot_size") if isinstance(instrument_data, Mapping) else None)
    if instrument["market"] == "A" and side == "BUY":
        lot_size = int(_finite(lot_size if lot_size is not None else 100, "lot_size"))
    elif instrument["market"] == "HK" and side == "BUY" and lot_size is None:
        violations.append("hong_kong_buy_requires_current_instrument_lot_size")
    else:
        lot_size = int(_finite(lot_size if lot_size is not None else 1, "lot_size"))
    if lot_size and quantity and quantity % lot_size:
        violations.append("quantity_not_multiple_of_lot_size")

    positions = account.get("positions") or []
    if isinstance(positions, Mapping):
        positions = [{"symbol": key, **(value if isinstance(value, Mapping) else {"quantity": value})} for key, value in positions.items()]
    if not isinstance(positions, list):
        raise StockError("account.positions must be an array or object")
    held = sellable = current_value = 0.0
    sellable_known = False
    for position in positions:
        if not isinstance(position, Mapping) or not position.get("symbol"):
            continue
        try:
            matches = normalize_symbol(str(position["symbol"]))["symbol"] == instrument["symbol"]
        except StockError:
            matches = False
        if matches:
            held = _finite(position.get("quantity", 0), "position.quantity")
            current_value = _finite(position.get("market_value", 0), "position.market_value")
            if position.get("sellable_quantity") is not None:
                sellable = _finite(position.get("sellable_quantity"), "position.sellable_quantity")
                sellable_known = True
            elif instrument["market"] != "A":
                sellable, sellable_known = held, True
            break
    if side == "SELL":
        if instrument["market"] == "A" and not sellable_known:
            violations.append("a_share_sell_requires_sellable_quantity_for_t_plus_1")
        elif quantity > sellable:
            violations.append("insufficient_sellable_quantity")

    fees_bps = _finite(policy.get("estimated_fees_bps", 0), "estimated_fees_bps")
    order_value = quantity * price if quantity and price else None
    estimated_cash = order_value * (1 + fees_bps / 10_000) if order_value is not None else None
    cash = _finite(account.get("cash"), "account.cash", optional=True)
    if side == "BUY" and estimated_cash is not None:
        if cash is None:
            violations.append("cash_balance_required_for_buy")
        elif estimated_cash > cash:
            violations.append("insufficient_cash")
    max_order_value = _finite(policy.get("max_order_value"), "max_order_value", optional=True)
    if max_order_value is not None and order_value is not None and order_value > max_order_value:
        violations.append("max_order_value_exceeded")
    nav = _finite(account.get("net_asset_value"), "net_asset_value", optional=True)
    max_position_weight = _finite(policy.get("max_position_weight"), "max_position_weight", optional=True)
    projected_weight = None
    if max_position_weight is not None:
        if nav is None or nav <= 0 or order_value is None:
            violations.append("net_asset_value_required_for_position_limit")
        else:
            projected_value = current_value + order_value if side == "BUY" else max(0, current_value - order_value)
            projected_weight = projected_value / nav
            if projected_weight > max_position_weight:
                violations.append("max_position_weight_exceeded")

    if mode not in {"paper", "live"}:
        violations.append("mode_must_be_paper_or_live")
    if mode == "live":
        if policy.get("allow_live") is not True:
            violations.append("policy_does_not_allow_live_orders")
        if payload.get("explicit_user_authorization") is not True:
            violations.append("exact_live_order_not_explicitly_authorized")
    if not order.get("time_in_force"):
        warnings.append("time_in_force_not_declared")
    if not quote.get("market_session"):
        warnings.append("market_session_not_verified")

    return {
        "contract_version": 1,
        "allowed": not violations,
        "violations": sorted(set(violations)),
        "warnings": sorted(set(warnings)),
        "normalized_order": {
            "symbol": instrument["symbol"], "market": instrument["market"],
            "currency": instrument["currency"], "side": side, "quantity": quantity,
            "order_type": order_type, "limit_price": _rounded(limit_price),
            "time_in_force": order.get("time_in_force"), "mode": mode, "lot_size": lot_size,
        },
        "evidence": {
            "quote_as_of": quote_time.isoformat() if quote_time else None,
            "quote_age_seconds": _rounded(age_seconds, 2),
            "last_price": _rounded(last),
        },
        "estimates": {
            "order_value": _rounded(order_value, 2),
            "cash_required_with_estimated_fees": _rounded(estimated_cash, 2),
            "projected_position_weight": _rounded(projected_weight),
        },
        "execution": "validation_only_no_order_was_submitted",
    }


def _markdown_cell(value: Any) -> str:
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    elif value is None:
        text = "—"
    else:
        text = str(value)
    return text.replace("|", "\\|").replace("\n", "<br>")


def evidence_record(filename: str) -> dict[str, Any]:
    """Bind report provenance to source bytes rather than a model's transcription.

    Keep declared structured metadata verbatim. No free-text interpretation or
    replacement of observation dates with file/retrieval time occurs here.
    """
    source = Path(filename)
    if not source.is_file():
        raise StockError("evidence file not found")
    raw = source.read_bytes()
    try:
        payload = {} if source.suffix.lower() == ".csv" else json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise StockError("evidence must be valid JSON or CSV") from exc
    fields = ("symbol", "order_id", "mode", "source", "timestamp", "observed_at", "retrieved_at",
              "as_of", "currency", "base_currency", "meta", "instrument", "provenance", "sample", "input_selection")
    def metadata(value: Any) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}
        result = {key: value[key] for key in fields if key in value}
        for key in ("quote", "order", "data"):
            if isinstance(value.get(key), Mapping):
                result[key] = metadata(value[key])
        if isinstance(value.get("securities"), list):
            result["securities"] = [metadata(item) for item in value["securities"]]
        return result
    return {"file": source.name, "sha256": hashlib.sha256(raw).hexdigest(),
            "declared_metadata": metadata(payload)}


def render_report(payload: Any, *, sources: Sequence[Mapping[str, Any]] = ()) -> str:
    if not isinstance(payload, Mapping):
        raise StockError("report dossier must be an object")
    lines = [f"# {_markdown_cell(payload.get('title') or 'Stock Analysis')}", ""]
    if sources:
        lines.extend(["## Source records", "", "These are file snapshots; record times below are not a claim of current state.", "",
                      "| File | SHA-256 | Declared metadata |", "| --- | --- | --- |"])
        lines.extend(f"| {_markdown_cell(item['file'])} | {_markdown_cell(item['sha256'])} | {_markdown_cell(item['declared_metadata'])} |" for item in sources)
        lines.append("")
    for name in ("scope", "evidence", "summary"):
        value = payload.get(name)
        if value is None:
            continue
        lines.extend([f"## {name.replace('_', ' ').title()}", ""])
        if isinstance(value, Mapping):
            lines.extend(["| Field | Value |", "| --- | --- |"])
            lines.extend(f"| {_markdown_cell(key)} | {_markdown_cell(item)} |" for key, item in value.items())
        elif isinstance(value, list):
            lines.extend(f"- {_markdown_cell(item)}" for item in value)
        else:
            lines.append(_markdown_cell(value))
        lines.append("")
    metrics = payload.get("metrics")
    if isinstance(metrics, Mapping):
        lines.extend(["## Metrics", "", "| Metric | Value |", "| --- | --- |"])
        lines.extend(f"| {_markdown_cell(key)} | {_markdown_cell(value)} |" for key, value in metrics.items())
        lines.append("")
    elif isinstance(metrics, list) and all(isinstance(row, Mapping) for row in metrics):
        columns = list(dict.fromkeys(key for row in metrics for key in row))
        if columns:
            lines.extend(["## Metrics", "", "| " + " | ".join(_markdown_cell(key) for key in columns) + " |",
                          "| " + " | ".join("---" for _ in columns) + " |"])
            lines.extend("| " + " | ".join(_markdown_cell(row.get(key)) for key in columns) + " |" for row in metrics)
            lines.append("")
    elif metrics is not None:
        raise StockError("report metrics must be an object or an array of objects")
    for name in ("scenarios", "risks", "limitations", "next_steps"):
        value = payload.get(name)
        if value is None:
            continue
        lines.extend([f"## {name.replace('_', ' ').title()}", ""])
        if isinstance(value, Mapping):
            lines.extend(f"- **{_markdown_cell(key)}:** {_markdown_cell(item)}" for key, item in value.items())
        elif isinstance(value, list):
            lines.extend(f"- {_markdown_cell(item)}" for item in value)
        else:
            lines.append(_markdown_cell(value))
        lines.append("")
    lines.extend(["---", "Generated from the supplied StockAnalyser dossier; absent fields were not inferred.", ""])
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    normalize = commands.add_parser("normalize-symbol")
    normalize.add_argument("--symbol", required=True)
    normalize.add_argument("--market", default="auto")

    analyze = commands.add_parser("analyze")
    analyze.add_argument("--input", required=True)
    analyze.add_argument("--symbol")
    analyze.add_argument("--source")
    analyze.add_argument("--as-of")
    analyze.add_argument("--cutoff")
    analyze.add_argument("--output")

    screen = commands.add_parser("screen")
    screen.add_argument("--input", required=True)
    screen.add_argument("--as-of")
    screen.add_argument("--cutoff")
    screen.add_argument("--output")

    backtest = commands.add_parser("backtest")
    backtest.add_argument("--input", required=True)
    backtest.add_argument("--strategy", choices=["sma_cross", "momentum", "rsi_reversion"], required=True)
    backtest.add_argument("--fast", type=int, default=20)
    backtest.add_argument("--slow", type=int, default=60)
    backtest.add_argument("--lookback", type=int, default=60)
    backtest.add_argument("--threshold", type=float, default=0.0)
    backtest.add_argument("--rsi-entry", type=float, default=30.0)
    backtest.add_argument("--rsi-exit", type=float, default=55.0)
    backtest.add_argument("--cost-bps", type=float, default=0.0)
    backtest.add_argument("--slippage-bps", type=float, default=0.0)
    backtest.add_argument("--as-of")
    backtest.add_argument("--cutoff")
    backtest.add_argument("--include-series", action="store_true")
    backtest.add_argument("--output")

    portfolio = commands.add_parser("portfolio-risk")
    portfolio.add_argument("--input", required=True)
    portfolio.add_argument("--confidence", type=float, default=0.95)
    portfolio.add_argument("--mode", choices=["historical", "scenario"], default="historical")
    portfolio.add_argument("--output")

    order = commands.add_parser("validate-order")
    order.add_argument("--input", required=True)
    order.add_argument("--as-of")
    order.add_argument("--output")

    report = commands.add_parser("render-report")
    report.add_argument("--input", required=True)
    report.add_argument("--output")
    report.add_argument("--evidence-input", action="append", default=[])
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        input_path = getattr(args, "input", None)
        evidence_paths = getattr(args, "evidence_input", [])
        output = getattr(args, "output", None)
        # Protect every analysis input, including symlink/hardlink aliases, at
        # the shared write boundary. Existing separate output files still work.
        if output:
            target = Path(output)
            for filename in ([input_path] if input_path else []) + evidence_paths:
                source = Path(filename)
                if target.resolve() == source.resolve() or (target.exists() and source.exists() and target.samefile(source)):
                    raise StockError("output must not overwrite an input or evidence file")
        payload = _read(input_path) if input_path else None
        selection = None
        cutoff = getattr(args, "cutoff", None)
        if cutoff:
            if args.as_of and _parse_date(args.as_of) != _parse_date(cutoff):
                raise StockError("cutoff and as-of must agree when both are provided")
            payload, selection = select_history_cutoff(payload, cutoff)
            args.as_of = _parse_date(cutoff).isoformat()
        if args.command == "normalize-symbol":
            result = normalize_symbol(args.symbol, args.market)
        elif args.command == "analyze":
            result = analyze_payload(payload, symbol=args.symbol, source=args.source, as_of=args.as_of)
        elif args.command == "screen":
            result = screen_payload(payload, as_of=args.as_of)
        elif args.command == "backtest":
            if args.cost_bps < 0 or args.slippage_bps < 0:
                raise StockError("cost and slippage must be non-negative")
            result = backtest_payload(payload, args)
        elif args.command == "portfolio-risk":
            result = portfolio_payload(payload, args.confidence, mode=args.mode)
        elif args.command == "validate-order":
            result = validate_order_payload(payload, as_of=args.as_of)
        else:
            rendered = render_report(payload, sources=[evidence_record(filename) for filename in evidence_paths])
            if args.output:
                target = Path(args.output)
                if not target.parent.is_dir():
                    raise StockError(f"output directory does not exist: {target.parent}")
                target.write_text(rendered, encoding="utf-8")
            else:
                sys.stdout.write(rendered)
            return 0
        if selection is not None:
            result["input_selection"] = {"method": "price_bars_on_or_before_cutoff", "histories": selection,
                "limitation": "Price selection does not establish point-in-time availability of fundamentals or universe membership."}
        _emit(result, output)
        return 0
    except StockError as exc:
        sys.stderr.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
