/** 单条字幕（cue） */
export interface Cue {
  /** 应用内部稳定 id，不参与导出编号 */
  id: string;
  /** 起始时间（秒） */
  start: number;
  /** 结束时间（秒） */
  end: number;
  /** 字幕文本（可含多行） */
  text: string;
}

/** 拖动中的边界信息 */
export type DragEdge = 'start' | 'end';

/** 越界原因，用于回弹提示 */
export interface RejectReason {
  /** 违反的规则文案 */
  message: string;
  /** 0 = 左边界, 1 = 右边界 */
  edge: DragEdge;
  /** 被拒绝时鼠标指向的时间（秒），用于渲染红色虚影 */
  time: number;
}

/** 校对台可配置约束（秒） */
export interface Constraints {
  /** 最短时长 */
  minDuration: number;
  /** 相邻字幕最小间隔 */
  minGap: number;
}

/** 静音段（秒，半开区间 [start, end)） */
export interface SilenceSegment {
  start: number;
  end: number;
}

/** 静音分析状态 */
export type SilenceStatus = 'idle' | 'analyzing' | 'done' | 'error';

/** 导入结果 */
export interface ParseResult {
  cues: Cue[];
  warnings: string[];
}
