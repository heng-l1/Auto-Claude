"""
Coding Critic Agent
===================

Validates each subtask's output before the coder moves to the next one.
Catches blocking issues (broken compilation, missing exports, broken imports)
early, before they cascade into downstream subtasks.

The critic runs a lightweight, read-only SDK session between subtasks and
returns a CriticVerdict. On any infrastructure error, it defaults to PASS
so it never blocks builds due to its own failure.
"""

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from core.client import create_client
from core.error_utils import safe_receive_messages
from core.git_executable import run_git

logger = logging.getLogger(__name__)

# Directory containing prompt files
PROMPTS_DIR = Path(__file__).parent.parent / "prompts"

# Maximum number of diff lines to include in the critic prompt
# to avoid context window overflow
MAX_DIFF_LINES = 500


@dataclass
class CriticVerdict:
    """Result of the coding critic's evaluation of a subtask.

    Attributes:
        passed: Whether the subtask passed validation.
        issues: All issues found (blocking + warnings).
        blocking_issues: Issues that would cause downstream subtasks to fail.
        warnings: Non-blocking quality observations.
        fix_instructions: Actionable instructions for the coder to fix blocking issues.
        raw_response: The full unprocessed response from the critic agent.
    """

    passed: bool
    issues: list[str] = field(default_factory=list)
    blocking_issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    fix_instructions: str = ""
    raw_response: str = ""


def _get_git_diff(
    project_dir: Path,
    commit_before: str | None,
    commit_after: str | None,
) -> str:
    """Get the git diff between two commits, capped at MAX_DIFF_LINES.

    Args:
        project_dir: Project root for git operations.
        commit_before: Commit hash before the subtask.
        commit_after: Commit hash after the subtask.

    Returns:
        The diff text, truncated if necessary.
    """
    if not commit_before or not commit_after:
        return "(no diff available — missing commit references)"

    if commit_before == commit_after:
        return "(no changes — commits are identical)"

    result = run_git(
        ["diff", commit_before, commit_after],
        cwd=project_dir,
        timeout=30,
    )

    if result.returncode != 0:
        return f"(git diff failed: {result.stderr.strip()})"

    diff_text = result.stdout
    lines = diff_text.splitlines()

    if len(lines) > MAX_DIFF_LINES:
        truncated = "\n".join(lines[:MAX_DIFF_LINES])
        return f"{truncated}\n\n[... diff truncated at {MAX_DIFF_LINES} lines — {len(lines)} total ...]"

    return diff_text


def _build_critic_prompt(
    spec_dir: Path,
    subtask: dict,
    commit_before: str | None,
    commit_after: str | None,
    project_dir: Path,
) -> str:
    """Build the full prompt for the coding critic agent.

    Loads the coding_critic_agent.md prompt template and appends the subtask
    context including ID, description, files involved, acceptance criteria,
    verification command, and a capped git diff.

    Args:
        spec_dir: Directory containing the spec files.
        subtask: The subtask dict from the implementation plan.
        commit_before: Commit hash before the subtask.
        commit_after: Commit hash after the subtask.
        project_dir: Project root for git diff operations.

    Returns:
        The complete prompt string for the critic agent.
    """
    # Load the prompt template
    prompt_file = PROMPTS_DIR / "coding_critic_agent.md"
    if not prompt_file.exists():
        logger.warning("[Coding Critic] Prompt template not found: %s", prompt_file)
        return ""

    base_prompt = prompt_file.read_text(encoding="utf-8")

    # Extract subtask context
    subtask_id = subtask.get("id", "unknown")
    description = subtask.get("description", "No description")
    files_to_modify = subtask.get("files_to_modify", [])
    files_to_create = subtask.get("files_to_create", [])
    patterns_from = subtask.get("patterns_from", [])

    # Extract verification command
    verification = subtask.get("verification", {})
    verification_cmd = verification.get("command", "No verification command specified")
    verification_expected = verification.get("expected", "")

    # Get the git diff
    diff_text = _get_git_diff(project_dir, commit_before, commit_after)

    # Build the context section
    context_parts = [
        "\n\n---\n\n## SUBTASK CONTEXT\n",
        f"**Subtask ID:** `{subtask_id}`\n",
        f"**Description:** {description}\n",
    ]

    if files_to_modify:
        context_parts.append(
            f"**Files to modify:** {', '.join(f'`{f}`' for f in files_to_modify)}\n"
        )

    if files_to_create:
        context_parts.append(
            f"**Files to create:** {', '.join(f'`{f}`' for f in files_to_create)}\n"
        )

    if patterns_from:
        context_parts.append(
            f"**Patterns from:** {', '.join(f'`{f}`' for f in patterns_from)}\n"
        )

    context_parts.extend([
        f"\n**Verification command:**\n```bash\n{verification_cmd}\n```\n",
        f"**Expected output:** {verification_expected}\n" if verification_expected else "",
        f"\n**Commit before:** `{commit_before or 'N/A'}`\n",
        f"**Commit after:** `{commit_after or 'N/A'}`\n",
        f"\n### Git Diff\n\n```diff\n{diff_text}\n```\n",
    ])

    return base_prompt + "".join(context_parts)


def _parse_critic_response(response_text: str) -> CriticVerdict:
    """Parse the structured verdict from the critic's response.

    Looks for VERDICT: PASS or VERDICT: FAIL markers, extracts [BLOCKING]
    and [WARNING] issues, and collects fix instructions. Defaults to PASS
    if markers are not found or response is empty.

    Args:
        response_text: The raw response text from the critic agent.

    Returns:
        A CriticVerdict with the parsed results.
    """
    if not response_text or not response_text.strip():
        logger.info("[Coding Critic] Empty response — defaulting to PASS")
        return CriticVerdict(passed=True, raw_response=response_text or "")

    # Determine the verdict (PASS or FAIL)
    # Look for "VERDICT: PASS" or "VERDICT: FAIL" markers (case-insensitive)
    verdict_match = re.search(
        r"VERDICT:\s*(PASS|FAIL)", response_text, re.IGNORECASE
    )

    if not verdict_match:
        logger.info(
            "[Coding Critic] No VERDICT marker found in response — defaulting to PASS"
        )
        return CriticVerdict(passed=True, raw_response=response_text)

    passed = verdict_match.group(1).upper() == "PASS"

    # Extract [BLOCKING] issues
    blocking_issues: list[str] = []
    blocking_pattern = re.findall(
        r"\[BLOCKING\]\s*(.+?)(?=\n(?:####|\[BLOCKING\]|\[WARNING\]|###|$))",
        response_text,
        re.IGNORECASE | re.DOTALL,
    )
    for issue in blocking_pattern:
        cleaned = issue.strip()
        if cleaned:
            blocking_issues.append(cleaned)

    # Extract [WARNING] issues
    warnings: list[str] = []
    warning_pattern = re.findall(
        r"\[WARNING\]\s*(.+?)(?=\n(?:####|\[BLOCKING\]|\[WARNING\]|###|$))",
        response_text,
        re.IGNORECASE | re.DOTALL,
    )
    for issue in warning_pattern:
        cleaned = issue.strip()
        if cleaned:
            warnings.append(cleaned)

    # Combine all issues
    all_issues = blocking_issues + warnings

    # Extract fix instructions (text after "### Fix Instructions" heading)
    fix_instructions = ""
    fix_match = re.search(
        r"###\s*Fix Instructions\s*\n(.*?)(?=\n###|\Z)",
        response_text,
        re.IGNORECASE | re.DOTALL,
    )
    if fix_match:
        fix_instructions = fix_match.group(1).strip()

    return CriticVerdict(
        passed=passed,
        issues=all_issues,
        blocking_issues=blocking_issues,
        warnings=warnings,
        fix_instructions=fix_instructions,
        raw_response=response_text,
    )


async def run_coding_critic(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    subtask: dict,
    commit_before: str | None,
    commit_after: str | None,
) -> CriticVerdict:
    """Run the coding critic agent to validate a completed subtask.

    Creates a read-only SDK client session, sends the critic prompt with
    subtask context, runs one conversation turn, and parses the verdict.

    On any infrastructure error (network, auth, SDK bug), catches the
    exception and returns a PASS verdict so the critic never blocks builds.

    Args:
        project_dir: Root directory of the project (working directory).
        spec_dir: Directory containing the spec files.
        model: Claude model to use for the critic session.
        subtask: The subtask dict from the implementation plan.
        commit_before: Commit hash before the subtask was implemented.
        commit_after: Commit hash after the subtask was implemented.

    Returns:
        CriticVerdict with the validation result.
    """
    subtask_id = subtask.get("id", "unknown")

    try:
        logger.info("[Coding Critic] Starting validation for subtask %s", subtask_id)

        # Build the critic prompt
        prompt = _build_critic_prompt(
            spec_dir, subtask, commit_before, commit_after, project_dir
        )
        if not prompt:
            logger.warning(
                "[Coding Critic] Empty prompt — skipping critic, defaulting to PASS"
            )
            return CriticVerdict(passed=True, raw_response="")

        # Create a read-only SDK client for the critic
        logger.info("[Coding Critic] Creating SDK client (agent_type=coding_critic)")
        client = create_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            agent_type="coding_critic",
        )

        # Run one conversation turn
        logger.info("[Coding Critic] Sending prompt to SDK...")
        await client.query(prompt)

        # Collect the response text
        response_text = ""
        async for msg in safe_receive_messages(client, caller="coding_critic"):
            msg_type = type(msg).__name__

            if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                for block in msg.content:
                    block_type = type(block).__name__
                    if block_type == "TextBlock" and hasattr(block, "text"):
                        response_text += block.text

        logger.info(
            "[Coding Critic] Received response (%d chars)", len(response_text)
        )

        # Parse the verdict
        verdict = _parse_critic_response(response_text)

        if verdict.passed:
            logger.info("[Coding Critic] Subtask %s — PASS", subtask_id)
        else:
            logger.warning(
                "[Coding Critic] Subtask %s — FAIL (%d blocking issues)",
                subtask_id,
                len(verdict.blocking_issues),
            )

        return verdict

    except Exception as e:
        # Never block builds due to critic infrastructure errors
        logger.warning(
            "[Coding Critic] Infrastructure error for subtask %s: %s — defaulting to PASS",
            subtask_id,
            e,
        )
        return CriticVerdict(
            passed=True,
            raw_response=f"[Infrastructure error: {e}]",
        )
