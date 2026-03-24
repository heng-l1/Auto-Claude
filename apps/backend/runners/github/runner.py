#!/usr/bin/env python3
"""
GitHub Automation Runner
========================

CLI interface for GitHub automation features:
- PR Review: AI-powered code review
- Issue Triage: Classification, duplicate/spam detection
- Issue Auto-Fix: Automatic spec creation from issues
- Issue Batching: Group similar issues and create combined specs

Usage:
    # Review a specific PR
    python runner.py review-pr 123

    # Triage all open issues
    python runner.py triage --apply-labels

    # Triage specific issues
    python runner.py triage 1 2 3

    # Start auto-fix for an issue
    python runner.py auto-fix 456

    # Check for issues with auto-fix labels
    python runner.py check-auto-fix-labels

    # Show auto-fix queue
    python runner.py queue

    # Batch similar issues and create combined specs
    python runner.py batch-issues

    # Batch specific issues
    python runner.py batch-issues 1 2 3 4 5

    # Show batch status
    python runner.py batch-status
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

# Fix Windows console encoding for Unicode output (emojis, special chars)
if sys.platform == "win32":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Add backend to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

# Validate platform-specific dependencies BEFORE any imports that might
# trigger graphiti_core -> real_ladybug -> pywintypes import chain (ACS-253)
from core.dependency_validator import validate_platform_dependencies

validate_platform_dependencies()

# Load .env file with centralized error handling
from cli.utils import import_dotenv

load_dotenv = import_dotenv()

env_file = Path(__file__).parent.parent.parent / ".env"
if env_file.exists():
    load_dotenv(env_file)

# Initialize Sentry early to capture any startup errors
from core.sentry import capture_exception, init_sentry, set_context

init_sentry(component="github-runner")

from debug import debug_error
from phase_config import sanitize_thinking_level

# Add github runner directory to path for direct imports
sys.path.insert(0, str(Path(__file__).parent))

# Now import models and orchestrator directly (they use relative imports internally)
from models import GitHubRunnerConfig
from orchestrator import GitHubOrchestrator, ProgressCallback
from services.io_utils import safe_print


def print_progress(callback: ProgressCallback) -> None:
    """Print progress updates to console."""
    prefix = ""
    if callback.pr_number:
        prefix = f"[PR #{callback.pr_number}] "
    elif callback.issue_number:
        prefix = f"[Issue #{callback.issue_number}] "

    safe_print(f"{prefix}[{callback.progress:3d}%] {callback.message}")


def get_config(args) -> GitHubRunnerConfig:
    """Build config from CLI args and environment."""
    import subprocess

    from core.gh_executable import get_gh_executable

    token = args.token or os.environ.get("GITHUB_TOKEN", "")
    bot_token = args.bot_token or os.environ.get("GITHUB_BOT_TOKEN")

    # Repo detection priority:
    # 1. Explicit --repo flag (highest priority)
    # 2. Auto-detect from project's git remote (primary for multi-project setups)
    # 3. GITHUB_REPO env var (fallback only)
    repo = args.repo  # Only use explicit CLI flag initially

    # Find gh CLI - use get_gh_executable for cross-platform support
    gh_path = get_gh_executable()

    if os.environ.get("DEBUG"):
        safe_print(f"[DEBUG] gh CLI path: {gh_path}")
        safe_print(
            f"[DEBUG] PATH env: {os.environ.get('PATH', 'NOT SET')[:200]}...",
            flush=True,
        )

    if not token and gh_path:
        # Try to get from gh CLI
        try:
            result = subprocess.run(
                [gh_path, "auth", "token"],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                token = result.stdout.strip()
        except FileNotFoundError:
            pass  # gh not installed or not in PATH

    # Auto-detect repo from project's git remote (takes priority over env var)
    if not repo and gh_path:
        try:
            result = subprocess.run(
                [
                    gh_path,
                    "repo",
                    "view",
                    "--json",
                    "nameWithOwner",
                    "-q",
                    ".nameWithOwner",
                ],
                cwd=args.project,
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                repo = result.stdout.strip()
            elif os.environ.get("DEBUG"):
                safe_print(f"[DEBUG] gh repo view failed: {result.stderr}")
        except FileNotFoundError:
            pass  # gh not installed or not in PATH

    # Fall back to environment variable only if auto-detection failed
    if not repo:
        repo = os.environ.get("GITHUB_REPO", "")

    if not token:
        safe_print(
            "Error: No GitHub token found. Set GITHUB_TOKEN or run 'gh auth login'"
        )
        sys.exit(1)

    if not repo:
        safe_print(
            "Error: No GitHub repo found. Set GITHUB_REPO or run from a git repo."
        )
        sys.exit(1)

    return GitHubRunnerConfig(
        token=token,
        repo=repo,
        bot_token=bot_token,
        model=args.model,
        thinking_level=args.thinking_level,
        fast_mode=getattr(args, "fast_mode", False),
        auto_fix_enabled=getattr(args, "auto_fix_enabled", False),
        auto_fix_labels=getattr(args, "auto_fix_labels", ["auto-fix"]),
        auto_post_reviews=getattr(args, "auto_post", False),
    )


async def cmd_review_pr(args) -> int:
    """Review a pull request."""
    import sys

    # Force unbuffered output so Electron sees it in real-time
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(line_buffering=True)

    debug = os.environ.get("DEBUG")
    if debug:
        safe_print(f"[DEBUG] Starting PR review for PR #{args.pr_number}")
        safe_print(f"[DEBUG] Project directory: {args.project}")
        safe_print("[DEBUG] Building config...")

    config = get_config(args)

    if debug:
        safe_print(
            f"[DEBUG] Config built: repo={config.repo}, model={config.model}",
            flush=True,
        )
        safe_print("[DEBUG] Creating orchestrator...")

    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    if debug:
        safe_print("[DEBUG] Orchestrator created")
        safe_print(
            f"[DEBUG] Calling orchestrator.review_pr({args.pr_number})...", flush=True
        )

    # Read reviewer notes from file if provided
    reviewer_notes = None
    notes_file = getattr(args, "notes_file", None)
    if notes_file:
        try:
            reviewer_notes = Path(notes_file).read_text(encoding="utf-8").strip()
            if not reviewer_notes:
                reviewer_notes = None
            elif debug:
                safe_print(f"[DEBUG] Loaded reviewer notes from {notes_file} ({len(reviewer_notes)} chars)")
        except (FileNotFoundError, PermissionError, UnicodeDecodeError) as e:
            safe_print(f"Warning: Could not read notes file '{notes_file}': {e}")

    # Pass force_review flag if --force was specified
    force_review = getattr(args, "force", False)
    result = await orchestrator.review_pr(args.pr_number, force_review=force_review, reviewer_notes=reviewer_notes)

    if debug:
        safe_print(f"[DEBUG] review_pr returned, success={result.success}")

    if result.success:
        # For in_progress results (not saved to disk), output JSON so the frontend
        # can parse it from stdout instead of relying on the disk file.
        if result.overall_status == "in_progress":
            safe_print(f"__RESULT_JSON__:{json.dumps(result.to_dict())}")
            return 0

        safe_print(f"\n{'=' * 60}")
        safe_print(f"PR #{result.pr_number} Review Complete")
        safe_print(f"{'=' * 60}")
        safe_print(f"Status: {result.overall_status}")
        safe_print(f"Summary: {result.summary}")
        safe_print(f"Findings: {len(result.findings)}")

        if result.findings:
            safe_print("\nFindings by severity:")
            for f in result.findings:
                emoji = {"critical": "!", "high": "*", "medium": "-", "low": "."}
                safe_print(
                    f"  {emoji.get(f.severity.value, '?')} [{f.severity.value.upper()}] {f.title}"
                )
                safe_print(f"    File: {f.file}:{f.line}")
        return 0
    else:
        safe_print(f"\nReview failed: {result.error}")
        return 1


async def cmd_followup_review_pr(args) -> int:
    """Perform a follow-up review of a pull request."""
    import sys

    # Force unbuffered output so Electron sees it in real-time
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(line_buffering=True)

    debug = os.environ.get("DEBUG")
    if debug:
        safe_print(f"[DEBUG] Starting follow-up review for PR #{args.pr_number}")
        safe_print(f"[DEBUG] Project directory: {args.project}")
        safe_print("[DEBUG] Building config...")

    config = get_config(args)

    if debug:
        safe_print(
            f"[DEBUG] Config built: repo={config.repo}, model={config.model}",
            flush=True,
        )
        safe_print("[DEBUG] Creating orchestrator...")

    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    if debug:
        safe_print("[DEBUG] Orchestrator created")
        safe_print(
            f"[DEBUG] Calling orchestrator.followup_review_pr({args.pr_number})...",
            flush=True,
        )

    try:
        result = await orchestrator.followup_review_pr(args.pr_number)
    except ValueError as e:
        safe_print(f"\nFollow-up review failed: {e}")
        return 1

    if debug:
        safe_print(
            f"[DEBUG] followup_review_pr returned, success={result.success}", flush=True
        )

    if result.success:
        safe_print(f"\n{'=' * 60}")
        safe_print(f"PR #{result.pr_number} Follow-up Review Complete")
        safe_print(f"{'=' * 60}")
        safe_print(f"Status: {result.overall_status}")
        safe_print(f"Is Follow-up: {result.is_followup_review}")

        if result.resolved_findings:
            safe_print(f"Resolved: {len(result.resolved_findings)} finding(s)")
        if result.unresolved_findings:
            safe_print(f"Still Open: {len(result.unresolved_findings)} finding(s)")
        if result.new_findings_since_last_review:
            safe_print(
                f"New Issues: {len(result.new_findings_since_last_review)} finding(s)"
            )

        safe_print(f"\nSummary:\n{result.summary}")

        if result.findings:
            safe_print("\nRemaining Findings:")
            for f in result.findings:
                emoji = {"critical": "!", "high": "*", "medium": "-", "low": "."}
                safe_print(
                    f"  {emoji.get(f.severity.value, '?')} [{f.severity.value.upper()}] {f.title}"
                )
                safe_print(f"    File: {f.file}:{f.line}")
        return 0
    else:
        safe_print(f"\nFollow-up review failed: {result.error}")
        return 1


async def cmd_triage(args) -> int:
    """Triage issues."""
    config = get_config(args)
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    issue_numbers = args.issues if args.issues else None
    results = await orchestrator.triage_issues(
        issue_numbers=issue_numbers,
        apply_labels=args.apply_labels,
    )

    safe_print(f"\n{'=' * 60}")
    safe_print(f"Triaged {len(results)} issues")
    safe_print(f"{'=' * 60}")

    for r in results:
        flags = []
        if r.is_duplicate:
            flags.append(f"DUP of #{r.duplicate_of}")
        if r.is_spam:
            flags.append("SPAM")
        if r.is_feature_creep:
            flags.append("CREEP")

        flag_str = f" [{', '.join(flags)}]" if flags else ""
        safe_print(
            f"  #{r.issue_number}: {r.category.value} (confidence: {r.confidence:.0%}){flag_str}"
        )

        if r.labels_to_add:
            safe_print(f"    + Labels: {', '.join(r.labels_to_add)}")

    return 0


async def cmd_auto_fix(args) -> int:
    """Start auto-fix for an issue."""
    config = get_config(args)
    config.auto_fix_enabled = True
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    state = await orchestrator.auto_fix_issue(args.issue_number)

    safe_print(f"\n{'=' * 60}")
    safe_print(f"Auto-Fix State for Issue #{state.issue_number}")
    safe_print(f"{'=' * 60}")
    safe_print(f"Status: {state.status.value}")
    if state.spec_id:
        safe_print(f"Spec ID: {state.spec_id}")
    if state.pr_number:
        safe_print(f"PR: #{state.pr_number}")
    if state.error:
        safe_print(f"Error: {state.error}")

    return 0


async def cmd_check_labels(args) -> int:
    """Check for issues with auto-fix labels."""
    config = get_config(args)
    config.auto_fix_enabled = True
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    issues = await orchestrator.check_auto_fix_labels()

    if issues:
        safe_print(f"Found {len(issues)} issues with auto-fix labels:")
        for num in issues:
            safe_print(f"  #{num}")
    else:
        safe_print("No issues with auto-fix labels found.")

    return 0


async def cmd_check_new(args) -> int:
    """Check for new issues not yet in the auto-fix queue."""
    config = get_config(args)
    config.auto_fix_enabled = True
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    issues = await orchestrator.check_new_issues()

    safe_print("JSON Output")
    safe_print(json.dumps(issues))

    return 0


async def cmd_queue(args) -> int:
    """Show auto-fix queue."""
    config = get_config(args)
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
    )

    queue = await orchestrator.get_auto_fix_queue()

    safe_print(f"\n{'=' * 60}")
    safe_print(f"Auto-Fix Queue ({len(queue)} items)")
    safe_print(f"{'=' * 60}")

    if not queue:
        safe_print("Queue is empty.")
        return 0

    for state in queue:
        status_emoji = {
            "pending": "...",
            "analyzing": "...",
            "creating_spec": "...",
            "building": "...",
            "qa_review": "...",
            "pr_created": "+++",
            "completed": "OK",
            "failed": "ERR",
        }
        emoji = status_emoji.get(state.status.value, "???")
        safe_print(f"  [{emoji}] #{state.issue_number}: {state.status.value}")
        if state.pr_number:
            safe_print(f"       PR: #{state.pr_number}")
        if state.error:
            safe_print(f"       Error: {state.error[:50]}...")

    return 0


async def cmd_batch_issues(args) -> int:
    """Batch similar issues and create combined specs."""
    config = get_config(args)
    config.auto_fix_enabled = True
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    issue_numbers = args.issues if args.issues else None
    batches = await orchestrator.batch_and_fix_issues(issue_numbers)

    safe_print(f"\n{'=' * 60}")
    safe_print(f"Created {len(batches)} batches from similar issues")
    safe_print(f"{'=' * 60}")

    if not batches:
        safe_print(
            "No batches created. Either no issues found or all issues are unique."
        )
        return 0

    for batch in batches:
        issue_nums = ", ".join(f"#{i.issue_number}" for i in batch.issues)
        safe_print(f"\n  Batch: {batch.batch_id}")
        safe_print(f"    Issues: {issue_nums}")
        safe_print(f"    Theme: {batch.theme}")
        safe_print(f"    Status: {batch.status.value}")
        if batch.spec_id:
            safe_print(f"    Spec: {batch.spec_id}")

    return 0


async def cmd_batch_status(args) -> int:
    """Show batch status."""
    config = get_config(args)
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
    )

    status = await orchestrator.get_batch_status()

    safe_print(f"\n{'=' * 60}")
    safe_print("Batch Status")
    safe_print(f"{'=' * 60}")
    safe_print(f"Total batches: {status.get('total_batches', 0)}")
    safe_print(f"Pending: {status.get('pending', 0)}")
    safe_print(f"Processing: {status.get('processing', 0)}")
    safe_print(f"Completed: {status.get('completed', 0)}")
    safe_print(f"Failed: {status.get('failed', 0)}")

    return 0


async def cmd_analyze_preview(args) -> int:
    """
    Analyze issues and preview proposed batches without executing.

    This is the "proactive" workflow for reviewing issue groupings before action.
    """
    import json

    config = get_config(args)
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    issue_numbers = args.issues if args.issues else None
    max_issues = getattr(args, "max_issues", 200)

    result = await orchestrator.analyze_issues_preview(
        issue_numbers=issue_numbers,
        max_issues=max_issues,
    )

    if not result.get("success"):
        safe_print(f"Error: {result.get('error', 'Unknown error')}")
        return 1

    safe_print(f"\n{'=' * 60}")
    safe_print("Issue Analysis Preview")
    safe_print(f"{'=' * 60}")
    safe_print(f"Total issues: {result.get('total_issues', 0)}")
    safe_print(f"Analyzed: {result.get('analyzed_issues', 0)}")
    safe_print(f"Already batched: {result.get('already_batched', 0)}")
    safe_print(f"Proposed batches: {len(result.get('proposed_batches', []))}")
    safe_print(f"Single issues: {len(result.get('single_issues', []))}")

    proposed_batches = result.get("proposed_batches", [])
    if proposed_batches:
        safe_print(f"\n{'=' * 60}")
        safe_print("Proposed Batches (for human review)")
        safe_print(f"{'=' * 60}")

        for i, batch in enumerate(proposed_batches, 1):
            confidence = batch.get("confidence", 0)
            validated = "" if batch.get("validated") else "[NEEDS REVIEW] "
            safe_print(
                f"\n  Batch {i}: {validated}{batch.get('theme', 'No theme')} ({confidence:.0%} confidence)"
            )
            safe_print(f"    Primary issue: #{batch.get('primary_issue')}")
            safe_print(f"    Issue count: {batch.get('issue_count', 0)}")
            safe_print(f"    Reasoning: {batch.get('reasoning', 'N/A')}")
            safe_print("    Issues:")
            for item in batch.get("issues", []):
                similarity = item.get("similarity_to_primary", 0)
                safe_print(
                    f"      - #{item['issue_number']}: {item.get('title', '?')} ({similarity:.0%})"
                )

    # Output JSON for programmatic use
    if getattr(args, "json", False):
        safe_print(f"\n{'=' * 60}")
        safe_print("JSON Output")
        safe_print(f"{'=' * 60}")
        # Print JSON on single line to avoid corruption from line-by-line stdout prefixes
        safe_print(json.dumps(result))

    return 0


async def cmd_resolve_conflicts(args) -> int:
    """Resolve PR merge conflicts with AI."""
    import subprocess

    from core.git_executable import get_isolated_git_env
    from core.workspace import _run_parallel_merges, _try_simple_3way_merge
    from core.workspace.git_utils import is_binary_file, is_lock_file
    from core.workspace.models import ParallelMergeResult, ParallelMergeTask
    from gh_client import GHClient
    from merge.progress import MergeProgressStage, emit_progress
    from services.pr_worktree_manager import PRWorktreeManager

    # Force unbuffered output so Electron sees it in real-time
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(line_buffering=True)

    config = get_config(args)
    pr_number = args.pr_number

    emit_progress(MergeProgressStage.ANALYZING, 5, "Fetching PR metadata...")

    # Create GH client and fetch PR metadata
    gh_client = GHClient(
        project_dir=args.project,
        default_timeout=30.0,
        repo=config.repo,
    )
    pr_data = await gh_client.pr_get(
        pr_number,
        json_fields=["headRefName", "baseRefName", "headRefOid"],
    )

    head_ref = pr_data["headRefName"]
    base_ref = pr_data["baseRefName"]
    head_oid = pr_data["headRefOid"]

    emit_progress(MergeProgressStage.ANALYZING, 10, "Creating worktree...")

    # Create worktree at headRefOid
    worktree_manager = PRWorktreeManager(
        project_dir=args.project,
        worktree_dir=".auto-claude/worktrees/pr-conflicts",
    )
    worktree_path = worktree_manager.create_worktree(head_oid, pr_number)

    env = get_isolated_git_env()

    try:
        # Fetch base branch in worktree
        emit_progress(MergeProgressStage.ANALYZING, 15, f"Fetching base branch {base_ref}...")
        subprocess.run(
            ["git", "fetch", "origin", base_ref],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

        # Attempt merge
        emit_progress(MergeProgressStage.DETECTING_CONFLICTS, 25, f"Merging origin/{base_ref}...")
        merge_result = subprocess.run(
            ["git", "merge", f"origin/{base_ref}", "--no-edit"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

        # Clean merge - commit and push
        if merge_result.returncode == 0:
            emit_progress(MergeProgressStage.VALIDATING, 90, "Clean merge, pushing...")
            push_result = subprocess.run(
                ["git", "push", "origin", f"HEAD:{head_ref}"],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
            if push_result.returncode != 0:
                # Retry with --force-with-lease
                push_result = subprocess.run(
                    ["git", "push", "--force-with-lease", "origin", f"HEAD:{head_ref}"],
                    cwd=worktree_path,
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env=env,
                )
                if push_result.returncode != 0:
                    result = {
                        "success": False,
                        "error": f"Push failed: {push_result.stderr.strip()}",
                        "filesResolved": [],
                        "filesUnresolved": [],
                        "autoMerged": 0,
                        "aiMerged": 0,
                    }
                    safe_print(f"__RESULT_JSON__:{json.dumps(result)}")
                    return 1

            result = {
                "success": True,
                "filesResolved": [],
                "filesUnresolved": [],
                "autoMerged": 0,
                "aiMerged": 0,
            }
            emit_progress(MergeProgressStage.COMPLETE, 100, "Clean merge completed")
            safe_print(f"__RESULT_JSON__:{json.dumps(result)}")
            return 0

        # Conflicts detected - get list of conflicting files
        emit_progress(MergeProgressStage.DETECTING_CONFLICTS, 30, "Detecting conflicts...")
        diff_result = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=U"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        conflicting_files = [f for f in diff_result.stdout.strip().split("\n") if f]

        if not conflicting_files:
            # Merge failed but no conflicts detected - unexpected
            result = {
                "success": False,
                "error": f"Merge failed: {merge_result.stderr.strip()}",
                "filesResolved": [],
                "filesUnresolved": [],
                "autoMerged": 0,
                "aiMerged": 0,
            }
            safe_print(f"__RESULT_JSON__:{json.dumps(result)}")
            return 1

        emit_progress(
            MergeProgressStage.DETECTING_CONFLICTS,
            35,
            f"Found {len(conflicting_files)} conflicting files",
            details={"conflicts_found": len(conflicting_files)},
        )

        # Get merge-base SHA
        merge_base_result = subprocess.run(
            ["git", "merge-base", "HEAD", f"origin/{base_ref}"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        merge_base_sha = merge_base_result.stdout.strip()

        resolved_files: list[str] = []
        unresolved_files: list[str] = []
        auto_merged_count = 0
        ai_merged_count = 0

        # Categorize and resolve files
        text_files_to_resolve: list[tuple[str, str, str, str]] = []  # (file, base, ours, theirs)

        emit_progress(MergeProgressStage.RESOLVING, 40, "Categorizing conflicts...")

        for file_path in conflicting_files:
            # Binary files -> unresolved
            if is_binary_file(file_path):
                unresolved_files.append(file_path)
                continue

            # Lock files -> take theirs (base branch version)
            if is_lock_file(file_path):
                try:
                    theirs_result = subprocess.run(
                        ["git", "show", f"origin/{base_ref}:{file_path}"],
                        cwd=worktree_path,
                        capture_output=True,
                        text=True,
                        timeout=30,
                        env=env,
                    )
                    if theirs_result.returncode == 0:
                        (worktree_path / file_path).write_text(
                            theirs_result.stdout, encoding="utf-8"
                        )
                        resolved_files.append(file_path)
                        auto_merged_count += 1
                    else:
                        unresolved_files.append(file_path)
                except Exception:
                    unresolved_files.append(file_path)
                continue

            # Text file - get all three versions for 3-way merge
            try:
                base_result = subprocess.run(
                    ["git", "show", f"{merge_base_sha}:{file_path}"],
                    cwd=worktree_path,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=env,
                )
                ours_result = subprocess.run(
                    ["git", "show", f"HEAD:{file_path}"],
                    cwd=worktree_path,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=env,
                )
                theirs_result = subprocess.run(
                    ["git", "show", f"origin/{base_ref}:{file_path}"],
                    cwd=worktree_path,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    env=env,
                )

                base_content = base_result.stdout if base_result.returncode == 0 else None
                ours_content = ours_result.stdout if ours_result.returncode == 0 else ""
                theirs_content = theirs_result.stdout if theirs_result.returncode == 0 else ""

                text_files_to_resolve.append(
                    (file_path, base_content, ours_content, theirs_content)
                )
            except Exception:
                unresolved_files.append(file_path)

        # First pass: simple 3-way merge
        emit_progress(MergeProgressStage.RESOLVING, 50, "Attempting simple 3-way merges...")
        ai_merge_needed: list[tuple[str, str | None, str, str]] = []

        for file_path, base_content, ours_content, theirs_content in text_files_to_resolve:
            success, merged_content = _try_simple_3way_merge(
                base_content, ours_content, theirs_content
            )
            if success and merged_content is not None:
                (worktree_path / file_path).parent.mkdir(parents=True, exist_ok=True)
                (worktree_path / file_path).write_text(
                    merged_content, encoding="utf-8"
                )
                resolved_files.append(file_path)
                auto_merged_count += 1
            else:
                ai_merge_needed.append(
                    (file_path, base_content, ours_content, theirs_content)
                )

        # Second pass: AI merge for remaining files
        if ai_merge_needed:
            emit_progress(
                MergeProgressStage.RESOLVING,
                60,
                f"Running AI merge on {len(ai_merge_needed)} files...",
                details={"conflicts_resolved": auto_merged_count},
            )

            merge_tasks = [
                ParallelMergeTask(
                    file_path=fp,
                    main_content=ours,
                    worktree_content=theirs,
                    base_content=base,
                    spec_name="pr-conflict-resolution",
                    project_dir=worktree_path,
                )
                for fp, base, ours, theirs in ai_merge_needed
            ]

            ai_results: list[ParallelMergeResult] = await _run_parallel_merges(
                merge_tasks, worktree_path
            )

            for ai_result in ai_results:
                if ai_result.success and ai_result.merged_content is not None:
                    file_full_path = worktree_path / ai_result.file_path
                    file_full_path.parent.mkdir(parents=True, exist_ok=True)
                    file_full_path.write_text(
                        ai_result.merged_content, encoding="utf-8"
                    )
                    resolved_files.append(ai_result.file_path)
                    ai_merged_count += 1
                else:
                    unresolved_files.append(ai_result.file_path)

        emit_progress(
            MergeProgressStage.VALIDATING,
            80,
            f"Resolved {len(resolved_files)} files, {len(unresolved_files)} unresolved",
            details={
                "conflicts_resolved": len(resolved_files),
                "conflicts_found": len(conflicting_files),
            },
        )

        # If unresolved files remain, abort
        if unresolved_files:
            subprocess.run(
                ["git", "merge", "--abort"],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=30,
                env=env,
            )
            result = {
                "success": False,
                "error": f"Could not resolve {len(unresolved_files)} files",
                "filesResolved": resolved_files,
                "filesUnresolved": unresolved_files,
                "autoMerged": auto_merged_count,
                "aiMerged": ai_merged_count,
            }
            emit_progress(
                MergeProgressStage.ERROR,
                80,
                f"Failed: {len(unresolved_files)} files could not be resolved",
            )
            safe_print(f"__RESULT_JSON__:{json.dumps(result)}")
            return 1

        # All resolved - stage, commit, and push
        emit_progress(MergeProgressStage.VALIDATING, 85, "Committing resolved files...")
        subprocess.run(
            ["git", "add", "."],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        subprocess.run(
            ["git", "commit", "-m", "Resolve merge conflicts with AI"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )

        emit_progress(MergeProgressStage.VALIDATING, 90, "Pushing resolved conflicts...")
        push_result = subprocess.run(
            ["git", "push", "origin", f"HEAD:{head_ref}"],
            cwd=worktree_path,
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

        if push_result.returncode != 0:
            # Retry with --force-with-lease
            push_result = subprocess.run(
                ["git", "push", "--force-with-lease", "origin", f"HEAD:{head_ref}"],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                timeout=120,
                env=env,
            )
            if push_result.returncode != 0:
                result = {
                    "success": False,
                    "error": f"Push failed: {push_result.stderr.strip()}",
                    "filesResolved": resolved_files,
                    "filesUnresolved": unresolved_files,
                    "autoMerged": auto_merged_count,
                    "aiMerged": ai_merged_count,
                }
                safe_print(f"__RESULT_JSON__:{json.dumps(result)}")
                return 1

        result = {
            "success": True,
            "filesResolved": resolved_files,
            "filesUnresolved": [],
            "autoMerged": auto_merged_count,
            "aiMerged": ai_merged_count,
        }
        emit_progress(MergeProgressStage.COMPLETE, 100, "Conflicts resolved successfully")
        safe_print(f"__RESULT_JSON__:{json.dumps(result)}")
        return 0

    finally:
        # Always cleanup worktree
        worktree_manager.remove_worktree(worktree_path)


async def cmd_approve_batches(args) -> int:
    """
    Approve and execute batches from a JSON file.

    Usage: runner.py approve-batches approved_batches.json
    """
    import json

    config = get_config(args)
    orchestrator = GitHubOrchestrator(
        project_dir=args.project,
        config=config,
        progress_callback=print_progress,
    )

    # Load approved batches from file
    try:
        with open(args.batch_file, encoding="utf-8") as f:
            approved_batches = json.load(f)
    except (json.JSONDecodeError, FileNotFoundError, UnicodeDecodeError) as e:
        safe_print(f"Error loading batch file: {e}")
        return 1

    if not approved_batches:
        safe_print("No batches in file to approve.")
        return 0

    safe_print(f"Approving and executing {len(approved_batches)} batches...")

    created_batches = await orchestrator.approve_and_execute_batches(approved_batches)

    safe_print(f"\n{'=' * 60}")
    safe_print(f"Created {len(created_batches)} batches")
    safe_print(f"{'=' * 60}")

    for batch in created_batches:
        issue_nums = ", ".join(f"#{i.issue_number}" for i in batch.issues)
        safe_print(f"  {batch.batch_id}: {issue_nums}")

    return 0


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="GitHub automation CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Global options
    parser.add_argument(
        "--project",
        type=Path,
        default=Path.cwd(),
        help="Project directory (default: current)",
    )
    parser.add_argument(
        "--token",
        type=str,
        help="GitHub token (or set GITHUB_TOKEN)",
    )
    parser.add_argument(
        "--bot-token",
        type=str,
        help="Bot account token for comments (optional)",
    )
    parser.add_argument(
        "--repo",
        type=str,
        help="GitHub repo (owner/name) or auto-detect",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="claude-sonnet-4-5-20250929",
        help="AI model to use",
    )
    parser.add_argument(
        "--thinking-level",
        type=str,
        default="medium",
        help="Thinking level for extended reasoning (low, medium, high)",
    )
    parser.add_argument(
        "--fast-mode",
        action="store_true",
        help="Enable Fast Mode for faster Opus 4.6 output",
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # review-pr command
    review_parser = subparsers.add_parser("review-pr", help="Review a pull request")
    review_parser.add_argument("pr_number", type=int, help="PR number to review")
    review_parser.add_argument(
        "--auto-post",
        action="store_true",
        help="Automatically post review to GitHub",
    )
    review_parser.add_argument(
        "--force",
        action="store_true",
        help="Force a new review even if commit was already reviewed",
    )
    review_parser.add_argument(
        "--notes-file",
        type=str,
        default=None,
        help="Path to a file containing reviewer notes to inject into the review",
    )

    # followup-review-pr command
    followup_parser = subparsers.add_parser(
        "followup-review-pr",
        help="Follow-up review of a PR (after contributor changes)",
    )
    followup_parser.add_argument("pr_number", type=int, help="PR number to review")

    # triage command
    triage_parser = subparsers.add_parser("triage", help="Triage issues")
    triage_parser.add_argument(
        "issues",
        type=int,
        nargs="*",
        help="Specific issue numbers (or all open if none)",
    )
    triage_parser.add_argument(
        "--apply-labels",
        action="store_true",
        help="Apply suggested labels to GitHub",
    )

    # auto-fix command
    autofix_parser = subparsers.add_parser("auto-fix", help="Start auto-fix for issue")
    autofix_parser.add_argument("issue_number", type=int, help="Issue number to fix")

    # check-auto-fix-labels command
    subparsers.add_parser(
        "check-auto-fix-labels", help="Check for issues with auto-fix labels"
    )

    # check-new command
    subparsers.add_parser(
        "check-new", help="Check for new issues not yet in auto-fix queue"
    )

    # queue command
    subparsers.add_parser("queue", help="Show auto-fix queue")

    # batch-issues command
    batch_parser = subparsers.add_parser(
        "batch-issues", help="Batch similar issues and create combined specs"
    )
    batch_parser.add_argument(
        "issues",
        type=int,
        nargs="*",
        help="Specific issue numbers (or all open if none)",
    )

    # batch-status command
    subparsers.add_parser("batch-status", help="Show batch status")

    # analyze-preview command (proactive workflow)
    analyze_parser = subparsers.add_parser(
        "analyze-preview",
        help="Analyze issues and preview proposed batches without executing",
    )
    analyze_parser.add_argument(
        "issues",
        type=int,
        nargs="*",
        help="Specific issue numbers (or all open if none)",
    )
    analyze_parser.add_argument(
        "--max-issues",
        type=int,
        default=200,
        help="Maximum number of issues to analyze (default: 200)",
    )
    analyze_parser.add_argument(
        "--json",
        action="store_true",
        help="Output JSON for programmatic use",
    )

    # approve-batches command
    approve_parser = subparsers.add_parser(
        "approve-batches",
        help="Approve and execute batches from a JSON file",
    )
    approve_parser.add_argument(
        "batch_file",
        type=Path,
        help="JSON file containing approved batches",
    )

    # resolve-conflicts command
    resolve_parser = subparsers.add_parser(
        "resolve-conflicts", help="Resolve PR merge conflicts with AI"
    )
    resolve_parser.add_argument("pr_number", type=int, help="PR number to resolve conflicts for")

    args = parser.parse_args()

    # Validate and sanitize thinking level (handles legacy values like 'ultrathink')
    args.thinking_level = sanitize_thinking_level(args.thinking_level)

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Route to command handler
    commands = {
        "review-pr": cmd_review_pr,
        "followup-review-pr": cmd_followup_review_pr,
        "triage": cmd_triage,
        "auto-fix": cmd_auto_fix,
        "check-auto-fix-labels": cmd_check_labels,
        "check-new": cmd_check_new,
        "queue": cmd_queue,
        "batch-issues": cmd_batch_issues,
        "batch-status": cmd_batch_status,
        "analyze-preview": cmd_analyze_preview,
        "approve-batches": cmd_approve_batches,
        "resolve-conflicts": cmd_resolve_conflicts,
    }

    handler = commands.get(args.command)
    if not handler:
        safe_print(f"Unknown command: {args.command}")
        sys.exit(1)

    try:
        # Set context for Sentry
        set_context(
            "command",
            {
                "name": args.command,
                "project": str(args.project),
                "repo": args.repo or "auto-detect",
            },
        )

        exit_code = asyncio.run(handler(args))
        sys.exit(exit_code)
    except KeyboardInterrupt:
        safe_print("\nInterrupted.")
        sys.exit(1)
    except Exception as e:
        import traceback

        # Capture exception with Sentry
        capture_exception(e, command=args.command)

        debug_error("github_runner", "Command failed", error=str(e))
        safe_print(f"Error: {e}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
