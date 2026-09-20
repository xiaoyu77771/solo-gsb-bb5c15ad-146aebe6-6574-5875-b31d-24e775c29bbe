import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COUNTDOWN_SECONDS,
  SHADOW_DRIFT_LIMIT,
  clampRelative,
  describeGetUserMediaError,
  isRecordingSupported,
  needsDriftCorrection,
  pickRecorderMimeType,
  trackDrift,
  type ShadowErrorState
} from './shadow';

export type ShadowPhase = 'idle' | 'countdown' | 'recording' | 'recorded';
export type ShadowTrackId = 'orig' | 'rec';

export interface UseShadowCompareParams {
  /** 当前选中字幕；null 时面板不可用 */
  cue: { id: string; start: number; end: number; text: string } | null;
  /** 已导入音频的 Object URL；未导入时为 null */
  audioUrl: string | null;
  /** 已导入音频时长（秒），未知时为 0 */
  duration: number;
  /** 非阻断提示（权限 / 启动失败等走专用错误态） */
  onNotice: (text: string) => void;
  /** 进入 / 退出忙碌态（倒计时 + 录音），App 据此暂停 A-B 回卷 */
  onBusyChange: (busy: boolean) => void;
}

interface ActiveSession {
  id: number;
  abort: AbortController;
  range: { start: number; end: number };
  /** 录音推进 rAF */
  tickRaf: number;
  /** 电平表 rAF（与录音推进分开持有，避免句柄互相覆盖） */
  meterRaf: number;
  /** 倒计时定时器 */
  countdownTimer: number | null;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  meterContext: AudioContext | null;
  chunks: BlobPart[];
  /** 停止指令来源，避免 rAF 越过终点与 ended 事件双触发 */
  stopping: boolean;
  /** MediaRecorder 是否已 onstop 落盘 */
  stopped: boolean;
  /** 录音起点（performance.now），用于录音时长回显 */
  startedAt: number;
}

function createInactiveSession(id: number): ActiveSession {
  return {
    id,
    abort: new AbortController(),
    range: { start: 0, end: 0 },
    tickRaf: 0,
    meterRaf: 0,
    countdownTimer: null,
    recorder: null,
    stream: null,
    meterContext: null,
    chunks: [],
    stopping: false,
    stopped: false,
    startedAt: 0
  };
}

/**
 * 单句跟读对比引擎：
 * - 录音：申请麦克风 → 3s 倒计时 → 先启动录音、再从字幕起点播原音 → 字幕终点自动停；
 *   录音 Blob 只以 Object URL 形式存在内存中，刷新 / 关闭即消失，不上传、不落盘。
 * - 回放：原音与录音同步启动，各自音量 / 静音独立；任一路暂停 / 结束 / 重新定位联动另一轨；
 *   rAF 以原音时钟校准录音轨，累计偏差超过 80ms 即纠偏。
 * - 资源纪律：切换字幕、导入新音频、重新录制、组件卸载都会停止并释放
 *   旧 MediaStream、定时器与 Object URL（见 teardownSession）。
 */
export function useShadowCompare(params: UseShadowCompareParams) {
  const { cue, audioUrl, duration, onNotice, onBusyChange } = params;

  const supported = useMemo(() => isRecordingSupported(), []);

  const [phase, setPhaseState] = useState<ShadowPhase>('idle');
  const [countdown, setCountdown] = useState(0);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const [error, setError] = useState<ShadowErrorState | null>(null);
  const [meterLevel, setMeterLevel] = useState(0);
  const [recUrl, setRecUrl] = useState<string | null>(null);
  const [segStart, setSegStart] = useState(0);
  const [segEnd, setSegEnd] = useState(0);
  const [recDuration, setRecDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [origPos, setOrigPos] = useState(0);
  const [recPos, setRecPos] = useState(0);
  const [drift, setDrift] = useState(0);
  const [origVolume, setOrigVolume] = useState(1);
  const [recVolume, setRecVolume] = useState(1);
  const [origMuted, setOrigMuted] = useState(false);
  const [recMuted, setRecMuted] = useState(false);

  // ---- 会话资源 ----
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(0);
  const sessionRef = useRef<ActiveSession>(createInactiveSession(0));
  const phaseRef = useRef<ShadowPhase>('idle');
  const origElRef = useRef<HTMLAudioElement | null>(null);
  const recElRef = useRef<HTMLAudioElement | null>(null);
  const recUrlRef = useRef<string | null>(null);
  const cueRef = useRef(cue);
  const audioUrlRef = useRef(audioUrl);
  const durationRef = useRef(duration);
  const supportedRef = useRef(supported);
  const noticeRef = useRef(onNotice);
  const segRangeRef = useRef({ start: 0, end: 0 });
  const recDurationRef = useRef(0);
  /** 程序性联动标记：防止 play/pause/seek 事件在两轨间互相回环 */
  const syncingRef = useRef(false);
  /** 结束去抖：rAF 判终点与原音 ended 事件可能接连触发 */
  const finishingRef = useRef(false);
  /** 回放校准 rAF */
  const playbackRafRef = useRef(0);
  const playingRef = useRef(false);
  /** 最近一次写入 UI 的偏差值，仅变化超过 4ms 才再次 setState */
  const driftRef = useRef(0);
  // 音量 / 静音的 ref 镜像，供跨会话事件回调读取最新值
  const volumeRef = useRef({ orig: 1, rec: 1 });
  const mutedRef = useRef({ orig: false, rec: false });

  cueRef.current = cue;
  audioUrlRef.current = audioUrl;
  durationRef.current = duration;
  supportedRef.current = supported;
  noticeRef.current = onNotice;
  volumeRef.current = { orig: origVolume, rec: recVolume };
  mutedRef.current = { orig: origMuted, rec: recMuted };

  const setPhase = useCallback((next: ShadowPhase) => {
    if (!mountedRef.current) return;
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  /* ---------------- 资源释放 ---------------- */

  const killAudio = useCallback((el: HTMLAudioElement | null) => {
    if (!el) return;
    el.pause();
    el.removeAttribute('src');
    try {
      el.load(); // 中断挂起的解码 / 下载
    } catch {
      /* 部分浏览器对无 src 调 load 抛错，忽略 */
    }
  }, []);

  const stopMeter = useCallback((s: ActiveSession) => {
    if (s.meterRaf) {
      cancelAnimationFrame(s.meterRaf);
      s.meterRaf = 0;
    }
    if (!s.meterContext) return;
    void s.meterContext.close().catch(() => undefined);
    s.meterContext = null;
  }, []);

  /**
   * 拆除当前跟读会话：取消定时器 / rAF、停 MediaRecorder 并等待落盘回调由调用方处理，
   * 释放 MediaStream 与电平分析 AudioContext、释放录音 Object URL、销毁两轨音频元素。
   * 参数 resetUi 控制是否把界面状态复位（重新录制时由 enterPlayback 接管状态，不复位）。
   */
  const teardownSession = useCallback(
    (resetUi: boolean) => {
      const s = sessionRef.current;
      s.abort.abort();
      if (s.countdownTimer !== null) {
        window.clearInterval(s.countdownTimer);
        s.countdownTimer = null;
      }
      if (s.tickRaf) cancelAnimationFrame(s.tickRaf);
      s.tickRaf = 0;
      if (s.meterRaf) cancelAnimationFrame(s.meterRaf);
      s.meterRaf = 0;
      if (playbackRafRef.current) {
        cancelAnimationFrame(playbackRafRef.current);
        playbackRafRef.current = 0;
      }
      playingRef.current = false;
      syncingRef.current = false;
      finishingRef.current = false;

      // 先摘除 recorder 事件再 stop：不希望拆除路径触发 onstop 落盘
      if (s.recorder && s.recorder.state !== 'inactive') {
        try {
          s.recorder.ondataavailable = null;
          s.recorder.onstop = null;
          s.recorder.stop();
        } catch {
          /* 已停止时忽略 */
        }
      }
      s.recorder = null;

      // 关闭电平分析（独立 AudioContext，与静音分析的缓存上下文无关）
      stopMeter(s);

      // 释放麦克风：停所有轨道后设备指示灯熄灭
      if (s.stream) {
        s.stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        s.stream = null;
      }

      // 销毁两轨音频元素（事件随元素一起被 GC）
      killAudio(origElRef.current);
      origElRef.current = null;
      killAudio(recElRef.current);
      recElRef.current = null;

      // 录音 Object URL 只在当前浏览器会话内有效，切字幕 / 换音频 / 重录 / 卸载即回收
      if (recUrlRef.current) {
        URL.revokeObjectURL(recUrlRef.current);
        recUrlRef.current = null;
      }

      // 建一个空壳会话，旧 abort 信号已失效，任何挂起的异步回调读到即落空
      sessionIdRef.current += 1;
      sessionRef.current = createInactiveSession(sessionIdRef.current);

      if (resetUi && mountedRef.current) {
        setPhase('idle');
        setCountdown(0);
        setRecordElapsed(0);
        setMeterLevel(0);
        setRecUrl(null);
        setRecDuration(0);
        setPlaying(false);
        setOrigPos(0);
        setRecPos(0);
        setDrift(0);
        setSegStart(0);
        setSegEnd(0);
      }
    },
    [killAudio, setPhase, stopMeter]
  );

  /* ---------------- 电平表 ---------------- */

  const startMeter = useCallback(
    (s: ActiveSession, stream: MediaStream) => {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return; // 无 Web Audio 不影响录音，仅不显示电平
      try {
        const ctx = new Ctor();
        void ctx.resume().catch(() => undefined);
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser); // 只连 analyser，不接 destination，避免啸叫
        const buf = new Float32Array(analyser.fftSize);
        const loop = () => {
          if (s !== sessionRef.current || !mountedRef.current) return;
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i]);
            if (v > peak) peak = v;
          }
          setMeterLevel(Number(peak.toFixed(3)));
          s.meterRaf = requestAnimationFrame(loop);
        };
        s.meterContext = ctx;
        s.meterRaf = requestAnimationFrame(loop);
      } catch {
        /* 电平表失败可忽略 */
      }
    },
    []
  );

  /* ---------------- 回放（recorded 阶段）编排 ---------------- */

  /** 同步两轨播放状态到 UI；两轨均暂停才认为回放暂停 */
  const syncPlayingState = useCallback(() => {
    const orig = origElRef.current;
    const rec = recElRef.current;
    const isPlaying = !!orig && !!rec && !orig.paused && !rec.paused;
    playingRef.current = isPlaying;
    setPlaying(isPlaying);
  }, []);

  /** 回放结束：两轨都停在起点并复位 UI（保持 recorded 阶段可再次播放） */
  const finishPlayback = useCallback(() => {
    const s = sessionRef.current;
    if (s.abort.signal.aborted) return;
    if (finishingRef.current) return; // rAF 判终点与 ended 事件去重
    finishingRef.current = true;
    if (playbackRafRef.current) {
      cancelAnimationFrame(playbackRafRef.current);
      playbackRafRef.current = 0;
    }
    syncingRef.current = true;
    const { start } = segRangeRef.current;
    const orig = origElRef.current;
    const rec = recElRef.current;
    if (orig) orig.currentTime = start;
    if (rec) rec.currentTime = 0;
    syncingRef.current = false;
    playingRef.current = false;
    setPlaying(false);
    setOrigPos(0);
    setRecPos(0);
    setDrift(0);
  }, []);

  /** 回放校准循环：以原音时钟为主，录音轨偏差超 80ms 即拉回 */
  const startPlaybackLoop = useCallback(() => {
    finishingRef.current = false;
    if (playbackRafRef.current) cancelAnimationFrame(playbackRafRef.current);
    const tick = () => {
      const s = sessionRef.current;
      if (s.abort.signal.aborted || phaseRef.current !== 'recorded') return;
      const orig = origElRef.current;
      const rec = recElRef.current;
      if (!orig || !rec) return;

      const { start, end } = segRangeRef.current;
      const oRel = orig.currentTime - start;
      const rRel = rec.currentTime;
      const d = trackDrift(oRel, rRel);

      // 累计偏差超过阈值：把录音轨重新定位到原音时钟对应的相对位置
      if (!orig.paused && needsDriftCorrection(d)) {
        syncingRef.current = true;
        try {
          rec.currentTime = clampRelative(oRel, recDurationRef.current);
        } finally {
          syncingRef.current = false;
        }
      }

      setOrigPos(clampRelative(oRel, end - start));
      setRecPos(clampRelative(rRel, recDurationRef.current));
      if (Math.abs(d - driftRef.current) > 0.004) {
        driftRef.current = d;
        setDrift(d);
      }

      // 原音到达终点：联动两轨结束（rec 可能略长 / 略短）
      if (!orig.paused && orig.currentTime >= end - 1e-6) {
        syncingRef.current = true;
        orig.pause();
        if (!rec.paused) rec.pause();
        syncingRef.current = false;
        finishPlayback();
        return;
      }
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);
  }, [finishPlayback]);

  /* ---------------- 录音（countdown / recording 阶段）编排 ---------------- */

  /**
   * 结束录音：幂等。由终点 rAF、原音 ended、停止按钮或 teardown 调用；
   * MediaRecorder 停后 onstop 落盘并进入回放阶段。
   */
  const stopRecording = useCallback(
    (sArg?: ActiveSession) => {
      const s = sArg ?? sessionRef.current;
      if (sArg && sArg !== sessionRef.current) return; // 旧会话的迟到调用
      if (s.stopping) return;
      s.stopping = true;
      const orig = origElRef.current;
      if (orig && !orig.paused) orig.pause();
      if (s.recorder && s.recorder.state !== 'inactive') {
        try {
          s.recorder.stop(); // onstop 中落盘
        } catch {
          /* ignore */
        }
      }
      if (s.tickRaf) {
        cancelAnimationFrame(s.tickRaf);
        s.tickRaf = 0;
      }
      stopMeter(s);
    },
    [stopMeter]
  );

  /** 录音中：推进时长回显；原音到达字幕终点（裁剪到音频结尾）自动停止 */
  const startRecordingTick = useCallback(
    (s: ActiveSession) => {
      const tick = () => {
        if (s !== sessionRef.current || s.abort.signal.aborted) return;
        const orig = origElRef.current;
        if (orig) {
          setRecordElapsed(
            Math.max(0, Math.min(orig.currentTime - s.range.start, s.range.end - s.range.start))
          );
          if (!orig.paused && orig.currentTime >= s.range.end - 1e-6) {
            orig.pause();
            stopRecording(s);
            return;
          }
        } else {
          // 原音元素尚未就绪时按墙上时钟回显
          setRecordElapsed((performance.now() - s.startedAt) / 1000);
        }
        s.tickRaf = requestAnimationFrame(tick);
      };
      s.tickRaf = requestAnimationFrame(tick);
    },
    [stopRecording]
  );

  /**
   * MediaRecorder 落盘后：释放麦克风，创建录音轨，进入双轨回放阶段。
   * 录音 Blob URL 仅存内存；进入前先释放麦克风（录音轨播放不需要它）。
   */
  const enterPlayback = useCallback(
    (s: ActiveSession, blob: Blob) => {
      if (s !== sessionRef.current || s.abort.signal.aborted) return;

      // 麦克风与电平表不再需要，尽早释放
      if (s.stream) {
        s.stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        s.stream = null;
      }
      stopMeter(s);
      setMeterLevel(0);

      const { start, end } = s.range;
      const url = URL.createObjectURL(blob);
      if (recUrlRef.current) URL.revokeObjectURL(recUrlRef.current);
      recUrlRef.current = url;

      const orig = origElRef.current;
      if (orig) {
        orig.currentTime = start;
        orig.volume = volumeRef.current.orig;
        orig.muted = mutedRef.current.orig;
      }

      const rec = new Audio();
      rec.preload = 'auto';
      rec.volume = volumeRef.current.rec;
      rec.muted = mutedRef.current.rec;
      rec.src = url;

      // 绑定录音轨事件（通过 abort signal 统一摘除）
      const signal = s.abort.signal;
      const onRecPlay = () => {
        if (signal.aborted || phaseRef.current !== 'recorded') return;
        const o = origElRef.current;
        if (o && o.paused) {
          syncingRef.current = true;
          void o.play().catch(() => undefined);
          syncingRef.current = false;
        }
        startPlaybackLoop();
        syncPlayingState();
      };
      const onRecPause = () => {
        if (signal.aborted || phaseRef.current !== 'recorded' || syncingRef.current) return;
        const o = origElRef.current;
        if (o && !o.paused) {
          syncingRef.current = true;
          o.pause();
          syncingRef.current = false;
        }
        syncPlayingState();
      };
      const onRecEnded = () => {
        if (signal.aborted || phaseRef.current !== 'recorded') return;
        const o = origElRef.current;
        if (o && !o.paused) {
          syncingRef.current = true;
          o.pause();
          syncingRef.current = false;
        }
        finishPlayback();
      };
      const onRecSeeked = () => {
        if (signal.aborted || phaseRef.current !== 'recorded') return;
        const o = origElRef.current;
        if (!o) return;
        // 程序性联动 seek 完成时两轨位置已对齐，直接忽略（seeked 为异步事件，
        // 不能依赖同步标记；用位置一致性区分"用户拖动"与"联动余波"）
        const expected = segRangeRef.current.start + rec.currentTime;
        if (Math.abs(o.currentTime - expected) <= 0.03) return;
        syncingRef.current = true;
        o.currentTime = clampRelative(expected, o.duration || expected);
        syncingRef.current = false;
      };
      rec.addEventListener('play', onRecPlay, { signal });
      rec.addEventListener('pause', onRecPause, { signal });
      rec.addEventListener('ended', onRecEnded, { signal });
      rec.addEventListener('seeked', onRecSeeked, { signal });
      recElRef.current = rec;

      // 录音时长以其 own metadata 为准；加载完成前先用区间长度兜底
      const fallback = Math.max(0, end - start);
      recDurationRef.current = fallback;
      setRecUrl(url);
      setRecDuration(fallback);
      setSegStart(start);
      setSegEnd(end);
      segRangeRef.current = { start, end };
      setOrigPos(0);
      setRecPos(0);
      driftRef.current = 0;
      setDrift(0);
      setPlaying(false);
      setRecordElapsed(0);
      setPhase('recorded');

      let settled = false;
      const settle = () => {
        if (settled || signal.aborted) return;
        settled = true;
        const d = Number.isFinite(rec.duration) && rec.duration > 0 ? rec.duration : fallback;
        recDurationRef.current = d;
        setRecDuration(d);
      };
      rec.addEventListener('loadedmetadata', settle, { signal });
      void rec.load();
    },
    [finishPlayback, setPhase, startPlaybackLoop, stopMeter, syncPlayingState]
  );

  /* ---------------- 启动：权限 -> 倒计时 -> 录音 ---------------- */

  /** 倒计时结束：先启动麦克风录音，再从字幕起点播原音 */
  const beginCapture = useCallback(
    (s: ActiveSession, stream: MediaStream) => {
      if (s !== sessionRef.current || s.abort.signal.aborted) return;
      const { start } = s.range;
      const orig = origElRef.current;
      if (!orig) return;

      let mimeType = '';
      const Ctor = window.MediaRecorder;
      if (Ctor && typeof Ctor.isTypeSupported === 'function') {
        mimeType = pickRecorderMimeType((m) => Ctor.isTypeSupported(m));
      }

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        teardownSession(true);
        setError({
          kind: 'device',
          text: err instanceof Error ? `录音初始化失败：${err.message}` : '录音初始化失败，可重试',
          recoverable: true
        });
        return;
      }
      s.recorder = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) s.chunks.push(ev.data);
      };
      recorder.onstop = () => {
        if (s !== sessionRef.current) return; // 旧会话（拆除路径），丢弃数据
        if (s.stopped) return;
        s.stopped = true;
        if (s.chunks.length === 0) {
          teardownSession(true);
          setError({ kind: 'unknown', text: '未采集到任何音频数据，可重试', recoverable: true });
          return;
        }
        const type = recorder.mimeType || mimeType || '';
        const blob = new Blob(s.chunks, type ? { type } : undefined);
        enterPlayback(s, blob);
      };
      recorder.onerror = () => {
        if (s !== sessionRef.current) return;
        noticeRef.current('录音过程中出现设备错误');
      };

      orig.currentTime = start;
      orig.volume = volumeRef.current.orig;
      orig.muted = mutedRef.current.orig;

      // 严格按要求的顺序：先启动麦克风录音，再播放原音
      try {
        recorder.start(250); // 每 250ms 一片，降低意外中断时的数据损失
      } catch (err) {
        teardownSession(true);
        setError({
          kind: 'device',
          text: err instanceof Error ? `录音启动失败：${err.message}` : '录音启动失败，可重试',
          recoverable: true
        });
        return;
      }
      s.startedAt = performance.now();
      setPhase('recording');
      startMeter(s, stream);
      startRecordingTick(s);

      // 录音先跑起来，再启动原音播放（play() 异步，期间录音已在采）
      window.setTimeout(
        () => {
          if (s !== sessionRef.current || s.abort.signal.aborted) return;
          const el = origElRef.current;
          if (!el) return;
          el.currentTime = start;
          void el.play().catch((err: unknown) => {
            if (s !== sessionRef.current) return;
            stopRecording(s);
            setError({
              kind: 'unknown',
              text: err instanceof Error ? `原音播放失败：${err.message}` : '原音播放失败，可重试',
              recoverable: true
            });
          });
        },
        // 短暂预热录音管线；用 0 即可满足"先录音后原音"，这里留 60ms 让首帧采集到位
        60
      );
    },
    [enterPlayback, noticeRef, setError, setPhase, startMeter, startRecordingTick, stopRecording, teardownSession]
  );

  /** 开始一次跟读：能力 / 前置条件检查 -> 申请麦克风 -> 倒计时 3s -> 录音 */
  const start = useCallback(() => {
    if (!supportedRef.current) {
      setError({
        kind: 'unsupported',
        text: '当前浏览器不支持麦克风录音（需要 getUserMedia 与 MediaRecorder），请换用现代浏览器后重试',
        recoverable: false
      });
      return;
    }
    const currentCue = cueRef.current;
    const url = audioUrlRef.current;
    if (!currentCue) {
      noticeRef.current('请先在时间轴或字幕列表中选择一条字幕');
      return;
    }
    if (!url) {
      noticeRef.current('请先导入音频再开始跟读');
      return;
    }
    if (currentCue.end <= currentCue.start) {
      noticeRef.current('该字幕时长无效（结束时间不晚于开始时间）');
      return;
    }

    // 重新录制 / 残留会话：先释放旧 MediaStream、定时器与 Object URL
    teardownSession(true);
    const sid = sessionIdRef.current;
    const s = createInactiveSession(sid);
    sessionRef.current = s;
    setError(null);
    setCountdown(COUNTDOWN_SECONDS);
    setPhase('countdown');

    // 预建原音轨元素（使用与主导航相同的 Object URL，独立播放不互相干扰）
    const orig = new Audio();
    orig.preload = 'auto';
    orig.src = url;
    const signal = s.abort.signal;
    orig.addEventListener(
      'ended',
      () => {
        if (signal.aborted || s !== sessionRef.current) return;
        // B 点恰为音频结尾时 ended 先于 rAF 判定
        if (phaseRef.current === 'recording') void stopRecording(s);
        else if (phaseRef.current === 'recorded') {
          const rec = recElRef.current;
          if (rec && !rec.paused) {
            syncingRef.current = true;
            rec.pause();
            syncingRef.current = false;
          }
          finishPlayback();
        }
      },
      { signal }
    );
    orig.addEventListener(
      'play',
      () => {
        if (signal.aborted || phaseRef.current !== 'recorded' || syncingRef.current) return;
        const rec = recElRef.current;
        if (rec && rec.paused) {
          syncingRef.current = true;
          void rec.play().catch(() => undefined);
          syncingRef.current = false;
        }
        startPlaybackLoop();
        syncPlayingState();
      },
      { signal }
    );
    orig.addEventListener(
      'pause',
      () => {
        if (signal.aborted || phaseRef.current !== 'recorded' || syncingRef.current) return;
        const rec = recElRef.current;
        if (rec && !rec.paused) {
          syncingRef.current = true;
          rec.pause();
          syncingRef.current = false;
        }
        syncPlayingState();
      },
      { signal }
    );
    orig.addEventListener(
      'seeked',
      () => {
        if (signal.aborted || phaseRef.current !== 'recorded') return;
        const rec = recElRef.current;
        if (!rec) return;
        const rel = orig.currentTime - segRangeRef.current.start;
        // 联动 seek 的余波：录音轨已在目标位置则不再回 seek，杜绝异步事件回环
        if (Math.abs(rec.currentTime - clampRelative(rel, recDurationRef.current)) <= 0.03) return;
        syncingRef.current = true;
        rec.currentTime = clampRelative(rel, recDurationRef.current);
        syncingRef.current = false;
      },
      { signal }
    );
    origElRef.current = orig;
    void orig.load();

    // 先申请麦克风权限（用户手势链中），成功后才进入倒计时
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
      .then((stream) => {
        if (s !== sessionRef.current || signal.aborted) {
          // 倒计时期间被取消 / 已切换字幕：立刻释放刚拿到的设备
          stream.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          });
          return;
        }
        s.stream = stream;

        // 区间裁剪到音频时长；开始前确保原音已 seek 到起点
        const dur = durationRef.current;
        const startT = Math.max(0, currentCue.start);
        const endT =
          dur > 0
            ? Math.min(Math.max(currentCue.end, startT + 0.05), dur)
            : currentCue.end;
        s.range = { start: startT, end: endT };

        const beginWhenReady = () => {
          if (s !== sessionRef.current || signal.aborted) return;
          orig.currentTime = startT;
          beginCapture(s, stream);
        };

        // 倒计时：3 -> 2 -> 1 -> 开录
        let remain = COUNTDOWN_SECONDS;
        s.countdownTimer = window.setInterval(
          () => {
            if (s !== sessionRef.current || signal.aborted) return;
            remain -= 1;
            if (remain <= 0) {
              if (s.countdownTimer !== null) {
                window.clearInterval(s.countdownTimer);
                s.countdownTimer = null;
              }
              beginWhenReady();
              return;
            }
            setCountdown(remain);
          },
          1000
        );
      })
      .catch((err: unknown) => {
        if (s !== sessionRef.current) return; // 已被新会话取代
        teardownSession(true);
        setError(describeGetUserMediaError(err));
      });
  }, [
    beginCapture,
    cueRef,
    durationRef,
    finishPlayback,
    noticeRef,
    setError,
    setPhase,
    startPlaybackLoop,
    stopRecording,
    supportedRef,
    syncPlayingState,
    teardownSession
  ]);

  /** 倒计时 / 录音中用户手动取消或提前停止 */
  const cancelOrStop = useCallback(() => {
    const phaseNow = phaseRef.current;
    if (phaseNow === 'countdown') {
      teardownSession(true);
    } else if (phaseNow === 'recording') {
      // 提前停止同样落盘，允许用户回放较短录音并重录
      stopRecording();
    }
  }, [stopRecording, teardownSession]);

  /** 放弃当前录音（recorded 阶段回到 idle，释放所有资源） */
  const discard = useCallback(() => {
    teardownSession(true);
  }, [teardownSession]);

  /** 重新录制：释放旧录音资源并立即开始新一轮 */
  const reRecord = useCallback(() => {
    start();
  }, [start]);

  /* ---------------- 回放双轨联动控制 ---------------- */

  /** 任一路的播放 / 暂停都联动另一轨（先启动落后的录音轨，偏差由 rAF 纠） */
  const toggleTrack = useCallback(
    (id: ShadowTrackId) => {
      if (phaseRef.current !== 'recorded') return;
      const orig = origElRef.current;
      const rec = recElRef.current;
      if (!orig || !rec) return;
      const source = id === 'orig' ? orig : rec;
      const other = id === 'orig' ? rec : orig;
      if (source.paused) {
        // 原音已播到终点再次点播放：两轨复位后同步从头播
        if (orig.currentTime >= segRangeRef.current.end - 1e-6) {
          syncingRef.current = true;
          orig.currentTime = segRangeRef.current.start;
          rec.currentTime = 0;
          syncingRef.current = false;
        }
        syncingRef.current = true;
        // 先启动另一轨（多为录音，play() 建立延迟更大），再启动本轨
        void other.play().catch(() => undefined);
        void source.play().catch(() => undefined);
        syncingRef.current = false;
      } else {
        syncingRef.current = true;
        source.pause();
        other.pause();
        syncingRef.current = false;
      }
      syncPlayingState();
    },
    [syncPlayingState]
  );

  /** 任一路重新定位都联动另一轨（区间相对时间 1:1 映射） */
  const seekTrack = useCallback((id: ShadowTrackId, relative: number) => {
    if (phaseRef.current !== 'recorded') return;
    const orig = origElRef.current;
    const rec = recElRef.current;
    if (!orig || !rec) return;
    const { start, end } = segRangeRef.current;
    const rel = clampRelative(relative, Math.max(end - start, recDurationRef.current));
    syncingRef.current = true;
    try {
      if (id === 'orig') {
        orig.currentTime = clampRelative(start + rel, orig.duration || start + rel);
        rec.currentTime = clampRelative(rel, recDurationRef.current);
      } else {
        rec.currentTime = clampRelative(rel, recDurationRef.current);
        orig.currentTime = clampRelative(start + rel, orig.duration || start + rel);
      }
    } finally {
      syncingRef.current = false;
    }
    setOrigPos(clampRelative(orig.currentTime - start, end - start));
    setRecPos(clampRelative(rec.currentTime, recDurationRef.current));
    driftRef.current = trackDrift(orig.currentTime - start, rec.currentTime);
    setDrift(driftRef.current);
  }, []);

  const setTrackVolume = useCallback((id: ShadowTrackId, v: number) => {
    const value = clampRelative(v, 1);
    if (id === 'orig') {
      setOrigVolume(value);
      if (origElRef.current) origElRef.current.volume = value;
    } else {
      setRecVolume(value);
      if (recElRef.current) recElRef.current.volume = value;
    }
  }, []);

  const toggleTrackMute = useCallback((id: ShadowTrackId) => {
    if (id === 'orig') {
      setOrigMuted((m) => {
        if (origElRef.current) origElRef.current.muted = !m;
        return !m;
      });
    } else {
      setRecMuted((m) => {
        if (recElRef.current) recElRef.current.muted = !m;
        return !m;
      });
    }
  }, []);

  /* ---------------- 生命周期：切字幕 / 换音频 / 卸载 ---------------- */

  // 记录上一轮 key，首次挂载不触发拆除
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = cue && audioUrl ? `${cue.id}@${audioUrl}` : null;
    const prev = lastKeyRef.current;
    lastKeyRef.current = key;
    if (prev !== null && prev !== key) {
      // 切换字幕或导入新音频：停止并释放旧 MediaStream、定时器与 Object URL
      teardownSession(true);
    }
  }, [cue, audioUrl, teardownSession]);

  // 忙碌态（倒计时 + 录音）变化通知 App
  const busy = phase === 'countdown' || phase === 'recording';
  const lastBusyRef = useRef(false);
  useEffect(() => {
    if (lastBusyRef.current !== busy) {
      lastBusyRef.current = busy;
      onBusyChange(busy);
    }
  }, [busy, onBusyChange]);

  // 卸载：释放全部会话资源与两轨元素
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardownSession(false);
    };
  }, [teardownSession]);

  const rangeLength = Math.max(0, segEnd - segStart);

  return {
    supported,
    phase,
    countdown,
    recordElapsed,
    error,
    meterLevel,
    recUrl,
    playing,
    origPos,
    recPos,
    drift,
    origVolume,
    recVolume,
    origMuted,
    recMuted,
    rangeLength,
    recDuration,
    driftLimit: SHADOW_DRIFT_LIMIT,
    start,
    cancelOrStop,
    discard,
    reRecord,
    toggleTrack,
    seekTrack,
    setTrackVolume,
    toggleTrackMute,
    dismissError: () => setError(null)
  };
}
