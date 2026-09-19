/**
 * A-B 循环试听：区间计算与播放状态转换（纯函数，可单测）。
 *
 * 循环区间 = 选中字幕起止时间 ± 可调前后余量，并裁剪到 [0, 音频时长]。
 * 播放状态转换全部为纯函数，由 App 侧的播放回调（rAF / 事件）调用；
 * 暂停、导入新音频或关闭循环后，调用方保证旧回调读取到失效状态即落空，
 * 不再拉回播放头。
 */

export interface LoopMargins {
  /** 前余量（秒）：A = 字幕起点 − pre */
  pre: number;
  /** 后余量（秒）：B = 字幕终点 + post */
  post: number;
}

export interface LoopRange {
  /** 循环起点 A（秒） */
  a: number;
  /** 循环终点 B（秒） */
  b: number;
}

export const DEFAULT_LOOP_MARGINS: LoopMargins = { pre: 0.3, post: 0.3 };

/** 裁剪后短于该时长视为空区间（避免零长度死循环） */
export const MIN_LOOP_LENGTH = 0.05;

/**
 * 计算循环区间：
 * - A = max(0, 字幕起点 − pre)，B = 字幕终点 + post；
 * - 音频时长已知（>0）时 B 裁剪到时长，时长未知（<=0）不裁剪；
 * - 余量负值按 0 计；裁剪后不足 MIN_LOOP_LENGTH 返回 null（空区间）。
 */
export function computeLoopRange(
  cue: { start: number; end: number } | null,
  margins: LoopMargins,
  duration: number
): LoopRange | null {
  if (!cue) return null;
  const pre = Math.max(0, margins.pre);
  const post = Math.max(0, margins.post);
  const a = Math.max(0, cue.start - pre);
  let b = cue.end + post;
  if (duration > 0) b = Math.min(b, duration);
  if (b - a < MIN_LOOP_LENGTH) return null;
  return { a: Number(a.toFixed(3)), b: Number(b.toFixed(3)) };
}

export type LoopDisableReason = 'no-audio' | 'no-selection' | 'empty-range';

/** 循环不可用的原因（优先级：无音频 > 未选字幕 > 区间为空）；可用返回 null */
export function loopDisableReason(
  hasAudio: boolean,
  selectedCue: { start: number; end: number } | null,
  range: LoopRange | null
): LoopDisableReason | null {
  if (!hasAudio) return 'no-audio';
  if (!selectedCue) return 'no-selection';
  if (!range) return 'empty-range';
  return null;
}

export function loopDisableText(reason: LoopDisableReason): string {
  switch (reason) {
    case 'no-audio':
      return '请先导入音频';
    case 'no-selection':
      return '请先选择一条字幕';
    case 'empty-range':
      return '循环区间经音频时长裁剪后为空';
  }
}

/**
 * 播放推进（tick）：越过 B 点返回应跳转的 A 点，否则 null。
 * 仅在循环激活且播放中调用；暂停 / 换音频 / 关闭后旧回调不得再调用本转换。
 */
export function loopWrapTarget(time: number, range: LoopRange | null): number | null {
  if (!range) return null;
  return time >= range.b ? range.a : null;
}

/**
 * 开启循环 / 切换选择后校正播放头：
 * 落在新区间 [a, b] 之外时返回新 A 点（应立即跳转），区间内返回 null。
 */
export function loopEntryTarget(time: number, range: LoopRange | null): number | null {
  if (!range) return null;
  return time < range.a || time > range.b ? range.a : null;
}
