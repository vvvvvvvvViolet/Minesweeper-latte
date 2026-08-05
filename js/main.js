/*
 * Minesweeper Latte - UI controller.
 * Wires the game logic to the DOM, and owns the undo history + timer.
 */
(function (global) {
  'use strict';

  var MS = global.Minesweeper;
  var Storage = global.MinesweeperStorage;
  var HISTORY_LIMIT = 40;
  var LONG_PRESS_MS = 450;

  var el = {};
  var game = null;
  var cells = [];
  var history = [];
  var undoUsed = 0;
  var timer = { accumulated: 0, startedAt: 0, running: false, handle: 0 };
  var pendingModalAction = null;
  var tapMode = 'dig'; // 'dig' | 'flag' — what a plain tap/click does
  var touch = { timer: 0, index: -1, handled: false, moved: false, startX: 0, startY: 0 };

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheElements();
    populateDifficulties();
    bindEvents();
    setTapMode('dig');
    registerServiceWorker();

    // The instructions are handy on a desktop, but they push the board off
    // a phone screen, so collapse them there.
    el.help.open = global.matchMedia ? global.matchMedia('(min-width: 721px)').matches : true;

    var auto = Storage.loadAuto();
    if (auto && auto.snapshot && !isFinished(auto.snapshot.status)) {
      applySave(auto);
      toast('เล่นต่อจากเกมที่ค้างไว้');
    } else {
      startGame('beginner');
    }
  }

  function cacheElements() {
    [
      'board', 'mine-count', 'timer', 'status-face', 'undo-btn', 'save-btn',
      'load-btn', 'new-btn', 'difficulty', 'custom-fields', 'custom-rows',
      'custom-cols', 'custom-mines', 'custom-apply', 'message', 'undo-count',
      'modal', 'modal-title', 'modal-slots', 'modal-close', 'best-times', 'toast',
      'mode-dig', 'mode-flag', 'help'
    ].forEach(function (id) {
      el[camel(id)] = document.getElementById(id);
    });
  }

  function camel(id) {
    return id.replace(/-([a-z])/g, function (_, ch) { return ch.toUpperCase(); });
  }

  /** Builds the difficulty menu from the presets, so the list lives in one place. */
  function populateDifficulties() {
    MS.PRESET_ORDER.forEach(function (key) {
      var preset = MS.DIFFICULTIES[key];
      var option = document.createElement('option');
      option.value = key;
      option.textContent = preset.label + ' · ' + preset.rows + '×' + preset.cols +
        ' · ' + preset.mines + ' ลูก';
      el.difficulty.appendChild(option);
    });

    var custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'กำหนดเอง';
    el.difficulty.appendChild(custom);
    el.difficulty.value = 'beginner';
  }

  function bindEvents() {
    el.modeDig.addEventListener('click', function () { setTapMode('dig'); });
    el.modeFlag.addEventListener('click', function () { setTapMode('flag'); });

    el.newBtn.addEventListener('click', function () { startGame(el.difficulty.value); });
    el.statusFace.addEventListener('click', function () { startGame(el.difficulty.value); });
    el.undoBtn.addEventListener('click', undo);
    el.saveBtn.addEventListener('click', function () { openModal('save'); });
    el.loadBtn.addEventListener('click', function () { openModal('load'); });
    el.modalClose.addEventListener('click', closeModal);
    el.modal.addEventListener('click', function (e) {
      if (e.target === el.modal) closeModal();
    });

    el.difficulty.addEventListener('change', function () {
      var custom = el.difficulty.value === 'custom';
      el.customFields.hidden = !custom;
      if (!custom) startGame(el.difficulty.value);
    });
    el.customApply.addEventListener('click', function () { startGame('custom'); });

    el.board.addEventListener('click', onBoardClick);
    el.board.addEventListener('dblclick', onBoardDblClick);
    el.board.addEventListener('contextmenu', onBoardContextMenu);
    el.board.addEventListener('mousedown', onBoardMouseDown);
    el.board.addEventListener('touchstart', onTouchStart, { passive: true });
    el.board.addEventListener('touchmove', onTouchMove, { passive: true });
    el.board.addEventListener('touchend', onTouchEnd);
    el.board.addEventListener('touchcancel', cancelLongPress);
    el.board.addEventListener('keydown', onBoardKeyDown);

    document.addEventListener('keydown', onGlobalKeyDown);
    global.addEventListener('beforeunload', autosave);
  }

  /** Registers the offline cache. Needs a secure context, so file:// opts out. */
  function registerServiceWorker() {
    if (!global.navigator || !global.navigator.serviceWorker) return;
    if (global.location.protocol === 'file:' || !global.isSecureContext) return;
    global.addEventListener('load', function () {
      global.navigator.serviceWorker.register('sw.js').catch(function () {
        // Offline support is a bonus; the game works fine without it.
      });
    });
  }

  /**
   * Phones have no right-click, so a tap mode decides what a plain tap does.
   * A long press always performs the other action.
   */
  function setTapMode(mode) {
    tapMode = mode;
    var digging = mode === 'dig';
    el.modeDig.classList.toggle('is-active', digging);
    el.modeFlag.classList.toggle('is-active', !digging);
    el.modeDig.setAttribute('aria-pressed', String(digging));
    el.modeFlag.setAttribute('aria-pressed', String(!digging));
    el.board.classList.toggle('is-flagmode', !digging);
  }

  /* ---------------------------------------------------------------- game */

  function startGame(difficulty) {
    var config;
    if (difficulty === 'custom') {
      config = {
        rows: MS.clamp(el.customRows.value, MS.LIMITS.minRows, MS.LIMITS.maxRows),
        cols: MS.clamp(el.customCols.value, MS.LIMITS.minCols, MS.LIMITS.maxCols),
        mines: parseInt(el.customMines.value, 10) || 10,
        difficulty: 'custom'
      };
    } else {
      var preset = MS.DIFFICULTIES[difficulty] || MS.DIFFICULTIES.beginner;
      config = { rows: preset.rows, cols: preset.cols, mines: preset.mines, difficulty: difficulty };
    }

    game = new MS.Game(config);
    if (difficulty === 'custom') syncCustomFields();

    history = [];
    undoUsed = 0;
    resetTimer();
    buildBoard();
    render();
    renderBestTimes();
    Storage.clearAuto();
    setMessage('คลิกช่องไหนก็ได้เพื่อเริ่ม — ช่องแรกปลอดภัยเสมอ');
  }

  function syncCustomFields() {
    el.customRows.value = game.rows;
    el.customCols.value = game.cols;
    el.customMines.value = game.mines;
  }

  /** Saves the current position so `undo` can step back to it. */
  function pushHistory() {
    history.push({ snapshot: game.snapshot(), elapsed: elapsedMs() });
    if (history.length > HISTORY_LIMIT) history.shift();
  }

  function act(fn) {
    if (game.isOver()) return;
    pushHistory();
    var changed = fn();
    if (!changed) {
      history.pop();
      return;
    }
    if (game.status === 'playing') startTimer();
    if (game.isOver()) finishGame();
    render();
    autosave();
  }

  function undo() {
    if (!history.length) {
      toast('ไม่มีตาที่ย้อนกลับได้แล้ว');
      return;
    }
    var wasOver = game.isOver();
    var entry = history.pop();
    game.restore(entry.snapshot);
    undoUsed++;

    if (game.status === 'ready') {
      resetTimer();
    } else if (wasOver && !game.isOver()) {
      // Undoing a losing move puts us back into play: rewind the clock to
      // that position and start counting again.
      resetTimer();
      timer.accumulated = entry.elapsed;
      startTimer();
    }

    render();
    autosave();
    setMessage('ย้อนกลับ 1 ตา (ย้อนแล้ว ' + undoUsed + ' ครั้ง — สถิติเวลาจะไม่ถูกบันทึก)');
  }

  function finishGame() {
    stopTimer();
    if (game.status === 'won') {
      var seconds = Math.floor(elapsedMs() / 1000);
      var isRecord = Storage.recordBestTime(game.difficulty, seconds, undoUsed === 0);
      renderBestTimes();
      setMessage(isRecord
        ? 'ชนะแล้ว! สถิติใหม่ ' + seconds + ' วินาที 🎉'
        : 'ชนะแล้ว! ใช้เวลา ' + seconds + ' วินาที' + (undoUsed ? ' (ใช้ย้อนกลับ ' + undoUsed + ' ครั้ง)' : ''));
    } else {
      setMessage('เหยียบระเบิด! กด "ย้อนกลับ" เพื่อแก้ตาล่าสุด หรือเริ่มเกมใหม่');
    }
  }

  function isFinished(status) {
    return status === 'won' || status === 'lost';
  }

  /* ----------------------------------------------------------- rendering */

  function buildBoard() {
    el.board.innerHTML = '';
    cells = [];
    el.board.style.setProperty('--cols', game.cols);
    el.board.style.setProperty('--rows', game.rows);
    // Wide boards get smaller cells so they need less sideways scrolling.
    el.board.classList.toggle('board--wide', game.cols > 20);
    el.board.setAttribute('aria-rowcount', game.rows);
    el.board.setAttribute('aria-colcount', game.cols);

    var frag = document.createDocumentFragment();
    for (var r = 0; r < game.rows; r++) {
      for (var c = 0; c < game.cols; c++) {
        var cell = document.createElement('button');
        var idx = r * game.cols + c;
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.index = idx;
        cell.dataset.row = r;
        cell.dataset.col = c;
        cell.tabIndex = idx === 0 ? 0 : -1;
        frag.appendChild(cell);
        cells.push(cell);
      }
    }
    el.board.appendChild(frag);
  }

  function render() {
    for (var i = 0; i < cells.length; i++) renderCell(i);

    el.mineCount.textContent = pad3(game.minesLeft());
    el.undoBtn.disabled = history.length === 0;
    el.undoCount.textContent = history.length ? '(' + history.length + ')' : '';
    el.statusFace.textContent = game.status === 'won' ? '😎' : game.status === 'lost' ? '😵' : '🙂';
    el.board.classList.toggle('is-over', game.isOver());
    el.board.setAttribute('aria-label', 'กระดาน ' + game.rows + ' คูณ ' + game.cols + ' มีระเบิด ' + game.mines + ' ลูก');
    updateTimerDisplay();
  }

  function renderCell(i) {
    var cell = cells[i];
    var state = game.cellState(i);
    var classes = ['cell'];
    var text = '';
    var label;

    if (state === MS.REVEALED) {
      classes.push('is-revealed');
      if (game.mineAt[i]) {
        classes.push('is-mine');
        if (i === game.explodedIndex) classes.push('is-exploded');
        text = '💣';
        label = 'ระเบิด';
      } else if (game.adjacent[i] > 0) {
        text = String(game.adjacent[i]);
        classes.push('n' + game.adjacent[i]);
        label = 'มีระเบิดข้างเคียง ' + game.adjacent[i] + ' ลูก';
      } else {
        label = 'ช่องว่าง';
      }
    } else if (state === MS.FLAGGED) {
      classes.push('is-flagged');
      text = '🚩';
      label = 'ปักธง';
      if (game.status === 'lost' && !game.mineAt[i]) {
        classes.push('is-wrong');
        text = '❌';
        label = 'ปักธงผิด';
      }
    } else {
      label = 'ยังไม่เปิด';
    }

    cell.className = classes.join(' ');
    if (cell.textContent !== text) cell.textContent = text;
    cell.setAttribute('aria-label', 'แถว ' + (Math.floor(i / game.cols) + 1) + ' คอลัมน์ ' + (i % game.cols + 1) + ', ' + label);
  }

  function renderBestTimes() {
    var best = Storage.getBestTimes();
    el.bestTimes.innerHTML = '';

    MS.PRESET_ORDER.forEach(function (key) {
      var value = best[key];
      var chip = document.createElement('span');
      chip.className = 'best__item';
      if (game && game.difficulty === key) chip.classList.add('is-current');

      var name = document.createElement('span');
      name.className = 'best__name';
      name.textContent = MS.DIFFICULTIES[key].label;
      chip.appendChild(name);

      var time = document.createElement('b');
      time.textContent = value == null ? '—' : value + ' วิ';
      chip.appendChild(time);

      el.bestTimes.appendChild(chip);
    });
  }

  function setMessage(text) {
    el.message.textContent = text;
  }

  var toastHandle = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('is-visible');
    clearTimeout(toastHandle);
    toastHandle = setTimeout(function () {
      el.toast.classList.remove('is-visible');
    }, 2200);
  }

  function pad3(n) {
    var sign = n < 0 ? '-' : '';
    var abs = Math.min(999, Math.abs(n));
    return sign + ('00' + abs).slice(-3);
  }

  /* --------------------------------------------------------------- timer */

  function elapsedMs() {
    return timer.accumulated + (timer.running ? Date.now() - timer.startedAt : 0);
  }

  function startTimer() {
    if (timer.running) return;
    timer.running = true;
    timer.startedAt = Date.now();
    timer.handle = setInterval(updateTimerDisplay, 200);
  }

  function stopTimer() {
    if (!timer.running) return;
    timer.accumulated = elapsedMs();
    timer.running = false;
    clearInterval(timer.handle);
    updateTimerDisplay();
  }

  function resetTimer() {
    clearInterval(timer.handle);
    timer = { accumulated: 0, startedAt: 0, running: false, handle: 0 };
    updateTimerDisplay();
  }

  function updateTimerDisplay() {
    el.timer.textContent = pad3(Math.floor(elapsedMs() / 1000));
  }

  /* -------------------------------------------------------------- inputs */

  function cellIndexFrom(target) {
    var cell = target.closest ? target.closest('.cell') : null;
    return cell ? parseInt(cell.dataset.index, 10) : -1;
  }

  /**
   * A tap on a revealed number always chords; on a hidden cell the tap mode
   * decides. `invert` swaps dig and flag, which is what a long press does.
   */
  function playCell(idx, invert) {
    var r = Math.floor(idx / game.cols);
    var c = idx % game.cols;
    if (game.cellState(idx) === MS.REVEALED) {
      act(function () { return game.chord(r, c); });
      return;
    }
    var flagging = (tapMode === 'flag') !== !!invert;
    act(function () { return flagging ? game.toggleFlag(r, c) : game.reveal(r, c); });
  }

  function onBoardClick(e) {
    // A long press already acted on this cell; swallow the click it produces.
    if (touch.handled) { touch.handled = false; return; }
    var idx = cellIndexFrom(e.target);
    if (idx < 0) return;
    playCell(idx, false);
  }

  function onBoardDblClick(e) {
    var idx = cellIndexFrom(e.target);
    if (idx < 0) return;
    act(function () { return game.chord(Math.floor(idx / game.cols), idx % game.cols); });
  }

  function onBoardContextMenu(e) {
    e.preventDefault();
    var idx = cellIndexFrom(e.target);
    if (idx < 0) return;
    act(function () { return game.toggleFlag(Math.floor(idx / game.cols), idx % game.cols); });
  }

  function onBoardMouseDown(e) {
    // Middle click is the classic chord shortcut.
    if (e.button !== 1) return;
    e.preventDefault();
    var idx = cellIndexFrom(e.target);
    if (idx < 0) return;
    act(function () { return game.chord(Math.floor(idx / game.cols), idx % game.cols); });
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return cancelLongPress();
    var idx = cellIndexFrom(e.target);
    if (idx < 0) return;
    touch.index = idx;
    touch.moved = false;
    touch.startX = e.touches[0].clientX;
    touch.startY = e.touches[0].clientY;
    clearTimeout(touch.timer);
    touch.timer = setTimeout(function () {
      if (touch.moved || touch.index < 0) return;
      touch.handled = true;
      // Long press does the opposite of the current tap mode.
      playCell(touch.index, true);
      if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(15);
    }, LONG_PRESS_MS);
  }

  function onTouchMove(e) {
    if (!e.touches.length) return;
    var dx = Math.abs(e.touches[0].clientX - touch.startX);
    var dy = Math.abs(e.touches[0].clientY - touch.startY);
    if (dx > 10 || dy > 10) {
      touch.moved = true;
      clearTimeout(touch.timer);
    }
  }

  function onTouchEnd(e) {
    clearTimeout(touch.timer);
    if (touch.handled) {
      // Stop the browser from turning this long press into a click.
      e.preventDefault();
      touch.handled = false;
    }
    touch.index = -1;
  }

  function cancelLongPress() {
    clearTimeout(touch.timer);
    touch.index = -1;
    touch.handled = false;
  }

  function onBoardKeyDown(e) {
    var idx = cellIndexFrom(e.target);
    if (idx < 0) return;
    var r = Math.floor(idx / game.cols);
    var c = idx % game.cols;
    var dr = 0;
    var dc = 0;

    switch (e.key) {
      case 'ArrowUp': dr = -1; break;
      case 'ArrowDown': dr = 1; break;
      case 'ArrowLeft': dc = -1; break;
      case 'ArrowRight': dc = 1; break;
      case 'f': case 'F':
        e.preventDefault();
        act(function () { return game.toggleFlag(r, c); });
        focusCell(idx);
        return;
      case ' ': case 'Enter':
        e.preventDefault();
        playCell(idx, false);
        focusCell(idx);
        return;
      default:
        return;
    }

    e.preventDefault();
    var nr = Math.min(game.rows - 1, Math.max(0, r + dr));
    var nc = Math.min(game.cols - 1, Math.max(0, c + dc));
    focusCell(nr * game.cols + nc);
  }

  function focusCell(idx) {
    if (!cells[idx]) return;
    cells.forEach(function (cell) { cell.tabIndex = -1; });
    cells[idx].tabIndex = 0;
    cells[idx].focus();
  }

  function onGlobalKeyDown(e) {
    if (e.key === 'Escape' && !el.modal.hidden) {
      closeModal();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      openModal('save');
    }
  }

  /* ------------------------------------------------------------ save/load */

  function buildPayload() {
    return {
      version: 1,
      snapshot: game.snapshot(),
      history: history,
      undoUsed: undoUsed,
      elapsed: elapsedMs()
    };
  }

  function autosave() {
    if (!game) return;
    Storage.saveAuto(buildPayload());
  }

  function applySave(payload) {
    game = MS.Game.fromSnapshot(payload.snapshot);
    history = Array.isArray(payload.history) ? payload.history : [];
    undoUsed = payload.undoUsed || 0;

    resetTimer();
    timer.accumulated = payload.elapsed || 0;

    var difficulty = game.difficulty || 'custom';
    el.difficulty.value = MS.DIFFICULTIES[difficulty] ? difficulty : 'custom';
    el.customFields.hidden = el.difficulty.value !== 'custom';
    syncCustomFields();

    buildBoard();
    render();
    renderBestTimes();
    if (game.status === 'playing') startTimer();
  }

  function openModal(mode) {
    pendingModalAction = mode;
    el.modalTitle.textContent = mode === 'save' ? 'บันทึกเกม' : 'โหลดเกม';
    renderSlots(mode);
    el.modal.hidden = false;
    el.modalClose.focus();
  }

  function closeModal() {
    el.modal.hidden = true;
    pendingModalAction = null;
  }

  function renderSlots(mode) {
    el.modalSlots.innerHTML = '';
    Storage.listSlots().forEach(function (entry) {
      el.modalSlots.appendChild(buildSlotRow(entry, mode));
    });
    if (!Storage.isPersistent) {
      var warn = document.createElement('p');
      warn.className = 'modal__warning';
      warn.textContent = 'เบราว์เซอร์นี้ปิดการเก็บข้อมูลไว้ เกมที่บันทึกจะหายเมื่อปิดแท็บ';
      el.modalSlots.appendChild(warn);
    }
  }

  function buildSlotRow(entry, mode) {
    var row = document.createElement('div');
    row.className = 'slot';

    var info = document.createElement('div');
    info.className = 'slot__info';

    var title = document.createElement('strong');
    title.textContent = 'ช่องที่ ' + entry.slot;
    info.appendChild(title);

    var detail = document.createElement('span');
    detail.textContent = entry.data ? describeSave(entry.data) : 'ว่าง';
    info.appendChild(detail);
    row.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'slot__actions';

    if (mode === 'save') {
      actions.appendChild(makeButton('บันทึกที่นี่', 'primary', function () {
        if (entry.data && !confirm('ช่องที่ ' + entry.slot + ' มีข้อมูลอยู่แล้ว ต้องการเขียนทับหรือไม่?')) return;
        var ok = Storage.saveSlot(entry.slot, buildPayload());
        closeModal();
        toast(ok ? 'บันทึกลงช่องที่ ' + entry.slot + ' แล้ว' : 'บันทึกได้ชั่วคราวเท่านั้น (พื้นที่เก็บข้อมูลเต็ม)');
      }));
    } else {
      actions.appendChild(makeButton('โหลด', 'primary', function () {
        var data = Storage.loadSlot(entry.slot);
        if (!data || !data.snapshot) return;
        applySave(data);
        closeModal();
        toast('โหลดเกมจากช่องที่ ' + entry.slot + ' แล้ว');
        setMessage('โหลดเกมที่บันทึกไว้เรียบร้อย');
        autosave();
      }, !entry.data));
    }

    actions.appendChild(makeButton('ลบ', 'ghost', function () {
      Storage.clearSlot(entry.slot);
      renderSlots(pendingModalAction);
      toast('ลบข้อมูลช่องที่ ' + entry.slot + ' แล้ว');
    }, !entry.data));

    row.appendChild(actions);
    return row;
  }

  function makeButton(label, variant, onClick, disabled) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--' + variant;
    btn.textContent = label;
    btn.disabled = !!disabled;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function describeSave(data) {
    var snap = data.snapshot || {};
    var preset = MS.DIFFICULTIES[snap.difficulty];
    var name = preset ? preset.label : 'กำหนดเอง';
    var status = snap.status === 'won' ? 'ชนะแล้ว' : snap.status === 'lost' ? 'แพ้แล้ว' : 'กำลังเล่น';
    var seconds = Math.floor((data.elapsed || 0) / 1000);
    return name + ' ' + snap.rows + '×' + snap.cols + ' · ' + status + ' · ' + seconds + ' วิ · ' + formatDate(data.savedAt);
  }

  function formatDate(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    return d.getDate() + '/' + (d.getMonth() + 1) + ' ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // Small handle for automated tests and console tinkering.
  global.MinesweeperApp = {
    getGame: function () { return game; },
    getHistoryLength: function () { return history.length; },
    startGame: startGame,
    undo: undo
  };
})(typeof window !== 'undefined' ? window : this);
