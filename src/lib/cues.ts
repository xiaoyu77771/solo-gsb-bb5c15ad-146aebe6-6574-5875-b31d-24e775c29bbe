import type { Constraints, Cue, DragEdge } from '../types';

/** 校验单条边界拖动是否合法；不合法返回原因（用于回弹提示） */
export function validateEdge(
  cues: Cue[],
  cueId: string,
  edge: DragEdge,
  candidateTime: number,
  constraints: Constraints
): { ok: true } | { ok: false; message: string } {
  const cue = cues.find((c) => c.id === cueId);
  if (!cue) return { ok: false, message: '未找到字幕块' };

  const t = candidateTime;
  if (Number.isNaN(t)) return { ok: false, message: '时间无效' };

  let newStart = cue.start;
  let newEnd = cue.end;
  if (edge === 'start') newStart = t;
  else newEnd = t;

  if (newStart < 0) {
    return { ok: false, message: '不能越过时间轴起点 00:00.000' };
  }

  if (newEnd - newStart < constraints.minDuration) {
    return {
      ok: false,
      message: `字幕时长 ${(newEnd - newStart).toFixed(3)}s 短于最短时长 ${constraints.minDuration.toFixed(
        3
      )}s`
    };
  }

  // 邻居检查：拖动后保持与左右最近字幕的间隔
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const idx = sorted.findIndex((c) => c.id === cueId);

  const prev = sorted
    .slice(0, idx)
    .reverse()
    .find((c) => c.id !== cueId);
  const next = sorted.slice(idx + 1).find((c) => c.id !== cueId);

  if (prev) {
    if (newStart < prev.end) {
      return { ok: false, message: '与上一条字幕发生重叠' };
    }
    if (newStart - prev.end < constraints.minGap) {
      return {
        ok: false,
        message: `与上一条间隔 ${(newStart - prev.end).toFixed(3)}s 小于最小间隔 ${constraints.minGap.toFixed(
          3
        )}s`
      };
    }
  }

  if (next) {
    if (next.start < newEnd) {
      return { ok: false, message: '与下一条字幕发生重叠' };
    }
    if (next.start - newEnd < constraints.minGap) {
      return {
        ok: false,
        message: `与下一条间隔 ${(next.start - newEnd).toFixed(3)}s 小于最小间隔 ${constraints.minGap.toFixed(
          3
        )}s`
      };
    }
  }

  return { ok: true };
}

/** 应用一条边界变更，返回新数组（不可变） */
export function applyEdge(cues: Cue[], cueId: string, edge: DragEdge, time: number): Cue[] {
  return cues.map((c) => {
    if (c.id !== cueId) return c;
    return edge === 'start' ? { ...c, start: time } : { ...c, end: time };
  });
}

export interface HistoryState {
  past: Cue[][];
  present: Cue[];
  future: Cue[][];
}

export function initHistory(present: Cue[]): HistoryState {
  return { past: [], present, future: [] };
}

/** 提交一次确定的调整（合法拖放结束时调用） */
export function commitHistory(state: HistoryState, next: Cue[]): HistoryState {
  return {
    past: [...state.past, state.present],
    present: next,
    future: []
  };
}

export function undoHistory(state: HistoryState): HistoryState {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future]
  };
}

export function redoHistory(state: HistoryState): HistoryState {
  if (state.future.length === 0) return state;
  const [next, ...rest] = state.future;
  return {
    past: [...state.past, state.present],
    present: next,
    future: rest
  };
}

/** 导入新文件时重置历史 */
export function replaceHistory(_state: HistoryState, cues: Cue[]): HistoryState {
  return { past: [], present: cues, future: [] };
}
