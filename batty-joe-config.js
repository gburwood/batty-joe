/* Batty Joe Development Specification v1.5.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};

  BJ.VERSION = '1.5.0';
  BJ.WIDTH = 960;
  BJ.HEIGHT = 720;

  BJ.State = Object.freeze({
    BOOT: 'BOOT',
    MENU: 'MENU',
    ATTRACT: 'ATTRACT',
    PLAYING: 'PLAYING',
    PAUSED: 'PAUSED',
    LIFE_LOST: 'LIFE_LOST',
    LEVEL_COMPLETE: 'LEVEL_COMPLETE',
    FRENZY_TRANSITION_IN: 'FRENZY_TRANSITION_IN',
    FRENZY_ACTIVE: 'FRENZY_ACTIVE',
    FRENZY_TRANSITION_OUT: 'FRENZY_TRANSITION_OUT',
    BOSS: 'BOSS',
    GAME_OVER: 'GAME_OVER',
    CONTINUE: 'CONTINUE',
    VICTORY: 'VICTORY'
  });

  const BASE_CONFIG = {
    title: 'Batty Joe',
    version: BJ.VERSION,
    playfield: { width: BJ.WIDTH, height: BJ.HEIGHT },
    campaignLevels: 20,
    bossLevel: 20,
    lives: { start: 3, max: 9 },
    continues: { max: 3, countdownSeconds: 10 },
    balls: { max: 6, radius: 8, releaseMaxAngleDegrees: 60 },
    spin: {
      enabled: true,
      maxAbs: 1.25,
      paddleVelocityContribution: 0.90,
      contactOffsetContribution: 0.10,
      maxHeadingDegreesPerSecond: 18,
      brickBounceDeflectionDegrees: 12,
      edgeBounceDeflectionDegrees: 9,
      paddleBounceDeflectionDegrees: 15,
      halfLifeSeconds: 2.4,
      snapThreshold: 0.02,
      wallRetention: 0.82,
      brickRetention: 0.78,
      explosionRetention: 0.70
    },
    collision: {
      imperfectRebound: {
        enabled: true,
        brickDegrees: 3.5,
        edgeDegrees: 2.0,
        deterministic: true
      }
    },
    paddle: {
      baseWidth: 130,
      height: 18,
      maxSpeed: 760,
      acceleration: 5200,
      deceleration: 4400,
      y: 670
    },
    difficulty: {
      easy: {
        baseSpeed: 330,
        maxSpeed: 620,
        accelerationFactor: 0.85,
        positiveDropChance: 0.14,
        negativeDropShare: 0.08,
        invadersFrenzyWeight: 0.0025,
        fpsFrenzyWeight: 0.0025,
        pinballFrenzyWeight: 0.0022,
        asteroidsFrenzyWeight: 0.0022,
        missileFrenzyWeight: 0.0022,
        revengeFrenzyWeight: 0.0020,
        tenPinFrenzyWeight: 0.0020,
        bomberFrenzyWeight: 0.0020,
        brickToughness: 0.85,
        hazardRate: 0.72
      },
      normal: {
        baseSpeed: 370,
        maxSpeed: 700,
        accelerationFactor: 1.0,
        positiveDropChance: 0.11,
        negativeDropShare: 0.14,
        invadersFrenzyWeight: 0.0022,
        fpsFrenzyWeight: 0.0022,
        pinballFrenzyWeight: 0.0020,
        asteroidsFrenzyWeight: 0.0020,
        missileFrenzyWeight: 0.0020,
        revengeFrenzyWeight: 0.0018,
        tenPinFrenzyWeight: 0.0018,
        bomberFrenzyWeight: 0.0018,
        brickToughness: 1.0,
        hazardRate: 1.0
      },
      hard: {
        baseSpeed: 415,
        maxSpeed: 780,
        accelerationFactor: 1.15,
        positiveDropChance: 0.09,
        negativeDropShare: 0.20,
        invadersFrenzyWeight: 0.0020,
        fpsFrenzyWeight: 0.0020,
        pinballFrenzyWeight: 0.0018,
        asteroidsFrenzyWeight: 0.0018,
        missileFrenzyWeight: 0.0018,
        revengeFrenzyWeight: 0.0016,
        tenPinFrenzyWeight: 0.0016,
        bomberFrenzyWeight: 0.0016,
        brickToughness: 1.18,
        hazardRate: 1.3
      }
    },
    powerups: {
      wide: { label: 'WIDE', positive: true, duration: 15, maxStacks: 4 },
      narrow: { label: 'NARROW', positive: false, duration: 12, maxStacks: 4 },
      multiball: { label: 'MULTI', positive: true, instant: true },
      sticky: { label: 'STICKY', positive: true, duration: 15, maxHold: 3 },
      laser: { label: 'LASER', positive: true, duration: 15, rate: 8 },
      slow_ball: { label: 'SLOW', positive: true, duration: 10, multiplier: 0.72 },
      fast_ball: { label: 'FAST', positive: false, duration: 10, multiplier: 1.30 },
      extra_life: { label: 'LIFE', positive: true, instant: true },
      penetrating_ball: { label: 'PIERCE', positive: true, duration: 12 },
      imprecise_paddle: { label: 'DRIFT', positive: false, duration: 10 },
      space_invaders_frenzy: { label: 'INVADERS', positive: true, instant: true, rare: true },
      fps_frenzy: { label: 'FPS', positive: true, instant: true, rare: true },
      pinball_frenzy: { label: 'PINBALL', positive: true, instant: true, rare: true },
      asteroids_frenzy: { label: 'ASTEROIDS', positive: true, instant: true, rare: true },
      missile_command_frenzy: { label: 'MISSILE', positive: true, instant: true, rare: true },
      arkanoid_revenge_frenzy: { label: 'REVENGE', positive: true, instant: true, rare: true },
      ten_pin_frenzy: { label: '10-PIN', positive: true, instant: true, rare: true },
      bomber_frenzy: { label: 'BOMBER', positive: true, instant: true, rare: true }
    },
    powerupCompatibility: {
      'wide|narrow': { allowed: false, resolution: 'replace-size' },
      'fast_ball|slow_ball': { allowed: false, resolution: 'replace-speed' }
    },
    scoring: {
      baseBrick: 100,
      noPaddleComboMax: 10,
      rapidWindow: 2,
      rapidComboMax: 8,
      chainBonus: 150,
      frenzyMultiplierStart: 2,
      frenzyMultiplierStep: 0.25,
      frenzyMultiplierMax: 5,
      frenzyClearBonus: 10000,
      fpsFrenzyClearBonus: 10000,
      pinballFrenzyClearBonus: 10000,
      asteroidsFrenzyClearBonus: 10000,
      missileFrenzyClearBonus: 10000,
      revengeFrenzyClearBonus: 10000,
      tenPinStrikeBonus: 12000,
      tenPinSpareBonus: 7000,
      tenPinFrenzyClearBonus: 10000,
      bomberFrenzyClearBonus: 12000,
      lifeBonus: 1000,
      continueBonus: 2500,
      comboBonusStep: 250,
      timePar: 120,
      timeBonusPerSecond: 20
    },
    frenzy: {
      duration: 20,
      minBricks: 8,
      shipWidth: 76,
      shipHeight: 24,
      transitionIn: 2.5,
      transitionOut: 2.0,
      maxPerLevelByType: { invaders: 1, fps: 1, pinball: 1, asteroids: 1, missile: 1, revenge: 1, tenpin: 1, bomber: 1 },
      maxTotalPerLevel: 2,
      totalMaxPerLevel: 2,
      configurableIndependentLimits: true,
      invaders: {
        minBricks: 8,
        shotSpeed: 620,
        invaderShotSpeed: 280,
        formationSpeed: 76,
        formationDrop: 18
      },
      fps: {
        minBricks: 8,
        rifleFireRate: 6,
        crosshairSpeed: 460,
        strafeMaxSpeed: 520,
        strafeAcceleration: 2600,
        strafeDeceleration: 2200,
        cameraLimit: 240,
        depthMin: 0.55,
        depthMax: 1.45,
        nearScale: 1.58,
        farScale: 0.72,
        parallaxStrength: 0.72,
        fallingBrick: { warningSeconds: 0.65 },
        falling: {
          telegraphSeconds: 0.65,
          fallSpeed: 360,
          gravity: 260,
          recoverySeconds: 0.55,
          baseInterval: 1.45,
          minimumInterval: 0.55,
          maxSimultaneous: { easy: 1, normal: 2, hard: 2 },
          startY: 72,
          impactY: 590,
          playerLaneHalfWidth: 48,
          screenParallax: 1.0
        }
      },
      pinball: {
        minBricks: 6,
        duration: 90,
        gravity: 420,
        flipperImpulse: 560,
        flipperAngularImpulse: 360,
        flipperPower: {
          baseImpulseMultiplier: 1.35,
          tipVelocityBonusMultiplier: 1.20,
          minimumUpwardExitSpeedMultiplier: 1.05,
          maximumUpwardExitSpeedMultiplier: 1.55,
          swingWindowSeconds: 0.14
        },
        nudgeImpulse: 120,
        nudgeCooldown: 1.0,
        ballRadius: 9,
        bumperImpulse: 1.12,
        apronStartY: 500,
        drainY: 700,
        playfieldLeft: 25,
        playfieldRight: 935,
        outlaneWidth: 30,
        funnelRestitution: 0.76,
        lowerBoundaryRestitution: 0.80,
        restitution: {
          default: 0.82,
          wall: 0.80,
          funnelRail: 0.76,
          brickTarget: 0.82,
          bumper: 0.90,
          flipper: 0.88,
          minSpeed: 210,
          maxSpeed: 620
        },
        funnelGuides: {
          left: { ax: 120, ay: 510, bx: 365, by: 625 },
          right: { ax: 840, ay: 510, bx: 595, by: 625 }
        },
        outlanes: {
          left: { centreX: 97, minX: 82, maxX: 112, entryY: 525 },
          right: { centreX: 863, minX: 848, maxX: 878, entryY: 525 }
        },
        centralDrain: { minX: 444, maxX: 516, commitY: 640 },
        flippers: {
          left: { pivotX: 382, pivotY: 646, restAngle: 18, activeAngle: -24, length: 118, thickness: 18 },
          right: { pivotX: 578, pivotY: 646, restAngle: 162, activeAngle: 204, length: 118, thickness: 18 }
        }
      },
      asteroids: {
        minBricks: 6, rotateSpeed: 3.2, thrust: 430, drag: 0.35, maxShipSpeed: 420,
        projectileSpeed: 650, fireRate: 5, asteroidSpeedMin: 24, asteroidSpeedMax: 74, shipRadius: 14
      },
      missile: {
        minBricks: 6, crosshairSpeed: 450, fireRate: 4, blastMaxRadius: 86, blastLife: 0.9,
        enemyMissileTravelMin: 1.7, enemyMissileTravelMax: 3.0, batteryFireInterval: 0.95, baseY: 668
      },
      revenge: {
        minBricks: 4, playerY: 74, enemyY: 646, playerWidth: 132, playerHeight: 18,
        ballSpeed: 390, enemyMaxSpeed: 420, enemyTracking: 0.84, relaunchDelay: 0.65
      },
      tenpin: {
        minBricks: 6, duration: 45, attempts: 2, laneNearY: 650, laneFarY: 142,
        ballSpeedMin: 0.50, ballSpeedMax: 0.92, aimRate: 1.15, maxAim: 1.0,
        collisionRadius: 0.22, powerCollisionBonus: 0.18, maxHook: 0.07,
        pinScaleNear: 1.18, pinScaleFar: 0.72, resetDelay: 0.9
      },
      bomber: {
        minBricks: 6, duration: 30, playerSpeed: 430, playerAcceleration: 2100, drag: 7.5,
        fireRate: 7, shotSpeed: 720, enemyShotSpeed: 300, enemyFireInterval: 0.82,
        enemyDrift: 42, enemyDiveSpeed: 34, playerWidth: 52, playerHeight: 42
      }
    },
    finalAssault: {
      enabled: true,
      thresholdPercent: 0.10,
      thresholdMaxBricks: 6,
      scoreMultiplier: 2.0,
      hunterAssistDelay1: 4.0,
      hunterAssistDelay2: 7.0,
      magneticAssistDelay: 10.0,
      hunterAssistStrength1: 0.18,
      hunterAssistStrength2: 0.32,
      maxCorrectionDegrees: 25,
      helperResetPolicy: 'destroyed_only',
      speedStartMultiplier: 1.0,
      speedMaxMultiplier: 1.35,
      speedRampSeconds: 15.0,
      magneticStartDegreesPerSecond: 6,
      magnetismMaxDegreesPerSecond: 30,
      magneticRampSeconds: 15.0,
      magneticMaxDistance: 380,
      magneticMinDistance: 35,
      magneticCombinedCapDegreesPerSecond: 36,
      magneticPaddleExclusion: 45,
      magneticAssist: { maxHeadingDegreesPerSecond: 30 }
    },
    bigBomb: {
      enabled: true,
      maximumUsesPerLevel: 1,
      pickupsRequired: 3,
      startDelaySeconds: 8.0,
      spawnMinSeconds: 18.0,
      spawnMaxSeconds: 32.0,
      pickupFallSpeed: 125,
      maxSimultaneous: 1,
      damage: 2,
      freezeSeconds: 0.18
    },
    level: {
      columns: 12,
      rowsMin: 5,
      rowsMax: 9,
      marginX: 62,
      top: 88,
      gap: 6,
      brickHeight: 28
    },
    boss: {
      id: 'boss_20',
      name: 'THE LAST BRICK',
      maxHealth: 100,
      width: 260,
      height: 72,
      y: 110,
      baseSpeed: { easy: 130, normal: 155, hard: 185 },
      difficultyFireFactor: { easy: 1.22, normal: 1.0, hard: 0.82 },
      phases: [
        { phase: 1, minHealthRatio: 0.66, speedMultiplier: 1.0, fireInterval: 1.12, attack: 'single' },
        { phase: 2, minHealthRatio: 0.33, speedMultiplier: 1.18, fireInterval: 0.84, attack: 'paired' },
        { phase: 3, minHealthRatio: 0.0, speedMultiplier: 1.38, fireInterval: 0.58, attack: 'spread' }
      ]
    }
  };

  function cloneConfig(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function getPath(root, parts) {
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      if (!node || !Object.prototype.hasOwnProperty.call(node, parts[i])) return { exists: false };
      node = node[parts[i]];
    }
    return { exists: true, value: node };
  }

  function setPath(root, parts, value) {
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) node = node[parts[i]];
    node[parts[parts.length - 1]] = value;
  }

  const CONFIG_ENUMS = {
    'finalAssault.helperResetPolicy': ['destroyed_only', 'any_hit', 'never']
  };

  const CONFIG_ALIASES = {
    'finalAssault.magneticAssist.maxHeadingDegreesPerSecond': 'finalAssault.magnetismMaxDegreesPerSecond',
    'physics.ball.spin.paddleVelocityContribution': 'spin.paddleVelocityContribution',
    'physics.ball.spin.maxFlightHeadingDegreesPerSecond': 'spin.maxHeadingDegreesPerSecond',
    'physics.ball.spin.maxBrickBounceDeflectionDegrees': 'spin.brickBounceDeflectionDegrees',
    'physics.ball.spin.maxEdgeBounceDeflectionDegrees': 'spin.edgeBounceDeflectionDegrees',
    'physics.collision.brickImperfectionDegrees': 'collision.imperfectRebound.brickDegrees',
    'physics.collision.edgeImperfectionDegrees': 'collision.imperfectRebound.edgeDegrees',
    'frenzy.pinball.outlaneWidth': 'frenzy.pinball.outlaneWidth',
    'frenzy.pinball.ballRestitution': 'frenzy.pinball.restitution.default',
    'frenzy.pinball.funnelRestitution': 'frenzy.pinball.restitution.funnelRail',
    'frenzy.pinball.flipperPower': 'frenzy.pinball.flipperPower.baseImpulseMultiplier',
    'frenzy.pinball.flipperTipBonus': 'frenzy.pinball.flipperPower.tipVelocityBonusMultiplier',
    'bigBomb.pickupsRequired': 'bigBomb.pickupsRequired',
    'bigBomb.spawnMinSeconds': 'bigBomb.spawnMinSeconds',
    'bigBomb.spawnMaxSeconds': 'bigBomb.spawnMaxSeconds',
    'bigBomb.pickupFallSpeed': 'bigBomb.pickupFallSpeed',
    'bigBomb.damage': 'bigBomb.damage',
    'frenzy.tenPin.attempts': 'frenzy.tenpin.attempts',
    'frenzy.tenPin.duration': 'frenzy.tenpin.duration',
    'frenzy.bomber.duration': 'frenzy.bomber.duration',
    'frenzy.pinball.duration': 'frenzy.pinball.duration',
    'frenzy.totalMaxPerLevel': 'frenzy.maxTotalPerLevel',
    'frenzy.fps.fallingBrick.warningSeconds': 'frenzy.fps.falling.telegraphSeconds'
  };

  function coerceConfigValue(raw, current, enumValues) {
    const type = typeof current;
    if (current === null || type === 'object' || type === 'function' || type === 'undefined') return { ok: false, reason: 'non_primitive_leaf' };
    let value;
    if (type === 'boolean') {
      if (raw === 'true') value = true;
      else if (raw === 'false') value = false;
      else return { ok: false, reason: 'invalid_boolean' };
    } else if (type === 'number') {
      value = Number(raw);
      if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_number' };
    } else if (type === 'string') {
      value = String(raw);
      if (enumValues && enumValues.indexOf(value) < 0) return { ok: false, reason: 'invalid_enum' };
    } else return { ok: false, reason: 'unsupported_type' };
    return { ok: true, value: value };
  }

  function buildRuntimeConfig(base, search) {
    const runtime = cloneConfig(base);
    const result = { config: runtime, active: [], invalid: [] };
    const params = new URLSearchParams(search || '');
    if (params.get('debug') !== 'true') return result;
    params.forEach(function (raw, key) {
      if (key.indexOf('cfg.') !== 0) return;
      const requestedPath = key.slice(4);
      const path = CONFIG_ALIASES[requestedPath] || requestedPath;
      const parts = path.split('.').filter(Boolean);
      const found = getPath(runtime, parts);
      if (!found.exists) { result.invalid.push({ path: requestedPath, value: raw, reason: 'unknown_path' }); return; }
      const enumValues = CONFIG_ENUMS[path] || CONFIG_ENUMS[requestedPath] || null;
      const coerced = coerceConfigValue(raw, found.value, enumValues);
      if (!coerced.ok) { result.invalid.push({ path: requestedPath, value: raw, reason: coerced.reason }); return; }
      setPath(runtime, parts, coerced.value);
      result.active = result.active.filter(function (x) { return x.path !== requestedPath; });
      result.active.push({ path: requestedPath, resolvedPath: path, value: coerced.value });
    });
    return result;
  }

  BJ.StaticConfig = deepFreeze(cloneConfig(BASE_CONFIG));
  BJ.ConfigTools = Object.freeze({ buildRuntimeConfig: buildRuntimeConfig, aliases: Object.freeze(Object.assign({}, CONFIG_ALIASES)) });
  const configResult = buildRuntimeConfig(BJ.StaticConfig, global.location ? global.location.search : '');
  BJ.Config = configResult.config;
  BJ.DebugConfigOverrides = { active: configResult.active, invalid: configResult.invalid };
  if (global.console && configResult.active.length) console.info('[Batty Joe] Active config overrides', configResult.active);
  if (global.console && configResult.invalid.length) console.warn('[Batty Joe] Ignored config overrides', configResult.invalid);

  BJ.DefaultSettings = Object.freeze({
    musicEnabled: true,
    sfxEnabled: true,
    globalMute: false,
    musicVolume: 0.28,
    sfxVolume: 0.55,
    reducedShake: false,
    reducedFlashing: false,
    colourBlindCues: true,
    pauseOnBlur: true,
    keys: {
      left: ['ArrowLeft', 'KeyA'],
      right: ['ArrowRight', 'KeyD'],
      action: ['Space'],
      bigBomb: ['ArrowDown'],
      pause: ['Escape'],
      fullscreen: ['KeyF']
    }
  });

  BJ.BrickTypes = Object.freeze({
    NORMAL: 'normal',
    MULTI: 'multi_hit',
    INDESTRUCTIBLE: 'indestructible',
    EXPLOSIVE: 'explosive',
    MOVING: 'moving',
    INVISIBLE: 'invisible',
    REGENERATING: 'regenerating',
    POWERUP: 'powerup'
  });

  BJ.BrickWeights = Object.freeze({
    normal: 1.0,
    multi_hit: 1.4,
    indestructible: 2.0,
    explosive: 1.6,
    moving: 1.6,
    invisible: 1.7,
    regenerating: 1.9,
    powerup: 1.2
  });

  BJ.Colour = Object.freeze({
    normal: '#31d7ff',
    multi_hit: '#ffcf4a',
    indestructible: '#8a95a5',
    explosive: '#ff5a5f',
    moving: '#a879ff',
    invisible: '#9be7c4',
    regenerating: '#49e06d',
    powerup: '#ff7ee2',
    paddle: '#54f7ff',
    ship: '#7dff8a',
    rifle: '#f5f8ff',
    ball: '#ffffff'
  });

  BJ.Utils = {
    clamp(value, min, max) { return Math.max(min, Math.min(max, value)); },
    lerp(a, b, t) { return a + (b - a) * t; },
    easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    deepClone(value) {
      if (global.structuredClone) return global.structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    },
    hashString(input) {
      let h = 2166136261 >>> 0;
      const s = String(input == null ? '' : input);
      for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      h += h << 13; h ^= h >>> 7; h += h << 3; h ^= h >>> 17; h += h << 5;
      return h >>> 0;
    },
    createRng(seedText) {
      let state = BJ.Utils.hashString(seedText) || 0x6d2b79f5;
      const rng = function () {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      rng.int = function (min, max) { return Math.floor(rng() * (max - min + 1)) + min; };
      rng.pick = function (items) { return items[Math.floor(rng() * items.length)]; };
      rng.state = function () { return state >>> 0; };
      rng.setState = function (value) { state = Number(value) >>> 0; return rng; };
      return rng;
    },
    randomSeed() {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let out = '';
      const cryptoObj = global.crypto;
      if (cryptoObj && cryptoObj.getRandomValues) {
        const bytes = new Uint8Array(8);
        cryptoObj.getRandomValues(bytes);
        for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
        return out;
      }
      for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
      return out;
    },
    formatTime(seconds) {
      seconds = Math.max(0, Math.floor(seconds || 0));
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    },
    formatScore(score) { return Math.round(score || 0).toString(); },
    normalizeInitials(text) {
      return String(text || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 3) || '???';
    },
    parseQuery(search) {
      const params = new URLSearchParams(search || '');
      return {
        debug: params.get('debug') === 'true',
        level: params.has('level') ? Number(params.get('level')) : null,
        seed: params.get('seed'),
        difficulty: params.get('difficulty'),
        lives: params.has('lives') ? Number(params.get('lives')) : null,
        frenzy: params.get('frenzy') === 'true',
        frenzyType: params.get('frenzyType')
      };
    }
  };
}(window));
