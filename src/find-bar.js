import { findTextMatches } from "./find.js";

export function createFindBar({
  document,
  editor,
  preview = () => null,
  isReading = () => false,
  notify = () => {},
  onUpdate = () => {}
}) {
  const byId = (id) => document.getElementById(id);
  const bar = byId("find-bar");
  const findInput = byId("find-input");
  const findCount = byId("find-count");
  const findPrevBtn = byId("find-prev");
  const findNextBtn = byId("find-next");
  const findCloseBtn = byId("find-close");
  const toggleReplaceBtn = byId("find-toggle-replace");
  const replaceRow = byId("replace-row");
  const replaceInput = byId("replace-input");
  const replaceOneBtn = byId("replace-one-btn");
  const replaceAllBtn = byId("replace-all-btn");
  const caseToggleBtn = byId("find-case-toggle");
  const exactToggleBtn = byId("find-exact-toggle");
  const regexToggleBtn = byId("find-regex-toggle");

  let matches = [];
  let activeIndex = -1;
  let isOpen = false;
  let isReplaceOpen = false;
  let invalidPattern = false;
  let useRegex = false;
  let matchCase = false;
  let exactMatch = false;
  let previewHighlightsRendered = false;

  function options() {
    return { useRegex, matchCase, exactMatch };
  }

  function state() {
    return {
      query: findInput.value,
      matches,
      activeIndex,
      invalidPattern,
      options: options(),
      open: isOpen,
      replaceOpen: isReplaceOpen
    };
  }

  function attach() {
    findInput.addEventListener("input", () => run());
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) {
          prev();
        } else {
          next();
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    findPrevBtn.addEventListener("click", prev);
    findNextBtn.addEventListener("click", next);
    findCloseBtn.addEventListener("click", close);
    toggleReplaceBtn.addEventListener("click", () => toggleReplace());
    caseToggleBtn.addEventListener("click", toggleMatchCase);
    exactToggleBtn.addEventListener("click", toggleExactMatch);
    regexToggleBtn.addEventListener("click", toggleRegex);

    replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        replaceOne();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    replaceOneBtn.addEventListener("click", replaceOne);
    replaceAllBtn.addEventListener("click", replaceAll);
  }

  function open({ replace = false } = {}) {
    isOpen = true;
    bar.style.display = "flex";

    if (replace) {
      toggleReplace(true);
    }

    const { start, end } = editor().getSelection();
    const selection = editor().getText().slice(start, end);
    if (selection) {
      findInput.value = selection;
    }

    if (replace && isReplaceOpen) {
      replaceInput.focus();
      replaceInput.select();
    } else {
      findInput.focus();
      findInput.select();
    }
    run();
  }

  function close() {
    isOpen = false;
    bar.style.display = "none";
    matches = [];
    activeIndex = -1;
    invalidPattern = false;
    findInput.value = "";
    replaceInput.value = "";
    toggleReplace(false);
    updateCount();
    refreshHighlights();
    onUpdate(state());
    editor().focus();
  }

  function toggleReplace(force) {
    isReplaceOpen = typeof force === "boolean" ? force : !isReplaceOpen;
    replaceRow.style.display = isReplaceOpen ? "flex" : "none";
    toggleReplaceBtn.classList.toggle("expanded", isReplaceOpen);
    toggleReplaceBtn.setAttribute("aria-expanded", String(isReplaceOpen));
    if (isReplaceOpen) {
      replaceInput.focus();
    }
  }

  function toggleRegex() {
    useRegex = !useRegex;
    regexToggleBtn.classList.toggle("active", useRegex);
    regexToggleBtn.setAttribute("aria-pressed", String(useRegex));
    run();
  }

  function toggleMatchCase() {
    matchCase = !matchCase;
    caseToggleBtn.classList.toggle("active", matchCase);
    caseToggleBtn.setAttribute("aria-pressed", String(matchCase));
    run();
  }

  function toggleExactMatch() {
    exactMatch = !exactMatch;
    exactToggleBtn.classList.toggle("active", exactMatch);
    exactToggleBtn.setAttribute("aria-pressed", String(exactMatch));
    run();
  }

  function run({ preserveActive = false, selectActive = true } = {}) {
    const query = findInput.value;
    const previousActiveIndex = activeIndex;
    findInput.classList.remove("invalid-regex");

    const result = findTextMatches(editor().getText(), query, options());
    matches = result.matches;
    invalidPattern = result.invalidPattern;

    if (invalidPattern) {
      activeIndex = -1;
      findInput.classList.add("invalid-regex");
      updateCount("Invalid");
      refreshHighlights();
      onUpdate(state());
      return;
    }

    if (matches.length > 0) {
      activeIndex = preserveActive && previousActiveIndex >= 0
        ? Math.min(previousActiveIndex, matches.length - 1)
        : 0;

      if (selectActive) {
        // Keeps focus in the search input.
        select(activeIndex);
        return;
      }
    } else {
      activeIndex = -1;
    }
    updateCount();
    refreshHighlights();
    onUpdate(state());
  }

  function select(index, { focusEditor = false } = {}) {
    if (index < 0 || index >= matches.length) return;
    activeIndex = index;
    const match = matches[index];

    if (focusEditor && !isReading()) {
      editor().focus();
    }
    editor().setSelection(match.start, match.end, { scroll: false });

    updateCount();
    refreshHighlights();
    scrollActiveMatchIntoView(match);
    onUpdate(state(), { selected: true });
  }

  function scrollActiveMatchIntoView(match) {
    editor().scrollToRange(match.start, match.end);

    if (isReading()) {
      const previewHighlight = preview()?.querySelector("mark.active-match");
      previewHighlight?.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
  }

  function next() {
    if (matches.length === 0) return;
    select((activeIndex + 1) % matches.length);
  }

  function prev() {
    if (matches.length === 0) return;
    select((activeIndex - 1 + matches.length) % matches.length);
  }

  function replaceOne() {
    if (matches.length === 0 || activeIndex < 0) return;
    const match = matches[activeIndex];
    const replaceText = replaceInput.value;
    const text = editor().getText();

    let replacement = replaceText;
    if (useRegex) {
      try {
        const regex = new RegExp(findInput.value, matchCase ? "" : "i");
        replacement = match.text.replace(regex, replaceText);
      } catch (e) {}
    }

    const newContent = text.substring(0, match.start) + replacement + text.substring(match.end);
    const targetIndex = activeIndex;
    const selectionAfterReplacement = match.start + replacement.length;
    editor().applyEdit({
      value: newContent,
      selectionStart: selectionAfterReplacement,
      selectionEnd: selectionAfterReplacement
    });

    // The page re-runs the search from the edit's input event.
    // Keep advancing from the match the user just replaced.
    if (matches.length > 0) {
      select(Math.min(targetIndex, matches.length - 1));
    }
  }

  function replaceAll() {
    if (matches.length === 0) return;
    const query = findInput.value;
    const replaceText = replaceInput.value;
    const text = editor().getText();
    const totalMatches = matches.length;

    let newContent = text;
    let replacementRegex = null;
    if (useRegex) {
      try {
        replacementRegex = new RegExp(query, matchCase ? "" : "i");
      } catch (e) {
        return;
      }
    }

    for (let index = matches.length - 1; index >= 0; index -= 1) {
      const match = matches[index];
      const replacement = replacementRegex
        ? match.text.replace(replacementRegex, replaceText)
        : replaceText;
      newContent = newContent.substring(0, match.start) +
        replacement +
        newContent.substring(match.end);
    }

    editor().applyEdit({
      value: newContent,
      selectionStart: newContent.length,
      selectionEnd: newContent.length
    });

    notify(`Replaced ${totalMatches} occurrences`);
    if (matches.length > 0) {
      select(0);
    }
  }

  function updateCount(customText) {
    if (customText) {
      findCount.textContent = customText;
    } else if (matches.length === 0) {
      findCount.textContent = "0 of 0";
    } else {
      findCount.textContent = `${activeIndex + 1} of ${matches.length}`;
    }
  }

  function clearPreviewHighlights() {
    if (!previewHighlightsRendered) return;
    const root = preview();
    if (root) {
      root.querySelectorAll("mark.find-preview-match").forEach((highlight) => {
        highlight.replaceWith(document.createTextNode(highlight.textContent));
      });
      root.normalize();
    }
    previewHighlightsRendered = false;
  }

  function updatePreviewHighlights() {
    clearPreviewHighlights();

    const root = preview();
    if (
      !root ||
      !isReading() ||
      !isOpen ||
      !findInput.value ||
      invalidPattern ||
      matches.length === 0
    ) {
      return;
    }

    const textNodes = [];
    const walker = document.createTreeWalker(root, document.defaultView.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    let previewMatchIndex = 0;
    textNodes.forEach((textNode) => {
      const nodeMatches = findTextMatches(textNode.nodeValue, findInput.value, options()).matches
        .map((match) => ({ ...match, previewIndex: previewMatchIndex++ }));

      for (let index = nodeMatches.length - 1; index >= 0; index -= 1) {
        const match = nodeMatches[index];
        textNode.splitText(match.end);
        const matchedText = textNode.splitText(match.start);
        const highlight = document.createElement("mark");

        highlight.className = "find-preview-match";
        highlight.dataset.findIndex = String(match.previewIndex);
        highlight.textContent = matchedText.nodeValue;
        if (match.previewIndex === activeIndex) {
          highlight.classList.add("active-match");
        }

        matchedText.replaceWith(highlight);
        previewHighlightsRendered = true;
      }
    });
  }

  function refreshHighlights() {
    updatePreviewHighlights();
    editor().setFindMatches(isOpen && findInput.value ? matches : [], activeIndex);
  }

  function handleKeydown(e) {
    if (!isOpen || !e.altKey || e.metaKey || e.ctrlKey) return false;
    const key = e.key.toLowerCase();
    if (key === "r") toggleRegex();
    else if (key === "c") toggleMatchCase();
    else if (key === "w") toggleExactMatch();
    else return false;
    e.preventDefault();
    return true;
  }

  return {
    attach,
    open,
    close,
    isOpen: () => isOpen,
    toggleReplace,
    run,
    next,
    prev,
    select,
    replaceOne,
    replaceAll,
    refreshHighlights,
    // After the preview re-renders, which drops its highlights.
    refreshPreview: updatePreviewHighlights,
    handleKeydown,
    state
  };
}
