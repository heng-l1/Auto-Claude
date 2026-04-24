import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAPIProfileEnv = vi.fn();
const mockGetOAuthModeClearVars = vi.fn();
const mockGetPythonEnv = vi.fn();
const mockGetBestAvailableProfileEnv = vi.fn();
const mockGetGitHubTokenForSubprocess = vi.fn();
const mockGetAugmentedEnv = vi.fn();

vi.mock('../../../../services/profile', () => ({
  getAPIProfileEnv: (...args: unknown[]) => mockGetAPIProfileEnv(...args),
}));

// Mock getAugmentedEnv from src/main/env-utils. buildAugmentedPythonEnv calls it
// internally, so mocking here gives us a deterministic augmented PATH to assert against
// without depending on the host shell's real PATH resolution.
vi.mock('../../../../env-utils', () => ({
  getAugmentedEnv: () => mockGetAugmentedEnv(),
}));

// Partial mock of agent/env-utils: keep the real buildAugmentedPythonEnv (so the real
// PATH merge + casing normalization logic exercises under test), but override
// getOAuthModeClearVars with the test spy.
vi.mock('../../../../agent/env-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../agent/env-utils')>();
  return {
    ...actual,
    getOAuthModeClearVars: (...args: unknown[]) => mockGetOAuthModeClearVars(...args),
  };
});

vi.mock('../../../../python-env-manager', () => ({
  pythonEnvManager: {
    getPythonEnv: () => mockGetPythonEnv(),
  },
}));

vi.mock('../../../../rate-limit-detector', () => ({
  getBestAvailableProfileEnv: () => mockGetBestAvailableProfileEnv(),
}));

// Mock getGitHubTokenForSubprocess to avoid calling gh CLI in tests
// Path is relative to the module being mocked (runner-env.ts), which imports from '../utils'
vi.mock('../../utils', () => ({
  getGitHubTokenForSubprocess: () => mockGetGitHubTokenForSubprocess(),
}));

vi.mock('../../../../cli-tool-manager', () => ({
  getToolInfo: () => ({ found: false, path: undefined, source: undefined }),
}));

vi.mock('../../../../sentry', () => ({
  getSentryEnvForSubprocess: () => ({}),
  safeBreadcrumb: () => {},
}));

import { getRunnerEnv } from '../runner-env';

describe('getRunnerEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for augmented env - deterministic PATH so assertions can verify
    // that subprocess env includes the login-shell PATH entries.
    mockGetAugmentedEnv.mockReturnValue({ PATH: '/mock/augmented:/usr/bin' });
    // Default mock for Python env - minimal env for testing
    mockGetPythonEnv.mockReturnValue({
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: '/bundled/site-packages',
    });
    // Default mock for profile env - returns BestProfileEnvResult format
    mockGetBestAvailableProfileEnv.mockReturnValue({
      env: {},
      profileId: 'default',
      profileName: 'Default',
      wasSwapped: false
    });
    // Default mock for GitHub token - returns null (no token) by default
    mockGetGitHubTokenForSubprocess.mockResolvedValue(null);
  });

  it('merges Python env with API profile env and OAuth clear vars', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    mockGetOAuthModeClearVars.mockReturnValue({
      ANTHROPIC_AUTH_TOKEN: '',
    });

    const result = await getRunnerEnv();

    expect(mockGetOAuthModeClearVars).toHaveBeenCalledWith({
      ANTHROPIC_AUTH_TOKEN: 'token',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
    // Python env is included first, then overridden by OAuth clear vars
    expect(result).toMatchObject({
      PYTHONPATH: '/bundled/site-packages',
      PYTHONDONTWRITEBYTECODE: '1',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'https://api.example.com',
    });
  });

  it('includes extra env values with highest precedence', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: 'token',
    });
    mockGetOAuthModeClearVars.mockReturnValue({});

    const result = await getRunnerEnv({ USE_CLAUDE_MD: 'true' });

    expect(result).toMatchObject({
      PYTHONPATH: '/bundled/site-packages',
      ANTHROPIC_AUTH_TOKEN: 'token',
      USE_CLAUDE_MD: 'true',
    });
  });

  it('includes PYTHONPATH for bundled packages (fixes #139)', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    mockGetPythonEnv.mockReturnValue({
      PYTHONPATH: '/app/Contents/Resources/python-site-packages',
    });

    const result = await getRunnerEnv();

    expect(result.PYTHONPATH).toBe('/app/Contents/Resources/python-site-packages');
  });

  it('includes profileEnv for OAuth token (fixes #563)', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    mockGetBestAvailableProfileEnv.mockReturnValue({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-123' },
      profileId: 'default',
      profileName: 'Default',
      wasSwapped: false
    });

    const result = await getRunnerEnv();

    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-123');
  });

  it('applies correct precedence order with profileEnv overriding pythonEnv', async () => {
    mockGetPythonEnv.mockReturnValue({
      SHARED_VAR: 'from-python',
    });
    mockGetAPIProfileEnv.mockResolvedValue({
      SHARED_VAR: 'from-api-profile',
    });
    mockGetOAuthModeClearVars.mockReturnValue({});
    mockGetBestAvailableProfileEnv.mockReturnValue({
      env: { SHARED_VAR: 'from-profile' },
      profileId: 'default',
      profileName: 'Default',
      wasSwapped: false
    });

    const result = await getRunnerEnv({ SHARED_VAR: 'from-extra' });

    // extraEnv has highest precedence
    expect(result.SHARED_VAR).toBe('from-extra');
  });

  it('includes GitHub token from gh CLI when available (fixes #151)', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    mockGetGitHubTokenForSubprocess.mockResolvedValue('gh-token-123');

    const result = await getRunnerEnv();

    expect(result.GITHUB_TOKEN).toBe('gh-token-123');
  });

  it('omits GITHUB_TOKEN when gh CLI returns null', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    mockGetGitHubTokenForSubprocess.mockResolvedValue(null);

    const result = await getRunnerEnv();

    expect(result.GITHUB_TOKEN).toBeUndefined();
  });

  it('includes augmented PATH so locally-installed CLI tools are findable', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    // pythonEnv has no PATH — augmented PATH should surface untouched in the result.
    mockGetPythonEnv.mockReturnValue({
      PYTHONPATH: '/bundled/site-packages',
    });

    const result = await getRunnerEnv();

    expect(result.PATH).toContain('/mock/augmented');
  });

  it('prepends pythonEnv PATH entries to augmented PATH', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    // pythonEnv carries a leading python-specific path plus the augmented entry.
    // After the merge, python-specific entries should be prepended.
    mockGetPythonEnv.mockReturnValue({
      PATH: '/python-only:/mock/augmented',
    });

    const result = await getRunnerEnv();

    expect(result.PATH.startsWith('/python-only')).toBe(true);
  });

  it('normalizes Path/PATH casing', async () => {
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});
    // Simulate the Windows case where pythonEnv arrives with lowercase 'Path'.
    // After normalization inside buildAugmentedPythonEnv, the merged env must expose
    // exactly one uppercase 'PATH' key and zero 'Path' keys (regression guard #1661).
    mockGetPythonEnv.mockReturnValue({
      Path: '/lowercase-python-path',
    } as unknown as Record<string, string>);

    const result = await getRunnerEnv();

    const keys = Object.keys(result);
    expect(keys.filter(k => k === 'PATH')).toHaveLength(1);
    expect(keys.filter(k => k === 'Path')).toHaveLength(0);
  });

  it('apiProfileEnv precedence preserved over augmented env', async () => {
    // Augmented env exposes an ANTHROPIC_BASE_URL — apiProfileEnv must still win.
    mockGetAugmentedEnv.mockReturnValue({
      PATH: '/mock/augmented:/usr/bin',
      ANTHROPIC_BASE_URL: 'https://from-augmented',
    });
    mockGetAPIProfileEnv.mockResolvedValue({
      ANTHROPIC_BASE_URL: 'https://api.example.test',
    });
    mockGetOAuthModeClearVars.mockReturnValue({});

    const result = await getRunnerEnv();

    expect(result.ANTHROPIC_BASE_URL).toBe('https://api.example.test');
  });

  it('extraEnv retains highest precedence', async () => {
    // Every layer below extraEnv supplies a different PATH, yet extraEnv still wins.
    mockGetAugmentedEnv.mockReturnValue({ PATH: '/mock/augmented:/usr/bin' });
    mockGetPythonEnv.mockReturnValue({ PATH: '/python-only' });
    mockGetAPIProfileEnv.mockResolvedValue({});
    mockGetOAuthModeClearVars.mockReturnValue({});

    const result = await getRunnerEnv({ PATH: '/override' });

    expect(result.PATH).toBe('/override');
  });
});
