import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Constraints, Cue, DragEdge, RejectReason, SilenceSegment } from '../types';
import { applyEdge } from '../lib/cues';
import { formatClock } from '../lib/srt';
import { resolveEdgeCandidate, type SnapEdge } from '../lib/silence';
import type { LoopRange } from '../lib/abLoop';

interface TimelineProps {
  cues: Cue[];
  /** 音频时长（秒），未知时为 0 */
  duration: number;
  currentTime: number;
  isPlaying: boolean;
  pps: number; // 每秒对应像素
  constraints: Constraints;
  selectedId: string | null;
  /** 检测到的静音段（秒），用于叠加静音带与吸附 */
  silences: SilenceSegment[];
  /** 静音吸附开关 */
  snapEnabled: boolean;
  /** 当前生效的 A-B 循环区间；未开启时为 null */
  loopRange: LoopRange | null;
  onSelect: (id: string | null) => void;
  onSeek: (t: number) => void;
  /** 合法拖放结束：提交边界并进入历史栈 */
  onCommit: (next: Cue[]) => void;
  /** 非阻断提示（如吸附点不合法而回退） */
  onNotice: (text: string) => void;
}

const LANE_HEIGHT = 52;
const RULER_HEIGHT = 34;
const PAD_RIGHT = 80;

function tickInterval(pps: number): number {
  const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const c of candidates) {
    if (c * pps >= 80) return c;
  }
  return 600;
}

function tickLabel(t: number, interval: number): string {
  if (interval < 1) return `${t.toFixed(1)}s`;
  const total = Math.round(t);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

interface DragState {
  cueId: string;
  edge: DragEdge;
  /** 鼠标位置对应的原始候选时间（未吸附） */
  candidate: number;
  /** 最终采用的时间（可能被吸附到静音边缘） */
  resolvedTime: number;
  valid: boolean;
  message: string;
  /** 是否吸附到静音边缘 */
  snapped: boolean;
  /** 吸附目标边缘 */
  snapEdge: SnapEdge | null;
  /** 吸附点不合法、已回退原候选时的原因 */
  snapRejected: string | null;
  startX: number;
  moved: boolean;
}

export default function Timeline({
  cues,
  duration,
  currentTime,
  isPlaying,
  pps,
  constraints,
  selectedId,
  silences,
  snapEnabled,
  loopRange,
  onSelect,
  onSeek,
  onCommit,
  onNotice
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneScrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [reject, setReject] = useState<RejectReason | null>(null);
  const rejectTimer = useRef<number | null>(null);

  // 标尺与泳道共享横向滚动位置
  const syncing = useRef(false);
  useEffect(() => {
    const ruler = scrollRef.current;
    const lane = laneScrollRef.current;
    if (!ruler || !lane) return;
    const fromRuler = () => {
      if (syncing.current) return;
      syncing.current = true;
      lane.scrollLeft = ruler.scrollLeft;
      requestAnimationFrame(() => {
        syncing.current = false;
      });
    };
    const fromLane = () => {
      if (syncing.current) return;
      syncing.current = true;
      ruler.scrollLeft = lane.scrollLeft;
      requestAnimationFrame(() => {
        syncing.current = false;
      });
    };
    ruler.addEventListener('scroll', fromRuler);
    lane.addEventListener('scroll', fromLane);
    return () => {
      ruler.removeEventListener('scroll', fromRuler);
      lane.removeEventListener('scroll', fromLane);
    };
  }, []);

  // 播放时播放头保持在可视区约 30% 位置
  const userPinned = useRef(false);
  useEffect(() => {
    const lane = laneScrollRef.current;
    if (!lane) return;
    const onWheel = () => {
      userPinned.current = true;
    };
    const onPointerDown = () => {
      userPinned.current = true;
    };
    lane.addEventListener('wheel', onWheel, { passive: true });
    lane.addEventListener('pointerdown', onPointerDown);
    return () => {
      lane.removeEventListener('wheel', onWheel);
      lane.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      userPinned.current = false;
      return;
    }
    if (userPinned.current) return;
    const lane = laneScrollRef.current;
    if (!lane) return;
    const x = currentTime * pps;
    const viewLeft = lane.scrollLeft;
    const viewRight = viewLeft + lane.clientWidth;
    if (x < viewLeft + 40 || x > viewRight - 80) {
      lane.scrollTo({ left: Math.max(0, x - lane.clientWidth * 0.3) });
    }
  }, [currentTime, isPlaying, pps]);

  // 选中（列表点击等）时滚动到目标块
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedRef.current === selectedId) return;
    selectedRef.current = selectedId;
    const cue = cues.find((c) => c.id === selectedId);
    const lane = laneScrollRef.current;
    if (!cue || !lane) return;
    const x = cue.start * pps;
    if (x < lane.scrollLeft || x > lane.scrollLeft + lane.clientWidth - 60) {
      lane.scrollTo({ left: Math.max(0, x - lane.clientWidth * 0.3), behavior: 'smooth' });
    }
  }, [selectedId, cues, pps]);

  const sorted = useMemo(
    () => [...cues].sort((a, b) => a.start - b.start || a.end - b.end),
    [cues]
  );

  const timelineEnd = useMemo(() => {
    const lastCue = sorted.length > 0 ? sorted[sorted.length - 1].end : 0;
    return Math.max(duration, lastCue, 10) + 5;
  }, [duration, sorted]);

  const trackWidth = timelineEnd * pps + PAD_RIGHT;
  const interval = useMemo(() => tickInterval(pps), [pps]);

  const ticks = useMemo(() => {
    const arr: number[] = [];
    for (let t = 0; t <= timelineEnd + 1e-6; t += interval) {
      arr.push(Number(t.toFixed(4)));
    }
    return arr;
  }, [timelineEnd, interval]);

  const timeFromClientX = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    return Number((x / pps).toFixed(4));
  }, [pps]);

  const flashReject = useCallback((reason: RejectReason) => {
    setReject(reason);
    if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
    rejectTimer.current = window.setTimeout(() => setReject(null), 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (rejectTimer.current) window.clearTimeout(rejectTimer.current);
    };
  }, []);

  // 拖动中的实时解析：先尝试静音吸附，吸附点仍须通过最短时长 / 最小间隔校验
  const resolve = useCallback(
    (cueId: string, edge: DragEdge, t: number): Omit<DragState, 'cueId' | 'edge' | 'startX' | 'moved'> => {
      const r = resolveEdgeCandidate(cues, cueId, edge, t, constraints, silences, snapEnabled);
      return {
        candidate: t,
        resolvedTime: r.time,
        valid: r.valid,
        message: r.message,
        snapped: r.snapped,
        snapEdge: r.edge,
        snapRejected: r.snapRejected
      };
    },
    [cues, constraints, silences, snapEnabled]
  );

  const beginDrag = (e: React.PointerEvent, cue: Cue, edge: DragEdge) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelect(cue.id);
    const t = timeFromClientX(e.clientX);
    const r = resolve(cue.id, edge, t);
    setDrag({ cueId: cue.id, edge, ...r, startX: e.clientX, moved: false });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const t = Math.max(0, timeFromClientX(e.clientX));
    const r = resolve(drag.cueId, drag.edge, t);
    setDrag({
      ...drag,
      ...r,
      moved: drag.moved || Math.abs(e.clientX - drag.startX) > 4
    });
  };

  const finishDrag = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.snapRejected) {
      // 吸附点不合法：已保留未吸附候选，提示具体原因
      onNotice(drag.snapRejected);
    }
    if (drag.valid && drag.moved) {
      const cue = cues.find((c) => c.id === drag.cueId);
      const snapped = Math.round(drag.resolvedTime * 1000) / 1000;
      const original = drag.edge === 'start' ? cue?.start : cue?.end;
      if (cue && snapped !== original) {
        onCommit(applyEdge(cues, drag.cueId, drag.edge, snapped));
      }
    } else if (!drag.valid) {
      // 越界回弹：不修改数据，标出原因与红色虚影（使用未吸附候选位置）
      flashReject({ edge: drag.edge, message: drag.message, time: drag.candidate });
    }
    setDrag(null);
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer 已释放时忽略 */
    }
  };

  // 拖动预览：被拖的 cue 以解析后时间（可能已吸附）渲染；数据本身不变，松手非法即自然回弹
  const visualCue = (cue: Cue): Cue => {
    if (drag && drag.cueId === cue.id) {
      return drag.edge === 'start'
        ? { ...cue, start: drag.resolvedTime }
        : { ...cue, end: drag.resolvedTime };
    }
    return cue;
  };

  const seekFromTrack = (e: React.MouseEvent) => {
    // 仅点击空白轨道/标尺时定位
    if (e.target !== e.currentTarget) return;
    onSeek(timeFromClientX(e.clientX));
  };

  const activeCue = sorted.find((c) => c.id === selectedId) ?? null;
  const dragCue = drag ? cues.find((c) => c.id === drag.cueId) ?? null : null;

  // 约束允许范围（供手柄提示参考）
  const limitsFor = useCallback(
    (cue: Cue, edge: DragEdge): { min: number; max: number } => {
      const idx = sorted.findIndex((c) => c.id === cue.id);
      const prev = sorted[idx - 1];
      const next = sorted[idx + 1];
      if (edge === 'start') {
        return {
          min: prev ? prev.end + constraints.minGap : 0,
          max: cue.end - constraints.minDuration
        };
      }
      return {
        min: cue.start + constraints.minDuration,
        max: next ? next.start - constraints.minGap : Number.POSITIVE_INFINITY
      };
    },
    [sorted, constraints]
  );

  return (
    <div className="timeline-wrap">
      {/* 标尺 */}
      <div className="timeline-scroll" ref={scrollRef}>
        <div
          className="ruler"
          ref={trackRef}
          style={{ width: trackWidth, height: RULER_HEIGHT }}
          onMouseDown={seekFromTrack}
        >
          {ticks.map((t) => (
            <div className="tick" key={t} style={{ left: t * pps }}>
              <span className="tick-label">{tickLabel(t, interval)}</span>
            </div>
          ))}
          {silences.map((seg, i) => (
            <div
              key={`rs-${i}`}
              className="silence-band ruler-band"
              style={{ left: seg.start * pps, width: Math.max(2, (seg.end - seg.start) * pps) }}
              title={`静音 ${formatClock(seg.start)} → ${formatClock(seg.end)}`}
            />
          ))}
          {/* A-B 循环范围与旗标（标尺） */}
          {loopRange && (
            <>
              <div
                className="ab-range ruler-ab"
                style={{ left: loopRange.a * pps, width: Math.max(2, (loopRange.b - loopRange.a) * pps) }}
                title={`循环区间 ${formatClock(loopRange.a)} → ${formatClock(loopRange.b)}`}
              />
              <div className="ab-flag" style={{ left: loopRange.a * pps }}>
                A
              </div>
              <div className="ab-flag" style={{ left: loopRange.b * pps }}>
                B
              </div>
            </>
          )}
          {duration > 0 && (
            <div className="audio-end" style={{ left: duration * pps }} title={`音频结尾 ${formatClock(duration)}`}>
              ♫
            </div>
          )}
        </div>
      </div>

      {/* 字幕泳道 */}
      <div className="timeline-scroll lane-scroll" ref={laneScrollRef}>
        <div
          className="lane"
          style={{ width: trackWidth, height: LANE_HEIGHT + 24 }}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              onSelect(null);
              seekFromTrack(e);
            }
          }}
        >
          {/* 静音带：Web Audio 检测出的连续静音段叠加在时间轴上 */}
          {silences.map((seg, i) => (
            <div
              key={`ls-${i}`}
              className={[
                'silence-band lane-band',
                drag?.snapEdge?.segment === seg && 'snap-target'
              ].join(' ')}
              style={{ left: seg.start * pps, width: Math.max(2, (seg.end - seg.start) * pps), top: 6, height: LANE_HEIGHT + 12 }}
              title={`静音 ${formatClock(seg.start)} → ${formatClock(seg.end)}`}
            >
              <span className="silence-tag">静</span>
            </div>
          ))}

          {/* A-B 循环范围带与 A/B 标线（泳道） */}
          {loopRange && (
            <>
              <div
                className="ab-range lane-ab"
                style={{
                  left: loopRange.a * pps,
                  width: Math.max(2, (loopRange.b - loopRange.a) * pps),
                  top: 6,
                  height: LANE_HEIGHT + 12
                }}
                title={`A-B 循环 ${formatClock(loopRange.a)} → ${formatClock(loopRange.b)}`}
              />
              <div className="ab-marker" style={{ left: loopRange.a * pps }} title={`循环起点 A ${formatClock(loopRange.a)}`}>
                <span className="ab-tag">A {formatClock(loopRange.a)}</span>
              </div>
              <div className="ab-marker" style={{ left: loopRange.b * pps }} title={`循环终点 B ${formatClock(loopRange.b)}`}>
                <span className="ab-tag right">B {formatClock(loopRange.b)}</span>
              </div>
            </>
          )}

          {sorted.map((cue) => {
            const v = visualCue(cue);
            const isDragTarget = drag?.cueId === cue.id;
            const invalid = isDragTarget && !drag?.valid;
            const selected = cue.id === selectedId;
            const active = currentTime >= cue.start && currentTime < cue.end;
            const left = Math.max(0, v.start) * pps;
            const width = Math.max(4, (v.end - v.start) * pps);
            const startLimit = limitsFor(cue, 'start');
            const endLimit = limitsFor(cue, 'end');

            return (
              <div
                key={cue.id}
                className={[
                  'cue',
                  selected && 'selected',
                  active && 'playing',
                  invalid && 'invalid'
                ].filter(Boolean).join(' ')}
                style={{ left, width, top: 12, height: LANE_HEIGHT }}
                title={`${formatClock(cue.start)} → ${formatClock(cue.end)}\n${cue.text.replace(/\n/g, ' ')}`}
                onMouseDown={(e) => {
                  // 手柄由 pointer 事件负责拖动，不参与点击定位
                  if (e.button !== 0 || (e.target as HTMLElement).closest('.handle')) return;
                  onSelect(cue.id);
                  const up = (ev: MouseEvent) => {
                    window.removeEventListener('mouseup', up);
                    if (Math.abs(ev.clientX - e.clientX) <= 4) {
                      onSeek(cue.start);
                    }
                  };
                  window.addEventListener('mouseup', up);
                }}
              >
                <div
                  className="handle handle-left"
                  onPointerDown={(e) => beginDrag(e, cue, 'start')}
                  title={`可拖动范围 ${formatClock(Math.min(startLimit.min, startLimit.max))} ~ ${formatClock(startLimit.max)}`}
                />
                <div className="cue-body">
                  <span className="cue-time">
                    {formatClock(cue.start)} – {formatClock(cue.end)}
                  </span>
                  <span className="cue-text">{cue.text.split('\n')[0]}</span>
                </div>
                <div
                  className="handle handle-right"
                  onPointerDown={(e) => beginDrag(e, cue, 'end')}
                  title={`可拖动范围 ${formatClock(endLimit.min)} ~ ${Number.isFinite(endLimit.max) ? formatClock(endLimit.max) : '∞'}`}
                />
              </div>
            );
          })}

          {/* 红色虚影：非法拖到的位置 */}
          {reject && dragCue && (
            <div
              className="reject-ghost"
              style={{
                left: reject.time * pps - 1,
                top: 12,
                height: LANE_HEIGHT
              }}
            >
              <div className="reject-bubble">
                <strong>回弹：</strong>
                {reject.message}
              </div>
            </div>
          )}

          {/* 拖动中的实时原因气泡 */}
          {drag && !drag.valid && (
            <div
              className="reject-bubble live"
              style={{
                left: Math.min(drag.candidate * pps + 12, trackWidth - 220),
                top: 0
              }}
            >
              {drag.message}
            </div>
          )}

          {/* 吸附到静音边缘的提示与标记 */}
          {drag && drag.snapped && drag.snapEdge && (
            <>
              <div className="snap-marker" style={{ left: drag.snapEdge.time * pps }} title="已吸附到静音边缘" />
              <div
                className="snap-bubble"
                style={{
                  left: Math.min(drag.snapEdge.time * pps + 10, trackWidth - 200),
                  top: 0
                }}
              >
                吸附静音{drag.snapEdge.side === 'start' ? '起点' : '终点'} {formatClock(drag.snapEdge.time)}
              </div>
            </>
          )}

          {/* 吸附点不合法而回退的提示（原候选仍合法时） */}
          {drag && drag.snapRejected && drag.valid && (
            <div
              className="reject-bubble live snap-reject"
              style={{
                left: Math.min(drag.candidate * pps + 12, trackWidth - 260),
                top: 22
              }}
            >
              {drag.snapRejected}
            </div>
          )}

          {/* 约束范围参考线（仅拖动目标显示） */}
          {drag && dragCue && (
            <>
              {(() => {
                const lim = limitsFor(dragCue, drag.edge);
                return (
                  <>
                    {lim.min > 0 && (
                      <div className="limit-line" style={{ left: lim.min * pps }} />
                    )}
                    {Number.isFinite(lim.max) && (
                      <div className="limit-line" style={{ left: (lim.max as number) * pps }} />
                    )}
                  </>
                );
              })()}
            </>
          )}

          {/* 播放头 */}
          <div className="playhead" style={{ left: currentTime * pps }}>
            <div className="playhead-head" />
            <div className="playhead-line" style={{ height: LANE_HEIGHT + 24 }} />
          </div>

          {/* 当前选中字幕时间回显 */}
          {activeCue && (
            <div
              className="cue-readout"
              style={{ left: Math.max(0, Math.min(activeCue.start * pps, trackWidth - 260)) }}
            >
              {secondsToSrtTimeShort(activeCue.start)} → {secondsToSrtTimeShort(activeCue.end)}
              {' '}（{(activeCue.end - activeCue.start).toFixed(3)}s）
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function secondsToSrtTimeShort(t: number): string {
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(mm)}:${p2(ss)}.${String(ms).padStart(3, '0')}`;
}
