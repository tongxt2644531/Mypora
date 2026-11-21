// 文件树右键菜单：新建文件、新建文件夹、重命名、删除（放进回收站）、在资源管理器中显示、复制路径。
// 新建和重命名直接在文件树那一行里输入名字：回车确定，Esc 取消。

import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

function dirOf(path) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : path;
}
const baseName = (p) => p.split(/[\\/]/).pop();

export function initTreeMenu({ tree, icons, renderTree, expandDir, openPath, getCurrentPath, onPathMoved, onPathDeleted, chooseFolder, toast }) {
  const menu = document.createElement("div");
  menu.id = "tree-menu";
  menu.className = "tt-pop";
  menu.hidden = true;
  document.body.append(menu);

  let target = null; // 右键点中的那一行

  const ITEMS = {
    newFile: "新建文件",
    newFolder: "新建文件夹",
    rename: "重命名",
    delete: "删除",
    reveal: "在资源管理器中显示",
    copyPath: "复制路径",
    openFolder: "打开其他文件夹…",
  };

  function show(row, x, y) {
    target = row;
    const isRoot = row.classList.contains("tree-root");
    const keys = isRoot
      ? ["newFile", "newFolder", "-", "reveal", "copyPath", "-", "openFolder"]
      : ["newFile", "newFolder", "-", "rename", "delete", "-", "reveal", "copyPath"];
    menu.replaceChildren(
      ...keys.map((k) => {
        if (k === "-") return document.createElement("hr");
        const b = document.createElement("button");
        b.dataset.op = k;
        b.textContent = ITEMS[k];
        if (k === "delete") b.classList.add("danger");
        return b;
      }),
    );
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.min(x, window.innerWidth - w - 4)}px`;
    menu.style.top = `${y + h > window.innerHeight - 4 ? Math.max(4, y - h) : y}px`;
  }

  function hide() {
    menu.hidden = true;
  }

  // 还没打开任何文件夹时的右键菜单
  function showNoFolder(x, y) {
    target = null;
    const b = document.createElement("button");
    b.dataset.op = "openFolder";
    b.textContent = "打开文件夹…";
    menu.replaceChildren(b);
    menu.hidden = false;
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 4)}px`;
    menu.style.top = `${y}px`;
  }

  // 在某一行里放一个输入框让用户输入名字。
  // place：放在 anchorRow 之后（新建）还是替换 anchorRow 的名字（重命名）
  function promptName({ anchorRow, depth, isDir, initial, rename }) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.className = "tree-input";
      input.value = initial;
      input.spellcheck = false;
      let row;
      if (rename) {
        row = anchorRow;
        row.querySelector(".tree-name").replaceWith(input);
      } else {
        row = document.createElement("div");
        row.className = "tree-item editing " + (isDir ? "tree-dir empty" : "tree-file");
        row.style.paddingLeft = `${4 + depth * 14}px`;
        const arrow = document.createElement("span");
        arrow.className = "tree-arrow";
        const icon = document.createElement("span");
        icon.className = "tree-icon";
        icon.innerHTML = isDir ? icons.folder : icons.file;
        row.append(arrow, icon, input);
        anchorRow.after(row);
      }
      row.classList.add("editing");
      input.focus();
      // 选中文件名，不选扩展名
      const dot = initial.lastIndexOf(".");
      input.setSelectionRange(0, !isDir && dot > 0 ? dot : initial.length);

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(input.value.trim());
        if (e.key === "Escape") finish(null);
      });
      input.addEventListener("blur", () => finish(input.value.trim() === initial ? null : input.value.trim()));
      input.addEventListener("click", (e) => e.stopPropagation());
    });
  }

  function validName(name) {
    if (!name) return false;
    if (/[<>:"/\\|?*]/.test(name)) {
      toast('名字里不能有 < > : " / \\ | ? * 这些字符');
      return false;
    }
    return true;
  }

  async function create(isDir) {
    const row = target;
    const isFolderRow = row.classList.contains("tree-dir");
    const parentDir = isFolderRow ? row.dataset.path : dirOf(row.dataset.path);
    // 在文件夹上新建：先展开它，输入框放在文件夹下面第一行
    let anchorRow = row;
    let depth = parseInt(row.style.paddingLeft) / 14;
    if (isFolderRow) {
      await expandDir(parentDir);
      anchorRow = tree.querySelector(`.tree-item[data-path="${CSS.escape(parentDir)}"]`) || tree.firstElementChild;
      depth = Math.round((parseInt(anchorRow.style.paddingLeft) - 4) / 14) + 1;
    } else {
      depth = Math.round((parseInt(row.style.paddingLeft) - 4) / 14);
    }
    let name = await promptName({ anchorRow, depth, isDir, initial: isDir ? "新建文件夹" : "未命名.md" });
    if (!validName(name)) {
      await renderTree();
      return;
    }
    if (!isDir && !/\.\w+$/.test(name)) name += ".md";
    const path = parentDir.replace(/[\\/]$/, "") + "\\" + name;
    try {
      await invoke(isDir ? "create_dir" : "create_file", { path });
    } catch (e) {
      toast(`新建失败：${e}`);
      await renderTree();
      return;
    }
    await renderTree();
    if (!isDir) await openPath(path);
  }

  async function rename() {
    const row = target;
    const from = row.dataset.path;
    const isDir = row.classList.contains("tree-dir");
    const name = await promptName({ anchorRow: row, isDir, initial: baseName(from), rename: true });
    if (!validName(name) || name === baseName(from)) {
      await renderTree();
      return;
    }
    const to = dirOf(from) + "\\" + name;
    try {
      await invoke("rename_path", { from, to });
      onPathMoved(from, to);
    } catch (e) {
      toast(`重命名失败：${e}`);
    }
    await renderTree();
  }

  async function remove() {
    const path = target.dataset.path;
    const isDir = target.classList.contains("tree-dir");
    const ok = await ask(`删除${isDir ? "文件夹" : "文件"}「${baseName(path)}」？${isDir ? "\n文件夹里的所有内容都会一起删除。" : ""}\n\n会放进回收站，需要时可以从回收站找回。`, {
      title: "删除",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (!ok) return;
    try {
      await invoke("trash_path", { path });
      onPathDeleted(path);
      toast(`已把「${baseName(path)}」放进回收站`);
    } catch (e) {
      toast(`删除失败：${e}`);
    }
    await renderTree();
  }

  const ops = {
    newFile: () => create(false),
    newFolder: () => create(true),
    rename,
    delete: remove,
    reveal: () => revealItemInDir(target.dataset.path).catch((e) => toast(`打开资源管理器失败：${e}`)),
    copyPath: async () => {
      try {
        await navigator.clipboard.writeText(target.dataset.path);
        toast("已复制路径");
      } catch (e) {
        toast(`复制失败：${e}`);
      }
    },
    openFolder: () => chooseFolder(),
  };

  // 右键：点在某一行上就针对那一行；点在空白处就当作点在根文件夹上
  document.getElementById("files-pane").addEventListener("contextmenu", (e) => {
    e.preventDefault();
    let row = e.target.closest(".tree-item");
    if (row?.classList.contains("editing")) return hide();
    if (!row) row = tree.querySelector(".tree-root");
    if (row) show(row, e.clientX, e.clientY);
    else showNoFolder(e.clientX, e.clientY);
  });

  menu.addEventListener("mousedown", (e) => e.preventDefault());
  menu.addEventListener("click", (e) => {
    const op = e.target.closest("button")?.dataset.op;
    if (!op) return;
    hide();
    ops[op]();
  });
  document.addEventListener("mousedown", (e) => {
    if (!menu.contains(e.target)) hide();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  tree.addEventListener("scroll", hide);
}
