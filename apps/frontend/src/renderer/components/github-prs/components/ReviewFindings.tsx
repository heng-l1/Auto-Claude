/**
 * ReviewFindings - Interactive findings display with selection and filtering
 *
 * Features:
 * - Grouped by severity (Critical/High vs Medium/Low)
 * - Checkboxes for selecting which findings to post
 * - Quick select actions (Critical/High, All, None)
 * - Collapsible sections for less important findings
 * - Visual summary of finding counts
 * - Disputed findings shown in a separate collapsible section
 * - Merges AI review findings with manually-authored findings (UI + terminal)
 *   into a single sorted list (severity rank → AI-first → authoredAt asc)
 */

import { useState, useMemo } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  CheckSquare,
  Square,
  Send,
  ChevronDown,
  ChevronRight,
  ShieldQuestion,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';
import type { PRReviewFinding } from '@shared/types/pr-review-comments';
import { useFindingSelection } from '../hooks/useFindingSelection';
import { FindingsSummary } from './FindingsSummary';
import { SeverityGroupHeader } from './SeverityGroupHeader';
import { FindingItem } from './FindingItem';
import type { SeverityGroup } from '../constants/severity-config';
import { SEVERITY_ORDER, SEVERITY_CONFIG } from '../constants/severity-config';

interface ReviewFindingsProps {
  findings: PRReviewFinding[];
  /**
   * Manually-authored findings for this PR (sourced from the
   * `manualFindings[prNumber]` slice of `pr-review-store`). Optional — when
   * omitted, only AI findings are shown. When provided, the two arrays are
   * merged and sorted (severity rank → AI source first → authoredAt asc) so
   * AI findings always lead each severity bucket and manual entries within a
   * bucket are listed in the order they were authored.
   */
  manualFindings?: PRReviewFinding[];
  selectedIds: Set<string>;
  postedIds?: Set<string>;
  onSelectionChange: (selectedIds: Set<string>) => void;
}

// Severity ordering used for the merged-list sort comparator. Mirrors
// `SEVERITY_ORDER` but as a lookup table for O(1) comparisons.
const SEVERITY_RANK: Record<PRReviewFinding['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Comparator for the merged AI + manual findings list.
 *
 * Sort key (in order of precedence):
 *   1. Severity rank — critical < high < medium < low.
 *   2. Source — `'ai'` (or missing, for back-compat with pre-`source` records)
 *      sorts before `'terminal'` / `'manual'`. AI findings always lead each
 *      severity bucket because they came from an explicit review pass.
 *   3. `authoredAt` ascending — older manual entries appear above newer ones.
 *      Findings without an `authoredAt` (legacy AI findings) sort before any
 *      authored entry so the deterministic original order is preserved.
 */
function compareFindings(a: PRReviewFinding, b: PRReviewFinding): number {
  // 1. Severity rank
  const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sevDiff !== 0) return sevDiff;

  // 2. Source: 'ai' (or undefined for back-compat) first
  const aIsAi = a.source == null || a.source === 'ai';
  const bIsAi = b.source == null || b.source === 'ai';
  if (aIsAi && !bIsAi) return -1;
  if (!aIsAi && bIsAi) return 1;

  // 3. authoredAt ascending — undefined sorts before defined
  if (a.authoredAt && b.authoredAt) {
    return a.authoredAt.localeCompare(b.authoredAt);
  }
  if (a.authoredAt) return 1;
  if (b.authoredAt) return -1;
  return 0;
}

export function ReviewFindings({
  findings,
  manualFindings = [],
  selectedIds,
  postedIds = new Set(),
  onSelectionChange,
}: ReviewFindingsProps) {
  const { t } = useTranslation('common');

  // Track which sections are expanded
  const [expandedSections, setExpandedSections] = useState<Set<SeverityGroup>>(
    new Set<SeverityGroup>(['critical', 'high']) // Critical and High expanded by default
  );
  const [disputedExpanded, setDisputedExpanded] = useState(false);

  // Merge AI findings + manual findings into a single sorted list before any
  // downstream filtering/grouping happens. The sort comparator handles all
  // three keys (severity → AI-first → authoredAt asc) in one pass so the
  // existing severity-grouping code below preserves the intended ordering
  // within each bucket without any further work.
  //
  // Each finding carries its own `id` (AI findings use the reviewer-generated
  // id; manual findings always prefix `manual-`), so there are no collisions
  // and the `useFindingSelection` selection state continues to work unchanged.
  const mergedFindings = useMemo(() => {
    if (manualFindings.length === 0) {
      // Fast path: nothing to merge. Sorting a freshly-spread AI-only list
      // would re-order findings the reviewer pipeline already laid out.
      return findings;
    }
    return [...findings, ...manualFindings].sort(compareFindings);
  }, [findings, manualFindings]);

  // Filter out posted findings - only show unposted findings for selection
  const unpostedFindings = useMemo(() =>
    mergedFindings.filter(f => !postedIds.has(f.id)),
    [mergedFindings, postedIds]
  );

  // Split unposted findings into active vs disputed (single pass)
  const { activeFindings, disputedFindings } = useMemo(() => {
    const active: PRReviewFinding[] = [];
    const disputed: PRReviewFinding[] = [];
    for (const finding of unpostedFindings) {
      if (finding.validationStatus === 'dismissed_false_positive') {
        disputed.push(finding);
      } else {
        active.push(finding);
      }
    }
    return { activeFindings: active, disputedFindings: disputed };
  }, [unpostedFindings]);

  // Check if all findings are posted (across both AI and manual sources)
  const allFindingsPosted = mergedFindings.length > 0 && unpostedFindings.length === 0;

  // Group ACTIVE unposted findings by severity (disputed go in their own section)
  const groupedFindings = useMemo(() => {
    const groups: Record<SeverityGroup, PRReviewFinding[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };

    for (const finding of activeFindings) {
      const severity = finding.severity as SeverityGroup;
      if (groups[severity]) {
        groups[severity].push(finding);
      }
    }

    return groups;
  }, [activeFindings]);

  // Count by severity (active findings only)
  const counts = useMemo(() => ({
    critical: groupedFindings.critical.length,
    high: groupedFindings.high.length,
    medium: groupedFindings.medium.length,
    low: groupedFindings.low.length,
    total: activeFindings.length,
    important: groupedFindings.critical.length + groupedFindings.high.length,
    posted: postedIds.size,
  }), [groupedFindings, activeFindings.length, postedIds.size]);

  // Selection hooks - use ACTIVE unposted findings only (Select All excludes disputed)
  const {
    toggleFinding,
    selectAll,
    selectNone,
    selectImportant,
    toggleSeverityGroup,
  } = useFindingSelection({
    findings: activeFindings,
    selectedIds,
    onSelectionChange,
    groupedFindings,
  });

  // Toggle section expansion
  const toggleSection = (severity: SeverityGroup) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(severity)) {
        next.delete(severity);
      } else {
        next.add(severity);
      }
      return next;
    });
  };

  // Count only active findings that are selected (excludes disputed from count)
  const selectedActiveCount = useMemo(
    () => activeFindings.filter(f => selectedIds.has(f.id)).length,
    [activeFindings, selectedIds]
  );

  // When all findings have been posted, show a success message instead of the selection UI
  if (allFindingsPosted) {
    return (
      <div className="space-y-4">
        <div className="text-center py-8 text-muted-foreground bg-success/5 rounded-lg border border-success/20">
          <Send className="h-8 w-8 mx-auto mb-2 text-success" />
          <p className="text-sm font-medium text-success">{t('prReview.allFindingsPosted')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('prReview.findingsPostedCount', { count: counts.posted })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Stats Bar - show active findings + disputed count */}
      <FindingsSummary
        findings={activeFindings}
        selectedCount={selectedActiveCount}
        disputedCount={disputedFindings.length}
      />

      {/* Quick Select Actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={selectImportant}
          className="text-xs"
          disabled={counts.important === 0}
        >
          <AlertTriangle className="h-3 w-3 mr-1" />
          {t('prReview.selectCriticalHigh', { count: counts.important })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={selectAll}
          className="text-xs"
        >
          <CheckSquare className="h-3 w-3 mr-1" />
          {t('prReview.selectAll')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={selectNone}
          className="text-xs"
          disabled={selectedIds.size === 0}
        >
          <Square className="h-3 w-3 mr-1" />
          {t('prReview.clear')}
        </Button>
      </div>

      {/* Grouped Findings (active only) */}
      <div className="space-y-3">
        {SEVERITY_ORDER.map((severity) => {
          const group = groupedFindings[severity];
          if (group.length === 0) return null;

          const config = SEVERITY_CONFIG[severity];
          const isExpanded = expandedSections.has(severity);
          const selectedInGroup = group.filter(f => selectedIds.has(f.id)).length;

          return (
            <div
              key={severity}
              className={cn(
                "rounded-lg border",
                config.bgColor
              )}
            >
              {/* Group Header */}
              <SeverityGroupHeader
                severity={severity}
                count={group.length}
                selectedCount={selectedInGroup}
                expanded={isExpanded}
                onToggle={() => toggleSection(severity)}
                onSelectAll={(e) => {
                  e.stopPropagation();
                  toggleSeverityGroup(severity);
                }}
              />

              {/* Group Content */}
              {isExpanded && (
                <div className="p-3 pt-0 space-y-2">
                  {group.map((finding) => (
                    <FindingItem
                      key={finding.id}
                      finding={finding}
                      selected={selectedIds.has(finding.id)}
                      posted={false}
                      onToggle={() => toggleFinding(finding.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Disputed Findings Section */}
      {disputedFindings.length > 0 && (
        <div className="rounded-lg border border-purple-500/20 bg-purple-500/5">
          {/* Disputed Header */}
          <button
            type="button"
            onClick={() => setDisputedExpanded(!disputedExpanded)}
            aria-expanded={disputedExpanded}
            className="w-full flex items-center gap-2 p-3 text-left hover:bg-purple-500/10 transition-colors rounded-t-lg"
          >
            {disputedExpanded ? (
              <ChevronDown className="h-4 w-4 text-purple-500 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-purple-500 shrink-0" />
            )}
            <ShieldQuestion className="h-4 w-4 text-purple-500 shrink-0" />
            <span className="text-sm font-medium text-purple-500">
              {t('prReview.disputedByValidator', { count: disputedFindings.length })}
            </span>
          </button>

          {/* Disputed Content */}
          {disputedExpanded && (
            <div className="p-3 pt-0 space-y-2">
              <p className="text-xs text-muted-foreground italic mb-2">
                {t('prReview.disputedSectionHint')}
              </p>
              {disputedFindings.map((finding) => (
                <FindingItem
                  key={finding.id}
                  finding={finding}
                  selected={selectedIds.has(finding.id)}
                  posted={false}
                  disputed
                  onToggle={() => toggleFinding(finding.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty State - no findings at all (neither AI nor manual) */}
      {mergedFindings.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <CheckCircle className="h-8 w-8 mx-auto mb-2 text-success" />
          <p className="text-sm">{t('prReview.noIssuesFound')}</p>
        </div>
      )}
    </div>
  );
}
