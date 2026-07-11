import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle, ChevronLeft } from 'lucide-react';
import { postJSON } from '../../api/client';
import { fire } from '../../lib/feedback';
import type { Txn, Category } from '../../api/types';
import { type SwipeConfig, type EdgeKey, type EdgeGroup, type Zone, type PreviewState, DEFAULT_SWIPE_CONFIG } from '../../lib/swipe';
import { centeredCard } from '../../lib/facets';
import { SwipeCard } from './SwipeCard';
import { SwipeConsole } from './SwipeConsole';
import { SubcategoryPanel } from './SubcategoryPanel';
import { LinkRefundSheet } from '../transactions/LinkRefundSheet';

interface SwipeDeckProps {
  transactions: Txn[];
  categories: Category[];
  config?: SwipeConfig;
  onExit?: () => void;
}

interface DeckState {
  index: number;
  skippedIds: Set<number>;
  pendingGroup: EdgeGroup | null;
  flyEdge: EdgeKey | null;
  makeRule: boolean;
  preview: PreviewState | null;
}

/** Compare two preview states on the fields that matter for rendering; treat
 *  null<->null as equal so a freshly-allocated-but-equivalent object from
 *  SwipeCard's drag loop doesn't churn deck state every frame. */
function previewEqual(a: PreviewState | null, b: PreviewState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.edge !== b.edge || a.kind !== b.kind) return false;
  if (Math.round(a.fill * 100) !== Math.round(b.fill * 100)) return false;
  if (a.kind === 'category' && b.kind === 'category' && a.slot !== b.slot) return false;
  return true;
}

export function SwipeDeck({ transactions, categories, config = DEFAULT_SWIPE_CONFIG, onExit }: SwipeDeckProps) {
  const qc = useQueryClient();
  const arenaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = arenaRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setSize({ w: rect.width || 380, h: rect.height || 640 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const catName = useMemo(() => {
    const m = new Map(categories.map(c => [c.ID, c.Name]));
    return (id: number) => m.get(id) ?? '';
  }, [categories]);

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingGroup: null,
    flyEdge: null,
    makeRule: true,
    preview: null,
  });
  const [linkOpen, setLinkOpen] = useState(false);

  const [frozenTxns] = useState(() => transactions);
  const queue = frozenTxns.filter(t => !state.skippedIds.has(t.ID));
  const current = queue[state.index] ?? null;

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['review'] });
    qc.invalidateQueries({ queryKey: ['transactions'] });
    qc.invalidateQueries({ queryKey: ['summary'] });
  }, [qc]);

  const categorize = useCallback((categoryId: number, edge: EdgeKey) => {
    if (!current) return;
    // Caller fires the feedback cue (success for a direct swipe, selection for
    // a panel pick) so a single action never double-fires. dx/dy are left
    // alone here — SwipeCard flies out under `flying`, and the card only
    // resets when its `txn.ID` changes on advance (handleExitComplete).
    setState(s => ({ ...s, pendingGroup: null, flyEdge: edge }));
    postJSON(`/api/transactions/${current.ID}/categorize`, {
      category_id: categoryId,
      merchant_raw: current.MerchantRaw,
      make_rule: state.makeRule,
    }).then(invalidate).catch(() => { /* fixable from list view */ });
  }, [current, state.makeRule, invalidate]);

  const handleZoneCommit = useCallback((zone: Zone) => {
    if (zone.kind === 'category') {
      fire('success');
      categorize(zone.categoryId, zone.edge);
    } else {
      // Slim "Other" sliver → open the sheet filtered to this edge's group.
      setState(s => ({ ...s, pendingGroup: zone.group }));
    }
  }, [categorize]);

  const handleCategorySelect = useCallback((categoryId: number) => {
    // The panel that opened from an Other sliver — fly toward that edge.
    const edge = (['up', 'down', 'left', 'right'] as const).find(
      e => config.edges[e].group === state.pendingGroup,
    ) ?? 'down';
    fire('selection');
    categorize(categoryId, edge);
  }, [config, state.pendingGroup, categorize]);

  const handleExitComplete = useCallback(() => {
    setState(s => ({ ...s, flyEdge: null, index: s.index + 1, preview: null }));
  }, []);

  const handleTripleTap = useCallback(() => {
    if (!current) return;
    setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }));
  }, [current]);

  const handlePreview = useCallback((next: PreviewState | null) => {
    setState(s => (previewEqual(s.preview, next) ? s : { ...s, preview: next }));
  }, []);

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingGroup: null }));
  }, []);

  const done = state.index >= queue.length;
  const total = queue.length;
  const remaining = total - state.index;

  const cw = Math.min(200, Math.round(size.w * 0.46));
  const ch = Math.round(cw * 1.5);
  const card = centeredCard(size.w, size.h, cw, ch);
  const band = Math.max(24, Math.round(Math.min((size.w - cw) / 2, (size.h - ch) / 2) * 0.42));

  return (
    <div ref={arenaRef} className="absolute inset-0 bg-[#0E1116] overflow-hidden">
      <button
        type="button"
        aria-label="Close review"
        onClick={() => onExit?.()}
        className="absolute z-20 w-10 h-10 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 press"
        style={{ top: 'calc(env(safe-area-inset-top) + 8px)', left: 8 }}
      >
        <ChevronLeft size={22} />
      </button>

      {!done && (
        <div
          className="absolute z-20 right-4 text-right"
          style={{ top: 'calc(env(safe-area-inset-top) + 18px)' }}
        >
          <p className="text-[10px] uppercase tracking-[0.24em] text-white/40 font-semibold">Sorting</p>
          <p className="text-[11px] tracking-wide text-white/60 tabular-nums">
            <b className="text-white/90 font-bold">{remaining}</b> to sort
          </p>
        </div>
      )}

      {done ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 text-center px-8">
          <CheckCircle size={72} className="text-good" />
          <h2 className="text-2xl font-bold text-white">All caught up!</h2>
          <p className="text-white/60">
            {state.index} transaction{state.index !== 1 ? 's' : ''} categorized this session
          </p>
        </div>
      ) : (
        <>
          {size.w > 0 && (
            <SwipeConsole w={size.w} h={size.h} card={card} band={band} config={config} catName={catName} preview={state.preview} />
          )}

          {size.w > 0 && current && (
            <div style={{ position: 'absolute', left: card.x0, top: card.y0, width: cw, height: ch }}>
              <SwipeCard
                key={current.ID}
                txn={current}
                config={config}
                catName={catName}
                flying={state.flyEdge}
                onZoneCommit={handleZoneCommit}
                onTripleTap={handleTripleTap}
                onExitComplete={handleExitComplete}
                onPreview={handlePreview}
              />
            </div>
          )}

          <p className="absolute bottom-4 left-0 right-0 text-center text-xs text-white/40">
            Swipe toward a category · triple-tap to skip
          </p>

          {current && current.Direction === 'credit' && (
            <button
              className="absolute bottom-10 left-0 right-0 mx-auto w-fit text-sm font-medium text-white/80 underline underline-offset-2"
              onClick={() => setLinkOpen(true)}
            >
              This is a refund — link the purchase
            </button>
          )}
        </>
      )}

      {state.pendingGroup && (
        <SubcategoryPanel
          group={state.pendingGroup}
          categories={categories}
          makeRule={state.makeRule}
          onMakeRuleChange={v => setState(s => ({ ...s, makeRule: v }))}
          onSelect={handleCategorySelect}
          onCancel={handleCancel}
        />
      )}

      {linkOpen && current && (
        <LinkRefundSheet
          txn={current}
          onLinked={() => {
            setLinkOpen(false);
            invalidate();
            setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }));
          }}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  );
}
