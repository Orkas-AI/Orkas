"""Checkpoint protocol for pytest; keeps module/session fixtures within a shard."""
import json
import logging
import os
import signal
import sys
from pathlib import Path

import pytest


def pytest_addoption(parser):
    parser.addoption('--orkas-checkpoint-shard', default='1/1')


class Checkpoint:
    def __init__(self, config):
        self.config = config
        self.path = Path(os.environ['ORKAS_TEST_BATCH_REPORT'])
        self.events = self.path.with_suffix('.events.jsonl')
        self.events.write_text('', encoding='utf-8')
        self.inventory = []
        self.results = {}
        self.expected_errors = []
        self.errors = 0
        self.current = 'collection'
        self.phase = 'collection'
        self.signal_handlers = {}
        for name in ('SIGTERM', 'SIGHUP'):
            value = getattr(signal, name, None)
            if value is not None:
                self.signal_handlers[value] = signal.getsignal(value)
                signal.signal(value, self.interrupt)
        owner = self

        class Handler(logging.Handler):
            def emit(self, record):
                level = 'error' if record.levelno >= 40 else 'warn' if record.levelno >= 30 else 'info'
                owner.event('stdout', f'[00:00:00.000] [{level}] [(python)] {record.getMessage()}\n')
        self.handler = Handler()
        logging.getLogger().addHandler(self.handler)

    @staticmethod
    def interrupt(signum, frame):
        # Let pytest unwind fixtures and stop its children before the parent exits.
        raise KeyboardInterrupt

    def event(self, stream, text):
        with self.events.open('a', encoding='utf-8') as output:
            output.write(json.dumps({'case': self.current, 'phase': self.phase, 'stream': stream, 'text': text}) + '\n')

    def drain_console(self):
        # The production console sink queues IO. Settle it while pytest still
        # owns this phase's capture, before another case can inherit its logs.
        module = sys.modules.get('utils.log')
        sink = getattr(module, '_console_sink', None)
        wait = getattr(sink, 'wait_idle', None)
        if callable(wait) and not wait(timeout=1):
            self.errors += 1
            self.event('stderr', '[00:00:00.000] [error] [(python-checkpoint)] Console log drain timed out\n')

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, session, config, items):
        self.drain_console()
        part, total = map(int, config.getoption('--orkas-checkpoint-shard').split('/'))
        files = sorted({str(item.path) for item in items})
        selected_files = set(files[part - 1::total])
        kept = [item for item in items if str(item.path) in selected_files]
        removed = [item for item in items if str(item.path) not in selected_files]
        if removed:
            config.hook.pytest_deselected(items=removed)
        items[:] = kept
        self.inventory = [item.nodeid for item in items]
        self.batch_units = len(files)
        for item in items:
            for marker in item.iter_markers('orkas_expected_errors'):
                if marker.kwargs or not marker.args:
                    raise pytest.UsageError('Expected error logs require explicit (prefix, count) pairs')
                for value in marker.args:
                    if (not isinstance(value, (tuple, list)) or len(value) != 2
                            or not isinstance(value[0], str) or not 1 <= len(value[0]) <= 512
                            or '\n' in value[0] or '\r' in value[0]
                            or type(value[1]) is not int or not 1 <= value[1] <= 200):
                        raise pytest.UsageError('Invalid expected error log declaration')
                    self.expected_errors.append({'case': item.nodeid, 'prefix': value[0], 'count': value[1]})

    def pytest_collectreport(self, report):
        if report.failed:
            self.errors += 1
        for name, text in report.sections:
            self.event('stderr' if name == 'Captured stderr' else 'stdout', text)

    def pytest_runtest_logstart(self, nodeid, location):
        self.current = nodeid

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_runtest_setup(self, item):
        self.phase = 'setup'
        yield
        self.drain_console()

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_runtest_call(self, item):
        self.phase = 'call'
        yield
        self.drain_console()

    @pytest.hookimpl(hookwrapper=True, trylast=True)
    def pytest_runtest_teardown(self, item):
        self.phase = 'teardown'
        yield
        self.drain_console()

    def pytest_runtest_logreport(self, report):
        result = self.results.setdefault(report.nodeid, {'phases': {}, 'durationMs': 0})
        # pytest emits failed unittest subtests before the enclosing call's
        # passed report. A later success must not erase that phase's failure.
        if result['phases'].get(report.when) != 'failed':
            result['phases'][report.when] = report.outcome
        result['durationMs'] += round(report.duration * 1000)
        for name, text in report.sections:
            # pytest includes previous phases in later reports. Read each once.
            if name == f'Captured stdout {report.when}':
                self.event('stdout', text)
            elif name == f'Captured stderr {report.when}':
                self.event('stderr', text)

    def pytest_warning_recorded(self, warning_message, when, nodeid, location):
        previous = self.current
        self.current = nodeid or 'collection'
        self.event('stdout', f'[00:00:00.000] [warn] [(python-warning)] {warning_message.message}\n')
        self.current = previous

    @pytest.hookimpl(trylast=True)
    def pytest_sessionfinish(self, session, exitstatus):
        files = []
        for nodeid, result in self.results.items():
            phases = result['phases']
            skipped = 'skipped' in phases.values()
            passed = phases.get('setup') == 'passed' and phases.get('call') == 'passed' and phases.get('teardown') == 'passed'
            failed = 'failed' in phases.values() or phases.get('teardown') != 'passed'
            state = 'failed' if failed else 'passed' if passed else 'skipped' if skipped else 'failed'
            files.append({'file': nodeid, 'state': state, 'passed': int(state == 'passed'),
                          'failed': int(state == 'failed'), 'skipped': int(state == 'skipped'),
                          'durationMs': result['durationMs']})
        self.path.write_text(json.dumps({'schema': 1, 'reason': 'passed' if exitstatus == 0 else 'failed',
                                        'unhandledErrors': self.errors, 'inventory': self.inventory,
                                        'files': files, 'expectedErrors': self.expected_errors,
                                        'batchUnits': getattr(self, 'batch_units', 0)}), encoding='utf-8')

    def pytest_unconfigure(self, config):
        logging.getLogger().removeHandler(self.handler)
        for value, handler in self.signal_handlers.items():
            signal.signal(value, handler)


def pytest_configure(config):
    config.addinivalue_line('markers', 'orkas_expected_errors: exact case-call fault log prefixes and counts; raw severity is retained')
    config.pluginmanager.register(Checkpoint(config), 'orkas-checkpoint-protocol')
