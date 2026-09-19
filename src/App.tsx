import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar';
import Timeline from './components/Timeline';
import CueList from './components/CueList';
import type { Constraints, Cue, SilenceStatus } from './types';
import { formatClock, parseSrt, serializeSrt } from './lib/srt';
import {
  computeLoopRange,
  DEFAULT_LOOP_MARGINS,
  loopDisableReason,
  loopDisableText,
  loopEntryTarget,
  loopWrapTarget,
  type LoopMargins,
  type LoopRange
} from './lib/abLoop';
import {
  commitHistory,
  initHistory,
  redoHistory,
  replaceHistory,
  undoHistory
} from './lib/cues';
import { detectSilences, type WindowLevels } from './lib/silence';
import {
  AbortToken,
  analyzeAudioFile,
  isAbortError
} from './lib/audioAnalysis';

interface Toast {
  id: number;
  kind: 'warn' | 'info' | 'error';
  text: string;
}

/** dBFS 风格阈值转线性振幅：-60dB≈0.001, -40dB=0.01, -20dB=0.1 */
function dbToAmplitude(db: number): number {
  return Math.min(1, Math.pow(10, db / 20));
}

export default function App() {
  const [history, setHistory] = useState(() => initHistory([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<Constraints>({
    minDuration: 0.5,
    minGap: 0.08
  });
  const [pps, setPps] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [srtName, setSrtName] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 静音分析：吸附开关、可调阈值（dB）、分析状态与窗口能量
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-40);
  const [levels, setLevels] = useState<WindowLevels | null>(null);
  const [silenceStatus, setSilenceStatus] = useState<SilenceStatus>('idle');
  const [silenceError, setSilenceError] = useState<string | null>(null);

  // A-B 循环试听：开关与前后余量（区间由选中字幕推导，见下方 loopRange）
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopMargins, setLoopMargins] = useState<LoopMargins>(DEFAULT_LOOP_MARGINS);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const toastId = useRef(0);
  // 当前音频分析的取消令牌；更换音频时取消旧分析并阻止旧结果回写
  const analysisTokenRef = useRef<AbortToken | null>(null);
  // 最新循环计划的镜像，供音频事件 / rAF 回调读取，避免闭包过期；
  // 暂停、导入新音频或关闭循环时同步置为失效，旧回调读到 inactive 即落空
  const loopPlanRef = useRef<{ active: boolean; range: LoopRange | null }>({
    active: false,
    range: null
  });

  const cues = history.present;

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  /* ---------------- 音频 ---------------- */

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => setCurrentTime(el.currentTime));
      el.addEventListener('loadedmetadata', () => setDuration(el.duration || 0));
      el.addEventListener('play', () => setIsPlaying(true));
      el.addEventListener('pause', () => setIsPlaying(false));
      el.addEventListener('ended', () => {
        // B 点被裁剪到音频结尾时，'ended' 先于「越过 B」发生：循环仍激活则回到 A 继续；
        // 读取的是最新循环计划，导入新音频 / 关闭循环后计划已失效，不会拉回播放头
        const plan = loopPlanRef.current;
        if (plan.active && plan.range) {
          el.currentTime = plan.range.a;
          setCurrentTime(plan.range.a);
          void el.play().catch(() => setIsPlaying(false));
          return;
        }
        setIsPlaying(false);
      });
      audioRef.current = el;
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    return () => {
      analysisTokenRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioRef.current?.pause();
    };
  }, []);

  /** 用 Web Audio API 解码并分析窗口能量；token 保证旧音频结果不会回写 */
  const runSilenceAnalysis = useCallback(
    (file: File) => {
      analysisTokenRef.current?.abort();
      const token = new AbortToken();
      analysisTokenRef.current = token;
      setSilenceStatus('analyzing');
      setSilenceError(null);
      analyzeAudioFile(file, token)
        .then((result) => {
          if (token.signal) return; // 已更换音频，丢弃旧结果
          setLevels({ levels: result.levels, windowSize: result.windowSize, duration: result.duration });
          setSilenceStatus('done');
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return; // 更换音频导致的取消，静默处理
          setSilenceStatus('error');
          setSilenceError(err instanceof Error ? err.message : String(err));
          pushToast('error', `静音分析失败：${err instanceof Error ? err.message : '音频无法解码'}`);
        });
    },
    [pushToast]
  );

  const handleImportAudio = useCallback(
    (file: File) => {
      // 先作废旧循环计划：换源期间已排队的播放回调不得再拉回播放头
      loopPlanRef.current = { active: false, range: null };
      const el = ensureAudio();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      el.src = url;
      el.load();
      setAudioName(file.name);
      setCurrentTime(0);
      setLevels(null);
      // 取消旧分析（若正在进行），并以新令牌开始本次分析，阻止旧结果回写
      runSilenceAnalysis(file);
      pushToast('info', `已加载音频：${file.name}`);
    },
    [ensureAudio, pushToast, runSilenceAnalysis]
  );

  // 阈值调整时基于窗口能量重新分段（纯前端计算，无需重新解码）
  const silenceThreshold = useMemo(() => dbToAmplitude(silenceThresholdDb), [silenceThresholdDb]);
  const silenceSegments = useMemo(
    () => (levels ? detectSilences(levels, { threshold: silenceThreshold }) : []),
    [levels, silenceThreshold]
  );

  const seek = useCallback(
    (t: number, play = false) => {
      const el = audioRef.current;
      if (!el || !audioUrlRef.current) {
        // 未导入音频时仍允许播放头移动，便于纯字幕检查
        setCurrentTime(Math.max(0, t));
        return;
      }
      const target = Math.max(0, Math.min(t, el.duration || t));
      el.currentTime = target;
      setCurrentTime(target);
      if (play) {
        void el.play().catch(() => pushToast('error', '浏览器拒绝了自动播放，请再点一次播放'));
      }
    },
    [pushToast]
  );

  const seekAndPlay = useCallback((t: number) => seek(t, true), [seek]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el || !audioUrlRef.current) {
      pushToast('warn', '请先导入浏览器可播放的音频文件');
      return;
    }
    if (el.paused) void el.play();
    else el.pause();
  }, [pushToast]);

  /* ---------------- A-B 循环试听 ---------------- */

  const selectedCue = useMemo(() => cues.find((c) => c.id === selectedId) ?? null, [cues, selectedId]);
  const hasAudio = audioName !== null;
  // 区间 = 选中字幕 ± 前后余量，裁剪到音频时长；选择或余量变化时自动更新
  const loopRange = useMemo(
    () => computeLoopRange(selectedCue, loopMargins, duration),
    [selectedCue, loopMargins, duration]
  );
  const loopDisabled = loopDisableReason(hasAudio, selectedCue, loopRange);
  const loopActive = loopEnabled && loopDisabled === null && loopRange !== null;

  // 渲染期同步最新循环计划，供音频事件 / rAF 回调读取（写入幂等，StrictMode 安全）
  loopPlanRef.current = { active: loopActive, range: loopActive ? loopRange : null };

  // 帧级回卷监听：播放中越过 B 点即回到 A 点继续。
  // 依赖变化（暂停 / 关闭 / 区间失效）或卸载时取消 rAF，且 tick 内再校验最新计划，
  // 保证旧回调不会再次拉回播放头。
  const loopMonitoring = loopActive && isPlaying;
  useEffect(() => {
    if (!loopMonitoring) return;
    const el = audioRef.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      const plan = loopPlanRef.current;
      if (plan.active && plan.range && !el.paused) {
        const target = loopWrapTarget(el.currentTime, plan.range);
        if (target !== null) {
          el.currentTime = target;
          setCurrentTime(target);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopMonitoring]);

  // 开启循环或切换选择后：播放头落在新区间外则立即跳到新 A 点（保持当前播放/暂停状态）
  const loopEntryKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loopActive || !loopRange) {
      loopEntryKeyRef.current = null;
      return;
    }
    const key = selectedId ?? '';
    if (loopEntryKeyRef.current === key) return; // 同一路径不重复校正（余量微调不抢播放头）
    loopEntryKeyRef.current = key;
    const el = audioRef.current;
    const now = el && audioUrlRef.current ? el.currentTime : currentTime;
    const target = loopEntryTarget(now, loopRange);
    if (target !== null) seek(target);
  }, [loopActive, loopRange, selectedId, seek, currentTime]);

  const handleLoopEnabledChange = useCallback((on: boolean) => {
    if (!on) {
      // 关闭循环：同步作废旧计划，已排队的播放回调不再拉回播放头
      loopPlanRef.current = { active: false, range: null };
    }
    setLoopEnabled(on);
  }, []);

  /* ---------------- SRT ---------------- */

  const handleImportSrt = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseSrt(String(reader.result ?? ''));
        if (result.cues.length === 0) {
          pushToast('error', '未从该文件解析出任何有效字幕');
          return;
        }
        setHistory((h) => replaceHistory(h, result.cues));
        setSrtName(file.name);
        setSelectedId(result.cues[0]?.id ?? null);
        pushToast('info', `已导入 ${result.cues.length} 条字幕：${file.name}`);
        result.warnings.forEach((w) => pushToast('warn', w));
      };
      reader.onerror = () => pushToast('error', `读取文件失败：${file.name}`);
      reader.readAsText(file, 'utf-8');
    },
    [pushToast]
  );

  /* ---------------- 历史 ---------------- */

  const commit = useCallback((next: Cue[]) => {
    setHistory((h) => commitHistory(h, next));
  }, []);

  const undo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, togglePlay]);

  /* ---------------- 导出 ---------------- */

  const exportSrt = useCallback(() => {
    if (cues.length === 0) {
      pushToast('warn', '没有可导出的字幕');
      return;
    }
    const blob = new Blob([serializeSrt(cues)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (srtName ?? 'subtitles.srt').replace(/\.srt$/i, '');
    a.href = url;
    a.download = `${base}.fixed.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('info', '已导出按时间顺序重新编号的 SRT');
  }, [cues, srtName, pushToast]);

  const statusText = useMemo(() => {
    const parts: string[] = [];
    parts.push(cues.length === 0 ? '等待导入：先选择 SRT，再选择音频' : `${cues.length} 条字幕`);
    if (silenceStatus === 'analyzing') parts.push('静音分析中…');
    else if (silenceStatus === 'done') {
      parts.push(`${silenceSegments.length} 段静音` + (snapEnabled ? '· 吸附已开启' : '· 吸附已关闭'));
    } else if (silenceStatus === 'error') parts.push('静音分析失败');
    if (loopActive && loopRange) {
      parts.push(`A-B 循环 ${formatClock(loopRange.a)} → ${formatClock(loopRange.b)}`);
    } else if (loopEnabled && loopDisabled) {
      parts.push(`循环待机：${loopDisableText(loopDisabled)}`);
    }
    if (cues.length > 0) parts.push(`已记录 ${history.past.length} 次调整`);
    return parts.join(' · ');
  }, [cues.length, history.past.length, silenceStatus, silenceSegments.length, snapEnabled, loopActive, loopRange, loopEnabled, loopDisabled]);

  return (
    <div className="app">
      <Toolbar
        audioName={audioName}
        srtName={srtName}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        pps={pps}
        constraints={constraints}
        onImportSrt={handleImportSrt}
        onImportAudio={handleImportAudio}
        onTogglePlay={togglePlay}
        onSeek={seekAndPlay}
        onUndo={undo}
        onRedo={redo}
        onZoom={setPps}
        onConstraintsChange={setConstraints}
        onExport={exportSrt}
        canExport={cues.length > 0}
        snapEnabled={snapEnabled}
        onSnapEnabledChange={setSnapEnabled}
        silenceThresholdDb={silenceThresholdDb}
        onSilenceThresholdChange={setSilenceThresholdDb}
        silenceStatus={silenceStatus}
        silenceSegmentCount={silenceSegments.length}
        silenceError={silenceError}
        loopEnabled={loopEnabled}
        loopRange={loopActive ? loopRange : null}
        loopDisabledReason={loopDisabled ? loopDisableText(loopDisabled) : null}
        loopMargins={loopMargins}
        onLoopEnabledChange={handleLoopEnabledChange}
        onLoopMarginsChange={setLoopMargins}
      />

      <main className="main">
        <section className="stage">
          <div className="status-bar">
            <span>{statusText}</span>
            <span className="status-hint">
              拖动字幕块左右边界校对 · 靠近静音带边缘 150ms 自动吸附 · 越界自动回弹并提示原因 · 点击字幕块定位播放
            </span>
          </div>
          <Timeline
            cues={cues}
            duration={duration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            pps={pps}
            constraints={constraints}
            selectedId={selectedId}
            silences={silenceSegments}
            snapEnabled={snapEnabled}
            loopRange={loopActive ? loopRange : null}
            onSelect={setSelectedId}
            onSeek={seekAndPlay}
            onCommit={commit}
            onNotice={(text) => pushToast('warn', text)}
          />
        </section>
        <CueList
          cues={cues}
          currentTime={currentTime}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSeek={seekAndPlay}
        />
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
