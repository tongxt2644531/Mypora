import Vditor from "vditor";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save, ask } from "@tauri-apps/plugin-dialog";
import { initTableTools } from "./table.js";
import { createSourceMode } from "./source.js";
import { initHeadingTweaks } from "./heading.js";
import { initFind } from "./find.js";
import { initSlashMenu } from "./slash.js";
import { initImages, IMAGE_EXT } from "./images.js";
import { initHistory } from "./history.js";
import { initLinks } from "./links.js";
import { initTreeMenu } from "./treemenu.js";

const appWindow = getCurrentWindow();
const APP_NAME = "Mypora";
const MD_FILTER = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];
const RECENT_MAX = 10;
const AUTOSAVE_DELAY = 2000; // 停止输入多久后自动保存（毫秒）

// ---------- 设置（保存在本地，下次启动恢复） ----------

const SETTINGS_KEY = "mdeditor.settings";
const settings = {
  sidebarVisible: true, // 左侧侧边栏是否显示
  sideTab: "outline", // 侧边栏当前标签：files | outline
  rootDir: null, // 文件树的根目录
  autoSave: true, // 是否自动保存
  recent: [], // 最近打开的文件路径，最新的在前
};

try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
} catch {
  /* 读取失败就用默认值 */
}
// 兼容旧版本的设置项
if ("outlineVisible" in settings) {
  settings.sidebarVisible = settings.outlineVisible;
  delete settings.outlineVisible;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 写入失败不影响使用 */
  }
}

// ---------- 状态 ----------

let vditor = null;
let currentPath = null; // 当前文件路径，null 表示未保存的新文档
let savedContent = ""; // 上次保存/打开时的内容，用来判断是否有修改
let mode = "ir"; // ir = 即时渲染（类 Typora），source = 源码模式（纯文本 + 对比预览）
let fileText = null; // 文件在磁盘上的原始文本（打开或保存时记下），进源码模式时显示原文
let autoSaveTimer = null;
let fileStat = null; // 上次打开/保存时文件的修改时间和大小，用来发现外部修改
let writing = false; // 正在写文件，这期间不检查外部修改

// ---------- 编辑器 ----------

function dirOf(path) {
  const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return i >= 0 ? path.slice(0, i) : path;
}

function baseName(path) {
  return path.split(/[\\/]/).pop();
}

// 每次打开文件都重建编辑器：图片相对路径的基准目录（linkBase）需要跟着文件变
function createEditor(content) {
  clearTimeout(autoSaveTimer);
  return new Promise((resolve) => {
    if (vditor) vditor.destroy();
    document.getElementById("outline-pane").replaceChildren();
    vditor = new Vditor("editor", {
      mode: "ir",
      height: "100%",
      cdn: "/vditor", // 使用本地资源，离线可用
      lang: "zh_CN",
      cache: { enable: false },
      toolbarConfig: { hide: true },
      theme: "classic",
      placeholder: "",
      // 大纲由 Vditor 生成，生成后搬到我们自己的侧边栏里显示。
      // position 设为 right，避免 Vditor 按左侧大纲宽度去偏移输入提示框的位置
      outline: { enable: false, position: "right" },
      // 粘贴图片：存到文档旁边的 assets 文件夹（见 images.js）
      upload: { handler: (files) => images.saveFiles(files) },
      preview: {
        theme: { current: "light" },
        hljs: { style: "github", lineNumber: true },
        markdown: {
          // 让 ![](img/a.png) 这类相对路径按 md 文件所在目录解析
          linkBase: currentPath ? convertFileSrc(dirOf(currentPath)) + "/" : "",
        },
      },
      input: () => {
        updateTitle();
        updateWordCount();
        highlightOutline();
        scheduleAutoSave();
        findTool?.refresh();
      },
      after: () => {
        vditor.setValue(content, true);
        savedContent = vditor.getValue(); // 以编辑器规范化后的内容为准
        updateTitle();
        updateWordCount();
        document.getElementById("outline-pane").replaceChildren(vditor.vditor.outline.element);
        vditor.vditor.outline.render(vditor.vditor);
        highlightOutline();
        vditor.focus();
        findTool?.refresh();
        resolve();
      },
    });
  });
}

// 当前编辑中的内容：源码模式取文本框，否则取 Vditor
function getContent() {
  if (mode === "source") return source.getValue();
  return vditor ? vditor.getValue() : "";
}

function isDirty() {
  return getContent() !== savedContent;
}

// 打开、新建、另存为之后载入内容
async function loadContent(text) {
  if (mode === "source") {
    setSource(text);
    savedContent = text;
    updateTitle();
    updateWordCount();
  } else {
    await createEditor(text);
  }
}

// ---------- 源码模式 ----------
// 不用 Vditor 自带的源码模式：它把内容转成源码视图时会丢字（比如表格里的 `</>`）。
// 这里用 CodeMirror 直接编辑原始文本（带行号），保存时一个字符都不会被改动。

const sourceWrap = document.getElementById("source-wrap");
const cursorPos = document.getElementById("cursor-pos");
const source = createSourceMode({
  parent: document.getElementById("source"),
  previewEl: document.getElementById("source-preview"),
  previewBody: document.getElementById("source-preview-body"),
  outlinePane: document.getElementById("outline-pane"),
  getLinkBase: () => (currentPath ? convertFileSrc(dirOf(currentPath)) + "/" : ""),
  isActive: () => mode === "source",
  onChange: () => {
    updateTitle();
    updateWordCount();
    scheduleAutoSave();
  },
  onCursor: (line, col) => {
    cursorPos.textContent = `行 ${line}，列 ${col}`;
  },
});

function setSource(text) {
  source.setValue(text);
}

function applyMode() {
  const source = mode === "source";
  document.getElementById("editor").hidden = source;
  sourceWrap.hidden = !source;
  document.getElementById("btn-mode").classList.toggle("active", source);
  cursorPos.hidden = !source;
}

function updateTitle() {
  const name = currentPath ? baseName(currentPath) : "未命名";
  const mark = isDirty() ? "● " : "";
  document.getElementById("filename").textContent = mark + (currentPath || "未命名");
  appWindow.setTitle(`${mark}${name} - ${APP_NAME}`);
}

// ---------- 侧边栏 ----------

const sidebar = document.getElementById("sidebar");

function applySidebar() {
  sidebar.hidden = !settings.sidebarVisible;
  document.getElementById("btn-sidebar").classList.toggle("collapsed", !settings.sidebarVisible);
  for (const btn of document.querySelectorAll("#side-tabs button")) {
    btn.classList.toggle("active", btn.dataset.tab === settings.sideTab);
  }
  document.getElementById("files-pane").hidden = settings.sideTab !== "files";
  document.getElementById("outline-pane").hidden = settings.sideTab !== "outline";
}

function toggleSidebar() {
  settings.sidebarVisible = !settings.sidebarVisible;
  saveSettings();
  applySidebar();
  highlightOutline();
  highlightTree();
}

document.getElementById("side-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("button")?.dataset.tab;
  if (!tab || tab === settings.sideTab) return;
  settings.sideTab = tab;
  saveSettings();
  applySidebar();
  highlightOutline();
  highlightTree();
});

// 高亮当前阅读位置对应的大纲项（像 Typora 一样）
function highlightOutline() {
  if (!vditor || mode !== "ir" || !settings.sidebarVisible || settings.sideTab !== "outline") return;
  const content = vditor.vditor[vditor.vditor.currentMode].element;
  const outline = vditor.vditor.outline.element;
  const top = content.getBoundingClientRect().top + 20;
  let activeId = null;
  for (const h of content.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")) {
    // 还没滚过第一个标题时，也高亮第一个标题
    if (activeId && h.getBoundingClientRect().top > top) break;
    activeId = h.id;
  }
  outline.querySelectorAll(".outline-active").forEach((el) => el.classList.remove("outline-active"));
  if (!activeId) return;
  const item = outline.querySelector(`[data-target-id="${CSS.escape(activeId)}"]`);
  if (item) {
    item.classList.add("outline-active");
    item.scrollIntoView({ block: "nearest" });
  }
}

let scrollTick = false;
document.getElementById("editor").addEventListener(
  "scroll",
  () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      highlightOutline();
    });
  },
  true, // scroll 事件不冒泡，用捕获阶段监听编辑区内部的滚动
);

// ---------- 代码块：点哪里光标就落在哪里 ----------
// Vditor 点击代码块时总把光标放到代码开头。这里在按下鼠标时记下点中的是第几个字符，
// 等 Vditor 处理完点击（展开代码块）后，再把光标移到原文里同样的位置。

const DIAGRAM_LANGS = /language-(mermaid|flowchart|echarts|mindmap|plantuml|graphviz|abc|markmap|smiles)/;
let pendingCaret = null;

// 文本节点遍历，跳过行号等不属于代码的内容
function codeTextNodes(code) {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement.closest(".vditor-linenumber__rows, .vditor-linenumber__temp")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  for (let n; (n = walker.nextNode()); ) nodes.push(n);
  return nodes;
}

document.getElementById("editor").addEventListener(
  "mousedown",
  (e) => {
    pendingCaret = null;
    const preview = e.target.closest?.(".vditor-ir__preview");
    const node = preview?.closest('[data-type="code-block"]');
    const code = preview?.querySelector("code");
    if (!node || !code || DIAGRAM_LANGS.test(code.className)) return;
    const hit = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!hit || !code.contains(hit.startContainer)) return;
    let offset = 0;
    for (const n of codeTextNodes(code)) {
      if (n === hit.startContainer) {
        offset += hit.startOffset;
        pendingCaret = { node, offset };
        return;
      }
      offset += n.length;
    }
  },
  true,
);

document.getElementById("editor").addEventListener("click", () => {
  if (!pendingCaret) return;
  const { node, offset } = pendingCaret;
  pendingCaret = null;
  const raw = node.isConnected && node.querySelector(".vditor-ir__marker--pre code");
  if (!raw) return;
  let left = offset;
  for (const n of codeTextNodes(raw)) {
    if (left <= n.length) {
      const range = document.createRange();
      range.setStart(n, left);
      range.collapse(true);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    left -= n.length;
  }
});

// ---------- 标题保持静态（不展开 ##），Ctrl+0~6 设置标题级别 ----------

initHeadingTweaks({ getVditor: () => (mode === "ir" ? vditor : null) });

// ---------- 渲染模式的查找替换（Ctrl+F / Ctrl+H） ----------

const findTool = initFind({
  getVditor: () => (mode === "ir" ? vditor : null),
  onChange: () => {
    updateTitle();
    updateWordCount();
    scheduleAutoSave();
    vditor.vditor.outline.render(vditor.vditor);
    highlightOutline();
  },
});

// ---------- “/” 快捷插入菜单（/dmk 代码块、/bg 表格 ……） ----------

initSlashMenu({ getVditor: () => (mode === "ir" ? vditor : null) });

// ---------- 表格工具栏 ----------

initTableTools({
  getVditor: () => (mode === "ir" ? vditor : null),
  // 表格被修改后：更新标题栏、字数、大纲，并安排自动保存
  onChange: () => {
    updateTitle();
    updateWordCount();
    scheduleAutoSave();
    vditor.vditor.outline.render(vditor.vditor);
    highlightOutline();
  },
});

// ---------- 文件树 ----------

const tree = document.getElementById("tree");
const expanded = new Set(); // 已展开的文件夹（小写路径）

const norm = (p) => p.toLowerCase();
const isUnder = (path, dir) => norm(path).startsWith(norm(dir).replace(/[\\/]$/, "") + "\\");

// 设置文件树根目录，并开始监听这个目录的变化
async function setRoot(dir) {
  settings.rootDir = dir;
  saveSettings();
  expanded.clear();
  try {
    await invoke("watch_dir", { path: dir });
  } catch (e) {
    console.warn("监听文件夹失败", e);
  }
  await renderTree();
}

// 打开文件后：文件不在当前根目录里就把根目录换成它所在的文件夹，否则展开到这个文件
async function revealInTree(path) {
  if (!settings.rootDir || !isUnder(path, settings.rootDir)) {
    await setRoot(dirOf(path));
    return;
  }
  let dir = dirOf(path);
  while (isUnder(dir, settings.rootDir)) {
    expanded.add(norm(dir));
    dir = dirOf(dir);
  }
  await renderTree();
}

// 图标（仿 Typora）：实心文件夹、带折角的文档、实心小三角
const TREE_ICONS = {
  folder:
    '<svg viewBox="0 0 16 16"><path d="M1.5 3.2c0-.4.3-.7.7-.7h3.9l1.6 1.6h6.1c.4 0 .7.3.7.7v8c0 .4-.3.7-.7.7H2.2c-.4 0-.7-.3-.7-.7z"/></svg>',
  file:
    '<svg viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3 M5.5 7.5h5 M5.5 9.5h5 M5.5 11.5h3.5"/></svg>',
  openFolder:
    '<svg viewBox="0 0 16 16"><path d="M1.5 4c0-.3.2-.5.5-.5h3.6l1.4 1.4h5.5c.3 0 .5.2.5.5V7 M1.5 4v8.5h10.8l2.2-5.5H4.2l-2.2 5.5"/></svg>',
};

let renderSeq = 0;
async function renderTree() {
  const seq = ++renderSeq;
  const root = settings.rootDir;
  if (!root) {
    const hint = emptyHint("还没有打开文件夹");
    const btn = document.createElement("button");
    btn.className = "tree-open-btn";
    btn.textContent = "打开文件夹";
    hint.append(document.createElement("br"), btn);
    tree.replaceChildren(hint);
    return;
  }
  const frag = document.createDocumentFragment();
  // 根文件夹自己作为第一行，右边有“打开文件夹”按钮（鼠标移上去才显示）
  const rootRow = makeRow({ name: baseName(root) || root, path: root, is_dir: true, expandable: true }, 0);
  rootRow.classList.add("tree-root", "open");
  const openBtn = document.createElement("button");
  openBtn.className = "tree-open-folder";
  openBtn.title = "打开其他文件夹";
  openBtn.innerHTML = TREE_ICONS.openFolder;
  rootRow.append(openBtn);
  frag.append(rootRow);
  await buildLevel(root, 1, frag);
  if (seq !== renderSeq) return; // 期间又触发了刷新，丢弃这次结果
  if (frag.childNodes.length === 1) frag.append(emptyHint("这个文件夹里没有 Markdown 文件"));
  const scroll = tree.scrollTop;
  tree.replaceChildren(frag);
  tree.scrollTop = scroll;
  highlightTree();
}

function emptyHint(text) {
  const div = document.createElement("div");
  div.className = "tree-empty";
  div.textContent = text;
  return div;
}

// 一行：[小三角][图标] 名称。每深一层缩进 14px
function makeRow(entry, depth) {
  const row = document.createElement("div");
  row.className = entry.is_dir ? "tree-item tree-dir" : "tree-item tree-file";
  if (entry.is_dir && !entry.expandable) row.classList.add("empty");
  row.dataset.path = entry.path;
  row.title = entry.path;
  row.style.paddingLeft = `${4 + depth * 14}px`;
  const arrow = document.createElement("span");
  arrow.className = "tree-arrow";
  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.innerHTML = entry.is_dir ? TREE_ICONS.folder : TREE_ICONS.file;
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = entry.name;
  row.append(arrow, icon, name);
  return row;
}

async function buildLevel(dir, depth, parent) {
  let entries;
  try {
    entries = await invoke("list_dir", { path: dir });
  } catch {
    return;
  }
  for (const entry of entries) {
    const row = makeRow(entry, depth);
    parent.append(row);
    if (entry.is_dir && entry.expandable && expanded.has(norm(entry.path))) {
      row.classList.add("open");
      await buildLevel(entry.path, depth + 1, parent);
    }
  }
}

function highlightTree() {
  const cur = currentPath && norm(currentPath);
  for (const row of tree.querySelectorAll(".tree-file")) {
    const active = norm(row.dataset.path) === cur;
    row.classList.toggle("active", active);
    if (active && !sidebar.hidden && settings.sideTab === "files") row.scrollIntoView({ block: "nearest" });
  }
}

async function chooseFolder() {
  const dir = await open({ directory: true, multiple: false, defaultPath: settings.rootDir || undefined });
  if (dir) await setRoot(dir);
}

tree.addEventListener("click", async (e) => {
  if (e.target.closest(".tree-open-folder, .tree-open-btn")) {
    await chooseFolder();
    return;
  }
  const row = e.target.closest(".tree-item");
  if (!row) return;
  const path = row.dataset.path;
  if (row.classList.contains("tree-dir")) {
    // 根文件夹不折叠；没有 md 的文件夹没有可展开的内容
    if (row.classList.contains("tree-root") || row.classList.contains("empty")) return;
    const key = norm(path);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    await renderTree();
    return;
  }
  if (currentPath && norm(path) === norm(currentPath)) return;
  if (await leaveCurrent()) await openPath(path);
});

// 文件夹里有文件新增、删除、重命名时刷新（合并短时间内的多次变化）
let fsTimer = null;
listen("fs-changed", () => {
  clearTimeout(fsTimer);
  fsTimer = setTimeout(renderTree, 300);
});

// ---------- 字数统计 ----------
// 和 Typora 一样：中日韩文字每个字算一个词，英文、数字按单词算

let countTimer = null;
function updateWordCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    if (!vditor) return;
    const text = getContent();
    const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0;
    const latin = text.match(/[A-Za-z0-9\u00c0-\u024f]+(?:['’.-][A-Za-z0-9\u00c0-\u024f]+)*/g)?.length ?? 0;
    document.getElementById("word-count").textContent = `${cjk + latin} 词`;
  }, 200);
}

// ---------- 自动保存 ----------

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  // 新建、还没保存过的文档没有路径，不自动保存
  if (!settings.autoSave || !currentPath) return;
  autoSaveTimer = setTimeout(() => {
    if (isDirty()) writeTo(currentPath, { silent: true });
  }, AUTOSAVE_DELAY);
}

function toggleAutoSave() {
  settings.autoSave = !settings.autoSave;
  saveSettings();
  renderAutoSaveButton();
  if (settings.autoSave) scheduleAutoSave();
  else clearTimeout(autoSaveTimer);
}

function renderAutoSaveButton() {
  const btn = document.querySelector('[data-act="autoSave"]');
  btn.textContent = settings.autoSave ? "自动保存：开" : "自动保存：关";
  btn.classList.toggle("off", !settings.autoSave);
}

// ---------- 最近打开 ----------

function addRecent(path) {
  settings.recent = [path, ...settings.recent.filter((p) => p !== path)].slice(0, RECENT_MAX);
  saveSettings();
}

function removeRecent(path) {
  settings.recent = settings.recent.filter((p) => p !== path);
  saveSettings();
}

const recentMenu = document.getElementById("recent-menu");

async function toggleRecent() {
  if (!recentMenu.hidden) {
    recentMenu.hidden = true;
    return;
  }
  // 先清掉已经不存在的文件
  const exists = await Promise.all(settings.recent.map((path) => invoke("file_exists", { path })));
  settings.recent = settings.recent.filter((_, i) => exists[i]);
  saveSettings();

  recentMenu.replaceChildren();
  if (settings.recent.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-empty";
    empty.textContent = "没有最近打开的文件";
    recentMenu.append(empty);
  } else {
    for (const path of settings.recent) {
      const item = document.createElement("button");
      item.className = "menu-item";
      item.dataset.path = path;
      item.title = path;
      const name = document.createElement("span");
      name.className = "menu-name";
      name.textContent = baseName(path);
      const dir = document.createElement("span");
      dir.className = "menu-dir";
      dir.textContent = dirOf(path);
      item.append(name, dir);
      recentMenu.append(item);
    }
    const clear = document.createElement("button");
    clear.className = "menu-item menu-clear";
    clear.dataset.clear = "1";
    clear.textContent = "清空记录";
    recentMenu.append(clear);
  }
  const btn = document.querySelector('[data-act="recent"]').getBoundingClientRect();
  recentMenu.style.left = `${btn.left}px`;
  recentMenu.style.top = `${btn.bottom + 2}px`;
  recentMenu.hidden = false;
}

recentMenu.addEventListener("click", async (e) => {
  const item = e.target.closest(".menu-item");
  if (!item) return;
  recentMenu.hidden = true;
  if (item.dataset.clear) {
    settings.recent = [];
    saveSettings();
    return;
  }
  const path = item.dataset.path;
  if (path === currentPath) return;
  if (await leaveCurrent()) await openPath(path);
});

// 点菜单外面或按 Esc 关闭菜单
document.addEventListener("mousedown", (e) => {
  if (!recentMenu.hidden && !recentMenu.contains(e.target) && !e.target.closest('[data-act="recent"]')) {
    recentMenu.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") recentMenu.hidden = true;
});

// ---------- 文件操作 ----------

// 离开当前文档（打开别的、新建、关闭窗口）前调用，返回 true 表示可以离开
async function leaveCurrent() {
  if (!isDirty()) return true;
  // 开着自动保存、文件也有路径：直接保存，不再询问
  if (settings.autoSave && currentPath) return writeTo(currentPath);
  return ask("当前文档有未保存的修改，确定要放弃吗？", {
    title: APP_NAME,
    kind: "warning",
    okLabel: "放弃修改",
    cancelLabel: "取消",
  });
}

async function openPath(path) {
  try {
    const text = await invoke("read_file", { path });
    currentPath = path;
    fileText = text;
    fileStat = await invoke("file_stat", { path });
    addRecent(path);
    history.snapshot(path, text, true);
    await loadContent(text);
    revealInTree(path);
  } catch (e) {
    removeRecent(path);
    alert(`打开失败：${e}`);
  }
}

// “新建”：另开一个窗口（空白文档），当前窗口不受影响
async function newWindow() {
  try {
    const sf = await appWindow.scaleFactor();
    const pos = (await appWindow.outerPosition()).toLogical(sf);
    const size = (await appWindow.innerSize()).toLogical(sf);
    const win = new WebviewWindow(`w-${Date.now()}`, {
      url: "index.html?blank=1",
      title: APP_NAME,
      x: pos.x + 30,
      y: pos.y + 30,
      width: size.width,
      height: size.height,
      minWidth: 480,
      minHeight: 320,
      theme: "light",
      dragDropEnabled: true,
    });
    win.once("tauri://error", (e) => toast(`打开新窗口失败：${e.payload}`));
  } catch (e) {
    toast(`打开新窗口失败：${e}`);
  }
}

async function newFile() {
  if (!(await leaveCurrent())) return;
  currentPath = null;
  fileText = null;
  fileStat = null;
  await loadContent("");
}

async function openFile() {
  if (!(await leaveCurrent())) return;
  const path = await open({ multiple: false, directory: false, filters: MD_FILTER });
  if (path) await openPath(path);
}

async function saveAs() {
  const path = await save({
    filters: MD_FILTER,
    defaultPath: currentPath || "未命名.md",
  });
  if (!path) return false;
  const reload = path !== currentPath; // 换了目录，图片相对路径基准要更新
  if (!(await writeTo(path))) return false;
  addRecent(path);
  if (reload) await loadContent(getContent());
  revealInTree(path);
  return true;
}

async function saveFile() {
  if (!currentPath) return saveAs();
  return writeTo(currentPath);
}

async function writeTo(path, { silent = false } = {}) {
  clearTimeout(autoSaveTimer);
  // 写之前先看文件是不是被别的程序改过，免得悄悄覆盖掉别人的修改
  if (path === currentPath && fileStat) {
    // 正在问用户用哪个版本：先别写，稍后再试
    if (checkingExternal) {
      if (silent) scheduleAutoSave();
      return false;
    }
    const changed = (st) => st && (st.mtime !== fileStat.mtime || st.size !== fileStat.size);
    if (changed(await invoke("file_stat", { path }))) {
      await checkExternal();
      if (!isDirty()) return true; // 选了“载入外部版本”，不用再写
      // 冲突还没解决（比如检查被跳过了），绝不覆盖
      if (changed(await invoke("file_stat", { path }))) {
        if (silent) scheduleAutoSave();
        return false;
      }
    }
  }
  const content = getContent();
  writing = true;
  try {
    await invoke("write_file", { path, content });
    currentPath = path;
    fileText = content;
    savedContent = content;
    fileStat = await invoke("file_stat", { path });
    updateTitle();
    history.snapshot(path, content, false);
    return true;
  } catch (e) {
    // 自动保存失败只在标题栏保留 ● 标记，不弹窗打断输入
    if (!silent) alert(`保存失败：${e}`);
    return false;
  } finally {
    writing = false;
  }
}

// ---------- 外部修改检测 ----------
// 文件被别的程序（比如 VS Code）改了：
//   - 这边没有未保存的修改 → 自动重新载入
//   - 这边也改了 → 问用户用哪个版本；没被选中的那个版本存进历史，不会丢

let checkingExternal = false;
async function checkExternal() {
  if (!currentPath || !fileStat || checkingExternal || writing) return;
  checkingExternal = true;
  try {
    const path = currentPath;
    const st = await invoke("file_stat", { path });
    if (!st || (st.mtime === fileStat.mtime && st.size === fileStat.size)) return;
    const text = await invoke("read_file", { path });
    if (text === fileText) {
      fileStat = st; // 只是修改时间变了，内容没变
      return;
    }
    if (!isDirty()) {
      fileText = text;
      fileStat = st;
      await reloadKeepScroll(text);
      history.snapshot(path, text, true);
      toast("文件在外部被修改，已重新载入");
      return;
    }
    // 先把外部版本存进历史，不管用户选哪个都不会丢
    await history.snapshot(path, text, true);
    const useDisk = await ask(`「${baseName(path)}」在外部被修改了，而这里也有还没保存的修改。\n\n要用哪个版本？没选的那个会存进历史版本，不会丢。`, {
      title: "文件在外部被修改",
      kind: "warning",
      okLabel: "用外部的版本",
      cancelLabel: "保留我的修改",
    });
    if (useDisk) await history.snapshot(path, getContent(), true); // 放弃的是自己的修改，也存一份
    fileStat = st;
    fileText = text;
    if (useDisk) {
      await reloadKeepScroll(text);
      toast("已载入外部修改后的版本");
    } else {
      scheduleAutoSave();
    }
  } catch (e) {
    console.warn("检查外部修改失败", e);
  } finally {
    checkingExternal = false;
  }
}

// 重新载入内容，尽量保持滚动位置
async function reloadKeepScroll(text) {
  const scroller = mode === "source" ? source.view.scrollDOM : vditor?.vditor?.ir?.element;
  const top = scroller?.scrollTop || 0;
  await loadContent(text);
  const after = mode === "source" ? source.view.scrollDOM : vditor?.vditor?.ir?.element;
  if (after) after.scrollTop = top;
}

setInterval(checkExternal, 2000);
window.addEventListener("focus", checkExternal);

// ---------- 提示条 ----------

const toastEl = document.createElement("div");
toastEl.id = "toast";
toastEl.hidden = true;
document.body.append(toastEl);
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

// ---------- 图片、历史版本、链接、文件树右键菜单 ----------

const images = initImages({
  getMode: () => mode,
  getVditor: () => vditor,
  getSource: () => source,
  getCurrentPath: () => currentPath,
  // 新建的文档还没保存：先另存为，图片才有地方放
  ensureSaved: async () => {
    toast("请先保存文档，图片会存到文档旁边的 assets 文件夹");
    return (await saveAs()) ? currentPath : null;
  },
  toast,
});

const history = initHistory({
  getPath: () => currentPath,
  getContent,
  getLinkBase: () => (currentPath ? convertFileSrc(dirOf(currentPath)) + "/" : ""),
  // 恢复：把那个版本的原文直接写回文件，再载入
  restore: async (text) => {
    writing = true;
    try {
      await invoke("write_file", { path: currentPath, content: text });
      fileText = text;
      fileStat = await invoke("file_stat", { path: currentPath });
    } finally {
      writing = false;
    }
    await reloadKeepScroll(text);
    history.snapshot(currentPath, text, true);
  },
  toast,
});

// 按标题文字找到标题并滚动过去（链接里的 #标题 用）
function scrollToHeading(anchor) {
  const key = (s) => s.toLowerCase().replace(/[\s\-_]+/g, "");
  const want = key(anchor);
  if (mode === "source") {
    const doc = source.view.state.doc;
    for (let i = 1; i <= doc.lines; i++) {
      const m = doc.line(i).text.match(/^#{1,6}\s+(.*)$/);
      if (m && key(m[1]) === want) {
        source.view.dispatch({ selection: { anchor: doc.line(i).from }, scrollIntoView: true });
        return true;
      }
    }
    return false;
  }
  const heads = vditor?.vditor?.ir?.element.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6") || [];
  for (const h of heads) {
    const text = h.textContent.replace(/\u200b/g, "").replace(/^#{1,6}\s*/, "");
    if (key(text) === want) {
      h.scrollIntoView({ block: "start" });
      return true;
    }
  }
  return false;
}

initLinks({
  getMode: () => mode,
  getCurrentPath: () => currentPath,
  getLinkBase: () => (currentPath ? convertFileSrc(dirOf(currentPath)) + "/" : ""),
  getSourceView: () => source.view,
  openDoc: async (path, anchor) => {
    if (!currentPath || norm(path) !== norm(currentPath)) {
      if (!(await invoke("file_exists", { path }))) {
        toast(`文件不存在：${path}`);
        return;
      }
      if (!(await leaveCurrent())) return;
      await openPath(path);
    }
    if (anchor) setTimeout(() => scrollToHeading(anchor), 300);
  },
  scrollToHeading,
  toast,
});

initTreeMenu({
  tree,
  icons: TREE_ICONS,
  renderTree,
  expandDir: async (dir) => {
    if (norm(dir) !== norm(settings.rootDir)) expanded.add(norm(dir));
    await renderTree();
  },
  openPath: async (path) => {
    if (await leaveCurrent()) await openPath(path);
  },
  // 重命名了当前文件、或者当前文件所在的文件夹：跟着更新路径
  onPathMoved: (from, to) => {
    const move = (p) => (norm(p) === norm(from) || isUnder(p, from) ? to + p.slice(from.length) : p);
    settings.recent = settings.recent.map(move);
    saveSettings();
    if (currentPath) {
      const moved = move(currentPath);
      if (moved !== currentPath) {
        currentPath = moved;
        invoke("file_stat", { path: currentPath }).then((st) => (fileStat = st));
        updateTitle();
      }
    }
  },
  // 删除了当前文件：内容还留在编辑器里，变成未保存的新文档，可以另存为
  onPathDeleted: (path) => {
    removeRecent(path);
    if (currentPath && (norm(currentPath) === norm(path) || isUnder(currentPath, path))) {
      currentPath = null;
      fileText = null;
      fileStat = null;
      savedContent = "";
      updateTitle();
      toast("当前文档已删除，内容还在编辑器里，需要的话可以另存为");
    }
  },
  chooseFolder,
  toast,
});

async function toggleMode() {
  const wasDirty = isDirty();
  const saved = savedContent;
  // 没改过就用磁盘上的原文，源码模式里看到的就是文件的真实内容
  const content = !wasDirty && fileText !== null ? fileText : getContent();
  if (findTool.isOpen()) findTool.close();
  mode = mode === "ir" ? "source" : "ir";
  applyMode();
  if (mode === "source") {
    setSource(content);
    savedContent = wasDirty ? saved : content;
    source.focusStart();
  } else {
    await createEditor(content);
    // 切模式不能改变“是否已修改”的状态：没改过就以切换后的内容为基准，
    // 否则只是切一下模式，自动保存就会把整理过格式的内容写回文件
    savedContent = wasDirty ? saved : vditor.getValue();
  }
  updateTitle();
  updateWordCount();
  scheduleAutoSave();
}

// ---------- 事件绑定 ----------

const actions = {
  new: newWindow,
  open: openFile,
  save: saveFile,
  saveAs,
  mode: toggleMode,
  sidebar: toggleSidebar,
  recent: toggleRecent,
  autoSave: toggleAutoSave,
  history: () => history.open(),
  // 渲染模式用自己的查找框；源码模式交给 CodeMirror
  find: () => (mode === "ir" ? findTool.open(false) : source.openSearch()),
  replace: () => (mode === "ir" ? findTool.open(true) : source.openSearch(true)),
};

for (const el of [document.getElementById("bar"), document.getElementById("status")]) {
  el.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act) actions[act]();
  });
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!e.ctrlKey) return;
    const k = e.key.toLowerCase();
    let act = null;
    if (k === "s") act = e.shiftKey ? "saveAs" : "save";
    else if (k === "o") act = "open";
    else if (k === "n") act = "new";
    else if (k === "/") act = "mode";
    else if (k === "f" && !e.shiftKey) act = "find";
    else if (k === "h" && !e.shiftKey) act = "replace";
    else if (k === "l" && e.shiftKey) act = "sidebar";
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      actions[act]();
    }
  },
  true,
);

// 拖入文件：.md 打开；图片复制到 assets 并插到松开鼠标的位置
getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== "drop") return;
  const paths = event.payload.paths;
  const md = paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
  if (md) {
    if (await leaveCurrent()) await openPath(md);
    return;
  }
  const imgs = paths.filter((p) => IMAGE_EXT.test(p));
  if (imgs.length) await images.insertPaths(imgs, event.payload.position);
});

// 程序已经开着时再双击 .md 文件，路径由后端转发过来
listen("open-file", async (event) => {
  const path = event.payload;
  if (path === currentPath) return;
  if (await leaveCurrent()) await openPath(path);
});

// 关闭窗口前：自动保存开着就直接保存，否则提示
appWindow.onCloseRequested(async (event) => {
  if (!(await leaveCurrent())) event.preventDefault();
});

// ---------- 启动 ----------
renderAutoSaveButton();
applySidebar();
// 恢复上次的文件树根目录（目录被删了就清掉）
if (settings.rootDir && (await invoke("dir_exists", { path: settings.rootDir }))) {
  await setRoot(settings.rootDir);
} else {
  settings.rootDir = null;
  renderTree();
}
// 双击 .md 文件启动时，路径通过命令行参数传进来。
// “新建”开出来的窗口（地址带 ?blank=1）是空白文档，不读命令行参数
const isBlankWindow = new URLSearchParams(location.search).has("blank");
const initial = isBlankWindow ? null : await invoke("initial_file");
if (initial) await openPath(initial);
else await createEditor("");

