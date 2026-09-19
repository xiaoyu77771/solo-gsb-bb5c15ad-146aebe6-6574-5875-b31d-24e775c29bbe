import type { Constraints, SilenceStatus } from '../types';
import { formatClock } from '../lib/srt';
import type { LoopMargins, LoopRange } from '../lib/abLoop';

interface ToolbarProps {
  audioName: string | null;
  srtName: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  canUndo: boolean;
  canRedo: boolean;
  pps: number;
  constraints: Constraints;
  snapEnabled: boolean;
  silenceThresholdDb: number;
  silenceStatus: SilenceStatus;
  silenceSegmentCount: number;
  silenceError: string | null;
  /** A-B 循环：开关状态（用户意图，即使暂不可用也保留） */
  loopEnabled: boolean;
  /** 当前生效的循环区间；未开启或不可用时为 null */
  loopRange: LoopRange | null;
  /** 不可用原因文案；null 表示可开启 */
  loopDisabledReason: string | null;
  loopMargins: LoopMargins;
  onLoopEnabledChange: (on: boolean) => void;
  onLoopMarginsChange: (next: LoopMargins) => void;
  onImportSrt: (file: File) => void;
  onImportAudio: (file: File) => void;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoom: (pps: number) => void;
  onConstraintsChange: (next: Constraints) => void;
  onSnapEnabledChange: (enabled: boolean) => void;
  onSilenceThresholdChange: (db: number) => void;
  onExport: () => void;
  canExport: boolean;
}

export default function Toolbar(p: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="brand">🎬 字幕节奏校对台</div>

      <div className="group file-group">
        <label className="btn">
          导入 SRT
          <input
            type="file"
            accept=".srt,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImportSrt(f);
              e.target.value = '';
            }}
          />
        </label>
        <label className="btn">
          导入音频
          <input
            type="file"
            accept="audio/*,.m4a,.aac,.ogg,.opus,.webm"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImportAudio(f);
              e.target.value = '';
            }}
          />
        </label>
        <span className="file-names" title={[p.srtName, p.audioName].filter(Boolean).join(' / ')}>
          {p.srtName ?? '未选择字幕'} · {p.audioName ?? '未选择音频'}
        </span>
      </div>

      <div className="group transport">
        <button className="btn icon" onClick={p.onTogglePlay} disabled={!p.audioName} title="播放/暂停（空格）">
          {p.isPlaying ? '⏸' : '▶'}
        </button>
        <span className="clock">
          {formatClock(p.currentTime)} / {formatClock(p.duration)}
        </span>
      </div>

      <div className="group loop-group">
        <label
          className="switch"
          title={
            p.loopDisabledReason ??
            '以选中字幕起止 ± 前后余量形成循环区间，播放越过 B 点自动回到 A 点'
          }
        >
          <input
            type="checkbox"
            checked={p.loopEnabled}
            disabled={!p.loopEnabled && p.loopDisabledReason !== null}
            onChange={(e) => p.onLoopEnabledChange(e.target.checked)}
          />
          A-B 循环
        </label>
        <label className="margin" title="循环起点 A = 字幕起点 − 前余量（不越过 0s）">
          前余量
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={p.loopMargins.pre}
            onChange={(e) =>
              p.onLoopMarginsChange({ ...p.loopMargins, pre: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          s
        </label>
        <label className="margin" title="循环终点 B = 字幕终点 + 后余量（不越过音频结尾）">
          后余量
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={p.loopMargins.post}
            onChange={(e) =>
              p.onLoopMarginsChange({ ...p.loopMargins, post: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          s
        </label>
        {p.loopDisabledReason ? (
          <span className="loop-state failed">{p.loopDisabledReason}</span>
        ) : p.loopRange ? (
          <span className="loop-state live">
            A {formatClock(p.loopRange.a)} → B {formatClock(p.loopRange.b)}
          </span>
        ) : null}
      </div>

      <div className="group zoom-group">
        <span>缩放</span>
        <input
          type="range"
          min={10}
          max={400}
          step={5}
          value={p.pps}
          onChange={(e) => p.onZoom(Number(e.target.value))}
        />
      </div>

      <div className="group constraint-group">
        <label>
          最短时长
          <input
            type="number"
            min={0}
            step={0.1}
            value={p.constraints.minDuration}
            onChange={(e) =>
              p.onConstraintsChange({ ...p.constraints, minDuration: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          s
        </label>
        <label>
          最小间隔
          <input
            type="number"
            min={0}
            step={0.1}
            value={p.constraints.minGap}
            onChange={(e) =>
              p.onConstraintsChange({ ...p.constraints, minGap: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          s
        </label>
      </div>

      <div className="group silence-group">
        <label className="switch" title="开启后，拖动字幕边界靠近静音段边缘 150ms 时自动吸附">
          <input
            type="checkbox"
            checked={p.snapEnabled}
            disabled={p.silenceStatus !== 'done'}
            onChange={(e) => p.onSnapEnabledChange(e.target.checked)}
          />
          静音吸附
        </label>
        <label
          className="threshold"
          title={
            p.silenceStatus === 'error'
              ? `静音分析失败：${p.silenceError ?? '音频无法解码'}`
              : '低于该 RMS 电平视为静音；仅对当前音频重新分段，无需重新解码'
          }
        >
          阈值
          <input
            type="range"
            min={-60}
            max={-20}
            step={1}
            value={p.silenceThresholdDb}
            disabled={p.silenceStatus !== 'done'}
            onChange={(e) => p.onSilenceThresholdChange(Number(e.target.value))}
          />
          <span className="db-value">{p.silenceThresholdDb} dB</span>
        </label>
        <span
          className={[
            'silence-state',
            p.silenceStatus === 'analyzing' && 'working',
            p.silenceStatus === 'error' && 'failed'
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {p.silenceStatus === 'analyzing'
            ? '静音分析中…'
            : p.silenceStatus === 'error'
              ? '分析失败'
              : p.silenceStatus === 'done'
                ? `${p.silenceSegmentCount} 段静音`
                : '未分析'}
        </span>
      </div>

      <div className="group history-group">
        <button className="btn" onClick={p.onUndo} disabled={!p.canUndo} title="撤销（Ctrl/⌘+Z）">
          ↶ 撤销
        </button>
        <button className="btn" onClick={p.onRedo} disabled={!p.canRedo} title="重做（Ctrl/⌘+Shift+Z）">
          ↷ 重做
        </button>
      </div>

      <button className="btn primary" onClick={p.onExport} disabled={!p.canExport}>
        导出 SRT
      </button>
    </header>
  );
}
