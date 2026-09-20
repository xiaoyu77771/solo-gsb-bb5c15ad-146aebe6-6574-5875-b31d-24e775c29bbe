/**
 * 单句跟读对比：浏览器能力探测、MIME 选择与回放纠偏（纯函数，可单测）。
 *
 * 录音只保存在当前浏览器会话：组件层把 MediaRecorder 产物放在内存
 * （Blob + Object URL），切换字幕 / 导入新音频 / 重新录制 / 卸载时释放。
 *
 * 回放时两轨（原音、录音）同步启动；任一路暂停 / 结束 / 重新定位都联动
 * 另一轨；帧级监听以原音为时钟，偏差绝对值超过 SYNC_TOLERANCE（80ms）
 * 即把落后 / 超前的一轨 seek 回原音相对位置。
 */

/** 允许的累计偏差阈值（秒）：超过 80ms 以原音时钟纠偏 */
export const SYNC_TOLERANCE = 0.08;

/** 录音前倒计时（秒） */
export const COUNTDOWN_SECONDS = 3;

/**
 * 回放纠偏：以原音为时钟，返回另一轨（录音）应跳到的时间；
 * 偏差绝对值 ≤ tolerance（恰好 80ms 不纠偏）返回 null。
 * 差值先取整到 1µs，消除二进制浮点尾数（如 2.16−2.08 的 0.08000000000000007）。
 *
 * @param refTime   原音当前时间（绝对时间轴，秒）
 * @param otherTime 录音当前时间（绝对时间轴，秒）
 * @param tolerance 允许偏差（秒）
 */
export function syncTarget(
  refTime: number,
  otherTime: number,
  tolerance: number = SYNC_TOLERANCE
): number | null {
  if (!Number.isFinite(refTime) || !Number.isFinite(otherTime)) return null;
  const diff = Math.round(Math.abs(refTime - otherTime) * 1e6) / 1e6;
  return diff > tolerance ? refTime : null;
}

/**
 * 相对位置是否已越过字幕终点（原音到字幕终点自动停止）。
 * 相对位置 = 当前时间 − 区间起点。
 */
export function isPastEnd(rel: number, durationSec: number): boolean {
  return Number.isFinite(rel) && rel >= durationSec;
}

/** 绝对时间转区间内相对位置（秒），并夹到 [0, duration] */
export function clampToRange(time: number, start: number, durationSec: number): number {
  return Math.min(Math.max(time - start, 0), durationSec);
}

/** 录音时长（秒）是否足以构成一次有效跟读 */
export function isUsableRecording(durationSec: number): boolean {
  return Number.isFinite(durationSec) && durationSec >= 0.05;
}

export interface ShadowSupport {
  ok: boolean;
  /** 不可用原因：不支持采集 / 不支持录音 / 非安全上下文 / 无音频上下文 */
  reason: 'getUserMedia' | 'mediaRecorder' | 'secure-context' | null;
}

/**
 * 浏览器能力探测（在安全上下文下调用）：
 * - mediaDevices.getUserMedia：麦克风采集
 * - MediaRecorder + isTypeSupported：录音编码
 * 非安全上下文（http:// 且非 localhost）下 navigator.mediaDevices 可能不存在。
 */
export function checkShadowSupport(nav: Navigator | undefined | null, win: Window | undefined | null): ShadowSupport {
  if (win && win.isSecureContext === false) {
    return { ok: false, reason: 'secure-context' };
  }
  const hasGum =
    !!nav &&
    !!nav.mediaDevices &&
    typeof nav.mediaDevices.getUserMedia === 'function';
  if (!hasGum) return { ok: false, reason: 'getUserMedia' };
  // 优先用注入窗口（便于测试），回退真实全局
  const hasRecorder = win
    ? typeof (win as unknown as { MediaRecorder?: unknown }).MediaRecorder === 'function'
    : typeof MediaRecorder === 'function';
  if (!hasRecorder) return { ok: false, reason: 'mediaRecorder' };
  return { ok: true, reason: null };
}

/** 能力缺失 / 权限拒绝时的可恢复提示文案 */
export function supportReasonText(reason: Exclude<ShadowSupport['reason'], null>): string {
  switch (reason) {
    case 'secure-context':
      return '麦克风仅能在安全上下文（HTTPS 或 localhost）下使用，请改用 localhost 或 HTTPS 访问后重试';
    case 'getUserMedia':
      return '当前浏览器不支持麦克风采集（getUserMedia），请改用最新版 Chrome / Edge / Firefox / Safari';
    case 'mediaRecorder':
      return '当前浏览器不支持 MediaRecorder 录音，请更换浏览器后重试';
  }
}

/**
 * 从候选 MIME 中选一个浏览器真正支持的；都不支持返回 ''（交给浏览器默认容器）。
 */
export function pickMimeType(
  MediaRecorderCtor?: { isTypeSupported: (t: string) => boolean }
): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  if (!MediaRecorderCtor) return '';
  return candidates.find((t) => MediaRecorderCtor.isTypeSupported(t)) ?? '';
}

export type MicErrorKind = 'denied' | 'busy' | 'unavailable' | 'unknown';

/** 把 getUserMedia 抛出的错误归一为可恢复的提示类型 */
export function classifyMicError(err: unknown): MicErrorKind {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'unavailable';
    case 'NotReadableError':
    case 'AbortError':
      return 'busy';
    default:
      return 'unknown';
  }
}

/** 各类麦克风错误的可恢复提示（均提供“重新录制”恢复路径） */
export function micErrorText(kind: MicErrorKind): string {
  switch (kind) {
    case 'denied':
      return '麦克风权限被拒绝：请在浏览器地址栏的站点设置中允许麦克风后，点击“开始录制”重试';
    case 'busy':
      return '麦克风被其他应用占用或系统中断了采集，请关闭占用程序后重试';
    case 'unavailable':
      return '未检测到可用的麦克风设备，请连接麦克风后重试';
    case 'unknown':
      return '麦克风启动失败，请检查设备与浏览器权限后重试';
  }
}
