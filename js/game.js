/*
 * Minesweeper Latte - core game logic (no DOM access).
 * Exposed as a global so the page works when opened straight from file://.
 */
(function (global) {
  'use strict';

  var HIDDEN = 0;
  var REVEALED = 1;
  var FLAGGED = 2;

  var STATE_CHARS = ['h', 'r', 'f'];

  var DIFFICULTIES = {
    beginner: { rows: 9, cols: 9, mines: 10, label: 'ง่าย' },
    intermediate: { rows: 16, cols: 16, mines: 40, label: 'ปานกลาง' },
    expert: { rows: 16, cols: 30, mines: 99, label: 'ยาก' }
  };

  var LIMITS = { minRows: 5, maxRows: 30, minCols: 5, maxCols: 40 };

  function neighbours(rows, cols, r, c, visit) {
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        var nr = r + dr;
        var nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        visit(nr, nc, nr * cols + nc);
      }
    }
  }

  /**
   * @param {{rows:number, cols:number, mines:number}} config
   */
  function Game(config) {
    this.configure(config);
  }

  Game.prototype.configure = function (config) {
    var rows = clamp(config.rows, LIMITS.minRows, LIMITS.maxRows);
    var cols = clamp(config.cols, LIMITS.minCols, LIMITS.maxCols);
    var size = rows * cols;
    // Leave at least 9 safe cells so the first click can always open an area.
    var mines = clamp(config.mines, 1, Math.max(1, size - 9));

    this.rows = rows;
    this.cols = cols;
    this.mines = mines;
    this.difficulty = config.difficulty || 'custom';
    this.reset();
  };

  Game.prototype.reset = function () {
    var size = this.rows * this.cols;
    this.mineAt = new Uint8Array(size);
    this.adjacent = new Uint8Array(size);
    this.state = new Uint8Array(size);
    this.status = 'ready'; // ready | playing | won | lost
    this.revealedCount = 0;
    this.flagCount = 0;
    this.moves = 0;
    this.minesPlaced = false;
    this.explodedIndex = -1;
    this.wrongFlags = [];
  };

  Game.prototype.index = function (r, c) {
    return r * this.cols + c;
  };

  Game.prototype.inBounds = function (r, c) {
    return r >= 0 && r < this.rows && c >= 0 && c < this.cols;
  };

  Game.prototype.cellState = function (index) {
    return this.state[index];
  };

  Game.prototype.minesLeft = function () {
    return this.mines - this.flagCount;
  };

  Game.prototype.isOver = function () {
    return this.status === 'won' || this.status === 'lost';
  };

  /** Places mines avoiding the first-clicked cell and its neighbours. */
  Game.prototype.placeMines = function (safeIndex) {
    var size = this.rows * this.cols;
    var forbidden = {};
    forbidden[safeIndex] = true;
    var self = this;
    neighbours(this.rows, this.cols, Math.floor(safeIndex / this.cols), safeIndex % this.cols, function (nr, nc, ni) {
      forbidden[ni] = true;
    });

    var pool = [];
    for (var i = 0; i < size; i++) {
      if (!forbidden[i]) pool.push(i);
    }
    // If the board is too dense for a full safe ring, fall back to only the clicked cell.
    if (pool.length < this.mines) {
      pool = [];
      for (var j = 0; j < size; j++) {
        if (j !== safeIndex) pool.push(j);
      }
    }

    // Partial Fisher-Yates: we only need the first `mines` entries.
    for (var k = 0; k < this.mines; k++) {
      var pick = k + Math.floor(Math.random() * (pool.length - k));
      var tmp = pool[k];
      pool[k] = pool[pick];
      pool[pick] = tmp;
      this.mineAt[pool[k]] = 1;
    }

    for (var r = 0; r < this.rows; r++) {
      for (var c = 0; c < this.cols; c++) {
        var idx = self.index(r, c);
        if (self.mineAt[idx]) continue;
        var count = 0;
        neighbours(self.rows, self.cols, r, c, function (nr, nc, ni) {
          if (self.mineAt[ni]) count++;
        });
        self.adjacent[idx] = count;
      }
    }

    this.minesPlaced = true;
  };

  /**
   * Reveals a cell, flood-filling through empty areas.
   * @returns {boolean} whether anything changed.
   */
  Game.prototype.reveal = function (r, c) {
    if (this.isOver() || !this.inBounds(r, c)) return false;
    var start = this.index(r, c);
    if (this.state[start] !== HIDDEN) return false;

    if (!this.minesPlaced) {
      this.placeMines(start);
      this.status = 'playing';
    }

    if (this.mineAt[start]) {
      this.state[start] = REVEALED;
      this.revealedCount++;
      this.explodedIndex = start;
      this.moves++;
      this.lose();
      return true;
    }

    this.floodReveal(start);
    this.moves++;
    this.checkWin();
    return true;
  };

  Game.prototype.floodReveal = function (start) {
    var stack = [start];
    var self = this;
    while (stack.length) {
      var idx = stack.pop();
      if (self.state[idx] !== HIDDEN) continue;
      self.state[idx] = REVEALED;
      self.revealedCount++;
      if (self.adjacent[idx] !== 0) continue;
      neighbours(self.rows, self.cols, Math.floor(idx / self.cols), idx % self.cols, function (nr, nc, ni) {
        if (self.state[ni] === HIDDEN && !self.mineAt[ni]) stack.push(ni);
      });
    }
  };

  Game.prototype.toggleFlag = function (r, c) {
    if (this.isOver() || !this.inBounds(r, c)) return false;
    var idx = this.index(r, c);
    if (this.state[idx] === REVEALED) return false;

    if (this.state[idx] === FLAGGED) {
      this.state[idx] = HIDDEN;
      this.flagCount--;
    } else {
      this.state[idx] = FLAGGED;
      this.flagCount++;
    }
    if (this.status === 'ready') this.status = 'playing';
    this.moves++;
    return true;
  };

  /**
   * Chording: on a revealed number whose flag count matches, open every
   * remaining hidden neighbour at once.
   */
  Game.prototype.chord = function (r, c) {
    if (this.isOver() || !this.inBounds(r, c)) return false;
    var idx = this.index(r, c);
    if (this.state[idx] !== REVEALED || this.adjacent[idx] === 0) return false;

    var self = this;
    var flagged = 0;
    var targets = [];
    neighbours(this.rows, this.cols, r, c, function (nr, nc, ni) {
      if (self.state[ni] === FLAGGED) flagged++;
      else if (self.state[ni] === HIDDEN) targets.push([nr, nc, ni]);
    });

    if (flagged !== this.adjacent[idx] || targets.length === 0) return false;

    var hitMine = false;
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (this.mineAt[t[2]]) {
        this.state[t[2]] = REVEALED;
        this.revealedCount++;
        this.explodedIndex = t[2];
        hitMine = true;
        break;
      }
      this.floodReveal(t[2]);
    }

    this.moves++;
    if (hitMine) this.lose();
    else this.checkWin();
    return true;
  };

  Game.prototype.lose = function () {
    this.status = 'lost';
    this.wrongFlags = [];
    for (var i = 0; i < this.state.length; i++) {
      if (this.state[i] === FLAGGED && !this.mineAt[i]) this.wrongFlags.push(i);
      if (this.state[i] === HIDDEN && this.mineAt[i]) this.state[i] = REVEALED;
    }
  };

  Game.prototype.checkWin = function () {
    var size = this.rows * this.cols;
    if (this.revealedCount !== size - this.mines) return;
    this.status = 'won';
    // Auto-flag every remaining mine so the finished board reads cleanly.
    for (var i = 0; i < size; i++) {
      if (this.mineAt[i] && this.state[i] !== FLAGGED) {
        this.state[i] = FLAGGED;
        this.flagCount++;
      }
    }
  };

  /** Compact, JSON-friendly snapshot used for undo and for saved games. */
  Game.prototype.snapshot = function () {
    return {
      rows: this.rows,
      cols: this.cols,
      mines: this.mines,
      difficulty: this.difficulty,
      status: this.status,
      revealedCount: this.revealedCount,
      flagCount: this.flagCount,
      moves: this.moves,
      minesPlaced: this.minesPlaced,
      explodedIndex: this.explodedIndex,
      wrongFlags: this.wrongFlags.slice(),
      mineAt: packBits(this.mineAt),
      adjacent: packDigits(this.adjacent),
      state: packStates(this.state)
    };
  };

  Game.prototype.restore = function (snap) {
    this.rows = snap.rows;
    this.cols = snap.cols;
    this.mines = snap.mines;
    this.difficulty = snap.difficulty || 'custom';
    this.status = snap.status;
    this.revealedCount = snap.revealedCount;
    this.flagCount = snap.flagCount;
    this.moves = snap.moves || 0;
    this.minesPlaced = !!snap.minesPlaced;
    this.explodedIndex = typeof snap.explodedIndex === 'number' ? snap.explodedIndex : -1;
    this.wrongFlags = snap.wrongFlags ? snap.wrongFlags.slice() : [];
    this.mineAt = unpackBits(snap.mineAt, this.rows * this.cols);
    this.adjacent = unpackDigits(snap.adjacent, this.rows * this.cols);
    this.state = unpackStates(snap.state, this.rows * this.cols);
    return this;
  };

  Game.fromSnapshot = function (snap) {
    var game = Object.create(Game.prototype);
    return game.restore(snap);
  };

  function packBits(arr) {
    var out = '';
    for (var i = 0; i < arr.length; i++) out += arr[i] ? '1' : '0';
    return out;
  }

  function unpackBits(str, size) {
    var arr = new Uint8Array(size);
    for (var i = 0; i < size; i++) arr[i] = str.charCodeAt(i) === 49 ? 1 : 0;
    return arr;
  }

  function packDigits(arr) {
    var out = '';
    for (var i = 0; i < arr.length; i++) out += String(arr[i]);
    return out;
  }

  function unpackDigits(str, size) {
    var arr = new Uint8Array(size);
    for (var i = 0; i < size; i++) arr[i] = str.charCodeAt(i) - 48;
    return arr;
  }

  function packStates(arr) {
    var out = '';
    for (var i = 0; i < arr.length; i++) out += STATE_CHARS[arr[i]];
    return out;
  }

  function unpackStates(str, size) {
    var arr = new Uint8Array(size);
    for (var i = 0; i < size; i++) {
      var ch = str.charAt(i);
      arr[i] = ch === 'r' ? REVEALED : ch === 'f' ? FLAGGED : HIDDEN;
    }
    return arr;
  }

  function clamp(value, min, max) {
    value = parseInt(value, 10);
    if (isNaN(value)) value = min;
    return Math.min(max, Math.max(min, value));
  }

  global.Minesweeper = {
    Game: Game,
    HIDDEN: HIDDEN,
    REVEALED: REVEALED,
    FLAGGED: FLAGGED,
    DIFFICULTIES: DIFFICULTIES,
    LIMITS: LIMITS,
    clamp: clamp
  };
})(typeof window !== 'undefined' ? window : this);
