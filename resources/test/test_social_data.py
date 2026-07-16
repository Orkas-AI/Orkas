import importlib.util
import json
import subprocess
import sys
from http.cookiejar import Cookie
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


SCRIPT_ROOT = (
    Path(__file__).resolve().parents[1]
    / "builtin/marketplace/skills/e7f5c0e6f1be/scripts"
)


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPT_ROOT / f"{name}.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


analyze = load_script("analyze_performance")
calculator = load_script("calculate_metrics")
fetch_core = load_script("social_fetch_core")


def sample_campaign():
    return {
        "platform": "instagram",
        "total_spend": 20,
        "posts": [
            {
                "id": "high",
                "likes": 10,
                "comments": 2,
                "shares": 1,
                "saves": 1,
                "reach": 100,
                "impressions": 200,
                "clicks": 4,
            },
            {
                "id": "low",
                "likes": 1,
                "reach": 100,
                "impressions": 100,
                "clicks": 1,
            },
        ],
    }


def test_analyzers_aggregate_benchmark_rank_and_roi_consistently():
    result = analyze.main([])
    assert result["ok"] is False

    metrics = analyze.calculate_metrics(sample_campaign())
    assert metrics["campaign_metrics"] == {
        "platform": "instagram",
        "total_posts": 2,
        "total_engagements": 15,
        "total_reach": 200,
        "total_impressions": 300,
        "total_clicks": 5,
        "avg_engagement_rate": 7.5,
        "ctr": 1.67,
    }
    assert metrics["roi_metrics"]["cost_per_click"] == 4.0
    assert analyze.benchmark_performance(metrics["campaign_metrics"])["ctr_status"] == "excellent"

    detailed = calculator.SocialMediaMetricsCalculator(sample_campaign()).analyze_all()
    assert detailed["ok"] is True
    assert [post["id"] for post in detailed["top_posts"]] == ["high", "low"]
    assert detailed["campaign_metrics"] == metrics["campaign_metrics"]


def test_analyzers_reject_empty_negative_and_zero_reach_inputs(tmp_path):
    invalid = calculator.SocialMediaMetricsCalculator({
        "total_spend": -1,
        "posts": [{"reach": 0, "clicks": -1}],
    }).analyze_all()
    assert invalid["ok"] is False
    assert invalid["details"]["errors"] == [
        "posts[0].reach must be > 0",
        "posts[0].clicks must be non-negative",
        "total_spend must be non-negative",
    ]

    payload = tmp_path / "invalid.json"
    payload.write_text(json.dumps({"posts": []}), encoding="utf-8")
    assert analyze.main([str(payload)])["error"] == "invalid input"


def test_cookie_loader_does_not_touch_browser_stores_without_explicit_opt_in(monkeypatch):
    loader = Mock()
    monkeypatch.setattr(fetch_core, "_BROWSER_COOKIE3_OK", True)
    monkeypatch.setattr(
        fetch_core,
        "browser_cookie3",
        SimpleNamespace(chrome=loader),
        raising=False,
    )

    assert fetch_core._load_cookies_for_domain(".reddit.com") == {}
    loader.assert_not_called()


def test_cookie_loader_uses_configured_browser_order_and_falls_back_after_opt_in(monkeypatch):
    monkeypatch.setattr(fetch_core, "_BROWSER_COOKIE3_OK", True)
    monkeypatch.setenv("SOCIAL_FETCH_BROWSERS", "missing,chrome,firefox")
    chrome = Mock(side_effect=RuntimeError("locked"))
    cookie = Cookie(
        version=0, name="session", value="token", port=None, port_specified=False,
        domain=".reddit.com", domain_specified=True, domain_initial_dot=True,
        path="/", path_specified=True, secure=True, expires=None, discard=True,
        comment=None, comment_url=None, rest={}, rfc2109=False,
    )
    firefox = Mock(return_value=[cookie])
    monkeypatch.setattr(
        fetch_core,
        "browser_cookie3",
        SimpleNamespace(chrome=chrome, firefox=firefox),
        raising=False,
    )

    assert fetch_core._load_cookies_for_domain(".reddit.com", allowed=True) == {"session": "token"}
    chrome.assert_called_once_with(domain_name=".reddit.com")
    firefox.assert_called_once_with(domain_name=".reddit.com")


def test_command_helpers_and_external_failures_are_fail_closed(monkeypatch):
    monkeypatch.setattr(fetch_core.shutil, "which", lambda _name: None)
    assert fetch_core.yt_dlp_cmd("video") == [sys.executable, "-m", "yt_dlp", "video"]
    assert fetch_core.xreach_cmd("topic", 3) == ["xreach", "search", "topic", "--json", "-n", "3"]

    failed = subprocess.CompletedProcess([], 1, stdout="not-json", stderr="failed")
    with patch.object(fetch_core.subprocess, "run", return_value=failed):
        assert fetch_core._yt_dlp_meta("https://example.test") == {}
        assert fetch_core._twitter_fetch_comments("https://example.test") == []
        assert fetch_core._youtube_fetch_comments("https://example.test") == []


def test_diagnostics_accumulate_errors_and_details():
    diag = fetch_core.make_diag("Test")
    fetch_core.add_diag(diag, status="error", errors="first", detail={"attempt": 1})
    fetch_core.add_diag(diag, errors="second", selected=2)
    assert diag["status"] == "error"
    assert diag["errors"] == ["first", "second"]
    assert diag["details"] == [{"attempt": 1}]
    assert diag["selected"] == 2
