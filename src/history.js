// 本地历史版本：每次保存时（同一文件最多每 5 分钟一份）在应用数据目录留一份快照，
// 打开文件时也会先存一份原始内容。可以按时间查看任意版本并恢复。
// 快照存在应用数据目录里，不会在文档文件夹里产生额外文件。

import Vditor from "vditor";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";

const pad = (n) => String(n).padStart(2, "0");

function formatTime(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function formatSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function initHistory({ getPath, getContent, getLinkBase, restore, toast }) {
  const modal = document.createElement("div");
  modal.id = "history-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="hm-box">
      <div class="hm-head">
        <span class="hm-title">历史版本</span>
        <span class="hm-file"></span>
        <button class="hm-close" title="关闭 (Esc)">×</button>
      </div>
      <div class="hm-body">
        <div class="hm-list"></div>
        <div class="hm-preview"><div class="hm-preview-body"></div></div>
      </div>
      <div class="hm-foot">
        <span class="hm-hint">打开文件时、以及每次保存时（同一文件最多每 5 分钟一份）会自动留一份，最多保留 100 份</span>
        <button class="hm-restore" disabled>恢复此版本</button>
      </div>
    </div>`;
  document.body.append(modal);

  const list = modal.querySelector(".hm-list");
  const previewBody = modal.querySelector(".hm-preview-body");
  const restoreBtn = modal.querySelector(".hm-restore");
  let selected = null; // { id, time, text }

  // 存一份快照；force 为 true 时不受 5 分钟间隔限制（内容和上一份相同仍然不存）
  async function snapshot(path, content, force = false) {
    if (!path) return;
    try {
      await invoke("history_save", { path, content, force });
    } catch (e) {
      console.warn("历史版本保存失败", e);
    }
  }

  async function open() {
    const path = getPath();
    if (!path) {
      toast("新建的文档还没有保存过，没有历史版本");
      return;
    }
    // 打开前先把当前内容存一份，列表里第一项就是“现在”
    await snapshot(path, getContent(), true);
    const items = await invoke("history_list", { path });
    modal.querySelector(".hm-file").textContent = path.split(/[\\/]/).pop();
    list.replaceChildren(
      ...items.map((it, i) => {
        const row = document.createElement("div");
        row.className = "hm-item";
        row.dataset.id = it.id;
        row.dataset.time = it.time;
        row.innerHTML = `<div class="hm-time"></div><div class="hm-meta"></div>`;
        row.querySelector(".hm-time").textContent = formatTime(it.time) + (i === 0 ? "（当前）" : "");
        row.querySelector(".hm-meta").textContent = `${ago(it.time)} · ${formatSize(it.size)}`;
        return row;
      }),
    );
    modal.hidden = false;
    // 默认选中上一个版本（第一项是当前内容）
    const first = list.children[1] || list.children[0];
    if (first) select(first);
  }

  async function select(row) {
    for (const r of list.children) r.classList.toggle("active", r === row);
    const id = row.dataset.id;
    const text = await invoke("history_read", { path: getPath(), id });
    selected = { id, time: +row.dataset.time, text };
    restoreBtn.disabled = row === list.children[0];
    Vditor.preview(previewBody, text, {
      cdn: "/vditor",
      lang: "zh_CN",
      mode: "light",
      theme: { current: "light" },
      hljs: { style: "github", lineNumber: true },
      markdown: { linkBase: getLinkBase() },
    });
    modal.querySelector(".hm-preview").scrollTop = 0;
  }

  function close() {
    modal.hidden = true;
  }

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".hm-item");
    if (row) select(row);
  });
  modal.querySelector(".hm-close").addEventListener("click", close);
  modal.addEventListener("mousedown", (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );

  restoreBtn.addEventListener("click", async () => {
    if (!selected) return;
    const ok = await ask(`恢复到 ${formatTime(selected.time)} 的版本？\n\n恢复后会立即保存。现在的内容已经存了一份历史，随时可以再恢复回来。`, {
      title: "恢复历史版本",
      kind: "warning",
      okLabel: "恢复",
      cancelLabel: "取消",
    });
    if (!ok) return;
    close();
    await restore(selected.text);
    toast(`已恢复到 ${formatTime(selected.time)} 的版本`);
  });

  return { snapshot, open };
}
