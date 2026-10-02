import Dexie, { type Table } from 'dexie';
import type { FishingPort } from '../types/port';
import type { FishingVessel } from '../types/vessel';
import type { PortCall } from '../types/call';
import type { Berth } from '../types/berth';
import { buildBerthRecords } from './berth';

/**
 * gbfishport-db：库名固定为 gbfishport-db
 * v1 建 ports / vessels；v2 新增 calls 表与 vesselId 索引；v3 新增 berths 表并按泊位数生成初始记录；
 * v4 为泊位与进出港记录补乐观锁版本号（berths.version / calls.version / calls.berthVersion），
 * 迁移只回填版本字段：旧泊位一律 version=1、历史流水 version=1 且 berthVersion=null，
 * 不根据历史流水反推或补造任何占用关系。
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
        ports: 'id, name, level, shelterLevel',
        vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
        calls: 'id, vesselId, type, time',
        berths: 'id, portId, berthNo, status, vesselId',
      })
      .upgrade(async (tx) => {
        // 仅回填版本号；保留旧记录的全部占用 / 空闲 / 维修状态，绝不补造占用关系
        await tx
          .table<Berth, string>('berths')
          .toCollection()
          .modify((berth) => {
            if (typeof berth.version !== 'number' || !Number.isFinite(berth.version) || berth.version < 1) {
              berth.version = 1;
            }
          });
        await tx
          .table<PortCall, string>('calls')
          .toCollection()
          .modify((call) => {
            if (typeof call.version !== 'number' || !Number.isFinite(call.version) || call.version < 1) {
              call.version = 1;
            }
            // 历史流水没有提交时的泊位快照，显式置空而非按流水反推泊位占用
            if (call.berthVersion === undefined) call.berthVersion = null;
          });
      });
  }
}

export const db = new FishPortDatabase();
