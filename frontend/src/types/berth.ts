/** 泊位状态 */
export type BerthStatus = '空闲' | '占用' | '维修';

export const BERTH_STATUSES: BerthStatus[] = ['空闲', '占用', '维修'];

/** 泊位占用记录 */
export interface Berth {
  id: string;
  /** 所属渔港 id */
  portId: string;
  /** 泊位号 */
  berthNo: string;
  /** 占用渔船 id */
  vesselId: string | null;
  /** 占用渔船名 */
  vesselName: string | null;
  /** 靠泊时间（ISO 字符串） */
  berthAt: string | null;
  /** 离泊时间（ISO 字符串） */
  leaveAt: string | null;
  /** 状态：空闲 / 占用 / 维修 */
  status: BerthStatus;
  /** 泊位设计水深 m */
  designDepth: number;
  /** 乐观锁版本号：每次占用 / 释放 / 维修状态变更时 +1，提交时核对 */
  version: number;
}

/**
 * 泊位状态冲突错误。
 * 提交前在事务内重新核对泊位，若实际状态 / 版本与表单选中时不一致（被其他标签页或值班员改过），
 * 抛出此错误，调用方应保留表单并提示重新选择泊位。
 */
export class BerthConflictError extends Error {
  constructor(
    public readonly berthNo: string,
    public readonly expected: { status: BerthStatus; version: number },
    public readonly actual: { status: BerthStatus; version: number },
  ) {
    super(
      `泊位 ${berthNo} 状态已变化（期望 ${expected.status} v${expected.version}，实际 ${actual.status} v${actual.version}），请重新选择泊位`,
    );
    this.name = 'BerthConflictError';
  }
}

/** 泊位占用聚合结果（useBerthStatus 输出） */
export interface BerthSummary {
  portId: string;
  total: number;
  occupied: number;
  free: number;
  maintenance: number;
  /** 占用率 0-1 */
  occupancyRate: number;
  /** 在港船舶数量 */
  inPortCount: number;
  freeBerths: Berth[];
  occupiedBerths: Berth[];
}
