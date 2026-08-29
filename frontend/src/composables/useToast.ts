// ---------- 全局 toast（模块级队列，ToastHost 组件渲染） ----------
import { reactive, readonly } from 'vue';

export interface ToastItem {
  id: number;
  text: string;
  color: 'success' | 'error' | 'info';
  show: boolean;
}

const state = reactive<{ items: ToastItem[] }>({ items: [] });
let seq = 0;

function push(text: string, color: ToastItem['color']): void {
  const item: ToastItem = { id: ++seq, text, color, show: true };
  state.items.push(item);
  setTimeout(() => {
    item.show = false;
    setTimeout(() => {
      const i = state.items.indexOf(item);
      if (i >= 0) state.items.splice(i, 1);
    }, 300);
  }, 2600);
}

export function useToast() {
  return {
    toasts: readonly(state).items,
    ok: (text: string) => push(text, 'success'),
    err: (text: string) => push(text, 'error'),
    info: (text: string) => push(text, 'info'),
  };
}
