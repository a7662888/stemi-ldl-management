/* ==========================================================================
   lecture-deck-workflow 播放引擎（2026-10-27）
   - 單一 index.html：<main id="k-stage"> 內每頁 <section class="k-slide" data-chapter data-title>
   - 逐步揭示：頁內元素加 data-s="n"（第 n 步出現）；每頁步數 = 最大的 data-s
   - 逐字稿：頁內 <template class="k-narr"><p data-step="n">一句一拍</p>…</template>
     （build_narration.py 抽成 narration.json → 配音 → build_beats.py 產 beats.js）
   - 兩種模式：主講（自己翻頁、N 講稿、O 總覽、B 黑屏）／自動播放（配音＋字幕＋配樂可各自開關）
   - 離線：不用 fetch、不連外網；音檔以相對路徑 <audio> 播放，file:// 直接開即可
   網址參數：?mode=present|auto  ?voice=m|f|off  ?sub=0  ?bgm=0  ?all=1（全部展開，截圖／PDF 用）  #12 跳第 12 頁
   ========================================================================== */
(() => {
  const $ = s => document.querySelector(s);
  const Q = new URLSearchParams(location.search);
  const showAll = Q.get('all') === '1';
  const stage = $('#k-stage');
  const slides = [...document.querySelectorAll('.k-slide')];
  const A = window.DECK_AUDIO || { voices: {}, bgm: null, beats: [] };
  const BEATS = A.beats || [];
  const pad = n => String(n).padStart(2, '0');

  /* ---------- 縮放：左上角為原點＋明確平移（行動裝置不會把舞台推出畫面） ---------- */
  const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;   // 手機、平板（觸控筆電仍算桌機）
  function fit() {
    const vv = window.visualViewport;
    const w = vv ? vv.width : innerWidth, h = vv ? vv.height : innerHeight;
    let s = Math.min(w / 1920, h / 1080), rsv = 0;
    // 觸控橫放、上下沒空間又左右沒留白（16:9 手機）→ 右側讓出 40px 給 ☰，簡報不被蓋
    if (TOUCH && (h - 1080 * s) / 2 < 64 && (w - 1920 * s) / 2 < 40) { rsv = 40; s = Math.min((w - rsv) / 1920, h / 1080); }
    stage.style.transform = `translate(${(w - rsv - 1920 * s) / 2}px, ${(h - 1080 * s) / 2}px) scale(${s})`;
    // 手機：簡報下方空白夠放控制列（直放）→ 控制列移到簡報下方、常駐；不夠（橫放）→ 平時隱藏、點畫面才出現
    const free = (h - 1080 * s) / 2;
    const below = free >= 64;
    document.body.classList.toggle('ctl-below', below);
    document.body.classList.toggle('ctl-tap', !below && TOUCH);
    const c = document.getElementById('k-ctl');
    if (c) c.style.top = below ? `${(h + 1080 * s) / 2 + 10}px` : '';
  }
  addEventListener('resize', fit);
  if (document.fonts) document.fonts.ready.then(() => slides[cur] && fitHead(slides[cur]));
  addEventListener('orientationchange', () => setTimeout(fit, 150));
  if (window.visualViewport) visualViewport.addEventListener('resize', fit);
  fit();

  /* ---------- 每頁步數、章節膠囊 ---------- */
  slides.forEach(s => {
    s.dataset.steps = Math.max(+s.dataset.minsteps || 0, ...[...s.querySelectorAll('[data-s],[data-reveal]')].map(e => +(e.dataset.s || e.dataset.reveal) || 0));   // data-minsteps：頁面沒有逐步元素但要用步數（CSS 標亮）時
  });
  const chapters = [];
  slides.forEach((s, i) => { const c = s.dataset.chapter; if (c && !chapters.find(x => x.name === c)) chapters.push({ name: c, first: i }); });
  slides.forEach(s => {
    if (s.classList.contains('k-cover') || s.dataset.nonav === '1' || chapters.length < 2) return;
    const nav = document.createElement('nav'); nav.className = 'k-nav';
    chapters.forEach(c => {
      const b = document.createElement('button'); b.textContent = c.name;
      if (c.name === s.dataset.chapter) b.classList.add('on');
      b.addEventListener('click', e => { e.stopPropagation(); if (mode === 'auto') jumpBeatToSlide(c.first); else go(c.first, 0); });
      nav.appendChild(b);
    });
    s.appendChild(nav);
  });

  /* ---------- 逐字稿（講稿面板與無配音時的計時都用它） ---------- */
  const narr = slides.map(s => {
    const t = s.querySelector('template.k-narr');
    if (!t) return [];
    return [...t.content.querySelectorAll('p')].map(p => ({ step: +(p.dataset.step || 0), text: p.textContent.trim() }));
  });

  /* ---------- 狀態 ---------- */
  let cur = 0, step = 0, mode = null;          // mode: 'present' | 'auto'
  let voice = null, subOn = true, bgmOn = true, playing = false, beatIdx = -1, timer = null, subTimer = null;
  const chrome = { chap: $('#k-chapter'), bar: $('#k-bar'), counter: $('#k-counter') };
  const vEl = $('#k-voice'), bEl = $('#k-bgm'), sub = $('#k-sub');
  if (A.bgm && bEl) bEl.src = A.bgm;

  function render() {
    slides.forEach((s, i) => s.classList.toggle('is-active', i === cur));
    const s = slides[cur];
    fitHead(s);
    s.dataset.step = showAll ? 'all' : step;   // CSS 可用 .k-slide[data-step="2"] 做步數相依的樣式
    s.querySelectorAll('[data-s]').forEach(el => el.classList.toggle('on', showAll || step >= +el.dataset.s));
    // data-sto="m"：第 m 步之後隱藏（換掉圖表／分頁內容）；?all=1 呈現最後狀態，被取代的也隱藏
    s.querySelectorAll('[data-sto]').forEach(el => el.classList.toggle('k-gone', step > +el.dataset.sto));
    // 分頁按鈕 data-step-btn="n"：目前步數落在 [n, 下一個按鈕) 時呈按下狀態
    const btns = [...s.querySelectorAll('[data-step-btn]')].sort((a, b) => a.dataset.stepBtn - b.dataset.stepBtn);
    btns.forEach((b, k) => { const lo = +b.dataset.stepBtn, hi = btns[k + 1] ? +btns[k + 1].dataset.stepBtn : 1e9;
      b.setAttribute('aria-pressed', step >= lo && step < hi); });
    document.dispatchEvent(new CustomEvent('k-step', { detail: { slide: cur, step, el: s, all: showAll } }));
    s.querySelectorAll('[data-reveal]').forEach(el => { if (showAll || step >= +el.dataset.reveal) el.classList.add('shown'); });
    if (chrome.chap) chrome.chap.textContent = s.dataset.chapter || '';
    if (chrome.counter) chrome.counter.textContent = `${pad(cur + 1)} / ${pad(slides.length)}`;
    if (chrome.bar) chrome.bar.style.width = `${(cur + 1) / slides.length * 100}%`;
    if (location.hash !== `#${cur + 1}`) history.replaceState(null, '', `${location.search}#${cur + 1}`);
    renderNotes();
  }
  /* 標題自動保持一行：不同手機／瀏覽器字寬不同，標題一折行就把整頁往下推、壓到結論條。
     折行時逐步縮小字級（最多到 82%），量測在頁面顯示時做。 */
  function fitHead(sl) {
    const h = sl.querySelector('.k-head h2'); if (!h) return;
    if (!h.dataset.fs) h.dataset.fs = parseFloat(getComputedStyle(h).fontSize);
    const base = +h.dataset.fs; let fs = base; h.style.fontSize = base + 'px';
    const one = () => h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight) < 1.5;
    while (!one() && fs > base * 0.82) { fs -= base * 0.03; h.style.fontSize = fs + 'px'; }
  }
  function go(i, st = 0) { cur = Math.max(0, Math.min(slides.length - 1, i)); step = st; render(); }
  function next() {
    if (step < +slides[cur].dataset.steps) { step++; render(); }
    else if (cur < slides.length - 1) go(cur + 1, 0);
  }
  function prev() {
    if (step > 0) { step--; render(); }
    else if (cur > 0) go(cur - 1, +slides[cur - 1].dataset.steps);
  }

  /* ---------- 講稿面板（N）：顯示逐字稿，目前這一步的句子標亮 ---------- */
  const notes = $('#k-notes'), notesBody = $('#k-notesbody');
  function renderNotes() {
    if (!notesBody) return;
    const lines = narr[cur];
    const extra = slides[cur].dataset.notes;
    notesBody.innerHTML = (lines.length ? lines.map(l =>
      `<p class="${l.step === step ? 'now' : ''}"><span class="st">${l.step}</span>${l.text}</p>`).join('') : '') +
      (extra ? `<p style="color:var(--muted)">${extra}</p>` : '');
  }

  /* ---------- 總覽（O） ---------- */
  const ov = $('#k-overview'), ovgrid = $('#k-ovgrid');
  if (ovgrid) slides.forEach((s, i) => {
    const c = document.createElement('button'); c.className = 'k-ovcell';
    c.innerHTML = `<b>${pad(i + 1)}</b>${s.dataset.title || ''}`;
    c.addEventListener('click', () => { ov.classList.remove('on'); if (mode === 'auto') jumpBeatToSlide(i); else go(i, 0); });
    ovgrid.appendChild(c);
  });
  const toggle = el => el && el.classList.toggle('on');

  /* ---------- 分頁按鈕：點了直接跳到該步（自動播放中則暫停在那一步） ---------- */
  document.querySelectorAll('[data-step-btn]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); if (mode === 'auto' && playing) pauseAuto(); step = +b.dataset.stepBtn; render();
  }));

  /* ---------- 頁內互動元件（點選揭曉；自動播放時依 data-reveal 步數自動揭曉） ---------- */
  document.querySelectorAll('.k-opt, .k-flip').forEach(o => {
    o.addEventListener('click', () => o.classList.toggle('shown'));
    if (showAll) o.classList.add('shown');
  });

  /* ---------- 原文圖點選放大（img.zoom；Click anywhere to close） ---------- */
  document.addEventListener('click', e => {
    const ov0 = document.getElementById('k-zoom');
    if (ov0) { ov0.remove(); return; }
    const img = e.target.closest('img.zoom');
    if (!img) return;
    const o = document.createElement('div'); o.id = 'k-zoom';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(20,28,38,.92);z-index:50;display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    o.innerHTML = `<img src="${img.getAttribute('src')}" style="max-width:96vw;max-height:92vh;background:#fff;border-radius:8px">` +
      '<div style="position:absolute;top:16px;right:26px;color:#fff;font-size:22px;font-weight:700">Click anywhere to close ✕</div>';
    document.body.appendChild(o);
  });

  /* ==========================================================================
     自動播放：一拍＝一句旁白；開始時切到該頁、揭示到該拍的步數
     ========================================================================== */
  const hasVoice = v => !!(A.voices && A.voices[v] && BEATS.length && BEATS.every(b => b.dur && b.dur[v]));
  const estDur = b => Math.max(1.6, b.text.replace(/\s/g, '').length / 4.0);   // 無Voice: 約每秒 4 字
  const beatDur = b => (voice !== 'off' && b.dur && b.dur[voice]) ? b.dur[voice] : estDur(b);

  function chunks(text) {   // 字幕：依標點切成 ≤ 22 字的短行
    const parts = text.split(/(?<=[，。；：！？、])/).reduce((acc, p) => {
      const last = acc[acc.length - 1];
      if (last && (last + p).length <= 22) acc[acc.length - 1] = last + p; else acc.push(p);
      return acc;
    }, []);
    return parts.map(p => p.replace(/[，、；：]$/, ''));
  }
  function showSubs(b, dur) {
    clearInterval(subTimer);
    if (!subOn) { sub.classList.remove('on'); return; }
    const cs = chunks(b.text), total = cs.reduce((a, c) => a + c.length, 0) || 1;
    let k = 0, acc = 0; const t0 = performance.now();
    const marks = cs.map(c => (acc += c.length) / total * dur * 1000);
    sub.textContent = cs[0]; sub.classList.add('on');
    subTimer = setInterval(() => {
      const t = performance.now() - t0;
      while (k < cs.length - 1 && t > marks[k]) { k++; sub.textContent = cs[k]; }
    }, 80);
  }
  function hideSubs() { clearInterval(subTimer); sub.classList.remove('on'); }
  function duck(on) { if (bEl) bEl.volume = on ? 0.32 : 0.6; }

  function playBeat(i) {
    clearTimeout(timer); vEl && vEl.pause();
    if (i >= BEATS.length) { finish(); return; }
    beatIdx = i;
    const b = BEATS[i];
    const G = A.gaps || {};   // deck.config.json 的 gaps（毫秒）：beat＝同頁換句、slide＝換頁
    const gap = (i > 0 && BEATS[i - 1].slide !== b.slide) ? (G.slide || 700) : (G.beat || 280);
    if (cur !== b.slide - 1 || step < b.step) go(b.slide - 1, b.step);
    else { step = b.step; render(); }
    updClock();
    const dur = beatDur(b);
    showSubs(b, dur);
    if (voice !== 'off' && vEl) {
      vEl.src = `${A.voices[voice].dir}/${b.id}.mp3`;
      duck(true);
      vEl.onended = () => { duck(false); hideSubsSoon(); timer = setTimeout(() => playing && playBeat(i + 1), gap); };
      vEl.play().catch(() => { timer = setTimeout(() => playing && playBeat(i + 1), dur * 1000 + gap); });
    } else {
      timer = setTimeout(() => { hideSubsSoon(); if (playing) playBeat(i + 1); }, dur * 1000 + gap);
    }
  }
  function hideSubsSoon() { clearInterval(subTimer); setTimeout(() => { if (!playing || vEl.paused) sub.classList.remove('on'); }, 250); }
  function startAuto(fromBeat = 0) {
    playing = true; setPlayBtn();
    if (bgmOn && bEl && A.bgm) { duck(false); bEl.play().catch(() => {}); }
    playBeat(fromBeat);
  }
  function pauseAuto() {
    playing = false; setPlayBtn(); clearTimeout(timer); vEl && vEl.pause(); hideSubs(); bEl && bEl.pause();
  }
  function resumeAuto() { if (beatIdx < 0) startAuto(0); else startAuto(beatIdx); }
  function jumpBeat(d) { const n = Math.max(0, Math.min(BEATS.length - 1, beatIdx + d)); if (playing) playBeat(n); else { beatIdx = n; const b = BEATS[n]; go(b.slide - 1, b.step); updClock(); } }
  function jumpBeatToSlide(si) {
    const n = BEATS.findIndex(b => b.slide === si + 1);
    if (n < 0) { go(si, 0); return; }
    if (playing) playBeat(n); else { beatIdx = n; go(si, BEATS[n].step); }
  }
  function finish() { pauseAuto(); beatIdx = -1; $('#k-end') && $('#k-end').classList.add('on'); }

  /* ---------- 控制列 ---------- */
  const ctl = $('#k-ctl');
  const bPlay = $('#kb-play'), bSub = $('#kb-sub'), bBgm = $('#kb-bgm'), bVoice = $('#kb-voice'), clock = $('#kb-time');
  const voiceLabel = () => voice === 'off' ? 'Voice: Off' : `Voice: ${(A.voices[voice] && A.voices[voice].short) || voice}`;
  function setPlayBtn() { if (bPlay) bPlay.textContent = playing ? '❚❚ Pause' : '▶ Play'; }
  function setToggles() {
    if (bSub) bSub.setAttribute('aria-pressed', subOn);
    if (bBgm) { bBgm.setAttribute('aria-pressed', bgmOn); bBgm.style.display = A.bgm ? '' : 'none'; }
    if (bVoice) bVoice.textContent = voiceLabel();
  }
  const total = () => BEATS.reduce((a, b) => a + beatDur(b), 0);
  const mmss = s => `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}`;
  function updClock() { if (clock && BEATS.length) clock.textContent = `${mmss(BEATS.slice(0, Math.max(0, beatIdx)).reduce((a, b) => a + beatDur(b), 0))} / ${mmss(total())}`; }
  const on = (el, f) => el && el.addEventListener('click', e => { e.currentTarget.blur(); f(); });
  on(bPlay, () => playing ? pauseAuto() : resumeAuto());
  on($('#kb-prev'), () => mode === 'auto' ? jumpBeat(-1) : prev());
  on($('#kb-next'), () => mode === 'auto' ? jumpBeat(1) : next());
  on(bSub, () => { subOn = !subOn; if (!subOn) hideSubs(); setToggles(); save(); });
  on(bBgm, () => { bgmOn = !bgmOn; if (!bgmOn) bEl.pause(); else if (playing || mode === 'present') bEl.play().catch(() => {}); setToggles(); save(); });
  on(bVoice, () => {   // 依序切換：可用的聲音 → 關
    const order = Object.keys(A.voices).filter(hasVoice).concat('off');
    voice = order[(order.indexOf(voice) + 1) % order.length];
    setToggles(); save(); if (playing) playBeat(beatIdx);
  });
  on($('#kb-menu'), () => openMenu());
  on($('#kb-notes'), () => toggle(notes));
  on($('#kb-ov'), () => toggle(ov));
  on($('#kb-fs'), () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
  let idle;
  function wake() {
    if (!ctl) return;
    ctl.classList.remove('hide'); clearTimeout(idle);
    if (document.body.classList.contains('ctl-below')) return;          // 直放：控制列在簡報下方，常駐
    idle = setTimeout(() => ctl.classList.add('hide'), TOUCH ? 2500 : 3000);
  }
  // 桌機：滑鼠移動或按鍵叫出控制列。手機：不因點畫面而跳出（主講要一直點下一步），改用右下角 ☰
  (TOUCH ? ['keydown'] : ['mousemove', 'pointerdown', 'keydown']).forEach(ev => addEventListener(ev, wake, { passive: true }));
  const handle = document.createElement('button');
  handle.id = 'k-handle'; handle.textContent = '☰'; handle.setAttribute('aria-label', 'Show Controls');
  document.body.appendChild(handle);
  handle.addEventListener('click', e => { e.stopPropagation(); if (ctl && !ctl.classList.contains('hide') && !document.body.classList.contains('ctl-below')) ctl.classList.add('hide'); else wake(); });
  if (ctl) ctl.addEventListener('click', () => wake());   // 操作控制列時延長顯示
  // 手機主講：點畫面右側 2/3＝下一步、左側 1/3＝上一步（點到按鈕、選項、圖片等互動元件時照常互動）
  const INTERACTIVE = 'button,a,input,label,select,textarea,.k-opt,.k-flip,img.zoom,td.cell,[data-step-btn],.k-nav,#k-ctl,#k-start,#k-handle,#k-overview,#k-notes,#k-end,#k-zoom';
  // iOS Safari 點在非互動區域不送 click，所以用 pointer 事件自己判斷「輕點」（位移 <12px、<450ms；滑動另由 touchend 處理）
  let pd = null;
  document.addEventListener('pointerdown', e => { pd = (e.pointerType === 'touch' || TOUCH) ? { x: e.clientX, y: e.clientY, t: Date.now(), el: e.target } : null; }, { passive: true });
  document.addEventListener('pointerup', e => {
    if (!pd || !TOUCH || mode !== 'present') return;
    const d = pd; pd = null;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || Date.now() - d.t > 450) return;
    if (d.el.closest(INTERACTIVE)) return;
    if ($('#k-overview')?.classList.contains('on') || $('#k-notes')?.classList.contains('on') || $('#k-black')?.classList.contains('on')) return;
    e.clientX < innerWidth / 3 ? prev() : next();
  }, { passive: true });

  /* ---------- 鍵盤 ---------- */
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || !mode) return;
    const k = e.key;
    if (k === 'Escape') { [ov, notes, $('#k-black')].forEach(p => p && p.classList.remove('on')); return; }
    if (k === 'o' || k === 'O') return toggle(ov);
    if (k === 'n' || k === 'N') return toggle(notes);
    if (k === 'f' || k === 'F') return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
    if (k === 's' || k === 'S') return bSub && bSub.click();
    if (k === 'm' || k === 'M') return bBgm && bBgm.click();
    if (mode === 'auto') {
      if (k === ' ') { e.preventDefault(); playing ? pauseAuto() : resumeAuto(); }
      else if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); jumpBeat(1); }
      else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); jumpBeat(-1); }
      return;
    }
    switch (k) {
      case 'ArrowRight': case 'PageDown': case ' ': case 'Enter': e.preventDefault(); next(); break;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); prev(); break;
      case 'Home': go(0, 0); break;
      case 'End': go(slides.length - 1, +slides[slides.length - 1].dataset.steps); break;
      case 'b': case 'B': case '.': toggle($('#k-black')); break;
    }
  });
  let tx = 0;
  addEventListener('touchstart', e => { tx = e.changedTouches[0].clientX; }, { passive: true });
  addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 70 && mode) (dx < 0 ? (mode === 'auto' ? jumpBeat(1) : next()) : (mode === 'auto' ? jumpBeat(-1) : prev()));
  }, { passive: true });

  /* ==========================================================================
     開場選單：主講（我來控制）／自動播放（選配音、字幕、配樂）
     ========================================================================== */
  const KEY = 'lecture-deck:' + (document.title || location.pathname);
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ voice, subOn, bgmOn })); } catch (_) {} }
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); if (o.voice) voice = o.voice; if (o.subOn !== undefined) subOn = o.subOn; if (o.bgmOn !== undefined) bgmOn = o.bgmOn; } catch (_) {}
  const firstVoice = Object.keys(A.voices || {}).find(hasVoice);
  if (!voice || (voice !== 'off' && !hasVoice(voice))) voice = firstVoice || 'off';   // 預設：第一個已配好的聲音
  if (Q.get('voice')) voice = Q.get('voice') === 'off' || !hasVoice(Q.get('voice')) ? 'off' : Q.get('voice');
  if (Q.get('sub') === '0') subOn = false;
  if (Q.get('bgm') === '0') bgmOn = false;

  const menu = $('#k-start');
  function buildMenu() {
    if (!menu) return;
    const vbox = menu.querySelector('[data-opt="voice"]');
    if (vbox) {
      const opts = Object.keys(A.voices || {}).map(k => [k, A.voices[k].label || k]).concat([['off', 'Voice Off (Subtitles Only)']]);
      vbox.innerHTML = '<b>Voice</b>' + opts.map(([k, lab]) =>
        `<label class="${k !== 'off' && !hasVoice(k) ? 'dis' : ''}"><input type="radio" name="kv" value="${k}" ${k === voice ? 'checked' : ''}>${lab}</label>`).join('');
      vbox.addEventListener('change', e => { voice = e.target.value; save(); setToggles(); });
    }
    const sbox = menu.querySelector('[data-opt="sub"] input'), mbox = menu.querySelector('[data-opt="bgm"] input');
    if (sbox) { sbox.checked = subOn; sbox.addEventListener('change', () => { subOn = sbox.checked; save(); setToggles(); }); }
    if (mbox) {
      mbox.checked = bgmOn && !!A.bgm; if (!A.bgm) mbox.closest('label').classList.add('dis');
      mbox.addEventListener('change', () => { bgmOn = mbox.checked; save(); setToggles(); });
    }
    const autoBtn = menu.querySelector('#kgo-auto');
    if (autoBtn && !BEATS.length) { autoBtn.disabled = true; autoBtn.textContent = 'Narration beats not generated yet'; }
    on(menu.querySelector('#kgo-present'), () => enter('present'));
    on(autoBtn, () => enter('auto'));
  }
  function enter(m) {
    mode = m; document.body.classList.remove('present', 'auto'); document.body.classList.add(m);
    menu && menu.classList.add('off'); $('#k-end') && $('#k-end').classList.remove('on');
    setToggles(); if (!TOUCH || document.body.classList.contains('ctl-below')) wake(); else ctl && ctl.classList.add('hide');
    if (TOUCH && m === 'present' && !sessionStorage.getItem('k-taphint')) {
      try { sessionStorage.setItem('k-taphint', '1'); } catch (_) {}
      const t = document.createElement('div'); t.id = 'k-toast';
      t.textContent = 'Tap right: Next | Tap left: Previous | Bottom-right ☰: Controls';
      document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
    }
    if (m === 'auto') { const n = Math.max(0, BEATS.findIndex(b => b.slide >= cur + 1)); startAuto(cur === 0 ? 0 : n); }
    else { pauseAuto(); }
  }
  function openMenu() { pauseAuto(); mode = null; document.body.classList.remove('present', 'auto'); menu && menu.classList.remove('off'); }
  on($('#kend-again'), () => { $('#k-end').classList.remove('on'); go(0, 0); enter('auto'); }); on($('#kend-replay'), () => { $('#k-end').classList.remove('on'); go(0, 0); enter('auto'); }); on($('#kend-present'), () => { $('#k-end').classList.remove('on'); go(0, 0); enter('present'); });
  on($('#kend-menu'), () => { $('#k-end').classList.remove('on'); go(0, 0); openMenu(); });

  /* ---------- 啟動 ---------- */
  const h = location.hash.match(/^#(\d+)$/);
  go(h ? +h[1] - 1 : 0, 0);
  buildMenu(); setToggles(); setPlayBtn(); updClock();
  if (showAll) { menu && menu.classList.add('off'); mode = 'present'; document.body.classList.add('present', 'all'); step = 99; render(); }
  else if (Q.get('mode') === 'present' || Q.get('mode') === 'auto') enter(Q.get('mode'));
  addEventListener('hashchange', () => { const m = location.hash.match(/^#(\d+)$/); if (m && +m[1] - 1 !== cur) go(+m[1] - 1, 0); });
  window.__deck = { go, next, prev, get state() { return { cur, step, mode, voice, subOn, bgmOn, playing, beatIdx }; } };
})();
