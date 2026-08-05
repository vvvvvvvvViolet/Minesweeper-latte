/*
 * Browser tests for Minesweeper Latte.
 *
 *   npm install playwright   (once)
 *   node tests/ui.test.js
 *
 * Serves the project on an ephemeral port itself, so no separate server is
 * needed. Set PW_CHROMIUM to point at an existing Chromium binary if you do
 * not want Playwright to download one.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

let pass = 0;
let fail = 0;

/** Parses the on-screen m:ss clock back into seconds. */
function clockSeconds(text) {
  const m = /^(\d+):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const { chromium, devices } = require('playwright');
  const { server, port } = await serve();
  const URL = `http://127.0.0.1:${port}/index.html`;
  const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
  const browser = await chromium.launch(launchOpts);

  /* ------------------------------------------------------------ desktop */
  console.log('\nMinesweeper Latte - browser tests\n\ndesktop');
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL);
  await page.waitForSelector('.cell');

  check('difficulty menu lists 5 presets plus custom',
    (await page.locator('#difficulty option').count()) === 6);
  check('the menu is generated in preset order', (await page.evaluate(() =>
    [...document.querySelectorAll('#difficulty option')].map((o) => o.value).join(',')))
    === 'novice,beginner,intermediate,expert,nightmare,custom');
  check('preset options show size and mine count',
    /มือใหม่ · 7×7 · 5 ลูก/.test(await page.locator('#difficulty option').first().textContent()));
  check('beginner is selected by default', (await page.locator('#difficulty').inputValue()) === 'beginner');
  check('best-time list shows one chip per preset', (await page.locator('.best__item').count()) === 5);
  check('the current difficulty chip is highlighted',
    (await page.locator('.best__item.is-current').count()) === 1);

  check('board renders 81 cells for beginner', (await page.locator('.cell').count()) === 81);
  check('mine counter shows 010', (await page.locator('#mine-count').textContent()) === '010');
  check('undo disabled at start', await page.locator('#undo-btn').isDisabled());
  check('custom size fields hidden on load', await page.locator('#custom-fields').isHidden());

  await page.locator('.cell').nth(40).click();
  await page.waitForTimeout(150);
  check('cells revealed after first click', (await page.locator('.cell.is-revealed').count()) > 0);
  check('never lose on the first click', (await page.locator('#status-face').textContent()) === '🙂');
  check('undo enabled after a move', !(await page.locator('#undo-btn').isDisabled()));
  check('undo badge shows 1', (await page.locator('#undo-count').textContent()).includes('1'));

  check('the clock reads as m:ss', /^\d+:[0-5]\d$/.test(await page.locator('#timer').textContent()));
  const t0 = await page.locator('#timer').textContent();
  await page.waitForTimeout(1300);
  check('timer counts up while playing',
    clockSeconds(await page.locator('#timer').textContent()) > clockSeconds(t0));

  await page.locator('.cell:not(.is-revealed)').first().click({ button: 'right' });
  await page.waitForTimeout(100);
  check('right-click plants a flag', (await page.locator('.cell.is-flagged').count()) === 1);
  check('mine counter drops to 009', (await page.locator('#mine-count').textContent()) === '009');

  /* --------------------------------------------------------------- undo */
  console.log('\nundo');
  const revealedBefore = await page.locator('.cell.is-revealed').count();
  await page.locator('#undo-btn').click();
  await page.waitForTimeout(100);
  check('undo removes the flag', (await page.locator('.cell.is-flagged').count()) === 0);
  check('undo restores the mine counter', (await page.locator('#mine-count').textContent()) === '010');
  check('undo keeps earlier reveals', (await page.locator('.cell.is-revealed').count()) === revealedBefore);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(100);
  check('ctrl+z undoes the first reveal', (await page.locator('.cell.is-revealed').count()) === 0);
  check('undo disabled once history is empty', await page.locator('#undo-btn').isDisabled());

  /* ----------------------------------------------------------- save/load */
  console.log('\nsave / load');
  await page.locator('.cell').nth(40).click();
  await page.waitForTimeout(100);
  const boardState = () => page.evaluate(() =>
    [...document.querySelectorAll('.cell')].map((c) => c.className).join('|'));
  const stateBeforeSave = await boardState();

  await page.locator('#save-btn').click();
  await page.waitForSelector('#modal:not([hidden])');
  check('save modal opens', await page.locator('#modal').isVisible());
  check('modal lists 3 slots', (await page.locator('.slot').count()) === 3);
  check('an unused slot reads ว่าง', (await page.locator('.slot__info span').first().textContent()).includes('ว่าง'));

  await page.locator('.slot').first().getByText('บันทึกที่นี่').click();
  await page.waitForTimeout(200);
  check('modal closes after saving', await page.locator('#modal').isHidden());
  check('toast confirms the save', (await page.locator('#toast').textContent()).includes('บันทึก'));
  check('slot 1 written to localStorage',
    await page.evaluate(() => !!localStorage.getItem('minesweeper-latte:slot:1')));

  await page.selectOption('#difficulty', 'intermediate');
  await page.waitForTimeout(150);
  check('switching difficulty rebuilds the board', (await page.locator('.cell').count()) === 256);
  check('a new game resets the timer', (await page.locator('#timer').textContent()) === '0:00');

  await page.locator('#load-btn').click();
  await page.waitForSelector('#modal:not([hidden])');
  check('the saved slot is described', (await page.locator('.slot__info span').first().textContent()).includes('ง่าย'));
  await page.locator('.slot').first().getByText('โหลด', { exact: true }).click();
  await page.waitForTimeout(200);
  check('load restores the exact board', (await boardState()) === stateBeforeSave);
  check('load restores the difficulty select', (await page.locator('#difficulty').inputValue()) === 'beginner');

  await page.locator('.cell:not(.is-revealed)').first().click({ button: 'right' });
  await page.waitForTimeout(150);
  const beforeReload = await boardState();
  await page.reload();
  await page.waitForSelector('.cell');
  await page.waitForTimeout(200);
  check('autosave resumes the game after a reload', (await boardState()) === beforeReload);
  check('resume toast is shown', (await page.locator('#toast').textContent()).includes('เล่นต่อ'));
  check('undo history survives the reload', !(await page.locator('#undo-btn').isDisabled()));

  /* ------------------------------------------------------- win and lose */
  console.log('\nwin / lose');
  await page.evaluate(() => {
    const g = window.MinesweeperApp.getGame();
    const cells = [...document.querySelectorAll('.cell')];
    for (let i = 0; i < cells.length; i++) {
      if (g.mineAt[i] && g.cellState(i) === 0) { cells[i].click(); break; }
    }
  });
  await page.waitForTimeout(200);
  check('stepping on a mine shows the sad face', (await page.locator('#status-face').textContent()) === '😵');
  check('the exploded cell is highlighted', (await page.locator('.cell.is-exploded').count()) === 1);
  const timerAtLoss = await page.locator('#timer').textContent();
  await page.waitForTimeout(700);
  check('timer stops after losing', (await page.locator('#timer').textContent()) === timerAtLoss);

  await page.locator('#undo-btn').click();
  await page.waitForTimeout(150);
  check('undo revives a lost game', (await page.locator('#status-face').textContent()) === '🙂');
  check('undo clears the explosion', (await page.locator('.cell.is-exploded').count()) === 0);
  check('the message mentions the undo count', (await page.locator('#message').textContent()).includes('ย้อนกลับ'));
  await page.waitForTimeout(1200);
  check('timer resumes after undoing a loss',
    clockSeconds(await page.locator('#timer').textContent()) > clockSeconds(timerAtLoss));

  /* ------------------------------------------------------------- clock */
  console.log('\nclock');
  // A three-digit counter clamped at 999, so anything past 16m39s froze.
  const longClock = await page.evaluate(() => {
    const results = {};
    for (const [label, seconds] of Object.entries({
      zero: 0, under: 59, oneMin: 60, wasClamped: 999, past: 1000, longGame: 3725
    })) {
      const app = window.MinesweeperApp;
      app.setElapsedForTest(seconds * 1000);
      results[label] = document.getElementById('timer').textContent;
    }
    return results;
  });
  check('0 seconds shows 0:00', longClock.zero === '0:00');
  check('59 seconds shows 0:59', longClock.under === '0:59');
  check('60 seconds rolls to 1:00', longClock.oneMin === '1:00');
  check('999 seconds shows 16:39', longClock.wasClamped === '16:39');
  check('the clock keeps counting past 999 seconds', longClock.past === '16:40');
  check('an hour-long game reads 62:05', longClock.longGame === '62:05');

  /* --------------------------------------------------- all five levels */
  console.log('\ndifficulty levels');
  const expected = {
    novice: { cells: 49, mines: '005' },
    beginner: { cells: 81, mines: '010' },
    intermediate: { cells: 256, mines: '040' },
    expert: { cells: 480, mines: '099' },
    nightmare: { cells: 800, mines: '180' }
  };
  for (const [key, want] of Object.entries(expected)) {
    await page.selectOption('#difficulty', key);
    await page.waitForTimeout(200);
    check(`${key} builds ${want.cells} cells`, (await page.locator('.cell').count()) === want.cells);
    check(`${key} shows ${want.mines} mines`, (await page.locator('#mine-count').textContent()) === want.mines);
    check(`${key} highlights its own best-time chip`, await page.evaluate((k) => {
      const chip = document.querySelector('.best__item.is-current');
      return !!chip && chip.textContent.includes(window.Minesweeper.DIFFICULTIES[k].label);
    }, key));
    check(`${key} first click is safe`, await (async () => {
      const g = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.cell')];
        cells[Math.floor(cells.length / 2)].click();
        return window.MinesweeperApp.getGame().status;
      });
      return g !== 'lost';
    })());
  }
  check('the widest board uses the compact cell size',
    await page.locator('#board').evaluate((b) => b.classList.contains('board--wide')));
  check('nightmare still fits the page width without body overflow', (await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);

  // Centring an overflowing child would make its first columns unreachable.
  const wide = await page.evaluate(() => {
    const wrap = document.querySelector('.board-wrap');
    const board = document.querySelector('#board');
    wrap.scrollLeft = 0;
    const firstCellLeft = document.querySelector('.cell').getBoundingClientRect().left;
    return {
      scrollable: wrap.scrollWidth >= board.getBoundingClientRect().width,
      firstCellVisible: firstCellLeft >= wrap.getBoundingClientRect().left - 1,
      overflows: wrap.scrollWidth > wrap.clientWidth
    };
  });
  check('the widest board overflows its wrapper', wide.overflows);
  check('every column of the widest board is reachable by scrolling', wide.scrollable);
  check('column 1 is visible at scroll position 0', wide.firstCellVisible);

  const lastCellVisible = await page.evaluate(() => {
    const wrap = document.querySelector('.board-wrap');
    wrap.scrollLeft = wrap.scrollWidth;
    const cells = document.querySelectorAll('.cell');
    const last = cells[cells.length - 1].getBoundingClientRect();
    return last.right <= wrap.getBoundingClientRect().right + 1;
  });
  check('the final column is reachable at full scroll', lastCellVisible);

  await page.selectOption('#difficulty', 'novice');
  await page.waitForTimeout(200);
  check('a small board stays centred in its wrapper', await page.evaluate(() => {
    const wrap = document.querySelector('.board-wrap').getBoundingClientRect();
    const board = document.querySelector('#board').getBoundingClientRect();
    return Math.abs((board.left - wrap.left) - (wrap.right - board.right)) < 2;
  }));

  /* ------------------------------------------------- custom + keyboard */
  console.log('\ncustom boards and keyboard');
  await page.selectOption('#difficulty', 'custom');
  await page.waitForTimeout(100);
  check('choosing custom reveals the size fields', await page.locator('#custom-fields').isVisible());
  check('the board waits for สร้างกระดาน', (await page.locator('.cell').count()) !== 56);
  await page.fill('#custom-rows', '7');
  await page.fill('#custom-cols', '8');
  await page.fill('#custom-mines', '5');
  await page.locator('#custom-apply').click();
  await page.waitForTimeout(150);
  check('custom board has 56 cells', (await page.locator('.cell').count()) === 56);

  await page.locator('.cell').first().focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('f');
  await page.waitForTimeout(100);
  check('F flags the focused cell', (await page.locator('.cell.is-flagged').count()) === 1);
  check('arrow keys moved focus to row 2, column 2', (await page.evaluate(() =>
    [...document.querySelectorAll('.cell')].findIndex((c) => c.classList.contains('is-flagged')))) === 9);
  await page.keyboard.press('f');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('Enter opens the focused cell', (await page.locator('.cell.is-revealed').count()) > 0);

  await page.evaluate(() => {
    const g = window.MinesweeperApp.getGame();
    const cells = [...document.querySelectorAll('.cell')];
    for (let i = 0; i < cells.length; i++) if (!g.mineAt[i] && g.cellState(i) !== 1) cells[i].click();
  });
  await page.waitForTimeout(300);
  check('winning shows the cool face', (await page.locator('#status-face').textContent()) === '😎');
  check('the win message is shown', (await page.locator('#message').textContent()).includes('ชนะ'));
  check('winning auto-flags the remaining mines', (await page.locator('#mine-count').textContent()) === '000');

  /* ------------------------------------------------------ accessibility */
  console.log('\naccessibility');
  await page.selectOption('#difficulty', 'beginner');
  await page.waitForTimeout(200);

  // role="grid" requires grid > row > gridcell. The rows use display:contents,
  // so this also proves they still reach the accessibility tree.
  check('the board exposes the grid role', (await page.getByRole('grid').count()) === 1);
  check('every board row is exposed as a row', (await page.getByRole('row').count()) === 9);
  check('every cell is exposed as a gridcell', (await page.getByRole('gridcell').count()) === 81);
  check('gridcells are children of rows', await page.evaluate(() =>
    [...document.querySelectorAll('[role="gridcell"]')]
      .every((c) => c.parentElement.getAttribute('role') === 'row')));
  check('rows are children of the grid', await page.evaluate(() =>
    [...document.querySelectorAll('[role="row"]')]
      .every((r) => r.parentElement.id === 'board')));
  check('rows and columns are indexed', await page.evaluate(() => {
    const firstRow = document.querySelector('[role="row"]');
    const cells = firstRow.querySelectorAll('[role="gridcell"]');
    return firstRow.getAttribute('aria-rowindex') === '1' &&
      cells[0].getAttribute('aria-colindex') === '1' &&
      cells[8].getAttribute('aria-colindex') === '9';
  }));
  check('the grid declares its dimensions', await page.evaluate(() => {
    const b = document.getElementById('board');
    return b.getAttribute('aria-rowcount') === '9' && b.getAttribute('aria-colcount') === '9';
  }));

  // The row wrappers must not disturb the CSS grid.
  const grid = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.cell')].map((c) => c.getBoundingClientRect());
    return {
      firstRowSameTop: cells.slice(0, 9).every((r) => Math.abs(r.top - cells[0].top) < 1),
      firstColSameLeft: [0, 9, 18, 27].every((i) => Math.abs(cells[i].left - cells[0].left) < 1),
      wrapsAfterNineCells: cells[9].top > cells[8].top,
      rowBoxesHaveNoSize: [...document.querySelectorAll('.board__row')]
        .every((r) => r.getBoundingClientRect().width === 0)
    };
  });
  check('cells in a row still share a top edge', grid.firstRowSameTop);
  check('cells in a column still share a left edge', grid.firstColSameLeft);
  check('the grid still wraps every 9 cells', grid.wrapsAfterNineCells);
  check('row wrappers generate no layout box', grid.rowBoxesHaveNoSize);

  // Keyboard navigation must survive the extra DOM level.
  await page.locator('.cell').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  check('arrow keys still cross row boundaries', await page.evaluate(() =>
    document.activeElement.dataset.index === '10'));

  /* -------------------------------------------------------------- modal */
  console.log('\nslot management');
  await page.locator('#load-btn').click();
  await page.waitForSelector('#modal:not([hidden])');
  await page.locator('.slot').first().getByText('ลบ').click();
  await page.waitForTimeout(150);
  check('deleting a slot empties it',
    (await page.locator('.slot__info span').first().textContent()).includes('ว่าง'));
  check('the deleted slot is gone from storage',
    await page.evaluate(() => !localStorage.getItem('minesweeper-latte:slot:1')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check('Escape closes the modal', await page.locator('#modal').isHidden());
  check('no uncaught errors on desktop', errors.length === 0);
  if (errors.length) console.log(errors.slice(0, 5));

  /* -------------------------------------------------------------- touch */
  console.log('\nmobile');
  const ctxMobile = await browser.newContext({ ...devices['Pixel 7'] });
  const mp = await ctxMobile.newPage();
  const mobileErrors = [];
  mp.on('pageerror', (e) => mobileErrors.push(String(e)));
  await mp.goto(URL);
  await mp.waitForSelector('.cell');

  const first = await mp.locator('.cell').nth(40).boundingBox();
  await mp.touchscreen.tap(first.x + first.width / 2, first.y + first.height / 2);
  await mp.waitForTimeout(200);
  check('tap reveals a cell', (await mp.locator('.cell.is-revealed').count()) > 0);

  const cdp = await ctxMobile.newCDPSession(mp);
  const target = await mp.locator('.cell:not(.is-revealed)').first().boundingBox();
  const tx = target.x + target.width / 2;
  const ty = target.y + target.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  await mp.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mp.waitForTimeout(200);
  check('long press plants a flag', (await mp.locator('.cell.is-flagged').count()) === 1);
  check('long press does not also reveal the cell',
    (await mp.locator('.cell.is-flagged.is-revealed').count()) === 0);

  const flagsBefore = await mp.locator('.cell.is-flagged').count();
  const drag = await mp.locator('.cell:not(.is-revealed):not(.is-flagged)').first().boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: drag.x + 5, y: drag.y + 5 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: drag.x + 5, y: drag.y + 60 }] });
  await mp.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mp.waitForTimeout(150);
  check('dragging to scroll does not flag', (await mp.locator('.cell.is-flagged').count()) === flagsBefore);

  const pageOverflow = () => mp.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no horizontal page overflow on mobile', (await pageOverflow()) <= 0);

  await mp.selectOption('#difficulty', 'expert');
  await mp.waitForTimeout(200);
  check('the expert board scrolls inside its wrapper', await mp.evaluate(() => {
    const w = document.querySelector('.board-wrap');
    return w.scrollWidth > w.clientWidth;
  }));
  check('the expert board does not overflow the page', (await pageOverflow()) <= 0);
  check('no uncaught errors on mobile', mobileErrors.length === 0);
  if (mobileErrors.length) console.log(mobileErrors.slice(0, 5));

  /* --------------------------------------------------- mobile UI layout */
  console.log('\nmobile layout');
  await mp.selectOption('#difficulty', 'beginner');
  await mp.waitForTimeout(200);

  const layout = await mp.evaluate(() => {
    const bar = document.querySelector('.actionbar').getBoundingClientRect();
    const panel = document.querySelector('.panel');
    const board = document.querySelector('#board').getBoundingClientRect();
    const wrap = document.querySelector('.board-wrap').getBoundingClientRect();
    return {
      barBottom: Math.round(bar.bottom),
      barTop: Math.round(bar.top),
      viewportH: window.innerHeight,
      barFixed: getComputedStyle(document.querySelector('.actionbar')).position === 'fixed',
      panelSticky: getComputedStyle(panel).position === 'sticky',
      boardAboveBar: board.top < bar.top,
      beginnerFits: board.width <= wrap.width + 1,
      helpCollapsed: !document.querySelector('#help').open
    };
  });
  check('the action bar is pinned to the bottom on phones', layout.barFixed);
  check('the action bar sits at the bottom edge of the viewport',
    Math.abs(layout.barBottom - layout.viewportH) <= 1);
  check('the status panel sticks to the top on phones', layout.panelSticky);
  check('the board is above the action bar', layout.boardAboveBar);
  check('a beginner board fits the phone width without scrolling', layout.beginnerFits);
  check('the instructions start collapsed on phones', layout.helpCollapsed);

  const targets = await mp.evaluate(() => {
    const rects = [...document.querySelectorAll('.actionbar__btn, .mode__btn')]
      .map((b) => b.getBoundingClientRect());
    const cell = document.querySelector('.cell').getBoundingClientRect();
    return {
      minBtnHeight: Math.min(...rects.map((r) => r.height)),
      minBtnWidth: Math.min(...rects.map((r) => r.width)),
      cell: Math.round(cell.width)
    };
  });
  check('every action-bar target is at least 44px tall', targets.minBtnHeight >= 44);
  check('every action-bar target is at least 44px wide', targets.minBtnWidth >= 44);
  check('cells stay tappable on a phone (>= 26px)', targets.cell >= 26);

  // pinch-zoom must not be blocked (WCAG 1.4.4)
  const viewportMeta = await mp.getAttribute('meta[name="viewport"]', 'content');
  check('pinch zoom is not disabled', !/user-scalable\s*=\s*no|maximum-scale/.test(viewportMeta));
  check('the viewport covers the display cutout', /viewport-fit=cover/.test(viewportMeta));

  /* ------------------------------------------------------ tap-mode UX */
  console.log('\ntap mode');
  check('dig mode is active by default',
    (await mp.locator('#mode-dig').getAttribute('aria-pressed')) === 'true');

  await mp.locator('#mode-flag').click();
  await mp.waitForTimeout(150);
  check('flag mode becomes active when tapped',
    (await mp.locator('#mode-flag').getAttribute('aria-pressed')) === 'true');
  check('dig mode is released', (await mp.locator('#mode-dig').getAttribute('aria-pressed')) === 'false');
  check('the board shows it is in flag mode',
    await mp.locator('#board').evaluate((b) => b.classList.contains('is-flagmode')));

  const flagCell = await mp.locator('.cell').nth(3).boundingBox();
  await mp.touchscreen.tap(flagCell.x + flagCell.width / 2, flagCell.y + flagCell.height / 2);
  await mp.waitForTimeout(200);
  check('a tap in flag mode plants a flag', (await mp.locator('.cell.is-flagged').count()) === 1);
  check('a tap in flag mode reveals nothing', (await mp.locator('.cell.is-revealed').count()) === 0);

  await mp.touchscreen.tap(flagCell.x + flagCell.width / 2, flagCell.y + flagCell.height / 2);
  await mp.waitForTimeout(200);
  check('tapping a flag again removes it', (await mp.locator('.cell.is-flagged').count()) === 0);

  // long press is always the opposite action
  const cdp2 = await ctxMobile.newCDPSession(mp);
  const digTarget = await mp.locator('.cell').nth(40).boundingBox();
  await cdp2.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: digTarget.x + digTarget.width / 2, y: digTarget.y + digTarget.height / 2 }]
  });
  await mp.waitForTimeout(700);
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await mp.waitForTimeout(250);
  check('a long press in flag mode digs instead', (await mp.locator('.cell.is-revealed').count()) > 0);
  check('a long press in flag mode plants no flag', (await mp.locator('.cell.is-flagged').count()) === 0);

  await mp.locator('#mode-dig').click();
  await mp.waitForTimeout(150);
  check('switching back to dig mode clears the board hint',
    !(await mp.locator('#board').evaluate((b) => b.classList.contains('is-flagmode'))));

  /* ------------------------------------------------------ installable */
  console.log('\ninstallable / offline');
  const manifestHref = await mp.getAttribute('link[rel="manifest"]', 'href');
  check('a web app manifest is linked', !!manifestHref);
  const manifest = await mp.evaluate(async (href) => {
    const res = await fetch(href);
    return res.ok ? res.json() : null;
  }, manifestHref);
  check('the manifest parses as JSON', !!manifest);
  check('the manifest is standalone', manifest && manifest.display === 'standalone');
  check('the manifest uses relative start_url and scope',
    manifest && manifest.start_url === './' && manifest.scope === './');
  check('the manifest has a 512px icon',
    !!(manifest && manifest.icons.some((i) => i.sizes === '512x512')));
  check('the manifest has a maskable icon',
    !!(manifest && manifest.icons.some((i) => (i.purpose || '').includes('maskable'))));
  const iconsOk = await mp.evaluate(async (icons) => {
    for (const icon of icons) {
      const res = await fetch(icon.src);
      if (!res.ok) return false;
    }
    return true;
  }, manifest.icons);
  check('every manifest icon actually resolves', iconsOk);
  check('an apple-touch-icon is provided for iOS',
    !!(await mp.getAttribute('link[rel="apple-touch-icon"]', 'href')));
  check('theme-color is set for both colour schemes',
    (await mp.locator('meta[name="theme-color"]').count()) === 2);

  await mp.evaluate(() => navigator.serviceWorker.ready);
  check('the service worker takes control', await mp.evaluate(() => !!navigator.serviceWorker.controller));

  await ctxMobile.setOffline(true);
  await mp.reload();
  await mp.waitForSelector('.cell', { timeout: 5000 }).catch(() => {});
  check('the game still loads with no connection', (await mp.locator('.cell').count()) === 81);
  check('styles survive offline too', await mp.evaluate(() =>
    getComputedStyle(document.querySelector('.board')).display === 'grid'));
  await mp.locator('.cell').nth(40).click();
  await mp.waitForTimeout(200);
  check('the game is playable offline', (await mp.locator('.cell.is-revealed').count()) > 0);
  await ctxMobile.setOffline(false);

  /* -------------------------------------------------- landscape phones */
  console.log('\nlandscape');
  const land = await browser.newContext({
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });
  const lp = await land.newPage();
  await lp.goto(URL);
  await lp.waitForSelector('.cell');

  const landscape = await lp.evaluate(() => {
    const bar = document.querySelector('.actionbar');
    const rect = bar.getBoundingClientRect();
    const board = document.querySelector('#board').getBoundingClientRect();
    const panel = document.querySelector('.panel').getBoundingClientRect();
    return {
      barFixed: getComputedStyle(bar).position === 'fixed',
      barAtBottom: Math.abs(rect.bottom - window.innerHeight) <= 1,
      panelSticky: getComputedStyle(document.querySelector('.panel')).position === 'sticky',
      headerHidden: getComputedStyle(document.querySelector('.app__header')).display === 'none',
      boardFitsHeight: board.bottom <= rect.top + 1 && board.top >= panel.bottom - 1,
      cell: Math.round(document.querySelector('.cell').getBoundingClientRect().width)
    };
  });
  // A landscape phone is wider than the phone breakpoint but far too short
  // for the desktop layout, so it must still get the compact treatment.
  check('a landscape phone keeps the fixed action bar', landscape.barFixed);
  check('the landscape action bar sits at the bottom edge', landscape.barAtBottom);
  check('the landscape status panel stays sticky', landscape.panelSticky);
  check('the landscape header is hidden to save height', landscape.headerHidden);
  check('the whole board fits between panel and bar in landscape', landscape.boardFitsHeight);
  check('landscape cells stay tappable (>= 24px)', landscape.cell >= 24);
  check('no horizontal overflow in landscape', (await lp.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
