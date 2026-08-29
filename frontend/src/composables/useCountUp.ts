// 数字滚动动画：源数值变化时平滑过渡到新值（用于统计卡片）
import { onUnmounted, ref, watch, type Ref } from "vue";

export function useCountUp(source: Ref<number>, duration = 650): Ref<number> {
  const display = ref(source.value);
  let raf = 0;

  watch(source, (target) => {
    cancelAnimationFrame(raf);
    const from = display.value;
    if (from === target) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - t) ** 3; // easeOutCubic
      display.value = Math.round(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });

  onUnmounted(() => cancelAnimationFrame(raf));
  return display;
}
