"""
Memory Integration for GitHub Automation
=========================================

Connects the GitHub automation system to the existing Graphiti memory layer for:
- Cross-session context retrieval
- Historical pattern recognition
- Codebase gotchas and quirks
- Similar past reviews and their outcomes

Leverages the existing Graphiti infrastructure from:
- integrations/graphiti/memory.py
- integrations/graphiti/queries_pkg/graphiti.py
- memory/graphiti_helpers.py

Usage:
    memory = GitHubMemoryIntegration(repo="owner/repo", state_dir=Path("..."))

    # Before reviewing, get relevant context
    context = await memory.get_review_context(
        file_paths=["auth.py", "utils.py"],
        change_description="Adding OAuth support",
    )

    # After review, store insights
    await memory.store_review_insight(
        pr_number=123,
        file_paths=["auth.py"],
        insight="Auth module requires careful session handling",
        category="gotcha",
    )
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Add parent paths to sys.path for imports
_backend_dir = Path(__file__).parent.parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

# Import Graphiti components
try:
    from integrations.graphiti.memory import (
        GraphitiMemory,
        GroupIdMode,
        get_graphiti_memory,
        is_graphiti_enabled,
    )
    from memory.graphiti_helpers import is_graphiti_memory_enabled

    GRAPHITI_AVAILABLE = True
except (ImportError, ValueError, SystemError):
    GRAPHITI_AVAILABLE = False

    def is_graphiti_enabled() -> bool:
        return False

    def is_graphiti_memory_enabled() -> bool:
        return False

    GroupIdMode = None

# Import global memory for cross-project user preference storage
try:
    from memory.global_memory import append_global_preference

    GLOBAL_MEMORY_AVAILABLE = True
except (ImportError, ValueError, SystemError):
    GLOBAL_MEMORY_AVAILABLE = False

    def append_global_preference(preference: str) -> None:
        pass


def _is_global_memory_enabled() -> bool:
    if not GLOBAL_MEMORY_AVAILABLE:
        return False
    return os.environ.get("GLOBAL_MEMORY_ENABLED", "").lower() in ("true", "1", "yes")


# ---------------------------------------------------------------------------
# Preference extraction keywords
# ---------------------------------------------------------------------------

# Indicators that a sentence expresses a user preference or priority
_PREFERENCE_INDICATORS = [
    "prefer",
    "important",
    "always",
    "never",
    "should",
    "must",
    "care about",
    "prioritize",
    "value",
    "focus on",
    "ensure",
    "require",
    "expect",
    "want",
    "need",
    "like to",
    "make sure",
    "pay attention",
    "concerned about",
    "priority",
    "critical",
    "essential",
]


def _extract_user_preferences(notes: str) -> list[str]:
    """
    Extract user preference-like statements from review notes.

    Identifies sentences that express preferences, priorities, or values
    about code quality, review style, or working patterns.

    Args:
        notes: Raw review notes text

    Returns:
        List of extracted preference strings

    Example:
        >>> _extract_user_preferences("I prefer thorough error handling. The code looks fine.")
        ["Prefers thorough error handling"]
    """
    if not notes or not notes.strip():
        return []

    preferences: list[str] = []
    seen: set[str] = set()

    # Split into sentences (handle ., !, ?, and newlines)
    sentences = re.split(r"[.!?\n]+", notes)

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence or len(sentence) < 10:
            continue

        sentence_lower = sentence.lower()

        # Check if sentence contains a preference indicator
        matched = False
        for indicator in _PREFERENCE_INDICATORS:
            if indicator in sentence_lower:
                matched = True
                break

        if not matched:
            continue

        # Clean up the preference statement
        # Remove leading pronouns/articles for a cleaner preference
        cleaned = re.sub(
            r"^(i |we |you |they |please |also |and |but |the )+",
            "",
            sentence.strip(),
            flags=re.IGNORECASE,
        ).strip()

        if not cleaned or len(cleaned) < 10:
            continue

        # Capitalize first letter and ensure it reads as a preference
        preference = cleaned[0].upper() + cleaned[1:]

        # If it doesn't start with a preference-like verb, prefix it
        pref_lower = preference.lower()
        if not any(
            pref_lower.startswith(p)
            for p in [
                "prefer",
                "always",
                "never",
                "ensure",
                "require",
                "expect",
                "want",
                "need",
                "focus",
                "make sure",
                "pay attention",
                "prioritize",
                "value",
                "care",
            ]
        ):
            preference = f"Prefers: {preference}"

        # Deduplicate
        norm = preference.lower().strip()
        if norm not in seen:
            seen.add(norm)
            preferences.append(preference)

    return preferences


@dataclass
class MemoryHint:
    """
    A hint from memory to aid decision making.
    """

    hint_type: str  # gotcha, pattern, warning, context
    content: str
    relevance_score: float = 0.0
    source: str = "memory"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReviewContext:
    """
    Context gathered from memory for a code review.
    """

    # Past insights about affected files
    file_insights: list[MemoryHint] = field(default_factory=list)

    # Similar past changes and their outcomes
    similar_changes: list[dict[str, Any]] = field(default_factory=list)

    # Known gotchas for this area
    gotchas: list[MemoryHint] = field(default_factory=list)

    # Codebase patterns relevant to this review
    patterns: list[MemoryHint] = field(default_factory=list)

    # Historical context from past reviews
    past_reviews: list[dict[str, Any]] = field(default_factory=list)

    @property
    def has_context(self) -> bool:
        return bool(
            self.file_insights
            or self.similar_changes
            or self.gotchas
            or self.patterns
            or self.past_reviews
        )

    def to_prompt_section(self) -> str:
        """Format memory context for inclusion in prompts."""
        if not self.has_context:
            return ""

        sections = []

        if self.gotchas:
            sections.append("### Known Gotchas")
            for gotcha in self.gotchas:
                sections.append(f"- {gotcha.content}")

        if self.file_insights:
            sections.append("\n### File Insights")
            for insight in self.file_insights:
                sections.append(f"- {insight.content}")

        if self.patterns:
            sections.append("\n### Codebase Patterns")
            for pattern in self.patterns:
                sections.append(f"- {pattern.content}")

        if self.similar_changes:
            sections.append("\n### Similar Past Changes")
            for change in self.similar_changes[:3]:
                outcome = change.get("outcome", "unknown")
                desc = change.get("description", "")
                sections.append(f"- {desc} (outcome: {outcome})")

        if self.past_reviews:
            sections.append("\n### Past Review Notes")
            for review in self.past_reviews[:3]:
                note = review.get("note", "")
                pr = review.get("pr_number", "")
                sections.append(f"- PR #{pr}: {note}")

        return "\n".join(sections)


class GitHubMemoryIntegration:
    """
    Integrates GitHub automation with the existing Graphiti memory layer.

    Uses the project's Graphiti infrastructure for:
    - Storing review outcomes and insights
    - Retrieving relevant context from past sessions
    - Recording patterns and gotchas discovered during reviews
    """

    def __init__(
        self,
        repo: str,
        state_dir: Path | None = None,
        project_dir: Path | None = None,
    ):
        """
        Initialize memory integration.

        Args:
            repo: Repository identifier (owner/repo)
            state_dir: Local state directory for the GitHub runner
            project_dir: Project root directory (for Graphiti namespacing)
        """
        self.repo = repo
        self.state_dir = state_dir or Path(".auto-claude/github")
        self.project_dir = project_dir or Path.cwd()
        self.memory_dir = self.state_dir / "memory"
        self.memory_dir.mkdir(parents=True, exist_ok=True)

        # Graphiti memory instance (lazy-loaded)
        self._graphiti: GraphitiMemory | None = None

        # Local cache for insights (fallback when Graphiti not available)
        self._local_insights: list[dict[str, Any]] = []
        self._load_local_insights()

    def _load_local_insights(self) -> None:
        """Load locally stored insights."""
        insights_file = self.memory_dir / f"{self.repo.replace('/', '_')}_insights.json"
        if insights_file.exists():
            try:
                with open(insights_file, encoding="utf-8") as f:
                    self._local_insights = json.load(f).get("insights", [])
            except (json.JSONDecodeError, KeyError):
                self._local_insights = []

    def _save_local_insights(self) -> None:
        """Save insights locally."""
        insights_file = self.memory_dir / f"{self.repo.replace('/', '_')}_insights.json"
        with open(insights_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "repo": self.repo,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "insights": self._local_insights[-1000:],  # Keep last 1000
                },
                f,
                indent=2,
            )

    @property
    def is_enabled(self) -> bool:
        """Check if Graphiti memory integration is available."""
        return GRAPHITI_AVAILABLE and is_graphiti_memory_enabled()

    async def _get_graphiti(self) -> GraphitiMemory | None:
        """Get or create Graphiti memory instance."""
        if not self.is_enabled:
            return None

        if self._graphiti is None:
            try:
                # Create spec dir for GitHub automation
                spec_dir = self.state_dir / "graphiti" / self.repo.replace("/", "_")
                spec_dir.mkdir(parents=True, exist_ok=True)

                self._graphiti = get_graphiti_memory(
                    spec_dir=spec_dir,
                    project_dir=self.project_dir,
                    group_id_mode=GroupIdMode.PROJECT,  # Share context across all GitHub reviews
                )

                # Initialize
                await self._graphiti.initialize()

            except Exception as e:
                self._graphiti = None
                return None

        return self._graphiti

    async def get_review_context(
        self,
        file_paths: list[str],
        change_description: str,
        pr_number: int | None = None,
    ) -> ReviewContext:
        """
        Get context from memory for a code review.

        Args:
            file_paths: Files being changed
            change_description: Description of the changes
            pr_number: PR number if available

        Returns:
            ReviewContext with relevant memory hints
        """
        context = ReviewContext()

        # Query Graphiti if available
        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                # Query for file-specific insights
                for file_path in file_paths[:5]:  # Limit to 5 files
                    results = await graphiti.get_relevant_context(
                        query=f"What should I know about {file_path}?",
                        num_results=3,
                        include_project_context=True,
                    )
                    for result in results:
                        content = result.get("content") or result.get("summary", "")
                        if content:
                            context.file_insights.append(
                                MemoryHint(
                                    hint_type="file_insight",
                                    content=content,
                                    relevance_score=result.get("score", 0.5),
                                    source="graphiti",
                                    metadata=result,
                                )
                            )

                # Query for similar changes
                similar = await graphiti.get_similar_task_outcomes(
                    task_description=f"PR review: {change_description}",
                    limit=5,
                )
                for item in similar:
                    context.similar_changes.append(
                        {
                            "description": item.get("description", ""),
                            "outcome": "success" if item.get("success") else "failed",
                            "task_id": item.get("task_id"),
                        }
                    )

                # Get session history for recent gotchas
                history = await graphiti.get_session_history(limit=10, spec_only=False)
                for session in history:
                    discoveries = session.get("discoveries", {})
                    for gotcha in discoveries.get("gotchas_encountered", []):
                        context.gotchas.append(
                            MemoryHint(
                                hint_type="gotcha",
                                content=gotcha,
                                relevance_score=0.7,
                                source="graphiti",
                            )
                        )
                    for pattern in discoveries.get("patterns_found", []):
                        context.patterns.append(
                            MemoryHint(
                                hint_type="pattern",
                                content=pattern,
                                relevance_score=0.6,
                                source="graphiti",
                            )
                        )

            except Exception:
                # Graphiti failed, fall through to local
                pass

        # Add local insights
        for insight in self._local_insights:
            # Match by file path
            if any(f in insight.get("file_paths", []) for f in file_paths):
                if insight.get("category") == "gotcha":
                    context.gotchas.append(
                        MemoryHint(
                            hint_type="gotcha",
                            content=insight.get("content", ""),
                            relevance_score=0.7,
                            source="local",
                        )
                    )
                elif insight.get("category") == "pattern":
                    context.patterns.append(
                        MemoryHint(
                            hint_type="pattern",
                            content=insight.get("content", ""),
                            relevance_score=0.6,
                            source="local",
                        )
                    )

        return context

    async def store_review_insight(
        self,
        pr_number: int,
        file_paths: list[str],
        insight: str,
        category: str = "insight",
        severity: str = "info",
    ) -> None:
        """
        Store an insight from a review for future reference.

        Args:
            pr_number: PR number
            file_paths: Files involved
            insight: The insight to store
            category: Category (gotcha, pattern, warning, insight)
            severity: Severity level
        """
        now = datetime.now(timezone.utc)

        # Store locally
        self._local_insights.append(
            {
                "pr_number": pr_number,
                "file_paths": file_paths,
                "content": insight,
                "category": category,
                "severity": severity,
                "created_at": now.isoformat(),
            }
        )
        self._save_local_insights()

        # Store in Graphiti if available
        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                if category == "gotcha":
                    await graphiti.save_gotcha(
                        f"[{self.repo}] PR #{pr_number}: {insight}"
                    )
                elif category == "pattern":
                    await graphiti.save_pattern(
                        f"[{self.repo}] PR #{pr_number}: {insight}"
                    )
                else:
                    # Save as session insight
                    await graphiti.save_session_insights(
                        session_num=pr_number,
                        insights={
                            "type": "github_review_insight",
                            "repo": self.repo,
                            "pr_number": pr_number,
                            "file_paths": file_paths,
                            "content": insight,
                            "category": category,
                            "severity": severity,
                        },
                    )
            except Exception:
                # Graphiti failed, local storage is backup
                pass

    async def store_review_outcome(
        self,
        pr_number: int,
        prediction: str,
        outcome: str,
        was_correct: bool,
        notes: str | None = None,
    ) -> None:
        """
        Store the outcome of a review for learning.

        Args:
            pr_number: PR number
            prediction: What the system predicted
            outcome: What actually happened
            was_correct: Whether prediction was correct
            notes: Additional notes
        """
        now = datetime.now(timezone.utc)

        # Store locally
        self._local_insights.append(
            {
                "pr_number": pr_number,
                "content": f"PR #{pr_number}: Predicted {prediction}, got {outcome}. {'Correct' if was_correct else 'Incorrect'}. {notes or ''}",
                "category": "outcome",
                "prediction": prediction,
                "outcome": outcome,
                "was_correct": was_correct,
                "created_at": now.isoformat(),
            }
        )
        self._save_local_insights()

        # Store in Graphiti
        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                await graphiti.save_task_outcome(
                    task_id=f"github_review_{self.repo}_{pr_number}",
                    success=was_correct,
                    outcome=f"Predicted {prediction}, actual {outcome}",
                    metadata={
                        "type": "github_review",
                        "repo": self.repo,
                        "pr_number": pr_number,
                        "prediction": prediction,
                        "actual_outcome": outcome,
                        "notes": notes,
                    },
                )
            except Exception:
                pass

    async def store_reviewer_notes(
        self,
        pr_number: int,
        notes: str,
        file_paths: list[str] | None = None,
    ) -> None:
        """
        Store reviewer notes and extract user preferences to global memory.

        When a user provides review notes, this method:
        1. Stores the notes as a local review insight
        2. Extracts preference-like statements from the notes
        3. Writes extracted preferences to global memory via append_global_preference()
        4. Optionally writes to Graphiti with GLOBAL scope (best-effort)

        Args:
            pr_number: PR number being reviewed
            notes: The reviewer's notes text
            file_paths: Files involved in the review (optional)
        """
        if not notes or not notes.strip():
            return

        now = datetime.now(timezone.utc)

        # Store the full notes as a local review insight
        self._local_insights.append(
            {
                "pr_number": pr_number,
                "file_paths": file_paths or [],
                "content": notes,
                "category": "reviewer_notes",
                "created_at": now.isoformat(),
            }
        )
        self._save_local_insights()

        # Store in Graphiti (project scope) if available
        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                await graphiti.save_session_insights(
                    session_num=pr_number,
                    insights={
                        "type": "reviewer_notes",
                        "repo": self.repo,
                        "pr_number": pr_number,
                        "file_paths": file_paths or [],
                        "content": notes,
                    },
                )
            except Exception:
                pass

        # Extract user preferences and save to global memory (only if enabled)
        if not _is_global_memory_enabled():
            return

        preferences = _extract_user_preferences(notes)
        for preference in preferences:
            try:
                append_global_preference(preference)
            except Exception as e:
                logger.warning(f"Failed to save global preference: {e}")

        # Also save preferences to Graphiti with GLOBAL scope (best-effort)
        if preferences and GRAPHITI_AVAILABLE and is_graphiti_enabled():
            try:
                from integrations.graphiti.memory import get_global_graphiti_memory

                global_graphiti = get_global_graphiti_memory()
                if global_graphiti:
                    await global_graphiti.initialize()
                    for preference in preferences:
                        await global_graphiti.save_pattern(
                            f"[user_preference] {preference}"
                        )
                    await global_graphiti.close()
            except Exception as e:
                logger.warning(f"Graphiti global preference save failed: {e}")

    async def get_codebase_patterns(
        self,
        area: str | None = None,
    ) -> list[MemoryHint]:
        """
        Get known codebase patterns.

        Args:
            area: Specific area (e.g., "auth", "api", "database")

        Returns:
            List of pattern hints
        """
        patterns = []

        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                query = (
                    f"Codebase patterns for {area}"
                    if area
                    else "Codebase patterns and conventions"
                )
                results = await graphiti.get_relevant_context(
                    query=query,
                    num_results=10,
                    include_project_context=True,
                )
                for result in results:
                    content = result.get("content") or result.get("summary", "")
                    if content:
                        patterns.append(
                            MemoryHint(
                                hint_type="pattern",
                                content=content,
                                relevance_score=result.get("score", 0.5),
                                source="graphiti",
                            )
                        )
            except Exception:
                pass

        # Add local patterns
        for insight in self._local_insights:
            if insight.get("category") == "pattern":
                if not area or area.lower() in insight.get("content", "").lower():
                    patterns.append(
                        MemoryHint(
                            hint_type="pattern",
                            content=insight.get("content", ""),
                            relevance_score=0.6,
                            source="local",
                        )
                    )

        return patterns

    async def explain_finding(
        self,
        finding_id: str,
        finding_description: str,
        file_path: str,
    ) -> str | None:
        """
        Get memory-backed explanation for a finding.

        Answers "Why did you flag this?" with historical context.

        Args:
            finding_id: Finding identifier
            finding_description: What was found
            file_path: File where it was found

        Returns:
            Explanation with historical context, or None
        """
        graphiti = await self._get_graphiti()
        if not graphiti:
            return None

        try:
            results = await graphiti.get_relevant_context(
                query=f"Why flag: {finding_description} in {file_path}",
                num_results=3,
                include_project_context=True,
            )

            if results:
                explanations = []
                for result in results:
                    content = result.get("content") or result.get("summary", "")
                    if content:
                        explanations.append(f"- {content}")

                if explanations:
                    return "Historical context:\n" + "\n".join(explanations)

        except Exception:
            pass

        return None

    async def store_reviewer_notes(
        self,
        pr_number: int,
        notes: str,
        file_paths: list[str] | None = None,
    ) -> None:
        """
        Store reviewer-provided notes for a PR.

        Notes are persisted both to a dedicated local JSON file and to the
        Graphiti knowledge graph (when available) for future semantic recall.

        Args:
            pr_number: PR number
            notes: The reviewer's notes text
            file_paths: Optional list of files the notes relate to
        """
        if not notes or not notes.strip():
            return

        now = datetime.now(timezone.utc)
        file_paths = file_paths or []

        # Save to dedicated notes file (.auto-claude/github/pr/notes_{prNumber}.json)
        pr_dir = self.state_dir / "pr"
        pr_dir.mkdir(parents=True, exist_ok=True)
        notes_file = pr_dir / f"notes_{pr_number}.json"

        notes_data = {
            "pr_number": pr_number,
            "notes": notes.strip(),
            "file_paths": file_paths,
            "updated_at": now.isoformat(),
        }

        # Preserve history if file already exists
        existing_history: list[dict[str, Any]] = []
        if notes_file.exists():
            try:
                with open(notes_file, encoding="utf-8") as f:
                    existing = json.load(f)
                    existing_history = existing.get("history", [])
            except (json.JSONDecodeError, KeyError):
                pass

        existing_history.append(
            {
                "notes": notes.strip(),
                "file_paths": file_paths,
                "timestamp": now.isoformat(),
            }
        )
        # Keep last 50 history entries
        existing_history = existing_history[-50:]

        with open(notes_file, "w", encoding="utf-8") as f:
            json.dump(
                {
                    **notes_data,
                    "history": existing_history,
                },
                f,
                indent=2,
            )

        # Also store in local insights for cross-PR retrieval
        self._local_insights.append(
            {
                "pr_number": pr_number,
                "file_paths": file_paths,
                "content": notes.strip(),
                "category": "reviewer_notes",
                "created_at": now.isoformat(),
            }
        )
        self._save_local_insights()

        # Store in Graphiti if available (best-effort)
        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                await graphiti.save_session_insights(
                    session_num=pr_number,
                    insights={
                        "type": "reviewer_notes",
                        "repo": self.repo,
                        "pr_number": pr_number,
                        "file_paths": file_paths,
                        "content": notes.strip(),
                        "created_at": now.isoformat(),
                    },
                )
            except Exception:
                # Graphiti failed, local storage is the backup
                pass

    def get_reviewer_notes(self, pr_number: int) -> str | None:
        """
        Load reviewer notes for a specific PR from local storage.

        Args:
            pr_number: PR number

        Returns:
            The stored notes text, or None if no notes exist
        """
        notes_file = self.state_dir / "pr" / f"notes_{pr_number}.json"
        if not notes_file.exists():
            return None

        try:
            with open(notes_file, encoding="utf-8") as f:
                data = json.load(f)
                notes = data.get("notes", "")
                return notes if notes else None
        except (json.JSONDecodeError, KeyError):
            return None

    async def get_relevant_reviewer_notes(
        self,
        file_paths: list[str],
        description: str,
        limit: int = 5,
    ) -> list[MemoryHint]:
        """
        Query for semantically relevant past reviewer notes.

        Searches both Graphiti and local insights for notes that may be
        relevant to the current review based on file paths and description.

        Args:
            file_paths: Files being reviewed
            description: Description of the current changes
            limit: Maximum number of notes to return

        Returns:
            List of MemoryHint objects containing relevant past notes
        """
        hints: list[MemoryHint] = []

        # Query Graphiti if available
        graphiti = await self._get_graphiti()
        if graphiti:
            try:
                results = await graphiti.get_relevant_context(
                    query=f"Reviewer notes for: {description}",
                    num_results=limit,
                    include_project_context=True,
                )
                for result in results:
                    content = result.get("content") or result.get("summary", "")
                    if content:
                        hints.append(
                            MemoryHint(
                                hint_type="reviewer_notes",
                                content=content,
                                relevance_score=result.get("score", 0.5),
                                source="graphiti",
                                metadata=result,
                            )
                        )
            except Exception:
                pass

        # Also search local insights for reviewer_notes matching file paths
        for insight in self._local_insights:
            if insight.get("category") != "reviewer_notes":
                continue
            insight_files = insight.get("file_paths", [])
            # Match if any file paths overlap or if no file constraint
            if not insight_files or any(f in insight_files for f in file_paths):
                hints.append(
                    MemoryHint(
                        hint_type="reviewer_notes",
                        content=insight.get("content", ""),
                        relevance_score=0.6,
                        source="local",
                        metadata={
                            "pr_number": insight.get("pr_number"),
                            "created_at": insight.get("created_at"),
                        },
                    )
                )

        # Deduplicate by content and limit
        seen: set[str] = set()
        unique_hints: list[MemoryHint] = []
        for hint in hints:
            if hint.content not in seen:
                seen.add(hint.content)
                unique_hints.append(hint)

        # Sort by relevance score descending, then limit
        unique_hints.sort(key=lambda h: h.relevance_score, reverse=True)
        return unique_hints[:limit]

    @staticmethod
    def load_notes_from_file(notes_file_path: str | Path) -> str | None:
        """
        Load reviewer notes from a temp file (passed from frontend via CLI).

        Args:
            notes_file_path: Path to the temp file containing notes text

        Returns:
            The notes text, or None if file doesn't exist or is empty
        """
        path = Path(notes_file_path)
        if not path.exists():
            return None

        try:
            content = path.read_text(encoding="utf-8").strip()
            return content if content else None
        except (OSError, UnicodeDecodeError):
            return None

    async def close(self) -> None:
        """Close Graphiti connection."""
        if self._graphiti:
            try:
                await self._graphiti.close()
            except Exception:
                pass
            self._graphiti = None

    def get_summary(self) -> dict[str, Any]:
        """Get summary of stored memory."""
        categories = {}
        for insight in self._local_insights:
            cat = insight.get("category", "unknown")
            categories[cat] = categories.get(cat, 0) + 1

        graphiti_status = None
        if self._graphiti:
            graphiti_status = self._graphiti.get_status_summary()

        return {
            "repo": self.repo,
            "total_local_insights": len(self._local_insights),
            "by_category": categories,
            "graphiti_available": GRAPHITI_AVAILABLE,
            "graphiti_enabled": self.is_enabled,
            "graphiti_status": graphiti_status,
        }
