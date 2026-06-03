"""
Phase 4a — pr_reviewer.md must contain the Reviewer Notes directive.

The PR reviewer prompt (apps/backend/prompts/github/pr_reviewer.md) is
the system prompt sent to Claude for every code review. As part of
Phase 4a, it must explicitly instruct the AI to address every reviewer
note that appears in the injected `## Reviewer Notes` section of the
user message.

This is a snapshot-style assertion: we load the file and verify that
the literal section header AND the MUST directive are present. If the
directive is removed or the heading drifts, this test catches it
before it ships.

See spec FR #8 and #12, Phase 4a subtask-4a-1 in
.auto-claude/specs/131-implement-manual-pr-findings-system/implementation_plan.json.
"""

from __future__ import annotations

from pathlib import Path

import pytest

# tests/ → services/ → github/ → runners/ → backend/
_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent
_PROMPT_PATH = _BACKEND_DIR / "prompts" / "github" / "pr_reviewer.md"


@pytest.fixture(scope="module")
def prompt_text() -> str:
    """Read pr_reviewer.md once per module."""
    if not _PROMPT_PATH.exists():
        pytest.fail(f"pr_reviewer.md not found at {_PROMPT_PATH}")
    return _PROMPT_PATH.read_text(encoding="utf-8")


class TestPRReviewerPrompt:
    """Verify the Phase 4a directive lives in the prompt file."""

    def test_prompt_file_exists(self) -> None:
        assert _PROMPT_PATH.exists(), f"Missing prompt file: {_PROMPT_PATH}"

    def test_contains_reviewer_notes_section_header(self, prompt_text: str) -> None:
        """The exact section header must appear verbatim.

        The directive uses ### (3 hashes — a subsection inside the
        system prompt). The user-content heading is ## (2 hashes) and
        intentionally lives at a different nesting level — do NOT
        unify them (see spec §Patterns: Followup-Review Notes Wiring).
        """
        assert "### Reviewer Notes (when present)" in prompt_text, (
            "Reviewer Notes section header is missing or has drifted. "
            "Expected literal: '### Reviewer Notes (when present)'."
        )

    def test_contains_must_directive_inside_section(self, prompt_text: str) -> None:
        """A MUST-style directive must appear inside the Reviewer Notes section.

        The AI is required to address every reviewer note — silently
        skipping a note is a failure mode the directive forbids.
        """
        header = "### Reviewer Notes (when present)"
        section_start = prompt_text.find(header)
        assert section_start >= 0, "Reviewer Notes section header missing"

        # The section ends at the next sibling/parent heading
        # ("\n## " for top-level or "\n### " for next subsection),
        # whichever comes first; otherwise end of file.
        search_from = section_start + len(header)
        next_top = prompt_text.find("\n## ", search_from)
        next_sub = prompt_text.find("\n### ", search_from)
        # Pick the nearest non-negative boundary
        candidates = [idx for idx in (next_top, next_sub) if idx >= 0]
        section_end = min(candidates) if candidates else len(prompt_text)
        section_text = prompt_text[section_start:section_end]

        assert "MUST" in section_text, (
            "Reviewer Notes section is missing the MUST directive. "
            "The AI must be explicitly told it MUST address every note "
            "(see spec FR #8)."
        )

    def test_section_warns_against_silent_skipping(self, prompt_text: str) -> None:
        """The directive must explicitly forbid silently skipping notes.

        This is the behavioural anchor that prevents future regressions
        from quietly removing the requirement to handle every note.
        """
        header = "### Reviewer Notes (when present)"
        section_start = prompt_text.find(header)
        assert section_start >= 0
        search_from = section_start + len(header)
        next_top = prompt_text.find("\n## ", search_from)
        next_sub = prompt_text.find("\n### ", search_from)
        candidates = [idx for idx in (next_top, next_sub) if idx >= 0]
        section_end = min(candidates) if candidates else len(prompt_text)
        section_text = prompt_text[section_start:section_end].lower()

        # The exact phrasing may evolve, but at minimum the section
        # should mention "silently" or "skip" + "note" — terms that
        # encode the never-silently-skip-a-note contract.
        assert "skip" in section_text or "silent" in section_text, (
            "Reviewer Notes section should explicitly forbid silently "
            "skipping notes (look for words like 'skip' or 'silent')."
        )
