"""Offline CLI regression for measured returns versus declared value scenarios."""

import json
import math
import os
from pathlib import Path
import subprocess
import sys

import pytest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
ENTRYPOINTS = ["calculate_metrics", "analyze_performance"]


def campaign(**changes):
    data = {
        "platform": "instagram",
        "total_spend": 100,
        "posts": [{
            "post_id": "one", "likes": 8, "comments": 1, "shares": 1,
            "saves": 0, "reach": 100, "impressions": 200, "clicks": 10,
        }],
    }
    data.update(changes)
    return data


def invoke(tmp_path, script, data):
    source = tmp_path / "campaign.json"
    source.write_text(json.dumps(data), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPTS / f"{script}.py"), str(source)],
        cwd=tmp_path, capture_output=True, text=True, timeout=10,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert result.stderr == "", result.stderr
    output = json.loads(result.stdout)
    assert result.returncode == (0 if output.get("ok") else 1)
    return output


@pytest.fixture(params=ENTRYPOINTS)
def run_metrics(tmp_path, request):
    return lambda data: invoke(tmp_path, request.param, data)


@pytest.mark.parametrize("revenue,roas,roi", [(0, 0, -100), (1000, 10, 900)])
def test_measured_revenue_changes_returns_with_explicit_zero_other_cost(run_metrics, revenue, roas, roi):
    output = run_metrics(campaign(revenue=revenue, non_marketing_costs=0))
    assert output["ok"] is True
    metrics = output["roi_metrics"]
    assert metrics.get("revenue") == revenue
    assert metrics.get("roas") == roas
    assert metrics["roi_percentage"] == roi
    assert metrics.get("roi_basis") == "revenue_less_non_marketing_costs"
    assert metrics["estimated_value"] is None


def test_roi_uses_matching_costs_without_treating_sales_as_profit(run_metrics):
    output = run_metrics(campaign(revenue=1000, non_marketing_costs=600))
    assert output["ok"] is True
    assert output["roi_metrics"]["roas"] == 10
    assert output["roi_metrics"]["roi_percentage"] == 300


def test_revenue_without_other_costs_supports_roas_but_not_profit_roi(run_metrics):
    output = run_metrics(campaign(revenue=1000))
    assert output["ok"] is True
    metrics = output["roi_metrics"]
    assert metrics.get("roas") == 10
    assert metrics["roi_percentage"] is None
    assert "non_marketing_costs" in metrics["unavailable_reasons"]["roi_percentage"]


def test_missing_revenue_is_not_zero_or_an_implicit_interaction_value(run_metrics):
    output = run_metrics(campaign())
    assert output["ok"] is True
    metrics = output["roi_metrics"]
    assert metrics.get("revenue") is None
    assert metrics.get("roas") is None
    assert metrics["roi_percentage"] is None
    assert metrics["estimated_value"] is None
    assert "revenue" in metrics["unavailable_reasons"]["roi_percentage"]


@pytest.mark.parametrize("spend", [None, 0])
def test_missing_and_zero_spend_leave_return_ratios_undefined(run_metrics, spend):
    output = run_metrics(campaign(total_spend=spend, revenue=1000, non_marketing_costs=0))
    assert output["ok"] is True
    metrics = output["roi_metrics"]
    assert metrics["total_spend"] == spend
    assert metrics.get("roas") is None
    assert metrics["roi_percentage"] is None
    assert "total_spend" in metrics["unavailable_reasons"]["roi_percentage"]
    assert metrics["cost_per_click"] == (None if spend is None else 0)


def test_explicit_value_scenario_stays_separate_from_observed_returns(run_metrics):
    output = run_metrics(campaign(value_per_engagement=1000, conversion_value=500))
    assert output["ok"] is True
    metrics = output["roi_metrics"]
    assert metrics["estimated_value"] == 10000
    assert metrics.get("estimated_roi_percentage") == 9900
    assert metrics.get("estimate_basis") == "user_supplied_value_per_engagement"
    assert metrics.get("conversion_value_return_percentage") == 400
    assert metrics.get("roas") is None
    assert metrics["roi_percentage"] is None
    assert all("ROI" not in row and "预算" not in row and "budget" not in row.lower()
               for row in output.get("recommendations", []))


def test_zero_value_is_valid_and_never_replaced_by_another_basis(run_metrics):
    output = run_metrics(campaign(revenue=0, non_marketing_costs=0,
                                  conversion_value=500, value_per_engagement=0))
    assert output["ok"] is True
    metrics = output["roi_metrics"]
    assert metrics.get("roas") == 0
    assert metrics["roi_percentage"] == -100
    assert metrics["estimated_value"] == 0


def test_complete_post_money_can_be_summed_but_campaign_totals_are_not_added_again(run_metrics):
    data = campaign()
    data.pop("total_spend")
    data["posts"] = [dict(data["posts"][0], spend=40, revenue=400, non_marketing_costs=100),
                     dict(data["posts"][0], post_id="two", spend=60, revenue=600, non_marketing_costs=500)]
    metrics = run_metrics(data)["roi_metrics"]
    assert (metrics.get("total_spend"), metrics.get("revenue"), metrics.get("roas"),
            metrics["roi_percentage"]) == (100, 1000, 10, 300)
    metrics = run_metrics({**data, "total_spend": 200, "revenue": 2000,
                           "non_marketing_costs": 1200})["roi_metrics"]
    assert (metrics.get("total_spend"), metrics.get("revenue"), metrics.get("roas"),
            metrics["roi_percentage"]) == (200, 2000, 10, 300)


def test_partial_post_revenue_is_not_presented_as_a_complete_total(run_metrics):
    data = campaign()
    data["posts"] = [dict(data["posts"][0], revenue=100), dict(data["posts"][0], post_id="two")]
    metrics = run_metrics(data)["roi_metrics"]
    assert metrics.get("revenue") is None
    assert metrics.get("roas") is None
    assert metrics["roi_percentage"] is None


@pytest.mark.parametrize("field,value", [
    ("total_spend", -1), ("revenue", "100"), ("revenue", True),
    ("non_marketing_costs", -1), ("conversion_value", float("nan")),
    ("value_per_engagement", float("inf")),
])
def test_invalid_money_is_a_structured_input_failure(run_metrics, field, value):
    output = run_metrics(campaign(**{field: value}))
    assert output["ok"] is False
    assert "roi_metrics" not in output
    errors = " ".join(output["details"]["errors"])
    if isinstance(value, float) and not math.isfinite(value):
        assert errors  # NaN/Infinity are invalid JSON even outside known fields.
    else:
        assert field in errors


def test_missing_or_zero_counters_do_not_invent_rates_or_block_supported_returns(run_metrics):
    data = campaign(revenue=1000, non_marketing_costs=600)
    data["posts"][0].update(reach=0, impressions=0, clicks=0)
    output = run_metrics(data)
    assert output["ok"] is True
    assert output["campaign_metrics"]["avg_engagement_rate"] is None
    assert output["campaign_metrics"]["ctr"] is None
    assert output["roi_metrics"]["cost_per_click"] is None
    assert output["roi_metrics"]["roi_percentage"] == 300
    del data["posts"][0]["reach"]
    output = run_metrics(data)
    assert output["ok"] is True
    assert output["campaign_metrics"]["total_reach"] is None
    assert output["campaign_metrics"]["avg_engagement_rate"] is None


def test_both_entrypoints_keep_the_same_calculation_contract(tmp_path):
    data = campaign(revenue=1000, non_marketing_costs=600, conversion_value=500,
                    value_per_engagement=2)
    outputs = [invoke(tmp_path, script, data) for script in ENTRYPOINTS]
    assert outputs[0]["campaign_metrics"] == outputs[1]["campaign_metrics"]
    assert outputs[0]["roi_metrics"] == outputs[1]["roi_metrics"]
    assert outputs[0]["roi_metrics"]["roi_percentage"] == 300


def test_incomplete_interactions_preserve_supported_click_and_return_metrics(run_metrics):
    data = campaign(revenue=1000, non_marketing_costs=600)
    del data["posts"][0]["likes"]
    output = run_metrics(data)
    assert output["ok"] is True
    assert output["campaign_metrics"]["total_engagements"] is None
    assert output["campaign_metrics"]["avg_engagement_rate"] is None
    assert output["campaign_metrics"]["ctr"] == 5
    assert output["roi_metrics"]["cost_per_engagement"] is None
    assert output["roi_metrics"]["roi_percentage"] == 300


def test_reconciled_costs_can_produce_a_negative_roi(run_metrics):
    output = run_metrics(campaign(revenue=1000, non_marketing_costs=1500))
    assert output["ok"] is True
    assert output["roi_metrics"]["roi_percentage"] == -600


@pytest.mark.parametrize("data", [[], {"posts": []}, {"posts": [None]}])
def test_invalid_corpus_is_rejected_without_a_partial_report(run_metrics, data):
    output = run_metrics(data)
    assert output["ok"] is False
    assert "roi_metrics" not in output
    assert output["details"]["errors"]


def test_nonfinite_unknown_post_metadata_is_rejected_before_serialization(run_metrics):
    data = campaign(revenue=1000, non_marketing_costs=600)
    data["posts"][0]["extra_metadata"] = float("nan")
    output = run_metrics(data)
    assert output["ok"] is False
    assert "roi_metrics" not in output
