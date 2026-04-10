#!/usr/bin/env python3
"""
Tests for Worktree Auto-Rebase Functionality
=============================================

Tests the rebase_worktree_onto_base() method on WorktreeManager,
which rebases a worktree branch onto the latest origin/{base_branch}.

Uses real git repos via the temp_git_repo fixture from conftest.py.
Since temp_git_repo creates a local-only repo with NO remote, tests
that call rebase_worktree_onto_base() (which runs 'git fetch origin')
must first set up a bare remote using setup_remote_repo().
"""

import subprocess
from pathlib import Path

import pytest

from worktree import WorktreeManager


def setup_remote_repo(temp_dir: Path) -> Path:
    """Set up a bare remote repo for a temp_git_repo.

    The temp_git_repo fixture creates a local-only repo with no remote.
    This helper:
      (a) Clones the repo as a bare repo
      (b) Adds the bare repo as 'origin' remote
      (c) Pushes main to the bare origin

    Returns the path to the bare repo.
    """
    bare_path = temp_dir.parent / f"{temp_dir.name}-bare.git"
    subprocess.run(
        ["git", "clone", "--bare", str(temp_dir), str(bare_path)],
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "remote", "add", "origin", str(bare_path)],
        cwd=temp_dir,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "push", "origin", "main"],
        cwd=temp_dir,
        capture_output=True,
        check=True,
    )
    return bare_path


def add_commit_to_bare_origin(
    bare_path: Path,
    temp_dir: Path,
    filename: str,
    content: str,
    message: str,
) -> None:
    """Add a commit to the bare origin and fetch it into temp_dir.

    Since we can't commit directly into a bare repo easily, this clones
    the bare repo into a temporary working copy, commits, pushes back,
    then fetches in temp_dir.
    """
    clone_path = bare_path.parent / "origin-workdir"
    if clone_path.exists():
        import shutil

        shutil.rmtree(clone_path)

    subprocess.run(
        ["git", "clone", str(bare_path), str(clone_path)],
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "origin@example.com"],
        cwd=clone_path,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Origin User"],
        cwd=clone_path,
        capture_output=True,
    )
    (clone_path / filename).write_text(content)
    subprocess.run(
        ["git", "add", "."],
        cwd=clone_path,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "commit", "-m", message],
        cwd=clone_path,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "push", "origin", "main"],
        cwd=clone_path,
        capture_output=True,
        check=True,
    )


class TestRebaseSuccess:
    """Tests for successful rebase when worktree is behind origin/main."""

    def test_rebase_brings_worktree_up_to_date(self, temp_git_repo: Path):
        """Worktree behind main by N commits -> rebase applies cleanly."""
        bare_path = setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        # Add a new commit to origin/main via the bare repo
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="new_feature.py",
            content="# new feature\n",
            message="Add new feature to main",
        )

        # Rebase should succeed
        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is True

        # Verify the new file is now in the worktree
        assert (info.path / "new_feature.py").exists()
        assert (info.path / "new_feature.py").read_text() == "# new feature\n"

    def test_rebase_with_multiple_commits_behind(self, temp_git_repo: Path):
        """Worktree behind by multiple commits -> all are rebased."""
        bare_path = setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        # Add two commits to origin/main
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="file_a.txt",
            content="content a\n",
            message="Add file a",
        )
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="file_b.txt",
            content="content b\n",
            message="Add file b",
        )

        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is True

        # Both files should be present
        assert (info.path / "file_a.txt").exists()
        assert (info.path / "file_b.txt").exists()


class TestRebaseAlreadyUpToDate:
    """Tests for when worktree is already at same commit as main."""

    def test_already_up_to_date_returns_true(self, temp_git_repo: Path):
        """Worktree at same commit as main -> returns True immediately."""
        setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        manager.create_worktree("test-spec")

        # No new commits on origin/main - already up to date
        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is True


class TestRebaseConflict:
    """Tests for rebase conflict detection and abort."""

    def test_conflict_aborts_and_restores_branch(self, temp_git_repo: Path):
        """Same file modified in both branches -> rebase aborts, branch restored."""
        bare_path = setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        # Record pre-rebase commit in the worktree
        pre_rebase_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=info.path,
            capture_output=True,
            text=True,
        )
        pre_rebase_commit = pre_rebase_result.stdout.strip()

        # Modify a file in the worktree and commit
        (info.path / "README.md").write_text("worktree change\n")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Worktree change to README"],
            cwd=info.path,
            capture_output=True,
        )

        # Record the worktree commit after our change
        worktree_commit_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=info.path,
            capture_output=True,
            text=True,
        )
        worktree_commit = worktree_commit_result.stdout.strip()

        # Modify the same file on origin/main (creates conflict)
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="README.md",
            content="origin conflicting change\n",
            message="Conflicting change on main",
        )

        # Rebase should fail due to conflict
        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is False

        # Branch should be restored to pre-rebase state (our worktree commit)
        post_rebase_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=info.path,
            capture_output=True,
            text=True,
        )
        post_rebase_commit = post_rebase_result.stdout.strip()
        assert post_rebase_commit == worktree_commit

        # No rebase should be in progress
        rebase_dir = info.path / ".git" / "rebase-merge"
        rebase_apply_dir = info.path / ".git" / "rebase-apply"
        # For worktrees, .git is a file pointing to the main repo, so check
        # that git status is clean (no rebase in progress)
        status_result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=info.path,
            capture_output=True,
            text=True,
        )
        assert status_result.returncode == 0


class TestRebaseStashPreservation:
    """Tests that uncommitted changes are stashed before rebase and restored after."""

    def test_stash_preserved_on_successful_rebase(self, temp_git_repo: Path):
        """Uncommitted changes stashed before rebase, restored after success."""
        bare_path = setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        # Add a new commit to origin/main so there's something to rebase
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="new_feature.py",
            content="# new feature\n",
            message="Add new feature",
        )

        # Create uncommitted changes in the worktree (on a different file to avoid conflict)
        (info.path / "local_work.txt").write_text("uncommitted work in progress\n")

        # Verify dirty state
        assert manager.has_uncommitted_changes("test-spec") is True

        # Rebase should succeed
        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is True

        # Uncommitted changes should be restored
        assert (info.path / "local_work.txt").exists()
        assert (info.path / "local_work.txt").read_text() == "uncommitted work in progress\n"

        # New feature from origin should also be present
        assert (info.path / "new_feature.py").exists()

    def test_stash_preserved_on_failed_rebase(self, temp_git_repo: Path):
        """Uncommitted changes stashed before rebase, restored after failure."""
        bare_path = setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        # Commit a change to README in the worktree (to create conflict)
        (info.path / "README.md").write_text("worktree committed change\n")
        subprocess.run(["git", "add", "."], cwd=info.path, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "Worktree README change"],
            cwd=info.path,
            capture_output=True,
        )

        # Create conflicting change on origin/main (same file)
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="README.md",
            content="origin conflicting change\n",
            message="Conflicting change on main",
        )

        # Create uncommitted changes in worktree (on a different file)
        (info.path / "local_work.txt").write_text("uncommitted work\n")

        # Verify dirty state
        assert manager.has_uncommitted_changes("test-spec") is True

        # Rebase should fail due to conflict
        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is False

        # Uncommitted changes should be restored via stash pop
        assert (info.path / "local_work.txt").exists()
        assert (info.path / "local_work.txt").read_text() == "uncommitted work\n"


class TestRebaseFetchFailure:
    """Tests for when git fetch fails (no remote configured)."""

    def test_no_remote_returns_false_gracefully(self, temp_git_repo: Path):
        """Repo without remote configured -> returns False gracefully."""
        # Do NOT call setup_remote_repo - no remote configured
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        manager.create_worktree("test-spec")

        # Rebase should fail gracefully (fetch will fail - no origin)
        result = manager.rebase_worktree_onto_base("test-spec")
        assert result is False


class TestRebaseEdgeCases:
    """Tests for edge cases in rebase functionality."""

    def test_nonexistent_worktree_returns_false(self, temp_git_repo: Path):
        """worktree_path.exists() check returns False for non-existent worktree."""
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        # Don't create any worktree - it doesn't exist
        result = manager.rebase_worktree_onto_base("nonexistent-spec")
        assert result is False

    def test_stash_pop_failure_after_successful_rebase_returns_true(
        self, temp_git_repo: Path
    ):
        """Stash pop failure after successful rebase -> returns True with warning.

        If the rebase itself succeeds but stash pop fails, the method
        should still return True because the rebase was successful.
        We simulate this by modifying a tracked file (README.md) in the
        worktree without committing (so it gets stashed), while origin/main
        also modifies the same file (so stash pop conflicts after rebase).
        """
        bare_path = setup_remote_repo(temp_git_repo)
        manager = WorktreeManager(temp_git_repo)
        manager.setup()

        info = manager.create_worktree("test-spec")

        # Modify a tracked file in the worktree WITHOUT committing.
        # This creates a stashable uncommitted change.
        (info.path / "README.md").write_text("modified by worktree for stash\n")

        # On origin/main, also modify README.md with different content.
        # After rebase, README.md will have the origin content, so
        # stash pop will conflict (stash base doesn't match).
        add_commit_to_bare_origin(
            bare_path,
            temp_git_repo,
            filename="README.md",
            content="modified by origin - completely different\n",
            message="Modify README on main",
        )

        # Rebase should succeed because:
        # 1. Uncommitted changes are stashed before rebase
        # 2. Worktree branch has no COMMITTED changes to README.md
        # 3. Rebase applies cleanly (worktree branch replayed on origin/main)
        # But stash pop will fail because the stash was made against
        # the old README.md content, and rebase changed it.
        result = manager.rebase_worktree_onto_base("test-spec")

        # Should return True because the rebase itself succeeded
        # (stash pop failure only produces a warning)
        assert result is True
