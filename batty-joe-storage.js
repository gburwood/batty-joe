/* Batty Joe Development Specification v1.5.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};
  const KEYS = {
    save: 'battyJoe.save.v1',
    settings: 'battyJoe.settings.v1',
    highScores: 'battyJoe.highScores.v1'
  };

  const memory = Object.create(null);

  function getBackend() {
    try {
      if (global.localStorage) {
        const test = '__battyjoe_test__';
        global.localStorage.setItem(test, '1');
        global.localStorage.removeItem(test);
        return global.localStorage;
      }
    } catch (e) {
      // Fall through to memory storage.
    }
    return {
      getItem(key) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null; },
      setItem(key, value) { memory[key] = String(value); },
      removeItem(key) { delete memory[key]; }
    };
  }

  const backend = getBackend();

  function safeParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }

  function mergeSettings(base, saved) {
    const result = BJ.Utils.deepClone(base);
    if (!saved || typeof saved !== 'object') return result;
    Object.keys(saved).forEach(function (key) {
      if (key === 'keys' && saved.keys) {
        result.keys = Object.assign({}, result.keys, saved.keys);
      } else if (Object.prototype.hasOwnProperty.call(result, key)) {
        result[key] = saved[key];
      }
    });
    return result;
  }

  BJ.Storage = {
    keys: KEYS,

    loadSettings() {
      return mergeSettings(BJ.DefaultSettings, safeParse(backend.getItem(KEYS.settings), null));
    },

    saveSettings(settings) {
      backend.setItem(KEYS.settings, JSON.stringify(settings));
    },

    loadCampaign() {
      const data = safeParse(backend.getItem(KEYS.save), null);
      if (!data || data.specVersion !== BJ.VERSION) return null;
      return data;
    },

    saveCampaign(data) {
      const copy = BJ.Utils.deepClone(data);
      copy.specVersion = BJ.VERSION;
      copy.savedAt = new Date().toISOString();
      backend.setItem(KEYS.save, JSON.stringify(copy));
    },

    clearCampaign() {
      backend.removeItem(KEYS.save);
    },

    loadHighScores() {
      const rows = safeParse(backend.getItem(KEYS.highScores), []);
      return Array.isArray(rows) ? rows : [];
    },

    addHighScore(entry) {
      const rows = this.loadHighScores();
      rows.push(Object.assign({}, entry));
      rows.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.date).localeCompare(String(b.date));
      });
      const top = rows.slice(0, 10);
      backend.setItem(KEYS.highScores, JSON.stringify(top));
      return top;
    },

    qualifiesForHighScore(score) {
      const rows = this.loadHighScores();
      return rows.length < 10 || Number(score) > Number(rows[rows.length - 1].score || 0);
    },

    clearAllForTests() {
      Object.keys(KEYS).forEach(function (name) { backend.removeItem(KEYS[name]); });
    }
  };
}(window));
