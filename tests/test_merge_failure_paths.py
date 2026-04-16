#!/usr/bin/env python3
"""
Tests for Merge Failure Paths
==============================

Covers the six merge-subsystem bug fixes introduced by spec 119:

- B2a: AI merge fails + non-overlapping lines -> _git_merge_file auto-merges,
       file is staged, no conflict markers remain.
- B2b: AI merge fails + overlapping lines -> file ends up in remaining_conflicts
       with conflict markers intact and NOT staged.
- B3:  Failed restore-checkout in _rebase_spec_branch raises RebaseRestoreError
       and the caller returns an error dict with rebase_restore_failed=True.
- B4:  A dirty working tree that was auto-stashed before merge surfaces the
       exact stash@{N} ref and `git stash pop stash@{N}` recovery hint in
       the merge result's warnings list.
- B5a: Pre-existing lock whose timestamp is older than MERGE_LOCK_TTL_SECONDS
       is treated as stale and reclaimed.
- B5b: Pre-existing lock written by a different host is treated as stale and
       reclaimed.
- B5c: Legacy bare-PID lock files are parsed without raising JSONDecodeError.
- B6:  A file that ends up with <<<<<<< markers on disk after a "successful"
       AI merge flips result.success to False and is appended to the
       remaining_conflicts list via the post-merge verification helper.
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

# Add auto-claude directory to path for imports (mirrors other merge test files).
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))
sys.path.insert(0, str(Path(__file__).parent))

# Imports exercised by the tests.
#
# ``core.workspace`` is a *package* (directory with ``__init__.py``) that
# loads the coexisting ``apps/backend/core/workspace.py`` file via
# ``importlib`` and exposes a **subset** of its functions under the package
# namespace. The merge functions exercised here (``_try_smart_merge_inner``,
# ``_run_post_merge_verification``, ``_git_merge_file``, ...) live inside
# that loaded module, accessible as ``core.workspace._workspace_module``.
# All monkeypatching must target the loaded module so the patched symbol is
# what the production code actually looks up at call time.
import core.workspace as workspace_package  # noqa: E402

_workspace_module = workspace_package._workspace_module

_rebase_spec_branch = _workspace_module._rebase_spec_branch
_resolve_git_conflicts_with_ai = _workspace_module._resolve_git_conflicts_with_ai
_run_post_merge_verification = _workspace_module._run_post_merge_verification
_try_smart_merge_inner = _workspace_module._try_smart_merge_inner

from core.workspace import ParallelMergeResult  # noqa: E402
from core.workspace.models import (  # noqa: E402
    MERGE_LOCK_TTL_SECONDS,
    MergeLock,
    RebaseRestoreError,
)
from merge import MergeOrchestrator  # noqa: E402
from worktree import WorktreeManager  # noqa: E402


# =============================================================================
# Helpers
# =============================================================================


def _git(cwd: Path, *args: str) -> None:
    """Run a git subprocess with check=True in the given directory."""
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        check=True,
    )


def _make_async_failure(error: str = "Simulated AI failure"):
    """Build an async replacement for _run_parallel_merges that fails every task."""

    async def _mock(tasks, project_dir, max_concurrent=5):
        return [
            ParallelMergeResult(
                file_path=task.file_path,
                merged_content=None,
                success=False,
                error=error,
            )
            for task in tasks
        ]

    return _mock


def _make_async_success_with_markers(marker_content: str):
    """Async replacement that returns a "success" result carrying conflict markers."""

    async def _mock(tasks, project_dir, max_concurrent=5):
        return [
            ParallelMergeResult(
                file_path=task.file_path,
                merged_content=marker_content,
                success=True,
                was_auto_merged=False,
            )
            for task in tasks
        ]

    return _mock


def _staged_files(project_dir: Path) -> set[str]:
    """Return the set of file paths currently staged in ``project_dir``."""
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        cwd=project_dir,
        capture_output=True,
        text=True,
    )
    return {line for line in result.stdout.splitlines() if line}


# =============================================================================
# B2a / B2b — AI merge failure fallback to git merge-file
# =============================================================================


class TestAIMergeFallback:
    """B2a/B2b: When AI merge fails, fall back to git merge-file."""

    def test_b2a_ai_failure_non_overlapping_auto_merges(
        self, temp_project, monkeypatch
    ):
        """B2a: AI fails + non-overlapping lines -> _git_merge_file auto-merges.

        The resulting file must be staged with no conflict markers on disk.
        """
        # Common ancestor content.
        target_file = temp_project / "module.py"
        target_file.write_text("def foo():\n    return 1\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Initial module for B2a")

        # Spec branch: add a new function below (non-overlapping change).
        spec_branch = "auto-claude/test-b2a"
        _git(temp_project, "checkout", "-b", spec_branch)
        target_file.write_text(
            "def foo():\n    return 1\n\ndef bar():\n    return 2\n"
        )
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Spec: add bar")

        # Main: add a new import above (non-overlapping change).
        _git(temp_project, "checkout", "main")
        target_file.write_text("import logging\n\ndef foo():\n    return 1\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Main: add import")

        # Simulate AI merge failure for every queued task.
        monkeypatch.setattr(
            _workspace_module,
            "_run_parallel_merges",
            _make_async_failure("Simulated AI failure for B2a"),
        )

        orchestrator = MergeOrchestrator(
            temp_project, enable_ai=False, dry_run=False
        )
        git_conflicts = {
            "conflicting_files": ["module.py"],
            "base_branch": "main",
            "spec_branch": spec_branch,
        }

        result = _resolve_git_conflicts_with_ai(
            temp_project,
            "test-b2a",
            temp_project,
            git_conflicts,
            orchestrator,
        )

        # The git 3-way merge fallback should have produced a clean merge.
        assert "module.py" in result.get("resolved_files", []), (
            f"module.py should be auto-merged via _git_merge_file fallback; "
            f"got: {result}"
        )

        merged_content = target_file.read_text()
        assert "import logging" in merged_content
        assert "def bar()" in merged_content
        assert "<<<<<<<" not in merged_content, (
            "Non-overlapping merge should not contain conflict markers"
        )

        # File must be staged after the clean fallback merge.
        assert "module.py" in _staged_files(temp_project)

    def test_b2b_ai_failure_overlapping_lines_conflict_markers(
        self, temp_project, monkeypatch
    ):
        """B2b: AI fails + overlapping lines -> remaining_conflicts with markers intact."""
        # Common ancestor content.
        target_file = temp_project / "module.py"
        target_file.write_text("def foo():\n    return 1\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Initial module for B2b")

        # Spec branch: modify return value (overlapping change).
        spec_branch = "auto-claude/test-b2b"
        _git(temp_project, "checkout", "-b", spec_branch)
        target_file.write_text("def foo():\n    return 2\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Spec: return 2")

        # Main: modify return value differently (overlapping change).
        _git(temp_project, "checkout", "main")
        target_file.write_text("def foo():\n    return 3\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Main: return 3")

        # Simulate AI merge failure so fallback path is exercised.
        monkeypatch.setattr(
            _workspace_module,
            "_run_parallel_merges",
            _make_async_failure("Simulated AI failure for B2b"),
        )

        orchestrator = MergeOrchestrator(
            temp_project, enable_ai=False, dry_run=False
        )
        git_conflicts = {
            "conflicting_files": ["module.py"],
            "base_branch": "main",
            "spec_branch": spec_branch,
        }

        result = _resolve_git_conflicts_with_ai(
            temp_project,
            "test-b2b",
            temp_project,
            git_conflicts,
            orchestrator,
        )

        # File must end up in remaining_conflicts with markers on disk.
        remaining = result.get("remaining_conflicts", [])
        assert any(c.get("file") == "module.py" for c in remaining), (
            f"module.py should be in remaining_conflicts; got: {remaining}"
        )

        on_disk = target_file.read_text()
        assert "<<<<<<<" in on_disk, (
            "Overlapping conflict markers must be preserved on disk"
        )
        assert ">>>>>>>" in on_disk
        assert "=======" in on_disk

        # The conflicting file must NOT be staged (markers require review).
        assert "module.py" not in _staged_files(temp_project)

        # Overall resolution should report failure (conflicts remain).
        assert result.get("success") is False


# =============================================================================
# B3 — Rebase restore failure surfaces RebaseRestoreError
# =============================================================================


class TestRebaseRestoreError:
    """B3: Failed restore-checkout raises RebaseRestoreError and propagates."""

    def test_b3_rebase_restore_failure_raises(self, temp_project, monkeypatch):
        """Monkeypatched ``git checkout <original>`` in the finally block raises.

        Setup:
            - A spec branch with commits that is behind main so rebase is
              actually attempted.
            - The spec branch is NOT registered in a worktree (so the
              worktree-lock short-circuit is bypassed).

        Expected:
            _rebase_spec_branch raises RebaseRestoreError when the final
            restore-checkout returns nonzero.
        """
        spec_branch = "auto-claude/test-b3"

        # Create spec branch with a commit.
        _git(temp_project, "checkout", "-b", spec_branch)
        (temp_project / "spec_file.txt").write_text("spec content\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Spec commit")

        # Go back to main and create a commit (spec is now behind main).
        _git(temp_project, "checkout", "main")
        (temp_project / "main_file.txt").write_text("main content\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Main commit")

        # Wrap run_git so the final ``checkout main`` returns nonzero but
        # every other command behaves normally. The first checkout in the
        # function body is ``checkout <spec_branch>`` so that one is allowed
        # to succeed untouched.
        original_run_git = _workspace_module.run_git

        def failing_run_git(args, **kwargs):
            result = original_run_git(args, **kwargs)
            if list(args[:2]) == ["checkout", "main"]:
                # Simulate a broken checkout (e.g. HEAD lock, missing ref).
                result.returncode = 1
                result.stderr = (
                    "fatal: Simulated failure restoring original branch"
                )
            return result

        monkeypatch.setattr(_workspace_module, "run_git", failing_run_git)

        with pytest.raises(RebaseRestoreError) as exc_info:
            _rebase_spec_branch(temp_project, "test-b3", "main")

        assert "main" in str(exc_info.value)

    def test_b3_caller_returns_error_dict(self, temp_project, monkeypatch):
        """The caller (_try_smart_merge_inner) catches RebaseRestoreError.

        Expected:
            Returns {success: False, rebase_restore_failed: True, error: str}
        """
        # Use the same branch setup as the raise test.
        spec_branch = "auto-claude/test-b3-caller"
        _git(temp_project, "checkout", "-b", spec_branch)
        (temp_project / "spec_b3.txt").write_text("spec content\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Spec commit for B3 caller")

        _git(temp_project, "checkout", "main")
        (temp_project / "main_b3.txt").write_text("main content\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Main commit for B3 caller")

        original_run_git = _workspace_module.run_git

        def failing_run_git(args, **kwargs):
            result = original_run_git(args, **kwargs)
            if list(args[:2]) == ["checkout", "main"]:
                result.returncode = 1
                result.stderr = "fatal: Simulated failure"
            return result

        monkeypatch.setattr(_workspace_module, "run_git", failing_run_git)

        manager = WorktreeManager(temp_project, base_branch="main")
        result = _try_smart_merge_inner(
            temp_project,
            "test-b3-caller",
            temp_project,
            manager,
        )

        assert result is not None, (
            "_try_smart_merge_inner must return a dict, not propagate the exception"
        )
        assert result.get("success") is False
        assert result.get("rebase_restore_failed") is True
        assert "error" in result


# =============================================================================
# B4 — Stash recovery UX in merge warnings
# =============================================================================


class TestStashRecoveryWarning:
    """B4: Dirty-tree stash_ref must surface in merge warnings."""

    def test_b4_stash_warning_in_merge_output(self, temp_project, monkeypatch):
        """merge result warnings must mention ``stash@{`` and the exact pop command.

        We drive _try_smart_merge_inner through the simplest completing path
        (no conflicts, preview reports auto-mergeable) and verify the stash
        recovery warning is present in the returned result.
        """
        # Spec branch exists but has no commits beyond main — merge-tree and
        # preview both short-circuit, so we can reach a return path without
        # fighting the real merge machinery.
        spec_branch = "auto-claude/test-b4"
        _git(temp_project, "checkout", "-b", spec_branch)
        _git(temp_project, "checkout", "main")

        # Guarantee preview returns a "needs human" conflict so the function
        # returns via a deterministic path that still forwards warnings.
        def fake_preview(self, spec_names):
            return {
                "tasks": list(spec_names),
                "files_to_merge": ["fake.py"],
                "conflicts": [
                    {
                        "file": "fake.py",
                        "can_auto_merge": False,
                        "reason": "forced for B4",
                    }
                ],
                "summary": {"auto_mergeable": 0},
            }

        monkeypatch.setattr(MergeOrchestrator, "preview_merge", fake_preview)

        manager = WorktreeManager(temp_project, base_branch="main")
        stash_ref = "stash@{0}"
        result = _try_smart_merge_inner(
            temp_project,
            "test-b4",
            temp_project,
            manager,
            stash_ref=stash_ref,
        )

        assert result is not None, (
            "_try_smart_merge_inner must complete normally to surface warnings"
        )
        warnings = result.get("warnings", [])
        assert warnings, "Warnings list should be populated when stash_ref is set"

        # The stash warning must carry both the ref and the precise recovery
        # command so users can copy-paste it.
        stash_warning = next(
            (w for w in warnings if w.get("file") == "working-tree"), None
        )
        assert stash_warning is not None, (
            f"Expected a working-tree stash warning; got: {warnings}"
        )
        reason = stash_warning.get("reason", "")
        assert "stash@{" in reason
        assert f"git stash pop {stash_ref}" in reason


# =============================================================================
# B5 — Merge lock staleness and legacy format handling
# =============================================================================


class TestMergeLockStaleness:
    """B5a/B5b/B5c: MergeLock must detect stale and legacy-format lock files."""

    def _lock_file_path(self, project_dir: Path, spec_name: str) -> Path:
        """Mirror MergeLock's internal path so tests can pre-populate the lock."""
        return (
            project_dir
            / ".auto-claude"
            / ".locks"
            / f"merge-{spec_name}.lock"
        )

    def test_b5a_expired_ttl_lock_acquired(self, temp_project):
        """B5a: Lock with timestamp older than TTL must be reclaimed."""
        spec_name = "test-b5a"
        lock_file = self._lock_file_path(temp_project, spec_name)
        lock_file.parent.mkdir(parents=True, exist_ok=True)

        stale_data = {
            # Use a PID that is very likely running (this process) so the
            # only reason to reclaim is the TTL expiry — that isolates the
            # staleness path we want to verify.
            "pid": os.getpid(),
            "ts": time.time() - (MERGE_LOCK_TTL_SECONDS + 60),
            "host": socket.gethostname(),
        }
        lock_file.write_text(json.dumps(stale_data), encoding="utf-8")

        with MergeLock(temp_project, spec_name):
            assert lock_file.exists(), "Lock file should be held after acquire"
            current = json.loads(lock_file.read_text(encoding="utf-8"))
            assert current["pid"] == os.getpid()
            assert current["host"] == socket.gethostname()
            # Fresh timestamp — no longer expired.
            assert time.time() - current["ts"] < MERGE_LOCK_TTL_SECONDS

        assert not lock_file.exists(), "Lock file should be cleaned up on exit"

    def test_b5b_different_host_lock_reclaimed(self, temp_project):
        """B5b: Lock owned by a different host must be reclaimed."""
        spec_name = "test-b5b"
        lock_file = self._lock_file_path(temp_project, spec_name)
        lock_file.parent.mkdir(parents=True, exist_ok=True)

        foreign_host_data = {
            # Same PID (running) and fresh timestamp — only the host mismatch
            # should drive the reclaim decision.
            "pid": os.getpid(),
            "ts": time.time(),
            "host": "definitely-not-this-host-xyz-123",
        }
        lock_file.write_text(json.dumps(foreign_host_data), encoding="utf-8")

        with MergeLock(temp_project, spec_name):
            current = json.loads(lock_file.read_text(encoding="utf-8"))
            assert current["host"] == socket.gethostname()
            assert current["pid"] == os.getpid()

        assert not lock_file.exists()

    def test_b5c_legacy_bare_pid_lock_parsed(self, temp_project):
        """B5c: Legacy bare-PID lock files must NOT raise JSONDecodeError."""
        spec_name = "test-b5c"
        lock_file = self._lock_file_path(temp_project, spec_name)
        lock_file.parent.mkdir(parents=True, exist_ok=True)

        # Bare integer PID — the format used before JSON lock data landed.
        # Use a PID that is almost certainly not running so the lock is
        # treated as stale and reclaimed.
        lock_file.write_text("999999", encoding="utf-8")

        # Acquisition must not surface a JSONDecodeError — the code has a
        # legacy-format fallback that parses bare integers.
        try:
            with MergeLock(temp_project, spec_name):
                current = json.loads(lock_file.read_text(encoding="utf-8"))
                assert current["pid"] == os.getpid()
                assert current["host"] == socket.gethostname()
        except json.JSONDecodeError as exc:
            pytest.fail(
                "Legacy bare-PID lock must be parsed without JSONDecodeError; "
                f"raised: {exc}"
            )

        assert not lock_file.exists()


# =============================================================================
# B6 — Post-merge verification detects conflict markers
# =============================================================================


class TestPostMergeVerification:
    """B6: Injected <<<<<<< markers flip success to False and add conflicts."""

    def test_b6_verification_detects_markers_in_staged_file(self, temp_project):
        """_run_post_merge_verification must detect markers in staged files."""
        target_file = temp_project / "has_markers.py"
        target_file.write_text(
            "def foo():\n"
            "<<<<<<< HEAD\n"
            "    return 1\n"
            "=======\n"
            "    return 2\n"
            ">>>>>>> spec\n"
        )
        _git(temp_project, "add", "has_markers.py")

        verification = _run_post_merge_verification(temp_project)

        assert verification["conflict_markers_present"] is True
        assert "has_markers.py" in verification["files_with_markers"]
        assert verification["staged_files"] >= 1
        assert verification["merge_already_committed"] is False

    def test_b6_markers_flip_success_and_append_to_remaining_conflicts(
        self, temp_project, monkeypatch
    ):
        """Injecting <<<<<<< into the "resolved" content must flip success.

        This simulates the dangerous scenario where the AI returns a
        syntactically-successful result that still contains conflict markers.
        Post-merge verification should catch it, flip success to False, and
        surface the file in remaining_conflicts.
        """
        # Divergence setup: spec and main each modify module.py differently.
        target_file = temp_project / "module.py"
        target_file.write_text("def foo():\n    return 1\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Initial module for B6")

        spec_branch = "auto-claude/test-b6"
        _git(temp_project, "checkout", "-b", spec_branch)
        target_file.write_text("def foo():\n    return 2\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Spec returns 2")

        _git(temp_project, "checkout", "main")
        target_file.write_text("def foo():\n    return 3\n")
        _git(temp_project, "add", ".")
        _git(temp_project, "commit", "-m", "Main returns 3")

        # Simulate AI "success" while sneaking conflict markers into the
        # merged content. The resolver will write this to disk and stage it.
        marker_content = (
            "def foo():\n"
            "<<<<<<< HEAD\n"
            "    return 3\n"
            "=======\n"
            "    return 2\n"
            ">>>>>>> spec\n"
        )
        monkeypatch.setattr(
            _workspace_module,
            "_run_parallel_merges",
            _make_async_success_with_markers(marker_content),
        )

        orchestrator = MergeOrchestrator(
            temp_project, enable_ai=False, dry_run=False
        )
        git_conflicts = {
            "conflicting_files": ["module.py"],
            "base_branch": "main",
            "spec_branch": spec_branch,
        }

        result = _resolve_git_conflicts_with_ai(
            temp_project,
            "test-b6",
            temp_project,
            git_conflicts,
            orchestrator,
        )

        # Success must be flipped to False by the verification sweep.
        assert result.get("success") is False

        remaining = result.get("remaining_conflicts", [])
        assert any(c.get("file") == "module.py" for c in remaining), (
            f"module.py should be added to remaining_conflicts by the "
            f"verification sweep; got: {remaining}"
        )

        # The verification payload itself must report the markers.
        verification = result.get("verification")
        assert verification is not None
        assert verification["conflict_markers_present"] is True
        assert "module.py" in verification["files_with_markers"]
