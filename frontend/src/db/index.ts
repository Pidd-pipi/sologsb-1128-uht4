import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import { buildBerthRecords } from './berth';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 为 berths / calls 回填乐观锁版本号（不补造占用关系，仅给缺少 version 的记录补 1）。
 */
export class FishPortDatabase extends Dexie {
  ports!: Table<FishingPort, string>;
  vessels!: Table<FishingVessel, string>;
  calls!: Table<PortCall, string>;
  berths!: Table<Berth, string>;

  constructor() {
    super('gbfishport-db');

    this.version(1).stores({
      ports: 'id, name, level, shelterLevel',
      vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
    });

    this.version(2)
      .stores({
        calls: 'id, vesselId, type, time',
      })
      .upgrade(async (tx) => {
        // v2 迁移：新增 calls 表与 vesselId 索引，回填历史记录的冗余字段
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (!call.vesselName) call.vesselName = '';
            if (!call.visaStatus) call.visaStatus = '待签证';
          });
      });

    this.version(3)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // v3 迁移：新增 berths 表，并按每个渔港登记的泊位数生成初始泊位记录
        const ports = await tx.table<FishingPort, string>('ports').toArray();
        const berthTable = tx.table<Berth, string>('berths');
        for (const port of ports) {
          const existing = await berthTable.where('portId').equals(port.id).count();
          if (existing === 0) {
            await berthTable.bulkPut(buildBerthRecords(port));
          }
        }
      });

    this.version(4)
      .stores({
        berths: 'id, portId, berthNo, status, vesselId, version',
        calls: 'id, vesselId, type, time, version',
      })
      .upgrade(async (tx) => {
        // v4 迁移：回填乐观锁版本号。
        // 只给缺少 version 的记录补 1，**不补造占用关系**——
        // 泊位的 vesselId / status 保持 v3 迁移后的现状，不从历史流水反推占用。
        await tx
          .table<Berth, string>('berths')
          .toCollection()
          .modify((berth) => {
            if (berth.version === undefined || berth.version === null) berth.version = 1;
          });
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (call.version === undefined || call.version === null) call.version = 1;
          });
      });
  }
}

export const db = new FishPortDatabase();
