/* Batty Joe Level Editor */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};
  const U = BJ.Utils;

  const GRID_COLS = 12;
  const GRID_ROWS = 10;
  const MIN_BRICKS = 16;
  const MAX_BRICKS = 96;
  const MAX_DURABILITY = 5;
  const MAX_SAVED_LEVELS = 20;
  const STORAGE_KEY_PREFIX = 'BattyJoe_UserLevel_';
  const STORAGE_INDEX_KEY = 'BattyJoe_UserLevelIndex';

  const BRICK_TYPES = {
    STANDARD: 'standard',
    INDESTRUCTIBLE: 'indestructible',
    POWERUP_SPAWNER: 'powerup_spawner'
  };

  const POWERUP_TYPES = [
    'multi_ball', 'laser', 'slow_time', 'paddle_expansion',
    'frenzy_pickup', // Legacy value for display
    'space_invaders_frenzy', 'fps_frenzy', 'pinball_frenzy',
    'asteroids_frenzy', 'missile_command_frenzy', 'arkanoid_revenge_frenzy', 'grid_runner_frenzy'
  ];

  function LevelEditor() {
    this.grid = this.createEmptyGrid();
    this.currentSelection = { type: BRICK_TYPES.STANDARD, durability: 1, powerup: null };
    this.currentLevel = null;
    this.isDirty = false;
  }

  LevelEditor.prototype.createEmptyGrid = function () {
    const grid = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      grid[row] = [];
      for (let col = 0; col < GRID_COLS; col++) {
        grid[row][col] = null;
      }
    }
    return grid;
  };

  LevelEditor.prototype.placeBrick = function (col, row, type, durability, powerup, frenzyType) {
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) {
      return false;
    }
    const brickData = {
      type: type || BRICK_TYPES.STANDARD,
      durability: durability || 1,
      powerup: powerup || null
    };
      if (frenzyType && powerup && powerup.indexOf('frenzy') > -1) {
      brickData.frenzyType = frenzyType;
    }
    this.grid[row][col] = brickData;
    this.isDirty = true;
    return true;
  };

  LevelEditor.prototype.removeBrick = function (col, row) {
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) {
      return false;
    }
    this.grid[row][col] = null;
    this.isDirty = true;
    return true;
  };

  LevelEditor.prototype.getBrick = function (col, row) {
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) {
      return null;
    }
    return this.grid[row][col];
  };

  LevelEditor.prototype.clearGrid = function () {
    this.grid = this.createEmptyGrid();
    this.isDirty = true;
  };

  LevelEditor.prototype.setSelection = function (type, durability, powerup) {
    this.currentSelection = {
      type: type || BRICK_TYPES.STANDARD,
      durability: Math.min(durability || 1, MAX_DURABILITY),
      powerup: powerup || null
    };
  };

  LevelEditor.prototype.getBrickCount = function () {
    let count = 0;
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        if (this.grid[row][col]) count++;
      }
    }
    return count;
  };

  LevelEditor.prototype.validate = function (levelData) {
    const errors = [];

    if (!levelData.id || !/^[a-zA-Z0-9_-]{1,32}$/.test(levelData.id)) {
      errors.push('Invalid ID: must be 1-32 alphanumeric characters, underscores, or hyphens');
    }
    if (!levelData.title || levelData.title.length === 0 || levelData.title.length > 64) {
      errors.push('Title must be 1-64 characters');
    }
    if (!levelData.difficulty || !['easy', 'normal', 'hard'].includes(levelData.difficulty)) {
      errors.push('Difficulty must be easy, normal, or hard');
    }
    if (!levelData.bricks || !Array.isArray(levelData.bricks)) {
      errors.push('Bricks must be an array');
    } else {
      if (levelData.bricks.length < MIN_BRICKS) {
        errors.push('Minimum ' + MIN_BRICKS + ' bricks required');
      }
      if (levelData.bricks.length > MAX_BRICKS) {
        errors.push('Maximum ' + MAX_BRICKS + ' bricks allowed');
      }
      levelData.bricks.forEach(function (brick, idx) {
        if (typeof brick.col !== 'number' || brick.col < 0 || brick.col >= GRID_COLS) {
          errors.push('Brick ' + idx + ': invalid column');
        }
        if (typeof brick.row !== 'number' || brick.row < 0 || brick.row >= GRID_ROWS) {
          errors.push('Brick ' + idx + ': invalid row');
        }
        if (!brick.type || !Object.values(BRICK_TYPES).includes(brick.type)) {
          errors.push('Brick ' + idx + ': invalid type');
        }
        if (typeof brick.durability !== 'number' || brick.durability < 1 || brick.durability > MAX_DURABILITY) {
          errors.push('Brick ' + idx + ': durability must be 1-' + MAX_DURABILITY);
        }
        if (brick.type === BRICK_TYPES.POWERUP_SPAWNER && brick.powerup && !POWERUP_TYPES.includes(brick.powerup)) {
          errors.push('Brick ' + idx + ': invalid power-up type');
        }
      });
    }

      // Validate frenzy powerup limit (max 2 per level)
    if (levelData.bricks && Array.isArray(levelData.bricks)) {
      const frenzyCount = levelData.bricks.filter(function (brick) {
        return brick.powerup && brick.powerup.indexOf('frenzy') > -1;
      }).length;
      if (frenzyCount > 2) {
        errors.push('Maximum 2 frenzy power-ups allowed per level (game enforces this limit)');
      }
    }

    return { valid: errors.length === 0, errors: errors };
  };

  LevelEditor.prototype.gridToLevel = function (id, title, difficulty, description) {
    const bricks = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const brick = this.grid[row][col];
        if (brick) {
          const brickData = {
            col: col,
            row: row,
            type: brick.type,
            durability: brick.durability
          };
          if (brick.powerup) {
            brickData.powerup = brick.powerup;
          }
          if (brick.frenzyType) {
            brickData.frenzyType = brick.frenzyType;
          }
          bricks.push(brickData);
        }
      }
    }

    return {
      id: id,
      title: title,
      description: description || '',
      difficulty: difficulty,
      bricks: bricks,
      metadata: {
        created_at: new Date().toISOString(),
        created_by: 'player',
        version: BJ.Config.version
      }
    };
  };

  LevelEditor.prototype.levelToGrid = function (levelData) {
    this.grid = this.createEmptyGrid();
    if (levelData && levelData.bricks && Array.isArray(levelData.bricks)) {
      levelData.bricks.forEach(function (brick) {
        if (brick.col >= 0 && brick.col < GRID_COLS && brick.row >= 0 && brick.row < GRID_ROWS) {
          const gridBrick = {
            type: brick.type,
            durability: brick.durability
          };
          if (brick.powerup) {
            gridBrick.powerup = brick.powerup;
          }
          if (brick.frenzyType) {
            gridBrick.frenzyType = brick.frenzyType;
          }
          this.grid[brick.row][brick.col] = gridBrick;
        }
      }, this);
    }
    this.currentLevel = levelData;
    this.isDirty = false;
  };

  LevelEditor.prototype.saveToStorage = function (levelData) {
    const validation = this.validate(levelData);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }

    try {
      const index = this.getStorageIndex();
      if (index.length >= MAX_SAVED_LEVELS && !index.includes(levelData.id)) {
        return { success: false, errors: ['Maximum ' + MAX_SAVED_LEVELS + ' saved levels reached'] };
      }

      const storageKey = STORAGE_KEY_PREFIX + levelData.id;
      global.localStorage.setItem(storageKey, JSON.stringify(levelData));

      if (!index.includes(levelData.id)) {
        index.push(levelData.id);
        global.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
      }

      this.isDirty = false;
      return { success: true };
    } catch (e) {
      return { success: false, errors: ['Storage error: ' + (e.message || 'unknown')] };
    }
  };

  LevelEditor.prototype.loadFromStorage = function (levelId) {
    try {
      const storageKey = STORAGE_KEY_PREFIX + levelId;
      const data = global.localStorage.getItem(storageKey);
      if (!data) {
        return null;
      }
      const levelData = JSON.parse(data);
      this.levelToGrid(levelData);
      return levelData;
    } catch (e) {
      return null;
    }
  };

  LevelEditor.prototype.getStorageIndex = function () {
    try {
      const index = global.localStorage.getItem(STORAGE_INDEX_KEY);
      return index ? JSON.parse(index) : [];
    } catch (e) {
      return [];
    }
  };

  LevelEditor.prototype.listStoredLevels = function () {
    const index = this.getStorageIndex();
    const levels = [];
    index.forEach(function (levelId) {
      const levelData = this.loadFromStorage(levelId);
      if (levelData) {
        levels.push({
          id: levelData.id,
          title: levelData.title,
          difficulty: levelData.difficulty,
          bricks: levelData.bricks.length,
          created_at: levelData.metadata.created_at
        });
      }
    }, this);
    return levels;
  };

  LevelEditor.prototype.deleteFromStorage = function (levelId) {
    try {
      const storageKey = STORAGE_KEY_PREFIX + levelId;
      global.localStorage.removeItem(storageKey);
      const index = this.getStorageIndex();
      const newIndex = index.filter(function (id) { return id !== levelId; });
      global.localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(newIndex));
      return true;
    } catch (e) {
      return false;
    }
  };

  LevelEditor.prototype.exportAsJSON = function () {
    const level = this.gridToLevel('exported_level', 'Exported Level', 'normal');
    return JSON.stringify(level, null, 2);
  };

  LevelEditor.prototype.importFromJSON = function (jsonString) {
    try {
      const levelData = JSON.parse(jsonString);
      const validation = this.validate(levelData);
      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }
      this.levelToGrid(levelData);
      return { success: true, level: levelData };
    } catch (e) {
      return { success: false, errors: ['Invalid JSON: ' + (e.message || 'parse error')] };
    }
  };

  LevelEditor.prototype.getGridDimensions = function () {
    return { cols: GRID_COLS, rows: GRID_ROWS };
  };

  BJ.LevelEditor = LevelEditor;
  BJ.LevelEditor.BRICK_TYPES = BRICK_TYPES;
  BJ.LevelEditor.POWERUP_TYPES = POWERUP_TYPES;
  BJ.LevelEditor.GRID_COLS = GRID_COLS;
  BJ.LevelEditor.GRID_ROWS = GRID_ROWS;
  BJ.LevelEditor.MIN_BRICKS = MIN_BRICKS;
  BJ.LevelEditor.MAX_BRICKS = MAX_BRICKS;
  BJ.LevelEditor.MAX_SAVED_LEVELS = MAX_SAVED_LEVELS;

}(window));
