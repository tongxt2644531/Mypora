// “/” 快捷插入菜单（类似飞书）：在空白行开头输入 / 弹出菜单，接着输入的字用来筛选：
//   /dmk、/代码块、/daimakuai、/code  → 代码块
//   /bg、/表格、/biaoge、/table      → 表格
// ↑↓ 选择，回车 / Tab 确认，Esc 关闭（关闭后这个 / 就当普通字符留着）。
//
// 插入做法：用 Vditor 内置的 Lute 把 Markdown 模板转成编辑器里的结构，替换掉打着 “/xxx”
// 的那一段，再触发一次输入事件，让 Vditor 完成代码高亮、撤销记录、自动保存等后续处理。

const COMMANDS = [
  { name: "一级标题", keys: ["yjbt", "yijibiaoti", "h1", "heading"], hint: "#", md: "# 标题", select: "标题" },
  { name: "二级标题", keys: ["ejbt", "erjibiaoti", "h2"], hint: "##", md: "## 标题", select: "标题" },
  { name: "三级标题", keys: ["sjbt", "sanjibiaoti", "h3"], hint: "###", md: "### 标题", select: "标题" },
  { name: "四级标题", keys: ["sjbt", "sijibiaoti", "h4"], hint: "####", md: "#### 标题", select: "标题" },
  { name: "代码块", keys: ["dmk", "daimakuai", "code"], hint: "```", md: "```\n\n```", caret: "code" },
  { name: "表格", keys: ["bg", "biaoge", "table"], hint: "3×3", md: "| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |", caret: "table", select: "列1" },
  { name: "无序列表", keys: ["wxlb", "wuxuliebiao", "ul", "list"], hint: "-", md: "- 列表项", select: "列表项" },
  { name: "有序列表", keys: ["yxlb", "youxuliebiao", "ol"], hint: "1.", md: "1. 列表项", select: "列表项" },
  { name: "任务列表", keys: ["rwlb", "renwuliebiao", "todo", "task"], hint: "- [ ]", md: "- [ ] 待办事项", select: "待办事项" },
  { name: "引用", keys: ["yy", "yinyong", "quote"], hint: ">", md: "> 引用内容", select: "引用内容" },
  // 用 *** 而不是 ---：单独转换 --- 时会被当成文档开头的 YAML 文件头
  { name: "分割线", keys: ["fgx", "fengexian", "hr", "line"], hint: "---", md: "***", caret: "after" },
  { name: "数学公式", keys: ["sxgs", "shuxuegongshi", "gs", "math"], hint: "$$", md: "$$\n\n$$", caret: "code" },
  { name: "流程图", keys: ["lct", "liuchengtu", "mermaid", "flow"], hint: "mermaid", md: "```mermaid\ngraph TD\n    A[开始] --> B[结束]\n```", caret: "code" },
  { name: "链接", keys: ["lj", "lianjie", "link"], hint: "[]()", inline: "[链接文字](https://)" },
  { name: "图片", keys: ["tp", "tupian", "image", "img"], hint: "![]()", inline: "![图片描述](图片路径)" },
];

function match(cmd, q) {
  if (!q) return 1;
  q = q.toLowerCase();
  if (cmd.keys.some((k) => k === q)) return 4; // 完全等于缩写
  if (cmd.name.startsWith(q)) return 3;
  if (cmd.keys.some((k) => k.startsWith(q))) return 2;
  if (cmd.name.includes(q)) return 1;
  return 0;
}

export function initSlashMenu({ getVditor }) {
  const menu = document.createElement("div");
  menu.id = "slash-menu";
  menu.hidden = true;
  document.body.append(menu);

  let items = []; // 当前显示的命令
  let active = 0;
  let block = null; // 打着 “/xxx” 的那一段
  let dismissed = null; // 按 Esc 关掉时的 “段落 + 文字”，文字没变就不再弹出

  const root = () => getVditor()?.vditor?.ir?.element;

  function topBlock(node) {
    const r = root();
    let el = node?.nodeType === 3 ? node.parentElement : node;
    while (el && el.parentElement !== r) el = el.parentElement;
    return el;
  }

  // 光标所在段落是不是只有 “/xxx”，且光标在末尾
  function currentQuery() {
    const sel = getSelection();
    const r = root();
    if (!r || !sel.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!r.contains(range.startContainer)) return null;
    const b = topBlock(range.startContainer);
    if (!b || b.tagName !== "P") return null;
    const text = b.textContent.replace(/​/g, "");
    const m = text.match(/^\/([^\s/]{0,20})$/);
    if (!m) return null;
    const after = document.createRange();
    after.selectNodeContents(b);
    after.setStart(range.startContainer, range.startOffset);
    if (after.toString().replace(/​/g, "") !== "") return null;
    return { block: b, query: m[1], text, rect: range.getBoundingClientRect() };
  }

  function update() {
    const q = currentQuery();
    if (!q || (dismissed && dismissed.block === q.block && dismissed.text === q.text)) {
      hide();
      return;
    }
    dismissed = null;
    block = q.block;
    items = COMMANDS.map((c) => [c, match(c, q.query)])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c);
    if (!items.length) {
      hide();
      return;
    }
    active = 0;
    render();
    place(q.rect);
  }

  function render() {
    menu.replaceChildren(
      ...items.map((c, i) => {
        const el = document.createElement("div");
        el.className = "slash-item" + (i === active ? " active" : "");
        el.dataset.i = i;
        const name = document.createElement("span");
        name.className = "slash-name";
        name.textContent = c.name;
        const hint = document.createElement("span");
        hint.className = "slash-hint";
        hint.textContent = c.hint;
        el.append(name, hint);
        return el;
      }),
    );
    menu.hidden = false;
    menu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  function place(rect) {
    // 光标在空段落开头时拿不到位置，就用段落的位置
    if (!rect || (rect.top === 0 && rect.left === 0)) rect = block.getBoundingClientRect();
    const h = menu.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
    menu.style.left = `${Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${top}px`;
  }

  function hide() {
    menu.hidden = true;
    block = null;
  }

  function setCaret(node, toEnd) {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.collapse(!toEnd);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // 触发 Vditor 的输入处理（重新渲染光标所在块、高亮代码、记录撤销、自动保存）
  function rerender() {
    root().dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
  }

  // 选中新块里的占位文字，直接打字就能替换
  function selectPlaceholder(word) {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const b = topBlock(sel.getRangeAt(0).startContainer);
    if (!b) return;
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode()); ) {
      if (n.parentElement.closest(".vditor-ir__marker")) continue;
      const i = n.data.indexOf(word);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + word.length);
        sel.removeAllRanges();
        sel.addRange(r);
        return;
      }
    }
  }

  function apply(cmd) {
    const vditor = getVditor();
    const p = block;
    hide();
    if (!vditor || !p?.isConnected) return;

    // 行内内容（链接、图片）：把这一段的文字换成对应的 Markdown
    if (cmd.inline) {
      p.textContent = cmd.inline;
      setCaret(p, true);
      rerender();
      return;
    }

    // 块内容：用 Lute 把模板转成编辑器结构，替换掉这一段
    const holder = document.createElement("div");
    holder.innerHTML = vditor.vditor.lute.Md2VditorIRDOM(cmd.md);
    const created = [...holder.children];
    if (!created.length) return;
    p.replaceWith(...created);
    const first = created[0];

    if (cmd.caret === "code") {
      setCaret(first.querySelector(".vditor-ir__marker--pre code") || first, false);
    } else if (cmd.caret === "table") {
      setCaret(first.querySelector("th, td") || first, true);
    } else if (cmd.caret === "after") {
      // 分割线后面要有一段可以继续打字
      let next = created[created.length - 1].nextElementSibling;
      if (!next || next.tagName !== "P") {
        next = document.createElement("p");
        next.dataset.block = "0";
        next.textContent = "​";
        created[created.length - 1].after(next);
      }
      setCaret(next, true);
    } else {
      setCaret(first.querySelector("li") || first.querySelector("p") || first, true);
    }
    rerender();
    if (cmd.select) selectPlaceholder(cmd.select);
  }

  // ---- 事件 ----

  const editor = document.getElementById("editor");
  editor.addEventListener("input", () => setTimeout(update, 0));
  editor.addEventListener("compositionend", () => setTimeout(update, 0));
  document.addEventListener("selectionchange", () => {
    if (!menu.hidden) update();
  });
  editor.addEventListener("scroll", hide, true);

  // 菜单打开时，接管 ↑ ↓ 回车 Tab Esc（在 Vditor 之前处理）
  editor.addEventListener(
    "keydown",
    (e) => {
      if (menu.hidden || e.isComposing) return;
      const keys = { ArrowDown: 1, ArrowUp: -1 };
      if (e.key in keys) {
        active = (active + keys[e.key] + items.length) % items.length;
        render();
      } else if (e.key === "Enter" || e.key === "Tab") {
        apply(items[active]);
      } else if (e.key === "Escape") {
        const q = currentQuery();
        dismissed = q && { block: q.block, text: q.text };
        hide();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  menu.addEventListener("mousedown", (e) => e.preventDefault()); // 不抢走编辑器里的光标
  menu.addEventListener("click", (e) => {
    const el = e.target.closest(".slash-item");
    if (el) apply(items[+el.dataset.i]);
  });
  menu.addEventListener("mousemove", (e) => {
    const el = e.target.closest(".slash-item");
    if (el && +el.dataset.i !== active) {
      active = +el.dataset.i;
      for (const x of menu.children) x.classList.toggle("active", x === el);
    }
  });

  return { hide };
}
