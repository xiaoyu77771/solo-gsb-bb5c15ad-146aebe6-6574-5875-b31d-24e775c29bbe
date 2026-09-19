import { computeWindowLevels, WINDOW_SIZE } from './silence';

/** 简单的取消令牌：开始新分析（更换音频）时令旧令牌失效 */
export class AbortToken {
  private aborted = false;
  abort(): void {
    this.aborted = true;
  }
  get signal(): boolean {
    return this.aborted;
  }
}

export class AbortTokenAbortError extends Error {
  constructor() {
    super('analysis aborted');
    this.name = 'AbortTokenAbortError';
  }
}

/** 更换音频时取消旧分析 */
export function isAbortError(err: unknown): boolean {
  return err instanceof AbortTokenAbortError;
}

export interface AudioLevelsResult {
  levels: Float32Array;
  windowSize: number;
  duration: number;
  sampleRate: number;
}

let cachedContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!cachedContext) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('当前浏览器不支持 Web Audio API');
    cachedContext = new Ctor();
  }
  return cachedContext;
}

/**
 * 用 Web Audio API 解码本地音频，按 20ms 窗口计算各声道 RMS 的最大值。
 * 传入 token 后，若在解码 / 分析期间被取消（更换音频），
 * Promise 会 reject（AbortTokenAbortError），调用方据此阻止旧结果回写。
 * 阈值变化只需基于窗口能量重新分段，无需重新解码。
 */
export async function analyzeAudioFile(
  file: File,
  token: AbortToken
): Promise<AudioLevelsResult> {
  const arrayBuffer = await file.arrayBuffer();
  if (token.signal) throw new AbortTokenAbortError();

  const ctx = getAudioContext();
  // slice(0) 得到独立副本，避免 decodeAudioData 在部分浏览器 detach 原 buffer
  const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  if (token.signal) throw new AbortTokenAbortError();

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  const win = computeWindowLevels(channels, buffer.sampleRate, WINDOW_SIZE);
  if (token.signal) throw new AbortTokenAbortError();
  return { ...win, sampleRate: buffer.sampleRate };
}
