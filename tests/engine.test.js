/*
 * Engine tests for Minesweeper Latte. No dependencies:
 *   node tests/engine.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8'), ctx);
const MS = ctx.window.Minesweeper;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

console.log('Minesweeper Latte - engine tests\n');

// 0. difficulty presets
{
  const order = MS.PRESET_ORDER;
  check('five difficulty presets are exposed', order.length === 5);
  check('every preset in the order exists', order.every(k => !!MS.DIFFICULTIES[k]));
  check('no preset is missing from the order',
    Object.keys(MS.DIFFICULTIES).every(k => order.indexOf(k) !== -1));
  check('every preset has a label', order.every(k => !!MS.DIFFICULTIES[k].label));
  check('no duplicate labels', new Set(order.map(k => MS.DIFFICULTIES[k].label)).size === 5);

  const size = k => MS.DIFFICULTIES[k].rows * MS.DIFFICULTIES[k].cols;
  const density = k => MS.DIFFICULTIES[k].mines / size(k);
  let growing = true, denser = true, fits = true, playable = true;
  for (let i = 0; i < order.length; i++) {
    const d = MS.DIFFICULTIES[order[i]];
    if (i > 0) {
      if (size(order[i]) <= size(order[i - 1])) growing = false;
      if (density(order[i]) <= density(order[i - 1])) denser = false;
    }
    // presets must survive Game's clamping untouched
    if (d.rows < MS.LIMITS.minRows || d.rows > MS.LIMITS.maxRows ||
        d.cols < MS.LIMITS.minCols || d.cols > MS.LIMITS.maxCols) fits = false;
    const g = new MS.Game({ rows: d.rows, cols: d.cols, mines: d.mines, difficulty: order[i] });
    if (g.rows !== d.rows || g.cols !== d.cols || g.mines !== d.mines) playable = false;
  }
  check('presets grow in board size', growing);
  check('presets grow in mine density', denser);
  check('presets stay inside the size limits', fits);
  check('no preset is altered by clamping', playable);

  // each preset must be winnable end to end
  let allWon = true;
  for (const key of order) {
    const d = MS.DIFFICULTIES[key];
    const g = new MS.Game({ rows: d.rows, cols: d.cols, mines: d.mines, difficulty: key });
    g.reveal(Math.floor(d.rows / 2), Math.floor(d.cols / 2));
    for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
      if (!g.mineAt[r * d.cols + c]) g.reveal(r, c);
    }
    if (g.status !== 'won' || g.flagCount !== d.mines) allWon = false;
  }
  check('every preset can be played to a win', allWon);
}

// 1. first click safe, always
for (let i = 0; i < 300; i++) {
  const g = new MS.Game({rows:9, cols:9, mines:10, difficulty:'beginner'});
  g.reveal(4,4);
  if (g.status === 'lost') { check('first click never a mine', false); break; }
  if (i === 299) check('first click never a mine (300 boards)', true);
}

// 2. mine count correct
{
  const g = new MS.Game({rows:16, cols:30, mines:99});
  g.reveal(8,15);
  let n = 0; for (const v of g.mineAt) n += v;
  check('exactly 99 mines placed', n === 99);
  check('interior first click opens >= its 3x3 ring', g.revealedCount >= 9);
  const g3 = new MS.Game({rows:16, cols:30, mines:99});
  g3.reveal(0,0);
  check('corner first click opens >= its 2x2 ring', g3.revealedCount >= 4);
}

// 3. adjacency numbers consistent
{
  const g = new MS.Game({rows:12, cols:12, mines:30});
  g.reveal(5,5);
  let ok = true;
  for (let r=0;r<12;r++) for (let c=0;c<12;c++) {
    const i = r*12+c; if (g.mineAt[i]) continue;
    let cnt=0;
    for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++) {
      if(!dr&&!dc) continue; const nr=r+dr,nc=c+dc;
      if(nr<0||nr>=12||nc<0||nc>=12) continue;
      cnt += g.mineAt[nr*12+nc];
    }
    if (cnt !== g.adjacent[i]) ok = false;
  }
  check('adjacency counts match mine layout', ok);
}

// 4. flags
{
  const g = new MS.Game({rows:9,cols:9,mines:10});
  g.toggleFlag(0,0);
  check('flag increments count', g.flagCount === 1 && g.minesLeft() === 9);
  g.toggleFlag(0,0);
  check('unflag decrements count', g.flagCount === 0);
  g.reveal(4,4);
  const revealedIdx = [...g.state].findIndex(s => s === MS.REVEALED);
  const rr = Math.floor(revealedIdx/9), rc = revealedIdx%9;
  check('cannot flag a revealed cell', g.toggleFlag(rr,rc) === false);
}

// 5. win detection: auto-solve by revealing every safe cell
{
  const g = new MS.Game({rows:9,cols:9,mines:10});
  g.reveal(4,4);
  for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!g.mineAt[r*9+c]) g.reveal(r,c);
  check('win detected when all safe cells open', g.status === 'won');
  check('win auto-flags all mines', g.flagCount === 10 && g.minesLeft() === 0);
}

// 6. lose reveals mines
{
  const g = new MS.Game({rows:9,cols:9,mines:10});
  g.reveal(4,4);
  const mineIdx = [...g.mineAt].findIndex(v => v === 1);
  g.reveal(Math.floor(mineIdx/9), mineIdx%9);
  check('stepping on a mine loses', g.status === 'lost');
  check('explodedIndex recorded', g.explodedIndex === mineIdx);
  const allShown = [...g.mineAt].every((m,i) => !m || g.state[i] !== MS.HIDDEN);
  check('all mines revealed on loss', allShown);
  check('no moves accepted after loss', g.reveal(0,0) === false && g.toggleFlag(0,0) === false);
}

// 7. snapshot round-trip
{
  const g = new MS.Game({rows:16,cols:16,mines:40,difficulty:'intermediate'});
  g.reveal(8,8); g.toggleFlag(0,0); g.toggleFlag(0,1);
  const snap = JSON.parse(JSON.stringify(g.snapshot()));
  const g2 = MS.Game.fromSnapshot(snap);
  const same = g2.rows===g.rows && g2.cols===g.cols && g2.mines===g.mines &&
    g2.status===g.status && g2.revealedCount===g.revealedCount && g2.flagCount===g.flagCount &&
    g2.difficulty===g.difficulty &&
    String(g2.state)===String(g.state) && String(g2.mineAt)===String(g.mineAt) &&
    String(g2.adjacent)===String(g.adjacent);
  check('snapshot survives JSON round-trip', same);
}

// 8. undo restores exact prior position
{
  const g = new MS.Game({rows:12,cols:12,mines:20});
  g.reveal(6,6);
  const before = JSON.parse(JSON.stringify(g.snapshot()));
  const mineIdx = [...g.mineAt].findIndex(v => v === 1);
  g.reveal(Math.floor(mineIdx/12), mineIdx%12);
  check('lost after stepping on mine', g.status === 'lost');
  g.restore(before);
  check('undo returns to playing', g.status === 'playing');
  check('undo restores board exactly', String(g.state) === String(MS.Game.fromSnapshot(before).state));
  check('undo re-hides the mine', g.state[mineIdx] === MS.HIDDEN);
  check('board still playable after undo', g.reveal(Math.floor(mineIdx/12), mineIdx%12) === true);
}

// 9. chording
{
  const N = 9;
  const around = (r, c, fn) => {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
      fn(nr, nc, nr * N + nc);
    }
  };

  // A chord only opens cells, so the candidate needs at least one hidden
  // non-mine neighbour. Boards where no such cell exists are retried.
  let g = null, target = null;
  for (let attempt = 0; attempt < 50 && !target; attempt++) {
    g = new MS.Game({ rows: N, cols: N, mines: 10 });
    g.reveal(4, 4);
    for (let r = 0; r < N && !target; r++) for (let c = 0; c < N && !target; c++) {
      const i = r * N + c;
      if (g.state[i] !== MS.REVEALED || g.adjacent[i] === 0) continue;
      let openable = 0;
      around(r, c, (nr, nc, ni) => {
        if (g.state[ni] === MS.HIDDEN && !g.mineAt[ni]) openable++;
      });
      if (openable > 0) target = [r, c];
    }
  }
  check('found a chordable cell', !!target);

  if (target) {
    const [r, c] = target;
    check('chord blocked before flags placed', g.chord(r, c) === false);
    around(r, c, (nr, nc, ni) => {
      if (g.mineAt[ni] && g.state[ni] === MS.HIDDEN) g.toggleFlag(nr, nc);
    });
    const before = g.revealedCount;
    check('chord opens neighbours once flags match', g.chord(r, c) === true);
    check('chord actually revealed cells', g.revealedCount > before);
    check('chord did not lose the game', g.status !== 'lost');
    check('chord is a no-op when nothing is left to open', g.chord(r, c) === false);
  }
}

// 10. clamping / degenerate configs
{
  const g = new MS.Game({rows:2, cols:2, mines:9999});
  check('rows clamped to minimum', g.rows === 5 && g.cols === 5);
  check('mines clamped below cell count', g.mines <= 25 - 9);
  g.reveal(2,2);
  check('dense board still safe on first click', g.status !== 'lost');
  const g2 = new MS.Game({rows:99, cols:99, mines:10});
  check('rows/cols clamped to maximum', g2.rows === 30 && g2.cols === 40);
}

// 11. out-of-bounds is a no-op
{
  const g = new MS.Game({rows:9,cols:9,mines:10});
  check('out-of-bounds reveal ignored', g.reveal(-1,0) === false && g.reveal(9,9) === false);
  check('re-revealing an open cell is a no-op', (g.reveal(4,4), g.reveal(4,4)) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
