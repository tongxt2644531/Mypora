// 标题保持静态（仿 Typora）：光标进入标题时不展开前面的 ## 标记。
//
// 标记藏起来以后要补上几件事，否则会出怪事：
//   1. 光标不能停在看不见的 ## 里（点击、Home 键都可能把光标放进去，打字就会打进标记里）
//      → 光标一进入标记，就挪到标题文字的开头
//      注意：光标在标题文字的最开头（偏移 0）时，Chrome 会把输入的字插到前面那个元素
//      （也就是隐藏的 ## 标记）末尾，Vditor 重新渲染时会把标记里多出来的字丢掉。
//      所以在标题文字最前面放一个零宽空格，光标停在它后面；保存时零宽空格会被自动去掉
//   2. 在标题文字开头按退格：Vditor 会悄悄删掉隐藏的空格，标题变成显示着 "##标题" 的普通段落
//      → 改成 Typora 的行为：标题变回普通段落
//   3. 在标题文字开头按 ← ：会钻进隐藏的标记里 → 改为跳到上一段的末尾
//   4. 没法再靠输入 # 改标题级别 → 加上 Typora 的快捷键：Ctrl+1~6 设为对应级别标题，Ctrl+0 变回段落
//
// 改标题级别的做法和 Vditor 自己的一样：改掉标题前面的 ## 文字，再触发一次输入事件，
// 让 Vditor 重新渲染这一块。

const HEADINGS = "h1, h2, h3, h4, h5, h6";

export function initHeadingTweaks({ getVditor }) {
  const editor = document.getElementById("editor");
  const irRoot = () => getVditor()?.vditor?.ir?.element;

  function caret() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const root = irRoot();
    if (!root || !root.contains(range.startContainer)) return null;
    return range;
  }

  // 光标所在的顶层块（段落、标题等）
  function topBlock(node) {
    const root = irRoot();
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el && el.parentElement !== root) el = el.parentElement;
    return el;
  }

  const markerOf = (h) => h.querySelector(":scope > .vditor-ir__marker--heading");

  // 标题文字开头的位置：标记后面的文字节点里、零宽空格之后
  function visibleStart(h, marker) {
    let text = marker.nextSibling;
    if (!text || text.nodeType !== 3) {
      text = document.createTextNode("​");
      marker.after(text);
    } else if (!text.data.startsWith("​")) {
      text.insertData(0, "​");
    }
    const r = document.createRange();
    r.setStart(text, 1);
    r.collapse(true);
    return r;
  }

  function isAtVisibleStart(range, marker) {
    const r = document.createRange();
    r.setStartAfter(marker);
    try {
      r.setEnd(range.startContainer, range.startOffset);
    } catch {
      return false;
    }
    return r.toString().replace(/​/g, "") === "";
  }

  // 光标是否在“危险位置”：标记里、标记前，或标题文字的最开头（零宽空格之前）
  function caretNeedsFix(range, h, marker) {
    if (marker.contains(range.startContainer)) return true;
    if (range.startContainer === h) {
      return range.startOffset <= [...h.childNodes].indexOf(marker) + 1;
    }
    const text = marker.nextSibling;
    if (range.startContainer === text && text.nodeType === 3) {
      return range.startOffset === 0;
    }
    return false;
  }

  function setCaret(range) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 让 Vditor 按光标所在的块重新渲染（它会把 "## 文字" 重新识别成标题或段落）
  function rerender() {
    irRoot().dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
  }

  // ---- 1. 光标不能停在看不见的标记里 ----
  document.addEventListener("selectionchange", () => {
    const range = caret();
    if (!range || !range.collapsed) return;
    const h = topBlock(range.startContainer);
    if (!h?.matches(HEADINGS)) return;
    const marker = markerOf(h);
    if (marker && caretNeedsFix(range, h, marker)) setCaret(visibleStart(h, marker));
  });

  // ---- 2、3、4：键盘 ----
  editor.addEventListener(
    "keydown",
    (e) => {
      const range = caret();
      if (!range) return;
      const block = topBlock(range.startContainer);
      if (!block) return;

      // Ctrl+0 ~ Ctrl+6：设置标题级别（Ctrl+0 为普通段落）
      if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[0-6]$/.test(e.key)) {
        const level = +e.key;
        const prefix = level ? "#".repeat(level) + " " : "";
        if (block.matches(HEADINGS)) {
          const marker = markerOf(block);
          if (!marker) return;
          marker.textContent = prefix;
        } else if (block.tagName === "P" && level > 0) {
          block.insertBefore(document.createTextNode(prefix), block.firstChild);
        } else {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        rerender();
        return;
      }

      if (!block.matches(HEADINGS) || !range.collapsed || e.ctrlKey || e.altKey || e.shiftKey) return;
      const marker = markerOf(block);
      if (!marker || !isAtVisibleStart(range, marker)) return;

      // 标题文字开头按退格：标题变回普通段落
      if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        marker.textContent = "";
        rerender();
        return;
      }

      // 标题文字开头按 ←：跳到上一块的末尾
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        const prev = block.previousElementSibling;
        if (!prev) return;
        const r = document.createRange();
        r.selectNodeContents(prev);
        r.collapse(false);
        setCaret(r);
      }
    },
    true,
  );
}
