/**
 * MCP Server Pre-warm Service
 *
 * Primes stdio MCP servers at Electron startup so the first real session
 * does not incur cold-start overhead. Reads the user's MCP config, spawns
 * each stdio entry once with an augmented login-shell PATH, lets it
 * initialize for a short warm-up window, and then gracefully shuts it down.
 *
 * The service is strictly fire-and-forget: missing config, malformed JSON,
 * spawn failures, and missing binaries are all swallowed. At most one
 * console.warn is emitted per unexpected exception.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAugmentedEnv } from '../env-utils';
import { isWindows } from '../platform';

/**
 * Warm-up window (ms) before a graceful termination signal is sent.
 */
const WARMUP_WINDOW_MS = 10_000;

/**
 * Deadline (ms) after which any surviving child is force-killed.
 */
const FORCE_KILL_DEADLINE_MS = 12_000;

/**
 * Tracks a spawned child and whether its 'exit' event has already fired.
 * Used to short-circuit the SIGKILL escalation when the child has already
 * terminated from SIGTERM.
 */
interface TrackedChild {
  child: ChildProcess;
  hasExited: boolean;
}

/**
 * Spawn every configured stdio MCP server once to prime caches, then shut
 * them down after a brief warm-up window.
 *
 * This is strictly fire-and-forget. Any error (missing config, malformed
 * JSON, spawn failure, ENOENT) is swallowed silently; at most one
 * console.warn is emitted when an unexpected exception escapes the inner
 * guards.
 */
export async function preWarmStdioMcpServers(): Promise<void> {
  try {
    const configPath = join(
      process.env.CLAUDE_CONFIG_DIR ?? homedir(),
      '.claude.json'
    );

    let data: unknown;
    try {
      if (!existsSync(configPath)) {
        return;
      }
      const content = readFileSync(configPath, 'utf-8');
      data = JSON.parse(content);
    } catch {
      // Missing or malformed config file: silent no-op.
      return;
    }

    const mcpServers = (data as { mcpServers?: unknown } | null | undefined)
      ?.mcpServers;
    if (!mcpServers || typeof mcpServers !== 'object') {
      return;
    }

    const tracked: TrackedChild[] = [];

    for (const config of Object.values(mcpServers as Record<string, unknown>)) {
      if (!config || typeof config !== 'object') continue;

      const cfg = config as Record<string, unknown>;

      // Strict opt-in: only entries with an explicit `type === 'stdio'` are
      // pre-warmed. Entries missing `type`, or set to `'command'`, `'http'`,
      // or `'sse'`, are skipped.
      if (cfg.type !== 'stdio') continue;
      if (typeof cfg.command !== 'string' || cfg.command.length === 0) continue;

      const command = cfg.command;
      const args = Array.isArray(cfg.args) ? (cfg.args as string[]) : [];
      const overrideEnv =
        cfg.env && typeof cfg.env === 'object'
          ? (cfg.env as Record<string, string>)
          : {};

      const child = spawn(command, args, {
        env: { ...getAugmentedEnv(), ...overrideEnv },
        stdio: ['pipe', 'ignore', 'ignore'],
      });

      // ENOENT and similar spawn failures are delivered as 'error' events,
      // not thrown. Attaching a no-op listener prevents an unhandled error
      // from crashing the main process.
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op; swallows spawn error events so the main process never crashes on ENOENT
      child.on('error', () => {});

      // Close stdin immediately so the server does not stall waiting on it.
      child.stdin?.end();

      const entry: TrackedChild = { child, hasExited: false };
      child.once('exit', () => {
        entry.hasExited = true;
      });

      tracked.push(entry);
    }

    // Graceful termination after the warm-up window.
    setTimeout(() => {
      for (const entry of tracked) {
        if (entry.hasExited) continue;
        try {
          if (isWindows()) {
            // Windows has no real POSIX signals; kill() with no argument is
            // the idiomatic graceful stop on this platform.
            entry.child.kill();
          } else {
            entry.child.kill('SIGTERM');
          }
        } catch {
          // Process already dead or detached; ignore.
        }
      }
    }, WARMUP_WINDOW_MS).unref();

    // Force termination for any child that has not exited and has not
    // already been killed by the graceful stage.
    setTimeout(() => {
      for (const entry of tracked) {
        if (entry.hasExited || entry.child.killed) continue;
        try {
          if (isWindows()) {
            // On Windows, kill() is idempotent and sufficient for leaf
            // processes — the pre-warm target is always a leaf.
            entry.child.kill();
          } else {
            entry.child.kill('SIGKILL');
          }
        } catch {
          // Process already dead; ignore.
        }
      }
    }, FORCE_KILL_DEADLINE_MS).unref();
  } catch (err) {
    console.warn('[MCP Pre-warm] unexpected failure:', err);
  }
}
