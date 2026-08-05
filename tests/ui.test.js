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

  const t0 = await page.locator('#timer').textContent();
  await page.waitForTimeout(1300);
  check('timer counts up while playing', Number(await page.locator('#timer').textContent()) > Number(t0));

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
  check('a new game resets the timer', (await page.locator('#timer').textContent()) === '000');

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
    Number(await page.locator('#timer').textContent()) > Number(timerAtLoss));

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

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
