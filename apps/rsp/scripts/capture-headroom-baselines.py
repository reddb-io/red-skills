#!/usr/bin/env python3
"""Capture replay-only Headroom baselines for the rsp two-axis corpus.

The benchmark must not install or execute headroom-ai in CI. This script is the
explicit maintainer refresh path: it creates a temporary virtualenv, installs the
pinned Headroom package, runs compress() over the checked-in fidelity corpus, and
writes apps/rsp/tests/fixtures/headroom/baselines.json.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import subprocess
import sys
import tempfile
import venv
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HEADROOM_PACKAGE = "headroom-ai"
HEADROOM_VERSION = "0.31.0"
DEFAULT_FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
DEFAULT_OUT = DEFAULT_FIXTURE_ROOT / "headroom" / "baselines.json"


def main() -> int:
    args = parse_args()
    if args.capture_child:
        capture(args.fixture_root, args.out)
        return 0

    with tempfile.TemporaryDirectory(prefix="rsp-headroom-capture-") as tmp:
        venv_dir = Path(tmp) / "venv"
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        python = venv_dir / "bin" / "python"
        subprocess.run(
            [str(python), "-m", "pip", "install", f"{HEADROOM_PACKAGE}=={HEADROOM_VERSION}"],
            check=True,
        )
        subprocess.run(
            [
                str(python),
                str(Path(__file__).resolve()),
                "--capture-child",
                "--fixture-root",
                str(args.fixture_root),
                "--out",
                str(args.out),
            ],
            check=True,
        )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="capture pinned headroom-ai baselines for rsp fixtures")
    parser.add_argument("--fixture-root", type=Path, default=DEFAULT_FIXTURE_ROOT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--capture-child", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def capture(fixture_root: Path, out: Path) -> None:
    from headroom import CompressConfig, compress

    installed = importlib.metadata.version(HEADROOM_PACKAGE)
    if installed != HEADROOM_VERSION:
        raise SystemExit(f"expected {HEADROOM_PACKAGE}=={HEADROOM_VERSION}, found {installed}")

    fixtures = discover_fixtures(fixture_root)
    captured: list[dict[str, Any]] = []
    config = CompressConfig(
        compress_user_messages=True,
        compress_system_messages=True,
        protect_recent=0,
        protect_analysis_context=False,
        min_tokens_to_compress=1,
        kompress_model="disabled",
    )
    for fixture_path in fixtures:
        fixture = json.loads(fixture_path.read_text(encoding="utf8"))
        stdout = fixture["recorded"]["stdout"]
        try:
            result = compress(
                [{"role": "user", "content": stdout}],
                model="gpt-4o",
                optimize=True,
                config=config,
            )
            compressed = result.messages[0]["content"]
            if not isinstance(compressed, str):
                captured.append(not_covered(fixture["name"], "compress() returned non-string message content"))
                continue
            captured.append(
                {
                    "name": fixture["name"],
                    "coverage": "covered",
                    "stdout": compressed,
                    "fidelity_assertions_passed": fidelity_preserved(stdout, compressed, fixture),
                    "transforms_applied": list(result.transforms_applied),
                }
            )
        except Exception as exc:  # pragma: no cover - this records external package failures.
            captured.append(not_covered(fixture["name"], f"{type(exc).__name__}: {exc}"))

    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": f"{HEADROOM_PACKAGE} {HEADROOM_VERSION}",
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "capture_script": "apps/rsp/scripts/capture-headroom-baselines.py",
        "fixtures": captured,
    }
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf8")


def discover_fixtures(fixture_root: Path) -> list[Path]:
    roots = [fixture_root / "gh", fixture_root / "git", fixture_root / "test-runners"]
    return sorted(path for root in roots for path in root.rglob("*.json"))


def not_covered(name: str, reason: str) -> dict[str, Any]:
    return {
        "name": name,
        "coverage": "not-covered",
        "not_covered_reason": reason,
    }


def fidelity_preserved(original: str, compressed: str, fixture: dict[str, Any]) -> bool:
    if compressed == original:
        return True
    if "<<ccr:" in compressed:
        return False
    for assertion in fixture.get("assertions", []):
        expected = assertion.get("expected")
        if not scalar_preserved(original, compressed, expected):
            return False
    return True


def scalar_preserved(original: str, compressed: str, expected: Any) -> bool:
    candidates = expected_strings(expected)
    if not candidates:
        return True
    if not any(candidate in original for candidate in candidates):
        return True
    return any(candidate in compressed for candidate in candidates)


def expected_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, bool):
        return [json.dumps(value), str(value)]
    if isinstance(value, (int, float)):
        return [str(value)]
    return []


if __name__ == "__main__":
    raise SystemExit(main())
