// 点击链接打开：
//   - 渲染模式、源码模式：按住 Ctrl 点击链接（不按 Ctrl 是正常编辑）
//   - 源码模式右侧预览：直接点击（预览不能编辑，同时防止 WebView 跳转到链接页面）
// 打开方式：
//   - http / https / mailto：用系统浏览器打开
//   - #标题：跳到本文档里的这个标题
//   - 指向 .md 的相对路径（可带 #标题）：在编辑器里打开那个文档
//   - 其他本地文件（pdf、图片等）：用系统默认程序打开

import { openUrl, openPath } from "@tauri-apps/plugin-opener";

function dirOf(path) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : path;
}

// 把相对路径拼到 base 目录上，处理 ./ 和 ../
function resolvePath(base, rel) {
  if (/^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("\\\\")) return rel.replace(/\//g, "\\");
  const parts = base.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("\\");
}

// 找出一行文字里光标位置（offset）所在的链接地址
function linkAtOffset(line, offset) {
  const patterns = [/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, /<((?:https?|mailto):[^>\s]+)>/g, /(?:https?:\/\/)[^\s<>()\]]+/g];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(line)); ) {
      if (offset >= m.index && offset <= m.index + m[0].length) return m[1] ?? m[0];
    }
  }
  return null;
}

export function initLinks({ getMode, getCurrentPath, getLinkBase, getSourceView, openDoc, scrollToHeading, toast }) {
  async function follow(raw) {
    let url = (raw || "").trim().replace(/^<|>$/g, "");
    if (!url) return;
    // 预览里的相对链接会被加上本地文件前缀，还原成相对路径
    const base = getLinkBase();
    if (base && url.startsWith(base)) url = decodeURIComponent(url.slice(base.length));

    if (/^(https?:|mailto:|tel:)/i.test(url)) {
      try {
        await openUrl(url);
      } catch (e) {
        toast(`打开链接失败：${e}`);
      }
      return;
    }
    if (url.startsWith("#")) {
      if (!scrollToHeading(decodeURIComponent(url.slice(1)))) toast("在本文档里没找到这个标题");
      return;
    }
    const current = getCurrentPath();
    if (!current) {
      toast("文档还没保存，没法确定相对路径");
      return;
    }
    const [pathPart, anchor] = url.split("#");
    let rel = pathPart;
    try {
      rel = decodeURIComponent(pathPart);
    } catch {
      /* 保持原样 */
    }
    if (rel.startsWith("file:///")) rel = rel.slice(8);
    const target = resolvePath(dirOf(current), rel);
    if (/\.(md|markdown)$/i.test(target)) {
      await openDoc(target, anchor ? decodeURIComponent(anchor) : null);
    } else {
      try {
        await openPath(target);
      } catch (e) {
        toast(`打开失败：${e}`);
      }
    }
  }

  // 渲染模式：Ctrl + 点击
  document.getElementById("editor").addEventListener(
    "click",
    (e) => {
      if (!e.ctrlKey || getMode() !== "ir") return;
      const node = e.target.closest?.('[data-type="a"]');
      const anchor = e.target.closest?.("a[href]");
      const url = node?.querySelector(".vditor-ir__marker--link")?.textContent || anchor?.getAttribute("href");
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      follow(url);
    },
    true,
  );

  // 源码模式：Ctrl + 点击（同时阻止 CodeMirror 的“Ctrl+点击加一个光标”）
  document.getElementById("source").addEventListener(
    "mousedown",
    (e) => {
      if (!e.ctrlKey || e.button !== 0) return;
      const view = getSourceView();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const line = view.state.doc.lineAt(pos);
      const url = linkAtOffset(line.text, pos - line.from);
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      follow(url);
    },
    true,
  );

  // 预览区（源码模式右侧、历史版本预览）：直接点击，并且绝不让 WebView 自己跳转
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest?.("#source-preview a[href], #history-modal .hm-preview a[href]");
      if (!a) return;
      e.preventDefault();
      if (a.closest("#source-preview")) follow(a.getAttribute("href"));
    },
    true,
  );

  // 按住 Ctrl 时，链接上显示手形光标，提示可以点击打开
  const setCtrl = (on) => document.body.classList.toggle("ctrl-down", on);
  window.addEventListener("keydown", (e) => e.key === "Control" && setCtrl(true));
  window.addEventListener("keyup", (e) => e.key === "Control" && setCtrl(false));
  window.addEventListener("blur", () => setCtrl(false));

  return { follow };
}
