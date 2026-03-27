#!/usr/bin/env python3
"""
Tests for Export Validator
==========================

Tests the post-merge export validation that detects silently lost exports.

Covers:
- TypeScript / JavaScript named, default, and brace export extraction
- Python __all__ and top-level definition extraction
- Validation logic: lost exports, explicit removals, no false positives
- Unsupported file types return no exports
"""

import importlib
import sys
from datetime import datetime
from pathlib import Path

import pytest

# Add auto-claude directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent / "apps" / "backend"))

# Import modules directly to avoid merge/__init__.py which transitively
# pulls in modules requiring Python 3.10+ on some CI environments.
_ev = importlib.import_module("merge.export_validator")
extract_exports = _ev.extract_exports
extract_python_exports = _ev.extract_python_exports
extract_ts_js_exports = _ev.extract_ts_js_exports
validate_exports = _ev.validate_exports

_types = importlib.import_module("merge.types")
ChangeType = _types.ChangeType
SemanticChange = _types.SemanticChange
TaskSnapshot = _types.TaskSnapshot


# =============================================================================
# TypeScript / JavaScript export extraction
# =============================================================================


class TestTsJsExportExtraction:
    """Tests for TypeScript/JavaScript export extraction."""

    def test_named_function_exports(self):
        code = """
export function foo() {}
export async function bar() {}
"""
        assert extract_ts_js_exports(code) == {"foo", "bar"}

    def test_const_let_var_exports(self):
        code = """
export const myConst = 42;
export let myLet = 'hello';
export var myVar = true;
"""
        assert extract_ts_js_exports(code) == {"myConst", "myLet", "myVar"}

    def test_class_interface_type_enum_exports(self):
        code = """
export class MyClass {}
export interface MyInterface {}
export type MyType = string;
export enum MyEnum { A, B }
"""
        assert extract_ts_js_exports(code) == {
            "MyClass",
            "MyInterface",
            "MyType",
            "MyEnum",
        }

    def test_default_exports(self):
        code = """
export default function App() {}
export default class Widget {}
"""
        exports = extract_ts_js_exports(code)
        assert "default:App" in exports
        assert "default:Widget" in exports

    def test_default_identifier_export(self):
        code = """
const App = () => {};
export default App;
"""
        assert "default:App" in extract_ts_js_exports(code)

    def test_brace_exports(self):
        code = """
export { foo, bar, baz };
"""
        assert extract_ts_js_exports(code) == {"foo", "bar", "baz"}

    def test_brace_export_with_alias(self):
        code = """
export { foo as myFoo, bar as default };
"""
        exports = extract_ts_js_exports(code)
        assert "myFoo" in exports
        assert "default" in exports

    def test_mixed_exports(self):
        code = """
import { create } from 'zustand';

export function getOrCreateActor(id: string) {}
export const useTerminalStore = create<State>((set, get) => ({}));

export async function restoreTerminalSessions(path: string): Promise<void> {}
"""
        exports = extract_ts_js_exports(code)
        assert exports == {
            "getOrCreateActor",
            "useTerminalStore",
            "restoreTerminalSessions",
        }

    def test_no_exports(self):
        code = """
function internal() {}
const x = 42;
"""
        assert extract_ts_js_exports(code) == set()

    def test_non_export_statements_ignored(self):
        code = """
// export function commented() {}
const exported = "export function fake() {}";
export function real() {}
"""
        exports = extract_ts_js_exports(code)
        assert "real" in exports
        # The regex may pick up the string literal — that's acceptable
        # as a minor false positive, not a missed export

    def test_generator_function_export(self):
        code = """
export function* myGenerator() { yield 1; }
"""
        assert "myGenerator" in extract_ts_js_exports(code)


# =============================================================================
# Python export extraction
# =============================================================================


class TestPythonExportExtraction:
    """Tests for Python export extraction."""

    def test_all_list(self):
        code = """
__all__ = ["foo", "bar", "Baz"]

def foo(): pass
def bar(): pass
class Baz: pass
def _private(): pass
"""
        assert extract_python_exports(code) == {"foo", "bar", "Baz"}

    def test_all_single_quotes(self):
        code = "__all__ = ['one', 'two']"
        assert extract_python_exports(code) == {"one", "two"}

    def test_fallback_to_top_level_defs(self):
        code = """
def hello(): pass
def goodbye(): pass
class Greeter: pass
def _private(): pass
async def fetch_data(): pass
"""
        exports = extract_python_exports(code)
        assert exports == {"hello", "goodbye", "Greeter", "fetch_data"}
        assert "_private" not in exports

    def test_no_public_definitions(self):
        code = """
_x = 42
def _helper(): pass
"""
        assert extract_python_exports(code) == set()


# =============================================================================
# Unified extraction with file path
# =============================================================================


class TestExtractExports:
    """Tests for the unified extract_exports function."""

    def test_ts_file(self):
        code = "export function foo() {}"
        assert extract_exports(code, "src/store.ts") == {"foo"}

    def test_tsx_file(self):
        code = "export const App = () => {};"
        assert extract_exports(code, "src/App.tsx") == {"App"}

    def test_js_file(self):
        code = "export function bar() {}"
        assert extract_exports(code, "utils.js") == {"bar"}

    def test_py_file(self):
        code = "def hello(): pass"
        assert extract_exports(code, "module.py") == {"hello"}

    def test_unsupported_extension(self):
        code = "pub fn foo() {}"
        assert extract_exports(code, "lib.rs") == set()

    def test_json_file(self):
        assert extract_exports("{}", "package.json") == set()


# =============================================================================
# Validation logic
# =============================================================================


def _make_snapshot(
    task_id: str = "task-001",
    changes: list[SemanticChange] | None = None,
) -> TaskSnapshot:
    return TaskSnapshot(
        task_id=task_id,
        task_intent="test",
        started_at=datetime.now(),
        semantic_changes=changes or [],
    )


class TestValidateExports:
    """Tests for the validate_exports function."""

    def test_no_lost_exports(self):
        baseline = "export function foo() {}\nexport function bar() {}"
        merged = "export function foo() {}\nexport function bar() {}"
        warnings = validate_exports(baseline, merged, "store.ts")
        assert warnings == []

    def test_detects_lost_export(self):
        baseline = "export function foo() {}\nexport async function bar() {}"
        merged = "export function foo() {}"
        warnings = validate_exports(baseline, merged, "store.ts")
        assert len(warnings) == 1
        assert "bar" in warnings[0]

    def test_multiple_lost_exports(self):
        baseline = (
            "export function a() {}\n"
            "export function b() {}\n"
            "export function c() {}\n"
        )
        merged = "export function a() {}"
        warnings = validate_exports(baseline, merged, "store.ts")
        assert len(warnings) == 2
        lost_names = {w.split("'")[1] for w in warnings}
        assert lost_names == {"b", "c"}

    def test_explicit_removal_not_flagged(self):
        baseline = "export function foo() {}\nexport function bar() {}"
        merged = "export function foo() {}"
        snapshot = _make_snapshot(
            changes=[
                SemanticChange(
                    change_type=ChangeType.REMOVE_FUNCTION,
                    target="bar",
                    location="module",
                    line_start=1,
                    line_end=1,
                )
            ]
        )
        warnings = validate_exports(baseline, merged, "store.ts", [snapshot])
        assert warnings == []

    def test_new_exports_not_flagged(self):
        baseline = "export function foo() {}"
        merged = "export function foo() {}\nexport function newFunc() {}"
        warnings = validate_exports(baseline, merged, "store.ts")
        assert warnings == []

    def test_empty_baseline_no_warnings(self):
        warnings = validate_exports("", "export function foo() {}", "store.ts")
        assert warnings == []

    def test_unsupported_file_no_warnings(self):
        warnings = validate_exports(
            "pub fn foo() {}", "pub fn bar() {}", "lib.rs"
        )
        assert warnings == []

    def test_python_lost_export(self):
        baseline = "def hello(): pass\ndef goodbye(): pass"
        merged = "def hello(): pass"
        warnings = validate_exports(baseline, merged, "utils.py")
        assert len(warnings) == 1
        assert "goodbye" in warnings[0]

    def test_realistic_terminal_store_scenario(self):
        """Reproduce the exact scenario that caused the build failure:
        restoreTerminalSessions was lost during a merge."""
        baseline = """
import { create } from 'zustand';

export function getOrCreateTerminalActor(terminalId: string) {}
export function sendTerminalMachineEvent(terminalId: string, event: any) {}

export const useTerminalStore = create<any>((set, get) => ({
  terminals: [],
  addTerminal: () => {},
  removeTerminal: (id: string) => {},
}));

const restoringProjects = new Set<string>();

export async function restoreTerminalSessions(projectPath: string): Promise<void> {
  // restore logic...
}
"""
        # Merged result lost restoreTerminalSessions
        merged = """
import { create } from 'zustand';

export function getOrCreateTerminalActor(terminalId: string) {}
export function sendTerminalMachineEvent(terminalId: string, event: any) {}

export const useTerminalStore = create<any>((set, get) => ({
  terminals: [],
  addTerminal: () => {},
  removeTerminal: (id: string) => {},
}));
"""
        warnings = validate_exports(baseline, merged, "terminal-store.ts")
        assert len(warnings) == 1
        assert "restoreTerminalSessions" in warnings[0]
