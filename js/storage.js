/*
 * Minesweeper Latte - persistence layer (localStorage).
 * Handles manual save slots, the auto-resume slot and best times.
 */
(function (global) {
  'use strict';

  var PREFIX = 'minesweeper-latte:';
  var SLOT_KEY = PREFIX + 'slot:';
  var AUTO_KEY = PREFIX + 'autosave';
  var BEST_KEY = PREFIX + 'best';
  var SLOT_COUNT = 3;

  var memory = {};
  var available = (function () {
    try {
      var probe = PREFIX + 'probe';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  })();

  function readRaw(key) {
    if (!available) return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    try {
      return global.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function writeRaw(key, value) {
    if (!available) {
      memory[key] = value;
      return true;
    }
    try {
      global.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      // Quota exceeded or storage disabled mid-session: keep the game playable.
      memory[key] = value;
      return false;
    }
  }

  function removeRaw(key) {
    delete memory[key];
    if (!available) return;
    try {
      global.localStorage.removeItem(key);
    } catch (err) {
      /* ignore */
    }
  }

  function readJson(key) {
    var raw = readRaw(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  function writeJson(key, value) {
    return writeRaw(key, JSON.stringify(value));
  }

  var Storage = {
    slotCount: SLOT_COUNT,
    isPersistent: available,

    saveSlot: function (slot, payload) {
      payload.savedAt = Date.now();
      return writeJson(SLOT_KEY + slot, payload);
    },

    loadSlot: function (slot) {
      return readJson(SLOT_KEY + slot);
    },

    clearSlot: function (slot) {
      removeRaw(SLOT_KEY + slot);
    },

    listSlots: function () {
      var slots = [];
      for (var i = 1; i <= SLOT_COUNT; i++) {
        slots.push({ slot: i, data: this.loadSlot(i) });
      }
      return slots;
    },

    saveAuto: function (payload) {
      payload.savedAt = Date.now();
      return writeJson(AUTO_KEY, payload);
    },

    loadAuto: function () {
      return readJson(AUTO_KEY);
    },

    clearAuto: function () {
      removeRaw(AUTO_KEY);
    },

    getBestTimes: function () {
      return readJson(BEST_KEY) || {};
    },

    /**
     * Records a win. Only clean runs (no undo used) are eligible.
     * @returns {boolean} true when this run became the new record.
     */
    recordBestTime: function (difficulty, seconds, clean) {
      if (!clean || difficulty === 'custom') return false;
      var best = this.getBestTimes();
      if (best[difficulty] && best[difficulty] <= seconds) return false;
      best[difficulty] = seconds;
      writeJson(BEST_KEY, best);
      return true;
    },

    clearBestTimes: function () {
      removeRaw(BEST_KEY);
    }
  };

  global.MinesweeperStorage = Storage;
})(typeof window !== 'undefined' ? window : this);
