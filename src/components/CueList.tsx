import { useEffect, useRef } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';

interface CueListProps {
  cues: Cue[];
  currentTime: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSeek: (t: number) => void;
}

export default function CueList({ cues, currentTime, selectedId, onSelect, onSeek }: CueListProps) {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  return (
    <aside className="cue-list">
      <div className="cue-list-head">
        字幕列表（{sorted.length}）
        <span className="hint">点击时间码定位播放</span>
      </div>
      <div className="cue-list-body">
        {sorted.length === 0 && <div className="empty">尚未导入 SRT 文件</div>}
        {sorted.map((cue, i) => {
          const active = currentTime >= cue.start && currentTime < cue.end;
          return (
            <div
              key={cue.id}
              ref={cue.id === selectedId ? selectedRef : null}
              className={[
                'cue-row',
                cue.id === selectedId && 'selected',
                active && 'playing'
              ].filter(Boolean).join(' ')}
              onClick={() => onSelect(cue.id)}
            >
              <div className="cue-row-index">{i + 1}</div>
              <button
                className="cue-row-time"
                title="定位到该字幕"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(cue.id);
                  onSeek(cue.start);
                }}
              >
                {secondsToSrtTime(cue.start)}
                <br />
                {secondsToSrtTime(cue.end)}
              </button>
              <div className="cue-row-text">{cue.text}</div>
              <div className="cue-row-dur">{(cue.end - cue.start).toFixed(2)}s</div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
