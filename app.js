/* Vocab Trainer — a browser-based custom-vocabulary English learning app.
 * No dependencies, no build step. State persists in localStorage.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "vocab-trainer:v1";
  const DAY = 24 * 60 * 60 * 1000;

  /* ---------------------------------------------------------------- state */
  /** @typedef {{id:string, front:string, back:string, example:string, category:string,
   *   reps:number, ease:number, interval:number, due:number, lapses:number,
   *   correct:number, seen:number}} Card */

  /** @type {{cards: Card[]}} */
  let state = load();
  // Ensure newer fields exist for data saved by earlier versions.
  if (!state.settings) state.settings = { voice: "", rate: 0.95 };
  if (typeof state.settings.rate !== "number") state.settings.rate = 0.95;
  if (typeof state.settings.remind !== "boolean") state.settings.remind = false;
  if (typeof state.settings.readRate !== "number") state.settings.readRate = 0.9;
  if (typeof state.settings.readVoice !== "string") state.settings.readVoice = "";
  if (state.settings.theme !== "light" && state.settings.theme !== "dark") {
    state.settings.theme =
      window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  }
  if (!state.history) state.history = {}; // { "YYYY-MM-DD": reviewCount }
  if (typeof state.goal !== "number") state.goal = 20;
  if (state.plan === undefined) state.plan = null; // { scope, perDay, createdOn }
  if (!Array.isArray(state.favReads)) state.favReads = []; // [{exch,doc,text}]
  if (!state.dailyActivity) state.dailyActivity = {}; // { "YYYY-MM-DD": {listen,speak} }
  if (!state.skills) state.skills = {}; // per-skill { n: attempts, ok: correct }
  ["listen", "speak", "read", "write"].forEach((k) => {
    if (!state.skills[k]) state.skills[k] = { n: 0, ok: 0 };
  });
  let selectedCats = new Set(); // empty = all categories

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { cards: [] };
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("save failed", e);
    }
  }

  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* -------------------------------------------------------------- helpers */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  // Render **bold** markers (used in example sentences) as <b>.
  function renderInline(s) {
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  }
  function stripMd(s) {
    return String(s == null ? "" : s)
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Text-to-speech pronunciation via the Web Speech API (no network needed).
  const TTS = window.speechSynthesis;
  let VOICES = [];
  // Prefer a real US English voice so playback sounds American, not British/AU.
  function pickUSVoice() {
    if (!VOICES.length) return "";
    const us = VOICES.filter((v) => /en[-_]US/i.test(v.lang));
    const pool = us.length ? us : VOICES.filter((v) => /^en/i.test(v.lang));
    if (!pool.length) return "";
    const preferred = /Samantha|Alex|Aaron|Nicky|Ava|Allison|Google US English|United States|Zira|David|Aria|Jenny|Guy/i;
    return (pool.find((v) => preferred.test(v.name)) || pool[0]).name;
  }
  // Resolve the utterance voice: honor explicit choice, otherwise fall back to US.
  function resolveVoice(name) {
    const chosen = VOICES.find((x) => x.name === name);
    if (chosen) return chosen;
    const us = pickUSVoice();
    return VOICES.find((x) => x.name === us) || null;
  }
  function refreshVoices() {
    VOICES = TTS ? TTS.getVoices() : [];
    // Default both global and reading voices to American on first run.
    if (VOICES.length) {
      const us = pickUSVoice();
      let changed = false;
      if (!state.settings.voice && us) { state.settings.voice = us; changed = true; }
      if (!state.settings.readVoice && us) { state.settings.readVoice = us; changed = true; }
      if (changed) save();
    }
    populateVoiceSelect();
  }
  function speak(text, rate) {
    if (!TTS || !text) return;
    try {
      TTS.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = "en-US";
      u.rate = rate || state.settings.rate || 0.95;
      const v = resolveVoice(state.settings.voice);
      if (v) u.voice = v;
      TTS.speak(u);
    } catch (_) {}
  }

  /* -------------------------------------------------------------- parsers */
  // Each parser returns [{front, back, example, category}]
  function detectFormat(text) {
    const t = text.trim();
    if (/^\s*\|.*\|/m.test(t) || /^#{1,6}\s/m.test(t)) return "markdown";
    if (/\t/.test(t)) return "tsv";
    if (/^[^\n=]+=[^\n]+/m.test(t) && !/,/.test(t.split("\n")[0])) return "text";
    if (/,/.test(t)) return "csv";
    return "text";
  }

  const FRONT_KW = ["english", "英文", "word", "term", "缩写", "语句", "句式", "句子", "phrase"];
  const BACK_KW = ["中文", "释义", "全称", "meaning", "translation", "含义", "解释", "定义", "definition"];
  const EXAMPLE_KW = ["例句", "example", "sentence", "eg"];
  // Columns that are metadata, not vocabulary content, and must be ignored.
  const IGNORE_KW = ["掌握", "自填", "备注", "status", "状态", "count", "数量", "词条数",
    "模块", "module", "说明", "remark", "level", "note", "progress"];
  const isIndexHeader = (c) => /^(no\.?|#|num\.?|index|序号|编号|序|id)$/i.test(c.trim());

  // Classify header columns into front/back/example plus a set to ignore.
  // `recognized` is true only when a real English or meaning column was found,
  // which lets us skip non-vocabulary tables (e.g. a table of contents).
  function classifyColumns(headerCells) {
    const h = headerCells.map((c) => c.toLowerCase().trim());
    const hit = (cell, kws) => kws.some((k) => cell.includes(k));
    let front = -1, back = -1, example = -1;
    const ignore = new Set();
    h.forEach((c, i) => {
      if (example < 0 && hit(c, EXAMPLE_KW)) { example = i; return; }
      if (front < 0 && hit(c, FRONT_KW)) { front = i; return; }
      if (back < 0 && hit(c, BACK_KW)) { back = i; return; }
      if (isIndexHeader(c) || hit(c, IGNORE_KW)) ignore.add(i);
    });
    const recognized = front >= 0 || back >= 0;
    // Positional fallbacks only fill the gaps, never override recognized cols.
    if (front < 0) front = firstFree([back, example], ignore, headerCells.length);
    if (back < 0) back = firstFree([front, example], ignore, headerCells.length);
    if (example === front || example === back) example = -1;
    return { front, back, example, ignore, recognized };
  }
  function firstFree(taken, ignore, len) {
    for (let i = 0; i < len; i++) {
      if (taken.includes(i) || ignore.has(i)) continue;
      return i;
    }
    return -1;
  }

  function rowToEntry(cells, map, category) {
    const get = (i) => (i >= 0 && i < cells.length ? stripMd(cells[i]) : "");
    const front = get(map.front);
    const example = get(map.example);
    const ignore = map.ignore || new Set();
    // Collect the back from the mapped column plus any leftover (non-ignored)
    // columns, e.g. the abbreviation table's 全称 + 中文, so nothing is lost.
    const backParts = [];
    if (map.back >= 0) backParts.push(get(map.back));
    cells.forEach((c, i) => {
      if (i === map.front || i === map.back || i === map.example || ignore.has(i)) return;
      const v = stripMd(c);
      if (v) backParts.push(v);
    });
    const back = backParts.filter(Boolean).join(" / ");
    if (!front) return null;
    return { front, back, example, category };
  }

  function parseMarkdown(text, defaultCat) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let category = defaultCat || "";
    let map = null;
    for (const line of lines) {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        // Use heading text, dropping trailing "（English）" parenthetical for brevity is optional; keep full.
        category = stripMd(heading[1]).replace(/\s*[（(].*?[)）]\s*$/, "").trim() || category;
        map = null; // new section => new table header expected
        continue;
      }
      if (!/\|/.test(line)) continue;
      // separator row like |---|---|
      if (/^\s*\|?\s*:?-{2,}/.test(line.replace(/\s/g, ""))) continue;
      const cells = line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim());
      if (cells.length < 2) continue;
      if (!map) {
        map = classifyColumns(cells); // first table row = header
        // Skip tables that aren't vocabulary (e.g. a table of contents).
        if (!map.recognized) map = { skip: true };
        continue;
      }
      if (map.skip) continue;
      const entry = rowToEntry(cells, map, category || defaultCat || "未分类");
      if (entry) out.push(entry);
    }
    return out;
  }

  function splitCsvLine(line, delim) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === delim) {
        out.push(cur); cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function parseDelimited(text, delim, defaultCat) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    const rows = lines.map((l) => splitCsvLine(l, delim));
    let start = 0;
    let map;
    const first = rows[0].map((c) => c.toLowerCase());
    const looksHeader = first.some((c) =>
      /english|中文|释义|例句|word|meaning|term|全称|缩写/.test(c)
    );
    if (looksHeader) {
      map = classifyColumns(rows[0]);
      start = 1;
    } else {
      map = { front: 0, back: rows[0].length > 1 ? 1 : -1, example: rows[0].length > 2 ? 2 : -1, ignore: new Set() };
    }
    const out = [];
    for (let i = start; i < rows.length; i++) {
      const entry = rowToEntry(rows[i], map, defaultCat || "未分类");
      if (entry) out.push(entry);
    }
    return out;
  }

  // Plain text: "word = 中文", "word - 中文", "word\t中文", or tab example after.
  function parseText(text, defaultCat) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const out = [];
    for (const line of lines) {
      let m = line.split(/\s*[=\t]\s*|\s+[-–—]\s+/);
      if (m.length < 2) {
        // last resort: split on first run of spaces before CJK
        const idx = line.search(/[\u4e00-\u9fff]/);
        if (idx > 0) m = [line.slice(0, idx), line.slice(idx)];
        else m = [line];
      }
      const front = stripMd((m[0] || "").trim());
      const back = stripMd((m[1] || "").trim());
      const example = stripMd((m[2] || "").trim());
      if (front) out.push({ front, back, example, category: defaultCat || "未分类" });
    }
    return out;
  }

  function parseInput(text, format, defaultCat) {
    const fmt = format === "auto" ? detectFormat(text) : format;
    switch (fmt) {
      case "markdown": return parseMarkdown(text, defaultCat);
      case "csv": return parseDelimited(text, ",", defaultCat);
      case "tsv": return parseDelimited(text, "\t", defaultCat);
      default: return parseText(text, defaultCat);
    }
  }

  /* ------------------------------------------------------------------ SRS */
  // Simplified SM-2. grade: 0 again, 1 hard, 2 good, 3 easy.
  function newCardFields() {
    return { reps: 0, ease: 2.5, interval: 0, due: Date.now(), lapses: 0, correct: 0, seen: 0 };
  }
  function dayKey(d) {
    return (
      d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  function recordReview() {
    const k = dayKey(new Date());
    state.history[k] = (state.history[k] || 0) + 1;
  }
  function todayActivity() {
    const k = dayKey(new Date());
    if (!state.dailyActivity[k]) state.dailyActivity[k] = { listen: 0, speak: 0 };
    return state.dailyActivity[k];
  }
  function bumpDaily(kind) {
    const a = todayActivity();
    a[kind] = (a[kind] || 0) + 1;
    save();
  }
  function recordSkill(skill, grade) {
    if (!skill || !state.skills[skill]) return;
    state.skills[skill].n++;
    if (grade >= 2) state.skills[skill].ok++;
  }
  // Consecutive days (ending today or yesterday) with at least one review.
  function computeStreak() {
    const h = state.history;
    const d = new Date();
    if (!(h[dayKey(d)] > 0)) d.setDate(d.getDate() - 1);
    let streak = 0;
    while (h[dayKey(d)] > 0) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }
  function todayReviews() {
    return state.history[dayKey(new Date())] || 0;
  }

  function schedule(card, grade, skill) {
    card.seen++;
    if (!card.introducedOn) card.introducedOn = dayKey(new Date());
    recordReview();
    recordSkill(skill, grade);
    if (grade === 0) {
      card.reps = 0;
      card.lapses++;
      card.interval = 0;
      card.ease = Math.max(1.3, card.ease - 0.2);
      card.due = Date.now() + 60 * 1000; // ~1 min, stays in session
      return card;
    }
    card.correct++;
    if (grade === 1) card.ease = Math.max(1.3, card.ease - 0.15);
    else if (grade === 3) card.ease += 0.15;
    card.reps++;
    if (card.reps === 1) card.interval = grade === 3 ? 3 : 1;
    else if (card.reps === 2) card.interval = grade === 1 ? 3 : 6;
    else {
      const mult = grade === 1 ? 1.2 : card.ease;
      card.interval = Math.round(card.interval * mult);
    }
    card.due = Date.now() + card.interval * DAY;
    return card;
  }
  function status(card) {
    if (card.reps === 0) return "new";
    if (card.interval >= 7) return "known";
    return "learning";
  }

  /* ------------------------------------------------------------ card sets */
  function categories() {
    const map = new Map();
    for (const c of state.cards) map.set(c.category, (map.get(c.category) || 0) + 1);
    return Array.from(map.entries());
  }
  function activeCards() {
    if (!selectedCats.size) return state.cards;
    return state.cards.filter((c) => selectedCats.has(c.category));
  }
  // Difficulty for the "hardest words" ordering: more lapses / lower ease /
  // lower accuracy => harder => sorts first.
  function difficultyScore(c) {
    const acc = c.seen ? c.correct / c.seen : 1;
    return c.lapses * 100 + (2.5 - (c.ease || 2.5)) * 10 + (1 - acc) * 5;
  }
  function dueCards(cards) {
    const now = Date.now();
    return cards.filter((c) => c.due <= now);
  }

  /* ------------------------------------------------------- daily study plan */
  // Cards within the plan's scope (a category, or all cards).
  function planScopeCards() {
    if (!state.plan) return [];
    const sc = state.plan.scope;
    if (!sc || sc === "__all__") return state.cards;
    return state.cards.filter((c) => c.category === sc);
  }
  // A card counts as "learned/introduced" once it has been studied at least once.
  function isIntroduced(c) { return !!c.introducedOn || c.reps > 0; }
  function introducedTodayCount(cards) {
    const t = dayKey(new Date());
    return cards.filter((c) => c.introducedOn === t).length;
  }
  // Today's new words = fresh cards limited by (perDay - already introduced today).
  function todayNewQueue(cards, perDay) {
    const remaining = Math.max(0, perDay - introducedTodayCount(cards));
    const fresh = cards.filter((c) => !isIntroduced(c));
    return shuffle(fresh).slice(0, remaining);
  }
  // Today's reviews = introduced cards that are due now.
  function todayDueQueue(cards) {
    return dueCards(cards.filter(isIntroduced));
  }

  /* --------------------------------------------------------------- router */
  function showView(name) {
    stopRecog(); // stop any in-progress mic capture when navigating
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    if (name === "home") renderHome();
    if (name === "flashcard") startFlashcards();
    if (name === "quiz") startQuiz();
    if (name === "spell") startSpell();
    if (name === "dict") startDict();
    if (name === "speak") startSpeak();
    if (name === "write") { startWrite(); renderTemplates(); }
    if (name === "browse") renderBrowse();
    if (name === "import") renderSamples();
    if (name === "grammar") renderGrammar();
  }

  document.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) return showView(tab.dataset.view);
    const goto = e.target.closest("[data-goto]");
    if (goto) return showView(goto.dataset.goto);
  });

  /* ----------------------------------------------------------- sidebar UI */
  function renderCategories() {
    const list = $("#catList");
    const cats = categories().sort((a, b) => b[1] - a[1]);
    const total = state.cards.length;
    const allActive = selectedCats.size === 0;
    const items = [
      `<li data-cat="__all__" class="${allActive ? "active" : ""}">
        <div class="cat-main"><span class="cat-name" data-focus="__all__">全部</span></div>
        <span class="badge">${total}</span></li>`,
    ];
    for (const [name, count] of cats) {
      const on = selectedCats.has(name);
      const nm = escapeHtml(name);
      items.push(
        `<li data-cat="${nm}" class="${on ? "active" : ""}">
          <div class="cat-main">
            <input type="checkbox" class="cat-chk" data-cat="${nm}" ${on ? "checked" : ""} />
            <span class="cat-name" data-focus="${nm}" title="${nm}">${nm}</span>
          </div>
          <span class="badge">${count}</span></li>`
      );
    }
    list.innerHTML = items.join("");
  }
  function refreshCurrentView() {
    const current = $(".tab.active")?.dataset.view || "home";
    showView(current === "import" ? "browse" : current);
  }
  $("#catList").addEventListener("click", (e) => {
    const chk = e.target.closest(".cat-chk");
    if (chk) {
      // Toggle a category in/out of the multi-selection.
      if (chk.checked) selectedCats.add(chk.dataset.cat);
      else selectedCats.delete(chk.dataset.cat);
      renderCategories();
      refreshCurrentView();
      return;
    }
    const focus = e.target.closest("[data-focus]");
    if (!focus) return;
    // Clicking a name focuses just that category (or "全部" clears the filter).
    if (focus.dataset.focus === "__all__") selectedCats.clear();
    else selectedCats = new Set([focus.dataset.focus]);
    renderCategories();
    refreshCurrentView();
  });

  /* -------------------------------------------------------------- overview */
  function renderHome() {
    const cards = activeCards();
    const total = cards.length;
    const known = cards.filter((c) => status(c) === "known").length;
    const learning = cards.filter((c) => status(c) === "learning").length;
    const due = dueCards(cards).length;

    $("#statsGrid").innerHTML = `
      <div class="stat accent"><div class="num">${total}</div><div class="lbl">总词条</div></div>
      <div class="stat amber"><div class="num">${due}</div><div class="lbl">待复习</div></div>
      <div class="stat"><div class="num">${learning}</div><div class="lbl">学习中</div></div>
      <div class="stat green"><div class="num">${known}</div><div class="lbl">已掌握</div></div>`;

    const empty = state.cards.length === 0;
    $("#homeEmpty").hidden = !empty;
    $("#homeActions").hidden = empty;
    if (empty) renderSamples();
    $("#goalPanel").hidden = empty;
    $("#chartPanel").hidden = empty;
    $("#skillPanel").hidden = empty;
    $("#dueCount").textContent = `${due} 张待复习`;
    const hard = cards.filter((c) => c.lapses > 0).length;
    $("#hardCount").textContent = hard ? `${hard} 个易错词` : "按易错程度排序";
    renderTodayPlan();
    renderGoal();
    renderChart();
    renderSkills();
    renderMemDist();
    renderHeatmap();
    renderForecast();
    renderBadges();
    renderCategories();
  }

  /* --------------------------------------------------- badges & reminders */
  function renderBadges() {
    const box = $("#badgePanel");
    if (!box) return;
    if (state.cards.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    const streak = computeStreak();
    const learned = state.cards.filter(isIntroduced).length;
    const streakBadges = [
      { d: 3, icon: "🌱", name: "坚持3天" }, { d: 7, icon: "🔥", name: "一周达成" },
      { d: 30, icon: "🏅", name: "满月坚持" }, { d: 100, icon: "💎", name: "百日不辍" },
      { d: 365, icon: "👑", name: "年度学霸" },
    ];
    const wordBadges = [
      { n: 50, icon: "📗", name: "50词" }, { n: 100, icon: "📘", name: "100词" },
      { n: 500, icon: "📚", name: "500词" }, { n: 1000, icon: "🎓", name: "1000词" },
      { n: 2000, icon: "🏆", name: "2000词" },
    ];
    const chip = (earned, icon, name, sub) =>
      `<div class="badge ${earned ? "earned" : "locked"}"><span class="badge-ic">${icon}</span><span class="badge-nm">${name}</span><span class="badge-sub">${sub}</span></div>`;
    const sb = streakBadges.map((b) => chip(streak >= b.d, b.icon, b.name, b.d + "天")).join("");
    const wb = wordBadges.map((b) => chip(learned >= b.n, b.icon, b.name, b.n + "词")).join("");
    const supported = "Notification" in window;
    box.innerHTML = `
      <div class="chart-title">成就徽章</div>
      <div class="badge-sub-title">连续打卡（当前 🔥 ${streak} 天）</div>
      <div class="badge-row">${sb}</div>
      <div class="badge-sub-title">累计学习（已学 ${learned} 词）</div>
      <div class="badge-row">${wb}</div>
      <div class="remind-row">
        <label class="chk"><input type="checkbox" id="remindToggle" ${state.settings.remind ? "checked" : ""} ${supported ? "" : "disabled"} /> 开启复习提醒</label>
        <span class="muted" id="remindMsg"></span>
      </div>`;
    const rt = $("#remindToggle");
    if (rt) rt.onchange = onRemindToggle;
    updateRemindMsg();
  }
  function updateRemindMsg(txt) {
    const el = $("#remindMsg");
    if (!el) return;
    if (txt) { el.textContent = txt; return; }
    if (!("Notification" in window)) { el.textContent = "此设备不支持通知"; return; }
    if (!state.settings.remind) { el.textContent = "关闭中"; return; }
    el.textContent = Notification.permission === "granted"
      ? "已开启：打开 App 时若有待复习会提醒（iOS 需先添加到主屏并授权）"
      : "请在系统允许通知后生效";
  }
  function onRemindToggle(e) {
    const on = e.target.checked;
    if (!on) { state.settings.remind = false; save(); updateRemindMsg(); return; }
    if (!("Notification" in window)) { e.target.checked = false; updateRemindMsg("此设备不支持通知"); return; }
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") { state.settings.remind = true; save(); updateRemindMsg(); maybeNotifyDue(); }
      else { state.settings.remind = false; e.target.checked = false; save(); updateRemindMsg("通知权限被拒绝"); }
    });
  }
  // On app open: if reminders on and there are tasks due, fire one local notice per day.
  function maybeNotifyDue() {
    if (!state.settings.remind) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const due = dueCards(state.cards.filter(isIntroduced)).length;
    const newLeft = state.plan ? todayNewQueue(planScopeCards(), state.plan.perDay).length : 0;
    if (due + newLeft <= 0) return;
    const t = dayKey(new Date());
    if (state.lastNotify === t) return;
    state.lastNotify = t; save();
    try {
      new Notification("英语学习提醒", {
        body: `今天有 ${newLeft} 个新词 + ${due} 个待复习，来打卡吧！`,
        icon: "icons/icon-192.png",
      });
    } catch (_) {}
  }

  // Check-in heatmap: last 12 weeks, colored by daily review count vs goal.
  function renderHeatmap() {
    const box = $("#heatmapPanel");
    if (!box) return;
    if (state.cards.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    const weeks = 12;
    const goal = state.goal || 20;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(today.getDate() - (weeks * 7 - 1));
    start.setDate(start.getDate() - start.getDay()); // back to Sunday
    const level = (n) => (n <= 0 ? 0 : n < goal * 0.25 ? 1 : n < goal * 0.5 ? 2 : n < goal ? 3 : 4);
    const cols = [];
    let col = [];
    const cur = new Date(start);
    while (cur <= today) {
      const key = dayKey(cur);
      const n = state.history[key] || 0;
      col.push(`<span class="hm-cell l${level(n)}" data-d="${key}" data-n="${n}"></span>`);
      if (cur.getDay() === 6) { cols.push(`<div class="hm-col">${col.join("")}</div>`); col = []; }
      cur.setDate(cur.getDate() + 1);
    }
    if (col.length) cols.push(`<div class="hm-col">${col.join("")}</div>`);
    const streak = computeStreak();
    box.innerHTML = `
      <div class="chart-title">打卡日历 · 近 ${weeks} 周（🔥 连续 ${streak} 天）</div>
      <div class="heatmap">${cols.join("")}</div>
      <div class="hm-foot">
        <span class="hm-info muted" id="hmInfo">点击方块看当天练习量</span>
        <span class="hm-legend">少 <i class="hm-cell l0"></i><i class="hm-cell l1"></i><i class="hm-cell l2"></i><i class="hm-cell l3"></i><i class="hm-cell l4"></i> 多</span>
      </div>`;
  }

  // Upcoming reviews: how many introduced cards fall due over the next 7 days.
  function renderForecast() {
    const box = $("#forecastPanel");
    if (!box) return;
    const cards = activeCards().filter(isIntroduced);
    if (state.cards.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    const days = 7;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const buckets = new Array(days).fill(0);
    cards.forEach((c) => {
      const d = new Date(c.due); d.setHours(0, 0, 0, 0);
      const diff = Math.round((d - today) / DAY);
      if (diff <= 0) buckets[0]++;
      else if (diff < days) buckets[diff]++;
    });
    const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const maxN = Math.max(1, ...buckets);
    const bars = buckets
      .map((n, i) => {
        const d = new Date(today); d.setDate(today.getDate() + i);
        const lbl = i === 0 ? "今天" : i === 1 ? "明天" : week[d.getDay()];
        const h = n ? Math.max(Math.round((n / maxN) * 100), 6) : 0;
        return `<div class="fc-col"><div class="fc-n">${n}</div><div class="fc-track"><div class="fc-bar" style="height:${h}%"></div></div><div class="fc-lbl">${lbl}</div></div>`;
      })
      .join("");
    box.innerHTML = `<div class="chart-title">未来 7 天复习预测</div><div class="forecast">${bars}</div>`;
  }
  const heatmapEl = $("#heatmapPanel");
  if (heatmapEl) {
    heatmapEl.addEventListener("click", (e) => {
      const cell = e.target.closest(".hm-cell");
      const info = $("#hmInfo");
      if (cell && info && cell.dataset.d) info.textContent = `${cell.dataset.d} · 练习 ${cell.dataset.n || 0} 次`;
    });
  }

  // Memory-state distribution donut: new / learning / known.
  function renderMemDist() {
    const box = $("#memPanel");
    if (!box) return;
    const cards = activeCards();
    const total = cards.length;
    if (!total) { box.hidden = true; return; }
    box.hidden = false;
    const nw = cards.filter((c) => status(c) === "new").length;
    const lr = cards.filter((c) => status(c) === "learning").length;
    const kn = cards.filter((c) => status(c) === "known").length;
    const pctOf = (x) => (total ? (x / total) * 100 : 0);
    const a = pctOf(nw);
    const b = a + pctOf(lr);
    const knownPct = Math.round(pctOf(kn));
    box.innerHTML = `
      <div class="chart-title">记忆状态分布</div>
      <div class="mem-wrap">
        <div class="donut" style="background: conic-gradient(var(--mem-new) 0 ${a}%, var(--mem-learn) ${a}% ${b}%, var(--mem-known) ${b}% 100%)">
          <div class="donut-hole"><span class="donut-num">${knownPct}%</span><span class="donut-sub">已掌握</span></div>
        </div>
        <ul class="mem-legend">
          <li><i class="dot n"></i>生词 <b>${nw}</b></li>
          <li><i class="dot l"></i>学习中 <b>${lr}</b></li>
          <li><i class="dot k"></i>已掌握 <b>${kn}</b></li>
        </ul>
      </div>`;
  }

  /* --------------------------------------------------- daily plan (home UI) */
  let planEditing = false;
  function planFormHtml() {
    const cats = categories().sort((a, b) => b[1] - a[1]);
    const cur = state.plan || {};
    const perDay = cur.perDay || 10;
    const scope = cur.scope || "__all__";
    const opts = [`<option value="__all__" ${scope === "__all__" ? "selected" : ""}>全部词库</option>`]
      .concat(cats.map(([c, n]) => `<option value="${escapeHtml(c)}" ${scope === c ? "selected" : ""}>${escapeHtml(c)}（${n}）</option>`))
      .join("");
    return `
      <div class="today-head"><span class="today-title">📅 制定学习计划</span></div>
      <div class="plan-form">
        <label class="field"><span>学习范围</span><select id="planScope">${opts}</select></label>
        <label class="field"><span>每日新词</span><input type="number" id="planPerDay" min="1" max="200" value="${perDay}" /></label>
        <label class="field"><span>每日精听(句)</span><input type="number" id="planListen" min="0" max="500" value="${cur.listenGoal != null ? cur.listenGoal : 20}" /></label>
        <label class="field"><span>每日跟读(句)</span><input type="number" id="planSpeak" min="0" max="200" value="${cur.speakGoal != null ? cur.speakGoal : 5}" /></label>
        <button class="btn primary" data-plan-save>${state.plan ? "保存计划" : "开始计划"}</button>
        ${state.plan ? '<button class="btn ghost" data-plan-cancel>取消</button>' : ""}
      </div>
      <p class="muted plan-hint">每天放出固定数量的新词，配合到期复习，形成每日打卡闭环。复习不限量，到期即练。</p>`;
  }
  function renderTodayPlan() {
    const box = $("#todayPanel");
    if (!box) return;
    if (state.cards.length === 0) { box.hidden = true; return; }
    box.hidden = false;
    if (!state.plan || planEditing) { box.innerHTML = planFormHtml(); return; }
    const cards = planScopeCards();
    const perDay = state.plan.perDay;
    const total = cards.length;
    const learned = cards.filter(isIntroduced).length;
    const newQ = todayNewQueue(cards, perDay);
    const dueQ = todayDueQueue(cards);
    const todo = newQ.length + dueQ.length;
    const streak = computeStreak();
    const remaining = Math.max(0, total - learned);
    const eta = perDay > 0 ? Math.ceil(remaining / perDay) : 0;
    const pct = total ? Math.round((learned / total) * 100) : 0;
    const scopeName = !state.plan.scope || state.plan.scope === "__all__" ? "全部词库" : state.plan.scope;
    const act = todayActivity();
    const listenGoal = state.plan.listenGoal != null ? state.plan.listenGoal : 20;
    const speakGoal = (typeof SpeechRec !== "undefined" && SpeechRec) ? (state.plan.speakGoal != null ? state.plan.speakGoal : 5) : 0;
    const listenDone = act.listen || 0, speakDone = act.speak || 0;
    const listenLeft = Math.max(0, listenGoal - listenDone);
    const speakLeft = Math.max(0, speakGoal - speakDone);
    const allDone = todo === 0 && listenLeft === 0 && speakLeft === 0;
    let action;
    if (allDone) {
      action = `<div class="today-done">✅ 今日任务已完成！🔥 连续打卡 ${streak} 天，明天继续～</div>`;
    } else {
      let btns = "";
      if (todo > 0) btns += `<button class="btn primary today-go" data-today-start>背词 / 复习 · ${newQ.length} 新词 + ${dueQ.length} 复习</button>`;
      if (listenLeft > 0 || speakLeft > 0) btns += `<button class="btn today-go" data-goto-read>去精听 / 跟读 · 精听还差 ${listenLeft}${speakGoal ? " · 跟读还差 " + speakLeft : ""}</button>`;
      action = btns;
    }
    box.innerHTML = `
      <div class="today-head">
        <span class="today-title">📅 今日学习 · ${escapeHtml(scopeName)}</span>
        <button class="link-btn" data-plan-edit>调整计划</button>
      </div>
      <div class="today-stats">
        <div class="tstat"><div class="tnum">${newQ.length}</div><div class="tlbl">今日新词</div></div>
        <div class="tstat"><div class="tnum">${dueQ.length}</div><div class="tlbl">待复习</div></div>
        <div class="tstat"><div class="tnum">🔥 ${streak}</div><div class="tlbl">连续天数</div></div>
      </div>
      <div class="today-sub">🎧 精听 ${listenDone}/${listenGoal} 句${speakGoal ? ` · 🗣️ 跟读 ${speakDone}/${speakGoal} 句` : ""}</div>
      ${action}
      <div class="today-progress">
        <div class="tp-bar"><div class="tp-fill" style="width:${pct}%"></div></div>
        <div class="tp-text">已学 ${learned} / ${total}（${pct}%）· 每日 ${perDay} 个 · 预计还需 ${eta} 天学完</div>
        <div class="today-live">📈 今日已学 ${introducedTodayCount(cards)} 个新词 · 今日练习 ${todayReviews()} 次</div>
      </div>`;
  }
  const todayPanelEl = $("#todayPanel");
  if (todayPanelEl) {
    todayPanelEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-plan-save]")) {
        const scope = $("#planScope").value;
        const perDay = Math.max(1, Math.min(200, parseInt($("#planPerDay").value, 10) || 10));
        const listenGoal = Math.max(0, Math.min(500, parseInt($("#planListen").value, 10) || 0));
        const speakGoal = Math.max(0, Math.min(200, parseInt($("#planSpeak").value, 10) || 0));
        state.plan = { scope, perDay, listenGoal, speakGoal, createdOn: dayKey(new Date()) };
        planEditing = false; save(); renderHome();
      } else if (e.target.closest("[data-plan-cancel]")) {
        planEditing = false; renderTodayPlan();
      } else if (e.target.closest("[data-plan-edit]")) {
        planEditing = true; renderTodayPlan();
      } else if (e.target.closest("[data-today-start]")) {
        startTodaySession();
      } else if (e.target.closest("[data-goto-read]")) {
        showView("read");
      }
    });
  }
  // Four-skill dashboard: activity (bar) + accuracy per skill, from state.skills.
  function renderSkills() {
    const defs = [
      { key: "listen", label: "👂 听", name: "听", from: "听写" },
      { key: "speak", label: "🗣️ 说", name: "说", from: "口语" },
      { key: "read", label: "📖 读", name: "读", from: "卡片 / 选择" },
      { key: "write", label: "✍️ 写", name: "写", from: "拼写 / 造句" },
    ];
    const s = state.skills;
    const counts = defs.map((d) => (s[d.key] || { n: 0 }).n);
    const maxN = Math.max(1, ...counts);
    const total = counts.reduce((a, b) => a + b, 0);
    // Least-practiced skill (only highlight once there's some activity).
    let leastKey = null, leastN = Infinity;
    for (const d of defs) {
      const n = (s[d.key] || { n: 0 }).n;
      if (n < leastN) { leastN = n; leastKey = d.key; }
    }
    $("#skillsGrid").innerHTML = defs
      .map((d) => {
        const st = s[d.key] || { n: 0, ok: 0 };
        const acc = st.n ? Math.round((st.ok / st.n) * 100) : 0;
        const w = st.n ? Math.max(Math.round((st.n / maxN) * 100), 4) : 0;
        const least = total > 0 && d.key === leastKey ? " least" : "";
        const meta = st.n
          ? `${st.n} 次 · 正确率 ${acc}%`
          : `<span class="muted">来自「${d.from}」，未练习</span>`;
        return `<div class="skill-row">
          <span class="skill-name">${d.label}</span>
          <div class="skill-track"><div class="skill-fill${least}" style="width:${w}%"></div></div>
          <span class="skill-meta">${meta}</span>
        </div>`;
      })
      .join("");
    const leastName = defs.find((d) => d.key === leastKey).name;
    $("#skillTip").textContent =
      total === 0
        ? "从任意练习开始，这里会按听说读写四个维度显示你的练习量和正确率。"
        : `练得最少的是「${leastName}」，建议今天补一补这一项。`;
  }
  // Bar chart of reviews per day for the last 14 days (from state.history).
  function renderChart() {
    const days = 14;
    const today = new Date();
    const cols = [];
    let max = 1;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const count = state.history[dayKey(d)] || 0;
      max = Math.max(max, count);
      cols.push({ d, count, isToday: i === 0 });
    }
    $("#chart").innerHTML = cols
      .map((c) => {
        const h = c.count ? Math.max(Math.round((c.count / max) * 100), 5) : 2;
        const cls = c.count === 0 ? "zero" : c.isToday ? "today" : "";
        const label = `${c.d.getMonth() + 1}/${c.d.getDate()}`;
        return `<div class="chart-col" title="${label}：${c.count} 次">
          <div class="chart-val">${c.count || ""}</div>
          <div class="chart-bar ${cls}" style="height:${h}%"></div>
          <div class="chart-label">${c.d.getDate()}</div>
        </div>`;
      })
      .join("");
  }
  $("#hardQuick").addEventListener("click", () => {
    $("#fcHard").checked = true;
    $("#fcDueOnly").checked = false;
    showView("flashcard");
  });

  function renderGoal() {
    const streak = computeStreak();
    const done = todayReviews();
    const goal = state.goal;
    $("#goalStreak").textContent = `🔥 ${streak} 天连续`;
    $("#goalInput").value = goal;
    const pct = Math.min(100, Math.round((done / goal) * 100));
    $("#goalFill").style.width = pct + "%";
    $("#goalText").textContent =
      done >= goal
        ? `今天已完成 ${done} 次复习，达成目标 🎉`
        : `今天已复习 ${done} / ${goal} 次，还差 ${goal - done} 次`;
  }
  $("#goalInput").addEventListener("change", (e) => {
    const v = Math.max(1, Math.min(500, Number(e.target.value) || 20));
    state.goal = v;
    save();
    renderGoal();
  });

  /* ------------------------------------------------------------ flashcards */
  let fcQueue = [], fcIndex = 0;
  let pendingTodayQueue = null; // set by the daily plan's "开始今日学习"
  function startFlashcards() {
    if (pendingTodayQueue) {
      fcQueue = pendingTodayQueue;
      pendingTodayQueue = null;
      fcIndex = 0;
      $("#fcDone").hidden = true;
      $("#fcStage").hidden = false;
      renderFlashcard();
      return;
    }
    const dueOnly = $("#fcDueOnly").checked;
    let pool = activeCards();
    if (dueOnly) pool = dueCards(pool);
    fcQueue = $("#fcHard").checked
      ? pool.slice().sort((a, b) => difficultyScore(b) - difficultyScore(a))
      : shuffle(pool);
    fcIndex = 0;
    $("#fcDone").hidden = true;
    $("#fcStage").hidden = false;
    renderFlashcard();
  }
  // Start today's guided session: new words first, then due reviews.
  function startTodaySession() {
    if (!state.plan) return;
    const cards = planScopeCards();
    const q = todayNewQueue(cards, state.plan.perDay).concat(shuffle(todayDueQueue(cards)));
    if (!q.length) { renderHome(); return; }
    pendingTodayQueue = q;
    showView("flashcard");
  }
  function renderFlashcard() {
    const reverse = $("#fcReverse").checked;
    const card = fcQueue[fcIndex];
    const stage = $("#fcStage"), done = $("#fcDone"), controls = $("#fcControls");
    if (!fcQueue.length) {
      stage.hidden = true; controls.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>这个分类下没有卡片</h3><p class="muted">先去导入一些词汇，或取消"只看待复习"。</p>`;
      $("#fcProgress").textContent = "0 / 0";
      return;
    }
    if (fcIndex >= fcQueue.length) {
      stage.hidden = true; controls.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>🎉 本轮完成</h3><p class="muted">复习了 ${fcQueue.length} 张卡片。</p>
        <button class="btn primary" id="fcAgain">再来一轮</button>`;
      $("#fcAgain").onclick = startFlashcards;
      return;
    }
    stage.hidden = false;
    $("#fcProgress").textContent = `${fcIndex + 1} / ${fcQueue.length}`;
    const fc = $("#flashcard");
    fc.classList.remove("flipped");
    controls.hidden = true;
    $("#fcHint").textContent = "点击或按空格翻面";
    const front = reverse ? card.back : card.front;
    const backMain = reverse ? card.front : card.back;
    $("#fcFront").innerHTML = escapeHtml(front);
    const ex = card.example
      ? `<div class="fc-ex">${renderInline(card.example)}</div>` : "";
    $("#fcBack").innerHTML = `<div><div class="fc-cn">${escapeHtml(backMain)}</div>${ex}</div>`;
    if ($("#fcAutoSpeak").checked) speak(card.front);
  }
  function flipCard() {
    const fc = $("#flashcard");
    if ($("#fcStage").hidden) return; // nothing to flip (done/empty state)
    fc.classList.toggle("flipped");
    if (fc.classList.contains("flipped")) {
      $("#fcControls").hidden = false;
      $("#fcHint").textContent = "评估记忆：按 1-4 或点击按钮";
    }
  }
  function gradeCard(grade) {
    const card = fcQueue[fcIndex];
    if (!card) return;
    if (!$("#flashcard").classList.contains("flipped")) return; // must flip first
    schedule(card, grade, "read");
    save();
    if (grade === 0) {
      // requeue near the end so it comes back this session
      fcQueue.push(card);
    }
    fcIndex++;
    renderFlashcard();
  }
  $("#flashcard").addEventListener("click", flipCard);
  $("#fcControls").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-grade]");
    if (!btn) return;
    gradeCard(Number(btn.dataset.grade));
  });
  $("#fcRestart").onclick = startFlashcards;
  $("#fcDueOnly").onchange = startFlashcards;
  $("#fcHard").onchange = startFlashcards;
  $("#fcReverse").onchange = renderFlashcard;
  $("#fcSpeak").addEventListener("click", (e) => {
    e.stopPropagation();
    const card = fcQueue[fcIndex];
    if (card) speak(card.front);
  });

  // --- TTS voice + speed controls (shared by all study modes) ---
  function fillVoiceSelect(sel, current) {
    if (!sel) return;
    const en = VOICES.filter((v) => /^en/i.test(v.lang));
    const list = (en.length ? en : VOICES)
      .slice()
      .sort((a, b) => (/(en[-_]US)/i.test(b.lang) ? 1 : 0) - (/(en[-_]US)/i.test(a.lang) ? 1 : 0));
    sel.innerHTML =
      '<option value="">美式发音（自动）</option>' +
      list
        .map((v) => {
          const us = /en[-_]US/i.test(v.lang) ? "（美式）" : "";
          return `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}${us} · ${escapeHtml(v.lang)}</option>`;
        })
        .join("");
    sel.value = current || "";
  }
  function populateVoiceSelect() {
    fillVoiceSelect($("#ttsVoice"), state.settings.voice);
    fillVoiceSelect($("#rdVoice"), state.settings.readVoice);
  }
  $("#ttsVoice").addEventListener("change", (e) => {
    state.settings.voice = e.target.value;
    save();
    speak("order"); // quick preview
  });
  $("#ttsRate").value = state.settings.rate;
  $("#ttsRate").addEventListener("input", (e) => {
    state.settings.rate = Number(e.target.value);
    save();
  });
  $("#ttsRate").addEventListener("change", () => speak("settlement"));
  if (TTS) {
    refreshVoices();
    TTS.onvoiceschanged = refreshVoices;
  } else {
    // No speech support: hide audio-dependent controls and the dictation entry.
    ["fcSpeak", "ttsVoice", "ttsRate", "fcAutoSpeak"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && el.closest("label")) el.closest("label").style.display = "none";
      else if (el) el.style.display = "none";
    });
    const dictTab = document.querySelector('.tab[data-view="dict"]');
    if (dictTab) dictTab.style.display = "none";
    const dictQuick = document.getElementById("dictQuick");
    if (dictQuick) dictQuick.style.display = "none";
  }

  /* ------------------------------------------------------------------ quiz */
  let qzQueue = [], qzIndex = 0, qzScore = 0;
  function startQuiz() {
    qzQueue = shuffle(activeCards()).slice(0, 20);
    qzIndex = 0; qzScore = 0;
    $("#qzScore").textContent = "0";
    $("#qzDone").hidden = true;
    $("#qzStage").hidden = false;
    renderQuiz();
  }
  function renderQuiz() {
    const stage = $("#qzStage"), done = $("#qzDone");
    if (qzQueue.length < 1) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>没有可测试的词条</h3><p class="muted">先导入一些词汇吧。</p>`;
      $("#qzProgress").textContent = "0 / 0";
      return;
    }
    if (qzIndex >= qzQueue.length) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>🎯 测试完成</h3><p class="muted">得分 ${qzScore} / ${qzQueue.length}</p>
        <button class="btn primary" id="qzAgain">再测一次</button>`;
      $("#qzAgain").onclick = startQuiz;
      return;
    }
    const reverse = $("#qzReverse").checked; // 中→英 means show back, choose front
    const card = qzQueue[qzIndex];
    $("#qzProgress").textContent = `${qzIndex + 1} / ${qzQueue.length}`;
    const promptText = reverse ? card.back : card.front;
    const sub = reverse ? "选择正确的英文" : "选择正确的中文释义";
    $("#qzPrompt").innerHTML = `${escapeHtml(promptText)}<span class="qz-sub">${sub}</span>`;

    const answerField = reverse ? "front" : "back";
    const correct = card[answerField] || "—";
    // distractors from same pool
    const others = shuffle(
      state.cards.filter((c) => c !== card && (c[answerField] || "") && c[answerField] !== correct)
    );
    const optSet = [];
    const seen = new Set([correct]);
    for (const o of others) {
      if (optSet.length >= 3) break;
      const v = o[answerField];
      if (!seen.has(v)) { optSet.push(v); seen.add(v); }
    }
    const options = shuffle([correct, ...optSet]);
    $("#qzOptions").innerHTML = options
      .map(
        (o, i) =>
          `<button class="quiz-opt" data-val="${escapeHtml(o)}"><b class="opt-num">${i + 1}</b> ${escapeHtml(o)}</button>`
      )
      .join("");
  }
  function answerQuiz(btn) {
    if (!btn || btn.disabled) return;
    const reverse = $("#qzReverse").checked;
    const card = qzQueue[qzIndex];
    const correct = (reverse ? card.front : card.back) || "—";
    const ok = btn.dataset.val === correct;
    $$("#qzOptions .quiz-opt").forEach((b) => {
      b.disabled = true;
      if (b.dataset.val === correct) b.classList.add("correct");
      else if (b === btn) b.classList.add("wrong");
    });
    // feed SRS: good if right, again if wrong
    schedule(card, ok ? 2 : 0, "read");
    if (ok) { qzScore++; $("#qzScore").textContent = String(qzScore); }
    save();
    setTimeout(() => { qzIndex++; renderQuiz(); }, ok ? 650 : 1200);
  }
  $("#qzOptions").addEventListener("click", (e) => {
    answerQuiz(e.target.closest(".quiz-opt"));
  });
  $("#qzRestart").onclick = startQuiz;
  $("#qzReverse").onchange = startQuiz;

  /* --------------------------------------------------------------- spelling */
  let spQueue = [], spIndex = 0, spScore = 0, spAnswered = false;
  function startSpell() {
    // only cards that have an english front worth typing
    spQueue = shuffle(activeCards().filter((c) => c.front && c.front.length <= 40));
    spIndex = 0; spScore = 0; spAnswered = false;
    $("#spScore").textContent = "0";
    $("#spDone").hidden = true;
    $("#spStage").hidden = false;
    renderSpell();
  }
  function renderSpell() {
    const stage = $("#spStage"), done = $("#spDone");
    if (!spQueue.length) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>没有可练习的词条</h3><p class="muted">先导入一些词汇吧。</p>`;
      $("#spProgress").textContent = "0 / 0";
      return;
    }
    if (spIndex >= spQueue.length) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>✍️ 练习完成</h3><p class="muted">正确 ${spScore} / ${spQueue.length}</p>
        <button class="btn primary" id="spAgain">再练一次</button>`;
      $("#spAgain").onclick = startSpell;
      return;
    }
    spAnswered = false;
    const card = spQueue[spIndex];
    $("#spProgress").textContent = `${spIndex + 1} / ${spQueue.length}`;
    $("#spPrompt").textContent = card.back || "(无中文，凭例句作答)";
    $("#spExample").innerHTML = card.example
      ? renderInline(card.example.replace(new RegExp(escapeReg(card.front), "ig"), "____"))
      : "";
    const input = $("#spInput");
    input.value = ""; input.disabled = false; input.focus();
    $("#spFeedback").textContent = ""; $("#spFeedback").className = "spell-feedback";
    $("#spSubmit").textContent = "提交";
  }
  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function normalize(s) { return s.trim().toLowerCase().replace(/\s+/g, " "); }
  function submitSpell() {
    const card = spQueue[spIndex];
    if (!card) return;
    if (spAnswered) { spIndex++; renderSpell(); return; }
    const input = $("#spInput");
    const ans = normalize(input.value);
    const target = normalize(card.front);
    const fb = $("#spFeedback");
    spAnswered = true;
    input.disabled = true;
    if (ans === target && ans !== "") {
      fb.textContent = "✓ 正确"; fb.className = "spell-feedback ok";
      spScore++; $("#spScore").textContent = String(spScore);
      schedule(card, 2, "write");
    } else {
      fb.innerHTML = `✗ 正确答案：<b>${escapeHtml(card.front)}</b>`; fb.className = "spell-feedback no";
      schedule(card, 0, "write");
    }
    speak(card.front); // hear the correct pronunciation
    save();
    $("#spSubmit").textContent = "下一个";
  }
  $("#spSubmit").addEventListener("click", submitSpell);
  $("#spInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitSpell(); });
  $("#spRestart").onclick = startSpell;

  /* -------------------------------------------------------------- dictation */
  let dtQueue = [], dtIndex = 0, dtScore = 0, dtAnswered = false;
  function dictMode() {
    const el = document.querySelector('input[name="dtMode"]:checked');
    return el ? el.value : "word";
  }
  // What gets played (and typed) for a card in the given mode.
  function listenText(card, mode) {
    if (mode === "sentence") {
      if (card.example) return card.example;
      if (card.front && /\s/.test(card.front.trim())) return card.front; // phrase/sentence entry
      return null;
    }
    return card.front;
  }
  function normalizeAnswer(s) {
    // Case/punctuation-insensitive, collapse whitespace — forgiving for dictation.
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[^\w\s]|_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function startDict() {
    $("#dtDone").hidden = true;
    $("#dtStage").hidden = false;
    if (!TTS) {
      $("#dtStage").hidden = true;
      $("#dtDone").hidden = false;
      $("#dtDone").innerHTML =
        `<h3>当前浏览器不支持语音朗读</h3><p class="muted">听写需要浏览器的语音合成能力，建议用 Chrome / Edge 打开。</p>`;
      $("#dtProgress").textContent = "0 / 0";
      return;
    }
    const mode = dictMode();
    const maxLen = mode === "sentence" ? 120 : 40;
    const pool = activeCards().filter((c) => {
      const t = listenText(c, mode);
      return t && t.length <= maxLen;
    });
    dtQueue = shuffle(pool);
    dtIndex = 0; dtScore = 0; dtAnswered = false;
    $("#dtScore").textContent = "0";
    renderDict();
  }
  function renderDict() {
    if (!TTS) return;
    const stage = $("#dtStage"), done = $("#dtDone");
    if (!dtQueue.length) {
      stage.hidden = true; done.hidden = false;
      const hint =
        dictMode() === "sentence"
          ? "该范围内没有带例句 / 整句的词条，试试切到「单词」或换个分类。"
          : "先导入一些词汇吧。";
      done.innerHTML = `<h3>没有可听写的内容</h3><p class="muted">${hint}</p>`;
      $("#dtProgress").textContent = "0 / 0";
      return;
    }
    if (dtIndex >= dtQueue.length) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>🎧 听写完成</h3><p class="muted">正确 ${dtScore} / ${dtQueue.length}</p>
        <button class="btn primary" id="dtAgain">再来一轮</button>`;
      $("#dtAgain").onclick = startDict;
      return;
    }
    stage.hidden = false;
    dtAnswered = false;
    const card = dtQueue[dtIndex];
    $("#dtProgress").textContent = `${dtIndex + 1} / ${dtQueue.length}`;
    const input = $("#dtInput");
    input.value = ""; input.disabled = false; input.focus();
    $("#dtFeedback").textContent = ""; $("#dtFeedback").className = "spell-feedback";
    $("#dtSubmit").textContent = "提交";
    $("#dtHint").textContent = $("#dtShowCn").checked ? card.back || "" : "";
    speak(listenText(card, dictMode())); // auto-play
  }
  function submitDict() {
    const card = dtQueue[dtIndex];
    if (!card) return;
    if (dtAnswered) { dtIndex++; renderDict(); return; }
    const target = listenText(card, dictMode());
    const input = $("#dtInput");
    const fb = $("#dtFeedback");
    const ok = input.value.trim() !== "" && normalizeAnswer(input.value) === normalizeAnswer(target);
    dtAnswered = true;
    input.disabled = true;
    if (ok) {
      fb.textContent = "✓ 正确"; fb.className = "spell-feedback ok";
      dtScore++; $("#dtScore").textContent = String(dtScore);
      schedule(card, 2, "listen");
    } else {
      fb.innerHTML =
        `✗ 正确答案：<b>${escapeHtml(target)}</b>` +
        (card.back ? `<br><span class="muted">${escapeHtml(card.back)}</span>` : "");
      fb.className = "spell-feedback no";
      schedule(card, 0, "listen");
    }
    speak(target); // replay the correct audio
    save();
    $("#dtSubmit").textContent = "下一个";
  }
  function playCurrentDict(rate) {
    const c = dtQueue[dtIndex];
    if (c) speak(listenText(c, dictMode()), rate);
  }
  $("#dtPlay").onclick = () => playCurrentDict();
  $("#dtReplay").onclick = () => playCurrentDict();
  $("#dtSlow").onclick = () => playCurrentDict(0.6);
  $("#dtSubmit").addEventListener("click", submitDict);
  $("#dtInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitDict(); });
  $("#dtRestart").onclick = startDict;
  $("#dtShowCn").onchange = renderDict;
  document.querySelectorAll('input[name="dtMode"]').forEach((r) => (r.onchange = startDict));

  /* --------------------------------------------------------------- speaking */
  // Shadowing + pronunciation self-check via the browser Speech Recognition API.
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let spkQueue = [], spkIndex = 0, spkScores = [];
  let spkListening = false, spkFinal = "", spkDoneItem = false;
  let recog = null;

  function speakMode() {
    const el = document.querySelector('input[name="spkMode"]:checked');
    return el ? el.value : "word";
  }
  // Longest-common-subsequence over word arrays; returns which target words matched.
  function lcsMarks(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const marks = new Array(n).fill(false);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { marks[i] = true; i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return { marks, len: dp[0][0] };
  }
  function ensureRecog() {
    if (!SpeechRec) return null;
    if (recog) return recog;
    recog = new SpeechRec();
    recog.lang = "en-US";
    recog.interimResults = true;
    recog.maxAlternatives = 1;
    recog.continuous = false;
    recog.onresult = (e) => {
      let interim = "", fin = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      spkFinal = fin;
      $("#spkHeard").textContent = (fin + " " + interim).trim() || "🎙️ 聆听中…";
    };
    recog.onerror = (e) => {
      spkListening = false;
      updateMicUI();
      const msg =
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "需要麦克风权限，请在浏览器允许后重试。"
          : e.error === "no-speech"
          ? "没听到声音，请再点麦克风朗读一次。"
          : "识别出错，请重试。";
      $("#spkResult").innerHTML = `<span class="mark-no">${msg}</span>`;
    };
    recog.onend = () => {
      spkListening = false;
      updateMicUI();
      if (!spkDoneItem && spkFinal.trim()) finishSpeak(spkFinal.trim());
    };
    return recog;
  }
  function startRecog() {
    const r = ensureRecog();
    if (!r || spkListening) return;
    spkFinal = "";
    $("#spkHeard").textContent = "🎙️ 聆听中…";
    $("#spkResult").textContent = "";
    try { r.start(); spkListening = true; updateMicUI(); } catch (_) {}
  }
  function stopRecog() {
    if (recog && spkListening) { try { recog.stop(); } catch (_) {} }
    spkListening = false;
  }
  function updateMicUI() {
    const btn = $("#spkMic");
    if (!btn) return;
    btn.classList.toggle("listening", spkListening);
    btn.textContent = spkListening ? "🛑 结束朗读" : "🎤 点击朗读";
  }
  function startSpeak() {
    $("#spkDone").hidden = true;
    $("#spkStage").hidden = false;
    if (!SpeechRec) {
      $("#spkStage").hidden = true;
      $("#spkDone").hidden = false;
      $("#spkDone").innerHTML =
        `<h3>当前浏览器不支持语音识别</h3><p class="muted">口语评分依赖浏览器的语音识别能力，建议用 Chrome / Edge 打开并允许麦克风权限。</p>`;
      $("#spkProgress").textContent = "0 / 0";
      return;
    }
    const mode = speakMode();
    const maxLen = mode === "sentence" ? 120 : 40;
    const pool = activeCards().filter((c) => {
      const t = listenText(c, mode);
      return t && t.length <= maxLen;
    });
    spkQueue = shuffle(pool);
    spkIndex = 0; spkScores = [];
    $("#spkAvg").textContent = "0";
    renderSpeak();
  }
  function renderSpeak() {
    if (!SpeechRec) return;
    stopRecog();
    const stage = $("#spkStage"), done = $("#spkDone");
    if (!spkQueue.length) {
      stage.hidden = true; done.hidden = false;
      const hint =
        speakMode() === "sentence"
          ? "该范围内没有带例句 / 整句的词条，试试切到「单词」或换个分类。"
          : "先导入一些词汇吧。";
      done.innerHTML = `<h3>没有可练习的内容</h3><p class="muted">${hint}</p>`;
      $("#spkProgress").textContent = "0 / 0";
      return;
    }
    if (spkIndex >= spkQueue.length) {
      stage.hidden = true; done.hidden = false;
      const avg = spkScores.length ? Math.round(spkScores.reduce((a, b) => a + b, 0) / spkScores.length) : 0;
      done.innerHTML = `<h3>🗣️ 练习完成</h3><p class="muted">平均分 ${avg} / 100（共 ${spkScores.length} 句）</p>
        <button class="btn primary" id="spkAgain">再来一轮</button>`;
      $("#spkAgain").onclick = startSpeak;
      return;
    }
    stage.hidden = false;
    spkDoneItem = false; spkFinal = "";
    const card = spkQueue[spkIndex];
    const target = listenText(card, speakMode());
    $("#spkProgress").textContent = `${spkIndex + 1} / ${spkQueue.length}`;
    $("#spkPrompt").textContent = target;
    $("#spkCn").textContent = card.back || "";
    $("#spkHeard").innerHTML = `<span class="ph">点击麦克风开始朗读…</span>`;
    $("#spkResult").textContent = "";
    $("#spkNext").hidden = true;
    updateMicUI();
    speak(target); // reference read-aloud first
  }
  function finishSpeak(heard) {
    spkDoneItem = true;
    const card = spkQueue[spkIndex];
    const target = listenText(card, speakMode());
    const tWords = normalizeAnswer(target).split(" ").filter(Boolean);
    const hWords = normalizeAnswer(heard).split(" ").filter(Boolean);
    const { marks, len } = lcsMarks(tWords, hWords);
    const score = tWords.length ? Math.round((len / tWords.length) * 100) : 0;
    spkScores.push(score);
    $("#spkAvg").textContent = String(
      Math.round(spkScores.reduce((a, b) => a + b, 0) / spkScores.length)
    );
    const missed = tWords.filter((_, i) => !marks[i]);
    const color = score >= 80 ? "var(--green)" : score >= 50 ? "var(--amber)" : "var(--red)";
    let detail = `<span class="muted">你说的：</span>${escapeHtml(heard)}`;
    if (missed.length) {
      detail += `<br><span class="muted">待加强：</span><span class="mark-no">${missed.map(escapeHtml).join(", ")}</span>`;
    }
    $("#spkResult").innerHTML = `<span class="pct" style="color:${color}">${score} 分</span><br>${detail}`;
    schedule(card, score >= 80 ? 2 : score >= 50 ? 1 : 0, "speak");
    save();
    $("#spkNext").hidden = false;
  }
  $("#spkPlay").addEventListener("click", () => {
    const c = spkQueue[spkIndex];
    if (c) speak(listenText(c, speakMode()));
  });
  $("#spkMic").addEventListener("click", () => {
    if (!SpeechRec) return;
    if (spkListening) stopRecog();
    else startRecog();
  });
  $("#spkNext").addEventListener("click", () => { spkIndex++; renderSpeak(); });
  $("#spkRestart").onclick = startSpeak;
  document.querySelectorAll('input[name="spkMode"]').forEach((r) => (r.onchange = startSpeak));

  /* ---------------------------------------------------------------- reading */
  // Split text into word / non-word tokens, preserving everything for rebuild.
  function tokenizeText(text) {
    const tokens = [];
    const re = /[A-Za-z]+(?:['’\-][A-Za-z]+)*|[^A-Za-z]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      tokens.push({ w: m[0], word: /^[A-Za-z]/.test(m[0]) });
    }
    return tokens;
  }
  // Index vocabulary terms (1–5 words) by their lowercased word sequence.
  function buildTermIndex() {
    const index = new Map();
    let maxLen = 1;
    for (const c of state.cards) {
      const ws = (c.front || "").toLowerCase().match(/[a-z]+(?:['’-][a-z]+)*/g);
      if (!ws || ws.length === 0 || ws.length > 5) continue;
      const key = ws.join(" ");
      if (key.length <= 1) continue; // skip stray single letters (e.g. from "T+1")
      if (!index.has(key)) index.set(key, c);
      if (ws.length > maxLen) maxLen = ws.length;
    }
    return { index, maxLen };
  }
  function analyzeReading() {
    const text = $("#rdText").value;
    const out = $("#rdOutput");
    const msg = $("#rdMsg");
    if (!text.trim()) {
      msg.textContent = "请先粘贴英文文本，或点「载入示例段落」。";
      msg.className = "import-msg err";
      out.hidden = true;
      return;
    }
    const { index, maxLen } = buildTermIndex();
    const tokens = tokenizeText(text);
    const wordIdx = [];
    tokens.forEach((t, i) => { if (t.word) wordIdx.push(i); });
    const lower = tokens.map((t) => (t.word ? t.w.toLowerCase() : null));
    // Greedy longest-match over the word-token sequence.
    const groups = [];
    const foundCards = new Set();
    let wi = 0;
    while (wi < wordIdx.length) {
      let matched = null, mlen = 0;
      const maxTry = Math.min(maxLen, wordIdx.length - wi);
      for (let len = maxTry; len >= 1; len--) {
        const parts = [];
        for (let k = 0; k < len; k++) parts.push(lower[wordIdx[wi + k]]);
        const key = parts.join(" ");
        if (index.has(key)) { matched = index.get(key); mlen = len; break; }
      }
      if (matched) {
        groups.push({ start: wordIdx[wi], end: wordIdx[wi + mlen - 1], card: matched });
        foundCards.add(matched.id);
        wi += mlen;
      } else wi += 1;
    }
    const cloze = $("#rdCloze").checked;
    let html = "";
    let ti = 0, gi = 0;
    while (ti < tokens.length) {
      if (gi < groups.length && groups[gi].start === ti) {
        const g = groups[gi];
        const orig = tokens.slice(g.start, g.end + 1).map((t) => t.w).join("");
        const cn = g.card.back || "";
        if (cloze) {
          html += `<span class="cloze" data-term="${escapeHtml(orig)}" title="${escapeHtml(cn)}">${"_".repeat(Math.max(4, orig.length))}</span>`;
        } else {
          html += `<span class="term-hl" data-term="${escapeHtml(orig)}" title="${escapeHtml(cn)}">${escapeHtml(orig)}</span>`;
        }
        ti = g.end + 1;
        gi++;
      } else {
        html += escapeHtml(tokens[ti].w);
        ti++;
      }
    }
    out.innerHTML = html;
    out.hidden = false;
    msg.textContent = cloze
      ? `识别出 ${groups.length} 处术语（${foundCards.size} 个不同），点击空格显示答案。`
      : `识别出 ${groups.length} 处术语（${foundCards.size} 个不同），悬停看释义、点击朗读。`;
    msg.className = "import-msg ok";
  }
  /* ---- reading: business-topic browse + sentence-by-sentence listening ---- */
  const RREAD =
    window.RULE_READING && Array.isArray(window.RULE_READING.items)
      ? window.RULE_READING
      : { topics: [], items: [] };
  const rdState = { topic: null, page: 0, item: -1, sents: [], si: 0 };
  const RD_PAGE = 12;
  const TOPIC_NAME = {};
  (RREAD.topics || []).forEach((t) => { TOPIC_NAME[t.key] = t.name; });
  let rdSearchQuery = "";

  // Reuse vocabulary term highlighting for an arbitrary chunk of text.
  function highlightTerms(text, cloze) {
    const { index, maxLen } = buildTermIndex();
    const tokens = tokenizeText(text);
    const wordIdx = [];
    tokens.forEach((t, i) => { if (t.word) wordIdx.push(i); });
    const lower = tokens.map((t) => (t.word ? t.w.toLowerCase() : null));
    const groups = [];
    let wi = 0;
    while (wi < wordIdx.length) {
      let matched = null, mlen = 0;
      const maxTry = Math.min(maxLen, wordIdx.length - wi);
      for (let len = maxTry; len >= 1; len--) {
        const parts = [];
        for (let k = 0; k < len; k++) parts.push(lower[wordIdx[wi + k]]);
        const key = parts.join(" ");
        if (index.has(key)) { matched = index.get(key); mlen = len; break; }
      }
      if (matched) { groups.push({ start: wordIdx[wi], end: wordIdx[wi + mlen - 1], card: matched }); wi += mlen; }
      else wi += 1;
    }
    let html = "", ti = 0, gi = 0;
    while (ti < tokens.length) {
      if (gi < groups.length && groups[gi].start === ti) {
        const g = groups[gi];
        const orig = tokens.slice(g.start, g.end + 1).map((t) => t.w).join("");
        const cn = g.card.back || "";
        if (cloze) html += `<span class="cloze" data-term="${escapeHtml(orig)}" title="${escapeHtml(cn)}">${"_".repeat(Math.max(4, orig.length))}</span>`;
        else html += `<span class="term-hl" data-term="${escapeHtml(orig)}" title="${escapeHtml(cn)}">${escapeHtml(orig)}</span>`;
        ti = g.end + 1; gi++;
      } else { html += escapeHtml(tokens[ti].w); ti++; }
    }
    return html;
  }
  function splitSents(text) {
    return (text.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [text])
      .map((s) => s.trim())
      .filter((s) => s.length > 1);
  }
  function itemsOfTopic(t) { return RREAD.items.filter((it) => it.t === t); }
  function itemsForTopic(t) { return t === "__fav__" ? (state.favReads || []) : itemsOfTopic(t); }

  function initReading() {
    const sel = $("#rdTopicSel");
    if (!sel) return;
    if (!RREAD.topics.length) { sel.innerHTML = "<option>（无语料）</option>"; return; }
    sel.innerHTML =
      `<option value="__fav__">★ 我的收藏（${(state.favReads || []).length}）</option>` +
      RREAD.topics
        .map((tp) => `<option value="${escapeHtml(tp.key)}">${escapeHtml(tp.name)}（${itemsOfTopic(tp.key).length}）</option>`)
        .join("");
    rdState.topic = RREAD.topics[0].key;
    rdState.page = 0;
    if (!SpeechRec) { const m = $("#rdMic"); if (m) m.hidden = true; }
    showReadBrowse();
  }
  function showReadBrowse() {
    stopAuto();
    stopRdRecog();
    $("#rdBrowse").hidden = false;
    $("#rdReader").hidden = true;
    renderTopicList();
  }
  function renderTopicList() {
    const fav = rdState.topic === "__fav__";
    const items = itemsForTopic(rdState.topic);
    const pages = Math.max(1, Math.ceil(items.length / RD_PAGE));
    if (rdState.page >= pages) rdState.page = 0;
    $("#rdCount").textContent = `${items.length} 篇`;
    if (!items.length) {
      $("#rdList").innerHTML = `<div class="muted" style="padding:12px">${fav ? "还没有收藏。打开任意材料后点 ☆ 收藏，即可在此复习精听/跟读。" : "（空）"}</div>`;
      $("#rdPager").innerHTML = "";
      return;
    }
    const start = rdState.page * RD_PAGE;
    const slice = items.slice(start, start + RD_PAGE);
    const exportBtn = fav ? `<button class="btn ghost small rd-export" data-export-fav>📋 导出全部收藏（${items.length}）</button>` : "";
    $("#rdList").innerHTML = exportBtn + slice
      .map((it) => {
        const attr = fav ? `data-fav="${items.indexOf(it)}"` : `data-i="${RREAD.items.indexOf(it)}"`;
        const preview = it.text.slice(0, 90) + (it.text.length > 90 ? "…" : "");
        return `<div class="rd-card" ${attr}><div class="rd-card-src">${escapeHtml(it.exch)} · ${escapeHtml(it.doc)}</div><div class="rd-card-prev">${escapeHtml(preview)}</div></div>`;
      })
      .join("");
    $("#rdPager").innerHTML =
      `<button class="btn ghost small" data-pg="prev" ${rdState.page === 0 ? "disabled" : ""}>← 上一页</button>` +
      `<span class="rd-pageinfo">${rdState.page + 1} / ${pages}</span>` +
      `<button class="btn ghost small" data-pg="next" ${rdState.page >= pages - 1 ? "disabled" : ""}>下一页 →</button>`;
  }
  function exportFavorites() {
    const favs = state.favReads || [];
    if (!favs.length) return;
    const text = favs
      .map((f, i) => `## ${i + 1}. ${f.exch} · ${f.doc}\n\n${f.text}`)
      .join("\n\n---\n\n");
    copyText(text, () => { const c = $("#rdCount"); if (c) c.textContent = `✓ 已复制 ${favs.length} 篇收藏`; });
  }
  function openMaterialObj(it) {
    if (!it) return;
    rdState.cur = it;
    rdState.sents = splitSents(it.text);
    rdState.si = 0;
    $("#rdResults").hidden = true;
    $("#rdBrowse").hidden = true;
    $("#rdReader").hidden = false;
    $("#rdMeta").textContent = `${it.exch} · ${it.doc}`;
    updateFavBtn();
    loadNote();
    renderReader();
  }
  // Notes: one free-text note per material, keyed by its text, auto-saved.
  function noteKey(it) { return it ? it.text : ""; }
  function getNote(it) { return (state.readNotes || {})[noteKey(it)] || ""; }
  function updateNoteBtn() {
    const b = $("#rdNote"); if (!b) return;
    b.textContent = getNote(rdState.cur).trim() ? "📝 笔记 ●" : "📝 笔记";
  }
  function loadNote() {
    const ta = $("#rdNoteText");
    if (ta) ta.value = getNote(rdState.cur);
    const box = $("#rdNoteBox");
    if (box) box.hidden = !getNote(rdState.cur).trim();
    updateNoteBtn();
  }
  function saveNote(text) {
    const it = rdState.cur; if (!it) return;
    state.readNotes = state.readNotes || {};
    const k = noteKey(it);
    if (text.trim()) state.readNotes[k] = text;
    else delete state.readNotes[k];
    save();
    updateNoteBtn();
    const h = $("#rdNoteHint"); if (h) { h.textContent = "已保存 ✓"; setTimeout(() => { h.textContent = "自动保存"; }, 1200); }
  }
  function openMaterial(gi) { openMaterialObj(RREAD.items[gi]); }
  function isFavCur() {
    const it = rdState.cur;
    return !!it && (state.favReads || []).some((f) => f.text === it.text);
  }
  function updateFavBtn() {
    const b = $("#rdFav"); if (b) b.textContent = isFavCur() ? "★ 已收藏" : "☆ 收藏";
  }
  // Add the tapped word to a personal wordbook (a "生词本" category card in the store).
  function addToWordbook(word) {
    if (!word || word.length < 2) return;
    const w = word.toLowerCase();
    const el = $("#rdSpkResult");
    if (state.cards.some((c) => (c.front || "").toLowerCase() === w && c.category === "生词本")) {
      if (el) el.textContent = `「${word}」已在生词本`;
      return;
    }
    const known = state.cards.find((c) => (c.front || "").toLowerCase() === w && (c.back || "").trim());
    state.cards.push({
      id: uid(), front: word, back: known ? known.back : "", example: rdState.sents[rdState.si] || "",
      category: "生词本", reps: 0, ease: 2.5, interval: 0, due: Date.now(), lapses: 0, correct: 0, seen: 0,
    });
    save();
    if (el) el.textContent = `✓ 已加入生词本：${word}${known ? "（" + known.back + "）" : ""}`;
  }
  function wordSpans(s) {
    return escapeHtml(s).replace(/[A-Za-z][A-Za-z'’\-]*/g, (w) => `<span class="rd-word" data-w="${w}">${w}</span>`);
  }
  // Split a sentence into sense groups (意群) at grammatical boundaries so playback
  // can pause/highlight chunk by chunk. Heuristic, offline, tuned for rule-English.
  const CHUNK_STRONG = new Set(["and", "or", "but", "because", "if", "when", "while", "which",
    "who", "whom", "whose", "where", "although", "though", "unless", "until", "before", "after",
    "since", "whether", "so", "that", "provided", "pursuant", "subject", "according", "where", "as"]);
  const CHUNK_PREP = new Set(["in", "on", "at", "for", "with", "from", "by", "into", "within",
    "between", "upon", "during", "without", "against", "through", "over", "under"]);
  // Fixed multi-word phrases common in exchange/clearing rules — kept as one sense
  // group (never split internally) and treated as a chunk start. Longest match wins.
  const CHUNK_PHRASES = [
    "for the avoidance of doubt", "as soon as reasonably practicable", "as soon as practicable",
    "in accordance with", "subject to the provisions of", "for the purposes of", "for the purpose of",
    "in connection with", "with respect to", "in respect of", "on behalf of", "in the event that",
    "in the event of", "to the extent that", "without prejudice to", "in relation to", "by virtue of",
    "in lieu of", "as the case may be", "in the case of", "in compliance with", "in default of",
    "notwithstanding anything to the contrary", "subject to", "pursuant to", "provided that",
    "in the ordinary course of business", "on the basis that", "for the benefit of",
    // Additions: high-frequency fixed expressions across exchange/clearing rules.
    "including but not limited to", "including without limitation", "for and on behalf of",
    "except as otherwise provided", "save as otherwise provided", "unless otherwise agreed",
    "unless otherwise specified", "unless otherwise provided", "unless otherwise stated",
    "to the extent permitted by", "to the satisfaction of", "with effect from",
    "subject to the approval of", "with the approval of", "with the consent of",
    "in consultation with", "in conjunction with", "in accordance with applicable law",
    "for the account of", "at the discretion of", "in the discretion of", "at the request of",
    "in the absence of", "in the interests of", "in the interest of", "in excess of",
    "on account of", "with a view to", "in whole or in part", "as set out in", "as provided in",
    "as referred to in", "as specified in", "as defined in", "as described in", "as required by",
    "from time to time", "for the time being", "by way of", "in lieu thereof", "in order to",
    "so as to", "in addition to", "on or before", "on or after", "no later than", "not less than",
    "not more than", "in favour of", "in favor of", "prior to", "subsequent to", "in good faith",
    "in writing", "where applicable", "if applicable", "as applicable", "mutatis mutandis",
    "inter alia", "if any",
  ].map((p) => p.split(/\s+/)).sort((a, b) => b.length - a.length);
  const bareWord = (w) => w.replace(/[^A-Za-z]/g, "").toLowerCase();
  // Return length (in words) of a fixed phrase starting at index i, else 0.
  function matchPhrase(words, i) {
    for (const p of CHUNK_PHRASES) {
      if (i + p.length > words.length) continue;
      let ok = true;
      for (let j = 0; j < p.length; j++) {
        if (bareWord(words[i + j]) !== p[j]) { ok = false; break; }
      }
      if (ok) return p.length;
    }
    return 0;
  }
  function chunkSentence(s) {
    const words = String(s).split(/\s+/).filter(Boolean);
    if (words.length <= 4) return [s];
    const chunks = [];
    let cur = [];
    const flush = () => { if (cur.length) { chunks.push(cur.join(" ")); cur = []; } };
    for (let i = 0; i < words.length; i++) {
      // Fixed phrase: start a new sense group and keep the whole phrase intact.
      const pl = matchPhrase(words, i);
      if (pl) {
        if (i > 0 && cur.length >= 2) flush();
        for (let j = 0; j < pl; j++) cur.push(words[i + j]);
        const last = words[i + pl - 1];
        i += pl - 1;
        if (/[,;:—]$/.test(last)) flush();
        continue;
      }
      const w = words[i];
      const bare = bareWord(w);
      if (i > 0) {
        if (CHUNK_STRONG.has(bare) && cur.length >= 2) flush();
        else if (CHUNK_PREP.has(bare) && cur.length >= 4) flush();
      }
      cur.push(w);
      if (/[,;:—]$/.test(w)) flush(); // hard break after punctuation
    }
    flush();
    // Merge chunks shorter than 2 words into the previous one to avoid fragments.
    const merged = [];
    for (const c of chunks) {
      if (merged.length && c.split(/\s+/).length < 2) merged[merged.length - 1] += " " + c;
      else merged.push(c);
    }
    return merged.length ? merged : [s];
  }
  function chunkMode() { const el = $("#rdChunk"); return !!(el && el.checked); }
  function renderReader() {
    stopRdRecog();
    const cloze = $("#rdCloze").checked;
    const wb = $("#rdWordMode") && $("#rdWordMode").checked;
    const chunk = chunkMode();
    $("#rdSents").innerHTML = rdState.sents
      .map((s, i) => {
        const isCur = i === rdState.si;
        let inner;
        if (wb) inner = wordSpans(s);
        else if (chunk && isCur)
          inner = chunkSentence(s)
            .map((c, ci) => `<span class="rd-chunk" data-ci="${ci}">${highlightTerms(c, cloze)}</span>`)
            .join('<span class="rd-chunk-sep"> / </span>');
        else inner = highlightTerms(s, cloze);
        return `<span class="rd-sent${isCur ? " cur" : ""}${wb ? " wb" : ""}" data-i="${i}">${inner}</span>`;
      })
      .join(" ");
    $("#rdPos").textContent = `第 ${rdState.si + 1} / ${rdState.sents.length} 句${wb ? " · 点词加入生词本" : chunk ? " · 意群断句" : ""}`;
    const sr = $("#rdSpkResult"); if (sr) sr.innerHTML = "";
    const cur = $("#rdSents .rd-sent.cur");
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }
  function rdSpeakOne(text) {
    const TTS = window.speechSynthesis;
    if (!TTS || !text) return;
    try {
      TTS.cancel();
      const u = new SpeechSynthesisUtterance(String(text));
      u.lang = "en-US";
      u.rate = state.settings.readRate || state.settings.rate || 0.95;
      const v = resolveVoice(state.settings.readVoice || state.settings.voice);
      if (v) u.voice = v;
      TTS.speak(u);
    } catch (_) {}
  }
  // Play the current sentence chunk by chunk, highlighting each sense group as it speaks.
  function playChunks(i) {
    const TTS = window.speechSynthesis;
    const s = rdState.sents[i];
    if (!TTS || !s) return;
    const chunks = chunkSentence(s);
    bumpDaily("listen");
    const rate = state.settings.readRate || state.settings.rate || 0.95;
    const v = resolveVoice(state.settings.readVoice || state.settings.voice);
    const spans = () => Array.from(document.querySelectorAll("#rdSents .rd-sent.cur .rd-chunk"));
    let k = 0;
    const clear = () => spans().forEach((el) => el.classList.remove("active"));
    const step = () => {
      clear();
      if (k >= chunks.length) return;
      const list = spans();
      if (list[k]) { list[k].classList.add("active"); list[k].scrollIntoView({ block: "nearest" }); }
      const u = new SpeechSynthesisUtterance(chunks[k]);
      u.lang = "en-US"; u.rate = rate;
      if (v) u.voice = v;
      u.onend = () => { k++; setTimeout(step, 180); };
      u.onerror = () => { k++; setTimeout(step, 180); };
      try { TTS.cancel(); TTS.speak(u); } catch (_) { clear(); }
    };
    step();
  }
  function playSent(i) {
    const s = rdState.sents[i];
    if (!s) return;
    if (chunkMode()) playChunks(i);
    else { rdSpeakOne(s); bumpDaily("listen"); }
  }
  function gotoSent(i) {
    if (i < 0 || i >= rdState.sents.length) return;
    rdState.si = i;
    renderReader();
    playSent(i);
  }
  let rdAutoOn = false;
  function stopAuto() {
    rdAutoOn = false;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
    const b = $("#rdAuto"); if (b) b.textContent = "▶️ 连续";
  }
  function startAuto() {
    if (!window.speechSynthesis) return;
    rdAutoOn = true;
    const b = $("#rdAuto"); if (b) b.textContent = "⏸ 停止";
    const rate = (state.settings && (state.settings.readRate || state.settings.rate)) || 0.95;
    const v = resolveVoice(state.settings.readVoice || state.settings.voice);
    const step = () => {
      if (!rdAutoOn || rdState.si >= rdState.sents.length) { stopAuto(); return; }
      renderReader();
      bumpDaily("listen");
      const u = new SpeechSynthesisUtterance(rdState.sents[rdState.si]);
      u.lang = "en-US"; u.rate = rate;
      if (v) u.voice = v;
      u.onend = () => { if (rdAutoOn) { rdState.si++; if (rdState.si < rdState.sents.length) step(); else stopAuto(); } };
      u.onerror = () => { if (rdAutoOn) { rdState.si++; if (rdState.si < rdState.sents.length) step(); else stopAuto(); } };
      try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch (_) { stopAuto(); }
    };
    step();
  }
  $("#rdTopicSel").addEventListener("change", (e) => { rdState.topic = e.target.value; rdState.page = 0; renderTopicList(); });
  $("#rdList").addEventListener("click", (e) => {
    if (e.target.closest("[data-export-fav]")) { exportFavorites(); return; }
    const c = e.target.closest(".rd-card"); if (!c) return;
    if (c.dataset.fav != null) openMaterialObj((state.favReads || [])[Number(c.dataset.fav)]);
    else openMaterial(Number(c.dataset.i));
  });
  $("#rdFav").addEventListener("click", () => {
    const it = rdState.cur; if (!it) return;
    state.favReads = state.favReads || [];
    const i = state.favReads.findIndex((f) => f.text === it.text);
    if (i >= 0) state.favReads.splice(i, 1);
    else state.favReads.unshift({ exch: it.exch, doc: it.doc, text: it.text });
    save();
    updateFavBtn();
  });
  $("#rdPager").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pg]"); if (!b) return;
    if (b.dataset.pg === "prev" && rdState.page > 0) rdState.page--;
    else if (b.dataset.pg === "next") rdState.page++;
    renderTopicList();
  });
  $("#rdBack").addEventListener("click", showReadBrowse);
  const rdCopyEl = $("#rdCopy");
  if (rdCopyEl) rdCopyEl.addEventListener("click", () => {
    const it = rdState.cur; if (!it) return;
    const text = `${it.exch} · ${it.doc}\n\n${it.text}`;
    copyText(text, () => { const sr = $("#rdSpkResult"); if (sr) sr.textContent = "✓ 已复制本篇到剪贴板"; });
  });
  const rdNoteEl = $("#rdNote");
  if (rdNoteEl) rdNoteEl.addEventListener("click", () => {
    const box = $("#rdNoteBox"); if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) { const ta = $("#rdNoteText"); if (ta) ta.focus(); }
  });
  const rdNoteTextEl = $("#rdNoteText");
  if (rdNoteTextEl) rdNoteTextEl.addEventListener("input", (e) => saveNote(e.target.value));
  const rdNoteAddSentEl = $("#rdNoteAddSent");
  if (rdNoteAddSentEl) rdNoteAddSentEl.addEventListener("click", () => {
    const ta = $("#rdNoteText"); const s = rdState.sents[rdState.si]; if (!ta || !s) return;
    ta.value = (ta.value ? ta.value.replace(/\s*$/, "") + "\n\n" : "") + `> ${s}\n`;
    ta.focus();
    saveNote(ta.value);
  });
  $("#rdPrev").addEventListener("click", () => gotoSent(rdState.si - 1));
  $("#rdNext").addEventListener("click", () => gotoSent(rdState.si + 1));
  $("#rdPlay").addEventListener("click", () => playSent(rdState.si));
  $("#rdRepeat").addEventListener("click", () => playSent(rdState.si));
  $("#rdAuto").addEventListener("click", () => { if (rdAutoOn) stopAuto(); else startAuto(); });
  $("#rdCloze").addEventListener("change", renderReader);
  const rdWordModeEl = $("#rdWordMode");
  if (rdWordModeEl) rdWordModeEl.addEventListener("change", renderReader);
  const rdChunkEl = $("#rdChunk");
  if (rdChunkEl) rdChunkEl.addEventListener("change", renderReader);
  $("#rdSents").addEventListener("click", (e) => {
    const wd = e.target.closest(".rd-word"); if (wd) { addToWordbook(wd.dataset.w); return; }
    const term = e.target.closest(".term-hl"); if (term) { speak(term.dataset.term); return; }
    const cz = e.target.closest(".cloze");
    if (cz && !cz.classList.contains("revealed")) { cz.textContent = cz.dataset.term; cz.classList.add("revealed"); speak(cz.dataset.term); return; }
    const sent = e.target.closest(".rd-sent"); if (sent) gotoSent(Number(sent.dataset.i));
  });

  // Reader shadowing: score pronunciation of the current sentence (separate recognizer).
  let rdRecog = null, rdListening = false, rdFinal = "";
  function updateRdMic() {
    const b = $("#rdMic"); if (!b) return;
    b.classList.toggle("listening", rdListening);
    b.textContent = rdListening ? "🛑 结束" : "🎤 跟读";
  }
  function stopRdRecog() {
    if (rdRecog && rdListening) { try { rdRecog.stop(); } catch (_) {} }
    rdListening = false;
    updateRdMic();
  }
  function ensureRdRecog() {
    if (!SpeechRec) return null;
    if (rdRecog) return rdRecog;
    rdRecog = new SpeechRec();
    rdRecog.lang = "en-US"; rdRecog.interimResults = true; rdRecog.maxAlternatives = 1; rdRecog.continuous = false;
    rdRecog.onresult = (e) => {
      let interim = "", fin = "";
      for (let i = 0; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript; }
      rdFinal = fin;
      const el = $("#rdSpkResult"); if (el) el.textContent = (fin + " " + interim).trim() || "🎙️ 聆听中…";
    };
    rdRecog.onerror = () => { rdListening = false; updateRdMic(); };
    rdRecog.onend = () => { rdListening = false; updateRdMic(); if (rdFinal.trim()) scoreRdSentence(rdFinal.trim()); };
    return rdRecog;
  }
  function scoreRdSentence(heard) {
    const target = rdState.sents[rdState.si] || "";
    const tWords = normalizeAnswer(target).split(" ").filter(Boolean);
    const hWords = normalizeAnswer(heard).split(" ").filter(Boolean);
    const { marks, len } = lcsMarks(tWords, hWords);
    const score = tWords.length ? Math.round((len / tWords.length) * 100) : 0;
    const missed = tWords.filter((_, i) => !marks[i]);
    const color = score >= 80 ? "var(--green)" : score >= 50 ? "var(--amber)" : "var(--red)";
    let d = `<span class="pct" style="color:${color}">${score} 分</span> <span class="muted">你说：</span>${escapeHtml(heard)}`;
    if (missed.length) d += `<br><span class="muted">待加强：</span><span class="mark-no">${missed.map(escapeHtml).join(", ")}</span>`;
    const el = $("#rdSpkResult"); if (el) el.innerHTML = d;
    recordSkill("speak", score >= 80 ? 2 : score >= 50 ? 1 : 0);
    bumpDaily("speak");
    save();
  }
  $("#rdMic").addEventListener("click", () => {
    if (!SpeechRec) return;
    if (rdListening) { stopRdRecog(); return; }
    const r = ensureRdRecog(); if (!r) return;
    rdFinal = "";
    const el = $("#rdSpkResult"); if (el) el.textContent = "🎙️ 聆听中…";
    try { r.start(); rdListening = true; updateRdMic(); } catch (_) {}
  });
  const rdRateEl = $("#rdRate");
  if (rdRateEl) {
    rdRateEl.value = state.settings.readRate;
    rdRateEl.addEventListener("input", (e) => { state.settings.readRate = Number(e.target.value); save(); });
    rdRateEl.addEventListener("change", () => rdSpeakOne("settlement date"));
  }
  const rdVoiceEl = $("#rdVoice");
  if (rdVoiceEl) rdVoiceEl.addEventListener("change", (e) => { state.settings.readVoice = e.target.value; save(); rdSpeakOne("clearing house"); });

  // --- Speed presets (0.5×–1.5×), like a daily-listening app ---
  function markSpeed(box, val) {
    if (!box) return;
    let best = null, bestD = Infinity;
    box.querySelectorAll(".chip").forEach((c) => {
      c.classList.remove("active");
      const d = Math.abs(Number(c.dataset.r) - val);
      if (d < bestD) { bestD = d; best = c; }
    });
    if (best) best.classList.add("active");
  }
  function wireSpeedRow(id, get, set, preview, syncEl) {
    const box = document.getElementById(id);
    if (!box) return;
    markSpeed(box, get());
    box.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip"); if (!chip) return;
      const r = Number(chip.dataset.r);
      set(r); save();
      markSpeed(box, r);
      if (syncEl) syncEl.value = r;
      preview();
    });
  }
  wireSpeedRow("rdSpeed", () => state.settings.readRate || 0.9, (r) => { state.settings.readRate = r; }, () => rdSpeakOne("settlement date"), $("#rdRate"));
  wireSpeedRow("spkSpeed", () => state.settings.rate || 0.95, (r) => { state.settings.rate = r; }, () => speak("clearing house"), $("#ttsRate"));
  // Keep chips in sync when the fine-tune sliders move.
  if (rdRateEl) rdRateEl.addEventListener("input", () => markSpeed(document.getElementById("rdSpeed"), Number(rdRateEl.value)));
  const ttsRateEl2 = $("#ttsRate");
  if (ttsRateEl2) ttsRateEl2.addEventListener("input", () => markSpeed(document.getElementById("spkSpeed"), Number(ttsRateEl2.value)));

  // Full-library keyword search over paragraph items, grouped by business topic.
  function searchCorpus() {
    const q = ($("#rdSearch").value || "").trim();
    const box = $("#rdResults"), msg = $("#rdSearchMsg");
    if (!box || !msg) return;
    if (q.length < 2) { msg.textContent = "请输入至少 2 个字符"; box.hidden = true; return; }
    rdSearchQuery = q;
    const ql = q.toLowerCase(); const MAX = 80; const results = [];
    for (let i = 0; i < RREAD.items.length && results.length < MAX; i++) {
      const it = RREAD.items[i];
      const idx = it.text.toLowerCase().indexOf(ql);
      if (idx >= 0) {
        const start = Math.max(0, idx - 45), end = Math.min(it.text.length, idx + q.length + 70);
        const snip = (start > 0 ? "…" : "") + it.text.slice(start, end) + (end < it.text.length ? "…" : "");
        results.push({ i, t: it.t, exch: it.exch, doc: it.doc, snip });
      }
    }
    if (!results.length) { msg.textContent = `未找到「${q}」`; box.hidden = true; box.innerHTML = ""; return; }
    msg.textContent = `找到 ${results.length}${results.length >= MAX ? "+" : ""} 处，点击打开并定位到句`;
    const rx = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    const byTopic = {};
    results.forEach((r) => { (byTopic[r.t] = byTopic[r.t] || []).push(r); });
    const order = (RREAD.topics || []).map((t) => t.key).filter((k) => byTopic[k]);
    let html = "";
    order.forEach((k) => {
      html += `<div class="search-group">${escapeHtml(TOPIC_NAME[k] || k)}（${byTopic[k].length}）</div>`;
      html += byTopic[k]
        .map((r) => `<div class="search-hit" data-i="${r.i}"><span class="hit-src">${escapeHtml(r.exch)} · ${escapeHtml(r.doc)}</span><span class="hit-snip">${escapeHtml(r.snip).replace(rx, "<mark>$1</mark>")}</span></div>`)
        .join("");
    });
    box.innerHTML = html;
    box.hidden = false;
  }
  // Open a material from a search hit and jump to the sentence containing the query.
  function openFromSearch(gi) {
    openMaterial(gi);
    const q = (rdSearchQuery || "").toLowerCase();
    if (!q) return;
    const li = rdState.sents.findIndex((s) => s.toLowerCase().includes(q));
    if (li >= 0) gotoSent(li);
  }
  $("#rdSearchBtn").addEventListener("click", searchCorpus);
  $("#rdSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") searchCorpus(); });
  $("#rdResults").addEventListener("click", (e) => {
    const hit = e.target.closest(".search-hit"); if (!hit) return;
    $("#rdResults").hidden = true;
    openFromSearch(Number(hit.dataset.i));
  });

  /* ---------------------------------------------------------------- grammar */
  let grammarBuilt = false;
  function renderGrammar() {
    if (grammarBuilt) return;
    const G = window.RULE_GRAMMAR;
    if (!G) return;
    const pv = $("#gsub-patterns");
    if (pv && Array.isArray(G.patterns)) {
      pv.innerHTML = G.patterns
        .map(
          (p, i) => `
        <div class="gp-card">
          <div class="gp-name">${i + 1}. ${escapeHtml(p.name)}</div>
          <div class="gp-tip">${escapeHtml(p.tip)}</div>
          <div class="gp-eg"><button class="say-btn" data-say="${escapeHtml(p.eg)}" title="朗读">🔊</button><span>${escapeHtml(p.eg)}</span></div>
          <div class="gp-tpl">句型：${escapeHtml(p.template)}</div>
        </div>`
        )
        .join("");
    }
    buildGItemsShell(G);
    grammarBuilt = true;
  }
  const GI_PAGE = 12;
  const giState = { pat: "all", page: 0 };
  function grammarPatOf(i) {
    const G = window.RULE_GRAMMAR || {};
    const it = (G.items || [])[i];
    if (it && typeof it.pat === "number") return it.pat;
    const arr = G.patternOf || [];
    return arr[i] != null ? arr[i] : -1;
  }
  function buildGItemsShell(G) {
    const iv = $("#gsub-items");
    if (!iv) return;
    const patNames = (G.patterns || []).map((p) => p.name);
    const opts = ['<option value="all">全部句型</option>']
      .concat(patNames.map((n, i) => `<option value="${i}">${escapeHtml(n)}</option>`))
      .join("");
    iv.innerHTML = `<div class="gi-bar"><select id="giPatSel" class="mini-select">${opts}</select><span class="gi-count muted" id="giCount"></span></div><div id="giList"></div><div class="rd-pager" id="giPager"></div>`;
    renderGItems();
  }
  function giFiltered() {
    const items = (window.RULE_GRAMMAR || {}).items || [];
    const idxs = items.map((_, i) => i);
    if (giState.pat === "all") return idxs;
    return idxs.filter((i) => grammarPatOf(i) === Number(giState.pat));
  }
  function renderGItems() {
    const items = (window.RULE_GRAMMAR || {}).items || [];
    const list = giFiltered();
    const pages = Math.max(1, Math.ceil(list.length / GI_PAGE));
    if (giState.page >= pages) giState.page = 0;
    const slice = list.slice(giState.page * GI_PAGE, giState.page * GI_PAGE + GI_PAGE);
    const cnt = $("#giCount"); if (cnt) cnt.textContent = `${list.length} 句`;
    const listBox = $("#giList");
    if (listBox) listBox.innerHTML = slice.map((i) => {
      const it = items[i];
      const pts = (it.points || []).map((pt) => {
        const idx = pt.indexOf("：");
        return idx > 0 ? `<li><b>${escapeHtml(pt.slice(0, idx))}</b>：${escapeHtml(pt.slice(idx + 1))}</li>` : `<li>${escapeHtml(pt)}</li>`;
      }).join("");
      return `<div class="gi-card"><div class="gi-en"><button class="say-btn" data-say="${escapeHtml(it.en)}" title="朗读">🔊</button><span>${escapeHtml(it.en)}</span></div><div class="gi-cn">${escapeHtml(it.cn)}</div><div class="gi-core"><span class="gi-tag">主干</span>${escapeHtml(it.core)}</div><ul class="gi-points">${pts}</ul></div>`;
    }).join("");
    const pager = $("#giPager");
    if (pager) pager.innerHTML =
      `<button class="btn ghost small" data-gpg="prev" ${giState.page === 0 ? "disabled" : ""}>← 上一页</button>` +
      `<span class="rd-pageinfo">${giState.page + 1} / ${pages}</span>` +
      `<button class="btn ghost small" data-gpg="next" ${giState.page >= pages - 1 ? "disabled" : ""}>下一页 →</button>`;
  }
  const grammarSeg = $("#grammarSeg");
  if (grammarSeg) {
    grammarSeg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-gsub]");
      if (!b) return;
      const sub = b.dataset.gsub;
      $$("#grammarSeg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
      $("#gsub-patterns").hidden = sub !== "patterns";
      $("#gsub-items").hidden = sub !== "items";
      $("#gsub-quiz").hidden = sub !== "quiz";
      if (sub === "quiz") startGrammarQuiz();
    });
  }
  const grammarView = $("#view-grammar");
  if (grammarView) {
    grammarView.addEventListener("click", (e) => {
      const s = e.target.closest(".say-btn");
      if (s) speak(s.dataset.say);
    });
  }
  const gItemsBox = $("#gsub-items");
  if (gItemsBox) {
    gItemsBox.addEventListener("change", (e) => {
      if (e.target.id === "giPatSel") { giState.pat = e.target.value; giState.page = 0; renderGItems(); }
    });
    gItemsBox.addEventListener("click", (e) => {
      const b = e.target.closest("[data-gpg]"); if (!b) return;
      if (b.dataset.gpg === "prev" && giState.page > 0) giState.page--;
      else if (b.dataset.gpg === "next") giState.page++;
      renderGItems();
    });
  }

  // Grammar self-test: pick the core (main clause) or the correct Chinese.
  let gqQueue = [], gqIndex = 0, gqScore = 0, gqAnswered = false;
  function makeGrammarQuestions(n) {
    const G = window.RULE_GRAMMAR || {};
    const items = G.items || [];
    const patOf = G.patternOf || [];
    const patNames = (G.patterns || []).map((p) => p.name);
    if (items.length < 4) return [];
    const order = shuffle(items.map((_, i) => i)).slice(0, n);
    const types = ["core", "cn", "pat"];
    const pickDistract = (correct, valueOf) => {
      const seen = new Set([correct]);
      const d = [];
      for (const x of shuffle(items)) {
        if (d.length >= 3) break;
        const v = valueOf(x);
        if (v && !seen.has(v)) { seen.add(v); d.push(v); }
      }
      return d;
    };
    return order.map((i, k) => {
      const it = items[i];
      let type = types[k % 3];
      if (type === "pat" && !(grammarPatOf(i) >= 0 && patNames.length >= 4)) type = "core";
      if (type === "core") {
        const d = pickDistract(it.core, (x) => x.core);
        return { en: it.en, type, ask: "选出该句的<b>主干</b>（去掉从句与修饰后的 S + V + O）：", correct: it.core, options: shuffle([it.core, ...d]), core: it.core, points: it.points };
      }
      if (type === "cn") {
        const d = pickDistract(it.cn, (x) => x.cn);
        return { en: it.en, type, ask: "选出该句的<b>准确中文</b>：", correct: it.cn, options: shuffle([it.cn, ...d]), core: it.core, points: it.points };
      }
      const pidx = grammarPatOf(i);
      const correct = patNames[pidx];
      const seen = new Set([correct]);
      const d = [];
      for (const nm of shuffle(patNames)) { if (d.length >= 3) break; if (!seen.has(nm)) { seen.add(nm); d.push(nm); } }
      const tip = (G.patterns[pidx] && G.patterns[pidx].tip) || "";
      return { en: it.en, type, ask: "这句<b>最突出的句式结构</b>是？", correct, options: shuffle([correct, ...d]), core: it.core, points: it.points, patTip: tip };
    });
  }
  function startGrammarQuiz() {
    gqQueue = makeGrammarQuestions(10);
    gqIndex = 0; gqScore = 0; gqAnswered = false;
    $("#gqScore").textContent = "0";
    $("#gqDone").hidden = true;
    $("#gqStage").hidden = false;
    renderGQ();
  }
  function renderGQ() {
    const q = gqQueue[gqIndex];
    if (!q) return;
    gqAnswered = false;
    $("#gqProgress").textContent = (gqIndex + 1) + " / " + gqQueue.length;
    $("#gqPrompt").innerHTML =
      `<div class="gq-ask">${q.ask}</div><div class="gq-sentence">${escapeHtml(q.en)}</div>`;
    $("#gqOptions").innerHTML = q.options
      .map((o, i) => `<button class="quiz-opt" data-val="${escapeHtml(o)}"><b class="opt-num">${i + 1}</b> ${escapeHtml(o)}</button>`)
      .join("");
    $("#gqExplain").hidden = true;
    $("#gqExplain").innerHTML = "";
    $("#gqNext").hidden = true;
  }
  function answerGQ(btn) {
    if (!btn || gqAnswered) return;
    gqAnswered = true;
    const q = gqQueue[gqIndex];
    const ok = btn.dataset.val === q.correct;
    if (ok) { gqScore++; $("#gqScore").textContent = String(gqScore); }
    $$("#gqOptions .quiz-opt").forEach((b) => {
      b.disabled = true;
      if (b.dataset.val === q.correct) b.classList.add("correct");
      else if (b === btn) b.classList.add("wrong");
    });
    const pts = (q.points || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("");
    const tip = q.patTip ? `<div class="gq-ex-tip">${escapeHtml(q.patTip)}</div>` : "";
    $("#gqExplain").innerHTML =
      tip + `<div class="gq-ex-core"><span class="gi-tag">主干</span>${escapeHtml(q.core)}</div><ul class="gi-points">${pts}</ul>`;
    $("#gqExplain").hidden = false;
    $("#gqNext").hidden = false;
  }
  function nextGQ() {
    if (gqIndex < gqQueue.length - 1) { gqIndex++; renderGQ(); }
    else {
      $("#gqStage").hidden = true;
      const done = $("#gqDone");
      done.hidden = false;
      done.innerHTML = `<h3>完成！得分 ${gqScore} / ${gqQueue.length}</h3><button class="btn primary" id="gqAgain">再来一组</button>`;
    }
  }
  const gqOptions = $("#gqOptions");
  if (gqOptions) gqOptions.addEventListener("click", (e) => answerGQ(e.target.closest(".quiz-opt")));
  const gqNext = $("#gqNext");
  if (gqNext) gqNext.addEventListener("click", nextGQ);
  const gqRestart = $("#gqRestart");
  if (gqRestart) gqRestart.addEventListener("click", startGrammarQuiz);
  const gqDone = $("#gqDone");
  if (gqDone) gqDone.addEventListener("click", (e) => { if (e.target.closest("#gqAgain")) startGrammarQuiz(); });
  const rdOutputEl = $("#rdOutput");
  if (rdOutputEl) rdOutputEl.addEventListener("click", (e) => {
    const hl = e.target.closest(".term-hl");
    if (hl) { speak(hl.dataset.term); return; }
    const cz = e.target.closest(".cloze");
    if (cz && !cz.classList.contains("revealed")) {
      cz.textContent = cz.dataset.term;
      cz.classList.add("revealed");
      speak(cz.dataset.term);
    }
  });

  /* ---------------------------------------------------------------- writing */
  function copyText(text, cb) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(cb, () => fallbackCopy(text, cb));
    } else fallbackCopy(text, cb);
  }
  function fallbackCopy(text, cb) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      if (cb) cb();
    } catch (_) {}
  }
  function isSentence(s) {
    s = (s || "").trim();
    if (!/\s/.test(s)) return false;
    return /[.?!？！]$/.test(s) || s.split(/\s+/).length >= 4;
  }

  // -- 造句练习 (Chinese -> English, self-assessed against a model answer) --
  let wrQueue = [], wrIndex = 0;
  function startWrite() {
    $("#wrDone").hidden = true;
    $("#wrStage").hidden = false;
    wrQueue = shuffle(activeCards().filter((c) => c.back && isSentence(c.front)));
    wrIndex = 0;
    renderWrite();
  }
  function renderWrite() {
    const stage = $("#wrStage"), done = $("#wrDone");
    if (!wrQueue.length) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>没有可练习的句子</h3><p class="muted">造句练习使用"整句"类词条（如会议句式）。载入示例词库或换个分类试试。</p>`;
      $("#wrProgress").textContent = "0 / 0";
      return;
    }
    if (wrIndex >= wrQueue.length) {
      stage.hidden = true; done.hidden = false;
      done.innerHTML = `<h3>✍️ 练习完成</h3><p class="muted">共练习 ${wrQueue.length} 句。</p>
        <button class="btn primary" id="wrAgain">再来一轮</button>`;
      $("#wrAgain").onclick = startWrite;
      return;
    }
    stage.hidden = false;
    const card = wrQueue[wrIndex];
    $("#wrProgress").textContent = `${wrIndex + 1} / ${wrQueue.length}`;
    $("#wrCn").textContent = card.back;
    const inp = $("#wrInput");
    inp.value = ""; inp.disabled = false; inp.focus();
    $("#wrShow").hidden = false;
    $("#wrRef").hidden = true; $("#wrRef").innerHTML = "";
    $("#wrGrade").hidden = true;
  }
  $("#wrShow").addEventListener("click", () => {
    const card = wrQueue[wrIndex];
    if (!card) return;
    $("#wrRef").innerHTML = `<span class="rf-label">参考答案</span>${escapeHtml(card.front)}`;
    $("#wrRef").hidden = false;
    $("#wrGrade").hidden = false;
    $("#wrShow").hidden = true;
    speak(card.front);
  });
  $("#wrGrade").addEventListener("click", (e) => {
    const b = e.target.closest("[data-wknow]");
    if (!b) return;
    schedule(wrQueue[wrIndex], Number(b.dataset.wknow), "write");
    save();
    wrIndex++;
    renderWrite();
  });
  $("#wrRestart").onclick = startWrite;

  // -- 写作模板库 --
  const WRITE_TEMPLATES = [
    { cat: "邮件", title: "请求信息 / 澄清需求", cn: "请对方补充或澄清信息",
      en: "Hi {Name},\n\nCould you help clarify {the requirement / expected behavior} for {feature or module}? Specifically, I'd like to confirm {point 1} and {point 2}.\n\nThanks in advance,\n{Your name}" },
    { cat: "邮件", title: "跟进进度", cn: "跟进任务 / 依赖项的进展",
      en: "Hi {Name},\n\nJust following up on {task / the API change}. Could you share the current status and an ETA? This is currently blocking {dependency} on our side.\n\nAppreciate your help,\n{Your name}" },
    { cat: "邮件", title: "确认理解", cn: "复述并确认理解无误",
      en: "Hi {Name},\n\nTo make sure I understand correctly: {your understanding}. Please correct me if I'm wrong. Once confirmed, we'll proceed with {next step}.\n\nBest,\n{Your name}" },
    { cat: "邮件", title: "上报问题 / 风险", cn: "上报缺陷或风险，说明影响与临时方案",
      en: "Hi {Name},\n\nWe've identified an issue in {environment}: {short description}. Impact: {impact}. The root cause is still under investigation; as a workaround we {temporary measure}. I'll keep you posted.\n\nRegards,\n{Your name}" },
    { cat: "邮件", title: "安排会议", cn: "发起会议邀约并给出议程",
      en: "Hi {Name},\n\nCould we set up a 30-minute call to align on {topic}? I'm available {time options} (your timezone). Proposed agenda:\n1. {item 1}\n2. {item 2}\n\nThanks,\n{Your name}" },
    { cat: "邮件", title: "发送会议纪要", cn: "会后发送纪要与待办",
      en: "Hi all,\n\nThanks for joining. Summary of what we agreed:\n- {decision 1}\n- {decision 2}\nAction items:\n- {owner} to {action} by {date}\n\nPlease reply if I missed anything.\n\nBest,\n{Your name}" },
    { cat: "会议", title: "开场", cn: "会议开场、说明目标",
      en: "Thanks everyone for joining. The goal of this meeting is to {objective}. Let's start with {first topic}." },
    { cat: "会议", title: "澄清", cn: "确认理解、请对方展开",
      en: "Just to make sure I understand correctly, you mean {…}? Could you elaborate a bit more on {point}?" },
    { cat: "会议", title: "表达观点", cn: "从产品角度表达关切与建议",
      en: "From the product side, my concern is {…}. I'd suggest we prioritize {…}, because {reason}." },
    { cat: "会议", title: "推进 / 跟进", cn: "明确负责人、截止日期、会后跟进",
      en: "Who will own this action item? Can we set a deadline for it? Let's follow up on {topic} offline." },
    { cat: "会议", title: "没听清", cn: "没听清时的礼貌请求",
      en: "Sorry, could you repeat that? I didn't quite catch the last part. Could you speak a little slower, please?" },
    { cat: "会议", title: "收尾", cn: "总结并结束会议",
      en: "Let's wrap up. To summarize, we agreed on {…}. I'll send out the notes and action items right after the call." },
  ];
  let tplCat = "全部";
  let tplFiltered = [];
  function renderTemplates() {
    const cats = ["全部", ...Array.from(new Set(WRITE_TEMPLATES.map((t) => t.cat)))];
    $("#tplCats").innerHTML = cats
      .map((c) => `<button class="btn small ${c === tplCat ? "primary" : ""}" data-tcat="${escapeHtml(c)}">${escapeHtml(c)}</button>`)
      .join("");
    tplFiltered = WRITE_TEMPLATES.filter((t) => tplCat === "全部" || t.cat === tplCat);
    $("#tplList").innerHTML = tplFiltered
      .map((t, i) => {
        const body = escapeHtml(t.en).replace(/\{([^}]+)\}/g, '<span class="ph">{$1}</span>');
        return `<div class="tpl-card">
          <div class="tpl-head">
            <span class="tpl-title">${escapeHtml(t.title)} <span class="tpl-cn">· ${escapeHtml(t.cn)}</span></span>
            <button class="btn small" data-copy="${i}">复制</button>
          </div>
          <div class="tpl-body">${body}</div>
        </div>`;
      })
      .join("");
  }
  $("#tplCats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tcat]");
    if (!b) return;
    tplCat = b.dataset.tcat;
    renderTemplates();
  });
  $("#tplList").addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    const t = tplFiltered[Number(b.dataset.copy)];
    if (!t) return;
    copyText(t.en, () => {
      b.textContent = "已复制";
      setTimeout(() => (b.textContent = "复制"), 1200);
    });
  });
  $("#writeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-wsub]");
    if (!b) return;
    const sub = b.dataset.wsub;
    $$("#writeSeg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
    $("#wsub-compose").hidden = sub !== "compose";
    $("#wsub-templates").hidden = sub !== "templates";
    if (sub === "compose") startWrite();
    else renderTemplates();
  });

  /* --------------------------------------------------------------- browse */
  function renderBrowse() {
    const q = normalize($("#browseSearch").value);
    let cards = activeCards();
    if (q) {
      cards = cards.filter(
        (c) =>
          normalize(c.front).includes(q) ||
          (c.back || "").toLowerCase().includes(q) ||
          (c.example || "").toLowerCase().includes(q)
      );
    }
    $("#browseCount").textContent = `${cards.length} 条`;
    const body = $("#browseBody");
    if (!cards.length) {
      body.innerHTML = `<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">暂无词条</td></tr>`;
      return;
    }
    const stLabel = { new: "未学", learning: "学习中", known: "已掌握" };
    body.innerHTML = cards
      .map((c) => {
        const st = status(c);
        return `<tr>
          <td class="en">${escapeHtml(c.front)}</td>
          <td>${escapeHtml(c.back)}</td>
          <td class="ex">${renderInline(c.example || "")}</td>
          <td><span class="pill ${st}">${stLabel[st]}</span></td>
          <td><button class="row-del" data-id="${c.id}">删除</button></td>
        </tr>`;
      })
      .join("");
  }
  $("#browseSearch").addEventListener("input", renderBrowse);
  $("#browseBody").addEventListener("click", (e) => {
    const btn = e.target.closest(".row-del");
    if (!btn) return;
    state.cards = state.cards.filter((c) => c.id !== btn.dataset.id);
    save();
    renderBrowse();
    renderCategories();
  });

  /* --------------------------------------------------------------- import */
  let previewEntries = [];
  function doPreview() {
    const text = $("#impText").value;
    const fmt = $("#impFormat").value;
    const cat = $("#impCategory").value.trim();
    const msg = $("#impMsg");
    if (!text.trim()) {
      msg.textContent = "请先粘贴内容或选择文件。"; msg.className = "import-msg err";
      $("#impPreviewWrap").hidden = true; $("#impConfirmBtn").disabled = true;
      return;
    }
    previewEntries = parseInput(text, fmt, cat);
    $("#impPreviewCount").textContent = String(previewEntries.length);
    $("#impPreviewBody").innerHTML = previewEntries
      .slice(0, 200)
      .map(
        (e) => `<tr>
          <td class="en">${escapeHtml(e.front)}</td>
          <td>${escapeHtml(e.back)}</td>
          <td class="ex">${renderInline(e.example || "")}</td>
          <td>${escapeHtml(e.category)}</td>
        </tr>`
      )
      .join("");
    $("#impPreviewWrap").hidden = false;
    if (previewEntries.length) {
      msg.textContent = `解析出 ${previewEntries.length} 条，确认无误后点击"确认导入"。`;
      msg.className = "import-msg ok";
      $("#impConfirmBtn").disabled = false;
    } else {
      msg.textContent = "没有解析出任何词条，请检查格式。";
      msg.className = "import-msg err";
      $("#impConfirmBtn").disabled = true;
    }
  }
  // Add parsed entries to the store, de-duping by category + front text.
  // Returns the number of new cards actually added.
  function addEntries(entries, replaceCats) {
    if (replaceCats) {
      const cats = new Set(entries.map((e) => e.category));
      state.cards = state.cards.filter((c) => !cats.has(c.category));
    }
    const existing = new Set(state.cards.map((c) => c.category + "\u0000" + normalize(c.front)));
    let added = 0;
    for (const e of entries) {
      const key = e.category + "\u0000" + normalize(e.front);
      if (existing.has(key)) continue;
      existing.add(key);
      state.cards.push(
        Object.assign(
          { id: uid(), front: e.front, back: e.back, example: e.example || "", category: e.category },
          newCardFields()
        )
      );
      added++;
    }
    return added;
  }
  function doImport() {
    if (!previewEntries.length) return;
    const added = addEntries(previewEntries, $("#impReplace").checked);
    save();
    const msg = $("#impMsg");
    msg.textContent = `已导入 ${added} 条新词条（跳过重复 ${previewEntries.length - added} 条）。`;
    msg.className = "import-msg ok";
    $("#impText").value = "";
    $("#impPreviewWrap").hidden = true;
    $("#impConfirmBtn").disabled = true;
    previewEntries = [];
    renderCategories();
  }
  $("#impPreviewBtn").addEventListener("click", doPreview);
  $("#impConfirmBtn").addEventListener("click", doImport);
  $("#impFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $("#impText").value = reader.result;
      if (/\.(md|markdown)$/i.test(file.name)) $("#impFormat").value = "markdown";
      else if (/\.csv$/i.test(file.name)) $("#impFormat").value = "csv";
      else if (/\.tsv$/i.test(file.name)) $("#impFormat").value = "tsv";
      doPreview();
    };
    reader.readAsText(file);
  });

  /* --------------------------------------------------------- built-in samples */
  function renderSamples() {
    const samples = window.VOCAB_SAMPLES || [];
    const box = $("#sampleBox");
    if (box) box.hidden = samples.length === 0;
    const existing = new Set(
      state.cards.map((c) => c.category + "\u0000" + normalize(c.front))
    );
    const loaded = (s) =>
      s.cards.length > 0 &&
      s.cards.every((c) => existing.has(c.category + "\u0000" + normalize(c.front)));
    const html = samples
      .map((s) => {
        const on = loaded(s);
        return `<button class="sample-card" data-sample="${escapeHtml(s.id)}" ${on ? "disabled" : ""}>
          <span class="sc-name">${escapeHtml(s.name)}</span>
          <span class="sc-count">${s.count} 词 · ${on ? "已载入" : "点击载入"}</span>
        </button>`;
      })
      .join("");
    ["#sampleList", "#sampleListHome"].forEach((sel) => {
      const el = $(sel);
      if (el) el.innerHTML = html;
    });
  }
  function loadSample(id) {
    const s = (window.VOCAB_SAMPLES || []).find((x) => x.id === id);
    if (!s) return;
    const added = addEntries(s.cards, false);
    save();
    selectedCats.clear();
    renderCategories();
    renderSamples();
    showView("home");
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sample]");
    if (btn && !btn.disabled) loadSample(btn.dataset.sample);
  });

  /* ------------------------------------------------------- backup / restore */
  $("#exportBtn").addEventListener("click", () => {
    const msg = $("#backupMsg");
    if (!state.cards.length) {
      msg.textContent = "没有可导出的数据。"; msg.className = "import-msg err";
      return;
    }
    const payload = {
      app: "vocab-trainer",
      version: 2,
      exportedAt: new Date().toISOString(),
      cards: state.cards,
      // Progress & preferences so a backup fully restores your state.
      goal: state.goal,
      history: state.history,
      skills: state.skills,
      settings: state.settings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `vocab-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    msg.textContent = `已导出 ${state.cards.length} 条。`; msg.className = "import-msg ok";
  });

  $("#restoreFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const msg = $("#backupMsg");
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (_) {
        msg.textContent = "文件不是有效的 JSON。"; msg.className = "import-msg err";
        return;
      }
      const cards = Array.isArray(data) ? data : data && data.cards;
      if (!Array.isArray(cards)) {
        msg.textContent = "未找到词条数据（缺少 cards 字段）。"; msg.className = "import-msg err";
        return;
      }
      const replace = $("#restoreReplace").checked;
      if (replace) state.cards = [];
      const seen = new Set(state.cards.map((c) => c.category + "\u0000" + normalize(c.front)));
      let added = 0;
      for (const raw of cards) {
        if (!raw || !raw.front) continue;
        const card = Object.assign({ id: uid(), category: "未分类" }, newCardFields(), raw);
        card.id = raw.id || uid();
        const key = card.category + "\u0000" + normalize(card.front);
        if (seen.has(key)) continue;
        seen.add(key);
        state.cards.push(card);
        added++;
      }
      // Restore progress & preferences. On "覆盖" we replace them wholesale;
      // on merge we only add cards and leave existing stats untouched (avoids
      // ambiguous double-counting of daily reviews).
      let statsNote = "";
      if (replace && !Array.isArray(data)) {
        if (data.history && typeof data.history === "object") state.history = data.history;
        if (typeof data.goal === "number") state.goal = data.goal;
        if (data.skills && typeof data.skills === "object") {
          state.skills = data.skills;
          ["listen", "speak", "read", "write"].forEach((k) => {
            if (!state.skills[k]) state.skills[k] = { n: 0, ok: 0 };
          });
        }
        if (data.settings && typeof data.settings === "object") {
          state.settings = Object.assign({}, state.settings, data.settings);
          applyTheme();
        }
        statsNote = "，含进度与设置";
      }
      save();
      selectedCats.clear();
      renderCategories();
      msg.textContent = `已恢复 ${added} 条${replace ? "（已覆盖" + statsNote + "）" : "（合并，跳过重复；不含统计）"}。`;
      msg.className = "import-msg ok";
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  /* --------------------------------------------------- export hardest words */
  function downloadFile(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function strugglingCards() {
    return state.cards
      .filter((c) => c.lapses > 0)
      .sort((a, b) => difficultyScore(b) - difficultyScore(a));
  }
  function csvEscape(s) {
    s = String(s == null ? "" : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const stampToday = () => new Date().toISOString().slice(0, 10);

  $("#exportHardMd").addEventListener("click", () => {
    const msg = $("#hardMsg");
    const cards = strugglingCards();
    if (!cards.length) {
      msg.textContent = "暂无易错词（错误次数都为 0）。"; msg.className = "import-msg err";
      return;
    }
    const byCat = {};
    for (const c of cards) (byCat[c.category] = byCat[c.category] || []).push(c);
    let md = `# 难词清单（易错优先）\n\n> 导出时间：${new Date().toLocaleString()}　共 ${cards.length} 词\n\n`;
    for (const [cat, list] of Object.entries(byCat)) {
      md += `## ${cat}\n\n| English | 中文释义 | 例句 | 错误次数 |\n| --- | --- | --- | --- |\n`;
      for (const c of list) {
        md += `| ${c.front} | ${c.back} | ${c.example || ""} | ${c.lapses} |\n`;
      }
      md += "\n";
    }
    downloadFile(`难词清单-${stampToday()}.md`, md, "text/markdown");
    msg.textContent = `已导出 ${cards.length} 个难词。`; msg.className = "import-msg ok";
  });

  $("#exportHardCsv").addEventListener("click", () => {
    const msg = $("#hardMsg");
    const cards = strugglingCards();
    if (!cards.length) {
      msg.textContent = "暂无易错词（错误次数都为 0）。"; msg.className = "import-msg err";
      return;
    }
    // Anki-friendly: two columns "front,back" (back includes example if present).
    const lines = cards.map((c) => {
      const back = c.example ? `${c.back} — ${c.example}` : c.back;
      return csvEscape(c.front) + "," + csvEscape(back);
    });
    downloadFile(`难词-anki-${stampToday()}.csv`, lines.join("\n"), "text/csv");
    msg.textContent = `已导出 ${cards.length} 个难词（CSV）。`; msg.className = "import-msg ok";
  });

  /* ------------------------------------------------------------- clear all */
  $("#clearAllBtn").addEventListener("click", () => {
    if (!state.cards.length) return;
    if (confirm("确定清空所有词汇和学习进度吗？此操作不可撤销。")) {
      // Keep TTS/voice/goal preferences; wipe words and progress.
      state = {
        cards: [], settings: state.settings, history: {}, goal: state.goal,
        skills: { listen: { n: 0, ok: 0 }, speak: { n: 0, ok: 0 }, read: { n: 0, ok: 0 }, write: { n: 0, ok: 0 } },
      };
      selectedCats.clear();
      save();
      renderCategories();
      showView("home");
    }
  });

  /* -------------------------------------------------------------- dark mode */
  function applyTheme() {
    const dark = state.settings.theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const btn = $("#themeToggle");
    if (btn) {
      btn.textContent = dark ? "☀️" : "🌙";
      btn.title = dark ? "切换浅色模式" : "切换深色模式";
    }
  }
  $("#themeToggle").addEventListener("click", () => {
    state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
    save();
    applyTheme();
  });

  /* ------------------------------------------------------ keyboard shortcuts */
  // Flashcards: Space/Enter flips, 1-4 grades. Quiz: 1-9 picks an option.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    const view = $(".tab.active") ? $(".tab.active").dataset.view : "";
    if (view === "flashcard") {
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault();
        flipCard();
      } else if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        gradeCard(Number(e.key) - 1);
      }
    } else if (view === "quiz") {
      if (e.key >= "1" && e.key <= "9") {
        const opts = $$("#qzOptions .quiz-opt");
        const opt = opts[Number(e.key) - 1];
        if (opt) {
          e.preventDefault();
          answerQuiz(opt);
        }
      }
    }
  });

  /* ----------------------------------------------------------------- init */
  if (!SpeechRec) {
    // No speech recognition: hide the speaking entry points.
    const t = document.querySelector('.tab[data-view="speak"]');
    if (t) t.style.display = "none";
    const q = document.getElementById("speakQuick");
    if (q) q.style.display = "none";
  }
  applyTheme();
  initReading();
  renderCategories();
  showView("home");
  maybeNotifyDue();

  // Register the service worker for offline use (only when served over http/https;
  // no-ops for the single-file / file:// build).
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
