#!/usr/bin/env python3
"""
Tests for Coding Critic Agent
===============================

Tests the CriticVerdict dataclass, _parse_critic_response() verdict parser,
and is_coding_critic_enabled() complexity-based activation function.
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

from agents.coding_critic import CriticVerdict, _parse_critic_response
from phase_config import is_coding_critic_enabled


# =============================================================================
# CriticVerdict Dataclass Tests
# =============================================================================


class TestCriticVerdictDataclass:
    """Tests for CriticVerdict fields, types, and defaults."""

    def test_critic_verdict_dataclass(self):
        """CriticVerdict fields have correct types and defaults."""
        verdict = CriticVerdict(passed=True)

        assert verdict.passed is True
        assert isinstance(verdict.passed, bool)
        assert isinstance(verdict.issues, list)
        assert isinstance(verdict.blocking_issues, list)
        assert isinstance(verdict.warnings, list)
        assert isinstance(verdict.fix_instructions, str)
        assert isinstance(verdict.raw_response, str)

        # Defaults should be empty
        assert verdict.issues == []
        assert verdict.blocking_issues == []
        assert verdict.warnings == []
        assert verdict.fix_instructions == ""
        assert verdict.raw_response == ""

    def test_critic_verdict_with_all_fields(self):
        """CriticVerdict can be constructed with all fields populated."""
        verdict = CriticVerdict(
            passed=False,
            issues=["issue1", "issue2"],
            blocking_issues=["blocker1"],
            warnings=["warning1"],
            fix_instructions="Fix the import",
            raw_response="full response text",
        )

        assert verdict.passed is False
        assert len(verdict.issues) == 2
        assert len(verdict.blocking_issues) == 1
        assert len(verdict.warnings) == 1
        assert verdict.fix_instructions == "Fix the import"
        assert verdict.raw_response == "full response text"


# =============================================================================
# _parse_critic_response() Tests
# =============================================================================


class TestParseCriticResponse:
    """Tests for _parse_critic_response() verdict parser."""

    def test_parse_pass_verdict(self):
        """_parse_critic_response() correctly parses a PASS verdict with no blocking issues."""
        response = """## Validation Result

### Issues Found
No blocking issues found.

### Verdict
VERDICT: PASS

All checks passed. The subtask implementation looks correct.
"""
        verdict = _parse_critic_response(response)

        assert verdict.passed is True
        assert verdict.blocking_issues == []
        assert verdict.raw_response == response

    def test_parse_fail_verdict(self):
        """Correctly parses FAIL verdict with blocking issues and fix instructions."""
        response = """## Validation Result

### Issues Found

[BLOCKING] Missing export for `UserService` class in `services/index.ts`
[BLOCKING] Import path `../utils/helpers` does not exist

### Fix Instructions
1. Add `export { UserService }` to services/index.ts
2. Create the missing utils/helpers.ts file or fix the import path

### Verdict
VERDICT: FAIL
"""
        verdict = _parse_critic_response(response)

        assert verdict.passed is False
        assert len(verdict.blocking_issues) == 2
        assert any("UserService" in issue for issue in verdict.blocking_issues)
        assert any("Import path" in issue for issue in verdict.blocking_issues)
        assert "export" in verdict.fix_instructions.lower() or "services/index.ts" in verdict.fix_instructions
        assert verdict.raw_response == response

    def test_parse_fail_with_warnings(self):
        """Distinguishes [BLOCKING] from [WARNING] issues."""
        response = """## Validation Result

### Issues Found

[BLOCKING] Compilation error: undefined variable `config` in main.py line 42
[WARNING] Consider adding type hints to the new `process_data()` function
[WARNING] Magic number 42 should be extracted to a named constant

### Fix Instructions
Fix the undefined variable by importing config from the settings module.

### Verdict
VERDICT: FAIL
"""
        verdict = _parse_critic_response(response)

        assert verdict.passed is False
        assert len(verdict.blocking_issues) == 1
        assert len(verdict.warnings) == 2
        # All issues = blocking + warnings
        assert len(verdict.issues) == 3
        assert any("Compilation error" in issue for issue in verdict.blocking_issues)
        assert any("type hints" in w for w in verdict.warnings)
        assert any("Magic number" in w for w in verdict.warnings)

    def test_parse_empty_response(self):
        """Defaults to PASS on empty response."""
        verdict = _parse_critic_response("")

        assert verdict.passed is True
        assert verdict.blocking_issues == []
        assert verdict.warnings == []
        assert verdict.issues == []

    def test_parse_none_like_response(self):
        """Defaults to PASS on None-like (whitespace only) response."""
        verdict = _parse_critic_response("   \n\n  ")

        assert verdict.passed is True

    def test_parse_malformed_response(self):
        """Defaults to PASS when verdict markers missing."""
        response = """The subtask looks fine. I reviewed the code changes
and everything seems to be working correctly. No issues found.
"""
        verdict = _parse_critic_response(response)

        assert verdict.passed is True
        assert verdict.raw_response == response

    def test_parse_pass_verdict_case_insensitive(self):
        """VERDICT marker is case-insensitive."""
        response = "verdict: PASS\nAll good."
        verdict = _parse_critic_response(response)
        assert verdict.passed is True

        response2 = "Verdict: pass\nAll good."
        verdict2 = _parse_critic_response(response2)
        assert verdict2.passed is True

    def test_parse_fail_verdict_case_insensitive(self):
        """VERDICT: FAIL marker is case-insensitive."""
        response = "verdict: FAIL\n[BLOCKING] broken import"
        verdict = _parse_critic_response(response)
        assert verdict.passed is False


# =============================================================================
# is_coding_critic_enabled() Tests
# =============================================================================


class TestIsCodingCriticEnabled:
    """Tests for is_coding_critic_enabled() complexity-based activation."""

    def _make_mock_assessment(self, complexity: str) -> MagicMock:
        """Create a mock RiskAssessment with the given complexity."""
        assessment = MagicMock()
        assessment.complexity = complexity
        return assessment

    @patch("analysis.risk_classifier.RiskClassifier")
    def test_is_coding_critic_enabled_complex(self, mock_classifier_cls):
        """Returns True when complexity_assessment.json has complexity 'complex'."""
        mock_instance = MagicMock()
        mock_instance.load_assessment.return_value = self._make_mock_assessment("complex")
        mock_classifier_cls.return_value = mock_instance

        result = is_coding_critic_enabled(Path("/fake/spec/dir"))

        assert result is True
        mock_instance.load_assessment.assert_called_once_with(Path("/fake/spec/dir"))

    @patch("analysis.risk_classifier.RiskClassifier")
    def test_is_coding_critic_enabled_simple(self, mock_classifier_cls):
        """Returns False for 'simple'."""
        mock_instance = MagicMock()
        mock_instance.load_assessment.return_value = self._make_mock_assessment("simple")
        mock_classifier_cls.return_value = mock_instance

        result = is_coding_critic_enabled(Path("/fake/spec/dir"))

        assert result is False

    @patch("analysis.risk_classifier.RiskClassifier")
    def test_is_coding_critic_enabled_standard(self, mock_classifier_cls):
        """Returns False for 'standard'."""
        mock_instance = MagicMock()
        mock_instance.load_assessment.return_value = self._make_mock_assessment("standard")
        mock_classifier_cls.return_value = mock_instance

        result = is_coding_critic_enabled(Path("/fake/spec/dir"))

        assert result is False

    @patch("analysis.risk_classifier.RiskClassifier")
    def test_is_coding_critic_enabled_missing_file(self, mock_classifier_cls):
        """Returns False when no assessment file (load_assessment returns None)."""
        mock_instance = MagicMock()
        mock_instance.load_assessment.return_value = None
        mock_classifier_cls.return_value = mock_instance

        result = is_coding_critic_enabled(Path("/fake/spec/dir"))

        assert result is False
