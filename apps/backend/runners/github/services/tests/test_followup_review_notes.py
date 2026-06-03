"""
Phase 4a — Reviewer notes injection in followup-review prompt.

When the followup reviewer is invoked with a non-empty `reviewer_notes`
string, the prompt that gets sent to the Claude Agent SDK MUST contain
a "### Reviewer Notes" heading followed by the supplied notes text.

This mirrors the canonical pattern at pr_review_engine.py:229-243 and
closes the Notes-drop bug described in the spec
(.auto-claude/specs/131-implement-manual-pr-findings-system/spec.md
Functional Requirement #8).

We mock `claude_agent_sdk.query` so the test does not call the real
Anthropic API — instead, the mock captures the prompt argument and
exits the async iterator immediately. We then inspect the captured
prompt for the expected heading and body.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.fixture
def followup_reviewer(tmp_path: Path):
    """Build a minimal FollowupReviewer for prompt-injection assertions."""
    from runners.github.models import GitHubRunnerConfig
    from runners.github.services.followup_reviewer import FollowupReviewer

    config = GitHubRunnerConfig(
        token="test-token",
        repo="owner/repo",
    )
    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)
    github_dir = tmp_path / "github"
    github_dir.mkdir(parents=True, exist_ok=True)

    return FollowupReviewer(
        project_dir=project_dir,
        github_dir=github_dir,
        config=config,
        use_ai=True,
    )


@pytest.fixture
def followup_context():
    """Build a minimal FollowupReviewContext with a non-trivial diff."""
    from runners.github.models import (
        FollowupReviewContext,
        PRReviewResult,
    )

    # Diff must be >100 chars so review_followup takes the AI path
    # (see followup_reviewer.py:172).
    diff = "diff --git a/x.py b/x.py\n@@ -1,1 +1,1 @@\n-old\n+new\n" * 5

    previous = PRReviewResult(
        pr_number=42,
        repo="owner/repo",
        success=True,
        findings=[],
        summary="Earlier review summary.",
    )
    return FollowupReviewContext(
        pr_number=42,
        previous_review=previous,
        previous_commit_sha="abc123def456",
        current_commit_sha="def456abc789",
        commits_since_review=[],
        files_changed_since_review=["x.py"],
        diff_since_review=diff,
    )


def _make_empty_async_query(capture: dict):
    """Return an async-generator stub that captures the prompt arg.

    The real SDK signature is `query(prompt, options) -> AsyncIterator`.
    Our stub records the prompt then yields nothing so the caller's
    `async for` loop completes immediately. This matches the
    "no structured output" branch in
    followup_reviewer.py:_run_ai_review.
    """

    async def fake_query(prompt, options):
        capture["prompt"] = prompt
        capture["options"] = options
        # Make this an async generator without yielding any messages.
        if False:
            yield None  # pragma: no cover

    return fake_query


class TestReviewerNotesInjection:
    """Phase 4a: reviewer_notes must be injected under ### Reviewer Notes."""

    @pytest.mark.asyncio
    async def test_notes_appear_under_heading(
        self, followup_reviewer, followup_context
    ):
        """The prompt MUST contain '### Reviewer Notes' followed by the notes."""
        capture: dict = {}
        with patch("claude_agent_sdk.query", _make_empty_async_query(capture)):
            await followup_reviewer._run_ai_review(
                followup_context,
                resolved=[],
                unresolved=[],
                reviewer_notes="x",
            )

        assert "prompt" in capture, "fake query was never called"
        prompt = capture["prompt"]

        # Heading is present
        assert "### Reviewer Notes" in prompt, (
            "Expected '### Reviewer Notes' heading missing from prompt"
        )

        # Notes body appears after the heading (i.e. it was actually injected,
        # not just present coincidentally elsewhere).
        heading_idx = prompt.index("### Reviewer Notes")
        body_after_heading = prompt[heading_idx:]
        assert "x" in body_after_heading, (
            "Expected reviewer_notes body 'x' missing after heading"
        )

    @pytest.mark.asyncio
    async def test_multiline_notes_preserved(
        self, followup_reviewer, followup_context
    ):
        """Multi-line notes appear verbatim after the heading."""
        notes = (
            "Check the auth refactor in users/api.py.\n"
            "Also verify the race condition in payments/processor.py."
        )
        capture: dict = {}
        with patch("claude_agent_sdk.query", _make_empty_async_query(capture)):
            await followup_reviewer._run_ai_review(
                followup_context,
                resolved=[],
                unresolved=[],
                reviewer_notes=notes,
            )

        prompt = capture["prompt"]
        heading_idx = prompt.index("### Reviewer Notes")
        body = prompt[heading_idx:]
        assert "Check the auth refactor in users/api.py." in body
        assert "race condition in payments/processor.py." in body

    @pytest.mark.asyncio
    async def test_empty_notes_skip_section(
        self, followup_reviewer, followup_context
    ):
        """Empty / whitespace-only notes MUST NOT emit the heading."""
        capture: dict = {}
        with patch("claude_agent_sdk.query", _make_empty_async_query(capture)):
            await followup_reviewer._run_ai_review(
                followup_context,
                resolved=[],
                unresolved=[],
                reviewer_notes="",
            )

        prompt = capture["prompt"]
        assert "### Reviewer Notes" not in prompt, (
            "Empty notes should not emit '### Reviewer Notes' section"
        )

    @pytest.mark.asyncio
    async def test_whitespace_only_notes_skip_section(
        self, followup_reviewer, followup_context
    ):
        """Whitespace-only notes are equivalent to no notes."""
        capture: dict = {}
        with patch("claude_agent_sdk.query", _make_empty_async_query(capture)):
            await followup_reviewer._run_ai_review(
                followup_context,
                resolved=[],
                unresolved=[],
                reviewer_notes="   \n\t  \n",
            )

        prompt = capture["prompt"]
        assert "### Reviewer Notes" not in prompt

    @pytest.mark.asyncio
    async def test_none_notes_skip_section(
        self, followup_reviewer, followup_context
    ):
        """None notes (default) MUST NOT emit the heading."""
        capture: dict = {}
        with patch("claude_agent_sdk.query", _make_empty_async_query(capture)):
            await followup_reviewer._run_ai_review(
                followup_context,
                resolved=[],
                unresolved=[],
                reviewer_notes=None,
            )

        prompt = capture["prompt"]
        assert "### Reviewer Notes" not in prompt
