import { describe, it, expect } from 'vitest';
import { buildRemoteProcessSet, DEFAULT_REMOTE_PROCESSES } from '../terminal';

describe('buildRemoteProcessSet', () => {
  it('returns defaults when no custom input', () => {
    const result = buildRemoteProcessSet();
    expect(result).toBe(DEFAULT_REMOTE_PROCESSES);
    expect(result.has('ssh')).toBe(true);
    expect(result.has('mosh')).toBe(true);
    expect(result.has('tmux')).toBe(true);
    expect(result.has('screen')).toBe(true);
    expect(result.size).toBe(4);
  });

  it('merges custom entries with defaults', () => {
    const result = buildRemoteProcessSet(['rdev', 'autossh']);
    expect(result.has('ssh')).toBe(true);
    expect(result.has('mosh')).toBe(true);
    expect(result.has('tmux')).toBe(true);
    expect(result.has('screen')).toBe(true);
    expect(result.has('rdev')).toBe(true);
    expect(result.has('autossh')).toBe(true);
    expect(result.size).toBe(6);
  });

  it('normalizes input: trims whitespace, lowercases, filters empty strings', () => {
    const result = buildRemoteProcessSet(['  SSH ', '', '  ']);
    // Should contain only the 4 defaults (SSH normalizes to ssh which is already a default,
    // empty and whitespace-only entries are filtered out)
    expect(result.has('ssh')).toBe(true);
    expect(result.has('mosh')).toBe(true);
    expect(result.has('tmux')).toBe(true);
    expect(result.has('screen')).toBe(true);
    expect(result.size).toBe(4);
  });

  it('handles undefined input and returns defaults', () => {
    const result = buildRemoteProcessSet(undefined);
    expect(result).toBe(DEFAULT_REMOTE_PROCESSES);
    expect(result.has('ssh')).toBe(true);
    expect(result.has('mosh')).toBe(true);
    expect(result.has('tmux')).toBe(true);
    expect(result.has('screen')).toBe(true);
    expect(result.size).toBe(4);
  });
});
