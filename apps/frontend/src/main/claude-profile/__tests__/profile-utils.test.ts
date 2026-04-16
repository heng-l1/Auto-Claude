/**
 * Unit tests for syncUserConfigToProfile
 *
 * Tests cover:
 * - Syncs mcpServers from user to profile
 * - Syncs projects from user to profile
 * - Profile MCPs win on collision
 * - Profile projects win on collision
 * - Noop when configDir is DEFAULT_CLAUDE_CONFIG_DIR
 * - Noop when user config has no mcpServers or projects
 * - Noop when already synced (byte-identical)
 * - Error on missing user config
 * - Error on corrupt non-empty profile config
 * - Creates profile .claude.json from {} if missing
 * - Does not sync oauthAccount/userID/caches
 * - Correct mcpsAdded and projectsAdded counts
 * - Atomic write integrity (no partial files)
 *
 * All tests use isolated temp directories — never touch real ~/.claude.json.
 * os.homedir() is mocked so DEFAULT_CLAUDE_CONFIG_DIR points to a temp sandbox.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Module-level state — set fresh in beforeEach so each test has an isolated sandbox
let FAKE_HOME: string;

// Mock os.homedir() so DEFAULT_CLAUDE_CONFIG_DIR resolves into our test sandbox.
// We use importOriginal to preserve tmpdir() and other os functions used above.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn(() => FAKE_HOME),
  };
});

describe('syncUserConfigToProfile', () => {
  let userConfigDir: string;      // FAKE_HOME/.claude (= DEFAULT_CLAUDE_CONFIG_DIR)
  let userConfigPath: string;     // FAKE_HOME/.claude.json (at home root, not inside .claude/)
  let profileConfigDir: string;   // FAKE_HOME/.claude-profiles/work
  let profileConfigPath: string;  // FAKE_HOME/.claude-profiles/work/.claude.json

  beforeEach(() => {
    // Create a unique temp sandbox so tests don't collide when run in parallel
    FAKE_HOME = mkdtempSync(path.join(tmpdir(), 'sync-test-'));
    userConfigDir = path.join(FAKE_HOME, '.claude');
    userConfigPath = path.join(FAKE_HOME, '.claude.json');
    profileConfigDir = path.join(FAKE_HOME, '.claude-profiles', 'work');
    profileConfigPath = path.join(profileConfigDir, '.claude.json');

    mkdirSync(userConfigDir, { recursive: true });
    mkdirSync(profileConfigDir, { recursive: true });

    // Re-import profile-utils on each test so DEFAULT_CLAUDE_CONFIG_DIR
    // picks up the fresh FAKE_HOME via the mocked homedir()
    vi.resetModules();
  });

  afterEach(() => {
    if (FAKE_HOME && existsSync(FAKE_HOME)) {
      rmSync(FAKE_HOME, { recursive: true, force: true });
    }
  });

  describe('merge semantics', () => {
    it('syncs mcpServers from user to profile', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {
            captain: { command: 'captain', args: [] },
            glean: { command: 'glean', args: ['auth'] },
          },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      if (result.status === 'synced') {
        expect(result.profileId).toBe('work');
        expect(result.mcpsAdded).toBe(2);
        expect(result.projectsAdded).toBe(0);
      }

      expect(existsSync(profileConfigPath)).toBe(true);
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      expect(profileData.mcpServers).toEqual({
        captain: { command: 'captain', args: [] },
        glean: { command: 'glean', args: ['auth'] },
      });
    });

    it('syncs projects from user to profile', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          projects: {
            '/home/me/project-a': { trust: true, allowedTools: ['read'] },
            '/home/me/project-b': { trust: false, allowedTools: [] },
          },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      if (result.status === 'synced') {
        expect(result.mcpsAdded).toBe(0);
        expect(result.projectsAdded).toBe(2);
      }

      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      expect(profileData.projects).toEqual({
        '/home/me/project-a': { trust: true, allowedTools: ['read'] },
        '/home/me/project-b': { trust: false, allowedTools: [] },
      });
    });

    it('preserves profile MCPs on collision (profile wins)', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {
            foo: { command: 'user-foo', args: ['--user'] },
            bar: { command: 'user-bar', args: [] },
          },
        }),
      );
      writeFileSync(
        profileConfigPath,
        JSON.stringify({
          mcpServers: {
            foo: { command: 'profile-foo', args: ['--profile'] },
          },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      // Profile's foo must win — user's foo must NOT overwrite it
      expect(profileData.mcpServers.foo).toEqual({
        command: 'profile-foo',
        args: ['--profile'],
      });
      // User's bar must be added since profile didn't have it
      expect(profileData.mcpServers.bar).toEqual({
        command: 'user-bar',
        args: [],
      });
    });

    it('preserves profile projects on collision (profile wins)', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          projects: {
            '/x': { trust: true, note: 'user' },
            '/y': { trust: false, note: 'user' },
          },
        }),
      );
      writeFileSync(
        profileConfigPath,
        JSON.stringify({
          projects: {
            '/x': { trust: false, note: 'profile' },
          },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      // Profile's /x must win
      expect(profileData.projects['/x']).toEqual({ trust: false, note: 'profile' });
      // User's /y must be added since profile didn't have it
      expect(profileData.projects['/y']).toEqual({ trust: false, note: 'user' });
    });

    it('returns correct mcpsAdded and projectsAdded counts', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {
            a: { command: 'a' },
            b: { command: 'b' },
            c: { command: 'c' }, // collides with profile
          },
          projects: {
            '/p1': { trust: true },
            '/p2': { trust: false }, // collides with profile
          },
        }),
      );
      writeFileSync(
        profileConfigPath,
        JSON.stringify({
          mcpServers: {
            c: { command: 'profile-c' },
          },
          projects: {
            '/p2': { trust: true },
          },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      if (result.status === 'synced') {
        // 2 new MCPs added (a and b); c was a collision
        expect(result.mcpsAdded).toBe(2);
        // 1 new project added (/p1); /p2 was a collision
        expect(result.projectsAdded).toBe(1);
      }
    });

    it('preserves non-sync fields in the profile config', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );
      writeFileSync(
        profileConfigPath,
        JSON.stringify({
          oauthAccount: { emailAddress: 'work@example.com' },
          someProfileField: 'keep-me',
          numShellStartups: 42,
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      // All existing profile fields must be preserved
      expect(profileData.oauthAccount).toEqual({ emailAddress: 'work@example.com' });
      expect(profileData.someProfileField).toBe('keep-me');
      expect(profileData.numShellStartups).toBe(42);
      // And the sync field was added
      expect(profileData.mcpServers).toEqual({ foo: { command: 'foo' } });
    });
  });

  describe('skip conditions (noop)', () => {
    it('returns noop/same-config when profileConfigDir is DEFAULT_CLAUDE_CONFIG_DIR', async () => {
      const { syncUserConfigToProfile, DEFAULT_CLAUDE_CONFIG_DIR } = await import(
        '../profile-utils'
      );

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );

      const result = syncUserConfigToProfile('default', DEFAULT_CLAUDE_CONFIG_DIR);

      expect(result.status).toBe('noop');
      if (result.status === 'noop') {
        expect(result.profileId).toBe('default');
        expect(result.reason).toBe('same-config');
      }
      // Must not have written a sibling file or touched anything
      // (the user config itself is untouched — same-config means skip entirely)
    });

    it('returns noop/no-user-content when user config has no mcpServers or projects', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          oauthAccount: { emailAddress: 'me@example.com' },
          userID: 'abc-123',
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('noop');
      if (result.status === 'noop') {
        expect(result.reason).toBe('no-user-content');
      }
      // Profile file must not have been created
      expect(existsSync(profileConfigPath)).toBe(false);
    });

    it('returns noop/no-user-content when mcpServers and projects are both empty objects', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: {},
          projects: {},
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('noop');
      if (result.status === 'noop') {
        expect(result.reason).toBe('no-user-content');
      }
    });

    it('returns noop/already-synced when nothing would change', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );

      // First sync — writes the file
      const first = syncUserConfigToProfile('work', profileConfigDir);
      expect(first.status).toBe('synced');

      // Second sync with identical inputs — should be a noop
      const second = syncUserConfigToProfile('work', profileConfigDir);
      expect(second.status).toBe('noop');
      if (second.status === 'noop') {
        expect(second.reason).toBe('already-synced');
      }
    });
  });

  describe('error handling', () => {
    it('returns error when user config is missing', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      // Note: user config file NOT created

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.profileId).toBe('work');
        expect(result.message).toMatch(/not found/i);
      }
    });

    it('reads user config from ~/.claude.json (home root), not ~/.claude/.claude.json', async () => {
      // Regression guard: Claude Code CLI stores its user-level config at ~/.claude.json
      // (sibling to the ~/.claude/ data directory), not inside it. If this function
      // mistakenly reads from ~/.claude/.claude.json, every sync fails with
      // "User config not found" even when the real config exists.
      const { syncUserConfigToProfile } = await import('../profile-utils');

      // Place a config ONLY at the wrong location (inside ~/.claude/)
      writeFileSync(
        path.join(FAKE_HOME, '.claude', '.claude.json'),
        JSON.stringify({ mcpServers: { wrong: { command: 'wrong' } } }),
      );
      // Leave the correct location (FAKE_HOME/.claude.json) absent

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.message).toMatch(/not found/i);
      }
    });

    it('returns error when user config is invalid JSON', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(userConfigPath, '{not valid json');

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.message).toMatch(/valid json/i);
      }
    });

    it('returns error when profile config is non-empty but unparseable', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );
      // Corrupt profile config (non-empty, invalid JSON)
      writeFileSync(profileConfigPath, '{corrupt json');

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect(result.message).toMatch(/profile config/i);
      }

      // Must not clobber the corrupt file with a new write
      expect(readFileSync(profileConfigPath, 'utf-8')).toBe('{corrupt json');
    });

    it('never throws — even with pathological inputs, returns a structured SyncResult', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      // No user config, no profile config — should still return an error, not throw
      expect(() => {
        const result = syncUserConfigToProfile('work', profileConfigDir);
        expect(result.status).toBe('error');
      }).not.toThrow();
    });
  });

  describe('file creation', () => {
    it('creates profile .claude.json from {} when missing', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
          projects: { '/p': { trust: true } },
        }),
      );

      // Profile .claude.json does NOT exist yet — only the dir
      expect(existsSync(profileConfigPath)).toBe(false);

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      expect(existsSync(profileConfigPath)).toBe(true);

      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      // Only the synced fields from user should exist — nothing more
      expect(Object.keys(profileData).sort()).toEqual(['mcpServers', 'projects']);
      expect(profileData.mcpServers).toEqual({ foo: { command: 'foo' } });
      expect(profileData.projects).toEqual({ '/p': { trust: true } });
    });

    it('treats an empty file as {} and still writes synced content', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );
      // Profile config exists but is empty
      writeFileSync(profileConfigPath, '');

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      expect(profileData.mcpServers).toEqual({ foo: { command: 'foo' } });
    });
  });

  describe('allowlist enforcement', () => {
    it('does not sync oauthAccount, userID, or caches from user config', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
          projects: { '/p': { trust: true } },
          // These fields must NOT be synced to the profile:
          oauthAccount: { emailAddress: 'user@example.com', accountUuid: 'u-1' },
          userID: 'user-id-secret',
          firstStartTime: '2026-01-01T00:00:00.000Z',
          numShellStartups: 999,
          cachedChangelog: 'some-cached-data',
          cachedStatsigGates: { gate: true },
          subscriptionNoticeCount: 3,
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      // Only allowlisted fields must be present on a freshly-created profile
      expect(Object.keys(profileData).sort()).toEqual(['mcpServers', 'projects']);
      // Explicitly assert each non-allowlisted field is absent
      expect(profileData.oauthAccount).toBeUndefined();
      expect(profileData.userID).toBeUndefined();
      expect(profileData.firstStartTime).toBeUndefined();
      expect(profileData.numShellStartups).toBeUndefined();
      expect(profileData.cachedChangelog).toBeUndefined();
      expect(profileData.cachedStatsigGates).toBeUndefined();
      expect(profileData.subscriptionNoticeCount).toBeUndefined();
    });

    it('does not overwrite profile oauthAccount even when user also has oauthAccount', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
          oauthAccount: { emailAddress: 'user@example.com' },
        }),
      );
      writeFileSync(
        profileConfigPath,
        JSON.stringify({
          oauthAccount: { emailAddress: 'work@example.com', accountUuid: 'work-id' },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);

      expect(result.status).toBe('synced');
      const profileData = JSON.parse(readFileSync(profileConfigPath, 'utf-8'));
      // Profile's oauthAccount must be untouched
      expect(profileData.oauthAccount).toEqual({
        emailAddress: 'work@example.com',
        accountUuid: 'work-id',
      });
    });
  });

  describe('atomic write integrity', () => {
    it('leaves no .tmp.* files in the profile directory after a successful sync', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
          projects: { '/p': { trust: true } },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);
      expect(result.status).toBe('synced');

      // Atomic write should have renamed the temp file away — no .tmp.* leftovers
      const entries = readdirSync(profileConfigDir);
      const tempFiles = entries.filter((f) => f.includes('.tmp.'));
      expect(tempFiles).toEqual([]);

      // Only the expected file should remain
      expect(entries).toContain('.claude.json');
    });

    it('produces a well-formed, parseable JSON file with 2-space indentation', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );

      const result = syncUserConfigToProfile('work', profileConfigDir);
      expect(result.status).toBe('synced');

      const raw = readFileSync(profileConfigPath, 'utf-8');
      // Must parse without throwing
      expect(() => JSON.parse(raw)).not.toThrow();
      // Must use 2-space indentation to match Claude Code's convention
      expect(raw).toContain('\n  "mcpServers"');
    });

    it('does not corrupt the profile file when called repeatedly', async () => {
      const { syncUserConfigToProfile } = await import('../profile-utils');

      writeFileSync(
        userConfigPath,
        JSON.stringify({
          mcpServers: { foo: { command: 'foo' } },
        }),
      );

      // Run 5 syncs back-to-back — file must remain valid JSON after each
      for (let i = 0; i < 5; i++) {
        const result = syncUserConfigToProfile('work', profileConfigDir);
        expect(['synced', 'noop']).toContain(result.status);

        const content = readFileSync(profileConfigPath, 'utf-8');
        expect(() => JSON.parse(content)).not.toThrow();
      }

      // After repeated syncs, no leftover temp files
      const entries = readdirSync(profileConfigDir);
      expect(entries.filter((f) => f.includes('.tmp.'))).toEqual([]);
    });
  });
});
