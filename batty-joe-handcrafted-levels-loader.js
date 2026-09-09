/* Batty Joe Handcrafted Levels Loader */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};

  function HandcraftedLevelsLoader() {
    this.designerLevels = {};
    this.challengeLevels = {};
    this.loadedFrom = null;
  }

  HandcraftedLevelsLoader.prototype.loadFromYAML = function (yamlData) {
    try {
      // Simple YAML-to-object parser for the level structure
      // (assumes YAML has already been parsed into an object)
      if (!yamlData || typeof yamlData !== 'object') {
        return { success: false, error: 'Invalid YAML data' };
      }

      this.designerLevels = {};
      this.challengeLevels = {};

      if (yamlData.designer_levels && Array.isArray(yamlData.designer_levels)) {
        yamlData.designer_levels.forEach(function (level) {
          if (level.id && this.validateLevelStructure(level)) {
            this.designerLevels[level.id] = level;
              if (Number.isInteger(level.campaign_level)) this.designerLevels[level.campaign_level] = level;
          }
        }, this);
      }

      if (yamlData.challenge_levels && Array.isArray(yamlData.challenge_levels)) {
        yamlData.challenge_levels.forEach(function (level) {
          if (level.id && this.validateLevelStructure(level)) {
            this.challengeLevels[level.id] = level;
          }
        }, this);
      }

      this.loadedFrom = yamlData.metadata || {};
      return { success: true, designerCount: Object.keys(this.designerLevels).length, challengeCount: Object.keys(this.challengeLevels).length };
    } catch (e) {
      return { success: false, error: 'Failed to load handcrafted levels: ' + (e.message || 'unknown error') };
    }
  };

  HandcraftedLevelsLoader.prototype.validateLevelStructure = function (level) {
    return level.id &&
           level.title &&
           level.difficulty &&
           level.bricks &&
           Array.isArray(level.bricks) &&
           level.bricks.length >= 16 &&
           level.bricks.length <= 96;
  };

  HandcraftedLevelsLoader.prototype.getDesignerLevel = function (levelId) {
    return this.designerLevels[levelId] || null;
  };

  HandcraftedLevelsLoader.prototype.getChallengeLevel = function (levelId) {
    return this.challengeLevels[levelId] || null;
  };

  HandcraftedLevelsLoader.prototype.listDesignerLevels = function () {
    const levels = [];
    Object.keys(this.designerLevels).forEach(function (id) {
      const level = this.designerLevels[id];
      levels.push({
        id: id,
        title: level.title,
        difficulty: level.difficulty,
        description: level.description || '',
        brickCount: level.bricks.length
      });
    }, this);
    return levels;
  };

  HandcraftedLevelsLoader.prototype.listChallengeLevels = function () {
    const levels = [];
    Object.keys(this.challengeLevels).forEach(function (id) {
      const level = this.challengeLevels[id];
      levels.push({
        id: id,
        title: level.title,
        difficulty: level.difficulty,
        description: level.description || '',
        brickCount: level.bricks.length
      });
    }, this);
    return levels;
  };

  HandcraftedLevelsLoader.prototype.convertToGameLevel = function (levelData) {
    // Convert handcrafted level format to the game's internal level format
    if (!levelData || !levelData.bricks) {
      return null;
    }

    const bricks = [];
    levelData.bricks.forEach(function (brick) {
      bricks.push({
        col: brick.col,
        row: brick.row,
        type: brick.type,
        durability: brick.durability,
        powerup: brick.powerup || null
      });
    });

    return {
      id: levelData.id,
      title: levelData.title,
      description: levelData.description || '',
      difficulty: levelData.difficulty,
      bricks: bricks,
      isHandcrafted: true,
      metadata: levelData.metadata || {}
    };
  };

  HandcraftedLevelsLoader.prototype.getAllAvailable = function () {
    const all = {};
    Object.keys(this.designerLevels).forEach(function (id) {
      all[id] = { type: 'designer', level: this.designerLevels[id] };
    }, this);
    Object.keys(this.challengeLevels).forEach(function (id) {
      all[id] = { type: 'challenge', level: this.challengeLevels[id] };
    }, this);
    return all;
  };

  BJ.HandcraftedLevelsLoader = HandcraftedLevelsLoader;

}(window));
