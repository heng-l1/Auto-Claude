#!/usr/bin/env python3
"""
PR Reply Runner
===============

Standalone CLI runner for generating AI reply drafts to PR review comment threads.
Receives unresolved thread data via stdin as JSON, queries Graphiti memory for
context, generates replies via Claude with MCP access, and streams results back
to the Electron frontend via structured stdout prefixes.

Usage:
    # Pipe thread data via stdin
    echo '[{"id": "thread1", ...}]' | python pr_reply_runner.py \\
        --repo owner/repo \\
        --pr 123 \\
        --project /path/to/project \\
        --model claude-sonnet-4-5-20250929 \\
        --thinking medium

Output protocol:
    __REPLY_CHUNK__:{"threadId": "...", "content": "...", "status": "...", "classification": "..."}
    __REPLY_COMPLETE__
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
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
from core.sentry import capture_exception, init_sentry

init_sentry(component="pr-reply-runner")

from phase_config import get_model_betas, resolve_model_id, sanitize_thinking_level

# Add github runner directory to path for direct imports
sys.path.insert(0, str(Path(__file__).parent))

from memory_integration import GitHubMemoryIntegration
from services.io_utils import safe_print


def _build_thread_prompt(thread: dict, memory_section: str) -> str:
    """
    Build a prompt for generating a reply to a single review thread.

    Args:
        thread: Thread data dict with id, path, line, diffHunk, comments.
        memory_section: Pre-formatted memory context string from Graphiti.

    Returns:
        Formatted prompt string for the AI model.
    """
    thread_id = thread.get("id", "unknown")
    file_path = thread.get("path", "unknown file")
    line = thread.get("line")
    diff_hunk = thread.get("diffHunk", "")
    comments = thread.get("comments", [])

    # Format the comment history
    comment_history = []
    for comment in comments:
        author = comment.get("author", {})
        author_login = author.get("login", "unknown") if author else "Ghost"
        body = comment.get("body", "")
        is_author = comment.get("isAuthor", False)
        role = "PR Author" if is_author else "Reviewer"
        comment_history.append(f"**{author_login}** ({role}):\n{body}")

    comments_str = "\n\n---\n\n".join(comment_history)

    # Build the location context
    location = f"`{file_path}`"
    if line:
        location += f" (line {line})"

    # Build the diff context section
    diff_section = ""
    if diff_hunk:
        diff_section = f"""
## Code Context (Diff Hunk)

```diff
{diff_hunk}
```
"""

    prompt = f"""You are responding to a review comment thread on a pull request.
Your goal is to draft a helpful, concise reply as the PR author.

## Thread Location

{location}

{diff_section}

## Comment Thread

{comments_str}

{memory_section}

## Instructions

1. Read the reviewer's feedback carefully and understand what they are asking for.
2. Draft a concise, professional reply as the PR author.
3. If the reviewer points out a clear bug or issue that requires a code change,
   start your reply with `[NEEDS_FIX]` — otherwise do NOT include this tag.
4. Be specific: reference the code, explain your reasoning, or acknowledge the issue.
5. Keep the reply focused and actionable. Do not be overly verbose or apologetic.
6. If you agree with the feedback, say so directly and explain what you'll change.
7. If you disagree, explain your reasoning respectfully with evidence.
8. Do NOT include markdown code fences around your entire reply — write it as plain
   comment text (inline code and small snippets are fine).

Reply ONLY with the comment text. No preamble, no "Here's a draft reply:" prefix."""

    return prompt


def _classify_reply(content: str) -> str:
    """
    Classify a generated reply as 'reply_only' or 'needs_fix'.

    Args:
        content: The generated reply text.

    Returns:
        Classification string: 'reply_only' or 'needs_fix'.
    """
    if content.strip().startswith("[NEEDS_FIX]"):
        return "needs_fix"
    return "reply_only"


def _clean_reply(content: str) -> str:
    """
    Clean up the generated reply by removing classification tags.

    Args:
        content: The raw generated reply text.

    Returns:
        Cleaned reply text.
    """
    cleaned = content.strip()
    if cleaned.startswith("[NEEDS_FIX]"):
        cleaned = cleaned[len("[NEEDS_FIX]"):].strip()
    return cleaned


def _emit_chunk(thread_id: str, content: str, status: str, classification: str) -> None:
    """
    Emit a reply chunk via stdout with the structured prefix.

    Args:
        thread_id: The thread ID this chunk belongs to.
        content: The reply content.
        status: Status string ('generating', 'ready', 'error').
        classification: Thread classification ('reply_only' or 'needs_fix').
    """
    chunk = {
        "threadId": thread_id,
        "content": content,
        "status": status,
        "classification": classification,
    }
    safe_print(f"__REPLY_CHUNK__:{json.dumps(chunk)}")


async def generate_replies(args) -> int:
    """
    Generate AI reply drafts for unresolved PR review threads.

    Reads thread data from stdin, queries memory for context,
    generates replies via Claude, and streams results to stdout.

    Args:
        args: Parsed CLI arguments.

    Returns:
        Exit code: 0 on success, 1 on failure.
    """
    from core.client import create_client

    # Force unbuffered output so Electron sees it in real-time
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(line_buffering=True)

    # Read thread data from stdin
    try:
        stdin_data = sys.stdin.read()
        threads = json.loads(stdin_data)
        if not isinstance(threads, list):
            safe_print("[ERROR] Expected JSON array of threads on stdin")
            return 1
    except json.JSONDecodeError as e:
        safe_print(f"[ERROR] Failed to parse stdin JSON: {e}")
        return 1

    if not threads:
        safe_print("[INFO] No threads to process")
        safe_print("__REPLY_COMPLETE__")
        return 0

    safe_print(f"[INFO] Processing {len(threads)} review thread(s) for PR #{args.pr}")

    # Extract file paths from threads for memory context
    file_paths = list(
        {t.get("path") for t in threads if t.get("path")}
    )

    # Build a description of the review threads for memory queries
    thread_summaries = []
    for t in threads[:5]:  # Limit to 5 for the description
        path = t.get("path", "unknown")
        comments = t.get("comments", [])
        last_comment = comments[-1] if comments else {}
        body = last_comment.get("body", "")[:100]
        thread_summaries.append(f"{path}: {body}")
    change_description = "PR review threads:\n" + "\n".join(thread_summaries)

    # Query memory for context (gracefully degrades if Graphiti unavailable)
    memory_section = ""
    try:
        memory = GitHubMemoryIntegration(
            repo=args.repo,
            project_dir=Path(args.project),
        )
        review_context = await memory.get_review_context(
            file_paths=file_paths,
            change_description=change_description,
            pr_number=args.pr,
        )
        if review_context.has_context:
            memory_section = (
                "\n## Memory Context (from past reviews and project knowledge)\n\n"
                + review_context.to_prompt_section()
            )
            safe_print(
                f"[INFO] Memory context loaded: "
                f"{len(review_context.file_insights)} file insights, "
                f"{len(review_context.gotchas)} gotchas, "
                f"{len(review_context.patterns)} patterns"
            )
    except Exception as e:
        safe_print(f"[WARN] Memory context unavailable: {e}")

    # Resolve model and set up client
    project_dir = Path(args.project)
    github_dir = project_dir / ".auto-claude" / "github"
    github_dir.mkdir(parents=True, exist_ok=True)

    model_shorthand = args.model or "sonnet"
    model = resolve_model_id(model_shorthand)
    betas = get_model_betas(model_shorthand)

    safe_print(f"[INFO] Using model: {model}")

    # Process each thread
    errors = 0
    for i, thread in enumerate(threads):
        thread_id = thread.get("id", f"unknown-{i}")
        file_path = thread.get("path", "unknown")

        safe_print(
            f"[INFO] [{i + 1}/{len(threads)}] Generating reply for thread "
            f"in {file_path}"
        )

        # Emit a "generating" status so the frontend shows progress
        _emit_chunk(thread_id, "", "generating", "reply_only")

        try:
            prompt = _build_thread_prompt(thread, memory_section)

            client = create_client(
                project_dir=project_dir,
                spec_dir=github_dir,
                model=model,
                agent_type="pr_replier",
                betas=betas,
            )

            result_text = ""
            async with client:
                await client.query(prompt)

                async for msg in client.receive_response():
                    msg_type = type(msg).__name__
                    if msg_type == "AssistantMessage" and hasattr(msg, "content"):
                        for block in msg.content:
                            block_type = type(block).__name__
                            if block_type == "TextBlock" and hasattr(block, "text"):
                                result_text += block.text

            if result_text.strip():
                classification = _classify_reply(result_text)
                cleaned = _clean_reply(result_text)
                _emit_chunk(thread_id, cleaned, "ready", classification)
            else:
                _emit_chunk(
                    thread_id,
                    "Unable to generate a reply for this thread.",
                    "error",
                    "reply_only",
                )
                errors += 1

        except Exception as e:
            capture_exception(e)
            safe_print(f"[ERROR] Failed to generate reply for thread {thread_id}: {e}")
            _emit_chunk(
                thread_id,
                f"Error generating reply: {e}",
                "error",
                "reply_only",
            )
            errors += 1

    # Signal completion
    safe_print("__REPLY_COMPLETE__")

    if errors == len(threads):
        safe_print(f"[ERROR] All {errors} thread(s) failed")
        return 1

    if errors > 0:
        safe_print(f"[WARN] {errors}/{len(threads)} thread(s) had errors")

    safe_print(
        f"[INFO] Generated replies for {len(threads) - errors}/{len(threads)} thread(s)"
    )
    return 0


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Generate AI reply drafts for PR review comment threads",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Generate replies for PR #123
    echo '[{"id": "thread1", "path": "src/app.py", ...}]' | \\
        python pr_reply_runner.py --repo owner/repo --pr 123 --project /path/to/project

    # With custom model and thinking level
    echo '[...]' | python pr_reply_runner.py \\
        --repo owner/repo --pr 123 --project . \\
        --model sonnet --thinking high

Thread JSON format (stdin):
    [
        {
            "id": "GraphQL thread node ID",
            "path": "src/file.py",
            "line": 42,
            "diffHunk": "@@ -10,6 +10,8 @@ ...",
            "comments": [
                {
                    "author": {"login": "reviewer"},
                    "body": "This could cause a null pointer...",
                    "isAuthor": false
                }
            ]
        }
    ]

Output protocol:
    __REPLY_CHUNK__:{"threadId": "...", "content": "...", "status": "generating|ready|error", "classification": "reply_only|needs_fix"}
    __REPLY_COMPLETE__
        """,
    )

    parser.add_argument(
        "--repo",
        type=str,
        required=True,
        help="GitHub repo in owner/name format",
    )
    parser.add_argument(
        "--pr",
        type=int,
        required=True,
        help="PR number",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=str(Path.cwd()),
        help="Project directory path (default: current directory)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="claude-sonnet-4-5-20250929",
        help="AI model to use (default: claude-sonnet-4-5-20250929)",
    )
    parser.add_argument(
        "--thinking",
        type=str,
        default="medium",
        help="Thinking level: low, medium, high (default: medium)",
    )

    args = parser.parse_args()

    # Validate and sanitize thinking level
    args.thinking = sanitize_thinking_level(args.thinking)

    try:
        exit_code = asyncio.run(generate_replies(args))
        sys.exit(exit_code)
    except KeyboardInterrupt:
        safe_print("[INFO] Cancelled by user")
        sys.exit(1)
    except Exception as e:
        capture_exception(e)
        safe_print(f"[FATAL] Unhandled error: {e}")
        safe_print(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    main()
