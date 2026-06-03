"""
Pytest configuration and fixtures for runners/github/services tests.

These tests cover the Phase 4a reviewer-notes wiring through the
followup-reviewer service plus the pr_reviewer.md prompt directive.

The github runner code uses an "absolute imports as fallback" pattern
(see followup_reviewer.py:27-65, pr_review_engine.py:14-39). For the
fallback path to work in tests, both the backend root and the
runners/github directory must be on sys.path — exactly as production
sets up in apps/backend/runners/github/runner.py:57-83.

Additionally, the `services` package needs to be pre-loaded as a
top-level module BEFORE pytest triggers the package-import chain via
`runners.github.__init__.py`. Without this, the fallback import
`from services.io_utils import safe_print` inside pr_review_engine.py
fails because sys.modules only has `runners.github.services`, not the
top-level `services` alias.

NOTE: this directory intentionally has no `__init__.py`. The github
runner's parent packages (`runners/__init__.py`,
`runners/github/__init__.py`) do eager imports that fail unless the
production sys.path setup is already in place. With no __init__.py
here, pytest loads this conftest as a standalone file FIRST and we
can establish the production-like environment before the test
files trigger any package walks (mirrors the core/workspace/tests
layout, which also has no __init__.py for the same reason).
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

# tests/  →  services/  →  github/  →  runners/  →  backend/
_TESTS_DIR = Path(__file__).resolve().parent
_SERVICES_DIR = _TESTS_DIR.parent
_GITHUB_DIR = _SERVICES_DIR.parent
_RUNNERS_DIR = _GITHUB_DIR.parent
_BACKEND_DIR = _RUNNERS_DIR.parent


def _ensure_path(path: str) -> None:
    """Insert path at sys.path[0] if not already present."""
    if path not in sys.path:
        sys.path.insert(0, path)


# Backend first, then github — pushes github to sys.path[0].
# Order matters: a top-level `import services` must resolve to
# runners/github/services/ (NOT apps/backend/services/, which is a
# different unrelated package that happens to share the name).
_ensure_path(str(_BACKEND_DIR))
_ensure_path(str(_GITHUB_DIR))


def _preload_services_namespace() -> None:
    """Pre-populate sys.modules with the github-runner services package.

    The fallback `from services.io_utils import safe_print` inside
    pr_review_engine.py is evaluated mid-way through loading
    runners.github.__init__.py. At that point, Python is in the middle
    of loading `runners.github.services` so the `services` top-level
    name is not yet resolvable via the normal search path — Python's
    in-progress submodule lookup wins.

    By pre-loading `services` and a few critical submodules now (before
    pytest triggers the parent-package walk), we make sure the
    fallback import succeeds.
    """
    if "services" in sys.modules and getattr(
        sys.modules["services"], "__file__", ""
    ).endswith("runners/github/services/__init__.py"):
        return  # already correctly loaded

    services_init = _SERVICES_DIR / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "services", str(services_init), submodule_search_locations=[str(_SERVICES_DIR)]
    )
    if spec is None or spec.loader is None:  # pragma: no cover
        return
    module = importlib.util.module_from_spec(spec)
    sys.modules["services"] = module
    spec.loader.exec_module(module)

    # Pre-load specific submodules that the fallback imports reach for.
    # These are imported with their normal `services.foo` names so Python's
    # finder records them in sys.modules under the canonical alias.
    for submod in ("io_utils", "category_utils", "prompt_manager"):
        try:
            importlib.import_module(f"services.{submod}")
        except Exception:  # pragma: no cover  - best effort
            pass


_preload_services_namespace()
