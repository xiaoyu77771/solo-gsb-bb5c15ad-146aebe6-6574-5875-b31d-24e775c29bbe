import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cue } from '../types';
import { formatClock } from '../lib/srt';
import {
  checkShadowSupport,
  classifyMicError,
  COUNTDOWN_SECONDS,
  micErrorText,
  pickMimeType,
  supportReasonText,
  syncTarget,
  SYNC_TOLERANCE
} from '../lib/shadowing';

type Phase = 'idle' | 'countdown' | 'recording' | 'recorded';
type NotifyKind = 'warn' | 'info' | 'error';

interface ShadowPanelProps {
  /** 当前选中字幕；切换时立即释放旧录音会话 */
  cue: Cue | null;
  /** 当前导入音频的 Object URL（变化 = 导入了新音频，必须释放旧会话） */
  audioUrl: string | null;
  duration: number;
  /** App 侧共享的原音 <audio> 元素（懒创建，导入音频后必存在） */
  audioElRef: { current: HTMLAudioElement | null };
  /** 倒计时 + 录音期间为 true，App 据此暂停 A-B 回卷并屏蔽空格走带 */
  onBusyChange: (busy: boolean) => void;
  onNotify: (kind: NotifyKind, text: string) => void;
}

interface Zone {
  a: number;
  b: number;
  dur: number;
}

interface PanelError {
  text: string;
  /** 权限 / 设备类错误可在用户处理后原地重试；浏览器不支持不可恢复 */
  recoverable: boolean;
}

/**
 * 单句跟读对比。
 *
 * 资源纪律：每次开始 / 取消 / 切换字幕 / 换音频 / 卸载都令会话号 +1，
 * 所有异步回调先校验会话号，并停止 MediaStream 轨道、清除定时器/rAF、
 * 撤销录音 Object URL——旧回调读到失效会话即落空（与 A-B 循环同一思路）。
 */
export default function ShadowPanel({
  cue,
  audioUrl,
  duration,
  audioElRef,
  onBusyChange,
  onNotify
}: ShadowPanelProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<PanelError | null>(null);
  const [comparePlaying, setComparePlaying] = useState(false);
  const [origPos, setOrigPos] = useState(0);
  const [recPos, setRecPos] = useState(0);
  const [origVolume, setOrigVolume] = useState(1);
  const [origMuted, setOrigMuted] = useState(false);
  const [recVolume, setRecVolume] = useState(1);
  const [recMuted, setRecMuted] = useState(false);

  /* ---------------- 会话与资源句柄 ---------------- */

  const sessionRef = useRef(0);
  const activeRef = useRef(false);
  const busyRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const streamPromiseRef = useRef<Promise<MediaStream> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recElRef = useRef<HTMLAudioElement | null>(null);
  const recUrlRef = useRef<string | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const safetyTimerRef = useRef<number | null>(null);
  const recordRafRef = useRef<number | null>(null);
  const compareRafRef = useRef<number | null>(null);
  const pendingZoneRef = useRef<Zone | null>(null);
  const zoneRef = useRef<Zone | null>(null);
  /** 非 null 表示正在对比回放：原音/录音的播放暂停与定位事件需要联动 */
  const compareSessionRef = useRef<number | null>(null);
  /** 程序内部联动操作期间抑制反向事件，避免互相拉扯 */
  const linkingRef = useRef(false);
  const syncingRef = useRef(false);
  const recVolRef = useRef(1);

  const support = useMemo(
    () =>
      checkShadowSupport(
        typeof navigator !== 'undefined' ? navigator : undefined,
        typeof window !== 'undefined' ? window : undefined
      ),
    []
  );

  const zone = useMemo<Zone | null>(() => {
    if (!cue) return null;
    const a = Math.max(0, cue.start);
    const b = duration > 0 ? Math.min(cue.end, duration) : cue.end;
    if (!(b - a >= 0.05)) return null;
    return { a, b, dur: Number((b - a).toFixed(3)) };
  }, [cue, duration]);
  zoneRef.current = zone;

  const setBusy = useCallback(
    (b: boolean) => {
      if (busyRef.current !== b) {
        busyRef.current = b;
        onBusyChange(b);
      }
    },
    [onBusyChange]
  );

  const clearTimers = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (safetyTimerRef.current !== null) {
      window.clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
    if (recordRafRef.current !== null) {
      cancelAnimationFrame(recordRafRef.current);
      recordRafRef.current = null;
    }
    if (compareRafRef.current !== null) {
      cancelAnimationFrame(compareRafRef.current);
      compareRafRef.current = null;
    }
  }, []);

  /** 释放麦克风、录音器、定时器与录音 Object URL；active 时一并停止原音与对比 */
  const teardown = useCallback(() => {
    sessionRef.current += 1; // 所有在途倒计时 / 采集 / onstop 回调立即失效
    activeRef.current = false;
    clearTimers();

    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        /* 已停止 */
      }
      recorderRef.current = null;
    }
    chunksRef.current = [];

    const stream = streamRef.current;
    stream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    streamRef.current = null;
    streamPromiseRef.current = null;

    const wasComparing = compareSessionRef.current !== null;
    compareSessionRef.current = null;
    linkingRef.current = false;
    syncingRef.current = false;
    const recEl = recElRef.current;
    if (recEl) {
      try {
        recEl.pause();
      } catch {
        /* ignore */
      }
    }
    if (recUrlRef.current) {
      URL.revokeObjectURL(recUrlRef.current);
      recUrlRef.current = null;
      if (recEl) {
        recEl.removeAttribute('src');
        recEl.load();
      }
    }
    // 仅在跟读会话（倒计时/录音/对比）中才接管原音；空闲时选择字幕不应打断正常试听
    if (wasComparing) {
      try {
        audioElRef.current?.pause();
      } catch {
        /* ignore */
      }
    }

    setPhase('idle');
    setCountdown(0);
    setComparePlaying(false);
    setOrigPos(0);
    setRecPos(0);
    setBusy(false);
  }, [audioElRef, clearTimers, setBusy]);

  /* ---------------- 切换字幕 / 导入新音频 / 卸载 ---------------- */

  const resetKey = `${cue?.id ?? ''}|${audioUrl ?? ''}`;
  const resetKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (resetKeyRef.current === null) {
      resetKeyRef.current = resetKey;
      return; // 首次挂载无旧会话可释放
    }
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      if (activeRef.current) teardown();
    }
  }, [resetKey, teardown]);

  useEffect(() => {
    return () => {
      teardown();
      // 卸载原音联动监听（见下方 effect）与录音元素
      recElRef.current = null;
    };
  }, [teardown]);

  /* ---------------- 录音失败（可恢复提示） ---------------- */

  const failSession = useCallback(
    (err: unknown) => {
      sessionRef.current += 1;
      activeRef.current = false;
      clearTimers();
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          /* ignore */
        }
        recorderRef.current = null;
      }
      chunksRef.current = [];
      const stream = streamRef.current;
      stream?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      streamRef.current = null;
      streamPromiseRef.current = null;
      const text = micErrorText(classifyMicError(err));
      setError({ text, recoverable: true });
      setPhase('idle');
      setCountdown(0);
      setBusy(false);
    },
    [clearTimers, setBusy]
  );

  /* ---------------- 录制：倒计时 → 先开麦 → 再放原音 → 终点自停 ---------------- */

  const finalizeRecording = useCallback(
    (session: number, z: Zone) => {
      const recorder = recorderRef.current;
      if (!recorder) return;
      if (recordRafRef.current !== null) {
        cancelAnimationFrame(recordRafRef.current);
        recordRafRef.current = null;
      }
      if (safetyTimerRef.current !== null) {
        window.clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
      // 先停原音；onstop 里再释放麦克风与 Blob
      const orig = audioElRef.current;
      try {
        orig?.pause();
      } catch {
        /* ignore */
      }

      recorder.onstop = () => {
        if (session !== sessionRef.current) {
          // 会话已被切换/取消/换音频作废旧：释放轨道，不产生 URL
          streamRef.current?.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          });
          streamRef.current = null;
          recorderRef.current = null;
          chunksRef.current = [];
          return;
        }
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        recorderRef.current = null;
        streamRef.current?.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        streamRef.current = null;

        if (blob.size === 0) {
          if (recUrlRef.current) URL.revokeObjectURL(recUrlRef.current);
          recUrlRef.current = null;
          activeRef.current = false;
          setPhase('idle');
          setBusy(false);
          setError({ text: '没有录到任何声音，请检查麦克风输入后重新录制', recoverable: true });
          return;
        }

        if (recUrlRef.current) URL.revokeObjectURL(recUrlRef.current); // 重新录制：释放旧 URL
        const url = URL.createObjectURL(blob);
        recUrlRef.current = url;

        let recEl = recElRef.current;
        if (!recEl) {
          recEl = new Audio();
          recEl.preload = 'auto';
          attachRecListeners(recEl);
          recElRef.current = recEl;
        }
        recEl.src = url;
        recEl.load();
        recEl.volume = recVolRef.current;

        if (orig) orig.currentTime = z.a; // 回到字幕起点，便于从头对比
        setOrigPos(0);
        setRecPos(0);
        setComparePlaying(false);
        setBusy(false);
        setPhase('recorded');
      };

      try {
        recorder.stop();
      } catch {
        /* onstop 仍会被状态机触发 */
      }
    },
    [audioElRef, setBusy]
  );
  // finalizeRecording 在 attachRecListeners 之后定义，但仅在事件回调中调用，延迟解析无碍
  const finalizeRef = useRef(finalizeRecording);
  finalizeRef.current = finalizeRecording;

  const launchCapture = useCallback(
    async (session: number) => {
      const z = pendingZoneRef.current;
      const promise = streamPromiseRef.current;
      const orig = audioElRef.current;
      if (!z || !promise || !orig) {
        if (session === sessionRef.current) failSession(new Error('录音条件已失效，请重试'));
        return;
      }
      let stream: MediaStream;
      try {
        stream = await promise;
      } catch (err) {
        if (session === sessionRef.current) failSession(err); // 权限拒绝/占用/无设备
        return;
      }
      if (session !== sessionRef.current) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        return;
      }
      streamRef.current = stream;

      let recorder: MediaRecorder;
      try {
        const mime = pickMimeType(typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined);
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch (err) {
        failSession(err);
        return;
      }
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      // 规定顺序：先启动麦克风录音，再从字幕起点播放原音。
      // play() 不 await（其 Promise 常在 canplay 后才 resolve），保证「先麦后原音」紧邻；
      // 自动播放被拒绝则走 catch 终止本次录音并给出可恢复提示。
      orig.pause();
      orig.currentTime = z.a;
      let playStarted = false;
      try {
        recorder.start(250);
        const playPromise = orig.play();
        playStarted = true;
        void playPromise.catch((err) => {
          if (session === sessionRef.current) failSession(err);
        });
      } catch (err) {
        if (!playStarted) {
          // recorder.start 同步抛错：停止并释放本次采集
          if (session === sessionRef.current) failSession(err);
          return;
        }
      }
      if (session !== sessionRef.current) return;

      setPhase('recording');

      // 帧级检查：到字幕终点（或原音结束）自动停止。
      // 不在此处理 paused：play() 调用与真正播放之间存在短暂窗口，元素仍可能
      // 报 paused；播放失败由上方 play() 的 catch 兜底，手动暂停由安全定时器兜底。
      const tick = () => {
        if (session !== sessionRef.current) return;
        const el = audioElRef.current;
        if (!el) {
          finalizeRef.current(session, z);
          return;
        }
        const rel = el.currentTime - z.a;
        if (el.ended || (!el.paused && rel >= z.dur)) {
          finalizeRef.current(session, z);
          return;
        }
        recordRafRef.current = requestAnimationFrame(tick);
      };
      recordRafRef.current = requestAnimationFrame(tick);

      // 兜底：原音意外暂停 / 事件失灵时也保证录音会停、麦克风会释放
      safetyTimerRef.current = window.setTimeout(() => {
        if (session === sessionRef.current) finalizeRef.current(session, z);
      }, z.dur * 1000 + 4000);
    },
    [audioElRef, failSession]
  );

  const startRecording = useCallback(() => {
    const z = zoneRef.current;
    const el = audioElRef.current;
    if (!support.ok || !z || !audioUrl || !el) return;
    setError(null);
    activeRef.current = true;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    pendingZoneRef.current = z;

    // 权限请求与倒计时并行：授权慢就在倒计时结束后等待；被拒绝则立刻给可恢复提示
    streamPromiseRef.current = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });

    setPhase('countdown');
    setCountdown(COUNTDOWN_SECONDS);
    setBusy(true);

    let n = COUNTDOWN_SECONDS;
    countdownTimerRef.current = window.setInterval(() => {
      n -= 1;
      if (n <= 0) {
        if (countdownTimerRef.current !== null) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
        setCountdown(0);
        if (session === sessionRef.current) void launchCapture(session);
      } else {
        setCountdown(n);
      }
    }, 1000);
  }, [audioElRef, audioUrl, launchCapture, setBusy, support.ok]);

  const cancelCountdown = useCallback(() => {
    sessionRef.current += 1;
    activeRef.current = false;
    clearTimers();
    streamPromiseRef.current = null;
    // 授权可能在取消后才返回：then 里比对会话号后自行停轨（见 launchCapture）
    streamRef.current?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    streamRef.current = null;
    setPhase('idle');
    setCountdown(0);
    setBusy(false);
  }, [clearTimers, setBusy]);

  const stopRecording = useCallback(() => {
    const z = pendingZoneRef.current;
    if (!z) return;
    finalizeRef.current(sessionRef.current, z);
  }, []);

  const discardRecording = useCallback(() => {
    teardown();
    setError(null);
  }, [teardown]);

  /* ---------------- 对比回放：同步启动 / 双向联动 / 原音时钟纠偏 ---------------- */

  const stopCompareRaf = useCallback(() => {
    if (compareRafRef.current !== null) {
      cancelAnimationFrame(compareRafRef.current);
      compareRafRef.current = null;
    }
  }, []);

  const endCompare = useCallback(
    (atEnd: boolean) => {
      if (compareSessionRef.current === null) return;
      compareSessionRef.current = null;
      stopCompareRaf();
      const z = zoneRef.current;
      const orig = audioElRef.current;
      const rec = recElRef.current;
      linkingRef.current = true;
      try {
        orig?.pause();
        rec?.pause();
      } catch {
        /* ignore */
      }
      if (atEnd && z) {
        if (orig) orig.currentTime = z.b;
        if (rec) rec.currentTime = Math.min(rec.duration || z.dur, z.dur);
        setOrigPos(z.dur);
        setRecPos(Math.min(rec?.duration || z.dur, z.dur));
      }
      linkingRef.current = false;
      setComparePlaying(false);
    },
    [audioElRef, stopCompareRaf]
  );
  const endCompareRef = useRef(endCompare);
  endCompareRef.current = endCompare;

  const runCompareRaf = useCallback(
    (token: number) => {
      const tick = () => {
        if (compareSessionRef.current !== token) return;
        const z = zoneRef.current;
        const orig = audioElRef.current;
        const rec = recElRef.current;
        if (!z || !orig || !rec) {
          endCompareRef.current(false);
          return;
        }
        const rel = orig.currentTime - z.a;
        if (!orig.paused && rel >= z.dur) {
          endCompareRef.current(true); // 原音到字幕终点：两轨一起停
          return;
        }
        if (orig.ended || rec.ended) {
          endCompareRef.current(orig.ended);
          return;
        }
        // 以原音为时钟：累计偏差超过 80ms 就把录音 seek 回原音相对位置
        if (!orig.paused && !rec.paused) {
          const target = syncTarget(rel, rec.currentTime, SYNC_TOLERANCE);
          if (target !== null) {
            syncingRef.current = true;
            try {
              rec.currentTime = Math.min(Math.max(target, 0), rec.duration || target);
            } catch {
              /* seek 时机异常时下一帧再纠 */
            }
            syncingRef.current = false;
          }
        }
        setOrigPos(Math.min(Math.max(rel, 0), z.dur));
        setRecPos(rec.currentTime);
        compareRafRef.current = requestAnimationFrame(tick);
      };
      compareRafRef.current = requestAnimationFrame(tick);
    },
    [audioElRef]
  );

  /** 任一路暂停时联动另一路并停止帧循环（会话仍保持：暂停中定位仍需联动） */
  const onLinkedPause = useCallback(
    (source: 'orig' | 'rec') => {
      if (compareSessionRef.current === null || linkingRef.current) return;
      linkingRef.current = true;
      try {
        if (source === 'orig') recElRef.current?.pause();
        else audioElRef.current?.pause();
      } catch {
        /* ignore */
      }
      linkingRef.current = false;
      stopCompareRaf();
      setComparePlaying(false);
    },
    [audioElRef, stopCompareRaf]
  );
  const onLinkedPauseRef = useRef(onLinkedPause);
  onLinkedPauseRef.current = onLinkedPause;

  /** 任一路恢复时联动另一路并重启帧循环（会话存在时） */
  const onLinkedPlay = useCallback(
    (source: 'orig' | 'rec') => {
      if (compareSessionRef.current === null || linkingRef.current) return;
      linkingRef.current = true;
      try {
        if (source === 'orig') {
          recElRef.current?.play().catch(() => undefined);
        } else {
          audioElRef.current?.play().catch(() => undefined);
        }
      } catch {
        /* ignore */
      }
      linkingRef.current = false;
      setComparePlaying(true);
      stopCompareRaf();
      runCompareRaf(compareSessionRef.current);
    },
    [audioElRef, runCompareRaf, stopCompareRaf]
  );
  const onLinkedPlayRef = useRef(onLinkedPlay);
  onLinkedPlayRef.current = onLinkedPlay;

  const startCompare = useCallback(
    (restart: boolean) => {
      const z = zoneRef.current;
      const orig = audioElRef.current;
      const rec = recElRef.current;
      if (!z || !orig || !rec) return;
      if (restart || orig.currentTime - z.a >= z.dur - 0.03 || rec.ended) {
        syncingRef.current = true;
        try {
          orig.currentTime = z.a;
          rec.currentTime = 0;
        } finally {
          syncingRef.current = false;
        }
        setOrigPos(0);
        setRecPos(0);
      }
      const token = Date.now() + Math.random();
      compareSessionRef.current = token;
      linkingRef.current = false;
      setComparePlaying(true);
      // 同步启动：两条 play() 在同一 tick 内发出
      void orig.play().catch(() => {
        onNotify('warn', '原音自动播放被浏览器阻止，请再点一次对比播放');
      });
      void rec.play().catch(() => {
        onNotify('warn', '录音回放启动失败，请重新录制');
      });
      runCompareRaf(token);
    },
    [audioElRef, onNotify, runCompareRaf]
  );

  const toggleCompare = useCallback(() => {
    const orig = audioElRef.current;
    const rec = recElRef.current;
    if (!orig || !rec) return;
    if (comparePlaying) {
      // 暂停原音即可：onLinkedPause 会联动暂停录音、停帧循环并更新按钮
      orig.pause();
    } else {
      startCompare(false);
    }
  }, [audioElRef, comparePlaying, startCompare]);

  /* ---------------- 原音 / 录音联动事件 ---------------- */

  // 录音元素在第一次录制完成时创建，监听只挂一次（处理器全部经 ref 读最新状态）
  function attachRecListeners(el: HTMLAudioElement) {
    el.addEventListener('play', () => onLinkedPlayRef.current('rec'));
    el.addEventListener('pause', () => onLinkedPauseRef.current('rec'));
    el.addEventListener('ended', () => {
      if (compareSessionRef.current !== null) endCompareRef.current(true);
    });
    el.addEventListener('seeking', () => {
      const z = zoneRef.current;
      const orig = audioElRef.current;
      if (!z || !orig || compareSessionRef.current === null || syncingRef.current) return;
      // 录音重新定位 -> 原音跳到对应绝对时间
      syncingRef.current = true;
      try {
        const rel = Math.min(Math.max(el.currentTime, 0), z.dur);
        orig.currentTime = z.a + rel;
        setOrigPos(rel);
      } finally {
        syncingRef.current = false;
      }
    });
  }

  // 原音元素由 App 拥有，音频换源时重挂监听（处理器经 ref 读最新状态）
  useEffect(() => {
    const orig = audioElRef.current;
    if (!orig || !audioUrl) return;

    const onPlay = () => onLinkedPlayRef.current('orig');
    const onPause = () => onLinkedPauseRef.current('orig');
    const onEnded = () => {
      if (compareSessionRef.current !== null) endCompareRef.current(true);
    };
    const onSeeking = () => {
      const z = zoneRef.current;
      const rec = recElRef.current;
      if (!z || !rec || compareSessionRef.current === null || syncingRef.current) return;
      // 原音重新定位 -> 录音跳到对应相对位置
      syncingRef.current = true;
      try {
        const rel = Math.min(Math.max(orig.currentTime - z.a, 0), z.dur);
        rec.currentTime = Math.min(rel, rec.duration || rel);
        setOrigPos(rel);
      } finally {
        syncingRef.current = false;
      }
    };

    orig.addEventListener('play', onPlay);
    orig.addEventListener('pause', onPause);
    orig.addEventListener('ended', onEnded);
    orig.addEventListener('seeking', onSeeking);
    return () => {
      orig.removeEventListener('play', onPlay);
      orig.removeEventListener('pause', onPause);
      orig.removeEventListener('ended', onEnded);
      orig.removeEventListener('seeking', onSeeking);
    };
  }, [audioElRef, audioUrl]);

  /* ---------------- 音量 / 静音（两路独立） ---------------- */

  const changeOrigVolume = (v: number) => {
    setOrigVolume(v);
    const el = audioElRef.current;
    if (el) el.volume = v;
  };
  const changeRecVolume = (v: number) => {
    setRecVolume(v);
    recVolRef.current = v;
    if (recElRef.current) recElRef.current.volume = v;
  };
  const toggleOrigMute = () => {
    const next = !origMuted;
    setOrigMuted(next);
    if (audioElRef.current) audioElRef.current.muted = next;
  };
  const toggleRecMute = () => {
    const next = !recMuted;
    setRecMuted(next);
    if (recElRef.current) recElRef.current.muted = next;
  };
  // 录音元素可能在音量设定之后才创建：src 载入时同步当前值
  useEffect(() => {
    if (recElRef.current) recElRef.current.volume = recVolume;
  }, [recVolume, phase]);
  useEffect(() => {
    if (recElRef.current) recElRef.current.muted = recMuted;
  }, [recMuted, phase]);

  /* ---------------- 定位条（任一路重新定位都会联动另一轨） ---------------- */

  const seekOrig = (rel: number) => {
    const z = zoneRef.current;
    const orig = audioElRef.current;
    if (!z || !orig) return;
    orig.currentTime = z.a + Math.min(Math.max(rel, 0), z.dur);
    setOrigPos(Math.min(Math.max(rel, 0), z.dur));
  };
  const seekRec = (rel: number) => {
    const rec = recElRef.current;
    if (!rec) return;
    rec.currentTime = Math.min(Math.max(rel, 0), rec.duration || rel);
    setRecPos(rec.currentTime);
  };

  /* ---------------- 渲染 ---------------- */

  const startDisabledReason = !support.ok
    ? support.reason
      ? supportReasonText(support.reason)
      : null
    : !audioUrl
      ? '请先导入音频'
      : !cue
        ? '请先在时间轴或列表中选择一条字幕'
        : !zone
          ? '该字幕区间超出音频时长，无法跟读'
          : null;

  const busy = phase === 'countdown' || phase === 'recording';

  return (
    <section className="shadow-panel" aria-label="单句跟读对比">
      <div className="shadow-head">
        <span className="shadow-title">🎙 单句跟读对比</span>
        {cue ? (
          <span className="shadow-cue" title={cue.text.replace(/\n/g, ' ')}>
            {formatClock(cue.start)} → {formatClock(cue.end)}（{zone ? `${zone.dur.toFixed(2)}s` : '区间无效'}）·{' '}
            {cue.text.split('\n')[0]}
          </span>
        ) : (
          <span className="shadow-cue dim">选中一条字幕后即可录制跟读</span>
        )}
        <span className={`shadow-state ${phase === 'recording' ? 'live' : ''}`}>
          {phase === 'countdown' && `倒计时 ${countdown} 秒，请准备…`}
          {phase === 'recording' && '● 录音中（到字幕终点自动停止）'}
          {phase === 'recorded' && '已录制，仅保存在本浏览器会话'}
          {phase === 'idle' && ''}
        </span>
      </div>

      <div className="shadow-body">
        <div className="shadow-controls">
          {phase === 'countdown' && (
            <>
              <span className="countdown-big">{countdown}</span>
              <button className="btn" onClick={cancelCountdown}>
                取消
              </button>
            </>
          )}
          {phase === 'recording' && (
            <button className="btn danger" onClick={stopRecording}>
              ■ 停止录音
            </button>
          )}
          {(phase === 'idle' || phase === 'recorded') && (
            <button
              className="btn primary"
              onClick={startRecording}
              disabled={startDisabledReason !== null}
              title={startDisabledReason ?? '倒计时 3 秒后先开麦录音，再从字幕起点播放原音'}
            >
              {phase === 'recorded' ? '🔁 重新录制' : '● 开始录制'}
            </button>
          )}
          {phase === 'recorded' && (
            <>
              <button className="btn" onClick={toggleCompare} title="原音与录音同步启动；暂停任一路会联动另一路">
                {comparePlaying ? '⏸ 暂停对比' : '▶ 对比播放'}
              </button>
              <button className="btn" onClick={() => startCompare(true)} title="两路一起回到字幕起点">
                ⏮ 回到起点
              </button>
              <button className="btn" onClick={discardRecording} title="删除本次录音并释放资源">
                🗑 清除
              </button>
            </>
          )}
          {startDisabledReason && phase === 'idle' && (
            <span className="shadow-warn">{startDisabledReason}</span>
          )}
          {error && (
            <span className="shadow-warn recoverable" title="处理后可直接点击开始/重新录制恢复">
              ⚠ {error.text}
            </span>
          )}
          {busy && <span className="shadow-busy-note">A-B 回卷已暂停，录音结束自动恢复</span>}
        </div>

        {phase === 'recorded' && zone && (
          <div className="shadow-tracks">
            <TrackRow
              name="原音"
              tone="orig"
              pos={origPos}
              max={zone.dur}
              volume={origVolume}
              muted={origMuted}
              onSeek={seekOrig}
              onVolume={changeOrigVolume}
              onToggleMute={toggleOrigMute}
            />
            <TrackRow
              name="我的跟读"
              tone="rec"
              pos={recPos}
              max={zone.dur}
              rawMax={zone.dur}
              volume={recVolume}
              muted={recMuted}
              onSeek={seekRec}
              onVolume={changeRecVolume}
              onToggleMute={toggleRecMute}
            />
            <span className="shadow-sync-hint">
              任一路暂停 / 结束 / 拖动定位均联动另一轨 · 偏差超过 {SYNC_TOLERANCE * 1000}ms 按原音时钟纠偏
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

/* ---------------- 单轨控制条 ---------------- */

interface TrackRowProps {
  name: string;
  tone: 'orig' | 'rec';
  pos: number;
  max: number;
  rawMax?: number;
  volume: number;
  muted: boolean;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
}

function TrackRow({ name, tone, pos, max, rawMax, volume, muted, onSeek, onVolume, onToggleMute }: TrackRowProps) {
  const posMax = rawMax ?? max;
  return (
    <div className={`track-row ${tone}`}>
      <span className="track-name">{name}</span>
      <button
        className={['btn', 'mini', muted && 'active-muted'].filter(Boolean).join(' ')}
        onClick={onToggleMute}
        title={muted ? '取消静音' : '静音该轨（不影响另一轨）'}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <input
        className="track-volume"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={(e) => onVolume(Number(e.target.value))}
        title="音量"
      />
      <input
        className="track-scrub"
        type="range"
        min={0}
        max={Math.max(posMax, 0.01)}
        step={0.01}
        value={Math.min(pos, posMax)}
        onChange={(e) => onSeek(Number(e.target.value))}
        title="拖动重新定位，另一轨会同步联动"
      />
      <span className="track-time">
        {formatClock(pos)} / {formatClock(posMax)}
      </span>
    </div>
  );
}
