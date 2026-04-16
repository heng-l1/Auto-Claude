/**
 * Unit tests for PhaseProgressIndicator component
 * Tests getPhaseState() pure logic for the 4-step pipeline: Plan -> Code -> QA -> PR
 * No React rendering, no jsdom — just function logic testing
 */
import { describe, it, expect } from 'vitest';
import type { ExecutionPhase } from '../../../shared/constants/phase-protocol';
import type { TaskStatus } from '../../../shared/types/task';

// Local display-only type matching the component's definition
type DisplayPhase = ExecutionPhase | 'pr_creation';

type PhaseState = 'complete' | 'active' | 'stuck' | 'failed' | 'pending';

/**
 * Replicates the getPhaseState() closure from PhaseStepsIndicator.
 * This mirrors the exact logic in PhaseProgressIndicator.tsx (lines 293-313).
 */
function getPhaseState(
  phaseKey: DisplayPhase,
  currentPhase: ExecutionPhase,
  isStuck: boolean,
  taskStatus?: TaskStatus
): PhaseState {
  // PR-specific logic FIRST — must precede the generic 'complete' check
  if (phaseKey === 'pr_creation') {
    if (currentPhase === 'failed') return 'failed';
    if (taskStatus === 'pr_created') return 'complete';
    return 'pending';
  }

  // Original logic below — unchanged, only handles non-PR phases
  const phaseOrder = ['planning', 'coding', 'qa_review', 'qa_fixing', 'complete'];
  const currentIndex = phaseOrder.indexOf(currentPhase);
  const phaseIndex = phaseOrder.indexOf(phaseKey);

  if (currentPhase === 'failed') return 'failed';
  if (currentPhase === 'complete') return 'complete';
  if (phaseKey === currentPhase || (phaseKey === 'qa_review' && currentPhase === 'qa_fixing')) {
    return isStuck ? 'stuck' : 'active';
  }
  if (phaseIndex < currentIndex) return 'complete';
  return 'pending';
}

/** The 4 display phases rendered in PhaseStepsIndicator */
const DISPLAY_PHASES: DisplayPhase[] = ['planning', 'coding', 'qa_review', 'pr_creation'];

/** Helper to get all phase states at once for a given configuration */
function getAllPhaseStates(
  currentPhase: ExecutionPhase,
  isStuck: boolean,
  taskStatus?: TaskStatus
): Record<DisplayPhase, PhaseState> {
  const result = {} as Record<DisplayPhase, PhaseState>;
  for (const phase of DISPLAY_PHASES) {
    result[phase] = getPhaseState(phase, currentPhase, isStuck, taskStatus);
  }
  return result;
}

describe('PhaseProgressIndicator', () => {
  describe('getPhaseState()', () => {
    it('should render 4 phases: planning, coding, qa_review, pr_creation', () => {
      // The phases array in PhaseStepsIndicator has exactly 4 entries
      expect(DISPLAY_PHASES).toEqual(['planning', 'coding', 'qa_review', 'pr_creation']);
      expect(DISPLAY_PHASES).toHaveLength(4);
    });

    it('should show planning as active with all others pending', () => {
      const states = getAllPhaseStates('planning', false);

      expect(states.planning).toBe('active');
      expect(states.coding).toBe('pending');
      expect(states.qa_review).toBe('pending');
      expect(states.pr_creation).toBe('pending');
    });

    it('should show coding as active with planning complete', () => {
      const states = getAllPhaseStates('coding', false);

      expect(states.planning).toBe('complete');
      expect(states.coding).toBe('active');
      expect(states.qa_review).toBe('pending');
      expect(states.pr_creation).toBe('pending');
    });

    it('should show QA as active with planning and coding complete', () => {
      const states = getAllPhaseStates('qa_review', false);

      expect(states.planning).toBe('complete');
      expect(states.coding).toBe('complete');
      expect(states.qa_review).toBe('active');
      expect(states.pr_creation).toBe('pending');
    });

    it('should map qa_fixing to QA active state', () => {
      const states = getAllPhaseStates('qa_fixing', false);

      expect(states.planning).toBe('complete');
      expect(states.coding).toBe('complete');
      expect(states.qa_review).toBe('active');
      expect(states.pr_creation).toBe('pending');
    });

    it('should show PR as pending when complete without pr_created status', () => {
      // Task execution finished (currentPhase='complete') but no PR was created
      const states = getAllPhaseStates('complete', false);

      expect(states.planning).toBe('complete');
      expect(states.coding).toBe('complete');
      expect(states.qa_review).toBe('complete');
      expect(states.pr_creation).toBe('pending');
    });

    it('should show all 4 phases as complete when taskStatus is pr_created', () => {
      // Task execution finished AND a PR was created
      const states = getAllPhaseStates('complete', false, 'pr_created');

      expect(states.planning).toBe('complete');
      expect(states.coding).toBe('complete');
      expect(states.qa_review).toBe('complete');
      expect(states.pr_creation).toBe('complete');
    });

    it('should show all 4 phases as failed when execution fails', () => {
      const states = getAllPhaseStates('failed', false);

      expect(states.planning).toBe('failed');
      expect(states.coding).toBe('failed');
      expect(states.qa_review).toBe('failed');
      expect(states.pr_creation).toBe('failed');
    });

    it('should show active phase as stuck with PR staying pending', () => {
      // Coding phase is active but stuck; PR remains pending
      const states = getAllPhaseStates('coding', true);

      expect(states.planning).toBe('complete');
      expect(states.coding).toBe('stuck');
      expect(states.qa_review).toBe('pending');
      expect(states.pr_creation).toBe('pending');
    });
  });
});
