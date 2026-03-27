"""
Export Validator
================

Post-merge validation that detects lost exports.

When the merge system produces a result (via semantic changes, auto-merge,
or AI resolution), this validator compares the exported symbols in the
baseline against the merged output.  Any export present in the baseline
but absent from the merged content — and not explicitly removed by a
task — is flagged as a lost export.

Supported languages: TypeScript / JavaScript, Python.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from .types import ChangeType, TaskSnapshot

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

_TS_JS_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"}
_PYTHON_EXTENSIONS = {".py", ".pyi"}


def _is_ts_js(file_path: str) -> bool:
    return Path(file_path).suffix.lower() in _TS_JS_EXTENSIONS


def _is_python(file_path: str) -> bool:
    return Path(file_path).suffix.lower() in _PYTHON_EXTENSIONS


# ---------------------------------------------------------------------------
# TypeScript / JavaScript export extraction
# ---------------------------------------------------------------------------

# Matches:  export function foo(
#           export async function foo(
#           export const foo =
#           export let foo =
#           export var foo =
#           export class Foo
#           export interface Foo
#           export type Foo
#           export enum Foo
#           export default function foo(  (captures "default:foo")
#           export default class Foo      (captures "default:Foo")
_TS_NAMED_EXPORT_RE = re.compile(
    r"export\s+"
    r"(?P<default>default\s+)?"
    r"(?:async\s+)?"
    r"(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+|enum\s+)"
    r"(?P<name>[A-Za-z_$][\w$]*)",
)

# Matches:  export { foo, bar as baz, qux }
_TS_BRACE_EXPORT_RE = re.compile(
    r"export\s*\{([^}]+)\}",
)

# Matches:  export default <identifier>
_TS_DEFAULT_IDENT_RE = re.compile(
    r"export\s+default\s+(?!function|class|interface|type|enum|async)([A-Za-z_$][\w$]*)",
)


def extract_ts_js_exports(content: str) -> set[str]:
    """Extract exported symbol names from TypeScript / JavaScript source."""
    exports: set[str] = set()

    for m in _TS_NAMED_EXPORT_RE.finditer(content):
        name = m.group("name")
        if m.group("default"):
            exports.add(f"default:{name}")
        else:
            exports.add(name)

    for m in _TS_BRACE_EXPORT_RE.finditer(content):
        inner = m.group(1)
        for item in inner.split(","):
            item = item.strip()
            if not item:
                continue
            # "foo as bar" → the exported name is "bar"
            parts = item.split(" as ")
            exported_name = parts[-1].strip()
            if exported_name:
                exports.add(exported_name)

    for m in _TS_DEFAULT_IDENT_RE.finditer(content):
        exports.add(f"default:{m.group(1)}")

    return exports


# ---------------------------------------------------------------------------
# Python export extraction
# ---------------------------------------------------------------------------

# Matches __all__ = ["foo", "bar", 'baz']
_PY_ALL_RE = re.compile(r"__all__\s*=\s*\[([^\]]*)\]", re.DOTALL)
_PY_ALL_ITEM_RE = re.compile(r"""['"](\w+)['"]""")

# Top-level def / class
_PY_DEF_RE = re.compile(r"^(?:def|class|async\s+def)\s+(\w+)", re.MULTILINE)


def extract_python_exports(content: str) -> set[str]:
    """Extract exported symbol names from Python source.

    Uses ``__all__`` if present, otherwise falls back to top-level
    public definitions (names not starting with ``_``).
    """
    # Prefer __all__ if present
    m = _PY_ALL_RE.search(content)
    if m:
        return set(_PY_ALL_ITEM_RE.findall(m.group(1)))

    # Fall back to top-level public definitions
    exports: set[str] = set()
    for m in _PY_DEF_RE.finditer(content):
        name = m.group(1)
        if not name.startswith("_"):
            exports.add(name)
    return exports


# ---------------------------------------------------------------------------
# Unified extraction
# ---------------------------------------------------------------------------


def extract_exports(content: str, file_path: str) -> set[str]:
    """Extract exported symbols from source code based on file extension."""
    if _is_ts_js(file_path):
        return extract_ts_js_exports(content)
    if _is_python(file_path):
        return extract_python_exports(content)
    return set()


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _get_explicitly_removed_exports(task_snapshots: list[TaskSnapshot]) -> set[str]:
    """Collect export names that were explicitly removed by tasks."""
    removed: set[str] = set()
    removal_types = {
        ChangeType.REMOVE_FUNCTION,
        ChangeType.REMOVE_IMPORT,
        ChangeType.REMOVE_VARIABLE,
    }
    for snapshot in task_snapshots:
        for change in snapshot.semantic_changes:
            if change.change_type in removal_types:
                removed.add(change.target)
    return removed


def validate_exports(
    baseline_content: str,
    merged_content: str,
    file_path: str,
    task_snapshots: list[TaskSnapshot] | None = None,
) -> list[str]:
    """Compare exports between baseline and merged content.

    Args:
        baseline_content: Original file content before merge.
        merged_content: File content produced by the merge.
        file_path: Path to the file (used for language detection).
        task_snapshots: Task snapshots to check for explicit removals.

    Returns:
        List of warning strings for each lost export.  Empty list means
        all baseline exports survived the merge.
    """
    baseline_exports = extract_exports(baseline_content, file_path)
    merged_exports = extract_exports(merged_content, file_path)

    if not baseline_exports:
        return []

    lost = baseline_exports - merged_exports
    if not lost:
        return []

    # Filter out exports that a task explicitly removed
    explicitly_removed = _get_explicitly_removed_exports(task_snapshots or [])
    unexplained_losses = lost - explicitly_removed

    if not unexplained_losses:
        return []

    warnings: list[str] = []
    for name in sorted(unexplained_losses):
        msg = f"Export '{name}' present in baseline but missing after merge"
        warnings.append(msg)
        logger.warning(f"[ExportValidator] {file_path}: {msg}")

    return warnings
