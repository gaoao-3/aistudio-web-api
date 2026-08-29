// ---------- 本地聊天记录 ----------
import { computed, ref } from "vue";
import { toastOk } from "../api/client";
import { model, msgs } from "./useCache";
import { useView } from "./useView";
import type { LocalConversation } from "../types";

const historyLoading = ref(false);

export function useHistory() {
  // generateContent 是无状态接口，聊天历史保存在浏览器 localStorage 中。
  // 目前保留“当前对话”这一项，不再依赖服务端会话存储。
  const history = computed<LocalConversation[]>(() =>
    msgs.value.length > 0
      ? [
          {
            id: "current",
            model: model.value,
            updated_at: new Date().toISOString(),
            messages: msgs.value,
          },
        ]
      : [],
  );

  function loadHistory(): void {
    historyLoading.value = false;
  }

  function historyPreview(conversation: LocalConversation): string {
    const firstUser = conversation.messages.find(
      (message) => message.role === "user",
    );
    return (
      firstUser?.content ||
      (firstUser?.attachments?.length ? "(图片/附件)" : "(空)")
    );
  }

  function openConversation(conversation: LocalConversation): void {
    msgs.value = conversation.messages.map((message) => ({
      ...message,
      attachments: message.attachments ? [...message.attachments] : undefined,
    }));
    model.value = conversation.model;
    useView().go("chat");
  }

  function removeConversation(id: string): void {
    if (id !== "current") return;
    msgs.value = [];
    toastOk("已清空当前对话");
  }

  return {
    history,
    historyLoading,
    loadHistory,
    historyPreview,
    openConversation,
    removeConversation,
  };
}
