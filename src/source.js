// 源码模式：左边 CodeMirror 编辑原始 Markdown（行号、当前行高亮、语法着色、Ctrl+F 查找），
// 右边是对比预览。左右按“标题”对齐同步滚动，左侧大纲按源码里的标题生成。
// 保存的永远是左边的原文，一个字符都不会被改动。

import Vditor from "vditor";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

// Markdown 语法着色：标记符号（# * ``` 等）用浅灰，标题深蓝加粗，链接蓝色，代码红色
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, color: "#1f4e8c", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#4183c4" },
  { tag: t.monospace, color: "#c7254e" },
  { tag: t.quote, color: "#777777" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.labelName], color: "#a0a0a0" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "#ffffff", color: "#333333" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei", monospace',
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "25px 0 50vh" },
  ".cm-line": { padding: "0 24px 0 10px" },
  ".cm-gutters": { backgroundColor: "#ffffff", color: "#999999", borderRight: "0.5px solid #dddddd" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 14px", minWidth: "26px" },
  ".cm-activeLine": { backgroundColor: "#f5f7fa" },
  ".cm-activeLineGutter": { backgroundColor: "#f5f7fa", color: "#333333", fontWeight: "bold" },
  ".cm-cursor": { borderLeftColor: "#333333" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#d7e4f2 !important" },
  ".cm-selectionMatch": { backgroundColor: "#eef3f9" },
  ".cm-panels": { backgroundColor: "#f8f8f8", borderColor: "#e7eaed", fontSize: "12px" },
});

// 找出源码里的标题行（跳过代码块里的 #）
function parseHeadings(doc) {
  const out = [];
  let fence = null;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const f = text.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = text.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ line: i, level: m[1].length, text: m[2] || "(空标题)" });
  }
  return out;
}

// 分段线性插值：按锚点把一边的位置换算成另一边的位置
function interpolate(anchors, from, to, value) {
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (value >= a[from] && value <= b[from]) {
      const span = b[from] - a[from];
      return a[to] + (span > 0 ? ((value - a[from]) / span) * (b[to] - a[to]) : 0);
    }
  }
  return anchors[anchors.length - 1][to];
}

export function createSourceMode({ parent, previewEl, previewBody, outlinePane, getLinkBase, isActive, onChange, onCursor }) {
  let headings = [];

  const extensions = [
    // 查找替换框等界面文字的中文翻译
    EditorState.phrases.of({
      Find: "查找",
      Replace: "替换",
      next: "下一个",
      previous: "上一个",
      all: "全部",
      "match case": "区分大小写",
      regexp: "正则",
      "by word": "全词",
      replace: "替换",
      "replace all": "全部替换",
      close: "关闭",
      "current match": "当前匹配",
      "on line": "在第",
      "replaced match on line $": "已替换第 $ 行的匹配",
      "replaced $ matches": "已替换 $ 处",
      "Go to line": "跳转到行",
      go: "跳转",
    }),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    search({ top: true }),
    highlightSelectionMatches(),
    markdown(),
    syntaxHighlighting(mdHighlight),
    EditorView.lineWrapping,
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    theme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        onChange();
        scheduleRefresh();
      }
      if (u.selectionSet || u.docChanged) reportCursor();
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: "", extensions }), parent });

  function reportCursor() {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    onCursor(line.number, pos - line.from + 1);
  }

  // ---------- 预览 ----------

  let previewTimer = null;
  function renderPreview(now = false) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(
      () => {
        Vditor.preview(previewBody, view.state.doc.toString(), {
          cdn: "/vditor",
          lang: "zh_CN",
          mode: "light",
          theme: { current: "light" },
          hljs: { style: "github", lineNumber: true },
          markdown: { linkBase: getLinkBase() },
          // 预览重新渲染后高度会变，按左边当前位置重新对齐
          after: () => syncFromSource(),
        });
      },
      now ? 0 : 250,
    );
  }

  let refreshTimer = null;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      headings = parseHeadings(view.state.doc);
      renderOutline();
    }, 200);
    renderPreview();
  }

  // ---------- 左右同步滚动（以标题为锚点） ----------

  // 左边视口顶部对应的“行号”（带小数，表示在这一行里的位置）
  function sourceTopLine() {
    const sc = view.scrollDOM;
    const docTop = view.documentTop - sc.getBoundingClientRect().top + sc.scrollTop;
    const h = sc.scrollTop - docTop;
    if (h <= 0) return 1;
    const block = view.lineBlockAtHeight(h);
    const line = view.state.doc.lineAt(block.from).number;
    return line + Math.min(1, Math.max(0, (h - block.top) / Math.max(1, block.height)));
  }

  function scrollSourceToLine(value) {
    const sc = view.scrollDOM;
    const doc = view.state.doc;
    const line = Math.min(doc.lines, Math.max(1, Math.floor(value)));
    const block = view.lineBlockAt(doc.line(line).from);
    const docTop = view.documentTop - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = docTop + block.top + (value - line) * block.height;
  }

  // 锚点：文档开头、每个标题、文档结尾。左边是行号，右边是预览里的纵向位置
  function anchors() {
    const base = previewEl.getBoundingClientRect().top - previewEl.scrollTop;
    const heads = [...previewBody.querySelectorAll(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6")];
    const list = [{ line: 1, y: 0 }];
    const n = Math.min(heads.length, headings.length);
    for (let i = 0; i < n; i++) {
      const y = heads[i].getBoundingClientRect().top - base - 20;
      if (y > list[list.length - 1].y) list.push({ line: headings[i].line, y });
    }
    list.push({ line: view.state.doc.lines + 1, y: Math.max(previewEl.scrollHeight - previewEl.clientHeight, list[list.length - 1].y + 1) });
    return list;
  }

  // 程序设置滚动位置时会触发对方的 scroll 事件，短时间内忽略，避免来回拉扯
  let ignoreSourceUntil = 0;
  let ignorePreviewUntil = 0;

  function syncFromSource() {
    if (!isActive()) return;
    ignorePreviewUntil = performance.now() + 120;
    previewEl.scrollTop = interpolate(anchors(), "line", "y", sourceTopLine());
  }

  function syncFromPreview() {
    if (!isActive()) return;
    ignoreSourceUntil = performance.now() + 120;
    scrollSourceToLine(interpolate(anchors(), "y", "line", previewEl.scrollTop));
  }

  view.scrollDOM.addEventListener("scroll", () => {
    highlightOutline();
    if (performance.now() < ignoreSourceUntil) return;
    syncFromSource();
  });
  previewEl.addEventListener("scroll", () => {
    if (performance.now() < ignorePreviewUntil) return;
    syncFromPreview();
  });

  // ---------- 大纲（按源码里的标题） ----------

  function renderOutline() {
    if (!isActive()) return;
    const list = document.createElement("div");
    list.className = "src-outline";
    if (headings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = "没有标题";
      list.append(empty);
    }
    const minLevel = Math.min(...headings.map((h) => h.level));
    for (const h of headings) {
      const item = document.createElement("div");
      item.className = "so-item";
      item.dataset.line = h.line;
      item.style.paddingLeft = `${8 + (h.level - minLevel) * 14}px`;
      item.textContent = h.text;
      item.title = `第 ${h.line} 行`;
      list.append(item);
    }
    outlinePane.replaceChildren(list);
    highlightOutline();
  }

  // 高亮视口顶部所在的章节
  function highlightOutline() {
    if (!isActive()) return;
    const top = sourceTopLine() + 1;
    let current = null;
    for (const h of headings) {
      if (h.line > top) break;
      current = h.line;
    }
    if (current === null && headings.length) current = headings[0].line;
    for (const item of outlinePane.querySelectorAll(".so-item")) {
      const on = +item.dataset.line === current;
      item.classList.toggle("active", on);
      if (on) item.scrollIntoView({ block: "nearest" });
    }
  }

  outlinePane.addEventListener("click", (e) => {
    const item = e.target.closest?.(".so-item");
    if (!item || !isActive()) return;
    const line = view.state.doc.line(+item.dataset.line);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 20 }),
    });
    view.focus();
  });

  return {
    view,
    getValue: () => view.state.doc.toString(),
    // 载入新内容：新的撤销历史，光标和滚动回到开头
    setValue(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
      headings = parseHeadings(view.state.doc);
      renderOutline();
      renderPreview(true);
      reportCursor();
      previewEl.scrollTop = 0;
    },
    // 在光标处插入文字（粘贴图片后插入 ![](...) 用）
    insertText(text) {
      view.dispatch(view.state.replaceSelection(text));
      view.focus();
    },
    // 把光标放到屏幕坐标处（拖入图片时用）
    setCursorAt(x, y) {
      const pos = view.posAtCoords({ x, y });
      if (pos != null) view.dispatch({ selection: { anchor: pos } });
    },
    // 打开查找框；focusReplace 为 true 时光标放到“替换”输入框
    openSearch(focusReplace = false) {
      openSearchPanel(view);
      if (focusReplace) {
        const input = view.dom.querySelector('.cm-search input[name="replace"]');
        input?.focus();
        input?.select();
      }
    },
    focusStart() {
      view.dispatch({ selection: { anchor: 0 } });
      view.scrollDOM.scrollTop = 0;
      view.focus();
    },
  };
}
