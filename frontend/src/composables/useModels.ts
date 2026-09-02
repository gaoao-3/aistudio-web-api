// ---------- 模型目录（从 app.ts 的 loadModels/pickDefaultModel 移植） ----------
import { apiFetch, toastErr, toastInfo } from '../api/client';
import { model, models } from './useCache';

interface ModelsResponse {
  models?: { name?: string }[];
  source?: 'live' | 'fallback';
}

let fallbackNoticeShown = false;

export function useModels() {
  function pickDefaultModel(): string {
    const ids = models.value.map(m => m.id);
    if (ids.includes('gemini-3.8-flash')) return 'gemini-3.8-flash';
    if (ids.includes('gemini-3.7-flash')) return 'gemini-3.7-flash';
    if (ids.includes('gemini-3.6-flash')) return 'gemini-3.6-flash';
    // 实时目录可能把 agent（antigravity/deep-research）排在前面，跳过
    return ids.find(id => /^(gemini|gemma)-/.test(id)) || ids[0] || '';
  }

  async function loadModels(): Promise<void> {
    try {
      const r = await apiFetch('/v1beta/models');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as ModelsResponse;
      if (!Array.isArray(d.models) || d.models.length === 0) throw new Error('服务端返回了空模型目录');
      models.value = d.models
        .map(m => ({ id: (m.name || '').replace('models/', '') }))
        .filter(m => m.id && !/^(antigravity|deep-research)/.test(m.id));
      if (d.source === 'fallback' && !fallbackNoticeShown) {
        fallbackNoticeShown = true;
        toastInfo('实时模型目录不可用，当前使用内置兜底列表');
      }
      const ids = models.value.map(m => m.id);
      if (!ids.includes(model.value) || /^(antigravity|deep-research)/.test(model.value)) {
        model.value = pickDefaultModel();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      toastErr(`模型目录加载失败，已沿用本地缓存：${detail}`);
    }
  }

  return { models, model, loadModels, pickDefaultModel };
}
