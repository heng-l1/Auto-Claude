"""
PR Creation Agent Runner
=========================

Standalone runner that builds rich context from specs, QA reports,
and project conventions, then invokes a Claude agent to push the branch
and create a pull request with a well-crafted title and description.

Guarantees valid JSON output to stdout even on failure — the frontend
parses the last JSON object from stdout to display the PR result.

Usage:
    python apps/backend/runners/pr_creation_runner.py \
        --project /path/to/project \
        --spec-dir /path/to/spec \
        --spec-name 114-implement-feature

    # Or programmatically:
    from runners.pr_creation_runner import run_pr_creation_agent
    result = await run_pr_creation_agent(project_dir, spec_dir, spec_name)
"""

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path

# Add auto-claude to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Validate platform-specific dependencies BEFORE any imports that might
# trigger graphiti_core -> real_ladybug -> pywintypes import chain (ACS-253)
from core.dependency_validator import validate_platform_dependencies

validate_platform_dependencies()

# Load .env file with centralized error handling
from cli.utils import import_dotenv

load_dotenv = import_dotenv()

env_file = Path(__file__).parent.parent / ".env"
if env_file.exists():
    load_dotenv(env_file)

from agents.pr_template_filler import detect_pr_template
from agents.session import run_agent_session
from core.client import create_client, load_claude_md
from core.workspace.git_utils import get_existing_build_worktree
from phase_config import (
    get_fast_mode,
    get_phase_client_thinking_kwargs,
    get_phase_model,
    get_phase_model_betas,
)
from task_logger import LogPhase, get_task_logger

logger = logging.getLogger(__name__)

# Maximum sizes (in characters) for context truncation to stay within token limits
MAX_SPEC_CHARS = 8_000
MAX_QA_REPORT_CHARS = 4_000
MAX_PLAN_CHARS = 4_000
MAX_CLAUDE_MD_CHARS = 6_000


def _failure_result(error: str, **overrides) -> dict:
    """
    Build a failure result dict with guaranteed JSON structure.

    All fields from PushAndCreatePRResult are populated with safe defaults,
    ensuring the frontend can always parse the output.

    Args:
        error: Human-readable error description
        **overrides: Additional fields to override defaults

    Returns:
        Dict matching PushAndCreatePRResult structure.
    """
    result = {
        "success": False,
        "pushed": False,
        "remote": "origin",
        "branch": "",
        "provider": "unknown",
        "pr_url": None,
        "already_exists": False,
        "error": error,
    }
    result.update(overrides)
    return result


def _extract_json_from_response(response_text: str) -> dict | None:
    """
    Extract the last JSON object from agent response text.

    Mirrors the frontend parsePRJsonOutput() regex strategy: finds all
    JSON-like objects in the output and returns the last one that contains
    expected PR result fields.

    Args:
        response_text: Full text output from the agent session

    Returns:
        Parsed dict if valid PR result JSON found, None otherwise.
    """
    if not response_text:
        return None

    # Match JSON objects (including one level of nesting)
    # This mirrors the frontend regex: /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g
    pattern = r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}"
    matches = re.findall(pattern, response_text)

    if not matches:
        return None

    # Try matches in reverse order (agent should print JSON as last output)
    for match in reversed(matches):
        try:
            parsed = json.loads(match)
            # Validate it looks like a PR result (has at least one expected field)
            if isinstance(parsed, dict) and (
                "success" in parsed or "pr_url" in parsed or "pushed" in parsed
            ):
                return parsed
        except json.JSONDecodeError:
            continue

    return None


def _load_file_content(path: Path, max_chars: int, label: str) -> str:
    """
    Load a file's content, truncating if too large.

    Args:
        path: Path to the file
        max_chars: Maximum characters before truncation
        label: Human-readable label for log messages

    Returns:
        File content (possibly truncated) or a fallback message.
    """
    if not path.is_file():
        logger.info("%s not found: %s", label, path)
        return f"({label} not available)"
    try:
        content = path.read_text(encoding="utf-8")
        if len(content) > max_chars:
            return content[:max_chars] + f"\n\n(... {label} truncated for brevity)"
        return content
    except Exception as e:
        logger.warning("Failed to read %s: %s", label, e)
        return f"({label} could not be loaded)"


def _summarize_implementation_plan(spec_dir: Path) -> str:
    """
    Load and summarize the implementation plan for context.

    Extracts feature name, workflow type, and per-phase completion stats
    rather than including the full JSON.

    Args:
        spec_dir: Directory containing spec files

    Returns:
        Human-readable plan summary.
    """
    plan_path = spec_dir / "implementation_plan.json"
    if not plan_path.is_file():
        return "(No implementation plan available)"

    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        parts: list[str] = []
        parts.append(f"Feature: {plan.get('feature', 'Unknown')}")
        parts.append(f"Workflow: {plan.get('workflow_type', 'Unknown')}")

        for phase in plan.get("phases", []):
            subtasks = phase.get("subtasks", [])
            completed = sum(1 for s in subtasks if s.get("status") == "completed")
            parts.append(
                f"  Phase '{phase.get('name', '?')}': "
                f"{completed}/{len(subtasks)} subtasks completed"
            )

        summary = "\n".join(parts)
        if len(summary) > MAX_PLAN_CHARS:
            summary = summary[:MAX_PLAN_CHARS] + "\n(... plan truncated)"
        return summary

    except Exception as e:
        logger.warning("Failed to parse implementation plan: %s", e)
        return "(Implementation plan could not be parsed)"


def _build_context_message(
    project_dir: Path,
    spec_dir: Path,
    spec_name: str,
    target_branch: str,
    title: str | None,
    draft: bool,
    worktree_path: Path | None = None,
) -> str:
    """
    Build the full context message for the PR creation agent.

    Loads the agent prompt template and appends all available context:
    spec overview, QA report, implementation plan summary, CLAUDE.md,
    and PR template.

    Args:
        project_dir: Root directory of the project
        spec_dir: Directory containing the spec files
        spec_name: Name of the spec
        target_branch: Target branch for the PR
        title: User-provided PR title (None to auto-generate)
        draft: Whether to create as draft PR

    Returns:
        The assembled prompt string.

    Raises:
        FileNotFoundError: If the prompt template file is missing.
    """
    # Load prompt template
    prompts_dir = Path(__file__).parent.parent / "prompts"
    prompt_path = prompts_dir / "pr_creation_agent.md"
    if not prompt_path.is_file():
        raise FileNotFoundError(
            f"PR creation agent prompt not found: {prompt_path}"
        )
    system_instructions = prompt_path.read_text(encoding="utf-8")

    # Load spec overview
    spec_content = _load_file_content(
        spec_dir / "spec.md", MAX_SPEC_CHARS, "Spec overview"
    )

    # Load QA report
    qa_content = _load_file_content(
        spec_dir / "qa_report.md", MAX_QA_REPORT_CHARS, "QA report"
    )

    # Load implementation plan summary
    plan_content = _summarize_implementation_plan(spec_dir)

    # Load CLAUDE.md for project conventions
    claude_md = load_claude_md(project_dir)
    if claude_md:
        if len(claude_md) > MAX_CLAUDE_MD_CHARS:
            claude_md = (
                claude_md[:MAX_CLAUDE_MD_CHARS] + "\n\n(... CLAUDE.md truncated)"
            )
    else:
        claude_md = "(No CLAUDE.md found in project)"

    # Detect PR template
    pr_template = detect_pr_template(project_dir)
    pr_template_section = (
        pr_template
        if pr_template
        else "(No PR template detected — use default structure from your instructions)"
    )

    # Assemble the full message
    worktree_line = (
        f"**Worktree (your cwd — already on the spec branch):** {worktree_path}"
        if worktree_path
        else "**Worktree:** (not provided — running from project root)"
    )
    parts = [
        system_instructions,
        "",
        "---",
        "",
        "## CONTEXT FOR THIS PR",
        "",
        f"**Spec Name:** {spec_name}",
        f"**Target Branch:** {target_branch}",
        f"**User-Provided Title:** {title or '(none — derive from context)'}",
        f"**Draft:** {'yes' if draft else 'no'}",
        worktree_line,
        "",
        "Your working directory is already set to the worktree above. "
        "The spec branch is checked out there. Do NOT attempt to `git checkout` "
        "a different branch and do NOT `cd` elsewhere — just run git/gh from here.",
        "",
        "### Spec Overview",
        "",
        spec_content,
        "",
        "### QA Report",
        "",
        qa_content,
        "",
        "### Implementation Plan Summary",
        "",
        plan_content,
        "",
        "### Project Conventions (CLAUDE.md)",
        "",
        claude_md,
        "",
        "### PR Template",
        "",
        pr_template_section,
        "",
        "---",
        "",
        "Now proceed through all phases: detect provider, push branch, "
        "compose title/body, create PR, and print the JSON result.",
    ]

    return "\n".join(parts)


async def run_pr_creation_agent(
    project_dir: Path,
    spec_dir: Path,
    spec_name: str,
    target_branch: str | None = None,
    title: str | None = None,
    draft: bool = False,
    cli_model: str | None = None,
    cli_thinking: str | None = None,
) -> dict:
    """
    Run the PR creation agent to push branch and create a pull request.

    Builds rich context from spec files, QA reports, and project conventions,
    then invokes a Claude agent to compose and create the PR. Guarantees
    valid JSON output matching PushAndCreatePRResult even on failure.

    Args:
        project_dir: Root directory of the project
        spec_dir: Directory containing the spec files
        spec_name: Name of the spec (e.g., '114-implement-feature')
        target_branch: Target branch for the PR (default: 'main')
        title: User-provided PR title (None to auto-generate)
        draft: Whether to create as draft PR
        cli_model: Model override from CLI argument
        cli_thinking: Thinking level override from CLI argument

    Returns:
        Dict matching PushAndCreatePRResult structure with fields:
        success, pushed, remote, branch, provider, pr_url, already_exists, error
    """
    target_branch = target_branch or "main"

    # Initialize task logger
    task_logger = get_task_logger(spec_dir)
    if task_logger:
        task_logger.start_phase(LogPhase.PR, "PR creation agent")

    try:
        # Resolve worktree path — the agent MUST run from the worktree so it's
        # on the correct branch. Running from project_dir leaves the agent on
        # whatever branch the main repo is checked out to (often master/main),
        # and it cannot `git checkout` the spec branch because the worktree
        # already holds it.
        worktree_path = get_existing_build_worktree(project_dir, spec_name)
        if not worktree_path:
            logger.error("No worktree found for spec: %s", spec_name)
            return _failure_result(f"No worktree found for spec: {spec_name}")

        # Resolve model and thinking config for 'pr' phase
        model = get_phase_model(spec_dir, "pr", cli_model)
        thinking_kwargs = get_phase_client_thinking_kwargs(
            spec_dir, "pr", model, cli_thinking
        )
        betas = get_phase_model_betas(spec_dir, "pr", cli_model)
        fast_mode = get_fast_mode(spec_dir)

        logger.info(
            "PR creation agent config: model=%s, thinking=%s, fast_mode=%s, worktree=%s",
            model,
            thinking_kwargs,
            fast_mode,
            worktree_path,
        )

        # Build context message
        message = _build_context_message(
            project_dir=project_dir,
            spec_dir=spec_dir,
            spec_name=spec_name,
            target_branch=target_branch,
            title=title,
            draft=draft,
            worktree_path=worktree_path,
        )

        # Capture the Claude CLI subprocess's stderr so we can diagnose
        # SDK-level issues like "Control request timeout: initialize" instead
        # of flying blind. The Electron worktree-handler tags Python stderr
        # lines with "[CREATE_PR DEBUG] STDERR:", so these will surface there.
        # The marker line below confirms this wiring ran even if the CLI
        # emits nothing on stderr (i.e. a silent hang vs. missing callback).
        def cli_stderr_cb(line: str) -> None:
            print(f"[CLI STDERR] {line}", file=sys.stderr, flush=True)

        print(
            f"[PR_AGENT] stderr capture enabled "
            f"(NODE_ENV={os.environ.get('NODE_ENV', '')}, "
            f"DEBUG={os.environ.get('DEBUG', '')})",
            file=sys.stderr,
            flush=True,
        )

        # Create client rooted at the worktree so git commands see the
        # spec branch checked out.
        client = create_client(
            project_dir,
            spec_dir,
            model,
            agent_type="pr_creation_agent",
            betas=betas or None,
            fast_mode=fast_mode,
            cwd=worktree_path,
            stderr_callback=cli_stderr_cb,
            **thinking_kwargs,
        )

        # Run agent session
        async with client:
            status, response, error_info = await run_agent_session(
                client, message, spec_dir, verbose=False, phase=LogPhase.PR
            )

        if task_logger:
            task_logger.end_phase(
                LogPhase.PR,
                success=(status != "error"),
                message="PR creation agent completed",
            )

        if status == "error":
            error_msg = error_info.get("message", "Agent session failed")
            logger.error("PR creation agent error: %s", error_msg)

            # Try to extract JSON even from error response (agent may have
            # printed partial results before the error)
            result = _extract_json_from_response(response)
            if result:
                return result

            return _failure_result(f"Agent execution failed: {error_msg}")

        # Extract JSON result from agent response
        result = _extract_json_from_response(response)
        if result:
            logger.info(
                "PR creation agent completed: %s",
                result.get("pr_url", "no URL"),
            )
            return result

        # Agent didn't produce parseable JSON — this shouldn't happen if
        # the prompt is followed, but we handle it gracefully
        logger.warning("PR creation agent did not produce valid JSON output")
        return _failure_result(
            "Agent completed but did not produce valid JSON output"
        )

    except FileNotFoundError as e:
        logger.error("PR creation agent setup error: %s", e)
        if task_logger:
            task_logger.log_error(f"Setup error: {e}", LogPhase.PR)
        return _failure_result(str(e))

    except Exception as e:
        logger.error("PR creation agent unexpected error: %s", e)
        if task_logger:
            task_logger.log_error(f"Unexpected error: {e}", LogPhase.PR)
        return _failure_result(f"Unexpected error: {e}")


def main():
    """CLI entry point for the PR creation runner."""
    import argparse

    parser = argparse.ArgumentParser(
        description="AI-powered PR creation agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--project",
        type=Path,
        default=Path.cwd(),
        help="Project directory (default: current directory)",
    )
    parser.add_argument(
        "--spec-dir",
        type=Path,
        required=True,
        help="Path to the spec directory",
    )
    parser.add_argument(
        "--spec-name",
        type=str,
        required=True,
        help="Spec name (e.g., '114-implement-feature')",
    )
    parser.add_argument(
        "--target-branch",
        type=str,
        default="main",
        help="Target branch for the PR (default: main)",
    )
    parser.add_argument(
        "--title",
        type=str,
        default=None,
        help="PR title (optional, auto-generated if not provided)",
    )
    parser.add_argument(
        "--draft",
        action="store_true",
        help="Create as draft PR",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model override (haiku, sonnet, opus, or full model ID)",
    )
    parser.add_argument(
        "--thinking-level",
        type=str,
        default=None,
        help="Thinking level override (low, medium, high, max)",
    )

    args = parser.parse_args()

    # Validate project directory
    project_dir = args.project.resolve()
    if not project_dir.exists():
        result = _failure_result(f"Project directory not found: {project_dir}")
        print(json.dumps(result))
        sys.exit(1)

    # Validate spec directory
    spec_dir = args.spec_dir.resolve()
    if not spec_dir.exists():
        result = _failure_result(f"Spec directory not found: {spec_dir}")
        print(json.dumps(result))
        sys.exit(1)

    try:
        result = asyncio.run(
            run_pr_creation_agent(
                project_dir=project_dir,
                spec_dir=spec_dir,
                spec_name=args.spec_name,
                target_branch=args.target_branch,
                title=args.title,
                draft=args.draft,
                cli_model=args.model,
                cli_thinking=args.thinking_level,
            )
        )
        # Print JSON result to stdout (critical for frontend parsing)
        print(json.dumps(result))
        sys.exit(0 if result.get("success") else 1)
    except KeyboardInterrupt:
        result = _failure_result("PR creation interrupted by user")
        print(json.dumps(result))
        sys.exit(1)
    except Exception as e:
        result = _failure_result(f"Fatal error: {e}")
        print(json.dumps(result))
        sys.exit(1)


if __name__ == "__main__":
    main()
