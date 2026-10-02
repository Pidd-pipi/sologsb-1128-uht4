import { onMounted, onUnmounted } from 'vue';
import { subscribeDataChanges, type DataChangeMessage } from '../db/sync';
import { usePortStore } from '../stores/portStore';

/**
 * 订阅其他标签页的数据变更：对方原子提交成功后，本页重新拉取
 * 泊位 / 流水 / 渔港，渔港一览、泊位网格、地图摘要与渔船时间线随即重算。
 *
 * 收多条短时间内的广播（对方连续登记）时做一次合并，避免频繁刷新。
 */
export function useDataSync(onChange?: (message: DataChangeMessage) => void): void {
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: DataChangeMessage | null = null;

  onMounted(() => {
    const portStore = usePortStore();
    unsubscribe = subscribeDataChanges((message) => {
      pending = message;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const latest = pending;
        pending = null;
        void portStore.loadAll();
        if (latest) onChange?.(latest);
      }, 150);
    });
  });

  onUnmounted(() => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe?.();
  });
}
