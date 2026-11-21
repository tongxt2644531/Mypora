// 渲染模式下的查找替换（Ctrl+F / Ctrl+H），外观和源码模式（CodeMirror）的查找框一致，
// 代替 WebView 自带的浏览器查找栏。
//
// 查找：在看得见的文字里找（跳过隐藏的 ## ** 等标记、行号、公式），用浏览器的
//       CSS 高亮接口标出来，不改动编辑区的内容，不会和 Vditor 打架。
// 替换：单个替换直接改那段文字，再让 Vditor 重新渲染这一块（和自己打字一样）；
//       代码块里的匹配改的是代码原文。全部替换直接在 Markdown 原文上替换，Ctrl+Z 可撤销。

// 这些元素里的文字看不见或不是正文，不参与查找
const SKIP = [
  ".vditor-ir__marker",
  ".vditor-ir__marker--pre",
  ".vditor-ir__marker--info",
  ".vditor-linenumber__rows",
  ".vditor-linenumber__temp",
  ".vditor-copy",
  ".katex",
  "svg",
  "style",
  "script",
].join(", ");

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function initFind({ getVditor, onChange }) {
  const panel = document.createElement("div");
  panel.id = "find-panel";
  panel.className = "cm-search";
  panel.hidden = true;
  panel.innerHTML = `
    <input class="cm-textfield" data-f="query" placeholder="查找" spellcheck="false">
    <button class="cm-button" data-f="next">下一个</button>
    <button class="cm-button" data-f="prev">上一个</button>
    <span class="find-count" data-f="count"></span>
    <br>
    <label><input type="checkbox" data-f="case">区分大小写</label>
    <label><input type="checkbox" data-f="regexp">正则</label>
    <label><input type="checkbox" data-f="word">全词</label>
    <br>
    <input class="cm-textfield" data-f="replace" placeholder="替换" spellcheck="false">
    <button class="cm-button" data-f="replaceOne">替换</button>
    <button class="cm-button" data-f="replaceAll">全部替换</button>
    <button name="close" data-f="close" title="关闭 (Esc)">×</button>`;
  const editorCol = document.getElementById("editor-col");
  editorCol.insertBefore(panel, document.getElementById("editor"));

  const $ = (k) => panel.querySelector(`[data-f="${k}"]`);
  const queryInput = $("query");
  const replaceInput = $("replace");
  const countEl = $("count");

  const root = () => getVditor()?.vditor?.ir?.element;

  let matches = []; // Range[]
  let current = -1;

  // ---------- 查找 ----------

  function buildRegExp() {
    const q = queryInput.value;
    if (!q) return null;
    let src = $("regexp").checked ? q : escapeRegExp(q);
    if ($("word").checked) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    try {
      return new RegExp(src, "gu" + ($("case").checked ? "" : "i"));
    } catch {
      return "invalid";
    }
  }

  // 按顶层块收集看得见的文字，记下每个文字节点在拼接串里的起点，方便把匹配换算回 Range
  function collect() {
    const blocks = [];
    const r = root();
    if (!r) return blocks;
    for (const block of r.children) {
      const nodes = [];
      let text = "";
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n; (n = walker.nextNode()); ) {
        nodes.push({ node: n, start: text.length });
        text += n.data;
      }
      if (text) blocks.push({ block, nodes, text });
    }
    return blocks;
  }

  function locate(nodes, index, isEnd) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      if (index > start || (index === start && !isEnd) || i === 0) {
        return [node, Math.min(index - start, node.data.length)];
      }
    }
    return null;
  }

  function search(keepPosition = false) {
    const re = buildRegExp();
    matches = [];
    if (re && re !== "invalid") {
      for (const { nodes, text } of collect()) {
        re.lastIndex = 0;
        for (let m; (m = re.exec(text)); ) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          const [sn, so] = locate(nodes, m.index, false);
          const [en, eo] = locate(nodes, m.index + m[0].length, true);
          const range = document.createRange();
          range.setStart(sn, so);
          range.setEnd(en, eo);
          matches.push(range);
        }
      }
    }
    if (!keepPosition || current >= matches.length) current = firstVisible();
    paint(re === "invalid");
  }

  // 默认从视口里第一个匹配开始
  function firstVisible() {
    if (!matches.length) return -1;
    const top = root().getBoundingClientRect().top;
    const i = matches.findIndex((m) => m.getBoundingClientRect().bottom >= top);
    return i < 0 ? 0 : i;
  }

  function paint(invalid = false) {
    if (window.CSS?.highlights) {
      CSS.highlights.set("find-all", new Highlight(...matches));
      CSS.highlights.set("find-current", current >= 0 ? new Highlight(matches[current]) : new Highlight());
    }
    countEl.textContent = invalid
      ? "正则有误"
      : !queryInput.value
        ? ""
        : matches.length
          ? `第 ${current + 1} / ${matches.length} 个`
          : "没有找到";
    countEl.classList.toggle("none", !!queryInput.value && !matches.length);
  }

  function reveal() {
    const m = matches[current];
    const sc = root();
    if (!m || !sc) return;
    const r = m.getBoundingClientRect();
    const box = sc.getBoundingClientRect();
    if (r.top < box.top + 30 || r.bottom > box.bottom - 30) {
      sc.scrollTop += r.top - box.top - sc.clientHeight / 3;
    }
  }

  function go(step) {
    if (!matches.length) return;
    current = (current + step + matches.length) % matches.length;
    paint();
    reveal();
  }

  // ---------- 替换 ----------

  // 让 Vditor 按光标所在的块重新渲染
  function rerender(at) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(at);
    root().dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
  }

  // 代码块：预览里的匹配换算到代码原文的同一位置
  function codeTextNodes(code) {
    const nodes = [];
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest(".vditor-linenumber__rows, .vditor-linenumber__temp")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let pos = 0;
    for (let n; (n = walker.nextNode()); ) {
      nodes.push({ node: n, start: pos });
      pos += n.data.length;
    }
    return nodes;
  }

  function offsetIn(nodes, node, offset) {
    const hit = nodes.find((x) => x.node === node);
    return hit ? hit.start + offset : -1;
  }

  function replacementFor(text) {
    const re = buildRegExp();
    const rep = replaceInput.value;
    if (!$("regexp").checked || !re || re === "invalid") return rep;
    re.lastIndex = 0;
    return text.replace(re, rep); // 正则模式支持 $1 这类引用
  }

  function replaceOne() {
    const m = matches[current];
    if (!m) return;
    const r = root();
    const text = m.toString();
    const rep = replacementFor(text);
    let block = m.startContainer.parentElement;
    while (block && block.parentElement !== r) block = block.parentElement;

    let target = m;
    if (block?.dataset.type === "code-block") {
      const preview = block.querySelector(".vditor-ir__preview code");
      const raw = block.querySelector(".vditor-ir__marker--pre code");
      if (!preview || !raw) return;
      const start = offsetIn(codeTextNodes(preview), m.startContainer, m.startOffset);
      const rawNodes = codeTextNodes(raw);
      const [sn, so] = locate(rawNodes, start, false);
      const [en, eo] = locate(rawNodes, start + text.length, true);
      target = document.createRange();
      target.setStart(sn, so);
      target.setEnd(en, eo);
    }
    target.deleteContents();
    const node = document.createTextNode(rep);
    target.insertNode(node);
    const after = document.createRange();
    after.setStartAfter(node);
    after.collapse(true);
    const keep = current;
    rerender(after);
    onChange();
    setTimeout(() => {
      search(true);
      current = Math.min(keep, matches.length - 1);
      paint();
      reveal();
      replaceInput.focus(); // 焦点回到替换框，可以接着按回车替换下一个
    }, 50);
  }

  function replaceAll() {
    const vditor = getVditor();
    const re = buildRegExp();
    if (!vditor || !re || re === "invalid") return;
    const md = vditor.getValue();
    const rep = replaceInput.value;
    const out = $("regexp").checked ? md.replace(re, rep) : md.replace(re, () => rep);
    if (out === md) return;
    const sc = root();
    const scroll = sc.scrollTop;
    vditor.setValue(out);
    root().scrollTop = scroll;
    onChange();
    search();
    replaceInput.focus();
  }

  // ---------- 打开 / 关闭 ----------

  function open(focusReplace = false) {
    panel.hidden = false;
    // 选中了文字就拿来当查找内容
    const sel = getSelection();
    const selected = sel.rangeCount && root()?.contains(sel.anchorNode) ? sel.toString() : "";
    if (selected && !selected.includes("\n")) queryInput.value = selected;
    const input = focusReplace ? replaceInput : queryInput;
    input.focus();
    input.select();
    search();
    reveal();
  }

  function close() {
    panel.hidden = true;
    matches = [];
    current = -1;
    CSS.highlights?.delete("find-all");
    CSS.highlights?.delete("find-current");
    root()?.focus({ preventScroll: true });
  }

  panel.addEventListener("click", (e) => {
    const k = e.target.closest("[data-f]")?.dataset.f;
    if (k === "next") go(1);
    else if (k === "prev") go(-1);
    else if (k === "replaceOne") replaceOne();
    else if (k === "replaceAll") replaceAll();
    else if (k === "close") close();
  });
  panel.addEventListener("change", (e) => {
    if (e.target.type === "checkbox") search();
  });
  queryInput.addEventListener("input", () => {
    search();
    reveal();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.target === replaceInput) replaceOne();
      else go(e.shiftKey ? -1 : 1);
    }
  });

  // 查找框开着时，不管焦点在哪，按 Esc 都关闭
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !panel.hidden) {
        e.preventDefault();
        close();
      }
    },
    true,
  );

  // 文档被编辑后重新查找（保持当前位置）
  let timer = null;
  function refresh() {
    if (panel.hidden) return;
    clearTimeout(timer);
    timer = setTimeout(() => search(true), 200);
  }

  return { open, close, refresh, isOpen: () => !panel.hidden };
}
