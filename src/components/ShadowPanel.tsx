import { useEffect, useState } from 'react';
import type { Cue } from '../types';
import { formatClock } from '../lib/srt';
import { useShadowCompare, type ShadowTrackId } from '../lib/useShadowCompare';

interface ShadowPanelProps {
  cue: Cue | null;
  audioUrl: string | null;
  duration: number;
  onNotice: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}

function formatMs(t: number): string {
  const v = Number.isFinite(t) ? t : 0;
  return `${v >= 0 ? '+' : '−'}${Math.abs(v * 1000).toFixed(0)}ms`;
}

/**
 * 单句跟读对比面板（停靠在舞台底部）：
 * 选中字幕 + 导入音频后，录制 -> 3s 倒计时 -> 先开麦克风再播原音 -> 字幕终点自动停；
 * 回放双轨同步、各自音量/静音，联动暂停/结束/重定位，偏差超 80ms 以原音纠偏。
 * 录音仅以内存 Blob URL 存在于当前浏览器会话。
 */
export default function ShadowPanel({ cue, audioUrl, duration, onNotice, onBusyChange }: ShadowPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const shadow = useShadowCompare({ cue, audioUrl, duration, onNotice, onBusyChange });
  const {
    supported,
    phase,
    countdown,
    recordElapsed,
    error,
    meterLevel,
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
    driftLimit,
    start,
    cancelOrStop,
    discard,
    reRecord,
    toggleTrack,
    seekTrack,
    setTrackVolume,
    toggleTrackMute,
    dismissError
  } = shadow;

  const ready = !!cue && !!audioUrl;
  const busy = phase === 'countdown' || phase === 'recording';
  const seekMax = Math.max(rangeLength, recDuration, 0.1);

  // 忙碌时自动展开，避免用户看不到倒计时
  useEffect(() => {
    if (busy) setCollapsed(false);
  }, [busy]);

  const statusText =
    phase === 'countdown'
      ? `倒计时 ${countdown}s 后开始录音`
      : phase === 'recording'
        ? `录音中 ${recordElapsed.toFixed(1)}s / ${rangeLength.toFixed(1)}s`
        : phase === 'recorded'
          ? '录音完成：双轨对比回放'
          : '待机';

  return (
    <div className={`shadow-dock ${phase !== 'idle' ? phase : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="shadow-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="shadow-title">🎤 单句跟读对比</span>
        <span className={`shadow-status phase-${phase}`}>{statusText}</span>
        {phase === 'recorded' && (
          <span
            className={`drift-badge ${Math.abs(drift) > driftLimit ? 'off' : 'ok'}`}
            title="原音与录音的累计时钟偏差；超过 80ms 已自动以原音纠偏"
          >
            偏差 {formatMs(drift)}
          </span>
        )}
        <span className="shadow-collapse" title={collapsed ? '展开' : '收起'}>
          {collapsed ? '▲' : '▼'}
        </span>
      </div>

      {!collapsed && (
        <div className="shadow-body">
          {error && (
            <div className={`shadow-error ${error.kind}`} role="alert">
              <span>{error.text}</span>
              <div className="shadow-error-actions">
                {error.recoverable && phase === 'idle' && (
                  <button className="btn mini" onClick={start}>
                    重试
                  </button>
                )}
                <button className="btn mini" onClick={dismissError}>
                  知道了
                </button>
              </div>
            </div>
          )}

          {phase === 'idle' && (
            <div className="shadow-idle">
              <div className="shadow-cue-info">
                {cue ? (
                  <>
                    <span className="shadow-cue-time">
                      {formatClock(cue.start)} → {formatClock(cue.end)}（{(cue.end - cue.start).toFixed(2)}s）
                    </span>
                    <span className="shadow-cue-text" title={cue.text}>
                      {cue.text.split('\n')[0] || '（无文本）'}
                    </span>
                  </>
                ) : (
                  <span className="shadow-hint">先在时间轴或左侧列表选中一条字幕</span>
                )}
                {!audioUrl && <span className="shadow-hint">请先导入音频</span>}
              </div>
              <div className="shadow-actions">
                <button className="btn primary" onClick={start} disabled={!ready || !supported}>
                  ● 开始跟读
                </button>
                <span className="shadow-tip">
                  点击后先申请麦克风并倒计时 3 秒，随后从字幕起点播放原音并同步录音，到字幕终点自动停止
                </span>
              </div>
            </div>
          )}

          {busy && (
            <div className="shadow-busy">
              {phase === 'countdown' ? (
                <div className="countdown-big">{countdown}</div>
              ) : (
                <div className="meter" aria-hidden="true">
                  <div className="meter-fill" style={{ width: `${Math.min(100, meterLevel * 160)}%` }} />
                </div>
              )}
              <div className="shadow-actions">
                <button className="btn danger" onClick={cancelOrStop}>
                  {phase === 'countdown' ? '取消' : '■ 提前停止'}
                </button>
                <span className="shadow-tip">
                  {phase === 'countdown' ? '麦克风已开启，保持安静准备跟读' : '请跟随原音朗读，越过字幕终点将自动停止'}
                </span>
              </div>
            </div>
          )}

          {phase === 'recorded' && (
            <div className="shadow-compare">
              <TrackRow
                name="原音"
                tone="orig"
                position={origPos}
                max={seekMax}
                playing={playing}
                volume={origVolume}
                muted={origMuted}
                onToggle={() => toggleTrack('orig')}
                onSeek={(t) => seekTrack('orig', t)}
                onVolume={(v) => setTrackVolume('orig', v)}
                onMute={() => toggleTrackMute('orig')}
              />
              <TrackRow
                name="录音"
                tone="rec"
                position={recPos}
                max={seekMax}
                playing={playing}
                volume={recVolume}
                muted={recMuted}
                onToggle={() => toggleTrack('rec')}
                onSeek={(t) => seekTrack('rec', t)}
                onVolume={(v) => setTrackVolume('rec', v)}
                onMute={() => toggleTrackMute('rec')}
              />
              <div className="shadow-actions">
                <button className="btn" onClick={reRecord}>
                  ↻ 重新录制
                </button>
                <button className="btn" onClick={discard}>
                  丢弃
                </button>
                <span className="shadow-tip">
                  两轨同步回放；任一路暂停 / 结束 / 拖动都会联动另一轨，累计偏差超过 {driftLimit * 1000}ms
                  时以原音时钟自动纠偏。录音仅保存在当前浏览器会话，刷新即消失。
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface TrackRowProps {
  name: string;
  tone: ShadowTrackId;
  position: number;
  max: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  onToggle: () => void;
  onSeek: (t: number) => void;
  onVolume: (v: number) => void;
  onMute: () => void;
}

function TrackRow({
  name,
  tone,
  position,
  max,
  playing,
  volume,
  muted,
  onToggle,
  onSeek,
  onVolume,
  onMute
}: TrackRowProps) {
  return (
    <div className={`track-row track-${tone}`}>
      <button className="btn icon track-play" onClick={onToggle} title={playing ? '两轨一起暂停' : '两轨一起播放'}>
        {playing ? '⏸' : '▶'}
      </button>
      <span className="track-name">{name}</span>
      <input
        className="track-seek"
        type="range"
        min={0}
        max={max}
        step={0.01}
        value={Math.min(position, max)}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label={`${name}进度`}
      />
      <span className="track-clock">
        {formatClock(position)} / {formatClock(max)}
      </span>
      <button
        className={`btn mini ${muted ? 'muted-on' : ''}`}
        onClick={onMute}
        title={muted ? '取消静音' : '静音该轨'}
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
        aria-label={`${name}音量`}
        title={`${name}音量 ${Math.round(volume * 100)}%`}
      />
    </div>
  );
}
