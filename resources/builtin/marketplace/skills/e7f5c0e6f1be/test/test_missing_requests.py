"""Missing-dependency envelope tests for the social fetch scripts.

stdlib unittest, no third-party deps.

Run:  cd PC/resources/builtin/marketplace/skills/e7f5c0e6f1be && python3 -m unittest

`social_fetch_core.py` used to do a bare `import requests`, so in a
stdlib-only sandbox every fetch died at import time with a raw traceback
instead of the documented `{"ok": false, "error": ..., "platform": ...}`
envelope (see fetch.py's docstring). These tests run fetch.py in a
subprocess with `requests` (and the optional deps) poisoned via a
PYTHONPATH shim, and assert the JSON contract:

  - Fetchers that need `requests` (xhs, reddit, bilibili-without-curl_cffi)
    exit 1 with a stderr JSON envelope naming the missing dependency.
  - Fetchers that never touch `requests` (twitter) still import and run,
    emitting the normal `{"ok": true, ...}` stdout envelope.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FETCH_PY = os.path.join(SKILL_DIR, "scripts", "fetch.py")

# Modules poisoned in the subprocess: `requests` is the subject under test;
# browser_cookie3/curl_cffi are blocked too so the test is hermetic on
# machines that happen to have them (no cookie reads, no TLS fallbacks).
_BLOCKED_MODULES = ("requests", "browser_cookie3", "curl_cffi")


def _run_fetch(shim_dir, *args, timeout=60):
    env = dict(os.environ)
    env["PYTHONPATH"] = shim_dir
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    # Restricted PATH: external CLIs (xreach, yt-dlp) must not be found, so
    # no network work happens even for fetchers that import fine.
    env["PATH"] = "/usr/bin:/bin"
    return subprocess.run(
        [sys.executable, FETCH_PY, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        cwd=SKILL_DIR,
    )


def _last_json_line(stream_text):
    lines = [ln for ln in stream_text.strip().splitlines() if ln.strip()]
    if not lines:
        raise AssertionError("expected a JSON line, got empty output")
    return json.loads(lines[-1])


class MissingRequestsEnvelope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="social-fetch-shim-")
        cls.shim_dir = cls._tmp.name
        for name in _BLOCKED_MODULES:
            with open(os.path.join(cls.shim_dir, name + ".py"), "w") as f:
                f.write(
                    "raise ImportError(\"No module named '%s' (blocked by test shim)\")\n"
                    % name
                )

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _assert_missing_dependency_envelope(self, proc, platform):
        self.assertEqual(
            proc.returncode, 1,
            "expected exit 1, got %s\nstdout: %r\nstderr: %r"
            % (proc.returncode, proc.stdout, proc.stderr),
        )
        self.assertNotIn("Traceback", proc.stderr)
        err = _last_json_line(proc.stderr)
        self.assertIs(err.get("ok"), False)
        self.assertEqual(err.get("platform"), platform)
        self.assertIn("requests", err.get("error", ""))
        self.assertIn("missing dependency", err.get("error", ""))

    def test_xhs_without_requests_emits_json_error_envelope(self):
        proc = _run_fetch(self.shim_dir, "xhs", "keyword")
        self._assert_missing_dependency_envelope(proc, "xhs")

    def test_reddit_without_requests_emits_json_error_envelope(self):
        proc = _run_fetch(self.shim_dir, "reddit", "keyword")
        self._assert_missing_dependency_envelope(proc, "reddit")

    def test_bilibili_without_requests_or_curl_cffi_emits_json_error_envelope(self):
        proc = _run_fetch(self.shim_dir, "bilibili", "keyword")
        self._assert_missing_dependency_envelope(proc, "bilibili")

    def test_twitter_without_requests_still_runs_and_returns_ok_envelope(self):
        # fetch_twitter only shells out to xreach; a missing `requests` must
        # not break module import for it. With xreach unavailable on the
        # restricted PATH it degrades to an empty ok:true result.
        proc = _run_fetch(self.shim_dir, "twitter", "keyword", timeout=120)
        self.assertEqual(
            proc.returncode, 0,
            "expected exit 0, got %s\nstdout: %r\nstderr: %r"
            % (proc.returncode, proc.stdout, proc.stderr),
        )
        out = _last_json_line(proc.stdout)
        self.assertIs(out.get("ok"), True)
        self.assertEqual(out.get("platform"), "twitter")
        self.assertEqual(out.get("count"), 0)


if __name__ == "__main__":
    unittest.main()
