/* Batty Joe Development Specification v1.7.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};
  const U = BJ.Utils;

  // Version and build info
  BJ.VERSION = '1.10.0-dev';
  BJ.BUILD_TIME = new Date().toISOString();

  function Input(settings) {
    this.settings = settings;
    this.down = Object.create(null);
    this.pressed = Object.create(null);
    this.codeDown = Object.create(null);
    this.captureAction = null;
    this.onCapture = null;
    this.canvas = null;
    this.pointer = { x: 0, y: 0, inside: false };
    this.mouseDown = false;
    this.mousePressed = false;
    this.bind();
  }

  Input.prototype.attachCanvas = function (canvas) { this.canvas = canvas; };

  Input.prototype.bind = function () {
    const self = this;
    global.addEventListener('keydown', function (event) {
      self.codeDown[event.code] = true;
      if (self.captureAction) {
        event.preventDefault();
        const action = self.captureAction;
        self.captureAction = null;
        self.settings.keys[action] = [event.code];
        if (self.onCapture) self.onCapture(action, event.code);
        return;
      }
      const action = self.actionForCode(event.code);
      if (action) {
        if (!self.down[action]) self.pressed[action] = true;
        self.down[action] = true;
        if (['left', 'right', 'action', 'bigBomb', 'pause', 'fullscreen'].indexOf(action) >= 0) event.preventDefault();
      }
    }, { passive: false });

    global.addEventListener('keyup', function (event) {
      self.codeDown[event.code] = false;
      const action = self.actionForCode(event.code);
      if (action) self.down[action] = false;
    });

    global.addEventListener('blur', function () {
      self.down = Object.create(null);
      self.pressed = Object.create(null);
      self.mouseDown = false;
      self.mousePressed = false;
      self.pointer.inside = false;
    });

    global.addEventListener('mousemove', function (event) {
      if (!self.canvas) return;
      const rect = self.canvas.getBoundingClientRect();
      self.pointer.x = (event.clientX - rect.left) * (self.canvas.width / rect.width);
      self.pointer.y = (event.clientY - rect.top) * (self.canvas.height / rect.height);
      self.pointer.inside = self.pointer.x >= 0 && self.pointer.y >= 0 && self.pointer.x <= self.canvas.width && self.pointer.y <= self.canvas.height;
    });
    global.addEventListener('mousedown', function (event) {
      if (event.button !== 0) return;
      self.mouseDown = true;
      self.mousePressed = true;
    });
    global.addEventListener('mouseup', function (event) {
      if (event.button !== 0) return;
      self.mouseDown = false;
    });
  };

  Input.prototype.actionForCode = function (code) {
    const keys = this.settings.keys || {};
    const names = Object.keys(keys);
    for (let i = 0; i < names.length; i += 1) {
      if ((keys[names[i]] || []).indexOf(code) >= 0) return names[i];
    }
    return null;
  };

  Input.prototype.isDown = function (action) { return !!this.down[action]; };
  Input.prototype.isCodeDown = function (code) { return !!this.codeDown[code]; };
  Input.prototype.wasPressed = function (action) {
    if (!this.pressed[action]) return false;
    delete this.pressed[action];
    return true;
  };
  Input.prototype.endFrame = function () { this.pressed = Object.create(null); this.mousePressed = false; };
  Input.prototype.isMouseDown = function () { return !!this.mouseDown; };
  Input.prototype.wasMousePressed = function () { const v = !!this.mousePressed; this.mousePressed = false; return v; };
  Input.prototype.getPointer = function () { return { x: this.pointer.x, y: this.pointer.y, inside: this.pointer.inside }; };
  Input.prototype.beginCapture = function (action, callback) {
    this.captureAction = action;
    this.onCapture = callback;
  };

  function App() {
    this.canvas = document.getElementById('gameCanvas');
    this.settings = BJ.Storage.loadSettings();
    this.input = new Input(this.settings);
    this.input.attachCanvas(this.canvas);
    this.audio = new BJ.AudioEngine(this.settings);
    this.query = U.parseQuery(global.location.search);
    this.game = new BJ.Game(this.canvas, {
      settings: this.settings,
      input: this.input,
      audio: this.audio,
      debug: this.query.debug,
      callbacks: {
        onStateChange: this.onStateChange.bind(this),
        onGameFinished: this.onGameFinished.bind(this),
        onVictory: this.onVictory.bind(this)
      }
    });
    this.lastTime = performance.now();
    this.settingsReturn = 'menu';
    this.pendingResult = null;
    this.loop = this.loop.bind(this);

    // Create level editor UI with error handling
    if (typeof BJ.LevelEditorUI !== 'function') {
      console.error('BJ.LevelEditorUI not found. Available on BJ:', Object.keys(BJ));
      throw new Error('LevelEditorUI module failed to load');
    }
    this.levelEditorUI = new BJ.LevelEditorUI();
    this.initializeHandcraftedLevels();
    this.bindUi();
    this.levelEditorUI.init(document.getElementById('gameShell'), this.game);
    this.applySettingsToUi();
    if (this.query.debug) {
      if (this.query.seed) document.getElementById('seedInput').value = this.query.seed;
      if (BJ.Config.difficulty[this.query.difficulty]) document.getElementById('difficultySelect').value = this.query.difficulty;
    }
    this.refreshContinueButton();
    this.setVersionInfo();
    this.showMainMenu();
    requestAnimationFrame(this.loop);
  }

  App.prototype.bindUi = function () {
    const self = this;
    function on(id, event, fn) {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, fn);
    }

    on('newGameBtn', 'click', function () { self.startPrebuiltCampaign(); });
    on('customCampaignBtn', 'click', function () { self.showCustomCampaignPanel(); });
    on('continueBtn', 'click', function () { self.continueSavedGame(); });
    on('highScoresBtn', 'click', function () { self.renderHighScores(); self.showPanel('highScoresPanel'); });
    on('howToBtn', 'click', function () { self.showPanel('howToPanel'); });
    on('levelEditorBtn', 'click', function () { self.levelEditorUI.open(); });
    on('settingsBtn', 'click', function () { self.settingsReturn = 'menu'; self.applySettingsToUi(); self.showPanel('settingsPanel'); });

    on('randomSeedBtn', 'click', function () { document.getElementById('seedInput').value = U.randomSeed(); });
    on('startGameBtn', 'click', function () { self.startNewGame(); });
    on('startCustomBtn', 'click', function () { self.startCustomCampaign(); });
    document.querySelectorAll('[data-back="menu"]').forEach(function (el) { el.addEventListener('click', function () { self.showMainMenu(); }); });

    on('resumeBtn', 'click', function () { self.hideOverlay(); self.game.resume(); });
    on('restartLevelBtn', 'click', function () { self.hideOverlay(); self.game.restartLevel(); });
    on('pauseSettingsBtn', 'click', function () { self.settingsReturn = 'pause'; self.applySettingsToUi(); self.showPanel('settingsPanel'); });
    on('quitMenuBtn', 'click', function () { self.showMainMenu(); });
    on('continueNowBtn', 'click', function () { self.game.useContinue(); self.hideOverlay(); });
    on('intermissionNextBtn', 'click', function () { if (self.game.intermissionPhase === 'prompt') { self.game.intermissionRemaining = 0; self.hideOverlay(); } });

    on('saveSettingsBtn', 'click', function () { self.saveSettings(); });
    on('musicToggleQuick', 'click', function () {
      self.settings.musicEnabled = !self.settings.musicEnabled;
      BJ.Storage.saveSettings(self.settings);
      self.audio.applySettings(self.settings);
      self.updateQuickMusicButton();
    });

    on('initialsForm', 'submit', function (event) {
      event.preventDefault();
      self.submitHighScore();
    });
    on('gameOverMenuBtn', 'click', function () { self.showMainMenu(); });
    on('victoryMenuBtn', 'click', function () { self.showMainMenu(); });
    on('hardLoopBtn', 'click', function () { self.startHardLoop(); });

    ['left', 'right', 'action', 'bigBomb', 'pause', 'fullscreen'].forEach(function (action) {
      on('key-' + action, 'click', function () {
        const button = document.getElementById('key-' + action);
        button.textContent = 'PRESS KEY';
        self.input.beginCapture(action, function (name, code) {
          button.textContent = self.prettyKey(code);
        });
      });
    });

    global.addEventListener('keydown', function (event) {
      self.audio.resume();
      if (event.code === self.primaryKey('pause')) {
        if (self.game.state === BJ.State.PAUSED) {
          self.hideOverlay();
          self.game.resume();
        } else if (self.game.isPlayableState() && !self.game.attract) {
          self.game.pause();
        }
      }
      if (event.code === self.primaryKey('fullscreen')) self.toggleFullscreen();
      if (self.query.debug) self.handleDebugKey(event.code);
    });

    global.addEventListener('blur', function () {
      if (self.settings.pauseOnBlur && self.game.isPlayableState() && !self.game.attract) self.game.pause();
    });

    document.addEventListener('fullscreenchange', function () {
      document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement);
    });
  };

  App.prototype.initializeHandcraftedLevels = function () {
    // Check if BJ.HandcraftedLevelsLoader is the constructor function (not yet instantiated)
    if (BJ.HandcraftedLevelsData && typeof BJ.HandcraftedLevelsLoader === 'function') {
      const LoaderClass = BJ.HandcraftedLevelsLoader;
      const loader = new LoaderClass();
      loader.loadFromYAML(BJ.HandcraftedLevelsData);
      BJ.HandcraftedLevelsLoader = loader;
      if (this.query.debug) {
        console.log('[App] Handcrafted levels initialized:', loader.listDesignerLevels().length, 'designer levels');
      }
    }
  };

  App.prototype.primaryKey = function (action) {
    return (this.settings.keys[action] || [])[0] || '';
  };

  App.prototype.prettyKey = function (code) {
    return String(code || '').replace(/^Key/, '').replace(/^Arrow/, '').replace('Space', 'SPACE').toUpperCase();
  };

  App.prototype.startNewGame = function () {
    const difficulty = document.getElementById('difficultySelect').value;
    let seed = document.getElementById('seedInput').value.trim();
    if (!seed) seed = U.randomSeed();
    BJ.Storage.clearCampaign();
    this.hideOverlay();
    this.audio.resume();
    this.game.newCampaign({
      seed,
      difficulty,
      level: this.query.debug ? (this.query.level || 1) : 1,
      lives: this.query.debug ? (this.query.lives || undefined) : undefined,
      debugModified: !!this.query.debug
    });
    if (this.query.debug && this.query.frenzy) global.setTimeout((function () { this.game.debugTriggerFrenzy(this.query.frenzyType || 'invaders'); }).bind(this), 350);
  };

    App.prototype.startPrebuiltCampaign = function () {
      BJ.Storage.clearCampaign();
       BJ.CustomCampaign = null;
       BJ.TestPlayLevel = null;
      this.hideOverlay();
      this.audio.resume();
      this.game.newCampaign({
        seed: 'PREBUILT',
        difficulty: 'normal',
        level: 1
      });
    };

  App.prototype.continueSavedGame = function () {
    const save = BJ.Storage.loadCampaign();
    if (!save) { this.refreshContinueButton(); return; }
    this.settings = BJ.Storage.loadSettings();
    this.game.setSettings(this.settings);
    this.audio.applySettings(this.settings);
    this.hideOverlay();
    this.audio.resume();
    this.game.resumeCampaign(save);
    if (this.query.debug) this.game.highScoreEligible = false;
  };

  App.prototype.showCustomCampaignPanel = function () {
    const self = this;
    const listEl = document.getElementById('customLevelsList');
    const noLevelsEl = document.getElementById('noCustomLevels');
    const startBtn = document.getElementById('startCustomBtn');

    // Get stored user levels
    const levels = this.levelEditorUI.editor.listStoredLevels();

    this.customCampaignSelection = [];

    if (levels.length === 0) {
      listEl.innerHTML = '';
      noLevelsEl.style.display = 'block';
      startBtn.disabled = true;
      this.showPanel('customCampaignPanel');
      return;
    }

    noLevelsEl.style.display = 'none';

    function renderLevels() {
      listEl.innerHTML = '';
      const selected = self.customCampaignSelection;
      const orderedLevels = levels.slice().sort(function (left, right) {
        const leftIndex = selected.indexOf(left.id);
        const rightIndex = selected.indexOf(right.id);
        if (leftIndex < 0 && rightIndex < 0) return 0;
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
      });

      orderedLevels.forEach(function (level) {
        const selectedIndex = selected.indexOf(level.id);
        const itemEl = document.createElement('div');
        itemEl.className = 'custom-level-item' + (selectedIndex >= 0 ? ' selected' : '');
        itemEl.dataset.levelId = level.id;
        itemEl.draggable = selectedIndex >= 0;

        const infoEl = document.createElement('div');
        infoEl.className = 'custom-level-item-info';
        const titleEl = document.createElement('div');
        titleEl.className = 'custom-level-item-title';
        titleEl.textContent = (selectedIndex >= 0 ? (selectedIndex + 1) + '. ' : '') + level.title;
        const detailsEl = document.createElement('div');
        detailsEl.className = 'custom-level-item-details';
        detailsEl.textContent = level.difficulty.toUpperCase() + ' • ' + level.bricks + ' bricks';
        infoEl.appendChild(titleEl);
        infoEl.appendChild(detailsEl);
        itemEl.appendChild(infoEl);

        itemEl.addEventListener('click', function () {
          if (selectedIndex >= 0) selected.splice(selectedIndex, 1);
          else selected.push(level.id);
          startBtn.disabled = selected.length === 0;
          renderLevels();
        });

        itemEl.addEventListener('dragstart', function (event) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', level.id);
          itemEl.classList.add('dragging');
        });
        itemEl.addEventListener('dragend', function () { itemEl.classList.remove('dragging'); });
        itemEl.addEventListener('dragover', function (event) {
          if (selectedIndex >= 0) event.preventDefault();
        });
        itemEl.addEventListener('drop', function (event) {
          event.preventDefault();
          const draggedId = event.dataTransfer.getData('text/plain');
          const fromIndex = selected.indexOf(draggedId);
          if (selectedIndex < 0 || fromIndex < 0 || fromIndex === selectedIndex) return;
          selected.splice(fromIndex, 1);
          selected.splice(selectedIndex, 0, draggedId);
          renderLevels();
        });
        listEl.appendChild(itemEl);
      });
      startBtn.disabled = selected.length === 0;
    }

    renderLevels();

    this.showPanel('customCampaignPanel');
  };

  App.prototype.startCustomCampaign = function () {
    if (!this.customCampaignSelection || this.customCampaignSelection.length === 0) {
      alert('Select at least one level');
      return;
    }

    BJ.Storage.clearCampaign();
    BJ.TestPlayLevel = null;
    BJ.CustomCampaign = {
      levelIds: this.customCampaignSelection.slice(0, 20),
      currentLevelIndex: 0,
      resumeLevel: Math.min(BJ.Config.campaignLevels + 1, this.customCampaignSelection.length + 1)
    };

    this.hideOverlay();
    this.audio.resume();
    this.game.newCampaign({
      type: 'custom',
      seed: 'CUSTOM-' + Date.now(),
      difficulty: 'normal',
      level: 1,
      customCampaign: true
    });
  };

  App.prototype.showMainMenu = function () {
    this.refreshContinueButton();
    this.updateQuickMusicButton();
    this.showPanel('mainMenuPanel');
    this.startAttractMode();
  };

  App.prototype.startAttractMode = function () {
    this.game.newCampaign({ seed: 'BATTY-DEMO', difficulty: 'normal', attract: true });
  };

  App.prototype.showPanel = function (id) {
    const overlay = document.getElementById('overlay');
    overlay.classList.add('visible');
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
    const panel = document.getElementById(id);
    if (panel) panel.classList.add('active');
  };

  App.prototype.hideOverlay = function () {
    document.getElementById('overlay').classList.remove('visible');
    document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
  };

  App.prototype.refreshContinueButton = function () {
    const btn = document.getElementById('continueBtn');
    const save = BJ.Storage.loadCampaign();
    btn.disabled = !save;
    btn.textContent = save ? ('CONTINUE  L' + save.currentLevel) : 'CONTINUE';
  };

  App.prototype.setVersionInfo = function () {
    const versionEl = document.getElementById('versionInfo');
    if (versionEl) {
      const buildTime = new Date(BJ.BUILD_TIME).toLocaleString();
      versionEl.textContent = 'v' + BJ.VERSION + ' • Built: ' + buildTime;
    }
  };

  App.prototype.onStateChange = function (next, old, detail) {
    if (this.game.attract) return;
    if (next === BJ.State.PAUSED) {
      document.getElementById('pauseSeed').textContent = this.game.seed;
      this.showPanel('pausePanel');
    } else if (next === BJ.State.LEVEL_COMPLETE) {
      const bonus = detail && detail.bonus ? detail.bonus : { total: 0, time: 0, lives: 0, combo: 0, continues: 0 };
      document.getElementById('intermissionTitle').textContent = 'LEVEL ' + this.game.level + ' COMPLETE';
      document.getElementById('intermissionScore').textContent = U.formatScore(this.game.score);
      document.getElementById('intermissionTime').textContent = U.formatTime(this.game.levelElapsed);
      document.getElementById('intermissionBonus').textContent = U.formatScore(bonus.total);
      this.showPanel('intermissionPanel');
    } else if (next === BJ.State.CONTINUE) {
      this.showPanel('continuePanel');
    } else if ([BJ.State.PLAYING, BJ.State.BOSS, BJ.State.FRENZY_TRANSITION_IN, BJ.State.FRENZY_ACTIVE, BJ.State.FRENZY_TRANSITION_OUT, BJ.State.LIFE_LOST].indexOf(next) >= 0) {
      this.hideOverlay();
    }
  };

  App.prototype.onGameFinished = function (result) {
    this.pendingResult = result;
    if (result.highScoreEligible && BJ.Storage.qualifiesForHighScore(result.score)) {
      document.getElementById('initialsScore').textContent = U.formatScore(result.score);
      document.getElementById('initialsInput').value = '';
      this.showPanel('initialsPanel');
      document.getElementById('initialsInput').focus();
    } else {
      this.showGameOver(result);
    }
  };

  App.prototype.onVictory = function (result) {
    this.pendingResult = result;
    if (result.highScoreEligible && BJ.Storage.qualifiesForHighScore(result.score)) {
      document.getElementById('initialsScore').textContent = U.formatScore(result.score);
      document.getElementById('initialsInput').value = '';
      document.getElementById('initialsPanel').dataset.after = 'victory';
      this.showPanel('initialsPanel');
      document.getElementById('initialsInput').focus();
    } else {
      this.showVictory(result);
    }
  };

  App.prototype.submitHighScore = function () {
    if (!this.pendingResult) return;
    const result = Object.assign({}, this.pendingResult, {
      initials: U.normalizeInitials(document.getElementById('initialsInput').value)
    });
    BJ.Storage.addHighScore(result);
    const afterVictory = this.pendingResult.campaignCompleted;
    this.pendingResult = null;
    document.getElementById('initialsPanel').dataset.after = '';
    if (afterVictory) this.showVictory(result); else this.showGameOver(result);
  };

  App.prototype.showGameOver = function (result) {
    document.getElementById('gameOverScore').textContent = U.formatScore(result.score);
    document.getElementById('gameOverLevel').textContent = String(result.levelReached);
    this.showPanel('gameOverPanel');
  };

  App.prototype.showVictory = function (result) {
    document.getElementById('victoryScore').textContent = U.formatScore(result.score);
    document.getElementById('victorySeed').textContent = result.campaignSeed;
    document.getElementById('hardLoopBtn').textContent = result.difficulty === 'hard' ? 'REPLAY HARD LOOP' : 'START HARDER LOOP';
    this.showPanel('victoryPanel');
  };

  App.prototype.startHardLoop = function () {
    const current = this.game.difficulty;
    const next = current === 'easy' ? 'normal' : 'hard';
    const seed = this.game.seed;
    BJ.Storage.clearCampaign();
    this.hideOverlay();
    this.game.newCampaign({ seed, difficulty: next });
  };

  App.prototype.renderHighScores = function () {
    const body = document.getElementById('highScoresBody');
    const rows = BJ.Storage.loadHighScores();
    body.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.textContent = 'NO SCORES YET. THE BRICKS ARE GETTING COCKY.';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach(function (row, index) {
      const tr = document.createElement('tr');
      [index + 1, row.initials, U.formatScore(row.score), String(row.difficulty).toUpperCase(), row.levelReached, row.campaignSeed].forEach(function (value) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  };

  App.prototype.applySettingsToUi = function () {
    const s = this.settings;
    document.getElementById('musicEnabled').checked = !!s.musicEnabled;
    document.getElementById('sfxEnabled').checked = !!s.sfxEnabled;
    document.getElementById('globalMute').checked = !!s.globalMute;
    document.getElementById('musicVolume').value = s.musicVolume;
    document.getElementById('sfxVolume').value = s.sfxVolume;
    document.getElementById('reducedShake').checked = !!s.reducedShake;
    document.getElementById('reducedFlashing').checked = !!s.reducedFlashing;
    document.getElementById('colourBlindCues').checked = !!s.colourBlindCues;
    document.getElementById('pauseOnBlur').checked = !!s.pauseOnBlur;
    ['left', 'right', 'action', 'bigBomb', 'pause', 'fullscreen'].forEach((function (action) {
      document.getElementById('key-' + action).textContent = this.prettyKey(this.primaryKey(action));
    }).bind(this));
    this.updateQuickMusicButton();
  };

  App.prototype.saveSettings = function () {
    const s = this.settings;
    s.musicEnabled = document.getElementById('musicEnabled').checked;
    s.sfxEnabled = document.getElementById('sfxEnabled').checked;
    s.globalMute = document.getElementById('globalMute').checked;
    s.musicVolume = Number(document.getElementById('musicVolume').value);
    s.sfxVolume = Number(document.getElementById('sfxVolume').value);
    s.reducedShake = document.getElementById('reducedShake').checked;
    s.reducedFlashing = document.getElementById('reducedFlashing').checked;
    s.colourBlindCues = document.getElementById('colourBlindCues').checked;
    s.pauseOnBlur = document.getElementById('pauseOnBlur').checked;
    BJ.Storage.saveSettings(s);
    this.audio.applySettings(s);
    this.game.setSettings(s);
    this.game.autosave('settings');
    if (this.settingsReturn === 'pause') this.showPanel('pausePanel'); else this.showMainMenu();
  };

  App.prototype.updateQuickMusicButton = function () {
    const btn = document.getElementById('musicToggleQuick');
    if (btn) btn.textContent = this.settings.musicEnabled && !this.settings.globalMute ? 'MUSIC ON' : 'MUSIC OFF';
  };

  App.prototype.toggleFullscreen = function () {
    const root = document.getElementById('gameShell');
    if (!document.fullscreenElement) {
      if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  };

  App.prototype.handleDebugKey = function (code) {
    if (!this.game || !this.game.isPlayableState()) return;
    const powerMap = {
      Digit1: 'wide', Digit2: 'narrow', Digit3: 'multiball', Digit4: 'sticky', Digit5: 'laser',
      Digit6: 'slow_ball', Digit7: 'fast_ball', Digit8: 'extra_life', Digit9: 'penetrating_ball', Digit0: 'imprecise_paddle'
    };
    if (powerMap[code]) this.game.debugSpawnPowerup(powerMap[code]);
    if (code === 'KeyR') this.game.debugTriggerFrenzy('invaders');
    if (code === 'KeyT') this.game.debugTriggerFrenzy('fps');
    if (code === 'KeyP') this.game.debugTriggerFrenzy('pinball');
    if (code === 'KeyO') this.game.debugTriggerFrenzy('asteroids');
    if (code === 'KeyM') this.game.debugTriggerFrenzy('missile');
    if (code === 'KeyV') this.game.debugTriggerFrenzy('revenge');
    if (code === 'KeyY') this.game.debugTriggerFrenzy('gridrunner');
    if (code === 'KeyG') this.game.debugSpawnBigBombPower();
    if (code === 'KeyN') this.game.debugAdvanceLevel();
    if (code === 'KeyK') this.game.debugDestroyRequired();
    if (code === 'KeyL') this.game.debugAddLife();
    if (code === 'KeyI') { this.game.highScoreEligible = false; this.game.debugInvulnerable = !this.game.debugInvulnerable; }
    if (code === 'KeyB') this.game.debugJumpToBoss();
  };

  App.prototype.loop = function (now) {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;

    this.game.update(dt);
    this.game.render();

    if (this.game.state === BJ.State.CONTINUE && !this.game.attract) {
      document.getElementById('continueCountdown').textContent = Math.max(0, Math.ceil(this.game.continueRemaining));
      document.getElementById('continuesLeft').textContent = this.game.continuesRemaining;
    }
    if (this.game.state === BJ.State.LEVEL_COMPLETE && !this.game.attract) {
      const nextBtn = document.getElementById('intermissionNextBtn');
      const prompt = this.game.intermissionPhase === 'prompt';
      nextBtn.style.visibility = prompt ? 'visible' : 'hidden';
      nextBtn.disabled = !prompt;
      if (prompt) nextBtn.textContent = 'NEXT LEVEL  ' + Math.max(0, Math.ceil(this.game.intermissionRemaining));
    }
    if (this.game.attract && (this.game.state === BJ.State.GAME_OVER || this.game.state === BJ.State.VICTORY || this.game.state === BJ.State.CONTINUE)) {
      this.startAttractMode();
    }

    this.input.endFrame();
    requestAnimationFrame(this.loop);
  };

  BJ.Input = Input;
  BJ.App = App;

  document.addEventListener('DOMContentLoaded', function () {
    BJ.app = new App();
  });
}(window));
