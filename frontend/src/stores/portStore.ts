import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { broadcastDataChange } from '../db/sync';
import { toPlain, uid } from '../utils/format';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import type { Berth, BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import { buildBerthRecords } from '../db/berth';

/** 泊位并发冲突：事务内重读泊位后状态/版本已变化，整笔写入已被拒绝。 */
export class BerthConflictError extends Error {
  constructor(
    public reason:
      | 'missing'
      | 'version'
      | 'inbound-occupied'
      | 'outbound-released'
      | 'maintenance',
    public detail: string,
  ) {
    super(detail);
    this.name = 'BerthConflictError';
  }
}

export interface PortInput {
  name: string;
  level: FishingPort['level'];
  longitude: number;
  latitude: number;
  berthCount: number;
  berthDepth: number;
  wharfLength: number;
  shelterLevel: number;
  supply: SupplyCapability;
  manager: string;
}

export const usePortStore = defineStore('port', () => {
  const ports = ref<FishingPort[]>([]);
  const berths = ref<Berth[]>([]);
  const calls = ref<PortCall[]>([]);
  const loading = ref(false);
  const filter = ref<PortFilter>(emptyPortFilter());

  const filteredPorts = computed(() => {
    const f = filter.value;
    const keyword = f.keyword.trim();
    return ports.value.filter((p) => {
      if (f.level && p.level !== f.level) return false;
      if (f.minShelterLevel !== null && p.shelterLevel < f.minShelterLevel) return false;
      if (keyword && !p.name.includes(keyword) && !p.manager.includes(keyword)) return false;
      return true;
    });
  });

  const callsSorted = computed(() =>
    [...calls.value].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
  );

  function portById(id: string): FishingPort | undefined {
    return ports.value.find((p) => p.id === id);
  }

  function berthsOf(portId: string): Berth[] {
    return berths.value.filter((b) => b.portId === portId).sort((a, b) => a.berthNo.localeCompare(b.berthNo));
  }

  function callsOfVessel(vesselId: string): PortCall[] {
    return callsSorted.value.filter((c) => c.vesselId === vesselId);
  }

  function resetFilter(): void {
    filter.value = emptyPortFilter();
  }

  async function loadAll(): Promise<void> {
    loading.value = true;
    try {
      const [p, b, c] = await Promise.all([db.ports.toArray(), db.berths.toArray(), db.calls.toArray()]);
      ports.value = p;
      berths.value = b;
      calls.value = c;
    } finally {
      loading.value = false;
    }
  }

  async function createPort(input: PortInput): Promise<FishingPort> {
    const port: FishingPort = {
      id: uid('p'),
      name: input.name.trim(),
      level: input.level,
      longitude: Number(input.longitude),
      latitude: Number(input.latitude),
      berthCount: Number(input.berthCount),
      berthDepth: Number(input.berthDepth),
      wharfLength: Number(input.wharfLength),
      shelterLevel: Number(input.shelterLevel),
      supply: { ...input.supply },
      manager: input.manager.trim(),
      createdAt: new Date().toISOString(),
    };
    const records = buildBerthRecords(port, []);
    // 渔港与泊位清单同一事务原子落库，避免只建成一半
    await db.transaction('rw', db.ports, db.berths, async () => {
      await db.ports.put(toPlain(port));
      await db.berths.bulkPut(toPlain(records));
    });
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    broadcastDataChange('ports', records.map((b) => b.id));
    return port;
  }

  async function addBerth(portId: string, berthNo: string, designDepth: number): Promise<Berth | null> {
    const port = portById(portId);
    if (!port) return null;
    const no = berthNo.trim().toUpperCase();
    if (!no) return null;
    if (berthsOf(portId).some((b) => b.berthNo === no)) return null;
    const berth: Berth = {
      id: `${portId}-${no}`,
      portId,
      berthNo: no,
      vesselId: null,
      vesselName: null,
      berthAt: null,
      leaveAt: null,
      status: '空闲',
      designDepth: Number(designDepth) || port.berthDepth,
      version: 1,
    };
    await db.berths.put(toPlain(berth));
    berths.value = [...berths.value, berth];
    broadcastDataChange('berths', [berth.id]);
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  /**
   * 切换泊位状态（置维修 / 释放为空闲）。
   * 状态切换本身也走版本号自增：另一标签页正停在旧版本上的登记选择会因此立即作废。
   */
  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    const hit = berths.value.find((b) => b.id === berthId);
    if (!hit || hit.status === status) return;
    const next: Berth = {
      ...hit,
      status,
      vesselId: status === '占用' ? hit.vesselId : null,
      vesselName: status === '占用' ? hit.vesselName : null,
      berthAt: status === '占用' ? hit.berthAt ?? new Date().toISOString() : hit.berthAt,
      leaveAt: status === '空闲' ? new Date().toISOString() : null,
      version: hit.version + 1,
    };
    await db.berths.put(toPlain(next));
    berths.value = berths.value.map((b) => (b.id === berthId ? next : b));
    broadcastDataChange('berths', [berthId]);
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
  }

  /**
   * 登记一条进出港记录，并同步泊位占用状态（进港 → 占用，出港 → 释放）。
   *
   * 并发安全：流水与泊位在同一个 IndexedDB 读写事务内原子提交。
   * 提交前在事务内重新核对泊位（而不是用本页内存里可能已过期的状态）：
   * - 泊位版本与选中时不一致（另一标签页已抢先处理）→ 拒绝整笔写入
   * - 进港时泊位已被占用 / 维修 → 拒绝
   * - 出港时泊位已被释放 / 维修 → 拒绝
   * 任一条不满足都抛 BerthConflictError 并回滚，调用方保留表单等待对方处理后再选。
   */
  async function registerCall(draft: CallDraft, vesselName: string, portId: string): Promise<PortCall> {
    if (draft.berthVersion === null || draft.berthVersion === undefined) {
      throw new BerthConflictError('version', '泊位版本信息缺失，请重新选择泊位后再提交（表单内容已保留）');
    }
    const expectedVersion = draft.berthVersion;
    const berthId = `${portId}-${draft.berthNo}`;
    const now = new Date().toISOString();

    const call: PortCall = {
      id: uid('c'),
      vesselId: draft.vesselId,
      vesselName,
      type: draft.type,
      time: draft.time ? new Date(draft.time).toISOString() : now,
      berthNo: draft.berthNo,
      iceKg: Number(draft.iceKg) || 0,
      fuelL: Number(draft.fuelL) || 0,
      unloadKg: Number(draft.unloadKg) || 0,
      visaStatus: draft.visaStatus,
      createdAt: now,
      version: 1,
      berthVersion: expectedVersion,
    };

    let nextBerth: Berth | null = null;
    try {
      await db.transaction('rw', db.calls, db.berths, async () => {
        // 事务内重读泊位，拿到此刻数据库里的权威状态
        const current = await db.berths.get(berthId);
        if (!current) {
          throw new BerthConflictError('missing', `泊位 ${draft.berthNo} 已不存在，请重新选择泊位（表单内容已保留）`);
        }
        if (current.version !== expectedVersion) {
          throw new BerthConflictError(
            'version',
            `泊位 ${current.berthNo} 刚被其他标签页处理过（版本 ${expectedVersion} → ${current.version}，当前为「${current.status}」），本次登记已取消，请核对后重新选择泊位`,
          );
        }
        if (current.status === '维修') {
          throw new BerthConflictError(
            'maintenance',
            `泊位 ${current.berthNo} 当前处于维修状态，不能登记进出港，请改选其他泊位`,
          );
        }
        if (draft.type === '进港') {
          if (current.status === '占用') {
            throw new BerthConflictError(
              'inbound-occupied',
              `泊位 ${current.berthNo} 已被${current.vesselName ? `「${current.vesselName}」` : '其他船舶'}占用，本次进港登记已取消，请改选空闲泊位`,
            );
          }
          nextBerth = {
            ...current,
            status: '占用',
            vesselId: draft.vesselId,
            vesselName,
            berthAt: call.time,
            leaveAt: null,
            version: current.version + 1,
          };
        } else {
          if (current.status === '空闲') {
            throw new BerthConflictError(
              'outbound-released',
              `泊位 ${current.berthNo} 已被释放为空闲，本次出港登记已取消，请核对后重新选择泊位`,
            );
          }
          nextBerth = {
            ...current,
            status: '空闲',
            vesselId: null,
            vesselName: null,
            berthAt: null,
            leaveAt: call.time,
            version: current.version + 1,
          };
        }
        await db.calls.put(toPlain(call));
        await db.berths.put(toPlain(nextBerth));
      });
    } catch (error) {
      // 冲突时先把本页状态对齐到数据库，好让泊位网格立即反映对方的处理结果
      if (error instanceof BerthConflictError) {
        const [freshBerths, freshCalls] = await Promise.all([db.berths.toArray(), db.calls.toArray()]);
        berths.value = freshBerths;
        calls.value = freshCalls;
      }
      throw error;
    }

    // 事务提交成功后再更新内存状态，随后通知其他标签页
    calls.value = [...calls.value, call];
    if (nextBerth) {
      berths.value = berths.value.map((b) => (b.id === nextBerth!.id ? nextBerth! : b));
    }
    broadcastDataChange('calls', [berthId]);
    return call;
  }

  return {
    ports,
    berths,
    calls,
    loading,
    filter,
    filteredPorts,
    callsSorted,
    portById,
    berthsOf,
    callsOfVessel,
    resetFilter,
    loadAll,
    createPort,
    addBerth,
    setBerthStatus,
    updatePort,
    registerCall,
  };
});
