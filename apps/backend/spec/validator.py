"""
Validation Module
=================

Spec validation with auto-fix capabilities.
"""

import json
from datetime import datetime
from pathlib import Path


def create_minimal_research(spec_dir: Path, reason: str = "No research needed") -> Path:
    """Create minimal research.md file."""
    research_file = spec_dir / "research.md"
    research_file.write_text(
        f"# Research\n\n**Research skipped**: {reason}\n",
        encoding="utf-8",
    )
    return research_file


def create_minimal_critique(
    spec_dir: Path, reason: str = "Critique not required"
) -> Path:
    """Create minimal critique_report.md file."""
    critique_file = spec_dir / "critique_report.md"
    critique_file.write_text(
        f"# Critique Report\n\n**No issues found**: {reason}\n",
        encoding="utf-8",
    )
    return critique_file


def create_empty_hints(spec_dir: Path, enabled: bool, reason: str) -> Path:
    """Create empty graph_hints.json file."""
    hints_file = spec_dir / "graph_hints.json"

    with open(hints_file, "w", encoding="utf-8") as f:
        json.dump(
            {
                "enabled": enabled,
                "reason": reason,
                "hints": [],
                "created_at": datetime.now().isoformat(),
            },
            f,
            indent=2,
        )

    return hints_file
