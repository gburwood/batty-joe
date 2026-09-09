/* Batty Joe Development Specification v1.9.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};
  const C = BJ.Config;
  const U = BJ.Utils;

  const templates = [
    { id: 'chevrons', symmetry: 'horizontal', include(r, c, rows, cols) { return ((r + c) % 3 !== 2) || c === Math.floor(cols / 2); } },
    { id: 'diamond', symmetry: 'horizontal', include(r, c, rows, cols) { const cx = (cols - 1) / 2; const cy = (rows - 1) / 2; return Math.abs(c - cx) / cols + Math.abs(r - cy) / rows < 0.58; } },
    { id: 'ribs', symmetry: 'vertical', include(r, c) { return r % 2 === 0 || c % 3 !== 1; } },
    { id: 'fortress', symmetry: 'horizontal', include(r, c, rows, cols) { const edge = c === 0 || c === cols - 1; return r < 2 || edge || ((c + r) % 2 === 0); } },
    { id: 'checker', symmetry: 'rotational', include(r, c) { return (r + c) % 2 === 0 || r === 0; } },
    { id: 'waves', symmetry: 'none', include(r, c) { return ((c + ((r * 2 + 1) % 5)) % 4) !== 0; } }
  ];

  function campaignRng(seed, difficulty, level, channel) {
    return U.createRng([BJ.VERSION, seed, difficulty, level, channel || 'level'].join('|'));
  }

  function typeProbabilities(level, difficulty) {
    const d = C.difficulty[difficulty] || C.difficulty.normal;
    const p = Math.min(1, level / 20);
    return {
      normal: Math.max(0.25, 0.66 - p * 0.31),
      multi_hit: 0.16 + p * 0.12 * d.brickToughness,
      indestructible: 0.015 + p * 0.075 * d.hazardRate,
      explosive: 0.045 + p * 0.035,
      moving: 0.025 + p * 0.065 * d.hazardRate,
      invisible: 0.02 + p * 0.055 * d.hazardRate,
      regenerating: 0.015 + p * 0.06 * d.hazardRate,
      powerup: 0.055
    };
  }

  function weightedType(rng, weights) {
    const entries = Object.keys(weights);
    const total = entries.reduce(function (s, k) { return s + weights[k]; }, 0);
    let roll = rng() * total;
    for (let i = 0; i < entries.length; i += 1) {
      roll -= weights[entries[i]];
      if (roll <= 0) return entries[i];
    }
    return 'normal';
  }

  function makeBrick(id, type, x, y, w, h, level, rng, difficulty) {
    let maxHits = 1;
    if (type === 'multi_hit') maxHits = U.clamp(2 + Math.floor((level - 1) / 4) + rng.int(0, 1), 2, 6);
    else if (type === 'indestructible') maxHits = 999;
    else if (type === 'regenerating') maxHits = U.clamp(2 + Math.floor(level / 7), 2, 4);
    else if (type === 'explosive' || type === 'moving' || type === 'invisible' || type === 'powerup') maxHits = level > 12 && rng() < 0.28 ? 2 : 1;

    return {
      id, type, x, y, w, h,
      homeX: x, homeY: y,
      alive: true,
      maxHits, hits: maxHits,
      lastHitAt: -999,
      destroyedAt: null,
      regenMode: type === 'regenerating' ? (rng() < 0.52 ? 'heal' : 'respawn') : null,
      moveDirection: rng() < 0.5 ? -1 : 1,
      moveSpeed: type === 'moving' ? rng.int(28, 52) : 0,
      shimmerPhase: rng() * Math.PI * 2,
      containedPowerup: type === 'powerup' ? choosePowerup(rng, level, difficulty, true) : null,
      seededDrop: rng() < 0.035 ? choosePowerup(rng, level, difficulty, false) : null,
      frenzyOriginal: null,
      frenzyMeta: null
    };
  }

  function choosePowerup(rng, level, difficulty, guaranteedPositive) {
    const diff = C.difficulty[difficulty] || C.difficulty.normal;
    const positive = ['wide', 'multiball', 'sticky', 'laser', 'slow_ball', 'extra_life', 'penetrating_ball'];
    const negative = ['narrow', 'fast_ball', 'imprecise_paddle'];
    if (level >= 3) {
      const fRoll = rng();
      const frenzyWeights = [
        ['space_invaders_frenzy', diff.invadersFrenzyWeight * 7],
        ['fps_frenzy', diff.fpsFrenzyWeight * 6],
        ['pinball_frenzy', diff.pinballFrenzyWeight * 6],
        ['asteroids_frenzy', diff.asteroidsFrenzyWeight * 6],
        ['missile_command_frenzy', diff.missileFrenzyWeight * 6],
        ['arkanoid_revenge_frenzy', diff.revengeFrenzyWeight * 6],
        ['grid_runner_frenzy', diff.gridRunnerFrenzyWeight * 6]
      ];
      let cumulative = 0;
      for (let i = 0; i < frenzyWeights.length; i += 1) {
        cumulative += frenzyWeights[i][1];
        if (fRoll < cumulative) return frenzyWeights[i][0];
      }
    }
    if (guaranteedPositive) return rng.pick(positive);
    if (rng() < diff.negativeDropShare) return rng.pick(negative);
    return rng.pick(positive);
  }

  function generateLevel(seed, difficulty, level) {
    if (C.bossLevels.indexOf(level) !== -1) return generateBossLevel(seed, difficulty, level);
    const rng = campaignRng(seed, difficulty, level, 'layout');
    const cfg = C.level;
    const rows = U.clamp(cfg.rowsMin + Math.floor((level - 1) / 4), cfg.rowsMin, cfg.rowsMax);
    const cols = cfg.columns;
    const template = templates[(rng.int(0, templates.length - 1) + level) % templates.length];
    const totalGap = cfg.gap * (cols - 1);
    const width = (C.playfield.width - cfg.marginX * 2 - totalGap) / cols;
    const weights = typeProbabilities(level, difficulty);
    const bricks = [];
    let id = 1;

    function symmetryKey(r, c) {
      if (template.symmetry === 'horizontal') return r + ':' + Math.min(c, cols - 1 - c);
      if (template.symmetry === 'vertical') return Math.min(r, rows - 1 - r) + ':' + c;
      if (template.symmetry === 'rotational') { const a = r + ':' + c; const b = (rows - 1 - r) + ':' + (cols - 1 - c); return a < b ? a : b; }
      return r + ':' + c;
    }

    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cellRng = campaignRng(seed, difficulty, level, 'cell|' + template.id + '|' + symmetryKey(r, c));
        let include = template.include(r, c, rows, cols);
        if (include && cellRng() < 0.055) include = false;
        if (!include) continue;
        const x = cfg.marginX + c * (width + cfg.gap);
        const y = cfg.top + r * (cfg.brickHeight + cfg.gap);
        let type = weightedType(cellRng, weights);
        if (r === 0 && type === 'indestructible') type = 'multi_hit';
        bricks.push(makeBrick(id++, type, x, y, width, cfg.brickHeight, level, cellRng, difficulty));
      }
    }

    let required = bricks.filter(function (b) { return b.type !== 'indestructible'; });
    if (required.length < 22) {
      bricks.forEach(function (b) {
        if (b.type === 'indestructible' && required.length < 22) { b.type = 'normal'; b.maxHits = b.hits = 1; required.push(b); }
      });
    }

    return { seed, difficulty, level, template: template.id, title: levelTitle(level, template.id), boss: null, bricks, initialBricks: U.deepClone(bricks), rngStateAtGeneration: rng.state() };
  }

  function generateBossLevel(seed, difficulty, level) {
    const rng = campaignRng(seed, difficulty, level, 'boss');
    const bossCfg = C.bosses[level];
    const boss = { id: bossCfg.id, name: bossCfg.name, x: (C.playfield.width - bossCfg.width) / 2, y: bossCfg.y, w: bossCfg.width, h: bossCfg.height, vx: bossCfg.baseSpeed[difficulty] || bossCfg.baseSpeed.normal, health: bossCfg.maxHealth, maxHealth: bossCfg.maxHealth, phase: 1, shotTimer: 1.3, bobPhase: rng() * Math.PI * 2, alive: true };
    return { seed, difficulty, level, template: 'boss', title: bossCfg.name, boss, bricks: [], initialBricks: [], rngStateAtGeneration: rng.state() };
  }

  function levelTitle(level, template) {
    const names = ['WARMING THE BAT', 'BRICKFAST', 'BOUNCE ACCOUNT', 'WALL STREET', 'NO REFUNDS', 'THE SHIMMERING', 'HORIZONTAL THINKING', 'REGENERATION GAME', 'CHAIN REACTION', 'PADDLE BUSINESS', 'SUSPICIOUS MASONRY', 'BALL CONTROL', 'BRICKS WITH BENEFITS', 'LASER GUIDED DIPLOMACY', 'THE HARD STUFF', 'RETURN OF THE WALL', 'SIX BALL PROBLEM', 'ALMOST THERE', 'PENULTIMATE PANIC'];
    return names[level - 1] || ('LEVEL ' + level + ' / ' + template.toUpperCase());
  }

  function restoreInitial(levelData) {
    const copy = U.deepClone(levelData);
    copy.bricks = U.deepClone(levelData.initialBricks || []);
    if (copy.boss) return generateBossLevel(copy.seed, copy.difficulty, copy.level);
    return copy;
  }

  function countRequired(bricks) { return bricks.filter(function (b) { return b.alive && b.type !== 'indestructible'; }).length; }

  function snapshotBricks(bricks) {
    return bricks.map(function (b) { return { id: b.id, alive: b.alive, hits: b.hits, x: b.x, y: b.y, lastHitAt: b.lastHitAt, destroyedAt: b.destroyedAt }; });
  }

  function handcraftedBricksToGameBricks(bricks, level) {
    // Convert handcrafted grid bricks to game brick format
    const cfg = C.level;
    const cols = 12;
    const cellWidth = (C.playfield.width - cfg.marginX * 2 - cfg.gap * (cols - 1)) / cols;
    const gameBricks = [];
    let id = 1;

    bricks.forEach(function (brick) {
      const x = cfg.marginX + brick.col * (cellWidth + cfg.gap);
      const y = cfg.top + brick.row * (cfg.brickHeight + cfg.gap);

      gameBricks.push({
        id: id++,
        type: brick.type === 'powerup_spawner' ? (brick.powerup || 'wide') : (brick.type === 'indestructible' ? 'indestructible' : 'normal'),
        x: x, y: y,
        w: cellWidth,
        h: cfg.brickHeight,
        homeX: x,
        homeY: y,
        alive: true,
        maxHits: brick.type === 'indestructible' ? 999 : (brick.durability || 1),
        hits: brick.type === 'indestructible' ? 999 : (brick.durability || 1),
        lastHitAt: -999,
        destroyedAt: null,
        regenMode: null,
        moveDirection: 1,
        moveSpeed: 0,
        shimmerPhase: 0,
        containedPowerup: brick.type === 'powerup_spawner' ? brick.powerup : null,
        seededDrop: null,
        frenzyOriginal: null,
        frenzyMeta: null
      });
    });

    return gameBricks;
  }

  function getLevel(seed, difficulty, level) {
    // Check for custom campaign level
    if (BJ.CustomCampaign && BJ.CustomCampaign.levelIds && BJ.CustomCampaign.levelIds.length > 0) {
      const currentIdx = BJ.CustomCampaign.currentLevelIndex || 0;
      if (currentIdx < BJ.CustomCampaign.levelIds.length) {
        const levelId = BJ.CustomCampaign.levelIds[currentIdx];
        if (BJ.LevelEditor) {
          const editor = new BJ.LevelEditor();
          const customLevel = editor.loadFromStorage(levelId);
          if (customLevel) {
            return {
              seed: seed,
              difficulty: customLevel.difficulty || difficulty,
              level: level,
              template: 'custom',
              title: customLevel.title || ('Custom Level ' + (currentIdx + 1)),
              boss: null,
              bricks: handcraftedBricksToGameBricks(customLevel.bricks || [], level),
              initialBricks: handcraftedBricksToGameBricks(customLevel.bricks || [], level),
              rngStateAtGeneration: null
            };
          }
        }
      }
    }

      // Check for test-play level (from level editor)
      if (BJ.TestPlayLevel && BJ.TestPlayLevel.id) {
        const testLevel = BJ.TestPlayLevel;
        return {
          seed: seed,
          difficulty: difficulty,
          level: level,
          template: 'test-play',
          title: testLevel.title || 'Test Play',
          boss: null,
          bricks: handcraftedBricksToGameBricks(testLevel.bricks || [], level),
          initialBricks: handcraftedBricksToGameBricks(testLevel.bricks || [], level),
          rngStateAtGeneration: null
        };
      }

      // Check for handcrafted level (from specification or loader)
      if (BJ.HandcraftedLevelsLoader && typeof BJ.HandcraftedLevelsLoader.getDesignerLevel === 'function') {
        var designerLevel = BJ.HandcraftedLevelsLoader.getDesignerLevel(level) ||
                            BJ.HandcraftedLevelsLoader.getChallengeLevel(level);
        if (designerLevel && designerLevel.bricks) {
          return {
            seed: seed,
            difficulty: difficulty,
            level: level,
            template: 'handcrafted',
            title: designerLevel.title || ('Level ' + level),
            boss: null,
            bricks: handcraftedBricksToGameBricks(designerLevel.bricks, level),
            initialBricks: handcraftedBricksToGameBricks(designerLevel.bricks, level),
            rngStateAtGeneration: null
          };
        }
      }

      // If PREBUILT campaign but no designer level found, this is an error condition
      if (seed === 'PREBUILT') {
        console.error('PREBUILT campaign but no designer level ' + level + ' found. Falling back to procedural.');
      }

      // Fall back to procedural generation
      return generateLevel(seed, difficulty, level);
    }

  BJ.Levels = { templates, campaignRng, choosePowerup, generateLevel, getLevel, restoreInitial, countRequired, snapshotBricks, handcraftedBricksToGameBricks };
}(window));
