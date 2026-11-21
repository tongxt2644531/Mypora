// 表格工具栏（仿 Typora）：光标在表格里时，在表格上方显示
//   左边：调整行列数、当前列左对齐 / 居中 / 右对齐
//   右边：更多（插入 / 删除行列）、删除表格
//
// 做法：所有操作都直接改 Markdown 文本 —— 找到光标所在的是第几个表格，在 Markdown 里
// 改好这张表，再让编辑器重新渲染，最后把光标放回对应的单元格。不去动 Vditor 内部的 DOM。

const ICONS = {
  size: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="0.5"/><rect x="9" y="2" width="5" height="5" rx="0.5"/><rect x="2" y="9" width="5" height="5" rx="0.5"/><rect x="9" y="9" width="5" height="5" rx="0.5"/></svg>',
  left: '<svg viewBox="0 0 16 16"><path d="M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8"/></svg>',
  center: '<svg viewBox="0 0 16 16"><path d="M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="8" cy="12.5" r="1.1"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9M7 7v4.5M9 7v4.5"/></svg>',
};

// ---------- Markdown 表格的解析和生成 ----------

const DELIM_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// 按没有转义的 | 拆分一行
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

function parseAlign(cell) {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

// 找出 Markdown 里所有顶层表格（跳过代码块里的内容），返回行号范围和内容
function findTables(md) {
  const lines = md.split("\n");
  const tables = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (line.startsWith("|") && i + 1 < lines.length && DELIM_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const start = i;
      const rows = [splitRow(line)];
      const aligns = splitRow(lines[i + 1]).map(parseAlign);
      let j = i + 2;
      while (j < lines.length && lines[j].startsWith("|")) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      const cols = Math.max(aligns.length, ...rows.map((r) => r.length));
      for (const r of rows) while (r.length < cols) r.push("");
      while (aligns.length < cols) aligns.push(null);
      tables.push({ start, end: j, rows, aligns });
      i = j - 1;
    }
  }
  return { lines, tables };
}

function serializeTable(t) {
  const row = (cells) => "| " + cells.map((c) => c || " ").join(" | ") + " |";
  const delim = t.aligns.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"));
  return [row(t.rows[0]), "| " + delim.join(" | ") + " |", ...t.rows.slice(1).map(row)];
}

// ---------- 工具栏 ----------

export function initTableTools({ getVditor, onChange }) {
  const bar = document.createElement("div");
  bar.id = "table-tools";
  bar.hidden = true;
  bar.innerHTML = `
    <div class="tt-group">
      <button data-tt="size" title="调整表格大小">${ICONS.size}</button>
      <button data-tt="left" title="当前列左对齐">${ICONS.left}</button>
      <button data-tt="center" title="当前列居中">${ICONS.center}</button>
      <button data-tt="right" title="当前列右对齐">${ICONS.right}</button>
    </div>
    <div class="tt-group">
      <button data-tt="more" title="更多操作">${ICONS.more}</button>
      <button data-tt="delete" title="删除表格">${ICONS.trash}</button>
    </div>`;
  document.body.append(bar);

  const menu = document.createElement("div");
  menu.id = "table-menu";
  menu.className = "tt-pop";
  menu.hidden = true;
  menu.innerHTML = `
    <button data-op="rowAbove">在上方插入行</button>
    <button data-op="rowBelow">在下方插入行</button>
    <button data-op="colLeft">在左侧插入列</button>
    <button data-op="colRight">在右侧插入列</button>
    <hr>
    <button data-op="delRow">删除当前行</button>
    <button data-op="delCol">删除当前列</button>`;
  document.body.append(menu);

  const sizePop = document.createElement("div");
  sizePop.id = "table-size";
  sizePop.className = "tt-pop";
  sizePop.hidden = true;
  sizePop.innerHTML = `
    <div class="tt-title">调整表格大小</div>
    <label>列数 <input type="number" min="1" max="30" data-k="cols"></label>
    <label>行数 <input type="number" min="1" max="200" data-k="rows"></label>
    <div class="tt-hint">行数含表头</div>
    <div class="tt-actions"><button data-k="cancel">取消</button><button data-k="ok" class="primary">确定</button></div>`;
  document.body.append(sizePop);

  // 当前光标所在的表格和单元格
  let cur = null; // { table, row, col }

  const irRoot = () => getVditor()?.vditor?.ir?.element;
  const scroller = () => irRoot();

  function locate() {
    const root = irRoot();
    const sel = getSelection();
    if (!root || !sel.rangeCount) return null;
    let node = sel.anchorNode;
    if (node && node.nodeType === 3) node = node.parentElement;
    const cell = node?.closest?.("td, th");
    const table = cell?.closest("table");
    if (!table || table.parentElement !== root) return null; // 只处理顶层表格
    const tr = cell.parentElement;
    return { table, row: [...table.rows].indexOf(tr), col: cell.cellIndex };
  }

  function position() {
    if (!cur || !cur.table.isConnected) {
      hide();
      return;
    }
    const r = cur.table.getBoundingClientRect();
    const box = scroller().getBoundingClientRect();
    const top = r.top - 24;
    if (top < box.top || r.top > box.bottom) {
      bar.style.visibility = "hidden";
    } else {
      bar.style.visibility = "";
    }
    bar.style.left = `${r.left}px`;
    bar.style.top = `${top}px`;
    bar.style.width = `${r.width}px`;
  }

  function refresh() {
    const loc = locate();
    if (!loc) {
      if (menu.hidden && sizePop.hidden) hide();
      return;
    }
    cur = loc;
    bar.hidden = false;
    position();
    // 高亮当前列的对齐方式
    const cell = cur.table.rows[cur.row]?.cells[cur.col];
    const align = cell?.getAttribute("align") || cell?.style.textAlign || "";
    for (const a of ["left", "center", "right"]) {
      bar.querySelector(`[data-tt="${a}"]`).classList.toggle("active", align === a);
    }
  }

  function hide() {
    bar.hidden = true;
    menu.hidden = true;
    sizePop.hidden = true;
    cur = null;
  }

  // 改 Markdown 里光标所在的那张表；fn 修改表格内容，返回操作后光标要去的 {row, col}，
  // 返回 "deleted" 表示整张表删掉了
  function edit(fn) {
    const vditor = getVditor();
    const root = irRoot();
    if (!vditor || !cur || !root) return;
    const index = [...root.querySelectorAll(":scope > table")].indexOf(cur.table);
    const { lines, tables } = findTables(vditor.getValue());
    const t = tables[index];
    if (index < 0 || !t) return;
    const target = fn(t, cur.row, cur.col);
    if (!target) return;
    const replacement = target === "deleted" ? [] : serializeTable(t);
    const md = [...lines.slice(0, t.start), ...replacement, ...lines.slice(t.end)].join("\n");

    const scroll = root.scrollTop;
    vditor.setValue(md);
    const newRoot = irRoot();
    newRoot.scrollTop = scroll;
    menu.hidden = true;
    sizePop.hidden = true;

    if (target === "deleted") {
      hide();
    } else {
      const table = newRoot.querySelectorAll(":scope > table")[index];
      const cell = table?.rows[Math.min(target.row, table.rows.length - 1)]?.cells[target.col];
      if (cell) {
        newRoot.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      refresh();
    }
    onChange();
  }

  const ops = {
    left: () => edit((t, r, c) => ((t.aligns[c] = "left"), { row: r, col: c })),
    center: () => edit((t, r, c) => ((t.aligns[c] = "center"), { row: r, col: c })),
    right: () => edit((t, r, c) => ((t.aligns[c] = "right"), { row: r, col: c })),
    delete: () => edit(() => "deleted"),
    // 表头上方不能再插行，就插到表头下方
    rowAbove: () =>
      edit((t, r, c) => {
        const at = Math.max(r, 1);
        t.rows.splice(at, 0, t.aligns.map(() => ""));
        return { row: at, col: c };
      }),
    rowBelow: () =>
      edit((t, r, c) => {
        t.rows.splice(r + 1, 0, t.aligns.map(() => ""));
        return { row: r + 1, col: c };
      }),
    colLeft: () =>
      edit((t, r, c) => {
        t.rows.forEach((row) => row.splice(c, 0, ""));
        t.aligns.splice(c, 0, null);
        return { row: r, col: c };
      }),
    colRight: () =>
      edit((t, r, c) => {
        t.rows.forEach((row) => row.splice(c + 1, 0, ""));
        t.aligns.splice(c + 1, 0, null);
        return { row: r, col: c + 1 };
      }),
    // 表头不能删（Markdown 表格必须有表头）；只剩一列时删列等于删表
    delRow: () =>
      edit((t, r, c) => {
        if (r === 0) return null;
        t.rows.splice(r, 1);
        return { row: Math.min(r, t.rows.length - 1), col: c };
      }),
    delCol: () =>
      edit((t, r, c) => {
        if (t.aligns.length <= 1) return "deleted";
        t.rows.forEach((row) => row.splice(c, 1));
        t.aligns.splice(c, 1);
        return { row: r, col: Math.min(c, t.aligns.length - 1) };
      }),
  };

  function resize(cols, rows) {
    edit((t, r, c) => {
      cols = Math.max(1, Math.min(30, cols | 0));
      rows = Math.max(1, Math.min(200, rows | 0));
      for (const row of t.rows) {
        row.length = Math.min(row.length, cols);
        while (row.length < cols) row.push("");
      }
      t.aligns.length = Math.min(t.aligns.length, cols);
      while (t.aligns.length < cols) t.aligns.push(null);
      t.rows.length = Math.min(t.rows.length, rows);
      while (t.rows.length < rows) t.rows.push(Array(cols).fill(""));
      return { row: Math.min(r, rows - 1), col: Math.min(c, cols - 1) };
    });
  }

  // 弹出菜单：默认在按钮下方；下方放不下就放到上方，左右不超出窗口
  function openPop(pop, anchor, alignRight) {
    const r = anchor.getBoundingClientRect();
    pop.hidden = false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = alignRight ? r.right - w : r.left;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  // 工具栏上的按钮不能抢走编辑器里的光标
  for (const el of [bar, menu]) el.addEventListener("mousedown", (e) => e.preventDefault());

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !cur) return;
    const k = btn.dataset.tt;
    if (k === "more") {
      sizePop.hidden = true;
      if (menu.hidden) openPop(menu, btn, true);
      else menu.hidden = true;
      // 表头行不能删、不能在上方插入
      menu.querySelector('[data-op="delRow"]').disabled = cur.row === 0;
    } else if (k === "size") {
      menu.hidden = true;
      if (!sizePop.hidden) {
        sizePop.hidden = true;
        return;
      }
      sizePop.querySelector('[data-k="cols"]').value = cur.table.rows[0].cells.length;
      sizePop.querySelector('[data-k="rows"]').value = cur.table.rows.length;
      openPop(sizePop, btn, false);
      sizePop.querySelector('[data-k="cols"]').select();
    } else {
      ops[k]?.();
    }
  });

  menu.addEventListener("click", (e) => {
    const op = e.target.closest("button")?.dataset.op;
    if (op) ops[op]();
  });

  sizePop.addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.k;
    if (k === "cancel") sizePop.hidden = true;
    if (k === "ok") applySize();
  });
  sizePop.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySize();
    if (e.key === "Escape") sizePop.hidden = true;
  });
  function applySize() {
    const cols = +sizePop.querySelector('[data-k="cols"]').value;
    const rows = +sizePop.querySelector('[data-k="rows"]').value;
    if (cols > 0 && rows > 0) resize(cols, rows);
  }

  // 点到别处时收起菜单
  document.addEventListener("mousedown", (e) => {
    if (!menu.contains(e.target) && !bar.contains(e.target)) menu.hidden = true;
    if (!sizePop.contains(e.target) && !bar.contains(e.target)) sizePop.hidden = true;
  });

  document.addEventListener("selectionchange", () => {
    // 正在调整大小的输入框里打字时，不要因为选区变化把工具栏收起
    if (sizePop.contains(document.activeElement)) return;
    refresh();
  });
  document.getElementById("editor").addEventListener("scroll", () => cur && position(), true);
  window.addEventListener("resize", () => cur && position());

  return { hide, refresh };
}
