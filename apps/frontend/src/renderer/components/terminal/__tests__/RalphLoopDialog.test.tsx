/**
 * @vitest-environment jsdom
 */
/**
 * RalphLoopDialog Tests
 *
 * Covers the seven scenarios from spec.md "QA Acceptance Criteria → Unit Tests":
 *   1. buildRalphLoopCommand — prompt only returns `/ralph-loop "the prompt"`.
 *   2. buildRalphLoopCommand — shell-escape: each of `"`, `\`, `$`, and backtick
 *      is escaped with exactly one backslash inside the surrounding double quotes.
 *   3. buildRalphLoopCommand — maxIterations gating: 5 adds the flag; 0, NaN,
 *      -1, Infinity omit it; 3.7 is floored to 3.
 *   4. buildRalphLoopCommand — completionPromise gating: non-empty trimmed
 *      value adds the flag with a shell-quoted value; whitespace-only or
 *      undefined omits it.
 *   5. Dialog — Run button disabled state: disabled when prompt is empty or
 *      whitespace; enabled once prompt has non-whitespace content.
 *   6. Dialog — newline collapse: `'line one\n  line two'` produces an
 *      onSubmit call whose prompt is `'line one line two'`.
 *   7. Dialog — reset on close: fill the form, close via onOpenChange(false),
 *      reopen — fields are empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { RalphLoopDialog, buildRalphLoopCommand } from '../RalphLoopDialog';

describe('buildRalphLoopCommand', () => {
  // Test 1: prompt only
  it('should return /ralph-loop "the prompt" with no flags when only prompt is provided', () => {
    expect(buildRalphLoopCommand({ prompt: 'the prompt' })).toBe(
      '/ralph-loop "the prompt"'
    );
  });

  // Test 2: shell-escape — each of `"`, `\`, `$`, and backtick is escaped
  describe('shell-escape', () => {
    it('should escape a double quote with exactly one backslash', () => {
      // Input prompt: a"b (3 chars: a, ", b)
      // Expected output: /ralph-loop "a\"b"
      expect(buildRalphLoopCommand({ prompt: 'a"b' })).toBe(
        '/ralph-loop "a\\"b"'
      );
    });

    it('should escape a backslash with exactly one backslash', () => {
      // Input prompt: a\b (3 chars: a, \, b)
      // Expected output: /ralph-loop "a\\b"
      expect(buildRalphLoopCommand({ prompt: 'a\\b' })).toBe(
        '/ralph-loop "a\\\\b"'
      );
    });

    it('should escape a dollar sign with exactly one backslash', () => {
      // Input prompt: a$b (3 chars: a, $, b)
      // Expected output: /ralph-loop "a\$b"
      expect(buildRalphLoopCommand({ prompt: 'a$b' })).toBe(
        '/ralph-loop "a\\$b"'
      );
    });

    it('should escape a backtick with exactly one backslash', () => {
      // Input prompt: a`b (3 chars: a, `, b)
      // Expected output: /ralph-loop "a\`b"
      expect(buildRalphLoopCommand({ prompt: 'a`b' })).toBe(
        '/ralph-loop "a\\`b"'
      );
    });

    it('should escape all four meaningful characters when combined', () => {
      // Composite check using all four characters in one prompt.
      expect(
        buildRalphLoopCommand({ prompt: 'fix `bug` and "test" with $VAR \\path' })
      ).toBe(
        '/ralph-loop "fix \\`bug\\` and \\"test\\" with \\$VAR \\\\path"'
      );
    });
  });

  // Test 3: maxIterations gating
  describe('maxIterations gating', () => {
    it('should include --max-iterations 5 when maxIterations is 5', () => {
      expect(buildRalphLoopCommand({ prompt: 'p', maxIterations: 5 })).toBe(
        '/ralph-loop "p" --max-iterations 5'
      );
    });

    it('should omit the flag when maxIterations is 0', () => {
      expect(buildRalphLoopCommand({ prompt: 'p', maxIterations: 0 })).toBe(
        '/ralph-loop "p"'
      );
    });

    it('should omit the flag when maxIterations is NaN', () => {
      expect(
        buildRalphLoopCommand({ prompt: 'p', maxIterations: Number.NaN })
      ).toBe('/ralph-loop "p"');
    });

    it('should omit the flag when maxIterations is -1', () => {
      expect(buildRalphLoopCommand({ prompt: 'p', maxIterations: -1 })).toBe(
        '/ralph-loop "p"'
      );
    });

    it('should omit the flag when maxIterations is Infinity', () => {
      expect(
        buildRalphLoopCommand({ prompt: 'p', maxIterations: Number.POSITIVE_INFINITY })
      ).toBe('/ralph-loop "p"');
    });

    it('should floor 3.7 to 3', () => {
      expect(buildRalphLoopCommand({ prompt: 'p', maxIterations: 3.7 })).toBe(
        '/ralph-loop "p" --max-iterations 3'
      );
    });

    it('should omit the flag when maxIterations is undefined', () => {
      expect(buildRalphLoopCommand({ prompt: 'p' })).toBe('/ralph-loop "p"');
    });
  });

  // Test 4: completionPromise gating
  describe('completionPromise gating', () => {
    it('should add --completion-promise with a shell-quoted value when non-empty', () => {
      expect(
        buildRalphLoopCommand({ prompt: 'p', completionPromise: 'done' })
      ).toBe('/ralph-loop "p" --completion-promise "done"');
    });

    it('should shell-quote special characters in completionPromise', () => {
      expect(
        buildRalphLoopCommand({
          prompt: 'p',
          completionPromise: 'value with "quotes" and $VAR'
        })
      ).toBe('/ralph-loop "p" --completion-promise "value with \\"quotes\\" and \\$VAR"');
    });

    it('should omit the flag when completionPromise is whitespace-only', () => {
      expect(
        buildRalphLoopCommand({ prompt: 'p', completionPromise: '   ' })
      ).toBe('/ralph-loop "p"');
    });

    it('should omit the flag when completionPromise is empty string', () => {
      expect(
        buildRalphLoopCommand({ prompt: 'p', completionPromise: '' })
      ).toBe('/ralph-loop "p"');
    });

    it('should omit the flag when completionPromise is undefined', () => {
      expect(buildRalphLoopCommand({ prompt: 'p' })).toBe('/ralph-loop "p"');
    });
  });
});

describe('RalphLoopDialog', () => {
  const mockOnOpenChange = vi.fn();
  const mockOnSubmit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 5: Run button disabled state
  describe('Run button disabled state', () => {
    it('should disable the Run button when the prompt is empty', async () => {
      render(
        <RalphLoopDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          onSubmit={mockOnSubmit}
        />
      );

      await waitFor(() => {
        const runButton = screen.getByRole('button', { name: 'Run' });
        expect(runButton).toBeDisabled();
      });
    });

    it('should disable the Run button when the prompt is whitespace-only', async () => {
      render(
        <RalphLoopDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          onSubmit={mockOnSubmit}
        />
      );

      const promptInput = screen.getByLabelText(/prompt/i);
      fireEvent.change(promptInput, { target: { value: '   \n  \t  ' } });

      await waitFor(() => {
        const runButton = screen.getByRole('button', { name: 'Run' });
        expect(runButton).toBeDisabled();
      });
    });

    it('should enable the Run button once the prompt has non-whitespace content', async () => {
      render(
        <RalphLoopDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          onSubmit={mockOnSubmit}
        />
      );

      const promptInput = screen.getByLabelText(/prompt/i);
      fireEvent.change(promptInput, { target: { value: 'Fix failing tests' } });

      await waitFor(() => {
        const runButton = screen.getByRole('button', { name: 'Run' });
        expect(runButton).toBeEnabled();
      });
    });

    it('should disable the Run button again when the prompt is cleared', async () => {
      render(
        <RalphLoopDialog
          open={true}
          onOpenChange={mockOnOpenChange}
          onSubmit={mockOnSubmit}
        />
      );

      const promptInput = screen.getByLabelText(/prompt/i);
      fireEvent.change(promptInput, { target: { value: 'Fix failing tests' } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
      });

      fireEvent.change(promptInput, { target: { value: '' } });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
      });
    });
  });

  // Test 6: Newline collapse
  it('should collapse internal newlines into single spaces before calling onSubmit', async () => {
    render(
      <RalphLoopDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
      />
    );

    const promptInput = screen.getByLabelText(/prompt/i);
    fireEvent.change(promptInput, { target: { value: 'line one\n  line two' } });

    const runButton = screen.getByRole('button', { name: 'Run' });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(mockOnSubmit).toHaveBeenCalledTimes(1);
    });

    expect(mockOnSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'line one line two'
      })
    );
  });

  // Test 7: Reset on close
  it('should reset form fields when the dialog is closed and reopened', async () => {
    const { rerender } = render(
      <RalphLoopDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
      />
    );

    // Fill all three fields
    const promptInput = screen.getByLabelText(/prompt/i);
    fireEvent.change(promptInput, { target: { value: 'My prompt' } });

    const maxIterationsInput = screen.getByLabelText(/max iterations/i);
    fireEvent.change(maxIterationsInput, { target: { value: '10' } });

    const completionInput = screen.getByLabelText(/completion promise/i);
    fireEvent.change(completionInput, { target: { value: 'tests pass' } });

    await waitFor(() => {
      expect(promptInput).toHaveValue('My prompt');
      expect(maxIterationsInput).toHaveValue(10);
      expect(completionInput).toHaveValue('tests pass');
    });

    // Close the dialog via Cancel button — this invokes handleOpenChange(false)
    // which performs the reset in the component's internal state.
    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(mockOnOpenChange).toHaveBeenCalledWith(false);

    // Simulate the parent reacting to onOpenChange(false) by re-rendering with
    // open={false}, then reopening with open={true}.
    rerender(
      <RalphLoopDialog
        open={false}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
      />
    );

    rerender(
      <RalphLoopDialog
        open={true}
        onOpenChange={mockOnOpenChange}
        onSubmit={mockOnSubmit}
      />
    );

    // All fields should be empty after reopen
    await waitFor(() => {
      expect(screen.getByLabelText(/prompt/i)).toHaveValue('');
      expect(screen.getByLabelText(/max iterations/i)).toHaveValue(null);
      expect(screen.getByLabelText(/completion promise/i)).toHaveValue('');
    });
  });
});
