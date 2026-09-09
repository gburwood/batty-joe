/* Batty Joe Level Editor UI Manager */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};

  function LevelEditorUI() {
    this.editor = null;
    this.isOpen = false;
    this.currentListIndex = null;
  }

  LevelEditorUI.prototype.init = function (gameShell, gameStateManager) {
    const self = this;
    this.gameShell = gameShell;
    this.gameStateManager = gameStateManager;
    this.editor = new BJ.LevelEditor();

    // UI Elements
    this.levelEditorPanel = document.getElementById('levelEditorPanel');
    if (!this.levelEditorPanel) {
      console.error('Level editor panel not found in DOM');
      return;
    }
    
    this.levelEditorGrid = document.getElementById('levelEditorGrid');
    this.brickCountDisplay = document.getElementById('brickCount');
    this.brickWarning = document.getElementById('brickWarning');

    // Form inputs
    this.levelIdInput = document.getElementById('levelIdInput');
    this.levelTitleInput = document.getElementById('levelTitleInput');
    this.levelDifficultySelect = document.getElementById('levelDifficultySelect');
    this.levelDescriptionInput = document.getElementById('levelDescriptionInput');
    this.powerupSelect = document.getElementById('powerupSelect');
    this.frenzyTypeSection = document.getElementById('frenzyTypeSection');
    this.frenzyTypeSelect = document.getElementById('frenzyTypeSelect');

    // Buttons
    this.levelEditorBtn = document.getElementById('levelEditorBtn');
    this.clearGridBtn = document.getElementById('clearGridBtn');
    this.testPlayBtn = document.getElementById('testPlayBtn');
    this.saveLevelBtn = document.getElementById('saveLevelBtn');
    this.loadLevelBtn = document.getElementById('loadLevelBtn');
    this.exportLevelBtn = document.getElementById('exportLevelBtn');
    this.importLevelBtn = document.getElementById('importLevelBtn');

    // Check if all required elements exist
    if (!this.levelEditorBtn || !this.clearGridBtn || !this.saveLevelBtn) {
      console.error('Some level editor UI elements not found');
      return;
    }

    // Initialize selection
    this.currentSelection = { type: BJ.LevelEditor.BRICK_TYPES.STANDARD, durability: 1, powerup: null, frenzyType: 'invaders' };

    // Bind events
    this.levelEditorBtn.addEventListener('click', function () { self.open(); });
    this.clearGridBtn.addEventListener('click', function () { self.confirmClearGrid(); });
    this.testPlayBtn.addEventListener('click', function () { self.testPlay(); });
    this.saveLevelBtn.addEventListener('click', function () { self.save(); });
    this.loadLevelBtn.addEventListener('click', function () { self.showLoadDialog(); });
    this.exportLevelBtn.addEventListener('click', function () { self.showExportDialog(); });
    this.importLevelBtn.addEventListener('click', function () { self.showImportDialog(); });

    // Brick type buttons
    const brickTypeButtons = document.querySelectorAll('.brick-type-buttons .palette-btn');
    if (brickTypeButtons.length > 0) {
      brickTypeButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          self.selectBrickType(this.getAttribute('data-type'));
        });
      });
    }

    // Durability buttons
    const durabilityButtons = document.querySelectorAll('.durability-buttons .durability-btn');
    if (durabilityButtons.length > 0) {
      durabilityButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          self.selectDurability(parseInt(this.getAttribute('data-durability')));
        });
      });
    }

    // Form inputs event listeners
    if (this.powerupSelect) {
      this.powerupSelect.addEventListener('change', function () {
        self.currentSelection.powerup = self.powerupSelect.value || null;
        // Show/hide frenzy type selector based on powerup selection
        if (self.frenzyTypeSection) {
          self.frenzyTypeSection.style.display = self.currentSelection.powerup === 'frenzy_pickup' ? 'block' : 'none';
        }
      });
    }

    if (this.frenzyTypeSelect) {
      this.frenzyTypeSelect.addEventListener('change', function () {
        self.currentSelection.frenzyType = self.frenzyTypeSelect.value;
      });
    }

    this.drawGrid();
    
    // Initialize UI state
    this.selectBrickType(BJ.LevelEditor.BRICK_TYPES.STANDARD);
    this.selectDurability(1);
  };

  LevelEditorUI.prototype.open = function () {
    if (!this.levelEditorPanel) return;
    const overlay = document.getElementById('overlay');
    if (!overlay) return;
    
    overlay.classList.add('visible');
    document.querySelectorAll('.panel').forEach(function (p) { 
      p.classList.remove('active'); 
    });
    this.levelEditorPanel.classList.add('active');
    this.isOpen = true;
    this.editor.clearGrid();
    this.drawGrid();
    this.updateBrickCount();
  };

  LevelEditorUI.prototype.close = function () {
    if (!this.levelEditorPanel) return;
    const overlay = document.getElementById('overlay');
    const mainMenuPanel = document.getElementById('mainMenuPanel');
    
    if (overlay) overlay.classList.add('visible');
    document.querySelectorAll('.panel').forEach(function (p) { 
      p.classList.remove('active'); 
    });
    if (mainMenuPanel) mainMenuPanel.classList.add('active');
    this.isOpen = false;
  };

  LevelEditorUI.prototype.drawGrid = function () {
    const self = this;
    if (!this.levelEditorGrid) return;
    
    this.levelEditorGrid.innerHTML = '';
    const dims = this.editor.getGridDimensions();

    for (let row = 0; row < dims.rows; row++) {
      for (let col = 0; col < dims.cols; col++) {
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.col = col;
        cell.dataset.row = row;

        const brick = this.editor.getBrick(col, row);
        if (brick) {
          cell.classList.add('filled-' + brick.type);
          cell.textContent = brick.durability;
        }

        cell.addEventListener('click', function () {
          if (self.currentSelection.type === BJ.LevelEditor.BRICK_TYPES.INDESTRUCTIBLE) {
            self.editor.placeBrick(col, row, BJ.LevelEditor.BRICK_TYPES.INDESTRUCTIBLE, 0);
          } else if (brick) {
            self.editor.removeBrick(col, row);
          } else {
            // Construct proper powerup type for frenzy
            let powerup = self.currentSelection.powerup;
            if (powerup === 'frenzy_pickup' && self.currentSelection.frenzyType) {
              const frenzyTypeMap = {
                'invaders': 'space_invaders_frenzy',
                'fps': 'fps_frenzy',
                'pinball': 'pinball_frenzy',
                'asteroids': 'asteroids_frenzy',
                'missile_command': 'missile_command_frenzy',
                'arkanoid_revenge': 'arkanoid_revenge_frenzy',
                'grid_runner': 'grid_runner_frenzy'
              };
              powerup = frenzyTypeMap[self.currentSelection.frenzyType] || powerup;
            }
              // Check frenzy limit (max 2 per level)
              if (powerup && powerup.indexOf('frenzy') > -1) {
                const frenzyCount = self.editor.grid.reduce(function (count, row) {
                  return count + row.filter(function (brick) {
                    return brick && brick.powerup && brick.powerup.indexOf('frenzy') > -1;
                  }).length;
                }, 0);
                if (frenzyCount >= 2) {
                  alert('Maximum 2 frenzy power-ups per level. Game enforces this limit.');
                  return;
                }
              }
            self.editor.placeBrick(col, row, self.currentSelection.type, self.currentSelection.durability, powerup, self.currentSelection.frenzyType);
          }
          self.drawGrid();
          self.updateBrickCount();
        });

        this.levelEditorGrid.appendChild(cell);
      }
    }
  };

  LevelEditorUI.prototype.updateBrickCount = function () {
    const count = this.editor.getBrickCount();
    if (this.brickCountDisplay) {
      this.brickCountDisplay.textContent = count;
    }
    if (this.brickWarning) {
      this.brickWarning.style.display = count < BJ.LevelEditor.MIN_BRICKS ? 'inline' : 'none';
    }
  };

  LevelEditorUI.prototype.selectBrickType = function (type) {
    this.currentSelection.type = type;
    const brickTypeButtons = document.querySelectorAll('.brick-type-buttons .palette-btn');
    if (brickTypeButtons.length === 0) return;
    
    brickTypeButtons.forEach(function (btn) {
      btn.classList.remove('active');
      if (btn.getAttribute('data-type') === type) {
        btn.classList.add('active');
      }
    });
  };

  LevelEditorUI.prototype.selectDurability = function (durability) {
    this.currentSelection.durability = durability;
    const durabilityButtons = document.querySelectorAll('.durability-buttons .durability-btn');
    if (durabilityButtons.length === 0) return;
    
    durabilityButtons.forEach(function (btn) {
      btn.classList.remove('active');
      if (parseInt(btn.getAttribute('data-durability')) === durability) {
        btn.classList.add('active');
      }
    });
  };

  LevelEditorUI.prototype.confirmClearGrid = function () {
    const msg = 'Clear all bricks? This cannot be undone.';
    if (confirm(msg)) {
      this.editor.clearGrid();
      this.drawGrid();
      this.updateBrickCount();
    }
  };

  LevelEditorUI.prototype.save = function () {
    const self = this;
    if (!this.levelIdInput || !this.levelTitleInput || !this.levelDifficultySelect) {
      alert('Form elements not initialized');
      return;
    }
    
    const id = this.levelIdInput.value.trim();
    const title = this.levelTitleInput.value.trim();
    const difficulty = this.levelDifficultySelect.value;
    const description = this.levelDescriptionInput ? this.levelDescriptionInput.value.trim() : '';

    if (!id || !title) {
      alert('ID and Title are required');
      return;
    }

    const levelData = this.editor.gridToLevel(id, title, difficulty, description);
    const validation = this.editor.validate(levelData);

    if (!validation.valid) {
      alert('Errors:\n' + validation.errors.join('\n'));
      return;
    }

    const result = this.editor.saveToStorage(levelData);
    if (result.success) {
      alert('Level "' + title + '" saved successfully!');
      this.levelIdInput.value = '';
      this.levelTitleInput.value = '';
      this.levelDescriptionInput.value = '';
    } else {
      alert('Save failed:\n' + result.errors.join('\n'));
    }
  };

  LevelEditorUI.prototype.showLoadDialog = function () {
    const self = this;
    const levels = this.editor.listStoredLevels();

    if (levels.length === 0) {
      alert('No saved levels found');
      return;
    }

    let msg = 'Select a level to load:\n\n';
    levels.forEach(function (level, idx) {
      msg += '[' + idx + '] ' + level.title + ' (' + level.difficulty.toUpperCase() + ', ' + level.bricks + ' bricks)\n';
    });
    msg += '\nEnter number (or cancel):';

    const input = prompt(msg);
    if (input === null) return;

    const idx = parseInt(input);
    if (isNaN(idx) || idx < 0 || idx >= levels.length) {
      alert('Invalid selection');
      return;
    }

    const levelData = this.editor.loadFromStorage(levels[idx].id);
    if (levelData) {
      this.levelIdInput.value = levelData.id;
      this.levelTitleInput.value = levelData.title;
      this.levelDifficultySelect.value = levelData.difficulty;
      this.levelDescriptionInput.value = levelData.description || '';
      this.drawGrid();
      this.updateBrickCount();
      alert('Level loaded: ' + levelData.title);
    } else {
      alert('Failed to load level');
    }
  };

  LevelEditorUI.prototype.showExportDialog = function () {
    if (!this.levelIdInput || !this.levelTitleInput || !this.levelDifficultySelect) {
      alert('Form elements not initialized');
      return;
    }
    
    const id = this.levelIdInput.value.trim();
    const title = this.levelTitleInput.value.trim();

    if (!id || !title) {
      alert('ID and Title are required before export');
      return;
    }

    const levelData = this.editor.gridToLevel(id, title, this.levelDifficultySelect.value, this.levelDescriptionInput ? this.levelDescriptionInput.value : '');
    const validation = this.editor.validate(levelData);

    if (!validation.valid) {
      alert('Cannot export invalid level:\n' + validation.errors.join('\n'));
      return;
    }

    const json = JSON.stringify(levelData, null, 2);
    const action = prompt('Export level:\n\n[1] Download as JSON\n[2] Copy to clipboard\n\nEnter 1 or 2 (or cancel):', '2');

    if (action === '1') {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = id + '.json';
      a.click();
      URL.revokeObjectURL(url);
    } else if (action === '2') {
      try {
        navigator.clipboard.writeText(json).then(function () {
          alert('Level JSON copied to clipboard');
        }).catch(function (err) {
          prompt('Copy this JSON manually:\n\n', json);
        });
      } catch (e) {
        prompt('Copy this JSON manually:\n\n', json);
      }
    }
  };

  LevelEditorUI.prototype.showImportDialog = function () {
    const self = this;
    if (!this.levelIdInput || !this.levelTitleInput || !this.levelDifficultySelect) {
      alert('Form elements not initialized');
      return;
    }
    
    const jsonStr = prompt('Paste level JSON or enter filename to load:');
    if (!jsonStr) return;

    const result = this.editor.importFromJSON(jsonStr);
    if (result.success) {
      const level = result.level;
      this.levelIdInput.value = level.id;
      this.levelTitleInput.value = level.title;
      this.levelDifficultySelect.value = level.difficulty;
      if (this.levelDescriptionInput) this.levelDescriptionInput.value = level.description || '';
      this.drawGrid();
      this.updateBrickCount();
      alert('Level imported successfully: ' + level.title);
    } else {
      alert('Import failed:\n' + result.errors.join('\n'));
    }
  };

  LevelEditorUI.prototype.testPlay = function () {
    if (!this.levelIdInput || !this.levelTitleInput) return;
    
    const id = this.levelIdInput.value.trim() || 'test_level';
    const title = this.levelTitleInput.value.trim() || 'Test Level';
    const difficulty = this.levelDifficultySelect ? this.levelDifficultySelect.value : 'normal';

    const levelData = this.editor.gridToLevel(id, title, difficulty, this.levelDescriptionInput ? this.levelDescriptionInput.value : '');
    const validation = this.editor.validate(levelData);

    if (!validation.valid) {
      alert('Cannot test invalid level:\n' + validation.errors.join('\n'));
      return;
    }

    // Store the test level in a temporary location so the game can load it
    BJ.TestPlayLevel = levelData;

    // Close editor and trigger test play
    this.close();
    if (this.gameStateManager) {
      this.gameStateManager.setState('PLAYING');
      // The levels loader will check for BJ.TestPlayLevel when loading
    }
  };

  // Export the constructor
  BJ.LevelEditorUI = LevelEditorUI;
  
  // Debug: verify export
  if (typeof BJ.LevelEditorUI === 'function') {
    console.log('[LevelEditorUI] Module loaded successfully');
  } else {
    console.error('[LevelEditorUI] EXPORT FAILED - BJ.LevelEditorUI is:', typeof BJ.LevelEditorUI);
  }

}(window));
