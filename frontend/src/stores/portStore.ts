import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { db } from '../db';
import { toPlain, uid } from '../utils/format';
import { notifyDataChanged } from '../utils/crossTab';
import { emptyPortFilter, type FishingPort, type PortFilter, type SupplyCapability } from '../types/port';
import { BerthConflictError, type Berth, type BerthStatus } from '../types/berth';
import type { CallDraft, PortCall } from '../types/call';
import { buildBerthRecords } from '../db/berth';

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
    // 写库前脱代理，避免 DataCloneError
    await db.ports.put(toPlain(port));
    const records = buildBerthRecords(port, []);
    await db.berths.bulkPut(toPlain(records));
    ports.value = [...ports.value, port];
    berths.value = [...berths.value, ...records];
    notifyDataChanged();
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
    const nextCount = berthsOf(portId).length;
    await updatePort(portId, { berthCount: nextCount });
    return berth;
  }

  async function setBerthStatus(berthId: string, status: BerthStatus): Promise<void> {
    // 事务内重新从 DB 读取，避免用 store 里的陈旧状态覆盖其他标签页的改动
    const hit = await db.berths.get(berthId);
    if (!hit) return;
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
    notifyDataChanged();
  }

  async function updatePort(portId: string, patch: Partial<FishingPort>): Promise<void> {
    const hit = portById(portId);
    if (!hit) return;
    const next: FishingPort = { ...hit, ...patch };
    await db.ports.put(toPlain(next));
    ports.value = ports.value.map((p) => (p.id === portId ? next : p));
    notifyDataChanged();
  }

  /**
   * 登记一条进出港记录，并同步泊位占用状态。
   *
   * 在同一个 Dexie 事务里原子完成「核对泊位 → 写流水 → 改泊位」：
   * - 提交前重新从 DB 读取泊位（不用 store 里的陈旧状态）；
   * - 进港要求泊位当前为「空闲」，出港要求「占用」，维修泊位一律拒绝；
   * - 核对泊位版本号（乐观锁），与表单选中时不一致则拒绝整笔写入；
   * - 任一不满足都抛 BerthConflictError，事务回滚，调用方保留表单。
   * 成功后通知其他标签页刷新。
   */
  async function registerCall(
    draft: CallDraft,
    vesselName: string,
    portId: string,
    expectedVersion: number,
  ): Promise<PortCall> {
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
      version: 1,
      createdAt: now,
    };

    // 事务内完成核对 + 写入，保证流水与泊位状态一致
    const nextBerth = await db.transaction('rw', db.calls, db.berths, async () => {
      // 重新从 DB 读取泊位，避免用 store 里的陈旧状态
      const berth = await db.berths
        .where('portId')
        .equals(portId)
        .filter((b) => b.berthNo === draft.berthNo)
        .first();

      if (!berth) {
        throw new BerthConflictError(
          draft.berthNo,
          { status: draft.type === '进港' ? '空闲' : '占用', version: expectedVersion },
          { status: '维修', version: 0 },
        );
      }

      // 维修泊位不能被进出港登记绕过
      if (berth.status === '维修') {
        throw new BerthConflictError(
          draft.berthNo,
          { status: berth.status, version: expectedVersion },
          { status: '维修', version: berth.version },
        );
      }

      // 进港 → 空闲；出港 → 占用
      const wanted: BerthStatus = draft.type === '进港' ? '空闲' : '占用';
      if (berth.status !== wanted) {
        throw new BerthConflictError(
          draft.berthNo,
          { status: wanted, version: expectedVersion },
          { status: berth.status, version: berth.version },
        );
      }

      // 乐观锁：版本不一致说明被其他标签页 / 值班员改过
      if (berth.version !== expectedVersion) {
        throw new BerthConflictError(
          draft.berthNo,
          { status: wanted, version: expectedVersion },
          { status: berth.status, version: berth.version },
        );
      }

      const next: Berth =
        draft.type === '进港'
          ? {
              ...berth,
              status: '占用',
              vesselId: draft.vesselId,
              vesselName,
              berthAt: call.time,
              leaveAt: null,
              version: berth.version + 1,
            }
          : {
              ...berth,
              status: '空闲',
              vesselId: null,
              vesselName: null,
              berthAt: null,
              leaveAt: call.time,
              version: berth.version + 1,
            };

      await db.calls.add(toPlain(call));
      await db.berths.put(toPlain(next));
      return next;
    });

    // 事务成功后同步 store，并通知其他标签页刷新
    calls.value = [...calls.value, call];
    berths.value = berths.value.map((b) => (b.id === nextBerth.id ? nextBerth : b));
    notifyDataChanged();
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
