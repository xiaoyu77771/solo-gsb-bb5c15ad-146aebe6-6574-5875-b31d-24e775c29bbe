import type { Constraints, DragEdge, SilenceSegment } from '../types';
import { validateEdge } from './cues';

/** 检测参数默认值（秒） */
export const WINDOW_SIZE = 0.02; // 20ms RMS 窗口
export const MIN_SILENCE_DURATION = 0.2; // 连续静音至少 200ms 才成段
export const MERGE_GAP = 0.08; // 静音段间隔不足 80ms 先合并
/** 拖动吸附半径（秒）：边界进入静音段边缘 150ms 范围内触发 */
export const SNAP_RADIUS = 0.15;

export interface DetectOptions {
  /** 线性振幅 RMS 阈值，低于该值视为静音（0..1） */
  threshold: number;
  windowSize?: number;
  minDuration?: number;
  mergeGap?: number;
}

export interface WindowLevels {
  /** 每个 20ms 窗口取各声道 RMS 的最大值（线性振幅） */
  levels: Float32Array;
  windowSize: number;
  duration: number;
}

export interface SilenceAnalysis extends WindowLevels {
  segments: SilenceSegment[];
  threshold: number;
}

/** 从声道数据按窗口计算各声道 RMS 的最大值 */
export function computeWindowLevels(
  channels: Float32Array[],
  sampleRate: number,
  windowSize = WINDOW_SIZE
): WindowLevels {
  const winSamples = Math.max(1, Math.round(sampleRate * windowSize));
  const lengths = channels.map((ch) => ch.length);
  const totalSamples = lengths.length > 0 ? Math.max(...lengths) : 0;
  const windows = Math.ceil(totalSamples / winSamples);
  const levels = new Float32Array(windows);

  for (let w = 0; w < windows; w++) {
    const from = w * winSamples;
    const to = Math.min(from + winSamples, totalSamples);
    let maxChannelRms = 0;
    for (const ch of channels) {
      let sum = 0;
      let n = 0;
      for (let i = from; i < to; i++) {
        if (i >= ch.length) break;
        const v = ch[i];
        sum += v * v;
        n++;
      }
      if (n > 0) {
        const rms = Math.sqrt(sum / n);
        if (rms > maxChannelRms) maxChannelRms = rms;
      }
    }
    levels[w] = maxChannelRms;
  }

  return {
    levels,
    windowSize,
    duration: windows * windowSize
  };
}

/**
 * 根据窗口能量检测静音段：
 * 1) 低于阈值的连续窗口形成候选段（要求连续至少 minDuration）；
 * 2) 间隔不足 mergeGap 的相邻段先合并（合并后再过最短时长）。
 */
export function detectSilences(levels: WindowLevels, options: DetectOptions): SilenceSegment[] {
  const {
    threshold,
    windowSize = levels.windowSize,
    minDuration = MIN_SILENCE_DURATION,
    mergeGap = MERGE_GAP
  } = options;

  const mergeWindows = mergeGap / windowSize;
  const minWindows = minDuration / windowSize;
  const { levels: lv } = levels;

  // 1) 连续低电平窗口 -> 候选段（窗口索引，闭区间）
  // 加极小 epsilon：恒定样本的 RMS 存在浮点误差，保证「恰好等于阈值」不判静音
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= lv.length; i++) {
    const quiet = i < lv.length && lv[i] < threshold - 1e-9;
    if (quiet && start < 0) {
      start = i;
    } else if (!quiet && start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }

  // 2) 间隔不足 mergeGap 的段先合并（严格小于；恰好 80ms 不合并）
  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - (last[1] + 1) < mergeWindows) {
      last[1] = run[1];
    } else {
      merged.push([run[0], run[1]]);
    }
  }

  // 3) 最短时长过滤（恰好 200ms 合法）
  return merged
    .filter(([s, e]) => (e - s + 1) >= minWindows)
    .map(([s, e]) => ({
      start: Number((s * windowSize).toFixed(4)),
      end: Number(((e + 1) * windowSize).toFixed(4))
    }));
}

/** 一次性完成窗口能量计算与静音段检测 */
export function analyzeChannels(
  channels: Float32Array[],
  sampleRate: number,
  options: DetectOptions
): SilenceAnalysis {
  const win = computeWindowLevels(channels, sampleRate, options.windowSize ?? WINDOW_SIZE);
  const segments = detectSilences(win, options);
  return { ...win, segments, threshold: options.threshold };
}

export interface SnapEdge {
  time: number;
  segment: SilenceSegment;
  /** 吸附点是该静音段的哪一侧 */
  side: 'start' | 'end';
}

/**
 * 在时间 t 附近 radius 范围内寻找最近的静音段边缘；
 * 两侧等距时取更早者（段起点）。
 */
export function nearestSilenceEdge(
  segments: SilenceSegment[],
  t: number,
  radius = SNAP_RADIUS
): SnapEdge | null {
  let best: SnapEdge | null = null;
  for (const seg of segments) {
    const edges: SnapEdge[] = [
      { time: seg.start, segment: seg, side: 'start' },
      { time: seg.end, segment: seg, side: 'end' }
    ];
    for (const edge of edges) {
      const dist = Math.abs(edge.time - t);
      if (!(dist < radius - 1e-9)) continue; // 严格处于半径内才吸附
      if (!best) {
        best = edge;
        continue;
      }
      const bestDist = Math.abs(best.time - t);
      // 更近者胜；等距取时间更早者
      if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && edge.time < best.time)) {
        best = edge;
      }
    }
  }
  return best;
}

export interface ResolveResult {
  /** 最终采用的时间（吸附后或原始候选） */
  time: number;
  /** 是否发生了吸附 */
  snapped: boolean;
  /** 吸附目标信息 */
  edge: SnapEdge | null;
  /** 校验结论（基于最终采用的时间） */
  valid: boolean;
  message: string;
  /** 吸附结果不合法时，说明原因；此时回退保留未吸附候选 */
  snapRejected: string | null;
}

/**
 * 解析一次拖动边界的候选时间：
 * 吸附开启时先在 150ms 范围内找静音边缘；吸附点若违反最短时长 /
 * 最小间隔等约束，则保留未吸附候选并带回原因。
 */
export function resolveEdgeCandidate(
  cues: Parameters<typeof validateEdge>[0],
  cueId: string,
  edge: DragEdge,
  rawTime: number,
  constraints: Constraints,
  segments: SilenceSegment[],
  snapEnabled: boolean,
  radius = SNAP_RADIUS
): ResolveResult {
  const snap = snapEnabled ? nearestSilenceEdge(segments, rawTime, radius) : null;

  const check = (time: number) => validateEdge(cues, cueId, edge, time, constraints);

  if (snap) {
    const r = check(snap.time);
    if (r.ok) {
      return { time: snap.time, snapped: true, edge: snap, valid: true, message: '', snapRejected: null };
    }
    const raw = check(rawTime);
    return {
      time: rawTime,
      snapped: false,
      edge: snap,
      valid: raw.ok,
      message: raw.ok ? '' : raw.message,
      snapRejected: `已找到静音边缘 ${snap.time.toFixed(3)}s，但${r.message}，保留原位置`
    };
  }

  const raw = check(rawTime);
  return {
    time: rawTime,
    snapped: false,
    edge: null,
    valid: raw.ok,
    message: raw.ok ? '' : raw.message,
    snapRejected: null
  };
}
