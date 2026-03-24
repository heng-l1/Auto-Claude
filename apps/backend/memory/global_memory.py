#!/usr/bin/env python3
"""
Global Memory Management
=========================

Functions for managing user-wide global memory that persists across projects.

Global memory stores cross-project user working patterns such as:
- Code review priorities and preferences
- Human review feedback patterns
- General working style preferences

Storage location: ~/.auto-claude/global_memory/
    ├── patterns.md         # Cross-project code patterns
    ├── gotchas.md          # Cross-project pitfalls to avoid
    └── preferences.json    # User working style preferences

All writes follow the dual-write pattern:
1. File-based write first (guaranteed, always available)
2. Graphiti GLOBAL scope best-effort (if enabled)
"""

import json
import logging
from pathlib import Path

from core.file_utils import write_json_atomic

from .graphiti_helpers import get_graphiti_memory, is_graphiti_memory_enabled, run_async
from .paths import get_global_memory_dir

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------


def append_global_pattern(pattern: str) -> None:
    """
    Append a code pattern to the global patterns list.

    Patterns are deduplicated - if the same pattern already exists,
    it won't be added again.

    Args:
        pattern: Description of the code pattern

    Example:
        append_global_pattern("Always use structured logging over print statements")
        append_global_pattern("Prefer composition over inheritance")
    """
    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return

    patterns_file = memory_dir / "patterns.md"

    # Load existing patterns
    existing_patterns = set()
    if patterns_file.exists():
        content = patterns_file.read_text(encoding="utf-8")
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("- "):
                existing_patterns.add(line[2:].strip())

    # Add new pattern if not duplicate
    pattern_stripped = pattern.strip()
    if pattern_stripped and pattern_stripped not in existing_patterns:
        with open(patterns_file, "a", encoding="utf-8") as f:
            if not patterns_file.exists() or patterns_file.stat().st_size == 0:
                f.write("# Global Code Patterns\n\n")
                f.write("Cross-project code patterns to follow:\n\n")
            f.write(f"- {pattern_stripped}\n")

        # Also save to Graphiti with GLOBAL scope if enabled
        if is_graphiti_memory_enabled():
            try:
                graphiti = run_async(
                    get_graphiti_memory(memory_dir, memory_dir.parent)
                )
                if graphiti:
                    run_async(graphiti.save_pattern(pattern_stripped))
                    run_async(graphiti.close())
            except Exception as e:
                logger.warning(f"Graphiti global pattern save failed: {e}")


def load_global_patterns() -> list[str]:
    """
    Load all global code patterns.

    Returns:
        List of pattern strings
    """
    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return []

    patterns_file = memory_dir / "patterns.md"

    if not patterns_file.exists():
        return []

    content = patterns_file.read_text(encoding="utf-8")
    patterns = []

    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("- "):
            patterns.append(line[2:].strip())

    return patterns


# ---------------------------------------------------------------------------
# Gotchas
# ---------------------------------------------------------------------------


def append_global_gotcha(gotcha: str) -> None:
    """
    Append a gotcha (pitfall to avoid) to the global gotchas list.

    Gotchas are deduplicated - if the same gotcha already exists,
    it won't be added again.

    Args:
        gotcha: Description of the pitfall to avoid

    Example:
        append_global_gotcha("Always close database connections in finally blocks")
        append_global_gotcha("API rate limits vary between environments")
    """
    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return

    gotchas_file = memory_dir / "gotchas.md"

    # Load existing gotchas
    existing_gotchas = set()
    if gotchas_file.exists():
        content = gotchas_file.read_text(encoding="utf-8")
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("- "):
                existing_gotchas.add(line[2:].strip())

    # Add new gotcha if not duplicate
    gotcha_stripped = gotcha.strip()
    if gotcha_stripped and gotcha_stripped not in existing_gotchas:
        with open(gotchas_file, "a", encoding="utf-8") as f:
            if not gotchas_file.exists() or gotchas_file.stat().st_size == 0:
                f.write("# Global Gotchas and Pitfalls\n\n")
                f.write("Cross-project pitfalls to watch out for:\n\n")
            f.write(f"- {gotcha_stripped}\n")

        # Also save to Graphiti with GLOBAL scope if enabled
        if is_graphiti_memory_enabled():
            try:
                graphiti = run_async(
                    get_graphiti_memory(memory_dir, memory_dir.parent)
                )
                if graphiti:
                    run_async(graphiti.save_gotcha(gotcha_stripped))
                    run_async(graphiti.close())
            except Exception as e:
                logger.warning(f"Graphiti global gotcha save failed: {e}")


def load_global_gotchas() -> list[str]:
    """
    Load all global gotchas.

    Returns:
        List of gotcha strings
    """
    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return []

    gotchas_file = memory_dir / "gotchas.md"

    if not gotchas_file.exists():
        return []

    content = gotchas_file.read_text(encoding="utf-8")
    gotchas = []

    for line in content.split("\n"):
        line = line.strip()
        if line.startswith("- "):
            gotchas.append(line[2:].strip())

    return gotchas


# ---------------------------------------------------------------------------
# Preferences
# ---------------------------------------------------------------------------


def append_global_preference(preference: str) -> None:
    """
    Append a user working style preference to global memory.

    Preferences capture user behavioral patterns such as code review priorities,
    working style signals, and cross-project habits. They are stored as JSON
    for structured access and use write_json_atomic for concurrent safety.

    Preferences are deduplicated - if the same preference already exists,
    it won't be added again.

    Args:
        preference: Description of the user preference

    Example:
        append_global_preference("Prefers thorough error handling in all code")
        append_global_preference("Cares about comprehensive test coverage")
    """
    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return

    preferences_file = memory_dir / "preferences.json"

    # Load existing preferences
    existing_preferences: list[str] = []
    if preferences_file.exists():
        try:
            content = preferences_file.read_text(encoding="utf-8")
            data = json.loads(content)
            if isinstance(data, list):
                existing_preferences = data
            elif isinstance(data, dict):
                existing_preferences = data.get("preferences", [])
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to read global preferences: {e}")

    # Add new preference if not duplicate
    preference_stripped = preference.strip()
    if preference_stripped and preference_stripped not in existing_preferences:
        existing_preferences.append(preference_stripped)
        write_json_atomic(
            preferences_file,
            {
                "source": "global",
                "preferences": existing_preferences,
            },
        )

        # Also save to Graphiti with GLOBAL scope if enabled
        if is_graphiti_memory_enabled():
            try:
                graphiti = run_async(
                    get_graphiti_memory(memory_dir, memory_dir.parent)
                )
                if graphiti:
                    run_async(graphiti.save_pattern(preference_stripped))
                    run_async(graphiti.close())
            except Exception as e:
                logger.warning(f"Graphiti global preference save failed: {e}")


def load_global_preferences() -> list[str]:
    """
    Load all global user preferences.

    Returns:
        List of preference strings
    """
    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return []

    preferences_file = memory_dir / "preferences.json"

    if not preferences_file.exists():
        return []

    try:
        content = preferences_file.read_text(encoding="utf-8")
        data = json.loads(content)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("preferences", [])
        return []
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"Failed to read global preferences: {e}")
        return []


# ---------------------------------------------------------------------------
# Clear
# ---------------------------------------------------------------------------


def clear_global_memory() -> None:
    """
    Clear all global memory.

    WARNING: This deletes all global patterns, gotchas, and preferences.
    Use with caution - typically only needed when the user explicitly requests it.
    """
    import shutil

    try:
        memory_dir = get_global_memory_dir()
    except OSError as e:
        logger.warning(f"Cannot access global memory directory: {e}")
        return

    if memory_dir.exists():
        shutil.rmtree(memory_dir)
        # Recreate empty directory
        memory_dir.mkdir(parents=True, exist_ok=True)
