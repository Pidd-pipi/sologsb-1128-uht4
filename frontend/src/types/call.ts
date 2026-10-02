/** 进出港类型 */
export type CallType = '进港' | '出港';

export const CALL_TYPES: CallType[] = ['进港', '出港'];

/** 签证状态 */
export type VisaStatus = '已签证' | '待签证' | '免签';

export const VISA_STATUSES: VisaStatus[] = ['已签证', '待签证', '免签'];

/** 进出港记录 */
export interface PortCall {
  id: string;
  /** 渔船 id */
  vesselId: string;
  /** 渔船名（冗余，便于流水展示） */
  vesselName: string;
  /** 类型：进港 / 出港 */
  type: CallType;
  /** 时间（ISO 字符串） */
  time: string;
  /** 泊位号 */
  berthNo: string;
  /** 加冰 kg */
  iceKg: number;
  /** 加油 L */
  fuelL: number;
  /** 卸货量 kg */
  unloadKg: number;
  /** 签证状态 */
  visaStatus: VisaStatus;
  createdAt: string;
  /**
   * 进出港记录版本号（乐观锁审计用）：新建即为 1。
   */
  version: number;
  /**
   * 提交时所依据的泊位版本号快照。
   * 登记在同一事务内重读泊位：泊位版本已变化（另一标签页先提交）即整笔拒绝。
   * 迁移回填的历史流水没有可依据的泊位快照，统一为 null，不参与占用补造。
   */
  berthVersion: number | null;
}

/** 进出港登记表单模型 */
export interface CallDraft {
  vesselId: string;
  type: CallType;
  time: string;
  berthNo: string;
  iceKg: number;
  fuelL: number;
  unloadKg: number;
  visaStatus: VisaStatus;
  /** 选中泊位时的版本号；提交时作为乐观锁依据，null 表示尚未取得版本快照 */
  berthVersion: number | null;
}

export function emptyCallDraft(berthNo = ''): CallDraft {
  return {
    vesselId: '',
    type: '进港',
    time: '',
    berthNo,
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证',
    berthVersion: null,
  };
}
