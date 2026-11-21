// 粘贴 / 拖入图片：把图片存到文档旁边的 assets 文件夹，并插入 ![](assets/xxx.png)
//   - 粘贴（截图、复制的图片文件）：渲染模式走 Vditor 的 upload.handler，源码模式自己接管 paste
//   - 拖入图片文件：Tauri 会截获拖放，拿到的是文件路径，复制到 assets 后插到鼠标松开的位置
//   - 新建、还没保存的文档没有所在文件夹，先让用户保存

import { invoke } from "@tauri-apps/api/core";

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

const pad = (n) => String(n).padStart(2, "0");

function dirOf(path) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : path;
}

// 截图没有像样的文件名，用时间命名：image-20261122-153045.png
function timestampName(ext) {
  const d = new Date();
  return `image-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`;
}

// Markdown 里的路径：空格、括号等要编码，否则链接会断
function mdImage(name) {
  const path = "assets/" + encodeURI(name).replace(/[()]/g, (c) => encodeURIComponent(c));
  return `![](${path})`;
}

export function initImages({ getMode, getVditor, getSource, getCurrentPath, ensureSaved, toast }) {
  const assetsDir = (docPath) => dirOf(docPath) + "\\assets";

  // 在当前光标处插入 Markdown
  function insert(md) {
    if (getMode() === "source") getSource().insertText(md);
    else getVditor()?.insertValue(md);
  }

  async function docPathOrAsk() {
    return getCurrentPath() || (await ensureSaved());
  }

  // 粘贴的图片（File 对象）
  async function saveFiles(files) {
    const images = files.filter((f) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name));
    if (!images.length) return "只支持粘贴图片";
    const docPath = await docPathOrAsk();
    if (!docPath) return "文档还没保存，图片没有地方存放";
    const dir = assetsDir(docPath);
    const out = [];
    for (const file of images) {
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      // 剪贴板里的截图通常叫 image.png，换成带时间的名字
      const name = !file.name || /^image\.\w+$/i.test(file.name) ? timestampName(ext) : file.name.replace(/[<>:"/\\|?*]/g, "_");
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const saved = await invoke("save_image", bytes, {
          headers: { dir: encodeURIComponent(dir), name: encodeURIComponent(name) },
        });
        out.push(mdImage(saved));
      } catch (e) {
        toast(`图片保存失败：${e}`);
      }
    }
    if (out.length) {
      insert(out.join("\n"));
      toast(`已保存 ${out.length} 张图片到 assets 文件夹`);
    }
    return null;
  }

  // 拖进来的图片文件（磁盘路径）；position 是物理像素坐标
  async function insertPaths(paths, position) {
    const docPath = await docPathOrAsk();
    if (!docPath) return;
    placeCaret(position);
    const dir = assetsDir(docPath);
    const out = [];
    for (const src of paths) {
      try {
        out.push(mdImage(await invoke("copy_into", { src, dir })));
      } catch (e) {
        toast(`图片复制失败：${e}`);
      }
    }
    if (out.length) {
      insert(out.join("\n"));
      toast(`已复制 ${out.length} 张图片到 assets 文件夹`);
    }
  }

  // 把光标放到松开鼠标的位置
  function placeCaret(position) {
    if (!position) return;
    const x = position.x / devicePixelRatio;
    const y = position.y / devicePixelRatio;
    if (getMode() === "source") {
      getSource().setCursorAt(x, y);
      return;
    }
    const root = getVditor()?.vditor?.ir?.element;
    const range = document.caretRangeFromPoint(x, y);
    if (root && range && root.contains(range.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // 源码模式：自己接管粘贴图片（CodeMirror 只会粘贴文字）
  document.getElementById("source").addEventListener(
    "paste",
    (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.some((f) => f.type.startsWith("image/"))) return;
      e.preventDefault();
      e.stopPropagation();
      saveFiles(files);
    },
    true,
  );

  return { saveFiles, insertPaths };
}
