/**
 * 跨标签页数据同步：某个标签页写入业务数据后通知其他标签页刷新。
 * 优先用 BroadcastChannel（同源、不污染 localStorage），不支持时降级为 localStorage storage 事件。
 */

const CHANNEL_NAME = 'gbfishport-sync';
const STORAGE_KEY = 'gbfishport:sync';

interface SyncMessage {
  type: 'data-changed';
  at: number;
}

type Listener = (msg: SyncMessage) => void;

const listeners = new Set<Listener>();

let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data && (event.data as SyncMessage).type === 'data-changed') {
        listeners.forEach((fn) => fn(event.data as SyncMessage));
      }
    };
  } catch {
    channel = null;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const msg = JSON.parse(event.newValue) as SyncMessage;
      if (msg.type === 'data-changed') {
        listeners.forEach((fn) => fn(msg));
      }
    } catch {
      // 忽略解析失败的消息
    }
  });
}

/** 通知其他标签页：业务数据已变更，请重新拉取 */
export function notifyDataChanged(): void {
  const msg: SyncMessage = { type: 'data-changed', at: Date.now() };
  if (channel) {
    try {
      channel.postMessage(msg);
    } catch {
      // BroadcastChannel 发送失败时降级到 localStorage
      writeToStorage(msg);
    }
  } else {
    writeToStorage(msg);
  }
}

function writeToStorage(msg: SyncMessage): void {
  try {
    // storage 事件只在其他标签页触发，正好用于降级通知
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msg));
  } catch {
    // localStorage 不可用时静默降级
  }
}

/** 订阅其他标签页的数据变更通知，返回取消订阅函数 */
export function onDataChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
