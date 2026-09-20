/**
 * 单句跟读对比：与浏览器环境无关的纯函数与常量（可在 Node 冒烟测试中直接调用）。
 *
 * 录音时序（UI 层编排）：申请麦克风 -> 倒计时 3s -> 先 MediaRecorder.start()
 * -> 再从字幕起点播放原音 -> 到达（裁剪后的）字幕终点自动停止。
 * 回放时原音为主时钟，录音轨为从时钟，累计偏差超过阈值即把录音轨拉回原音位置。
 */

/** 回放双轨允许的累计偏差阈值（秒）：超过 80ms 以原音时钟纠偏 */
export const SHADOW_DRIFT_LIMIT = 0.08;
/** 开录前倒计时秒数 */
export const COUNTDOWN_SECONDS = 3;

export type ShadowErrorKind = 'unsupported' | 'permission' | 'device' | 'unknown';

export interface ShadowErrorState {
  kind: ShadowErrorKind;
  text: string;
  /** 是否可在用户处理后（授权 / 插设备 / 重试）恢复 */
  recoverable: boolean;
}

/**
 * 录音能力检测：同时需要 getUserMedia 与 MediaRecorder。
 * 参数显式传入而非直接读全局，便于在 Node 中单测。
 */
export function hasRecordingSupport(
  mediaDevices: unknown,
  mediaRecorderCtor: unknown
): boolean {
  const md = mediaDevices as { getUserMedia?: unknown } | null | undefined;
  return typeof md?.getUserMedia === 'function' && typeof mediaRecorderCtor === 'function';
}

/** 浏览器侧包装：读取当前全局对象判断 */
export function isRecordingSupported(): boolean {
  return hasRecordingSupport(
    typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
    typeof window !== 'undefined' ? (window as { MediaRecorder?: unknown }).MediaRecorder : undefined
  );
}

/** 相对时间裁剪到 [0, dur]；非有限值按 0 处理，dur 非法按 0 处理 */
export function clampRelative(t: number, dur: number): number {
  const max = dur > 0 && Number.isFinite(dur) ? dur : 0;
  if (!Number.isFinite(t)) return 0;
  return Math.min(Math.max(0, t), max);
}

/**
 * 双轨时钟偏差（秒）：原音相对位置 − 录音位置。
 * 正值表示录音滞后于原音，负值表示超前；该差值即两路播放以来累计的时钟发散量。
 */
export function trackDrift(origRelative: number, recRelative: number): number {
  return origRelative - recRelative;
}

/** 累计偏差严格超过阈值才纠偏（恰好 80ms 不干预，避免频繁跳变） */
export function needsDriftCorrection(drift: number, limit = SHADOW_DRIFT_LIMIT): boolean {
  return Math.abs(drift) > limit;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus'
];

/**
 * 选择当前浏览器支持的录音容器格式（优先 webm/opus，Safari 退回 mp4）；
 * 全部不支持返回空串，由调用方使用 MediaRecorder 默认格式。
 */
export function pickRecorderMimeType(isTypeSupported: (mime: string) => boolean): string {
  for (const mime of MIME_CANDIDATES) {
    let ok = false;
    try {
      ok = !!isTypeSupported(mime);
    } catch {
      ok = false;
    }
    if (ok) return mime;
  }
  return '';
}

/** getUserMedia 异常归类为可恢复提示文案 */
export function describeGetUserMediaError(err: unknown): ShadowErrorState {
  const name =
    err instanceof DOMException
      ? err.name
      : (err as { name?: string } | null | undefined)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        kind: 'permission',
        text: '麦克风权限被拒绝：请点击浏览器地址栏的权限图标允许麦克风后重试',
        recoverable: true
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        kind: 'device',
        text: '未检测到可用麦克风设备，连接或选择设备后可重试',
        recoverable: true
      };
    case 'NotReadableError':
      return {
        kind: 'device',
        text: '麦克风正被其他程序占用，关闭占用程序后可重试',
        recoverable: true
      };
    default:
      return {
        kind: 'unknown',
        text: err instanceof Error && err.message ? `录音启动失败：${err.message}` : '录音启动失败，可重试',
        recoverable: true
      };
  }
}
