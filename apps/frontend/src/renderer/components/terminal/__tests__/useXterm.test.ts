/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for useXterm keyboard handlers
 * Tests terminal copy/paste keyboard shortcuts and platform detection
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { Mock } from 'vitest';
import { act, render } from '@testing-library/react';
import React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { useXterm } from '../useXterm';

// Mock xterm.js
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    loadAddon: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    input: vi.fn(),
    onData: vi.fn(),
    onResize: vi.fn(),
    dispose: vi.fn(),
    write: vi.fn(),
    onWriteParsed: vi.fn((_cb) => ({ dispose: vi.fn() })),
    clearTextureAtlas: vi.fn(),
    parser: {
      registerOscHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    selectAll: vi.fn(),
    clear: vi.fn(),
    cols: 80,
    rows: 24,
    options: {
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'monospace',
      fontWeight: 'normal',
      lineHeight: 1,
      letterSpacing: 0,
      theme: { cursorAccent: '#000000' },
      scrollback: 1000
    },
    refresh: vi.fn()
  }))
}));

// Mock xterm addons
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn()
  }))
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn()
}));

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(() => ({
    serialize: vi.fn(() => ''),
    dispose: vi.fn()
  }))
}));

// Mock terminal buffer manager
vi.mock('../../../../lib/terminal-buffer-manager', () => ({
  terminalBufferManager: {
    get: vi.fn(() => ''),
    getAndClear: vi.fn(() => ''),
    set: vi.fn(),
    clear: vi.fn()
  }
}));

// Mock WebGL context manager
const mockWebglRegister = vi.fn();
const mockWebglAcquire = vi.fn();
const mockWebglUnregister = vi.fn();
vi.mock('../../../lib/webgl-context-manager', () => ({
  webglContextManager: {
    register: (...args: unknown[]) => mockWebglRegister(...args),
    acquire: (...args: unknown[]) => mockWebglAcquire(...args),
    unregister: (...args: unknown[]) => mockWebglUnregister(...args),
  }
}));

// Mock settings store (for gpuAcceleration setting)
const mockSettingsStoreState = {
  settings: { gpuAcceleration: 'auto' as string | undefined }
};
vi.mock('../../../stores/settings-store', () => ({
  useSettingsStore: Object.assign(vi.fn(), {
    getState: () => mockSettingsStoreState,
    subscribe: vi.fn(() => vi.fn()),
  })
}));

// Mock terminal-store so Fix A tests can capture the writeCallback that useXterm
// registers via registerOutputCallback. Invoking it directly lets tests simulate
// PTY chunks arriving and assert on rAF-batched flush behavior.
// vi.hoisted ensures `terminalStoreMocks.state` exists before vi.mock factories run.
const terminalStoreMocks = vi.hoisted(() => ({
  state: { capturedWriteCallback: null as ((data: string) => void) | null },
}));
vi.mock('../../../stores/terminal-store', () => ({
  registerOutputCallback: (_id: string, cb: (data: string) => void) => {
    terminalStoreMocks.state.capturedWriteCallback = cb;
  },
  unregisterOutputCallback: () => {
    terminalStoreMocks.state.capturedWriteCallback = null;
  },
}));

// Mock navigator.platform for platform detection
const originalNavigatorPlatform = navigator.platform;

// Store original requestAnimationFrame for restoration after tests
const originalRequestAnimationFrame = global.requestAnimationFrame;
const originalCancelAnimationFrame = global.cancelAnimationFrame;

/**
 * Helper function to set up XTerm mocks and render the hook
 * Reduces test boilerplate from ~100 lines to ~20 lines per test
 */
async function setupMockXterm(overrides: {
  hasSelection?: () => boolean;
  getSelection?: () => string;
  paste?: ReturnType<typeof vi.fn>;
  input?: ReturnType<typeof vi.fn>;
} = {}) {
  let keyEventHandler: ((event: KeyboardEvent) => boolean) | null = null;

  // Override XTerm mock to be constructable
  (XTerm as unknown as Mock).mockImplementation(function() {
    return {
      open: vi.fn(),
      loadAddon: vi.fn(),
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        keyEventHandler = handler;
      }),
      hasSelection: overrides.hasSelection ?? vi.fn(() => false),
      getSelection: overrides.getSelection ?? vi.fn(() => ''),
      paste: overrides.paste ?? vi.fn(),
      input: overrides.input ?? vi.fn(),
      onData: vi.fn(),
      onResize: vi.fn(),
      dispose: vi.fn(),
      write: vi.fn(),
      onWriteParsed: vi.fn((_cb) => ({ dispose: vi.fn() })),
      clearTextureAtlas: vi.fn(),
      parser: {
        registerOscHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      },
      selectAll: vi.fn(),
      clear: vi.fn(),
      cols: 80,
      rows: 24,
      options: {
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 14,
        fontFamily: 'monospace',
        fontWeight: 'normal',
        lineHeight: 1,
        letterSpacing: 0,
        theme: { cursorAccent: '#000000' },
        scrollback: 1000
      },
      refresh: vi.fn()
    };
  });

  // Setup addon mocks
  const { FitAddon } = await import('@xterm/addon-fit');
  (FitAddon as unknown as Mock).mockImplementation(function() {
    return { fit: vi.fn() };
  });

  const { WebLinksAddon } = await import('@xterm/addon-web-links');
  (WebLinksAddon as unknown as Mock).mockImplementation(function() {
    return {};
  });

  const { SerializeAddon } = await import('@xterm/addon-serialize');
  (SerializeAddon as unknown as Mock).mockImplementation(function() {
    return {
      serialize: vi.fn(() => ''),
      dispose: vi.fn()
    };
  });

  // Mock ResizeObserver
  global.ResizeObserver = vi.fn().mockImplementation(function() {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn()
    };
  });

  // Create and render test wrapper component
  const TestWrapper = () => {
    const { terminalRef } = useXterm({ terminalId: 'test-terminal' });
    return React.createElement('div', { ref: terminalRef });
  };

  render(React.createElement(TestWrapper));

  // After rendering, keyEventHandler is guaranteed to be set by attachCustomKeyEventHandler
  // Use non-null assertion since we know the hook will set it
  return {
    keyEventHandler: keyEventHandler!,
    mockInstance: {
      hasSelection: overrides.hasSelection,
      getSelection: overrides.getSelection,
      paste: overrides.paste,
      input: overrides.input
    }
  };
}

describe('useXterm keyboard handlers', () => {
  let mockClipboard: {
    writeText: ReturnType<typeof vi.fn>;
    readText: ReturnType<typeof vi.fn>;
  };

  // Mock requestAnimationFrame for jsdom environment (not provided by default)
  // Isolated to this test file to prevent affecting other tests
  beforeAll(() => {
    global.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number);
    global.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
  });

  afterAll(() => {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  beforeEach(() => {
    // Use fake timers to control async behavior and prevent timer leaks
    vi.useFakeTimers();

    // Clear all mocks before each test
    vi.clearAllMocks();

    // Ensure window and navigator exist in test environment
    if (typeof window === 'undefined') {
      (global as { window: unknown }).window = {};
    }
    if (typeof navigator === 'undefined') {
      (global as { navigator: unknown }).navigator = {};
    }

    // Mock navigator.clipboard
    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue('test clipboard content')
    };

    Object.defineProperty(global.navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true
    });

    // Mock window.electronAPI
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTerminalInput: vi.fn()
    };
  });

  afterEach(() => {
    // Clear all pending timers before restoring mocks to prevent
    // "requestAnimationFrame is not defined" errors from delayed callbacks
    vi.clearAllTimers();
    vi.useRealTimers();

    vi.restoreAllMocks();
    // Reset navigator.platform to original value
    Object.defineProperty(navigator, 'platform', {
      value: originalNavigatorPlatform,
      writable: true
    });
  });

  describe('Platform detection', () => {
    it('should enable paste shortcuts on Windows (CTRL+V)', async () => {
      const mockPaste = vi.fn();

      // Mock Windows platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          shiftKey: false
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      // Windows should enable CTRL+V paste
      expect(mockPaste).toHaveBeenCalledWith('test clipboard content');
    });

    it('should enable paste shortcuts on Linux (both CTRL+V and CTRL+SHIFT+V)', async () => {
      const mockPaste = vi.fn();

      // Mock Linux platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      // Test CTRL+V
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          shiftKey: false
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockPaste).toHaveBeenCalledTimes(1);

      // Test CTRL+SHIFT+V (Linux-specific)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'V',
          ctrlKey: true,
          shiftKey: true
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockPaste).toHaveBeenCalledTimes(2);
    });

    it('should enable copy shortcuts on Linux (both CTRL+C and CTRL+SHIFT+C)', async () => {
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      // Mock Linux platform
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      // Test CTRL+C (should copy)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          shiftKey: false
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledTimes(1);

      // Test CTRL+SHIFT+C (Linux-specific, should also copy)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledTimes(2);
    });

    it('should NOT enable custom paste handler on macOS (uses system Cmd+V)', async () => {
      const mockPaste = vi.fn();

      // Mock macOS platform
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true,
          shiftKey: false
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      // macOS should NOT use custom CTRL+V handler (uses system Cmd+V instead)
      expect(mockPaste).not.toHaveBeenCalled();
    });
  });

  describe('Smart CTRL+C behavior', () => {
    it('should copy to clipboard when text is selected', async () => {
      // Create mock functions that will be shared between the mock instance and our assertions
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        // Simulate CTRL+C keydown event
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          metaKey: false
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false); // Should prevent xterm handling

        // Wait for clipboard write
        await vi.advanceTimersByTimeAsync(0);
      });

      // Verify the xterm instance methods were called
      expect(mockHasSelection).toHaveBeenCalled();
      expect(mockGetSelection).toHaveBeenCalled();

      // Verify clipboard.writeText was called with selected text
      expect(mockClipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    it('should send ^C interrupt when no text is selected', async () => {
      const mockHasSelection = vi.fn(() => false);
      const mockGetSelection = vi.fn(() => '');

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        // Simulate CTRL+C keydown event with no selection
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          metaKey: false
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(true); // Should let ^C pass through to terminal
      });

      // Verify clipboard.writeText was NOT called
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });

    it('should handle both ctrlKey (Windows/Linux) and metaKey (Mac)', async () => {
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      // Test ctrlKey (Windows/Linux)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
          // Wait for clipboard write
          await vi.advanceTimersByTimeAsync(0);
        }
      });

      // Test metaKey (Mac)
      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: false,
          metaKey: true
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
          // Wait for clipboard write
          await vi.advanceTimersByTimeAsync(0);
        }
      });

      // Both should trigger clipboard write
      expect(mockClipboard.writeText).toHaveBeenCalledTimes(2);
    });
  });

  describe('CTRL+V paste behavior', () => {
    it('should paste clipboard content on Windows', async () => {
      const mockPaste = vi.fn();

      // Mock Windows platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true
        });

        if (keyEventHandler) {
          const handled = keyEventHandler?.(event);
          expect(handled).toBe(false); // Should prevent literal ^V

          // Wait for clipboard read and paste
          await vi.advanceTimersByTimeAsync(0);
        }
      });

      // Verify clipboard read and paste
      expect(mockClipboard.readText).toHaveBeenCalled();
      expect(mockPaste).toHaveBeenCalledWith('test clipboard content');
    });

    it('should paste clipboard content on Linux', async () => {
      const mockPaste = vi.fn();

      // Mock Linux platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.readText).toHaveBeenCalled();
      expect(mockPaste).toHaveBeenCalledWith('test clipboard content');
    });

    it('should NOT paste on macOS (Cmd+V should work through existing handlers)', async () => {
      const mockPaste = vi.fn();

      // Mock macOS platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        // On Mac, this would be Cmd+V which is metaKey
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true, // ctrlKey, not metaKey
          metaKey: false
        });

        // On Mac, ctrlKey+V should NOT trigger paste (only Cmd+V works)
        keyEventHandler(event);
      });

      // Should not paste for ctrlKey+V on Mac
      expect(mockClipboard.readText).not.toHaveBeenCalled();
      expect(mockPaste).not.toHaveBeenCalled();
    });
  });

  describe('Linux CTRL+SHIFT+C copy shortcut', () => {
    it('should copy on Linux when CTRL+SHIFT+C is pressed', async () => {
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      // Mock Linux platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.writeText).toHaveBeenCalledWith('selected text');
    });

    it('should not trigger CTRL+SHIFT+C on Windows', async () => {
      // Mock Windows platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: vi.fn(() => false),
        getSelection: vi.fn(() => '')
      });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'C',
          ctrlKey: true,
          shiftKey: true
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
        }
      });

      // Should not copy on Windows
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });
  });

  describe('Linux CTRL+SHIFT+V paste shortcut', () => {
    it('should paste on Linux when CTRL+SHIFT+V is pressed', async () => {
      const mockPaste = vi.fn();

      // Mock Linux platform (navigator)
      Object.defineProperty(navigator, 'platform', {
        value: 'Linux',
        writable: true
      });

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'V',
          ctrlKey: true,
          shiftKey: true
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false);

        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockClipboard.readText).toHaveBeenCalled();
      expect(mockPaste).toHaveBeenCalledWith('test clipboard content');
    });
  });

  describe('Clipboard error handling', () => {
    it('should handle clipboard write errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockHasSelection = vi.fn(() => true);
      const mockGetSelection = vi.fn(() => 'selected text');

      // Mock clipboard write failure
      mockClipboard.writeText = vi.fn().mockRejectedValue(new Error('Clipboard write failed'));

      const { keyEventHandler } = await setupMockXterm({
        hasSelection: mockHasSelection,
        getSelection: mockGetSelection
      });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      // Should log error but not throw
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[useXterm] Failed to copy selection:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should handle clipboard read errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockPaste = vi.fn();

      // Mock Windows platform to enable custom paste handler
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        writable: true
      });

      // Mock clipboard read failure
      mockClipboard.readText = vi.fn().mockRejectedValue(new Error('Clipboard read failed'));

      const { keyEventHandler } = await setupMockXterm({ paste: mockPaste });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'v',
          ctrlKey: true
        });

        keyEventHandler(event);
        await vi.advanceTimersByTimeAsync(0);
      });

      // Should log error but not throw
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[useXterm] Failed to read clipboard:',
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Existing shortcuts preservation', () => {
    it('should let SHIFT+Enter pass through', async () => {
      const mockInput = vi.fn();

      const { keyEventHandler } = await setupMockXterm({ input: mockInput });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          ctrlKey: false,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
        }
      });

      // Should send ESC+newline for multi-line input
      expect(mockInput).toHaveBeenCalledWith('\x1b\n');
    });

    it('should let Ctrl+Backspace pass through', async () => {
      const mockInput = vi.fn();

      const { keyEventHandler } = await setupMockXterm({ input: mockInput });

      await act(async () => {
        const event = new KeyboardEvent('keydown', {
          key: 'Backspace',
          ctrlKey: true,
          metaKey: false
        });

        if (keyEventHandler) {
          keyEventHandler?.(event);
        }
      });

      // Should send Ctrl+U for delete line
      expect(mockInput).toHaveBeenCalledWith('\x15');
    });

    it('should let Ctrl+1-9 pass through for project tab switching', async () => {
      const { keyEventHandler } = await setupMockXterm();

      // Test all number keys 1-9
      for (let i = 1; i <= 9; i++) {
        act(() => {
          const event = new KeyboardEvent('keydown', {
            key: i.toString(),
            ctrlKey: true
          });

          if (keyEventHandler) {
            const handled = keyEventHandler?.(event);
            expect(handled).toBe(false); // Should bubble to window handler
          }
        });
      }
    });

    it('should let Ctrl+T and Ctrl+W pass through', async () => {
      const { keyEventHandler } = await setupMockXterm();

      // Test Ctrl+T
      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 't',
          ctrlKey: true
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false);
      });

      // Test Ctrl+W
      act(() => {
        const event = new KeyboardEvent('keydown', {
          key: 'w',
          ctrlKey: true
        });

        const handled = keyEventHandler(event);
        expect(handled).toBe(false);
      });
    });
  });

  describe('Event type checking', () => {
    it('should only handle keydown events, not keyup', async () => {
      const { keyEventHandler } = await setupMockXterm({
        hasSelection: vi.fn(() => true),
        getSelection: vi.fn(() => 'selected text')
      });

      act(() => {
        // Test keyup event (should be ignored)
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'c',
          ctrlKey: true
        });

        keyEventHandler(keyupEvent);
      });

      // Clipboard should not be called for keyup events
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });
  });
});

describe('useXterm WebGL context management', () => {
  // Mock requestAnimationFrame for jsdom environment
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  const originalCancelAnimationFrame = global.cancelAnimationFrame;

  beforeAll(() => {
    global.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number);
    global.cancelAnimationFrame = vi.fn((id: number) => clearTimeout(id));
  });

  afterAll(() => {
    global.requestAnimationFrame = originalRequestAnimationFrame;
    global.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Reset gpuAcceleration to default
    mockSettingsStoreState.settings.gpuAcceleration = 'auto';

    // Mock ResizeObserver
    global.ResizeObserver = vi.fn().mockImplementation(function() {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });

    // Mock getBoundingClientRect to return valid dimensions so deferred xterm.open() triggers.
    // In jsdom, elements have zero dimensions by default, which would prevent performInitialFit
    // from opening xterm (it waits for non-zero container dimensions).
    // Use spyOn so vi.restoreAllMocks() properly cleans up between tests.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0,
      toJSON: () => ({}),
    });

    // Mock window.electronAPI
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTerminalInput: vi.fn(),
      openExternal: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper to render useXterm and wait for initialization
   */
  async function renderUseXterm(terminalId = 'test-webgl-terminal') {
    // Set up XTerm mock with dispose tracking
    const mockDispose = vi.fn();
    (XTerm as unknown as Mock).mockImplementation(function() {
      return {
        open: vi.fn(),
        loadAddon: vi.fn(),
        attachCustomKeyEventHandler: vi.fn(),
        hasSelection: vi.fn(() => false),
        getSelection: vi.fn(() => ''),
        paste: vi.fn(),
        input: vi.fn(),
        onData: vi.fn(),
        onResize: vi.fn(),
        onWriteParsed: vi.fn((_cb) => ({ dispose: vi.fn() })),
        dispose: mockDispose,
        write: vi.fn(),
        parser: {
          registerOscHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        },
        selectAll: vi.fn(),
        clear: vi.fn(),
        clearTextureAtlas: vi.fn(),
        cols: 80,
        rows: 24,
        options: {
          cursorBlink: true,
          cursorStyle: 'block',
          fontSize: 14,
          fontFamily: 'monospace',
          fontWeight: 'normal',
          lineHeight: 1,
          letterSpacing: 0,
          theme: { cursorAccent: '#000000' },
          scrollback: 1000
        },
        refresh: vi.fn()
      };
    });

    const { FitAddon } = await import('@xterm/addon-fit');
    (FitAddon as unknown as Mock).mockImplementation(function() {
      return { fit: vi.fn(), dispose: vi.fn() };
    });

    const { WebLinksAddon } = await import('@xterm/addon-web-links');
    (WebLinksAddon as unknown as Mock).mockImplementation(function() {
      return {};
    });

    const { SerializeAddon } = await import('@xterm/addon-serialize');
    (SerializeAddon as unknown as Mock).mockImplementation(function() {
      return { serialize: vi.fn(() => ''), dispose: vi.fn() };
    });

    // Pre-warm the dynamic import cache for the WebGL context manager.
    // The first dynamic import() in vitest needs an extra async step to resolve
    // the mocked module. Pre-importing ensures it's cached for performInitialFit.
    await import('../../../lib/webgl-context-manager');

    let disposeHook: (() => void) | null = null;

    const TestWrapper = () => {
      const result = useXterm({ terminalId });
      // Expose dispose via ref so tests can call it
      disposeHook = result.dispose;
      return React.createElement('div', { ref: result.terminalRef });
    };

    await act(async () => {
      render(React.createElement(TestWrapper));
    });

    // Flush all pending timers to trigger deferred xterm.open() inside performInitialFit.
    // The deferred open uses raf (mocked as setTimeout(0)) which needs timer advancement,
    // followed by delayed refits (150ms, 350ms) which are safe since they just call
    // fit/refresh on mock instances.
    await act(async () => { await vi.runAllTimersAsync(); });
    // Extra flush for the dynamic WebGL import() which resolves as a microtask.
    // The first import in the suite may need an additional event loop turn.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    return { disposeHook: () => disposeHook?.() };
  }

  it('should lazily import and acquire WebGL context when gpuAcceleration is "auto"', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'auto';

    await renderUseXterm('terminal-auto');
    // Flush the dynamic import() promise + microtasks
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockWebglRegister).toHaveBeenCalledWith('terminal-auto', expect.anything());
    expect(mockWebglAcquire).toHaveBeenCalledWith('terminal-auto');
  });

  it('should lazily import and acquire WebGL context when gpuAcceleration is "on"', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'on';

    await renderUseXterm('terminal-on');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockWebglRegister).toHaveBeenCalledWith('terminal-on', expect.anything());
    expect(mockWebglAcquire).toHaveBeenCalledWith('terminal-on');
  });

  it('should NOT import WebGL module at all when gpuAcceleration is "off"', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'off';

    await renderUseXterm('terminal-off');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // When off, the dynamic import() never fires — no GPU code runs
    expect(mockWebglRegister).not.toHaveBeenCalled();
    expect(mockWebglAcquire).not.toHaveBeenCalled();
  });

  it('should unregister WebGL context on terminal disposal', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'auto';

    const { disposeHook } = await renderUseXterm('terminal-dispose');
    // Flush the dynamic import so the manager ref is populated
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mockWebglRegister).toHaveBeenCalledWith('terminal-dispose', expect.anything());

    // Dispose the terminal
    act(() => {
      disposeHook();
    });

    expect(mockWebglUnregister).toHaveBeenCalledWith('terminal-dispose');
  });

  it('should NOT unregister on disposal when WebGL was never loaded (off)', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = 'off';

    const { disposeHook } = await renderUseXterm('terminal-off-dispose');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Dispose the terminal
    act(() => {
      disposeHook();
    });

    // WebGL was never loaded, so unregister should not be called
    expect(mockWebglUnregister).not.toHaveBeenCalled();
  });

  it('should fallback to "off" when gpuAcceleration is undefined (upgrading users)', async () => {
    mockSettingsStoreState.settings.gpuAcceleration = undefined;

    await renderUseXterm('terminal-undefined');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // When undefined, the ?? 'off' fallback means no WebGL import at all
    expect(mockWebglRegister).not.toHaveBeenCalled();
    expect(mockWebglAcquire).not.toHaveBeenCalled();
  });
});

/**
 * Fix A unit tests — rAF-batched write callback.
 *
 * These tests install a capture-based requestAnimationFrame mock (store the
 * frame callback in `scheduledCallback`; invoke it manually from each test)
 * instead of the setTimeout-based polyfill used by the other describe blocks.
 * This gives deterministic per-frame control so we can enqueue N chunks BEFORE
 * the flush fires and assert on batching behavior.
 */
describe('useXterm rAF-batched write callback', () => {
  // Preserve whatever rAF/cAF the outer suite installed so we can restore it.
  const outerRequestAnimationFrame = global.requestAnimationFrame;
  const outerCancelAnimationFrame = global.cancelAnimationFrame;

  // Module-scoped capture: the flush callback scheduled via requestAnimationFrame.
  // Tests invoke this manually to simulate a frame firing.
  let scheduledCallback: FrameRequestCallback | null = null;
  let rafSpy: ReturnType<typeof vi.fn>;
  let cafSpy: ReturnType<typeof vi.fn>;
  // Stub rAF handle id returned by rafSpy. Tests assert that cancelAnimationFrame
  // is called with this same id during cleanup.
  const RAF_HANDLE_ID = 42;

  beforeAll(() => {
    rafSpy = vi.fn((cb: FrameRequestCallback): number => {
      scheduledCallback = cb;
      return RAF_HANDLE_ID;
    });
    cafSpy = vi.fn();
  });

  afterAll(() => {
    global.requestAnimationFrame = outerRequestAnimationFrame;
    global.cancelAnimationFrame = outerCancelAnimationFrame;
  });

  beforeEach(() => {
    // NOTE: vi.useFakeTimers() replaces global.requestAnimationFrame with its
    // internal fake-timer rAF. Install our capture-based mock AFTER useFakeTimers
    // so the rAF-batched write callback in useXterm picks up rafSpy/cafSpy, not
    // the vitest fake timer (which would make `scheduledCallback` unreachable).
    vi.useFakeTimers();
    vi.clearAllMocks();
    scheduledCallback = null;
    terminalStoreMocks.state.capturedWriteCallback = null;

    global.requestAnimationFrame = rafSpy as unknown as typeof global.requestAnimationFrame;
    global.cancelAnimationFrame = cafSpy as unknown as typeof global.cancelAnimationFrame;

    // ResizeObserver is referenced by useXterm's resize effect.
    global.ResizeObserver = vi.fn().mockImplementation(function() {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    });

    // window.electronAPI is referenced during xterm init (onData -> sendTerminalInput).
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      sendTerminalInput: vi.fn(),
      openExternal: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Render useXterm with a fresh XTerm mock. Returns the write spy (so tests
   * can assert on xterm.write calls), plus unmount + dispose handles.
   */
  async function renderForBatching(terminalId = 'test-batching-terminal') {
    const writeSpy = vi.fn();

    (XTerm as unknown as Mock).mockImplementation(function() {
      return {
        open: vi.fn(),
        loadAddon: vi.fn(),
        attachCustomKeyEventHandler: vi.fn(),
        hasSelection: vi.fn(() => false),
        getSelection: vi.fn(() => ''),
        paste: vi.fn(),
        input: vi.fn(),
        onData: vi.fn(),
        onResize: vi.fn(),
        onWriteParsed: vi.fn((_cb) => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
        write: writeSpy,
        parser: {
          registerOscHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        },
        selectAll: vi.fn(),
        clear: vi.fn(),
        clearTextureAtlas: vi.fn(),
        cols: 80,
        rows: 24,
        options: {
          cursorBlink: true,
          cursorStyle: 'block',
          fontSize: 14,
          fontFamily: 'monospace',
          fontWeight: 'normal',
          lineHeight: 1,
          letterSpacing: 0,
          theme: { cursorAccent: '#000000' },
          scrollback: 1000,
        },
        refresh: vi.fn(),
      };
    });

    const { FitAddon } = await import('@xterm/addon-fit');
    (FitAddon as unknown as Mock).mockImplementation(function() {
      return { fit: vi.fn(), dispose: vi.fn() };
    });

    const { WebLinksAddon } = await import('@xterm/addon-web-links');
    (WebLinksAddon as unknown as Mock).mockImplementation(function() {
      return {};
    });

    const { SerializeAddon } = await import('@xterm/addon-serialize');
    (SerializeAddon as unknown as Mock).mockImplementation(function() {
      return { serialize: vi.fn(() => ''), dispose: vi.fn() };
    });

    let hookReturn: ReturnType<typeof useXterm> | null = null;

    const TestWrapper = () => {
      const result = useXterm({ terminalId });
      hookReturn = result;
      return React.createElement('div', { ref: result.terminalRef });
    };

    const rendered = render(React.createElement(TestWrapper));

    // useXterm's performInitialFit calls requestAnimationFrame once during init
    // (for the deferred xterm.open). That init call is bookkeeping — not part of
    // the Fix A write-batching logic — so clear rafSpy's history here. Assertions
    // on toHaveBeenCalledTimes then only count writeCallback-triggered rAFs.
    // scheduledCallback is left intact: it will be overwritten by writeCallback's
    // next rAF schedule, which is the flush we actually want to invoke.
    rafSpy.mockClear();

    return {
      writeSpy,
      unmount: rendered.unmount,
      dispose: () => hookReturn?.dispose(),
    };
  }

  it('batches 5 enqueued chunks within one frame into a single xterm.write call', async () => {
    const { writeSpy } = await renderForBatching();
    // Narrow + assert in one shot so TypeScript knows writeCallback is non-null
    // for the rest of the test (satisfies Biome's noNonNullAssertion rule).
    const writeCallback = terminalStoreMocks.state.capturedWriteCallback;
    if (!writeCallback) throw new Error('Expected registerOutputCallback to have captured a writeCallback');

    // Enqueue 5 chunks BEFORE the frame fires. Each call should push into
    // pendingWritesRef; only the first should schedule a rAF (double-schedule guard).
    writeCallback('chunk-1');
    writeCallback('chunk-2');
    writeCallback('chunk-3');
    writeCallback('chunk-4');
    writeCallback('chunk-5');

    // xterm.write must not fire until the frame callback runs — chunks are buffered.
    expect(writeSpy).not.toHaveBeenCalled();
    // Only one rAF scheduled despite 5 writeCallback invocations.
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Fire the frame manually — this is the flush() that useXterm scheduled.
    if (!scheduledCallback) throw new Error('Expected writeCallback to have scheduled a frame callback');
    scheduledCallback(performance.now());

    // Exactly one xterm.write, with all 5 chunks concatenated via pending.join('').
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('chunk-1chunk-2chunk-3chunk-4chunk-5');
  });

  it('takes the fast path for a single chunk (writes pending[0], not join)', async () => {
    const { writeSpy } = await renderForBatching();
    const writeCallback = terminalStoreMocks.state.capturedWriteCallback;
    if (!writeCallback) throw new Error('Expected registerOutputCallback to have captured a writeCallback');

    writeCallback('only-chunk');

    // Fire the frame.
    if (!scheduledCallback) throw new Error('Expected writeCallback to have scheduled a frame callback');
    scheduledCallback(performance.now());

    // With a single pending chunk, flush uses pending[0] directly — avoids the
    // join('') allocation. The argument is the exact original string reference.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('only-chunk');
  });

  it('cleanup cancels pending rAF and clears pendingWritesRef to []', async () => {
    const { writeSpy, unmount } = await renderForBatching();
    const writeCallback = terminalStoreMocks.state.capturedWriteCallback;
    if (!writeCallback) throw new Error('Expected registerOutputCallback to have captured a writeCallback');

    // Enqueue a chunk so a rAF is pending at cleanup time.
    writeCallback('chunk-before-unmount');
    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Preserve the scheduled flush so we can verify the queue was cleared.
    const capturedFlush = scheduledCallback;
    if (!capturedFlush) throw new Error('Expected writeCallback to have scheduled a frame callback');

    // Trigger the useEffect cleanup via unmount.
    unmount();

    // cancelAnimationFrame was called with the rAF handle that rafSpy returned.
    expect(cafSpy).toHaveBeenCalledWith(RAF_HANDLE_ID);
    // unregisterOutputCallback was called → capturedWriteCallback nulled.
    expect(terminalStoreMocks.state.capturedWriteCallback).toBeNull();

    // Verify pendingWritesRef.current was reset to []: if we manually invoke
    // the flush that had been scheduled, it should hit the `pending.length === 0`
    // early-return and NOT call xterm.write.
    capturedFlush(performance.now());
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('disposed terminal skips xterm.write inside flush', async () => {
    const { writeSpy, dispose } = await renderForBatching();
    const writeCallback = terminalStoreMocks.state.capturedWriteCallback;
    if (!writeCallback) throw new Error('Expected registerOutputCallback to have captured a writeCallback');

    // Enqueue a chunk — rAF scheduled, but flush hasn't fired yet.
    writeCallback('chunk-pre-dispose');
    expect(rafSpy).toHaveBeenCalledTimes(1);
    if (!scheduledCallback) throw new Error('Expected writeCallback to have scheduled a frame callback');

    // Dispose the terminal: sets isDisposedRef.current = true and nulls xtermRef.
    // The flush guard is `xtermRef.current && !isDisposedRef.current` — both
    // conditions now prevent the write.
    dispose();

    // Fire the frame manually. Flush runs, but the guard skips xterm.write.
    scheduledCallback(performance.now());

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('schedules requestAnimationFrame exactly once for 3 rapid writeCallback calls (double-schedule guard)', async () => {
    const { unmount } = await renderForBatching();
    const writeCallback = terminalStoreMocks.state.capturedWriteCallback;
    if (!writeCallback) throw new Error('Expected registerOutputCallback to have captured a writeCallback');

    // Three synchronous writeCallback bursts within the same frame. The guard
    // `if (rafIdRef.current === null)` must prevent the 2nd and 3rd rAF calls.
    writeCallback('a');
    writeCallback('b');
    writeCallback('c');

    expect(rafSpy).toHaveBeenCalledTimes(1);

    // Unmount explicitly inside the test body so the useEffect cleanup runs
    // while our cafSpy is still installed. Without this, React's deferred
    // passive-effect unmount fires after `vi.useRealTimers()` / `restoreAllMocks`
    // in afterEach, and the bare `cancelAnimationFrame` reference in useXterm
    // throws ReferenceError because global.cancelAnimationFrame is gone.
    unmount();
    expect(cafSpy).toHaveBeenCalledWith(RAF_HANDLE_ID);
  });
});
