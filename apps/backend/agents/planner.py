"""
Planner Agent Module
====================

Handles follow-up planner sessions for adding new subtasks to completed specs.
Includes agent team definitions for parallel planning with specialist agents.
"""

import logging
from pathlib import Path

from claude_agent_sdk import AgentDefinition
from core.client import create_client
from phase_config import (
    get_fast_mode,
    get_phase_client_thinking_kwargs,
    get_phase_model,
    get_phase_model_betas,
)
from phase_event import ExecutionPhase, emit_phase
from task_logger import (
    LogPhase,
    get_task_logger,
)
from ui import (
    BuildState,
    Icons,
    StatusManager,
    bold,
    box,
    highlight,
    icon,
    muted,
    print_status,
)

from .session import run_agent_session

logger = logging.getLogger(__name__)

# =============================================================================
# PLANNER SPECIALIST AGENT DEFINITIONS
# =============================================================================

PLANNER_PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


def _load_planner_specialist_prompt(filename: str) -> str:
    """Load a planner specialist agent prompt from the prompts directory."""
    prompt_file = PLANNER_PROMPTS_DIR / filename
    if not prompt_file.exists():
        raise FileNotFoundError(f"Planner specialist prompt not found: {prompt_file}")
    return prompt_file.read_text(encoding="utf-8")


def define_planner_specialist_agents(
    spec_dir: Path,
    project_dir: Path,
) -> dict[str, AgentDefinition]:
    """
    Define specialist agents for planning with critic validation.

    The planner orchestrator can delegate codebase research to a research
    specialist and have its plan validated by a critic before finalizing.

    Args:
        spec_dir: Directory containing the spec files
        project_dir: Root directory of the project

    Returns:
        Dict of agent name -> AgentDefinition for the SDK
    """
    working_dir = project_dir.resolve()
    spec_path = spec_dir.resolve()

    def with_context(prompt: str) -> str:
        """Prepend working directory and spec location to a specialist prompt."""
        return (
            f"**Working directory**: `{working_dir}`\n"
            f"**Spec directory**: `{spec_path}`\n"
            f"**Spec files**: spec.md, implementation_plan.json, context.json, "
            f"project_index.json, complexity_assessment.json\n\n"
            f"---\n\n{prompt}"
        )

    return {
        "codebase-researcher": AgentDefinition(
            description=(
                "Codebase research specialist. Invoke BEFORE creating the "
                "implementation plan. Performs deep investigation of the project "
                "structure, finds similar existing implementations, detects "
                "technology stack, and identifies files to modify/reference. "
                "Use this ALWAYS — every planning session needs codebase research."
            ),
            prompt=with_context(
                _load_planner_specialist_prompt("planner_research_agent.md")
            ),
            tools=["Read", "Grep", "Glob", "Bash"],
            model="inherit",
        ),
        "plan-critic": AgentDefinition(
            description=(
                "Planning critic / validator. Invoke AFTER creating the "
                "implementation plan. Validates file references exist, checks "
                "dependency ordering, verifies subtask scope, and catches "
                "missed existing code. Use this ALWAYS — every plan must be "
                "validated before finalizing."
            ),
            prompt=with_context(
                _load_planner_specialist_prompt("planner_critic_agent.md")
            ),
            tools=["Read", "Grep", "Glob", "Bash"],
            model="inherit",
        ),
    }


async def run_followup_planner(
    project_dir: Path,
    spec_dir: Path,
    model: str,
    verbose: bool = False,
) -> bool:
    """
    Run the follow-up planner to add new subtasks to a completed spec.

    This is a simplified version of run_autonomous_agent that:
    1. Creates a client
    2. Loads the followup planner prompt
    3. Runs a single planning session
    4. Returns after the plan is updated (doesn't enter coding loop)

    The planner agent will:
    - Read FOLLOWUP_REQUEST.md for the new task
    - Read the existing implementation_plan.json
    - Add new phase(s) with pending subtasks
    - Update the plan status back to in_progress

    Args:
        project_dir: Root directory for the project
        spec_dir: Directory containing the completed spec
        model: Claude model to use
        verbose: Whether to show detailed output

    Returns:
        bool: True if planning completed successfully
    """
    from implementation_plan import ImplementationPlan
    from prompts import get_followup_planner_prompt

    # Initialize status manager for ccstatusline
    status_manager = StatusManager(project_dir)
    status_manager.set_active(spec_dir.name, BuildState.PLANNING)
    emit_phase(ExecutionPhase.PLANNING, "Follow-up planning")

    # Initialize task logger for persistent logging
    task_logger = get_task_logger(spec_dir)

    # Show header
    content = [
        bold(f"{icon(Icons.GEAR)} FOLLOW-UP PLANNER SESSION"),
        "",
        f"Spec: {highlight(spec_dir.name)}",
        muted("Adding follow-up work to completed spec."),
        "",
        muted("The agent will read your FOLLOWUP_REQUEST.md and add new subtasks."),
    ]
    print()
    print(box(content, width=70, style="heavy"))
    print()

    # Start planning phase in task logger
    if task_logger:
        task_logger.start_phase(LogPhase.PLANNING, "Starting follow-up planning...")
        task_logger.set_session(1)

    # Create client with phase-specific model and thinking budget
    # Respects task_metadata.json configuration when no CLI override
    planning_model = get_phase_model(spec_dir, "planning", model)
    planning_betas = get_phase_model_betas(spec_dir, "planning", model)
    thinking_kwargs = get_phase_client_thinking_kwargs(
        spec_dir, "planning", planning_model
    )
    fast_mode = get_fast_mode(spec_dir)
    logger.info(
        f"[Planner] [Fast Mode] {'ENABLED' if fast_mode else 'disabled'} for follow-up planning"
    )
    # Define specialist agents for planning with critic validation
    planner_agents = define_planner_specialist_agents(spec_dir, project_dir)
    client = create_client(
        project_dir,
        spec_dir,
        planning_model,
        agent_type="planner",
        betas=planning_betas,
        fast_mode=fast_mode,
        agents=planner_agents,
        **thinking_kwargs,
    )

    # Generate follow-up planner prompt
    prompt = get_followup_planner_prompt(spec_dir)

    print_status("Running follow-up planner...", "progress")
    print()

    try:
        # Run single planning session
        async with client:
            status, response, error_info = await run_agent_session(
                client, prompt, spec_dir, verbose, phase=LogPhase.PLANNING
            )

        # End planning phase in task logger
        if task_logger:
            task_logger.end_phase(
                LogPhase.PLANNING,
                success=(status != "error"),
                message="Follow-up planning session completed",
            )

        if status == "error":
            print()
            print_status("Follow-up planning failed", "error")
            status_manager.update(state=BuildState.ERROR)
            return False

        # Verify the plan was updated (should have pending subtasks now)
        plan_file = spec_dir / "implementation_plan.json"
        if plan_file.exists():
            plan = ImplementationPlan.load(plan_file)

            # Check if there are any pending subtasks
            all_subtasks = [c for p in plan.phases for c in p.subtasks]
            pending_subtasks = [c for c in all_subtasks if c.status.value == "pending"]

            if pending_subtasks:
                # Reset the plan status to in_progress (in case planner didn't)
                plan.reset_for_followup()
                await plan.async_save(plan_file)

                print()
                content = [
                    bold(f"{icon(Icons.SUCCESS)} FOLLOW-UP PLANNING COMPLETE"),
                    "",
                    f"New pending subtasks: {highlight(str(len(pending_subtasks)))}",
                    f"Total subtasks: {len(all_subtasks)}",
                    "",
                    muted("Next steps:"),
                    f"  Run: {highlight(f'python auto-claude/run.py --spec {spec_dir.name}')}",
                ]
                print(box(content, width=70, style="heavy"))
                print()
                status_manager.update(state=BuildState.PAUSED)
                return True
            else:
                print()
                print_status(
                    "Warning: No pending subtasks found after planning", "warning"
                )
                print(muted("The planner may not have added new subtasks."))
                print(muted("Check implementation_plan.json manually."))
                status_manager.update(state=BuildState.PAUSED)
                return False
        else:
            print()
            print_status(
                "Error: implementation_plan.json not found after planning", "error"
            )
            status_manager.update(state=BuildState.ERROR)
            return False

    except Exception as e:
        print()
        print_status(f"Follow-up planning error: {e}", "error")
        if task_logger:
            task_logger.log_error(f"Follow-up planning error: {e}", LogPhase.PLANNING)
        status_manager.update(state=BuildState.ERROR)
        return False
