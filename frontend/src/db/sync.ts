/**
 * 跨标签页数据变更通知。
 *
 * 值班室常开两个标签页，一个标签页原子提交成功后，必须立刻通知其他标签页，
 * 让渔港一览、泊位网格、地图摘要与渔船时间线重算。
 *
 * 优先使用 BroadcastChannel；浏览器不支持时降级为 window 的 storage 事件
 * （storage 事件天然只在「其他」标签页触发，不会回环通知写入者）。
 */

export type DataChangeScope = 'berths' | 'calls' | 'ports' | 'all';

export interface DataChangeMessage {
  /** 去重 id：storage 降级路径下不同事件可能重复投递 */
  id: number;
  /** 本次提交涉及的数据域，便于接收方决定重算范围 */
  scope: DataChangeScope;
  /** 变更泊位 id 列表（进出港登记 / 置维修 / 释放时携带） */
  berthIds?: string[];
  /** 发送方标签页标识 */
  origin: string;
  at: string;
}

const CHANNEL_NAME = 'gbfishport:data-change';
const STORAGE_KEY = 'gbfishport:data-change';

type ChangeHandler = (message: DataChangeMessage) => void;

let seq = 0;
const tabOrigin = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

let channel: BroadcastChannel | null = null;
const handlers = new Set<ChangeHandler>();
const recentIds: number[] = [];

function remember(id: number): boolean {
  if (recentIds.includes(id)) return false;
  recentIds.push(id);
  // 只保留最近 50 条，避免长会话内存增长
  if (recentIds.length > 50) recentIds.splice(0, recentIds.length - 50);
  return true;
}

function dispatch(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as DataChangeMessage;
  if (typeof message.id !== 'number' || message.origin === tabOrigin) return;
  if (!remember(message.id)) return;
  for (const handler of handlers) {
    try {
      handler(message);
    } catch (error) {
      console.warn('[gbfishport] 处理跨标签页数据变更失败：', error);
    }
  }
}

function ensureChannel(): void {
  if (channel !== null) return;
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<unknown>) => dispatch(event.data);
  } else if (typeof window !== 'undefined' && window.addEventListener) {
    // 降级：storage 事件只在其他标签页触发
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        dispatch(JSON.parse(event.newValue));
      } catch {
        // 忽略无法解析的噪声
      }
    });
  }
}

/** 订阅其他标签页的数据变更通知，返回退订函数。 */
export function subscribeDataChanges(handler: ChangeHandler): () => void {
  ensureChannel();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** 本标签页提交成功后调用，通知所有其他标签页重算。不会回环通知当前页。 */
export function broadcastDataChange(scope: DataChangeScope, berthIds: string[] = []): void {
  ensureChannel();
  seq += 1;
  const message: DataChangeMessage = {
    id: Date.now() * 1000 + seq,
    scope,
    berthIds,
    origin: tabOrigin,
    at: new Date().toISOString(),
  };
  if (channel) {
    channel.postMessage(message);
  } else if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
    } catch {
      // localStorage 不可用时降级为不通知，不阻塞主流程
    }
  }
}
