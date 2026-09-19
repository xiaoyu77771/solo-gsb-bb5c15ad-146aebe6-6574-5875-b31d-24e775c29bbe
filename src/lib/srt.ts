import type { Cue, ParseResult } from '../types';

let idCounter = 0;
export function nextId(): string {
  idCounter += 1;
  return `cue-${Date.now().toString(36)}-${idCounter}`;
}

/** 00:00:00,000 -> 秒 */
export function srtTimeToSeconds(raw: string): number | null {
  const m = raw.trim().match(
    /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/
  );
  if (!m) return null;
  const [, hh, mm, ss, ms] = m;
  const msPadded = ms.padEnd(3, '0');
  return (
    Number(hh) * 3600 +
    Number(mm) * 60 +
    Number(ss) +
    Number(msPadded) / 1000
  );
}

/** 秒 -> 00:00:00,000 */
export function secondsToSrtTime(t: number): string {
  const clamped = Math.max(0, t);
  const hh = Math.floor(clamped / 3600);
  const mm = Math.floor((clamped % 3600) / 60);
  const ss = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  // 处理四舍五入进位（999.5ms -> 1s）
  let carryS = ss;
  let carryM = mm;
  let carryH = hh;
  let msOut = ms;
  if (msOut === 1000) {
    msOut = 0;
    carryS += 1;
  }
  if (carryS === 60) {
    carryS = 0;
    carryM += 1;
  }
  if (carryM === 60) {
    carryM = 0;
    carryH += 1;
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(carryH)}:${p2(carryM)}:${p2(carryS)},${String(msOut).padStart(3, '0')}`;
}

/** 屏幕显示用 mm:ss.d */
export function formatClock(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '00:00.0';
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const tenth = Math.floor((t * 10) % 10);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(mm)}:${p2(ss)}.${tenth}`;
}

/**
 * 解析 SRT。容错点：
 * - 支持 UTF-8 BOM
 * - 毫秒分隔符 , 或 .
 * - 序号缺失时按顺序自动编号
 * - 空文本块 / 非法时间行会产生 warning 而非整体失败
 */
export function parseSrt(content: string): ParseResult {
  const warnings: string[] = [];
  const clean = content.replace(/^﻿/, '');
  // 以空行切块，兼容 \r\n
  const blocks = clean
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const cues: Cue[] = [];

  blocks.forEach((block, idx) => {
    const lines = block.split('\n');
    let cursor = 0;

    // 可选序号行
    if (/^\d+$/.test(lines[0].trim())) cursor = 1;

    const timeLine = lines[cursor] ?? '';
    const tm = timeLine
      .trim()
      .match(
        /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
      );

    if (!tm) {
      warnings.push(`第 ${idx + 1} 块时间码无法识别，已跳过：${timeLine.trim() || '(空)'}`);
      return;
    }

    const start = srtTimeToSeconds(tm[1]);
    const end = srtTimeToSeconds(tm[2]);
    if (start === null || end === null) {
      warnings.push(`第 ${idx + 1} 块时间码解析失败，已跳过`);
      return;
    }
    if (end <= start) {
      warnings.push(`第 ${idx + 1} 块结束时间不晚于开始时间（${secondsToSrtTime(start)}），已跳过`);
      return;
    }

    const text = lines.slice(cursor + 1).join('\n').trim();
    cues.push({ id: nextId(), start, end, text });
  });

  // 按开始时间排序，保证后续邻居计算稳定
  cues.sort((a, b) => a.start - b.start || a.end - b.end);

  return { cues, warnings };
}

/**
 * 导出 SRT：始终按时间先后重排，并输出 1..N 连续编号，
 * 避免用户调整后编号错乱。
 */
export function serializeSrt(cues: Cue[]): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  return (
    sorted
      .map((cue, i) => {
        const body = cue.text.trim() || '(无文本)';
        return `${i + 1}\n${secondsToSrtTime(cue.start)} --> ${secondsToSrtTime(
          cue.end
        )}\n${body}`;
      })
      .join('\n\n') + '\n'
  );
}
