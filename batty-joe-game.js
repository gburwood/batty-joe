/* Batty Joe Development Specification v1.6.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};
  const C = BJ.Config;
  const U = BJ.Utils;
  const P = BJ.Physics;

  function noop() {}

  function Game(canvas, options) {
    options = options || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audio = options.audio || { play: noop };
    this.input = options.input || null;
    this.settings = options.settings || BJ.Storage.loadSettings();
    this.callbacks = options.callbacks || {};
    this.debug = !!options.debug;
    this.debugInvulnerable = false;

    this.state = BJ.State.BOOT;
    this.previousState = null;
    this.seed = '';
    this.difficulty = 'normal';
    this.level = 1;
    this.score = 0;
    this.lives = C.lives.start;
    this.continuesRemaining = C.continues.max;
    this.campaignCompleted = false;
    this.maxCombo = 1;
    this.combo = 1;
    this.rapidCombo = 1;
    this.lastBrickActionAt = -999;
    this.elapsed = 0;
    this.levelElapsed = 0;
    this.stateElapsed = 0;
    this.fps = 60;
    this.fpsAccumulator = 0;
    this.fpsFrames = 0;
    this.simulationStep = 0;

    this.levelData = null;
    this.levelInitial = null;
    this.rng = U.createRng('boot');
    this.fxRng = U.createRng('boot-fx');
    this.paddle = null;
    this.balls = [];
    this.powerDrops = [];
    this.playerShots = [];
    this.enemyShots = [];
    this.particles = [];
    this.activePowerups = Object.create(null);
    this.laserCooldown = 0;
    this.frenzyCounts = { invaders: 0, fps: 0, pinball: 0, asteroids: 0, missile: 0, revenge: 0, tenpin: 0, bomber: 0 };
    this.frenzyTotalThisLevel = 0;
    this.frenzyMode = null;
    this.frenzyRemaining = 0;
    this.frenzyInitialCount = 0;
    this.frenzyFormationDirection = 1;
    this.frenzyFireTimer = 1;
    this.frenzySnapshot = null;
    this.frenzyTransition = null;
    this.fpsAim = { x: C.playfield.width / 2, y: C.playfield.height / 2 };
    this.fpsCamera = { x: 0, vx: 0 };
    this.fpsWeapon = { recoil: 0, muzzle: 0, tracer: null, hitFlash: 0 };
    this.fpsShootCooldown = 0;
    this.frenzyGame = null;
    this.finalAssault = { active: false, threshold: 0, noHitTime: 0, stage: 0, startingRequired: 0, lastResetStep: -1, elapsed: 0 };
    this.bigBomb = { charge: 0, collected: 0, used: false, readyAnnounced: false, spawnTimer: C.bigBomb.startDelaySeconds, freezeRemaining: 0, flashRemaining: 0, waveRemaining: 0 };
    this.bigBombRng = U.createRng('boot-big-bomb');
    this.shake = 0;
    this.intermissionRemaining = 0;
    this.continueRemaining = 0;
    this.attract = false;
    this.highScoreEligible = true;
    this.message = '';
    this.messageTime = 0;
    this.lastSaveAt = -999;
  }

  Game.prototype.setInput = function (input) {
    this.input = input;
  };

  Game.prototype.setSettings = function (settings) {
    this.settings = settings;
  };

  Game.prototype.setState = function (next, detail) {
    if (this.state === next) return;
    const old = this.state;
    this.previousState = old;
    this.state = next;
    this.stateElapsed = 0;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange(next, old, detail || null, this);
  };

  Game.prototype.newCampaign = function (options) {
    options = options || {};
    this.seed = String(options.seed || U.randomSeed()).toUpperCase();
    this.difficulty = C.difficulty[options.difficulty] ? options.difficulty : 'normal';
    this.level = U.clamp(Number(options.level || 1), 1, C.campaignLevels);
    this.score = 0;
    this.lives = U.clamp(Number(options.lives || C.lives.start), 1, C.lives.max);
    this.continuesRemaining = C.continues.max;
    this.campaignCompleted = false;
    this.maxCombo = 1;
    this.combo = 1;
    this.rapidCombo = 1;
    this.attract = !!options.attract;
    this.highScoreEligible = !this.attract && !options.debugModified;
    this.loadLevel(this.level, true);
    this.setState(this.attract ? BJ.State.ATTRACT : (this.level === C.bossLevel ? BJ.State.BOSS : BJ.State.PLAYING));
    if (!this.attract) this.autosave('level_start');
  };

  Game.prototype.resumeCampaign = function (save) {
    if (!save) return false;
    this.seed = save.campaignSeed;
    this.difficulty = C.difficulty[save.difficulty] ? save.difficulty : 'normal';
    this.level = U.clamp(Number(save.currentLevel || 1), 1, C.campaignLevels);
    this.score = Number(save.score || 0);
    this.lives = U.clamp(Number(save.lives || C.lives.start), 1, C.lives.max);
    this.continuesRemaining = U.clamp(Number(save.continuesRemaining == null ? C.continues.max : save.continuesRemaining), 0, C.continues.max);
    this.maxCombo = Math.max(1, Number(save.maxCombo || 1));
    this.combo = Math.max(1, Number(save.combo || 1));
    this.highScoreEligible = save.highScoreEligibleState !== false;
    this.attract = false;
    this.loadLevel(this.level, true);
    this.setState(this.level === C.bossLevel ? BJ.State.BOSS : BJ.State.PLAYING);
    return true;
  };

  Game.prototype.loadLevel = function (level, fresh) {
    this.level = level;
    this.levelData = BJ.Levels.generateLevel(this.seed, this.difficulty, level);
    this.levelInitial = U.deepClone(this.levelData);
    this.rng = BJ.Levels.campaignRng(this.seed, this.difficulty, level, 'gameplay');
    this.fxRng = BJ.Levels.campaignRng(this.seed, this.difficulty, level, 'fx');
    this.bigBombRng = BJ.Levels.campaignRng(this.seed, this.difficulty, level, 'big-bomb-spawn');
    this.levelElapsed = 0;
    this.frenzyCounts = { invaders: 0, fps: 0, pinball: 0, asteroids: 0, missile: 0, revenge: 0, tenpin: 0, bomber: 0 };
    this.frenzyTotalThisLevel = 0;
    this.frenzyMode = null;
    this.frenzyRemaining = 0;
    this.frenzySnapshot = null;
    this.frenzyTransition = null;
    this.fpsCamera = { x: 0, vx: 0 };
    this.fpsAim = { x: C.playfield.width / 2, y: C.playfield.height / 2 };
    this.fpsWeapon = { recoil: 0, muzzle: 0, tracer: null, hitFlash: 0 };
    this.frenzyGame = null;
    this.activePowerups = Object.create(null);
    this.powerDrops = [];
    this.playerShots = [];
    this.enemyShots = [];
    this.particles = [];
    this.combo = fresh ? this.combo : 1;
    this.rapidCombo = 1;
    this.lastBrickActionAt = -999;
    this.createPaddle();
    this.createStartingBall();
    this.finalAssault = { active: false, threshold: Math.max(1, Math.min(C.finalAssault.thresholdMaxBricks, Math.ceil(BJ.Levels.countRequired(this.levelData.bricks) * C.finalAssault.thresholdPercent))), noHitTime: 0, stage: 0, startingRequired: BJ.Levels.countRequired(this.levelData.bricks), lastResetStep: -1, elapsed: 0 };
    this.bigBomb = { charge: 0, collected: 0, used: false, readyAnnounced: false, spawnTimer: C.bigBomb.startDelaySeconds, freezeRemaining: 0, flashRemaining: 0, waveRemaining: 0 };
    this.showMessage(this.levelData.title, 2.0);
  };

  Game.prototype.createPaddle = function () {
    this.paddle = {
      x: (C.playfield.width - C.paddle.baseWidth) / 2,
      y: C.paddle.y,
      w: C.paddle.baseWidth,
      h: C.paddle.height,
      vx: 0,
      ship: false,
      hidden: false
    };
  };

  Game.prototype.createStartingBall = function () {
    const speed = this.getTargetBallSpeed();
    this.balls = [{
      x: this.paddle.x + this.paddle.w / 2,
      y: this.paddle.y - C.balls.radius - 2,
      r: C.balls.radius,
      vx: speed * 0.30,
      vy: -Math.sqrt(Math.max(1, speed * speed - Math.pow(speed * 0.30, 2))),
      launched: false,
      held: true,
      holdRemaining: Infinity,
      spin: 0,
      paddleSpeedBoost: 0
    }];
  };

  Game.prototype.getTargetBallSpeed = function () {
    const d = C.difficulty[this.difficulty];
    return P.acceleratedSpeed(d.baseSpeed, d.maxSpeed, this.level, this.levelElapsed, d.accelerationFactor);
  };

  Game.prototype.isFrenzyState = function () {
    return this.state === BJ.State.FRENZY_TRANSITION_IN || this.state === BJ.State.FRENZY_ACTIVE || this.state === BJ.State.FRENZY_TRANSITION_OUT;
  };

  Game.prototype.getBasePlayState = function () {
    return this.level === C.bossLevel ? BJ.State.BOSS : (this.attract ? BJ.State.ATTRACT : BJ.State.PLAYING);
  };

  Game.prototype.getActiveFrenzyConfig = function () {
    return C.frenzy[this.frenzyMode] || C.frenzy.invaders;
  };

  Game.prototype.getFrenzyDuration = function (mode) {
    const cfg = C.frenzy[mode];
    return cfg && Number(cfg.duration) > 0 ? Number(cfg.duration) : C.frenzy.duration;
  };

  Game.prototype.getFrenzyMinimumBricks = function (mode) {
    const cfg = C.frenzy[mode];
    return cfg && cfg.minBricks ? cfg.minBricks : C.frenzy.minBricks;
  };

  Game.prototype.countRequiredAliveBricks = function () {
    return this.levelData ? BJ.Levels.countRequired(this.levelData.bricks) : 0;
  };

  Game.prototype.isPlayableState = function () {
    return this.state === BJ.State.PLAYING || this.state === BJ.State.BOSS || this.state === BJ.State.ATTRACT || this.isFrenzyState();
  };

  Game.prototype.update = function (dt) {
    dt = Math.min(0.05, Math.max(0, Number(dt) || 0));
    this.simulationStep += 1;
    this.elapsed += dt;
    this.stateElapsed += dt;
    this.fpsAccumulator += dt;
    this.fpsFrames += 1;
    if (this.fpsAccumulator >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccumulator;
      this.fpsFrames = 0;
      this.fpsAccumulator = 0;
    }
    if (this.messageTime > 0) this.messageTime -= dt;

    if (this.state === BJ.State.LEVEL_COMPLETE) {
      this.intermissionRemaining -= dt;
      if (this.actionPressed() || this.intermissionRemaining <= 0) this.advanceLevel();
      return;
    }

    if (this.state === BJ.State.CONTINUE) {
      this.continueRemaining -= dt;
      if (this.actionPressed()) this.useContinue();
      else if (this.continueRemaining <= 0) this.finishGame(false);
      return;
    }

    if (!this.isPlayableState()) return;

    this.levelElapsed += dt;
    this.laserCooldown = Math.max(0, this.laserCooldown - dt);
    this.fpsShootCooldown = Math.max(0, this.fpsShootCooldown - dt);
    this.fpsWeapon.recoil = Math.max(0, this.fpsWeapon.recoil - dt * 8);
    this.fpsWeapon.muzzle = Math.max(0, this.fpsWeapon.muzzle - dt);
    this.fpsWeapon.hitFlash = Math.max(0, this.fpsWeapon.hitFlash - dt);
    if (this.fpsWeapon.tracer) {
      this.fpsWeapon.tracer.life -= dt;
      if (this.fpsWeapon.tracer.life <= 0) this.fpsWeapon.tracer = null;
    }

    if (this.isFrenzyState()) {
      if (this.state === BJ.State.FRENZY_ACTIVE) {
        if (this.frenzyMode === 'fps') this.updateFpsPlayer(dt);
        else if (this.frenzyMode === 'invaders') this.updatePaddle(dt);
        else if (this.frenzyMode === 'pinball') this.updatePinballInput(dt);
        else if (this.frenzyMode === 'asteroids') this.updateAsteroidsInput(dt);
        else if (this.frenzyMode === 'missile') this.updateMissileInput(dt);
        else if (this.frenzyMode === 'revenge') this.updateRevengeInput(dt);
        else if (this.frenzyMode === 'tenpin') this.updateTenPinInput(dt);
        else if (this.frenzyMode === 'bomber') this.updateBomberInput(dt);
      }
      this.updateFrenzyState(dt);
      this.updateEnemyShots(dt);
      this.updateParticles(dt);
      this.shake = Math.max(0, this.shake - dt * 12);
      return;
    }

    if (this.bigBomb) {
      this.bigBomb.flashRemaining = Math.max(0, (this.bigBomb.flashRemaining || 0) - dt);
      this.bigBomb.waveRemaining = Math.max(0, (this.bigBomb.waveRemaining || 0) - dt);
      if ((this.bigBomb.freezeRemaining || 0) > 0) {
        this.bigBomb.freezeRemaining = Math.max(0, this.bigBomb.freezeRemaining - dt);
        this.updateParticles(dt);
        this.shake = Math.max(0, this.shake - dt * 8);
        return;
      }
    }

    this.updateBigBomb(dt);
    if ((this.bigBomb && this.bigBomb.freezeRemaining > 0) || !this.isPlayableState()) {
      this.updateParticles(dt);
      this.shake = Math.max(0, this.shake - dt * 8);
      return;
    }
    this.updateActivePowerups(dt);
    this.updatePaddle(dt);
    this.updateBalls(dt);
    this.updateBricks(dt);
    this.updatePowerDrops(dt);
    this.updatePlayerShots(dt);
    if (this.state === BJ.State.BOSS) this.updateBoss(dt);
    this.updateEnemyShots(dt);
    this.updateParticles(dt);
    this.updateFinalAssault(dt);
    this.shake = Math.max(0, this.shake - dt * 12);
  };

  Game.prototype.updatePaddle = function (dt) {
    const p = this.paddle;
    const input = this.getHorizontalInput();
    const imprecise = !this.isFrenzyState() && !!this.activePowerups.imprecise_paddle;
    const penalty = imprecise ? 0.62 : 1;
    const accel = C.paddle.acceleration * penalty;
    const decel = C.paddle.deceleration * penalty;
    const maxSpeed = (this.frenzyMode === 'fps' && this.state === BJ.State.FRENZY_ACTIVE ? C.frenzy.fps.strafeMaxSpeed : C.paddle.maxSpeed) * (imprecise ? 0.86 : 1);

    if (input !== 0) {
      p.vx += input * accel * dt;
      p.vx = U.clamp(p.vx, -maxSpeed, maxSpeed);
    } else {
      const amount = decel * dt;
      if (Math.abs(p.vx) <= amount) p.vx = 0;
      else p.vx -= Math.sign(p.vx) * amount;
    }

    if (imprecise) {
      p.vx += Math.sin(this.elapsed * 4.7 + (this.rng.state() % 31)) * 22 * dt;
    }

    p.x += p.vx * dt;
    if (p.x < 0) { p.x = 0; p.vx = Math.max(0, p.vx); }
    if (p.x + p.w > C.playfield.width) { p.x = C.playfield.width - p.w; p.vx = Math.min(0, p.vx); }

    this.balls.forEach(function (ball) {
      if (ball.held) {
        // The bat moves underneath a held ball. This lets the player choose the
        // release angle by positioning the ball across the bat before release.
        ball.x = U.clamp(ball.x, p.x + ball.r, p.x + p.w - ball.r);
        ball.y = p.y - ball.r - 2;
        if (Number.isFinite(ball.holdRemaining)) ball.holdRemaining -= dt;
      }
    });

    if (this.actionPressed() || (this.input && this.input.wasMousePressed && this.input.wasMousePressed() && this.state === BJ.State.FRENZY_ACTIVE && this.frenzyMode === 'fps')) {
      const heldBalls = this.balls.filter(function (b) { return b.held; });
      if (heldBalls.length && !this.isFrenzyState()) this.releaseHeldBalls();
      else if (this.state === BJ.State.FRENZY_ACTIVE) this.firePlayerShot(true);
    }

    if (this.activePowerups.laser && !this.isFrenzyState() && this.actionDown() && this.laserCooldown <= 0) {
      this.firePlayerShot(false);
      this.laserCooldown = 1 / C.powerups.laser.rate;
    }
  };

  Game.prototype.getHorizontalInput = function () {
    if (this.attract && this.state !== BJ.State.FRENZY_ACTIVE) {
      const targets = this.balls.filter(function (b) { return b.launched; });
      const ball = targets.length ? targets.reduce(function (a, b) { return b.y > a.y ? b : a; }, targets[0]) : null;
      if (!ball) return 0;
      const centre = this.paddle.x + this.paddle.w / 2;
      if (ball.x < centre - 18) return -1;
      if (ball.x > centre + 18) return 1;
      return 0;
    }
    if (this.attract && this.state === BJ.State.FRENZY_ACTIVE && this.frenzyMode === 'invaders') {
      const danger = this.enemyShots.reduce(function (best, shot) {
        if (shot.mode !== 'fps' && shot.y > 480 && (!best || shot.y > best.y)) return shot;
        return best;
      }, null);
      if (danger) return danger.x < this.paddle.x + this.paddle.w / 2 ? 1 : -1;
      return Math.sin(this.elapsed * 1.3) > 0 ? 1 : -1;
    }
    if (!this.input) return 0;
    return (this.input.isDown('right') ? 1 : 0) - (this.input.isDown('left') ? 1 : 0);
  };

  Game.prototype.actionDown = function () {
    if (this.attract) return true;
    return !!(this.input && this.input.isDown('action'));
  };

  Game.prototype.actionPressed = function () {
    if (this.attract) {
      if (this.balls.some(function (b) { return b.held; })) return true;
      if (this.state === BJ.State.FRENZY_ACTIVE) return this.stateElapsed % 0.32 < 0.02;
      return false;
    }
    return !!(this.input && this.input.wasPressed('action'));
  };

  Game.prototype.releaseHeldBalls = function () {
    const self = this;
    this.balls.forEach(function (ball) {
      if (ball.held) self.releaseBall(ball);
    });
  };

  Game.prototype.updateBalls = function (dt) {
    const self = this;
    const targetSpeed = this.getTargetBallSpeed() * this.getBallSpeedEffect() * this.getFinalAssaultSpeedMultiplier();

    this.balls.slice().forEach(function (ball) {
      if (ball.held) {
        if (Number.isFinite(ball.holdRemaining) && ball.holdRemaining <= 0) self.releaseBall(ball);
        return;
      }
      P.decayPaddleSpeedBoost(ball, dt, targetSpeed, C.physics.paddleVelocityTransfer);
      const spinTurn = P.applySpin(ball, dt, C.spin);
      self.applyFinalAssaultMagnetism(ball, dt, spinTurn);
      const currentSpeed = Math.max(targetSpeed, P.length(ball.vx, ball.vy));
      P.normalizeVelocity(ball, currentSpeed);
      const previous = P.integrateBall(ball, dt, C.playfield.width, C.playfield.height);
      self.updateFinalAssaultBallTrail(ball);
      if (previous.hitWallX || previous.hitWallY) P.retainSpin(ball, C.spin.wallRetention);

      if (ball.y - ball.r > C.playfield.height) {
        const idx = self.balls.indexOf(ball);
        if (idx >= 0) self.balls.splice(idx, 1);
        return;
      }

      if (P.circleRect(ball, self.paddle) && ball.vy > 0) {
        ball.y = self.paddle.y - ball.r - 0.1;
        if (self.activePowerups.sticky) {
          ball.held = true;
          ball.launched = true;
          ball.holdRemaining = C.powerups.sticky.maxHold;
        } else {
          P.bounceFromPaddle(ball, self.paddle, targetSpeed);
          self.applyFinalAssaultAssist(ball);
        }
        self.combo = 1;
        self.audio.play('paddle_hit');
        self.chargeBigBombFromPaddleContact(ball);
      }

      if (self.state === BJ.State.BOSS && self.levelData.boss && self.levelData.boss.alive && P.circleRect(ball, self.levelData.boss)) {
        P.resolveBallRect(ball, self.levelData.boss, previous);
        self.damageBoss(4);
      } else {
        self.handleBallBrickCollisions(ball, previous);
      }
    });

    if (this.balls.length === 0 && this.state !== BJ.State.LEVEL_COMPLETE && this.state !== BJ.State.VICTORY) {
      this.loseLife();
    }
  };

  Game.prototype.releaseBall = function (ball) {
    const speed = this.getTargetBallSpeed() * this.getBallSpeedEffect() * this.getFinalAssaultSpeedMultiplier();
    ball.held = false;
    ball.launched = true;
    ball.holdRemaining = 0;
    ball.paddleSpeedBoost = 0;
    P.releaseFromPaddle(ball, this.paddle, speed, C.balls.releaseMaxAngleDegrees);
  };

  Game.prototype.handleBallBrickCollisions = function (ball, previous) {
    const bricks = this.levelData.bricks;
    for (let i = 0; i < bricks.length; i += 1) {
      const brick = bricks[i];
      if (!brick.alive || !P.circleRect(ball, brick)) continue;

      const penetrating = !!this.activePowerups.penetrating_ball && brick.type !== 'indestructible';
      const damaged = this.damageBrick(brick, 1, { source: 'ball', frenzy: false });
      if (!penetrating) {
        P.resolveBallRect(ball, brick, previous, { characterise: true, kind: 'brick', signature: 'brick-' + brick.id });
        P.retainSpin(ball, C.spin.brickRetention);
      }
      if (damaged) this.audio.play(brick.alive ? 'brick_hit' : 'brick_break');
      break;
    }
  };

  Game.prototype.damageBrick = function (brick, amount, context) {
    context = context || {};
    if (!brick.alive) return false;
    if (brick.type === 'indestructible' && !context.frenzy) return false;

    const now = this.levelElapsed;
    brick.lastHitAt = now;
    if (brick.type === 'indestructible' && context.frenzy) {
      if (brick.hits >= 999) brick.hits = 4;
    }
    brick.hits -= amount;
    const destroyed = brick.hits <= 0;
    this.scoreBrickAction(brick, destroyed, context);
    this.chargeBigBombFromBrick(brick, destroyed, context);
    this.handleFinalAssaultProgress(brick, destroyed, context);

    if (destroyed) {
      brick.alive = false;
      brick.destroyedAt = now;
      this.spawnParticles(brick.x + brick.w / 2, brick.y + brick.h / 2, brick.type === 'explosive' ? 18 : 7);

      if (brick.type === 'explosive') {
        this.audio.play('explosion');
        this.addShake(5);
        this.explodeBrick(brick, context);
      }

      if (!context.frenzy) this.maybeDropPowerup(brick);
      this.autosave('score_checkpoint');
      this.checkLevelComplete();
    }
    return true;
  };

  Game.prototype.handleFinalAssaultProgress = function (brick, destroyed, context) {
    if (!this.finalAssault || !this.finalAssault.active || this.isFrenzyState()) return false;
    if (!brick || brick.type === 'indestructible') return false;
    const policy = C.finalAssault.helperResetPolicy || 'destroyed_only';
    let shouldReset = false;
    if (policy === 'any_hit') shouldReset = true;
    else if (policy === 'destroyed_only') shouldReset = !!destroyed;
    else if (policy === 'never') shouldReset = false;
    if (!shouldReset) return false;
    if (this.finalAssault.lastResetStep === this.simulationStep) return false;
    this.finalAssault.noHitTime = 0;
    this.finalAssault.stage = 0;
    this.finalAssault.lastResetStep = this.simulationStep;
    return true;
  };

  Game.prototype.scoreBrickAction = function (brick, destroyed, context) {
    const now = this.levelElapsed;
    if (now - this.lastBrickActionAt <= C.scoring.rapidWindow) this.rapidCombo = Math.min(C.scoring.rapidComboMax, this.rapidCombo + 1);
    else this.rapidCombo = 1;
    this.lastBrickActionAt = now;
    this.combo = Math.min(C.scoring.noPaddleComboMax, this.combo + 1);
    this.maxCombo = Math.max(this.maxCombo, this.combo);

    const weight = BJ.BrickWeights[brick.type] || 1;
    let points = C.scoring.baseBrick * weight * this.combo * this.rapidCombo;
    if (!destroyed) points *= 0.45;
    if (this.finalAssault && this.finalAssault.active) points *= C.finalAssault.scoreMultiplier;
    if (context && context.frenzy) {
      const frenzyMultiplier = Math.min(C.scoring.frenzyMultiplierMax, C.scoring.frenzyMultiplierStart + Math.max(0, this.frenzyInitialCount - this.countFrenzyInvaders()) * C.scoring.frenzyMultiplierStep);
      points *= frenzyMultiplier;
    }
    if (context && context.chainDepth > 0) points += C.scoring.chainBonus * context.chainDepth;
    this.score += Math.round(points);
  };

  Game.prototype.explodeBrick = function (source, context) {
    const self = this;
    const radius = Math.max(source.w, source.h) * 1.25 + source.w * 0.55;
    const sx = source.x + source.w / 2;
    const sy = source.y + source.h / 2;
    const chainDepth = (context.chainDepth || 0) + 1;

    this.levelData.bricks.forEach(function (other) {
      if (!other.alive || other === source) return;
      const dx = (other.x + other.w / 2) - sx;
      const dy = (other.y + other.h / 2) - sy;
      if (Math.sqrt(dx * dx + dy * dy) > radius) return;
      if (other.type === 'indestructible' && !context.frenzy) return;
      const damage = other.type === 'explosive' ? other.hits : Math.max(1, other.hits);
      self.damageBrick(other, damage, {
        source: 'explosion',
        frenzy: !!context.frenzy,
        chainDepth
      });
    });
  };

  Game.prototype.updateBricks = function (dt) {
    const self = this;
    const laneMin = C.level.marginX;
    const laneMax = C.playfield.width - C.level.marginX;
    this.levelData.bricks.forEach(function (brick) {
      if (brick.type === 'moving' && brick.alive) {
        const oldX = brick.x;
        brick.x += brick.moveDirection * brick.moveSpeed * dt;
        if (brick.x < laneMin || brick.x + brick.w > laneMax) {
          brick.x = U.clamp(brick.x, laneMin, laneMax - brick.w);
          brick.moveDirection *= -1;
        }
        for (let i = 0; i < self.levelData.bricks.length; i += 1) {
          const other = self.levelData.bricks[i];
          if (other === brick || !other.alive) continue;
          if (P.rectRect(brick, other)) {
            brick.x = oldX;
            brick.moveDirection *= -1;
            break;
          }
        }
      }

      if (brick.type === 'regenerating') {
        if (brick.alive && brick.regenMode === 'heal' && brick.hits < brick.maxHits && self.levelElapsed - brick.lastHitAt >= 4) {
          brick.hits = Math.min(brick.maxHits, brick.hits + 1);
          brick.lastHitAt = self.levelElapsed;
        } else if (!brick.alive && brick.regenMode === 'respawn' && brick.destroyedAt != null && self.levelElapsed - brick.destroyedAt >= 6) {
          brick.alive = true;
          brick.hits = brick.maxHits;
          brick.destroyedAt = null;
          self.spawnParticles(brick.x + brick.w / 2, brick.y + brick.h / 2, 5);
        }
      }
    });
  };

  Game.prototype.maybeDropPowerup = function (brick) {
    if (this.attract && this.rng() < 0.4) return;
    let type = brick.containedPowerup || brick.seededDrop || null;
    const d = C.difficulty[this.difficulty];
    if (!type && this.rng() < d.positiveDropChance) type = BJ.Levels.choosePowerup(this.rng, this.level, this.difficulty, false);
    if (!type) return;
    const frenzyTypeToMode = {
      space_invaders_frenzy: 'invaders', fps_frenzy: 'fps', pinball_frenzy: 'pinball',
      asteroids_frenzy: 'asteroids', missile_command_frenzy: 'missile', arkanoid_revenge_frenzy: 'revenge',
      ten_pin_frenzy: 'tenpin', bomber_frenzy: 'bomber'
    };
    if (frenzyTypeToMode[type]) {
      const mode = frenzyTypeToMode[type];
      if (this.frenzyTotalThisLevel >= C.frenzy.maxTotalPerLevel || this.frenzyCounts[mode] >= C.frenzy.maxPerLevelByType[mode] || this.countAliveBricks() < this.getFrenzyMinimumBricks(mode)) return;
    }
    this.powerDrops.push({ type, x: brick.x + brick.w / 2 - 24, y: brick.y + brick.h / 2 - 10, w: 48, h: 20, vy: 150 });
  };

  Game.prototype.updatePowerDrops = function (dt) {
    for (let i = this.powerDrops.length - 1; i >= 0; i -= 1) {
      const drop = this.powerDrops[i];
      drop.y += drop.vy * dt;
      if (P.rectRect(drop, this.paddle)) {
        this.powerDrops.splice(i, 1);
        if (drop.special === 'big_bomb_power') this.collectBigBombPowerUp();
        else this.collectPowerup(drop.type);
      } else if (drop.y > C.playfield.height + 30) this.powerDrops.splice(i, 1);
    }
  };

  Game.prototype.collectPowerup = function (type) {
    const cfg = C.powerups[type];
    if (!cfg) return;
    this.audio.play('powerup_collect');

    const frenzyPowerups = {
      space_invaders_frenzy: 'invaders', fps_frenzy: 'fps', pinball_frenzy: 'pinball',
      asteroids_frenzy: 'asteroids', missile_command_frenzy: 'missile', arkanoid_revenge_frenzy: 'revenge',
      ten_pin_frenzy: 'tenpin', bomber_frenzy: 'bomber'
    };
    if (frenzyPowerups[type]) { this.startFrenzy(frenzyPowerups[type]); return; }

    if (type === 'multiball') { this.applyMultiball(); this.autosave('powerup_state_change'); return; }
    if (type === 'extra_life') { this.lives = Math.min(C.lives.max, this.lives + 1); this.showMessage('EXTRA LIFE. TRY NOT TO WASTE IT.', 1.8); this.autosave('powerup_state_change'); return; }

    if (type === 'wide') delete this.activePowerups.narrow;
    if (type === 'narrow') delete this.activePowerups.wide;
    if (type === 'slow_ball') delete this.activePowerups.fast_ball;
    if (type === 'fast_ball') delete this.activePowerups.slow_ball;

    const existing = this.activePowerups[type];
    this.activePowerups[type] = { remaining: cfg.duration, stacks: existing ? Math.min(cfg.maxStacks || 1, existing.stacks + 1) : 1 };
    this.recalculatePaddleSize();
    this.autosave('powerup_state_change');
  };

  Game.prototype.applyMultiball = function () {
    const existing = this.balls.slice();
    const target = Math.min(C.balls.max, existing.length * 2);
    let cursor = 0;
    while (this.balls.length < target && existing.length) {
      const source = existing[cursor % existing.length];
      const clone = Object.assign({}, source);
      clone.held = false;
      clone.launched = true;
      clone.holdRemaining = 0;
      clone.vx = -source.vx + (cursor % 2 ? 35 : -35);
      clone.vy = source.vy > 0 ? -Math.abs(source.vy) : source.vy;
      clone.spin = U.clamp((source.spin || 0) + (cursor % 2 ? 0.08 : -0.08), -1, 1);
      this.balls.push(clone);
      cursor += 1;
    }
    this.showMessage('MULTIBALL. ACCOUNTABILITY HAS ENDED.', 1.5);
  };

  Game.prototype.updateActivePowerups = function (dt) {
    if (this.isFrenzyState()) return;
    const expired = [];
    Object.keys(this.activePowerups).forEach((function (type) {
      const effect = this.activePowerups[type];
      effect.remaining -= dt;
      if (effect.remaining <= 0) expired.push(type);
    }).bind(this));
    expired.forEach((function (type) { delete this.activePowerups[type]; }).bind(this));
    if (expired.length) { this.recalculatePaddleSize(); this.autosave('powerup_state_change'); }
  };

  Game.prototype.recalculatePaddleSize = function () {
    if (!this.paddle) return;
    const centre = this.paddle.x + this.paddle.w / 2;
    let factor = 1;
    if (this.activePowerups.wide) factor = Math.min(2, 1 + 0.25 * this.activePowerups.wide.stacks);
    if (this.activePowerups.narrow) factor = Math.max(0.5, 1 - 0.125 * this.activePowerups.narrow.stacks);
    this.paddle.w = C.paddle.baseWidth * factor;
    this.paddle.x = U.clamp(centre - this.paddle.w / 2, 0, C.playfield.width - this.paddle.w);
  };

  Game.prototype.getBallSpeedEffect = function () {
    if (this.activePowerups.slow_ball) return C.powerups.slow_ball.multiplier;
    if (this.activePowerups.fast_ball) return C.powerups.fast_ball.multiplier;
    return 1;
  };

  Game.prototype.firePlayerShot = function (frenzy) {
    if (!this.paddle) return;
    if (frenzy && this.frenzyMode === 'fps') {
      if (this.fpsShootCooldown > 0) return;
      this.fpsShootCooldown = 1 / C.frenzy.fps.rifleFireRate;
      this.fireFpsHitscan();
      this.audio.play('laser');
      return;
    }
    const shotSpeed = frenzy ? C.frenzy.invaders.shotSpeed : 720;
    this.playerShots.push({ x: this.paddle.x + this.paddle.w / 2 - 3, y: this.paddle.y - 12, w: 6, h: 14, vy: -shotSpeed, frenzy: !!frenzy });
    this.audio.play('laser');
  };

  Game.prototype.getFpsHitscanTarget = function (x, y) {
    const targets = this.levelData.bricks.filter(function (brick) {
      return brick.alive && brick.frenzyMeta;
    });
    let hit = null;
    let bestDepth = Infinity;
    for (let i = 0; i < targets.length; i += 1) {
      const brick = targets[i];
      const attack = brick.frenzyMeta.attack;
      const rect = this.getFpsTargetRect(brick);
      if (!rect) continue;
      const effectiveDepth = attack && attack.phase === 'fall' ? -1 : brick.frenzyMeta.depth;
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h && effectiveDepth < bestDepth) {
        bestDepth = effectiveDepth;
        hit = brick;
      }
    }
    return hit;
  };

  Game.prototype.fireFpsHitscan = function () {
    const hit = this.getFpsHitscanTarget(this.fpsAim.x, this.fpsAim.y);
    this.fpsWeapon.recoil = 1;
    this.fpsWeapon.muzzle = 0.075;
    this.fpsWeapon.tracer = {
      x1: C.playfield.width / 2,
      y1: C.playfield.height - 94,
      x2: this.fpsAim.x,
      y2: this.fpsAim.y,
      life: 0.09,
      maxLife: 0.09
    };
    if (!hit) return;
    this.fpsWeapon.hitFlash = 0.08;
    this.spawnParticles(this.fpsAim.x, this.fpsAim.y, 10);
    this.damageBrick(hit, hit.type === 'normal' ? hit.hits : 1, { source: 'fps-hitscan', frenzy: true });
  };

  Game.prototype.updatePlayerShots = function (dt) {
    for (let i = this.playerShots.length - 1; i >= 0; i -= 1) {
      const shot = this.playerShots[i];
      shot.y += shot.vy * dt;
      if (shot.y + shot.h < 0) { this.playerShots.splice(i, 1); continue; }
      if (this.state === BJ.State.BOSS && this.levelData.boss && this.levelData.boss.alive && P.rectRect(shot, this.levelData.boss)) { this.damageBoss(2); this.playerShots.splice(i, 1); continue; }
      const hit = this.levelData.bricks.find(function (b) { return b.alive && P.rectRect(shot, b); });
      if (hit) { this.damageBrick(hit, hit.type === 'normal' ? hit.hits : 1, { source: shot.frenzy ? 'frenzy-shot' : 'laser', frenzy: !!shot.frenzy }); this.playerShots.splice(i, 1); }
    }
  };

  Game.prototype.normalizeFrenzyMode = function (mode) {
    const aliases = {
      invaders: 'invaders', space_invaders: 'invaders', space_invaders_frenzy: 'invaders',
      fps: 'fps', fps_frenzy: 'fps',
      pinball: 'pinball', pinball_frenzy: 'pinball',
      asteroids: 'asteroids', asteroids_frenzy: 'asteroids',
      missile: 'missile', missile_command: 'missile', missile_command_frenzy: 'missile',
      revenge: 'revenge', arkanoid_revenge: 'revenge', arkanoid_revenge_frenzy: 'revenge',
      tenpin: 'tenpin', ten_pin: 'tenpin', ten_pin_frenzy: 'tenpin', bowling: 'tenpin',
      bomber: 'bomber', bomber_frenzy: 'bomber'
    };
    return aliases[String(mode || '').toLowerCase()] || 'invaders';
  };

  Game.prototype.startFrenzy = function (requestedMode) {
    const mode = this.normalizeFrenzyMode(requestedMode);
    if (this.isFrenzyState() || !this.levelData || this.levelData.boss) return false;
    if ((this.frenzyCounts[mode] || 0) >= (C.frenzy.maxPerLevelByType[mode] || 1)) return false;
    if (this.frenzyTotalThisLevel >= C.frenzy.maxTotalPerLevel) return false;
    const participants = this.levelData.bricks.filter(function (brick) { return brick.alive; });
    if (participants.length < this.getFrenzyMinimumBricks(mode)) return false;

    this.frenzyCounts[mode] = (this.frenzyCounts[mode] || 0) + 1;
    this.frenzyTotalThisLevel += 1;
    this.frenzyMode = mode;
    this.frenzyRemaining = this.getFrenzyDuration(mode);
    this.frenzyInitialCount = participants.length;
    this.frenzyFormationDirection = 1;
    this.frenzyFireTimer = 1.1;
    this.frenzySnapshot = {
      balls: U.deepClone(this.balls),
      activePowerups: U.deepClone(this.activePowerups),
      paddle: U.deepClone(this.paddle),
      playerShots: U.deepClone(this.playerShots),
      enemyShots: U.deepClone(this.enemyShots),
      powerDrops: U.deepClone(this.powerDrops),
      combo: this.combo,
      rapidCombo: this.rapidCombo,
      laserCooldown: this.laserCooldown,
      lastBrickActionAt: this.lastBrickActionAt,
      rngState: this.rng.state(),
      levelElapsedAtStart: this.levelElapsed,
      finalAssault: U.deepClone(this.finalAssault),
      bigBomb: U.deepClone(this.bigBomb),
      bigBombRngState: this.bigBombRng && this.bigBombRng.state ? this.bigBombRng.state() : null
    };

    this.balls = [];
    this.powerDrops = [];
    this.playerShots = [];
    this.enemyShots = [];
    this.frenzyGame = null;
    this.fpsAim = { x: C.playfield.width / 2, y: C.playfield.height / 2 };
    this.fpsCamera = { x: 0, vx: 0 };
    this.fpsWeapon = { recoil: 0, muzzle: 0, tracer: null, hitFlash: 0 };

    participants.forEach((function (brick) {
      brick.frenzyOriginal = { x: brick.x, y: brick.y, w: brick.w, h: brick.h, hits: brick.hits, maxHits: brick.maxHits };
      brick.frenzyMeta = {
        mode: mode,
        transitionStart: { x: brick.x, y: brick.y, w: brick.w, h: brick.h },
        transitionEnd: { x: brick.x, y: brick.y, w: brick.w, h: brick.h },
        projected: null, visual: null, morph: 0, depth: 1,
        planeOffsetX: 0, planeDirection: brick.moveDirection || 1, lateralOffset: 0,
        angle: 0, vx: 0, vy: 0
      };
      if (brick.type === 'indestructible') { brick.hits = 4; brick.maxHits = 4; }
    }).bind(this));

    this.setupFrenzyMode(mode, participants);
    this.frenzyTransition = { direction: 'in', elapsed: 0, duration: C.frenzy.transitionIn, reason: 'start' };
    this.setState(BJ.State.FRENZY_TRANSITION_IN);
    this.audio.play('frenzy_transform');
    this.addShake(10);
    const labels = {
      invaders: 'SPACE INVADERS FRENZY!', fps: 'FPS FRENZY: DOWN THE BARREL!',
      pinball: 'PINBALL FRENZY!', asteroids: 'ASTEROIDS FRENZY!',
      missile: 'MISSILE COMMAND FRENZY!', revenge: 'ARKANOID REVENGE!',
      tenpin: '10-PIN FRENZY!', bomber: 'BOMBER FRENZY!'
    };
    this.showMessage(labels[mode], 2.3);
    this.autosave('frenzy_start');
    return true;
  };

  Game.prototype.setupFrenzyMode = function (mode, participants) {
    if (mode === 'invaders') {
      const cols = Math.min(10, Math.max(4, Math.ceil(Math.sqrt(participants.length * 1.6))));
      const spacingX = 74, spacingY = 42, totalW = (cols - 1) * spacingX;
      const startX = (C.playfield.width - totalW) / 2;
      participants.forEach(function (brick, index) {
        const col = index % cols, row = Math.floor(index / cols);
        brick.frenzyMeta.transitionEnd = { x: startX + col * spacingX - 28, y: 88 + row * spacingY, w: 56, h: 26 };
      });
      const centre = this.paddle.x + this.paddle.w / 2;
      this.paddle.ship = true; this.paddle.hidden = false;
      this.paddle.w = C.frenzy.shipWidth; this.paddle.h = C.frenzy.shipHeight;
      this.paddle.x = U.clamp(centre - this.paddle.w / 2, 0, C.playfield.width - this.paddle.w);
      return;
    }

    if (mode === 'fps') {
      this.paddle.ship = false; this.paddle.hidden = true;
      this.frenzyGame = { type: 'fps', attacks: [], attackCooldown: 0.9 };
      participants.forEach((function (brick) {
        const depthRng = BJ.Levels.campaignRng(this.seed, this.difficulty, this.level, 'fps-depth|' + brick.id);
        brick.frenzyMeta.depth = U.lerp(C.frenzy.fps.depthMin, C.frenzy.fps.depthMax, depthRng());
        brick.frenzyMeta.lateralOffset = (depthRng() - 0.5) * 14;
        brick.frenzyMeta.attack = null;
      }).bind(this));
      this.projectFpsBricks();
      participants.forEach(function (brick) {
        brick.frenzyMeta.transitionEnd = U.deepClone(brick.frenzyMeta.projected);
        brick.frenzyMeta.visual = U.deepClone(brick.frenzyMeta.transitionStart);
      });
      return;
    }

    this.paddle.ship = false;
    this.paddle.hidden = true;

    if (mode === 'pinball') {
      this.frenzyGame = {
        type: 'pinball',
        ball: { x: C.playfield.width / 2, y: 530, r: C.frenzy.pinball.ballRadius, vx: 185, vy: -330, spin: 0 },
        leftFlipper: Object.assign({ side: 'left', active: false }, C.frenzy.pinball.flippers.left),
        rightFlipper: Object.assign({ side: 'right', active: false }, C.frenzy.pinball.flippers.right),
        nudgeCooldown: 0,
        committedDrain: null
      };
      participants.forEach(function (brick, index) {
        const lift = 8 + (index % 3) * 4;
        brick.frenzyMeta.transitionEnd = { x: brick.x, y: brick.y + lift, w: brick.w, h: brick.h };
      });
      return;
    }

    if (mode === 'asteroids') {
      this.frenzyGame = {
        type: 'asteroids',
        ship: { x: C.playfield.width / 2, y: 585, vx: 0, vy: 0, angle: -Math.PI / 2, radius: C.frenzy.asteroids.shipRadius },
        shots: [], fireCooldown: 0
      };
      participants.forEach((function (brick) {
        const r = BJ.Levels.campaignRng(this.seed, this.difficulty, this.level, 'asteroid|' + brick.id);
        const angle = r() * Math.PI * 2;
        const speed = U.lerp(C.frenzy.asteroids.asteroidSpeedMin, C.frenzy.asteroids.asteroidSpeedMax, r());
        brick.frenzyMeta.vx = Math.cos(angle) * speed;
        brick.frenzyMeta.vy = Math.sin(angle) * speed;
        brick.frenzyMeta.angle = r() * Math.PI * 2;
        brick.frenzyMeta.rotationSpeed = (r() - 0.5) * 1.8;
        brick.frenzyMeta.transitionEnd = {
          x: U.clamp(brick.x + (r() - 0.5) * 90, 30, C.playfield.width - brick.w - 30),
          y: U.clamp(brick.y + (r() - 0.5) * 90 + 80, 90, 570), w: brick.w, h: brick.h
        };
      }).bind(this));
      return;
    }

    if (mode === 'missile') {
      this.frenzyGame = {
        type: 'missile', aim: { x: C.playfield.width / 2, y: 330 },
        blasts: [], missiles: [], fireCooldown: 0, batteryCooldown: 0.5,
        bases: [250, 480, 710].map(function (x, index) { return { index: index, x: x, y: C.frenzy.missile.baseY, alive: true }; })
      };
      participants.forEach(function (brick, index) {
        const scale = 0.88;
        brick.frenzyMeta.transitionEnd = {
          x: C.playfield.width / 2 + (brick.x + brick.w / 2 - C.playfield.width / 2) * scale - brick.w / 2,
          y: 100 + (brick.y - C.level.top) * 0.82 + (index % 2) * 4, w: brick.w, h: brick.h
        };
      });
      return;
    }

    if (mode === 'revenge') {
      const cfg = C.frenzy.revenge;
      this.frenzyGame = {
        type: 'revenge',
        player: { x: (C.playfield.width - cfg.playerWidth) / 2, y: cfg.playerY, w: cfg.playerWidth, h: cfg.playerHeight, vx: 0 },
        ball: { x: C.playfield.width / 2, y: C.playfield.height / 2, r: 8, vx: cfg.ballSpeed * 0.45, vy: cfg.ballSpeed * 0.89, spin: 0 },
        relaunch: 0
      };
      const gap = 3;
      const available = C.playfield.width - 120;
      const segW = Math.max(12, (available - gap * (participants.length - 1)) / participants.length);
      const startX = (C.playfield.width - (segW * participants.length + gap * (participants.length - 1))) / 2;
      participants.forEach(function (brick, index) {
        brick.frenzyMeta.transitionEnd = { x: startX + index * (segW + gap), y: cfg.enemyY, w: segW, h: 22 };
      });
      return;
    }

    if (mode === 'tenpin') {
      const cfg = C.frenzy.tenpin;
      const required = participants.filter(function (b) { return b.type !== 'indestructible'; });
      const indestructible = participants.filter(function (b) { return b.type === 'indestructible'; });
      const active = required.concat(indestructible).slice(0, 10);
      const pinLayout = [
        [0,0.78],[-0.34,0.84],[0.34,0.84],[-0.68,0.90],[0,0.90],[0.68,0.90],
        [-1.02,0.97],[-0.34,0.97],[0.34,0.97],[1.02,0.97]
      ];
      this.frenzyGame = { type: 'tenpin', activeIds: active.map(function (b) { return b.id; }), attemptsUsed: 0,
        maxAttempts: U.clamp(Math.round(cfg.attempts), 2, 3), ball: null, aim: 0, power: 0, charging: false,
        wasActionDown: false, resetDelay: 0, bowlStartAlive: active.length, result: '' };
      participants.forEach((function (brick) {
        const index = active.indexOf(brick);
        brick.frenzyMeta.activePin = index >= 0;
        if (index < 0) return;
        const pos = pinLayout[index];
        brick.frenzyMeta.pinX = pos[0]; brick.frenzyMeta.pinZ = pos[1]; brick.frenzyMeta.pinFallen = false;
        const projected = this.projectTenPinPoint(pos[0], pos[1]);
        brick.frenzyMeta.transitionEnd = { x: projected.x - 14, y: projected.y - 32, w: 28, h: 58 };
      }).bind(this));
      return;
    }

    if (mode === 'bomber') {
      const cfg = C.frenzy.bomber;
      this.frenzyGame = { type: 'bomber', player: { x: C.playfield.width / 2 - cfg.playerWidth / 2, y: 590,
        w: cfg.playerWidth, h: cfg.playerHeight, vx: 0, vy: 0 }, shots: [], enemyShots: [], fireCooldown: 0, enemyFireCooldown: 0.6 };
      participants.forEach((function (brick, index) {
        const r = BJ.Levels.campaignRng(this.seed, this.difficulty, this.level, 'bomber|' + brick.id);
        brick.frenzyMeta.aircraftType = (brick.type === 'moving' || brick.type === 'multi_hit' || r() > 0.58) ? 'fighter' : 'biplane';
        brick.frenzyMeta.baseX = 70 + (index % 8) * 112;
        brick.frenzyMeta.baseY = 100 + Math.floor(index / 8) * 58;
        brick.frenzyMeta.phase = r() * Math.PI * 2;
        brick.frenzyMeta.transitionEnd = { x: brick.frenzyMeta.baseX, y: brick.frenzyMeta.baseY, w: 56, h: 32 };
      }).bind(this));
      return;
    }
  };

  Game.prototype.updateFrenzyState = function (dt) {
    if (this.state === BJ.State.FRENZY_TRANSITION_IN || this.state === BJ.State.FRENZY_TRANSITION_OUT) {
      if (!this.frenzyTransition) return;
      this.frenzyTransition.elapsed += dt;
      const duration = this.frenzyTransition.duration || 0.01;
      const p = U.clamp(this.frenzyTransition.elapsed / duration, 0, 1);
      const e = U.easeInOut(p);

      if (this.frenzyMode === 'fps') {
        if (this.state === BJ.State.FRENZY_TRANSITION_IN) this.projectFpsBricks();
        this.levelData.bricks.forEach(function (brick) {
          if (!brick.alive || !brick.frenzyOriginal || !brick.frenzyMeta) return;
          const from = brick.frenzyTransitionFrom || brick.frenzyMeta.transitionStart;
          const to = brick.frenzyTransitionTo || brick.frenzyMeta.transitionEnd || brick.frenzyOriginal;
          brick.frenzyMeta.visual = {
            x: U.lerp(from.x, to.x, e), y: U.lerp(from.y, to.y, e),
            w: U.lerp(from.w, to.w, e), h: U.lerp(from.h, to.h, e)
          };
          brick.frenzyMeta.morph = this.state === BJ.State.FRENZY_TRANSITION_IN ? e : 1 - e;
        }, this);
      } else {
        this.levelData.bricks.forEach(function (brick) {
          if (!brick.alive || !brick.frenzyOriginal) return;
          const from = brick.frenzyTransitionFrom || (brick.frenzyMeta && brick.frenzyMeta.transitionStart ? brick.frenzyMeta.transitionStart : brick.frenzyOriginal);
          const to = brick.frenzyTransitionTo || (brick.frenzyMeta && brick.frenzyMeta.transitionEnd ? brick.frenzyMeta.transitionEnd : brick.frenzyOriginal);
          brick.x = U.lerp(from.x, to.x, e); brick.y = U.lerp(from.y, to.y, e);
          brick.w = U.lerp(from.w, to.w, e); brick.h = U.lerp(from.h, to.h, e);
          if (brick.frenzyMeta) brick.frenzyMeta.morph = this.state === BJ.State.FRENZY_TRANSITION_IN ? e : 1 - e;
        }, this);
      }

      this.addShake(0.8);
      if (p < 1) return;
      if (this.state === BJ.State.FRENZY_TRANSITION_IN) {
        if (this.frenzyMode === 'fps') {
          this.projectFpsBricks();
          this.levelData.bricks.forEach(function (brick) { if (brick.frenzyMeta) { brick.frenzyMeta.visual = U.deepClone(brick.frenzyMeta.projected); brick.frenzyMeta.morph = 1; } });
        }
        this.frenzyTransition = { direction: 'active', elapsed: 0, duration: this.getFrenzyDuration(this.frenzyMode), reason: 'active' };
        this.setState(BJ.State.FRENZY_ACTIVE);
      } else {
        this.finishFrenzyRestore(this.frenzyTransition.reason || 'timeout');
      }
      return;
    }

    if (this.state !== BJ.State.FRENZY_ACTIVE) return;
    this.frenzyRemaining -= dt;
    if (this.frenzyMode === 'fps') this.updateFpsFrenzy(dt);
    else if (this.frenzyMode === 'invaders') this.updateInvadersFrenzy(dt);
    else if (this.frenzyMode === 'pinball') this.updatePinballFrenzy(dt);
    else if (this.frenzyMode === 'asteroids') this.updateAsteroidsFrenzy(dt);
    else if (this.frenzyMode === 'missile') this.updateMissileFrenzy(dt);
    else if (this.frenzyMode === 'revenge') this.updateRevengeFrenzy(dt);
    else if (this.frenzyMode === 'tenpin') this.updateTenPinFrenzy(dt);
    else if (this.frenzyMode === 'bomber') this.updateBomberFrenzy(dt);
    if (this.frenzyRemaining <= 0 && this.state === BJ.State.FRENZY_ACTIVE) this.beginFrenzyExit('timeout');
  };

  Game.prototype.updateInvadersFrenzy = function (dt) {
    const invaders = this.levelData.bricks.filter(function (b) { return b.alive; });
    if (!invaders.length) { this.score += C.scoring.frenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); return; }
    let minX = Infinity, maxX = -Infinity;
    invaders.forEach(function (b) { minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.w); });
    const speedBoost = 1 + (1 - invaders.length / Math.max(1, this.frenzyInitialCount)) * 1.35;
    const dx = this.frenzyFormationDirection * C.frenzy.invaders.formationSpeed * speedBoost * dt;
    const edge = (this.frenzyFormationDirection < 0 && minX + dx < 18) || (this.frenzyFormationDirection > 0 && maxX + dx > C.playfield.width - 18);
    if (edge) { this.frenzyFormationDirection *= -1; invaders.forEach(function (b) { b.y += C.frenzy.invaders.formationDrop; }); }
    else invaders.forEach(function (b) { b.x += dx; });
    this.updateFrenzyRegeneration(dt);
    this.updatePlayerShots(dt);
    this.frenzyFireTimer -= dt;
    if (this.frenzyFireTimer <= 0) {
      this.fireInvaderShot(invaders);
      const ratio = invaders.length / Math.max(1, this.frenzyInitialCount);
      this.frenzyFireTimer = U.lerp(0.34, 1.18, ratio) * (this.difficulty === 'hard' ? 0.8 : this.difficulty === 'easy' ? 1.18 : 1);
    }
  };

  Game.prototype.updateFpsPlayer = function (dt) {
    const cfg = C.frenzy.fps;
    if (this.attract) {
      const targetCamera = Math.sin(this.elapsed * 0.8) * cfg.cameraLimit * 0.55;
      this.fpsCamera.x = U.lerp(this.fpsCamera.x, targetCamera, Math.min(1, dt * 2.5));
      this.fpsCamera.vx = 0;
    } else if (this.input && this.input.isCodeDown) {
      const strafe = (this.input.isCodeDown('ArrowRight') ? 1 : 0) - (this.input.isCodeDown('ArrowLeft') ? 1 : 0);
      if (strafe !== 0) {
        this.fpsCamera.vx += strafe * cfg.strafeAcceleration * dt;
        this.fpsCamera.vx = U.clamp(this.fpsCamera.vx, -cfg.strafeMaxSpeed, cfg.strafeMaxSpeed);
      } else {
        const amount = cfg.strafeDeceleration * dt;
        if (Math.abs(this.fpsCamera.vx) <= amount) this.fpsCamera.vx = 0;
        else this.fpsCamera.vx -= Math.sign(this.fpsCamera.vx) * amount;
      }
      this.fpsCamera.x += this.fpsCamera.vx * dt;
      if (this.fpsCamera.x < -cfg.cameraLimit || this.fpsCamera.x > cfg.cameraLimit) {
        this.fpsCamera.x = U.clamp(this.fpsCamera.x, -cfg.cameraLimit, cfg.cameraLimit);
        this.fpsCamera.vx = 0;
      }
    }

    const pointer = this.input && this.input.getPointer ? this.input.getPointer() : null;
    if (pointer && pointer.inside) {
      this.fpsAim.x = U.lerp(this.fpsAim.x, pointer.x, Math.min(1, dt * 18));
      this.fpsAim.y = U.lerp(this.fpsAim.y, pointer.y, Math.min(1, dt * 18));
    }
    if (!this.attract && this.input && this.input.isCodeDown) {
      if (this.input.isCodeDown('KeyA')) this.fpsAim.x -= cfg.crosshairSpeed * dt;
      if (this.input.isCodeDown('KeyD')) this.fpsAim.x += cfg.crosshairSpeed * dt;
      if (this.input.isCodeDown('KeyW')) this.fpsAim.y -= cfg.crosshairSpeed * dt;
      if (this.input.isCodeDown('KeyS')) this.fpsAim.y += cfg.crosshairSpeed * dt;
    }
    this.fpsAim.x = U.clamp(this.fpsAim.x, 24, C.playfield.width - 24);
    this.fpsAim.y = U.clamp(this.fpsAim.y, 72, C.playfield.height - 40);
  };

  Game.prototype.updateFpsFrenzy = function (dt) {
    this.levelData.bricks.forEach(function (brick) {
      if (!brick.alive || !brick.frenzyMeta || brick.type !== 'moving') return;
      const attack = brick.frenzyMeta.attack;
      if (attack && attack.phase !== 'telegraph') return;
      const limit = Math.max(18, brick.frenzyOriginal.w * 0.58);
      brick.frenzyMeta.planeOffsetX += brick.frenzyMeta.planeDirection * brick.moveSpeed * dt;
      if (brick.frenzyMeta.planeOffsetX < -limit || brick.frenzyMeta.planeOffsetX > limit) {
        brick.frenzyMeta.planeOffsetX = U.clamp(brick.frenzyMeta.planeOffsetX, -limit, limit);
        brick.frenzyMeta.planeDirection *= -1;
      }
    });

    this.projectFpsBricks();
    this.updateFpsFallingAttacks(dt);
    this.updateFrenzyRegeneration(dt);

    if ((this.actionDown() || (this.input && this.input.isMouseDown && this.input.isMouseDown())) && this.fpsShootCooldown <= 0) this.firePlayerShot(true);

    const bricks = this.levelData.bricks.filter(function (brick) { return brick.alive; });
    if (!bricks.length) { this.score += C.scoring.fpsFrenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); return; }

    if (this.attract && this.fpsShootCooldown <= 0) {
      const target = this.getFpsRenderBricks().slice().reverse().find(function (brick) { return brick.alive; });
      if (target) {
        const rect = this.getFpsTargetRect(target);
        if (rect) {
          this.fpsAim.x = rect.x + rect.w / 2;
          this.fpsAim.y = rect.y + rect.h / 2;
          this.firePlayerShot(true);
        }
      }
    }

    const g = this.frenzyGame;
    if (g && g.type === 'fps') {
      g.attackCooldown -= dt;
      const activeCount = g.attacks.filter(function (a) { return a && a.brick && a.brick.alive; }).length;
      const maxSim = C.frenzy.fps.falling.maxSimultaneous[this.difficulty] || C.frenzy.fps.falling.maxSimultaneous.normal;
      if (g.attackCooldown <= 0 && activeCount < maxSim) {
        this.spawnFpsFallingAttack();
        const ratio = bricks.length / Math.max(1, this.frenzyInitialCount);
        g.attackCooldown = Math.max(C.frenzy.fps.falling.minimumInterval,
          C.frenzy.fps.falling.baseInterval * U.lerp(0.45, 1.15, ratio) * (this.difficulty === 'hard' ? 0.86 : this.difficulty === 'easy' ? 1.16 : 1));
      }
    }
  };

  Game.prototype.getFpsPlayerWorldX = function () {
    return C.playfield.width / 2 + this.fpsCamera.x;
  };

  Game.prototype.getFpsFallingScreenX = function (worldX) {
    return C.playfield.width / 2 + (worldX - C.playfield.width / 2) - this.fpsCamera.x * C.frenzy.fps.falling.screenParallax;
  };

  Game.prototype.getFpsTargetRect = function (brick) {
    if (!brick || !brick.frenzyMeta) return null;
    const attack = brick.frenzyMeta.attack;
    if (attack && (attack.phase === 'fall' || attack.phase === 'recover') && attack.projected) return attack.projected;
    return brick.frenzyMeta.projected || brick.frenzyMeta.visual || null;
  };

  Game.prototype.spawnFpsFallingAttack = function () {
    const g = this.frenzyGame;
    if (!g || g.type !== 'fps') return null;
    let candidates = this.levelData.bricks.filter(function (brick) {
      return brick.alive && brick.frenzyMeta && !brick.frenzyMeta.attack;
    });
    if (!candidates.length) return null;
    candidates = candidates.sort(function (a, b) {
      return Math.abs(a.frenzyMeta.depth - 0.95) - Math.abs(b.frenzyMeta.depth - 0.95) || a.id - b.id;
    });
    const preferred = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.72)));
    const brick = preferred[Math.floor(this.rng() * preferred.length)];
    const attack = {
      brick: brick,
      phase: 'telegraph',
      elapsed: 0,
      worldX: this.getFpsPlayerWorldX(),
      screenY: C.frenzy.fps.falling.startY,
      vy: C.frenzy.fps.falling.fallSpeed,
      projected: null,
      recoveryFrom: null
    };
    brick.frenzyMeta.attack = attack;
    g.attacks.push(attack);
    return attack;
  };

  Game.prototype.updateFpsFallingAttacks = function (dt) {
    const g = this.frenzyGame;
    if (!g || g.type !== 'fps') return;
    const cfg = C.frenzy.fps.falling;

    for (let i = g.attacks.length - 1; i >= 0; i -= 1) {
      const attack = g.attacks[i];
      const brick = attack && attack.brick;
      if (!brick || !brick.alive || !brick.frenzyMeta) {
        if (brick && brick.frenzyMeta) brick.frenzyMeta.attack = null;
        g.attacks.splice(i, 1);
        continue;
      }

      attack.elapsed += dt;
      if (attack.phase === 'telegraph') {
        if (attack.elapsed >= cfg.telegraphSeconds) {
          attack.phase = 'fall';
          attack.elapsed = 0;
          attack.screenY = cfg.startY;
          attack.vy = cfg.fallSpeed;
        }
        continue;
      }

      if (attack.phase === 'fall') {
        attack.screenY += attack.vy * dt;
        attack.vy += cfg.gravity * dt;
        const progress = U.clamp((attack.screenY - cfg.startY) / Math.max(1, cfg.impactY - cfg.startY), 0, 1);
        const scale = U.lerp(0.78, 1.55, progress);
        const w = brick.frenzyOriginal.w * scale;
        const h = brick.frenzyOriginal.h * scale;
        const x = this.getFpsFallingScreenX(attack.worldX) - w / 2;
        attack.projected = { x: x, y: attack.screenY - h / 2, w: w, h: h, scale: scale };

        if (attack.screenY >= cfg.impactY) {
          const playerX = this.getFpsPlayerWorldX();
          const half = cfg.playerLaneHalfWidth + Math.min(30, brick.frenzyOriginal.w * 0.28);
          if (!this.debugInvulnerable && Math.abs(playerX - attack.worldX) <= half) {
            this.addShake(10);
            this.beginFrenzyExit('hit');
            return;
          }
          attack.phase = 'recover';
          attack.elapsed = 0;
          attack.recoveryFrom = U.deepClone(attack.projected);
        }
        continue;
      }

      if (attack.phase === 'recover') {
        const base = brick.frenzyMeta.projected;
        if (!base) continue;
        const p = U.easeInOut(U.clamp(attack.elapsed / Math.max(0.01, cfg.recoverySeconds), 0, 1));
        const from = attack.recoveryFrom || base;
        attack.projected = {
          x: U.lerp(from.x, base.x, p), y: U.lerp(from.y, base.y, p),
          w: U.lerp(from.w, base.w, p), h: U.lerp(from.h, base.h, p), scale: U.lerp(from.scale || 1, base.scale || 1, p)
        };
        if (p >= 1) {
          brick.frenzyMeta.attack = null;
          g.attacks.splice(i, 1);
        }
      }
    }
  };

  Game.prototype.projectFpsBricks = function () {
    const cfg = C.frenzy.fps;
    const cx = C.playfield.width / 2;
    const horizon = 230;
    this.levelData.bricks.forEach((function (brick) {
      if (!brick.alive || !brick.frenzyMeta || !brick.frenzyOriginal) return;
      const depth = brick.frenzyMeta.depth;
      const t = U.clamp((depth - cfg.depthMin) / Math.max(0.001, cfg.depthMax - cfg.depthMin), 0, 1);
      const scale = U.lerp(cfg.nearScale, cfg.farScale, t);
      const original = brick.frenzyOriginal;
      const worldCx = original.x + original.w / 2 + brick.frenzyMeta.planeOffsetX + brick.frenzyMeta.lateralOffset;
      const worldCy = original.y + original.h / 2;
      const parallax = this.fpsCamera.x * cfg.parallaxStrength * U.lerp(1.15, 0.28, t);
      const projectedCx = cx + (worldCx - cx) * scale - parallax;
      const projectedCy = horizon + (worldCy - horizon) * scale;
      const w = original.w * scale;
      const h = original.h * scale;
      brick.frenzyMeta.projected = { x: projectedCx - w / 2, y: projectedCy - h / 2, w: w, h: h, scale: scale };
      if (this.state === BJ.State.FRENZY_ACTIVE && !(brick.frenzyMeta.attack && brick.frenzyMeta.attack.phase !== 'telegraph')) {
        brick.frenzyMeta.visual = U.deepClone(brick.frenzyMeta.projected); brick.frenzyMeta.morph = 1;
      }
    }).bind(this));
    this.ensureFpsTargetVisibility();
  };

  Game.prototype.ensureFpsTargetVisibility = function () {
    const nearToFar = this.levelData.bricks.filter(function (brick) {
      return brick.alive && brick.frenzyMeta && brick.frenzyMeta.projected && !(brick.frenzyMeta.attack && brick.frenzyMeta.attack.phase !== 'telegraph');
    }).sort(function (a, b) { return a.frenzyMeta.depth - b.frenzyMeta.depth; });

    function coveredRatio(a, b) {
      const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
      if (x2 <= x1 || y2 <= y1) return 0;
      return ((x2 - x1) * (y2 - y1)) / Math.max(1, a.w * a.h);
    }

    for (let i = nearToFar.length - 1; i >= 0; i -= 1) {
      const farther = nearToFar[i];
      if (farther.type === 'indestructible') continue;
      for (let j = 0; j < i; j += 1) {
        const closer = nearToFar[j];
        if (coveredRatio(farther.frenzyMeta.projected, closer.frenzyMeta.projected) > 0.92) {
          const nudge = farther.id % 2 ? 16 : -16;
          farther.frenzyMeta.projected.x = U.clamp(farther.frenzyMeta.projected.x + nudge, 8, C.playfield.width - farther.frenzyMeta.projected.w - 8);
          break;
        }
      }
    }
  };

  Game.prototype.getFpsRenderBricks = function () {
    return this.levelData.bricks.filter(function (brick) {
      return brick.alive && brick.frenzyMeta && (brick.frenzyMeta.visual || brick.frenzyMeta.projected || (brick.frenzyMeta.attack && brick.frenzyMeta.attack.projected));
    }).sort(function (a, b) {
      const aa = a.frenzyMeta.attack, ba = b.frenzyMeta.attack;
      const ad = aa && (aa.phase === 'fall' || aa.phase === 'recover') ? -1 : a.frenzyMeta.depth;
      const bd = ba && (ba.phase === 'fall' || ba.phase === 'recover') ? -1 : b.frenzyMeta.depth;
      return bd - ad;
    });
  };

  Game.prototype.updatePinballInput = function (dt) {
    const g = this.frenzyGame;
    if (!g || g.type !== 'pinball') return;
    g.nudgeCooldown = Math.max(0, g.nudgeCooldown - dt);
    const left = this.attract ? Math.sin(this.elapsed * 3.4) > 0.55 : !!(this.input && this.input.isCodeDown && (this.input.isCodeDown('ArrowLeft') || this.input.isCodeDown('KeyA')));
    const right = this.attract ? Math.cos(this.elapsed * 3.0) > 0.55 : !!(this.input && this.input.isCodeDown && (this.input.isCodeDown('ArrowRight') || this.input.isCodeDown('KeyD')));
    const both = this.actionDown();
    const desired = [left || both, right || both];
    [g.leftFlipper, g.rightFlipper].forEach(function (f, index) {
      const nextActive = desired[index];
      f.powerWindow = Math.max(0, (f.powerWindow || 0) - dt);
      if (nextActive && !f.active) {
        f.powerWindow = C.frenzy.pinball.flipperPower.swingWindowSeconds;
        f.powerSpent = false;
      } else if (!nextActive) {
        f.powerWindow = 0;
        f.powerSpent = false;
      }
      f.active = nextActive;
    });
    const nudge = this.attract ? false : !!(this.input && this.input.isCodeDown && this.input.isCodeDown('ArrowUp'));
    if (nudge && g.nudgeCooldown <= 0 && g.ball) {
      g.ball.vy -= C.frenzy.pinball.nudgeImpulse;
      g.ball.vx += (this.rng() - 0.5) * C.frenzy.pinball.nudgeImpulse * 0.6;
      g.nudgeCooldown = C.frenzy.pinball.nudgeCooldown;
      this.addShake(2);
    }
  };

  Game.prototype.getPinballFlipperSegment = function (flipper) {
    const angleDeg = flipper.active ? flipper.activeAngle : flipper.restAngle;
    const angle = angleDeg * Math.PI / 180;
    return {
      ax: flipper.pivotX,
      ay: flipper.pivotY,
      bx: flipper.pivotX + Math.cos(angle) * flipper.length,
      by: flipper.pivotY + Math.sin(angle) * flipper.length
    };
  };

  Game.prototype.getPinballOutlaneBounds = function (side) {
    const cfg = C.frenzy.pinball;
    const lane = cfg.outlanes[side];
    const half = Math.max(1, cfg.outlaneWidth || (lane.maxX - lane.minX)) / 2;
    const centre = Number.isFinite(lane.centreX) ? lane.centreX : (lane.minX + lane.maxX) / 2;
    return { minX: centre - half, maxX: centre + half, entryY: lane.entryY, centreX: centre };
  };

  Game.prototype.getPinballApronSegments = function () {
    const cfg = C.frenzy.pinball;
    const left = this.getPinballOutlaneBounds('left');
    const right = this.getPinballOutlaneBounds('right');
    const lf = cfg.flippers.left;
    const rf = cfg.flippers.right;
    return [
      // Outer shoulders leave only the visible outlane mouths open.
      { ax: cfg.playfieldLeft, ay: left.entryY, bx: left.minX, by: left.entryY, kind: 'funnelRail', name: 'left-shoulder' },
      { ax: left.maxX, ay: left.entryY, bx: cfg.funnelGuides.left.ax, by: cfg.funnelGuides.left.ay, kind: 'funnelRail', name: 'left-funnel-join' },
      { ax: cfg.funnelGuides.left.ax, ay: cfg.funnelGuides.left.ay, bx: cfg.funnelGuides.left.bx, by: cfg.funnelGuides.left.by, kind: 'funnelRail', name: 'left-funnel' },
      { ax: cfg.funnelGuides.left.bx, ay: cfg.funnelGuides.left.by, bx: lf.pivotX, by: lf.pivotY, kind: 'funnelRail', name: 'left-apron-join' },
      { ax: lf.pivotX, ay: lf.pivotY, bx: cfg.centralDrain.minX, by: cfg.drainY, kind: 'funnelRail', name: 'left-central-apron' },

      { ax: cfg.playfieldRight, ay: right.entryY, bx: right.maxX, by: right.entryY, kind: 'funnelRail', name: 'right-shoulder' },
      { ax: right.minX, ay: right.entryY, bx: cfg.funnelGuides.right.ax, by: cfg.funnelGuides.right.ay, kind: 'funnelRail', name: 'right-funnel-join' },
      { ax: cfg.funnelGuides.right.ax, ay: cfg.funnelGuides.right.ay, bx: cfg.funnelGuides.right.bx, by: cfg.funnelGuides.right.by, kind: 'funnelRail', name: 'right-funnel' },
      { ax: cfg.funnelGuides.right.bx, ay: cfg.funnelGuides.right.by, bx: rf.pivotX, by: rf.pivotY, kind: 'funnelRail', name: 'right-apron-join' },
      { ax: rf.pivotX, ay: rf.pivotY, bx: cfg.centralDrain.maxX, by: cfg.drainY, kind: 'funnelRail', name: 'right-central-apron' },

      // Channel side walls make side-entry impossible after the visible mouth.
      { ax: left.minX, ay: left.entryY, bx: left.minX, by: cfg.drainY, kind: 'wall', thickness: 6, name: 'left-outlane-outer' },
      { ax: left.maxX, ay: left.entryY, bx: left.maxX, by: cfg.drainY, kind: 'wall', thickness: 6, name: 'left-outlane-inner' },
      { ax: right.minX, ay: right.entryY, bx: right.minX, by: cfg.drainY, kind: 'wall', thickness: 6, name: 'right-outlane-inner' },
      { ax: right.maxX, ay: right.entryY, bx: right.maxX, by: cfg.drainY, kind: 'wall', thickness: 6, name: 'right-outlane-outer' }
    ];
  };

  Game.prototype.getPinballRestitution = function (kind) {
    const r = BJ.Config.frenzy.pinball.restitution;
    const masterScale = (r.default || 0.82) / 0.82;
    const specific = Number.isFinite(r[kind]) ? r[kind] : r.default;
    return U.clamp(specific * masterScale, 0.35, 1.05);
  };

  Game.prototype.getPinballDrainRoute = function (ball) {
    const cfg = C.frenzy.pinball;
    const x = ball.x;
    const left = this.getPinballOutlaneBounds('left');
    const right = this.getPinballOutlaneBounds('right');
    if (x >= left.minX && x <= left.maxX && ball.y >= left.entryY) return 'left_outlane';
    if (x >= right.minX && x <= right.maxX && ball.y >= right.entryY) return 'right_outlane';
    if (x >= cfg.centralDrain.minX && x <= cfg.centralDrain.maxX && ball.y >= cfg.centralDrain.commitY) return 'central_gap';
    return null;
  };

  Game.prototype.resolvePinballLowerGeometry = function (ball) {
    const cfg = C.frenzy.pinball;
    const segments = this.getPinballApronSegments();
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (P.resolveBallSegment(ball, segment, segment.thickness || 12, 1.0)) {
        P.scaleVelocity(ball, this.getPinballRestitution(segment.kind || 'funnelRail'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed);
        P.retainSpin(ball, segment.kind === 'wall' ? 0.82 : 0.88);
        this.audio.play('paddle_hit');
      }
    }

    if (!this.frenzyGame.committedDrain) {
      this.frenzyGame.committedDrain = this.getPinballDrainRoute(ball);
    }

    // Once committed, only the channel walls remain relevant. The ball cannot
    // be rescued from an outlane or the centre drain by a flipper.
    if (this.frenzyGame.committedDrain) return;

    // Numerical safety net: the physical apron above should normally prevent
    // this from being reached. Outside a declared drain, the bottom is solid.
    if (ball.y + ball.r > cfg.drainY) {
      ball.y = cfg.drainY - ball.r;
      ball.vy = -Math.abs(ball.vy);
      P.scaleVelocity(ball, this.getPinballRestitution('wall'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed);
      P.retainSpin(ball, 0.82);
      this.audio.play('paddle_hit');
    }
  };

  Game.prototype.updatePinballFrenzy = function (dt) {
    const g = this.frenzyGame;
    if (!g || !g.ball) return;
    const cfg = C.frenzy.pinball;
    const ball = g.ball;
    ball.vy += cfg.gravity * dt;
    P.applySpin(ball, dt, C.spin);
    const prev = { x: ball.x, y: ball.y };
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.x - ball.r < cfg.playfieldLeft) { ball.x = cfg.playfieldLeft + ball.r; ball.vx = Math.abs(ball.vx); P.scaleVelocity(ball, this.getPinballRestitution('wall'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed); }
    if (ball.x + ball.r > cfg.playfieldRight) { ball.x = cfg.playfieldRight - ball.r; ball.vx = -Math.abs(ball.vx); P.scaleVelocity(ball, this.getPinballRestitution('wall'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed); }
    if (ball.y - ball.r < 66) { ball.y = 66 + ball.r; ball.vy = Math.abs(ball.vy); P.scaleVelocity(ball, this.getPinballRestitution('wall'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed); }

    this.resolvePinballLowerGeometry(ball);

    const flippers = [g.leftFlipper, g.rightFlipper];
    for (let i = 0; i < flippers.length; i += 1) {
      const f = flippers[i];
      const segment = this.getPinballFlipperSegment(f);
      const contact = P.circleSegment(ball, segment, f.thickness);
      if (!g.committedDrain && ball.vy > -180 && contact.hit && P.resolveBallSegment(ball, segment, f.thickness, 1.0)) {
        const speed = Math.max(1, P.length(ball.vx, ball.vy));
        const inward = f.side === 'left' ? 1 : -1;
        const tip = U.clamp(contact.point.t, 0, 1);
        P.scaleVelocity(ball, this.getPinballRestitution('flipper'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed);

        const poweredSwing = f.active && (f.powerWindow || 0) > 0 && !f.powerSpent;
        if (poweredSwing) {
          const power = cfg.flipperPower;
          const tipBonus = 1 + tip * (power.tipVelocityBonusMultiplier - 1);
          const minExit = cfg.flipperImpulse * power.minimumUpwardExitSpeedMultiplier;
          const maxExit = cfg.flipperImpulse * power.maximumUpwardExitSpeedMultiplier;
          const target = U.clamp(cfg.flipperImpulse * power.baseImpulseMultiplier * tipBonus, minExit, maxExit);
          const horizontalShare = 0.16 + tip * 0.22;
          ball.vx = inward * target * horizontalShare;
          ball.vy = -Math.sqrt(Math.max(1, target * target - ball.vx * ball.vx));
          ball.spin = U.clamp((ball.spin || 0) + inward * (0.32 + tip * 0.22), -C.spin.maxAbs, C.spin.maxAbs);
          f.powerSpent = true;
          f.powerWindow = 0;
        } else {
          // A static or already-spent flipper is still a solid surface, but it
          // cannot inject energy again merely because the key remains held.
          ball.vy = -Math.abs(ball.vy);
          ball.vx += inward * 28 * (0.35 + tip * 0.65);
          P.normalizeVelocity(ball, Math.max(cfg.restitution.minSpeed, P.length(ball.vx, ball.vy)));
          ball.spin = U.clamp((ball.spin || 0) + inward * 0.08, -C.spin.maxAbs, C.spin.maxAbs);
        }
        this.audio.play('paddle_hit');
      }
    }

    for (let i = 0; i < this.levelData.bricks.length; i += 1) {
      const brick = this.levelData.bricks[i];
      if (!brick.alive || !P.circleRect(ball, brick)) continue;
      P.resolveBallRect(ball, brick, prev);
      P.scaleVelocity(ball, this.getPinballRestitution(brick.type === 'explosive' ? 'bumper' : 'brickTarget'), cfg.restitution.minSpeed, cfg.restitution.maxSpeed);
      P.retainSpin(ball, C.spin.brickRetention);
      this.damageBrick(brick, 1, { source: 'pinball', frenzy: true });
      this.audio.play(brick.alive ? 'brick_hit' : 'brick_break');
      break;
    }
    this.updateFrenzyRegeneration(dt);
    if (g.committedDrain && ball.y - ball.r > cfg.drainY) { this.beginFrenzyExit('drain'); return; }
    if (!this.countAliveBricks()) { this.score += C.scoring.pinballFrenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); }
  };

  Game.prototype.updateAsteroidsInput = function (dt) {
    const g = this.frenzyGame;
    if (!g || g.type !== 'asteroids') return;
    const ship = g.ship, cfg = C.frenzy.asteroids;
    const left = this.attract ? Math.sin(this.elapsed * 1.1) < -0.2 : !!(this.input && this.input.isCodeDown && (this.input.isCodeDown('ArrowLeft') || this.input.isCodeDown('KeyA')));
    const right = this.attract ? Math.sin(this.elapsed * 1.1) > 0.2 : !!(this.input && this.input.isCodeDown && (this.input.isCodeDown('ArrowRight') || this.input.isCodeDown('KeyD')));
    const thrust = this.attract ? true : !!(this.input && this.input.isCodeDown && (this.input.isCodeDown('ArrowUp') || this.input.isCodeDown('KeyW')));
    ship.angle += ((right ? 1 : 0) - (left ? 1 : 0)) * cfg.rotateSpeed * dt;
    if (thrust) { ship.vx += Math.cos(ship.angle) * cfg.thrust * dt; ship.vy += Math.sin(ship.angle) * cfg.thrust * dt; }
    const speed = P.length(ship.vx, ship.vy);
    if (speed > cfg.maxShipSpeed) { ship.vx *= cfg.maxShipSpeed / speed; ship.vy *= cfg.maxShipSpeed / speed; }
    const drag = Math.max(0, 1 - cfg.drag * dt); ship.vx *= drag; ship.vy *= drag;
    if ((this.actionDown() || this.attract) && g.fireCooldown <= 0) {
      g.shots.push({ x: ship.x + Math.cos(ship.angle) * 18, y: ship.y + Math.sin(ship.angle) * 18, vx: Math.cos(ship.angle) * cfg.projectileSpeed, vy: Math.sin(ship.angle) * cfg.projectileSpeed, r: 3 });
      g.fireCooldown = 1 / cfg.fireRate; this.audio.play('laser');
    }
  };

  Game.prototype.updateAsteroidsFrenzy = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.asteroids;
    if (!g) return;
    g.fireCooldown = Math.max(0, g.fireCooldown - dt);
    const ship = g.ship;
    ship.x += ship.vx * dt; ship.y += ship.vy * dt;
    if (ship.x < 0) ship.x += C.playfield.width; if (ship.x > C.playfield.width) ship.x -= C.playfield.width;
    if (ship.y < 62) ship.y = C.playfield.height - 25; if (ship.y > C.playfield.height) ship.y = 70;

    this.levelData.bricks.forEach(function (brick) {
      if (!brick.alive || !brick.frenzyMeta) return;
      brick.x += brick.frenzyMeta.vx * dt; brick.y += brick.frenzyMeta.vy * dt;
      brick.frenzyMeta.angle += brick.frenzyMeta.rotationSpeed * dt;
      if (brick.x + brick.w < 0) brick.x = C.playfield.width; if (brick.x > C.playfield.width) brick.x = -brick.w;
      if (brick.y + brick.h < 58) brick.y = C.playfield.height; if (brick.y > C.playfield.height) brick.y = 60 - brick.h;
    });

    for (let i = g.shots.length - 1; i >= 0; i -= 1) {
      const shot = g.shots[i]; shot.x += shot.vx * dt; shot.y += shot.vy * dt;
      if (shot.x < -10 || shot.x > C.playfield.width + 10 || shot.y < 45 || shot.y > C.playfield.height + 10) { g.shots.splice(i, 1); continue; }
      const hit = this.levelData.bricks.find(function (brick) { return brick.alive && P.circleRect({ x: shot.x, y: shot.y, r: shot.r }, brick); });
      if (hit) { this.damageBrick(hit, 1, { source: 'asteroids-shot', frenzy: true }); this.spawnParticles(shot.x, shot.y, 6); g.shots.splice(i, 1); }
    }

    if (!this.debugInvulnerable) {
      const hitShip = this.levelData.bricks.find(function (brick) { return brick.alive && P.circleRect({ x: ship.x, y: ship.y, r: ship.radius }, brick); });
      if (hitShip) { this.beginFrenzyExit('collision'); return; }
    }
    this.updateFrenzyRegeneration(dt);
    if (!this.countAliveBricks()) { this.score += C.scoring.asteroidsFrenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); }
  };

  Game.prototype.updateMissileInput = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.missile;
    if (!g || g.type !== 'missile') return;
    g.fireCooldown = Math.max(0, g.fireCooldown - dt);
    const pointer = this.input && this.input.getPointer ? this.input.getPointer() : null;
    if (pointer && pointer.inside) { g.aim.x = U.lerp(g.aim.x, pointer.x, Math.min(1, dt * 18)); g.aim.y = U.lerp(g.aim.y, pointer.y, Math.min(1, dt * 18)); }
    if (!this.attract && this.input && this.input.isCodeDown) {
      if (this.input.isCodeDown('KeyA')) g.aim.x -= cfg.crosshairSpeed * dt;
      if (this.input.isCodeDown('KeyD')) g.aim.x += cfg.crosshairSpeed * dt;
      if (this.input.isCodeDown('KeyW')) g.aim.y -= cfg.crosshairSpeed * dt;
      if (this.input.isCodeDown('KeyS')) g.aim.y += cfg.crosshairSpeed * dt;
    }
    g.aim.x = U.clamp(g.aim.x, 20, C.playfield.width - 20); g.aim.y = U.clamp(g.aim.y, 75, cfg.baseY - 35);
    if ((this.actionDown() || (this.input && this.input.isMouseDown && this.input.isMouseDown()) || this.attract) && g.fireCooldown <= 0) {
      g.blasts.push({ x: g.aim.x, y: g.aim.y, life: cfg.blastLife, maxLife: cfg.blastLife, radius: 0, hitIds: Object.create(null) });
      g.fireCooldown = 1 / cfg.fireRate; this.audio.play('laser');
    }
  };

  Game.prototype.updateMissileFrenzy = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.missile;
    if (!g) return;
    g.batteryCooldown -= dt;
    const batteries = this.levelData.bricks.filter(function (brick) { return brick.alive; });
    if (g.batteryCooldown <= 0 && batteries.length) {
      const shooter = batteries[Math.floor(this.rng() * batteries.length)];
      const liveBases = g.bases.filter(function (b) { return b.alive; });
      if (liveBases.length) {
        const base = liveBases[Math.floor(this.rng() * liveBases.length)];
        const r = this.rng();
        g.missiles.push({ sx: shooter.x + shooter.w / 2, sy: shooter.y + shooter.h, x: shooter.x + shooter.w / 2, y: shooter.y + shooter.h, tx: base.x, ty: base.y, age: 0, travel: U.lerp(cfg.enemyMissileTravelMin, cfg.enemyMissileTravelMax, r), baseIndex: base.index, dead: false });
        this.audio.play('invader_fire');
      }
      const ratio = batteries.length / Math.max(1, this.frenzyInitialCount);
      g.batteryCooldown = cfg.batteryFireInterval * U.lerp(0.55, 1.25, ratio);
    }

    for (let i = g.missiles.length - 1; i >= 0; i -= 1) {
      const m = g.missiles[i]; m.age += dt; const t = U.clamp(m.age / m.travel, 0, 1);
      m.x = U.lerp(m.sx, m.tx, t); m.y = U.lerp(m.sy, m.ty, t);
      if (t >= 1) { g.missiles.splice(i, 1); if (!this.debugInvulnerable) { this.beginFrenzyExit('base_hit'); return; } }
    }

    for (let i = g.blasts.length - 1; i >= 0; i -= 1) {
      const blast = g.blasts[i]; blast.life -= dt;
      if (blast.life <= 0) { g.blasts.splice(i, 1); continue; }
      const progress = 1 - blast.life / blast.maxLife;
      blast.radius = Math.sin(Math.PI * progress) * cfg.blastMaxRadius;
      for (let j = g.missiles.length - 1; j >= 0; j -= 1) {
        const m = g.missiles[j]; const dx = m.x - blast.x, dy = m.y - blast.y;
        if (dx * dx + dy * dy <= blast.radius * blast.radius) { g.missiles.splice(j, 1); this.spawnParticles(m.x, m.y, 5); }
      }
      this.levelData.bricks.forEach((function (brick) {
        if (!brick.alive || blast.hitIds[brick.id]) return;
        const cx = brick.x + brick.w / 2, cy = brick.y + brick.h / 2, dx = cx - blast.x, dy = cy - blast.y;
        if (dx * dx + dy * dy <= blast.radius * blast.radius) { blast.hitIds[brick.id] = true; this.damageBrick(brick, 1, { source: 'missile-blast', frenzy: true }); }
      }).bind(this));
    }
    this.updateFrenzyRegeneration(dt);
    if (!this.countAliveBricks()) { this.score += C.scoring.missileFrenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); }
  };

  Game.prototype.updateRevengeInput = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.revenge;
    if (!g || g.type !== 'revenge') return;
    const player = g.player;
    let input = 0;
    if (this.attract) input = g.ball && g.ball.x < player.x + player.w / 2 ? -1 : 1;
    else if (this.input) input = ((this.input.isCodeDown && (this.input.isCodeDown('ArrowRight') || this.input.isCodeDown('KeyD'))) ? 1 : 0) - ((this.input.isCodeDown && (this.input.isCodeDown('ArrowLeft') || this.input.isCodeDown('KeyA'))) ? 1 : 0);
    player.vx += input * C.paddle.acceleration * dt;
    if (!input) player.vx *= Math.max(0, 1 - 9 * dt);
    player.vx = U.clamp(player.vx, -C.paddle.maxSpeed, C.paddle.maxSpeed);
    player.x = U.clamp(player.x + player.vx * dt, 0, C.playfield.width - player.w);
  };

  Game.prototype.updateRevengeFrenzy = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.revenge;
    if (!g) return;
    if (g.relaunch > 0) {
      g.relaunch -= dt;
      if (g.relaunch <= 0) g.ball = { x: C.playfield.width / 2, y: C.playfield.height / 2, r: 8, vx: cfg.ballSpeed * (this.rng() < 0.5 ? -0.42 : 0.42), vy: cfg.ballSpeed * 0.9, spin: 0 };
      return;
    }
    const ball = g.ball;
    if (!ball) return;
    P.applySpin(ball, dt, C.spin);
    const prev = { x: ball.x, y: ball.y };
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
    if (ball.x + ball.r > C.playfield.width) { ball.x = C.playfield.width - ball.r; ball.vx = -Math.abs(ball.vx); }

    const player = g.player;
    if (ball.vy < 0 && P.circleRect(ball, player)) {
      const relative = U.clamp((ball.x - (player.x + player.w / 2)) / (player.w / 2), -1, 1);
      const speed = Math.max(cfg.ballSpeed, P.length(ball.vx, ball.vy));
      ball.vx = Math.sin(relative * Math.PI * 0.38) * speed + player.vx * 0.1;
      ball.vy = Math.abs(Math.cos(relative * Math.PI * 0.38) * speed);
      ball.spin = U.clamp((player.vx / C.paddle.maxSpeed) * C.spin.paddleVelocityContribution + relative * C.spin.contactOffsetContribution, -1, 1);
      P.normalizeVelocity(ball, speed); ball.y = player.y + player.h + ball.r + 1; this.audio.play('paddle_hit');
    }

    const segments = this.levelData.bricks.filter(function (brick) { return brick.alive; });
    if (segments.length) {
      const enemyCentre = segments.reduce(function (sum, brick) { return sum + brick.x + brick.w / 2; }, 0) / segments.length;
      const error = ball.x - enemyCentre;
      const move = U.clamp(error * cfg.enemyTracking, -cfg.enemyMaxSpeed * dt, cfg.enemyMaxSpeed * dt);
      segments.forEach(function (brick) { brick.x = U.clamp(brick.x + move, 0, C.playfield.width - brick.w); });
    }

    if (ball.vy > 0) {
      const hit = segments.find(function (brick) { return P.circleRect(ball, brick); });
      if (hit) {
        this.damageBrick(hit, 1, { source: 'revenge-ball', frenzy: true });
        ball.vy = -Math.abs(ball.vy); ball.y = hit.y - ball.r - 1;
        ball.spin = U.clamp((ball.spin || 0) + ((hit.id % 3) - 1) * 0.08, -1, 1);
        this.audio.play(hit.alive ? 'brick_hit' : 'brick_break');
      }
    }
    if (ball.y + ball.r < 0) { this.beginFrenzyExit('miss'); return; }
    if (ball.y - ball.r > C.playfield.height) { g.ball = null; g.relaunch = cfg.relaunchDelay; }
    this.updateFrenzyRegeneration(dt);
    if (!this.countAliveBricks()) { this.score += C.scoring.revengeFrenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); }
  };

  Game.prototype.projectTenPinPoint = function (worldX, z) {
    const cfg = C.frenzy.tenpin;
    const zz = U.clamp(z, 0, 1.12);
    const perspective = U.lerp(1.18, 0.48, U.clamp(zz, 0, 1));
    return { x: C.playfield.width / 2 + worldX * 105 * perspective, y: U.lerp(cfg.laneNearY, cfg.laneFarY, U.clamp(zz, 0, 1)) };
  };

  Game.prototype.updateTenPinInput = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.tenpin;
    if (!g || g.type !== 'tenpin' || g.ball || g.resetDelay > 0) return;
    let aimInput = 0;
    if (this.attract) aimInput = Math.sin(this.elapsed * 1.6) > 0 ? 0.35 : -0.25;
    else if (this.input && this.input.isCodeDown) aimInput = ((this.input.isCodeDown('ArrowRight') || this.input.isCodeDown('KeyD')) ? 1 : 0) - ((this.input.isCodeDown('ArrowLeft') || this.input.isCodeDown('KeyA')) ? 1 : 0);
    g.aim = U.clamp(g.aim + aimInput * cfg.aimRate * dt, -cfg.maxAim, cfg.maxAim);
    const pointer = this.input && this.input.getPointer ? this.input.getPointer() : null;
    if (!this.attract && pointer && pointer.inside) g.aim = U.clamp((pointer.x - C.playfield.width / 2) / 330, -1, 1);
    const down = this.attract ? (this.stateElapsed % 2.2 < 1.0) : this.actionDown();
    if (down) { g.charging = true; g.power = U.clamp(g.power + dt * 0.85, 0.20, 1); }
    if (!down && g.wasActionDown && g.charging) this.launchTenPinBall();
    g.wasActionDown = down;
  };

  Game.prototype.launchTenPinBall = function () {
    const g = this.frenzyGame, cfg = C.frenzy.tenpin;
    if (!g || g.ball || g.attemptsUsed >= g.maxAttempts) return false;
    g.attemptsUsed += 1; g.bowlStartAlive = this.getTenPinActiveBricks().filter(function (b) { return b.alive; }).length;
    const power = U.clamp(g.power || 0.58, 0.20, 1);
    g.ball = { x: 0, z: 0, vx: g.aim * (0.34 + power * 0.18), speed: U.lerp(cfg.ballSpeedMin, cfg.ballSpeedMax, power), power: power,
      hook: -g.aim * cfg.maxHook * (0.35 + power * 0.65), hitIds: Object.create(null) };
    g.power = 0; g.charging = false;
    this.audio.play('bowling_roll'); return true;
  };

  Game.prototype.getTenPinActiveBricks = function () {
    return this.levelData.bricks.filter(function (b) { return b.frenzyMeta && b.frenzyMeta.activePin; });
  };

  Game.prototype.updateTenPinFrenzy = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.tenpin; if (!g) return;
    if (g.resetDelay > 0) { g.resetDelay -= dt; return; }
    const ball = g.ball; if (!ball) return;
    ball.z += ball.speed * dt; ball.vx += ball.hook * dt; ball.x += ball.vx * dt;
    const pins = this.getTenPinActiveBricks();
    for (let i = 0; i < pins.length; i += 1) {
      const brick = pins[i]; if (!brick.alive || ball.hitIds[brick.id]) continue;
      const m = brick.frenzyMeta; const dz = Math.abs(ball.z - m.pinZ); const reach = cfg.collisionRadius + ball.power * cfg.powerCollisionBonus;
      if (dz < 0.055 && Math.abs(ball.x - m.pinX) < reach) {
        ball.hitIds[brick.id] = true; this.damageBrick(brick, 1, { source: 'tenpin-ball', frenzy: true }); this.spawnParticles(brick.x + brick.w/2, brick.y + brick.h/2, 8);
        m.pinFallen = true; ball.vx += (ball.x - m.pinX) * 0.12; ball.speed *= 0.94;
        // Arcade pin-to-pin carry: sufficiently powerful direct contacts can topple immediate neighbours.
        if (ball.power > 0.55) pins.forEach((function (other) {
          if (!other.alive || other === brick || ball.hitIds[other.id]) return;
          const om = other.frenzyMeta; const d = Math.hypot(om.pinX - m.pinX, (om.pinZ - m.pinZ) * 5.0);
          if (d < 0.48 + ball.power * 0.22) { ball.hitIds[other.id] = true; om.pinFallen = true; this.damageBrick(other, 1, { source: 'tenpin-chain', frenzy: true }); }
        }).bind(this));
      }
    }
    if (ball.z >= 1.12 || Math.abs(ball.x) > 2.0) {
      const alive = pins.filter(function (b) { return b.alive; }).length; g.ball = null;
      if (alive === 0) {
        const first = g.attemptsUsed === 1; this.score += first ? C.scoring.tenPinStrikeBonus : C.scoring.tenPinSpareBonus;
        this.showMessage(first ? 'STRIKE!' : 'SPARE!', 1.8);
        if (this.countRequiredAliveBricks() === 0) { this.score += C.scoring.tenPinFrenzyClearBonus; this.finishFrenzyClear(); this.completeLevel(true); return; }
        this.beginFrenzyExit('pins_cleared'); return;
      }
      if (g.attemptsUsed >= g.maxAttempts) { this.beginFrenzyExit('attempts'); return; }
      g.resetDelay = cfg.resetDelay; g.power = 0; g.charging = false; g.wasActionDown = false;
      pins.forEach(function (b) { if (b.alive && b.frenzyMeta) b.frenzyMeta.pinFallen = false; });
    }
  };

  Game.prototype.updateBomberInput = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.bomber; if (!g || g.type !== 'bomber') return;
    const p = g.player; let ix = 0, iy = 0;
    if (this.attract) { ix = Math.sin(this.elapsed * 1.4); iy = Math.sin(this.elapsed * 0.9) * 0.35; }
    else if (this.input && this.input.isCodeDown) {
      ix = ((this.input.isCodeDown('ArrowRight') || this.input.isCodeDown('KeyD')) ? 1 : 0) - ((this.input.isCodeDown('ArrowLeft') || this.input.isCodeDown('KeyA')) ? 1 : 0);
      iy = ((this.input.isCodeDown('ArrowDown') || this.input.isCodeDown('KeyS')) ? 1 : 0) - ((this.input.isCodeDown('ArrowUp') || this.input.isCodeDown('KeyW')) ? 1 : 0);
    }
    p.vx += ix * cfg.playerAcceleration * dt; p.vy += iy * cfg.playerAcceleration * dt;
    if (!ix) p.vx *= Math.max(0, 1 - cfg.drag * dt); if (!iy) p.vy *= Math.max(0, 1 - cfg.drag * dt);
    p.vx = U.clamp(p.vx, -cfg.playerSpeed, cfg.playerSpeed); p.vy = U.clamp(p.vy, -cfg.playerSpeed, cfg.playerSpeed);
    p.x = U.clamp(p.x + p.vx * dt, 8, C.playfield.width - p.w - 8); p.y = U.clamp(p.y + p.vy * dt, C.playfield.height * 0.35, C.playfield.height - p.h - 18);
    g.fireCooldown = Math.max(0, g.fireCooldown - dt);
    if ((this.actionDown() || this.attract) && g.fireCooldown <= 0) { g.shots.push({ x:p.x+p.w/2, y:p.y-4, vy:-cfg.shotSpeed, r:3 }); g.fireCooldown=1/cfg.fireRate; this.audio.play('laser'); }
  };

  Game.prototype.updateBomberFrenzy = function (dt) {
    const g = this.frenzyGame, cfg = C.frenzy.bomber; if (!g) return;
    const alive = this.levelData.bricks.filter(function (b) { return b.alive; });
    alive.forEach((function (brick) { const m=brick.frenzyMeta; if(!m)return; m.phase += dt*(m.aircraftType==='fighter'?2.2:1.35); const amp=m.aircraftType==='fighter'?cfg.enemyDrift*1.35:cfg.enemyDrift; brick.x=U.clamp(m.baseX+Math.sin(m.phase)*amp,18,C.playfield.width-brick.w-18); brick.y=m.baseY+(m.aircraftType==='fighter'?Math.sin(m.phase*0.7)*22:Math.sin(m.phase*0.45)*10); }).bind(this));
    for (let i=g.shots.length-1;i>=0;i-=1){const sh=g.shots[i];sh.y+=sh.vy*dt;if(sh.y<45){g.shots.splice(i,1);continue;}const hit=alive.find(function(b){return b.alive && sh.x>=b.x&&sh.x<=b.x+b.w&&sh.y>=b.y&&sh.y<=b.y+b.h;});if(hit){this.damageBrick(hit,1,{source:'bomber-shot',frenzy:true});this.spawnParticles(sh.x,sh.y,6);g.shots.splice(i,1);}}
    g.enemyFireCooldown-=dt;
    if(g.enemyFireCooldown<=0&&alive.length){const shooter=alive[Math.floor(this.rng()*alive.length)];g.enemyShots.push({x:shooter.x+shooter.w/2,y:shooter.y+shooter.h,vx:(this.rng()-0.5)*55,vy:cfg.enemyShotSpeed,r:4});const ratio=alive.length/Math.max(1,this.frenzyInitialCount);g.enemyFireCooldown=cfg.enemyFireInterval*U.lerp(0.58,1.25,ratio);this.audio.play('invader_fire');}
    for(let i=g.enemyShots.length-1;i>=0;i-=1){const sh=g.enemyShots[i];sh.x+=sh.vx*dt;sh.y+=sh.vy*dt;if(sh.y>C.playfield.height+10){g.enemyShots.splice(i,1);continue;}const p=g.player;if(sh.x>=p.x&&sh.x<=p.x+p.w&&sh.y>=p.y&&sh.y<=p.y+p.h){g.enemyShots.splice(i,1);if(!this.debugInvulnerable){this.beginFrenzyExit('hit');return;}}}
    if(!this.debugInvulnerable){const p=g.player;const crash=alive.find(function(b){return P.rectRect(p,b);});if(crash){this.beginFrenzyExit('collision');return;}}
    this.updateFrenzyRegeneration(dt);
    if(!this.countAliveBricks()){this.score+=C.scoring.bomberFrenzyClearBonus;this.showMessage('AIR SUPERIORITY!',1.8);this.finishFrenzyClear();this.completeLevel(true);}
  };

  Game.prototype.drawTenPinEnvironment = function (ctx) {
    const cfg=C.frenzy.tenpin; ctx.save(); ctx.fillStyle='rgba(40,22,8,.72)';ctx.fillRect(0,54,C.playfield.width,C.playfield.height-54);
    const vx=C.playfield.width/2, hy=cfg.laneFarY; ctx.fillStyle='#c99b58';ctx.beginPath();ctx.moveTo(120,cfg.laneNearY);ctx.lineTo(vx-155,hy);ctx.lineTo(vx+155,hy);ctx.lineTo(C.playfield.width-120,cfg.laneNearY);ctx.closePath();ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.25)';ctx.lineWidth=2;[-1,-.5,0,.5,1].forEach(function(k){ctx.beginPath();ctx.moveTo(vx+k*330,cfg.laneNearY);ctx.lineTo(vx+k*125,hy);ctx.stroke();});
    for(let i=0;i<6;i++){const t=i/5;const y=U.lerp(cfg.laneNearY,hy,t*t);ctx.beginPath();ctx.moveTo(U.lerp(120,vx-155,t),y);ctx.lineTo(U.lerp(C.playfield.width-120,vx+155,t),y);ctx.stroke();}ctx.restore();
  };

  Game.prototype.drawTenPinBrick = function (ctx, brick) {
    const m=brick.frenzyMeta;if(!m||!m.activePin)return; const p=this.projectTenPinPoint(m.pinX,m.pinZ); const scale=U.lerp(C.frenzy.tenpin.pinScaleNear,C.frenzy.tenpin.pinScaleFar,m.pinZ); const lean=m.pinFallen?0.75:0;
    ctx.save();ctx.translate(p.x,p.y);ctx.rotate(lean);ctx.scale(scale,scale);ctx.fillStyle=brick.type==='indestructible'?'#c6d6e6':'#f7f1dd';ctx.strokeStyle='#ffffff';ctx.lineWidth=2;ctx.shadowBlur=10;ctx.shadowColor='#ffffff';
    ctx.beginPath();ctx.moveTo(-6,-31);ctx.bezierCurveTo(-15,-21,-14,-7,-20,12);ctx.bezierCurveTo(-22,28,-10,34,0,34);ctx.bezierCurveTo(10,34,22,28,20,12);ctx.bezierCurveTo(14,-7,15,-21,6,-31);ctx.closePath();ctx.fill();ctx.stroke();ctx.fillStyle='#d94b4b';ctx.fillRect(-11,-15,22,5);ctx.fillRect(-10,-8,20,4);ctx.restore();
  };

  Game.prototype.drawTenPinEntities = function (ctx) {
    const g=this.frenzyGame;if(!g)return;ctx.save();ctx.textAlign='center';ctx.font='bold 15px monospace';ctx.fillStyle='#ffe85f';ctx.fillText('BOWL '+Math.min(g.attemptsUsed+1,g.maxAttempts)+' / '+g.maxAttempts,480,92);
    if(!g.ball){const x=480+g.aim*250;ctx.fillStyle='rgba(255,232,95,.28)';ctx.fillRect(x-2,120,4,500);ctx.fillStyle='#d8d8df';ctx.beginPath();ctx.arc(480,622,24,0,Math.PI*2);ctx.fill();ctx.fillStyle='#111';ctx.beginPath();ctx.arc(472,612,3,0,Math.PI*2);ctx.arc(481,608,3,0,Math.PI*2);ctx.arc(487,616,3,0,Math.PI*2);ctx.fill();ctx.fillStyle='#7dff8a';ctx.fillRect(330,665,300*U.clamp(g.power,0,1),10);}
    else{const p=this.projectTenPinPoint(g.ball.x,g.ball.z);const sc=U.lerp(1.25,.45,U.clamp(g.ball.z,0,1));ctx.fillStyle='#d8d8df';ctx.shadowBlur=15;ctx.shadowColor='#fff';ctx.beginPath();ctx.arc(p.x,p.y,22*sc,0,Math.PI*2);ctx.fill();}
    ctx.restore();
  };

  Game.prototype.drawBomberEnvironment = function (ctx) {
    ctx.save();ctx.fillStyle='rgba(8,40,45,.52)';ctx.fillRect(0,54,C.playfield.width,C.playfield.height-54);ctx.strokeStyle='rgba(190,240,255,.13)';ctx.lineWidth=22;for(let i=0;i<7;i++){const y=((i*137+this.elapsed*80)%760)-20;ctx.beginPath();ctx.moveTo((i*181)%900,y);ctx.lineTo(((i*181)%900)+90,y+18);ctx.stroke();}ctx.restore();
  };

  Game.prototype.drawBomberBrick = function (ctx, brick) {
    const m=brick.frenzyMeta;if(!m)return;const fighter=m.aircraftType==='fighter';ctx.save();ctx.translate(brick.x+brick.w/2,brick.y+brick.h/2);ctx.fillStyle=BJ.Colour[brick.type]||'#ffcf72';ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.shadowBlur=9;ctx.shadowColor=ctx.fillStyle;
    ctx.beginPath();ctx.moveTo(0,-brick.h*.58);ctx.lineTo(fighter?9:6,-3);ctx.lineTo(brick.w*.48,6);ctx.lineTo(brick.w*.46,13);ctx.lineTo(8,9);ctx.lineTo(5,brick.h*.52);ctx.lineTo(-5,brick.h*.52);ctx.lineTo(-8,9);ctx.lineTo(-brick.w*.46,13);ctx.lineTo(-brick.w*.48,6);ctx.lineTo(fighter?-9:-6,-3);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();
  };

  Game.prototype.drawBomberEntities = function (ctx) {
    const g=this.frenzyGame;if(!g)return;const p=g.player;ctx.save();ctx.translate(p.x+p.w/2,p.y+p.h/2);ctx.fillStyle='#7dff8a';ctx.strokeStyle='#fff';ctx.shadowBlur=12;ctx.shadowColor='#7dff8a';ctx.beginPath();ctx.moveTo(0,-24);ctx.lineTo(9,-5);ctx.lineTo(25,6);ctx.lineTo(24,13);ctx.lineTo(7,9);ctx.lineTo(5,21);ctx.lineTo(-5,21);ctx.lineTo(-7,9);ctx.lineTo(-24,13);ctx.lineTo(-25,6);ctx.lineTo(-9,-5);ctx.closePath();ctx.fill();ctx.stroke();ctx.restore();
    ctx.save();ctx.fillStyle='#ffe85f';g.shots.forEach(function(sh){ctx.beginPath();ctx.arc(sh.x,sh.y,sh.r,0,Math.PI*2);ctx.fill();});ctx.fillStyle='#ff6573';g.enemyShots.forEach(function(sh){ctx.beginPath();ctx.arc(sh.x,sh.y,sh.r,0,Math.PI*2);ctx.fill();});ctx.restore();
  };

  Game.prototype.updateFrenzyRegeneration = function () {
    const self = this;
    this.levelData.bricks.forEach(function (brick) {
      if (brick.type !== 'regenerating') return;
      if (self.frenzyMode === 'fps' && brick.frenzyMeta && brick.frenzyMeta.attack && brick.frenzyMeta.attack.phase !== 'telegraph') return;
      if (brick.alive && brick.regenMode === 'heal' && brick.hits < brick.maxHits && self.levelElapsed - brick.lastHitAt >= 4) { brick.hits += 1; brick.lastHitAt = self.levelElapsed; }
      if (!brick.alive && brick.regenMode === 'respawn' && brick.frenzyOriginal && brick.destroyedAt != null && self.levelElapsed - brick.destroyedAt >= 6) { brick.alive = true; brick.hits = brick.maxHits; brick.destroyedAt = null; }
    });
  };

  Game.prototype.fireInvaderShot = function (invaders) {
    if (!invaders.length) return;
    const sorted = invaders.slice().sort(function (a, b) { return b.y - a.y; });
    const pool = sorted.slice(0, Math.min(sorted.length, 8));
    const shooter = pool[Math.floor(this.rng() * pool.length)];
    this.enemyShots.push({ x: shooter.x + shooter.w / 2 - 3, y: shooter.y + shooter.h, w: 6, h: 14, vy: C.frenzy.invaders.invaderShotSpeed, mode: 'invaders' });
    this.audio.play('invader_fire');
  };


  Game.prototype.updateEnemyShots = function (dt) {
    for (let i = this.enemyShots.length - 1; i >= 0; i -= 1) {
      const shot = this.enemyShots[i];
      shot.x += (shot.vx || 0) * dt;
      shot.y += shot.vy * dt;
      if (shot.y > C.playfield.height + 20) { this.enemyShots.splice(i, 1); continue; }
      if (this.paddle && P.rectRect(shot, this.paddle)) {
        this.enemyShots.splice(i, 1);
        if (this.debugInvulnerable) continue;
        if (this.state === BJ.State.FRENZY_ACTIVE) this.beginFrenzyExit('hit');
        else this.loseLife();
        break;
      }
    }
  };

  Game.prototype.beginFrenzyExit = function (reason) {
    if (this.state !== BJ.State.FRENZY_ACTIVE) return;
    this.playerShots = [];
    this.enemyShots = [];
    this.frenzyTransition = { direction: 'out', elapsed: 0, duration: C.frenzy.transitionOut, reason: reason || 'timeout' };
    this.levelData.bricks.forEach((function (brick) {
      if (!brick.alive || !brick.frenzyOriginal || !brick.frenzyMeta) return;
      if (this.frenzyMode === 'fps') {
        const attackRect = brick.frenzyMeta.attack && brick.frenzyMeta.attack.projected;
        brick.frenzyTransitionFrom = U.deepClone(attackRect || brick.frenzyMeta.projected || brick.frenzyMeta.visual || brick.frenzyOriginal);
      } else {
        brick.frenzyTransitionFrom = { x: brick.x, y: brick.y, w: brick.w, h: brick.h };
      }
      brick.frenzyTransitionTo = U.deepClone(brick.frenzyOriginal);
    }).bind(this));
    this.setState(BJ.State.FRENZY_TRANSITION_OUT);
    this.audio.play('frenzy_transform');
    this.addShake(8);
    if (reason === 'hit' || reason === 'drain' || reason === 'collision' || reason === 'base_hit' || reason === 'miss') {
      const messages = { fps: 'FPS FRENZY: TAKE COVER!', invaders: 'FRENZY CANCELLED. ALIENS: 1, YOU: 0.', pinball: 'PINBALL DRAINED.', asteroids: 'SHIP HIT. ASTEROIDS WIN THIS ROUND.', missile: 'BASE HIT. DEFENCE COLLAPSED.', revenge: 'REVENGE SERVED COLD.', tenpin: 'GUTTER BALL. PINS UNIMPRESSED.', bomber: 'BOMBER DOWN. BRICKS CLAIM AIRSPACE.' };
      this.showMessage(messages[this.frenzyMode] || 'FRENZY INTERRUPTED.', 1.8);
    } else if (reason === 'timeout') this.showMessage('FRENZY OVER. THE BRICKS HAVE LAWYERED UP.', 1.8);
  };

  Game.prototype.finishFrenzyClear = function () {
    this.playerShots = [];
    this.enemyShots = [];
    this.levelData.bricks.forEach(function (brick) {
      brick.frenzyOriginal = null;
      brick.frenzyMeta = null;
      brick.frenzyTransitionFrom = null;
      brick.frenzyTransitionTo = null;
    });
    if (this.paddle) { this.paddle.ship = false; this.paddle.hidden = false; }
    this.frenzySnapshot = null;
    this.frenzyTransition = null;
    this.frenzyMode = null;
    this.frenzyGame = null;
    this.fpsCamera = { x: 0, vx: 0 };
    this.canvas.style.cursor = '';
  };

  Game.prototype.finishFrenzyRestore = function (reason) {
    const surviving = this.levelData.bricks.filter(function (b) { return b.alive && b.frenzyOriginal; });
    surviving.forEach(function (brick) {
      const original = brick.frenzyOriginal;
      brick.x = original.x; brick.y = original.y; brick.w = original.w; brick.h = original.h; brick.maxHits = original.maxHits;
      if (brick.type === 'indestructible') brick.hits = 999; else brick.hits = Math.min(original.maxHits, Math.max(1, brick.hits));
      brick.frenzyOriginal = null; brick.frenzyMeta = null; brick.frenzyTransitionFrom = null; brick.frenzyTransitionTo = null;
    });
    this.levelData.bricks.forEach(function (brick) { if (!brick.alive) { brick.frenzyOriginal = null; brick.frenzyMeta = null; } });

    if (this.paddle) { this.paddle.ship = false; this.paddle.hidden = false; }
    this.playerShots = []; this.enemyShots = [];
    if (reason !== 'clear' && this.frenzySnapshot) {
      const spent = Math.max(0, this.levelElapsed - this.frenzySnapshot.levelElapsedAtStart);
      this.balls = U.deepClone(this.frenzySnapshot.balls || []);
      this.activePowerups = U.deepClone(this.frenzySnapshot.activePowerups || Object.create(null));
      this.paddle = U.deepClone(this.frenzySnapshot.paddle);
      this.paddle.ship = false; this.paddle.hidden = false;
      this.playerShots = U.deepClone(this.frenzySnapshot.playerShots || []);
      this.enemyShots = U.deepClone(this.frenzySnapshot.enemyShots || []);
      this.powerDrops = U.deepClone(this.frenzySnapshot.powerDrops || []);
      this.combo = this.frenzySnapshot.combo;
      this.rapidCombo = this.frenzySnapshot.rapidCombo;
      this.laserCooldown = this.frenzySnapshot.laserCooldown;
      this.lastBrickActionAt = this.frenzySnapshot.lastBrickActionAt + spent;
      this.finalAssault = U.deepClone(this.frenzySnapshot.finalAssault || this.finalAssault);
      this.bigBomb = U.deepClone(this.frenzySnapshot.bigBomb || this.bigBomb);
      if (this.bigBombRng && this.bigBombRng.setState && this.frenzySnapshot.bigBombRngState != null) this.bigBombRng.setState(this.frenzySnapshot.bigBombRngState);
      if (this.rng.setState) this.rng.setState(this.frenzySnapshot.rngState);
      if (!this.balls.length) this.createStartingBall();
    } else if (reason !== 'clear') {
      this.createPaddle();
      this.createStartingBall();
    }
    this.frenzySnapshot = null;
    this.frenzyTransition = null;
    this.frenzyMode = null;
    this.frenzyGame = null;
    this.setState(this.getBasePlayState(), { frenzyReason: reason });
    this.autosave('frenzy_end');
  };

  Game.prototype.countFrenzyInvaders = function () { return this.levelData ? this.levelData.bricks.filter(function (b) { return b.alive; }).length : 0; };

  Game.prototype.updateBoss = function (dt) {
    const boss = this.levelData.boss;
    if (!boss || !boss.alive) return;
    boss.bobPhase += dt * 2.2;
    boss.x += boss.vx * dt;
    const margin = 36;
    if (boss.x < margin || boss.x + boss.w > C.playfield.width - margin) {
      boss.x = U.clamp(boss.x, margin, C.playfield.width - margin - boss.w);
      boss.vx *= -1;
    }

    const hp = boss.health / boss.maxHealth;
    const phases = C.boss.phases;
    let phaseCfg = phases[0];
    for (let pi = 0; pi < phases.length; pi += 1) {
      if (hp <= phases[pi].minHealthRatio || pi === 0) phaseCfg = phases[pi];
    }
    // Explicit thresholds avoid ambiguity at exact boundaries.
    if (hp <= 0.33) phaseCfg = phases[2];
    else if (hp <= 0.66) phaseCfg = phases[1];
    else phaseCfg = phases[0];

    if (phaseCfg.phase !== boss.phase) {
      boss.phase = phaseCfg.phase;
      const direction = boss.vx < 0 ? -1 : 1;
      boss.vx = direction * (C.boss.baseSpeed[this.difficulty] || C.boss.baseSpeed.normal) * phaseCfg.speedMultiplier;
      this.audio.play('boss_event');
      this.addShake(6);
      this.showMessage(boss.phase === 2 ? 'BOSS: THAT TICKLED.' : 'BOSS: NOW YOU HAVE MY ATTENTION.', 1.8);
      this.autosave('boss_phase_change');
    }

    boss.shotTimer -= dt;
    if (boss.shotTimer <= 0) {
      const speed = this.difficulty === 'hard' ? 345 : this.difficulty === 'easy' ? 250 : 295;
      if (phaseCfg.attack === 'single') {
        this.enemyShots.push({ x: boss.x + boss.w / 2 - 4, y: boss.y + boss.h, w: 8, h: 16, vy: speed });
      } else if (phaseCfg.attack === 'paired') {
        this.enemyShots.push({ x: boss.x + boss.w * 0.3, y: boss.y + boss.h, w: 8, h: 16, vy: speed });
        this.enemyShots.push({ x: boss.x + boss.w * 0.7, y: boss.y + boss.h, w: 8, h: 16, vy: speed });
      } else {
        [-50, 0, 50].forEach((function (offset) {
          this.enemyShots.push({ x: boss.x + boss.w / 2 + offset, y: boss.y + boss.h, w: 8, h: 16, vy: speed + Math.abs(offset) * 0.25 });
        }).bind(this));
      }
      boss.shotTimer = phaseCfg.fireInterval * (C.boss.difficultyFireFactor[this.difficulty] || 1);
      this.audio.play('invader_fire');
    }
  };

  Game.prototype.damageBoss = function (amount) {
    const boss = this.levelData.boss;
    if (!boss || !boss.alive) return;
    boss.health = Math.max(0, boss.health - amount);
    this.score += amount * 125;
    this.spawnParticles(boss.x + boss.w / 2, boss.y + boss.h / 2, 5);
    this.addShake(2.5);
    if (boss.health <= 0) {
      boss.alive = false;
      this.audio.play('explosion');
      this.spawnParticles(boss.x + boss.w / 2, boss.y + boss.h / 2, 45);
      this.addShake(12);
      this.completeLevel(false);
    }
  };

  Game.prototype.getFinalAssaultRamp = function (seconds) {
    if (!this.finalAssault || !this.finalAssault.active) return 0;
    return U.clamp((this.finalAssault.elapsed || 0) / Math.max(0.001, seconds), 0, 1);
  };

  Game.prototype.getFinalAssaultSpeedMultiplier = function () {
    if (!this.finalAssault || !this.finalAssault.active) return 1;
    return U.lerp(C.finalAssault.speedStartMultiplier, C.finalAssault.speedMaxMultiplier, this.getFinalAssaultRamp(C.finalAssault.speedRampSeconds));
  };

  Game.prototype.getFinalAssaultMagneticDegreesPerSecond = function () {
    if (!this.finalAssault || !this.finalAssault.active) return 0;
    return U.lerp(C.finalAssault.magneticStartDegreesPerSecond, C.finalAssault.magnetismMaxDegreesPerSecond, this.getFinalAssaultRamp(C.finalAssault.magneticRampSeconds));
  };

  Game.prototype.updateFinalAssault = function (dt) {
    if (!this.levelData || this.levelData.boss || this.isFrenzyState()) return;
    const remaining = this.countRequiredAliveBricks();
    if (!this.finalAssault.active && remaining > 0 && remaining <= this.finalAssault.threshold) {
      this.finalAssault.active = true;
      this.finalAssault.noHitTime = 0;
      this.finalAssault.stage = 0;
      this.finalAssault.elapsed = 0;
      this.addShake(4);
      this.showMessage('FINAL ASSAULT!', 1.8);
    }
    if (!this.finalAssault.active) return;

    this.finalAssault.elapsed += dt;
    this.finalAssault.noHitTime += dt;
    if (this.finalAssault.noHitTime >= C.finalAssault.magneticAssistDelay) this.finalAssault.stage = 3;
    else if (this.finalAssault.noHitTime >= C.finalAssault.hunterAssistDelay2) this.finalAssault.stage = 2;
    else if (this.finalAssault.noHitTime >= C.finalAssault.hunterAssistDelay1) this.finalAssault.stage = 1;
    else this.finalAssault.stage = 0;

    if (remaining === 0) this.finalAssault.active = false;
  };

  Game.prototype.updateBigBomb = function (dt) {
    if (!this.bigBomb || !C.bigBomb.enabled || this.attract || this.isFrenzyState() || (this.levelData && this.levelData.boss)) return false;
    this.bigBomb.flashRemaining = Math.max(0, (this.bigBomb.flashRemaining || 0) - dt);
    this.bigBomb.waveRemaining = Math.max(0, (this.bigBomb.waveRemaining || 0) - dt);
    if (!this.bigBomb.used && this.bigBomb.charge >= 100 && !this.bigBomb.readyAnnounced) {
      this.bigBomb.readyAnnounced = true;
      this.showMessage('BIG BOMB READY  ↓', 1.8);
    }
    if (!this.bigBomb.used && this.bigBomb.charge >= 100 && this.input && this.input.wasPressed && this.input.wasPressed('bigBomb')) return this.deployBigBomb();
    if (this.bigBomb.used || this.bigBomb.charge >= 100) return false;

    const onScreen = this.powerDrops.some(function (drop) { return drop.special === 'big_bomb_power'; });
    this.bigBomb.spawnTimer = Math.max(0, Number(this.bigBomb.spawnTimer) || 0) - dt;
    if (this.bigBomb.spawnTimer <= 0 && !onScreen) this.spawnBigBombPowerUp();
    return false;
  };

  Game.prototype.scheduleNextBigBombPowerUp = function (initial) {
    if (!this.bigBomb) return;
    if (initial) { this.bigBomb.spawnTimer = C.bigBomb.startDelaySeconds; return; }
    const r = this.bigBombRng ? this.bigBombRng() : 0.5;
    this.bigBomb.spawnTimer = U.lerp(C.bigBomb.spawnMinSeconds, C.bigBomb.spawnMaxSeconds, r);
  };

  Game.prototype.spawnBigBombPowerUp = function () {
    if (!this.bigBomb || this.bigBomb.used || this.bigBomb.charge >= 100 || this.isFrenzyState()) return false;
    if (this.powerDrops.some(function (drop) { return drop.special === 'big_bomb_power'; })) return false;
    const r = this.bigBombRng ? this.bigBombRng() : 0.5;
    const w = 66, h = 28, margin = 70;
    this.powerDrops.push({ special: 'big_bomb_power', type: null, x: margin + r * (C.playfield.width - margin * 2 - w), y: 62,
      w: w, h: h, vy: C.bigBomb.pickupFallSpeed });
    this.scheduleNextBigBombPowerUp(false);
    return true;
  };

  Game.prototype.collectBigBombPowerUp = function () {
    if (!this.bigBomb || this.bigBomb.used || this.bigBomb.charge >= 100) return false;
    this.audio.play('big_bomb_power');
    this.bigBomb.collected = Math.min(C.bigBomb.pickupsRequired, (this.bigBomb.collected || 0) + 1);
    this.bigBomb.charge = U.clamp(this.bigBomb.collected / Math.max(1, C.bigBomb.pickupsRequired) * 100, 0, 100);
    if (this.bigBomb.charge >= 100) {
      this.bigBomb.readyAnnounced = true;
      this.showMessage('BIG BOMB READY  ↓', 2.0);
    } else this.showMessage('BIG BOMB POWER  ' + this.bigBomb.collected + '/' + C.bigBomb.pickupsRequired, 1.4);
    this.autosave('big_bomb_power');
    return true;
  };

  // Legacy charging hooks remain as deliberate no-ops: v1.5.0 only special pickups can arm the bomb.
  Game.prototype.chargeBigBomb = function () { return false; };
  Game.prototype.chargeBigBombFromBrick = function () { return false; };
  Game.prototype.chargeBigBombFromPaddleContact = function () { return false; };

  Game.prototype.deployBigBomb = function () {
    if (!this.bigBomb || this.bigBomb.used || this.bigBomb.charge < 100 || !C.bigBomb.enabled || this.isFrenzyState()) return false;
    this.bigBomb.used = true;
    this.bigBomb.charge = 100;
    this.bigBomb.freezeRemaining = C.bigBomb.freezeSeconds;
    this.bigBomb.flashRemaining = 0.20;
    this.bigBomb.waveRemaining = 0.55;
    this.audio.play('big_bomb');
    this.addShake(18);
    this.showMessage('BIG BOMB!', 1.1);
    this.spawnParticles(C.playfield.width / 2, C.playfield.height / 2, 55);
    const targets = this.levelData.bricks.filter(function (brick) { return brick.alive && brick.type !== 'indestructible'; }).slice();
    targets.forEach((function (brick) { if (brick.alive) this.damageBrick(brick, C.bigBomb.damage, { source: 'big-bomb', frenzy: false }); }).bind(this));
    this.autosave('big_bomb');
    return true;
  };

  Game.prototype.chargeFinalAssaultBomb = function () { return false; };
  Game.prototype.chargeFinalAssaultFromBrick = function () { return false; };
  Game.prototype.chargeFinalAssaultFromPaddleContact = function () { return false; };
  Game.prototype.deployFinalAssaultBigBomb = function () { return this.deployBigBomb(); };

  Game.prototype.updateFinalAssaultBallTrail = function (ball) {
    if (!ball) return;
    if (!this.finalAssault || !this.finalAssault.active || ball.held) { ball.finalAssaultTrail = []; return; }
    ball.finalAssaultTrail = ball.finalAssaultTrail || [];
    ball.finalAssaultTrail.push({ x: ball.x, y: ball.y });
    if (ball.finalAssaultTrail.length > 24) ball.finalAssaultTrail.splice(0, ball.finalAssaultTrail.length - 24);
  };

  Game.prototype.applyFinalAssaultMagnetism = function (ball, dt, priorHeadingDelta) {
    if (!this.finalAssault || !this.finalAssault.active || !ball || ball.held) return 0;
    if (this.paddle && Math.abs(ball.y - this.paddle.y) < C.finalAssault.magneticPaddleExclusion) return 0;
    const targets = this.levelData.bricks.filter(function (b) { return b.alive && b.type !== 'indestructible'; });
    if (!targets.length) return 0;
    let ax = 0, ay = 0, weightTotal = 0;
    targets.forEach(function (brick) {
      const tx = brick.x + brick.w / 2, ty = brick.y + brick.h / 2;
      const dx = tx - ball.x, dy = ty - ball.y, dist = Math.sqrt(dx * dx + dy * dy) || 1;
      if (dist < C.finalAssault.magneticMinDistance || dist > C.finalAssault.magneticMaxDistance) return;
      const weight = 1 - (dist - C.finalAssault.magneticMinDistance) / (C.finalAssault.magneticMaxDistance - C.finalAssault.magneticMinDistance);
      ax += (dx / dist) * weight; ay += (dy / dist) * weight; weightTotal += weight;
    });
    if (!weightTotal) return 0;
    ax /= weightTotal; ay /= weightTotal;
    const desired = Math.atan2(ay, ax);
    const oldVySign = Math.sign(ball.vy || -1);
    const magneticCap = this.getFinalAssaultMagneticDegreesPerSecond() * Math.PI / 180 * dt;
    const combinedCap = C.finalAssault.magneticCombinedCapDegreesPerSecond * Math.PI / 180 * dt;
    const remainingBudget = Math.max(0, combinedCap - Math.abs(priorHeadingDelta || 0));
    const maxDelta = Math.min(magneticCap, remainingBudget);
    const changed = P.steerVelocity(ball, desired, maxDelta);
    if (oldVySign !== 0 && Math.sign(ball.vy) !== oldVySign) ball.vy = Math.abs(ball.vy) * oldVySign;
    return changed;
  };

  Game.prototype.applyFinalAssaultAssist = function (ball) {
    if (!this.finalAssault.active || this.finalAssault.stage <= 0) return;
    const targets = this.levelData.bricks.filter(function (b) { return b.alive && b.type !== 'indestructible'; });
    if (!targets.length) return;
    let target = targets[0];
    for (let i = 1; i < targets.length; i += 1) { if (targets[i].y > target.y) target = targets[i]; }
    const desired = Math.atan2((target.y + target.h / 2) - ball.y, (target.x + target.w / 2) - ball.x);
    const current = Math.atan2(ball.vy, ball.vx);
    let diff = desired - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const strength = this.finalAssault.stage === 1 ? C.finalAssault.hunterAssistStrength1 : C.finalAssault.hunterAssistStrength2;
    const max = C.finalAssault.maxCorrectionDegrees * Math.PI / 180;
    diff = U.clamp(diff * strength, -max, max);
    const speed = P.length(ball.vx, ball.vy);
    const angle = current + diff;
    ball.vx = Math.cos(angle) * speed;
    ball.vy = Math.sin(angle) * speed;
    if (ball.vy > -Math.abs(speed) * 0.22) ball.vy = -Math.abs(speed) * 0.22;
    P.normalizeVelocity(ball, speed);
  };

  Game.prototype.loseLife = function () {
    if (this.debugInvulnerable || this.state === BJ.State.LEVEL_COMPLETE || this.state === BJ.State.CONTINUE || this.state === BJ.State.GAME_OVER) return;
    this.lives -= 1;
    this.activePowerups = Object.create(null);
    this.recalculatePaddleSize();
    this.powerDrops = [];
    this.playerShots = [];
    this.enemyShots = [];
    this.audio.play('life_lost');
    this.showMessage(this.deathMessage(), 1.7);
    this.autosave('life_loss');

    if (this.lives <= 0) {
      if (this.continuesRemaining > 0) {
        this.continueRemaining = C.continues.countdownSeconds;
        this.setState(BJ.State.CONTINUE);
      } else {
        this.finishGame(false);
      }
      return;
    }

    this.createStartingBall();
    this.setState(BJ.State.LIFE_LOST);
    const self = this;
    global.setTimeout(function () {
      if (self.state === BJ.State.LIFE_LOST) self.setState(self.level === C.bossLevel ? BJ.State.BOSS : (self.attract ? BJ.State.ATTRACT : BJ.State.PLAYING));
    }, 700);
  };

  Game.prototype.useContinue = function () {
    if (this.state !== BJ.State.CONTINUE || this.continuesRemaining <= 0) return;
    this.continuesRemaining -= 1;
    this.score = 0;
    this.lives = C.lives.start;
    this.levelData = BJ.Levels.restoreInitial(this.levelInitial);
    this.levelInitial = U.deepClone(this.levelData);
    this.combo = 1;
    this.rapidCombo = 1;
    this.loadLevel(this.level, true);
    this.setState(this.level === C.bossLevel ? BJ.State.BOSS : BJ.State.PLAYING);
    this.autosave('continue_used');
  };

  Game.prototype.checkLevelComplete = function () {
    if (this.isFrenzyState()) return;
    if (this.levelData.boss) return;
    if (BJ.Levels.countRequired(this.levelData.bricks) === 0) this.completeLevel(false);
  };

  Game.prototype.completeLevel = function (fromFrenzy) {
    if (this.state === BJ.State.LEVEL_COMPLETE || this.state === BJ.State.VICTORY) return;
    if (this.state === BJ.State.FRENZY_ACTIVE && !fromFrenzy) this.beginFrenzyExit('clear');
    const bonus = this.calculateLevelBonus();
    this.score += bonus.total;
    this.audio.play('level_complete');
    this.intermissionRemaining = 4;
    this.finalAssault.active = false;
    this.setState(BJ.State.LEVEL_COMPLETE, { bonus });
    this.autosave('level_completion');
  };

  Game.prototype.calculateLevelBonus = function () {
    const s = C.scoring;
    const time = Math.max(0, Math.floor(s.timePar - this.levelElapsed)) * s.timeBonusPerSecond;
    const lives = this.lives * s.lifeBonus;
    const combo = Math.max(0, this.maxCombo - 1) * s.comboBonusStep;
    const continues = this.continuesRemaining * s.continueBonus;
    return { time, lives, combo, continues, total: time + lives + combo + continues };
  };

  Game.prototype.advanceLevel = function () {
    if (this.level >= C.campaignLevels) {
      this.campaignCompleted = true;
      BJ.Storage.clearCampaign();
      this.setState(BJ.State.VICTORY);
      if (this.callbacks.onVictory) this.callbacks.onVictory(this.getResult(), this);
      return;
    }
    this.level += 1;
    this.loadLevel(this.level, true);
    this.setState(this.level === C.bossLevel ? BJ.State.BOSS : (this.attract ? BJ.State.ATTRACT : BJ.State.PLAYING));
    if (!this.attract) this.autosave('level_start');
  };

  Game.prototype.finishGame = function (completed) {
    this.campaignCompleted = !!completed;
    BJ.Storage.clearCampaign();
    this.setState(completed ? BJ.State.VICTORY : BJ.State.GAME_OVER);
    if (!this.attract && this.callbacks.onGameFinished) this.callbacks.onGameFinished(this.getResult(), this);
  };

  Game.prototype.getResult = function () {
    return {
      initials: '___',
      score: Math.round(this.score),
      campaignSeed: this.seed,
      difficulty: this.difficulty,
      levelReached: this.level,
      date: new Date().toISOString(),
      campaignCompleted: this.campaignCompleted,
      maxCombo: this.maxCombo,
      highScoreEligible: this.highScoreEligible
    };
  };

  Game.prototype.pause = function () {
    if (this.state === BJ.State.PAUSED || !this.isPlayableState()) return false;
    this.previousState = this.state;
    this.setState(BJ.State.PAUSED);
    this.autosave('pause');
    return true;
  };

  Game.prototype.resume = function () {
    if (this.state !== BJ.State.PAUSED) return false;
    const next = this.previousState && this.previousState !== BJ.State.PAUSED ? this.previousState : (this.level === C.bossLevel ? BJ.State.BOSS : BJ.State.PLAYING);
    this.state = next;
    this.stateElapsed = 0;
    if (this.callbacks.onStateChange) this.callbacks.onStateChange(next, BJ.State.PAUSED, null, this);
    return true;
  };

  Game.prototype.restartLevel = function () {
    if (!this.levelInitial) return;
    this.levelData = BJ.Levels.restoreInitial(this.levelInitial);
    this.levelInitial = U.deepClone(this.levelData);
    this.levelElapsed = 0;
    this.activePowerups = Object.create(null);
    this.powerDrops = [];
    this.playerShots = [];
    this.enemyShots = [];
    this.particles = [];
    this.createPaddle();
    this.createStartingBall();
    this.finalAssault = { active: false, threshold: Math.max(1, Math.min(C.finalAssault.thresholdMaxBricks, Math.ceil(BJ.Levels.countRequired(this.levelData.bricks) * C.finalAssault.thresholdPercent))), noHitTime: 0, stage: 0, startingRequired: BJ.Levels.countRequired(this.levelData.bricks), lastResetStep: -1, elapsed: 0 };
    this.bigBomb = { charge: 0, collected: 0, used: false, readyAnnounced: false, spawnTimer: C.bigBomb.startDelaySeconds, freezeRemaining: 0, flashRemaining: 0, waveRemaining: 0 };
    this.bigBombRng = BJ.Levels.campaignRng(this.seed, this.difficulty, this.level, 'big-bomb-spawn');
    this.setState(this.level === C.bossLevel ? BJ.State.BOSS : BJ.State.PLAYING);
    this.autosave('level_start');
  };

  Game.prototype.autosave = function () {
    if (this.attract || !this.seed || this.state === BJ.State.MENU || this.state === BJ.State.GAME_OVER || this.state === BJ.State.VICTORY) return;
    const save = {
      campaignSeed: this.seed,
      difficulty: this.difficulty,
      currentLevel: this.level,
      score: Math.round(this.score),
      lives: this.lives,
      continuesRemaining: this.continuesRemaining,
      generatedLevelState: this.levelInitial ? {
        template: this.levelInitial.template,
        initialBricks: U.deepClone(this.levelInitial.initialBricks || [])
      } : null,
      settings: U.deepClone(this.settings),
      highScoreEligibleState: this.highScoreEligible,
      maxCombo: this.maxCombo,
      combo: this.combo
    };
    BJ.Storage.saveCampaign(save);
  };

  Game.prototype.countAliveBricks = function () {
    return this.levelData ? this.levelData.bricks.filter(function (b) { return b.alive; }).length : 0;
  };

  Game.prototype.updateParticles = function (dt) {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 140 * dt;
    }
    if (this.particles.length > 240) this.particles.splice(0, this.particles.length - 240);
  };

  Game.prototype.spawnParticles = function (x, y, count) {
    const reduced = this.settings && this.settings.reducedFlashing;
    count = reduced ? Math.ceil(count * 0.4) : count;
    for (let i = 0; i < count; i += 1) {
      const angle = this.fxRng() * Math.PI * 2;
      const speed = 55 + this.fxRng() * 170;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.25 + this.fxRng() * 0.55,
        maxLife: 0.8,
        size: 1.5 + this.fxRng() * 3.5
      });
    }
  };

  Game.prototype.addShake = function (amount) {
    if (this.settings && this.settings.reducedShake) amount *= 0.22;
    this.shake = Math.max(this.shake, amount);
  };

  Game.prototype.showMessage = function (text, seconds) {
    this.message = text;
    this.messageTime = seconds || 1.5;
  };

  Game.prototype.deathMessage = function () {
    const messages = [
      'BALL LOST. GRAVITY REMAINS UNREPENTANT.',
      'THAT GAP WAS LARGER THAN IT LOOKED.',
      'PADDLE FAILURE. PAPERWORK PENDING.',
      'THE FLOOR CLAIMS ANOTHER ONE.',
      'BALL DOWN. BRICKS SMUG.'
    ];
    return messages[Math.floor(this.rng() * messages.length)];
  };

  Game.prototype.render = function () {
    const ctx = this.ctx;
    const w = C.playfield.width;
    const h = C.playfield.height;
    const fpsView = this.isFrenzyState() && this.frenzyMode === 'fps';
    const missileView = this.isFrenzyState() && this.frenzyMode === 'missile';
    const tenPinView = this.isFrenzyState() && this.frenzyMode === 'tenpin';
    this.canvas.style.cursor = (fpsView || missileView || tenPinView) ? 'none' : '';

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    const grd = ctx.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, fpsView ? '#111019' : '#07101d');
    grd.addColorStop(1, fpsView ? '#020205' : '#02050b');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);

    if (fpsView) this.drawFpsEnvironment(ctx); else this.drawStars(ctx);
    if (this.isFrenzyState()) this.drawFrenzyEnvironment(ctx);

    const shakeX = this.shake > 0 ? Math.sin(this.elapsed * 91.7) * this.shake * 0.5 : 0;
    const shakeY = this.shake > 0 ? Math.cos(this.elapsed * 77.3) * this.shake * 0.5 : 0;
    ctx.translate(shakeX, shakeY);

    if (this.levelData) {
      if (this.state === BJ.State.BOSS || (this.levelData.boss && this.levelData.boss.alive)) this.drawBoss(ctx);
      else this.drawBricks(ctx);
      this.drawPowerDrops(ctx);
      this.drawShots(ctx);
      this.drawBalls(ctx);
      this.drawPaddle(ctx);
      if (fpsView) this.drawFpsWeapon(ctx);
      this.drawFrenzyEntities(ctx);
      this.drawMagneticFilaments(ctx);
      this.drawParticles(ctx);
      this.drawBigBombEffect(ctx);
      if (this.isFrenzyState()) this.drawFrenzyTimer(ctx);
    }

    ctx.restore();
    this.drawHUD(ctx);
    this.drawMessage(ctx);
    if (this.debug) this.drawDebug(ctx);
  };

  Game.prototype.drawFpsEnvironment = function (ctx) {
    const horizon = 230;
    ctx.save();
    const ceiling = ctx.createLinearGradient(0, 54, 0, horizon);
    ceiling.addColorStop(0, '#16121e');
    ceiling.addColorStop(1, '#09080d');
    ctx.fillStyle = ceiling;
    ctx.fillRect(0, 54, C.playfield.width, horizon - 54);
    const floor = ctx.createLinearGradient(0, horizon, 0, C.playfield.height);
    floor.addColorStop(0, '#111118');
    floor.addColorStop(1, '#030305');
    ctx.fillStyle = floor;
    ctx.fillRect(0, horizon, C.playfield.width, C.playfield.height - horizon);
    ctx.strokeStyle = 'rgba(90,120,150,0.16)';
    ctx.lineWidth = 1;
    const vanishX = C.playfield.width / 2 - this.fpsCamera.x * 0.18;
    for (let x = -200; x <= C.playfield.width + 200; x += 80) {
      ctx.beginPath(); ctx.moveTo(vanishX, horizon); ctx.lineTo(x, C.playfield.height); ctx.stroke();
    }
    for (let y = horizon + 34; y < C.playfield.height; y += 46) {
      const t = (y - horizon) / (C.playfield.height - horizon);
      const yy = horizon + t * t * (C.playfield.height - horizon);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(C.playfield.width, yy); ctx.stroke();
    }
    ctx.restore();
  };

  Game.prototype.drawFrenzyEnvironment = function (ctx) {
    if (!this.isFrenzyState()) return;
    ctx.save();
    if (this.frenzyMode === 'pinball') {
      const pc = C.frenzy.pinball;
      ctx.fillStyle = 'rgba(16,8,36,0.34)'; ctx.fillRect(18, 62, C.playfield.width - 36, C.playfield.height - 78);
      ctx.strokeStyle = 'rgba(255,232,95,0.34)'; ctx.lineWidth = 3;
      ctx.strokeRect(pc.playfieldLeft, 70, pc.playfieldRight - pc.playfieldLeft, pc.drainY - 70);
      for (let i = 0; i < 7; i += 1) { ctx.beginPath(); ctx.arc(110 + i * 125, 470 - (i % 2) * 45, 13, 0, Math.PI * 2); ctx.stroke(); }

      ctx.lineWidth = 12; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(77,232,255,0.86)';
      this.getPinballApronSegments().forEach(function (r) {
        ctx.lineWidth = r.thickness || 12;
        ctx.beginPath(); ctx.moveTo(r.ax, r.ay); ctx.lineTo(r.bx, r.by); ctx.stroke();
      });

      const leftOut = this.getPinballOutlaneBounds('left');
      const rightOut = this.getPinballOutlaneBounds('right');
      ctx.lineWidth = 2; ctx.setLineDash([8, 7]);
      ctx.strokeStyle = 'rgba(255,101,115,0.95)';
      ctx.strokeRect(leftOut.minX, leftOut.entryY, leftOut.maxX - leftOut.minX, pc.drainY - leftOut.entryY);
      ctx.strokeRect(rightOut.minX, rightOut.entryY, rightOut.maxX - rightOut.minX, pc.drainY - rightOut.entryY);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,101,115,0.14)';
      ctx.fillRect(leftOut.minX, leftOut.entryY, leftOut.maxX - leftOut.minX, pc.drainY - leftOut.entryY);
      ctx.fillRect(rightOut.minX, rightOut.entryY, rightOut.maxX - rightOut.minX, pc.drainY - rightOut.entryY);

      ctx.strokeStyle = 'rgba(255,232,95,0.70)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(pc.centralDrain.minX, pc.drainY); ctx.lineTo(pc.centralDrain.maxX, pc.drainY); ctx.stroke();
      ctx.fillStyle = 'rgba(255,232,95,0.85)'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
      ctx.fillText('OUT', leftOut.centreX, pc.drainY - 8);
      ctx.fillText('OUT', rightOut.centreX, pc.drainY - 8);
    } else if (this.frenzyMode === 'missile') {
      ctx.fillStyle = 'rgba(3,20,18,0.28)'; ctx.fillRect(0, 54, C.playfield.width, C.playfield.height - 54);
      ctx.strokeStyle = 'rgba(114,255,159,0.14)'; ctx.lineWidth = 1;
      for (let x = 0; x < C.playfield.width; x += 64) { ctx.beginPath(); ctx.moveTo(x, 54); ctx.lineTo(x, C.playfield.height); ctx.stroke(); }
      for (let y = 86; y < C.playfield.height; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(C.playfield.width, y); ctx.stroke(); }
    } else if (this.frenzyMode === 'tenpin') {
      this.drawTenPinEnvironment(ctx);
    } else if (this.frenzyMode === 'bomber') {
      this.drawBomberEnvironment(ctx);
    } else if (this.frenzyMode === 'revenge') {
      ctx.fillStyle = 'rgba(75,18,35,0.13)'; ctx.fillRect(0, 54, C.playfield.width, C.playfield.height - 54);
      ctx.setLineDash([9, 10]); ctx.strokeStyle = 'rgba(255,92,168,0.22)';
      ctx.beginPath(); ctx.moveTo(0, C.playfield.height / 2); ctx.lineTo(C.playfield.width, C.playfield.height / 2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();
  };

  Game.prototype.drawFrenzyEntities = function (ctx) {
    if (!this.isFrenzyState() || !this.frenzyGame) return;
    if (this.frenzyMode === 'pinball') this.drawPinballEntities(ctx);
    else if (this.frenzyMode === 'asteroids') this.drawAsteroidsEntities(ctx);
    else if (this.frenzyMode === 'missile') this.drawMissileEntities(ctx);
    else if (this.frenzyMode === 'revenge') this.drawRevengeEntities(ctx);
    else if (this.frenzyMode === 'tenpin') this.drawTenPinEntities(ctx);
    else if (this.frenzyMode === 'bomber') this.drawBomberEntities(ctx);
  };

  Game.prototype.drawPinballEntities = function (ctx) {
    const g = this.frenzyGame; if (!g || !g.ball) return;
    const self = this;
    ctx.save();
    function drawFlipper(f) {
      const seg = self.getPinballFlipperSegment(f);
      ctx.save();
      ctx.strokeStyle = f.active ? '#ffe85f' : '#4de8ff';
      ctx.lineWidth = f.thickness; ctx.lineCap = 'round'; ctx.shadowBlur = 14; ctx.shadowColor = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(seg.ax, seg.ay); ctx.lineTo(seg.bx, seg.by); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(f.pivotX, f.pivotY, f.thickness * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    drawFlipper(g.leftFlipper); drawFlipper(g.rightFlipper);
    ctx.shadowBlur = 14; ctx.shadowColor = '#ffffff'; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(g.ball.x, g.ball.y, g.ball.r, 0, Math.PI * 2); ctx.fill();
    if (g.committedDrain) {
      ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff6573';
      ctx.fillText(g.committedDrain === 'central_gap' ? 'DANGER' : 'OUTLANE', g.ball.x, Math.min(C.frenzy.pinball.drainY - 14, g.ball.y - 18));
    }
    ctx.restore();
  };

  Game.prototype.drawAsteroidBrick = function (ctx, brick) {
    const c = { x: brick.x + brick.w / 2, y: brick.y + brick.h / 2 };
    const radius = Math.max(14, Math.min(34, Math.max(brick.w, brick.h) * 0.46));
    const angle = brick.frenzyMeta.angle || 0;
    const colour = BJ.Colour[brick.type] || '#ffffff';
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(angle); ctx.fillStyle = colour; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.shadowBlur = 9; ctx.shadowColor = colour;
    ctx.beginPath();
    for (let i = 0; i < 9; i += 1) {
      const a = i / 9 * Math.PI * 2; const rr = radius * (0.78 + ((brick.id * 17 + i * 13) % 23) / 100);
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.beginPath(); ctx.arc(-radius * .24, -radius * .1, radius * .16, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  Game.prototype.drawAsteroidsEntities = function (ctx) {
    const g = this.frenzyGame; if (!g) return;
    const ship = g.ship;
    ctx.save(); ctx.translate(ship.x, ship.y); ctx.rotate(ship.angle); ctx.strokeStyle = '#7dff8a'; ctx.lineWidth = 2; ctx.shadowBlur = 10; ctx.shadowColor = '#7dff8a';
    ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-13, -11); ctx.lineTo(-7, 0); ctx.lineTo(-13, 11); ctx.closePath(); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.fillStyle = '#ffe85f'; g.shots.forEach(function (shot) { ctx.beginPath(); ctx.arc(shot.x, shot.y, 3, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
  };

  Game.prototype.drawMissileEntities = function (ctx) {
    const g = this.frenzyGame; if (!g) return;
    ctx.save();
    g.bases.forEach(function (base) {
      ctx.fillStyle = base.alive ? '#72ff9f' : '#4b4b4b'; ctx.fillRect(base.x - 34, base.y, 68, 12);
      ctx.beginPath(); ctx.moveTo(base.x - 18, base.y); ctx.lineTo(base.x, base.y - 18); ctx.lineTo(base.x + 18, base.y); ctx.fill();
    });
    ctx.strokeStyle = '#ff6573'; ctx.lineWidth = 2;
    g.missiles.forEach(function (m) { ctx.beginPath(); ctx.moveTo(m.sx, m.sy); ctx.lineTo(m.x, m.y); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.fillRect(m.x - 2, m.y - 2, 4, 4); });
    g.blasts.forEach(function (b) { ctx.strokeStyle = '#ffe85f'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2); ctx.stroke(); });
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; const a = g.aim;
    ctx.beginPath(); ctx.arc(a.x, a.y, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(a.x - 18, a.y); ctx.lineTo(a.x - 5, a.y); ctx.moveTo(a.x + 5, a.y); ctx.lineTo(a.x + 18, a.y); ctx.moveTo(a.x, a.y - 18); ctx.lineTo(a.x, a.y - 5); ctx.moveTo(a.x, a.y + 5); ctx.lineTo(a.x, a.y + 18); ctx.stroke();
    ctx.restore();
  };

  Game.prototype.drawRevengeEntities = function (ctx) {
    const g = this.frenzyGame; if (!g) return;
    ctx.save();
    ctx.fillStyle = '#4de8ff'; ctx.shadowBlur = 12; ctx.shadowColor = '#4de8ff'; ctx.fillRect(g.player.x, g.player.y, g.player.w, g.player.h);
    if (g.ball) { ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#ffffff'; ctx.beginPath(); ctx.arc(g.ball.x, g.ball.y, g.ball.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  };

  Game.prototype.drawMagneticFilaments = function (ctx) {
    if (!this.finalAssault || !this.finalAssault.active || this.isFrenzyState()) return;
    const ramp = this.getFinalAssaultRamp(C.finalAssault.magneticRampSeconds);
    const alpha = (this.settings && this.settings.reducedFlashing ? 0.06 : 0.11) + ramp * (this.settings && this.settings.reducedFlashing ? 0.05 : 0.15);
    ctx.save(); ctx.strokeStyle = 'rgba(114,255,159,' + alpha + ')'; ctx.lineWidth = 1;
    this.balls.forEach((function (ball) {
      this.levelData.bricks.forEach(function (brick) {
        if (!brick.alive || brick.type === 'indestructible') return;
        const tx = brick.x + brick.w / 2, ty = brick.y + brick.h / 2, dx = tx - ball.x, dy = ty - ball.y;
        if (dx * dx + dy * dy > C.finalAssault.magneticMaxDistance * C.finalAssault.magneticMaxDistance) return;
        ctx.beginPath(); ctx.moveTo(ball.x, ball.y); ctx.lineTo(tx, ty); ctx.stroke();
      });
    }).bind(this));
    ctx.restore();
  };

  Game.prototype.drawBigBombEffect = function (ctx) {
    if (!this.bigBomb) return;
    const flash = this.bigBomb.flashRemaining || 0;
    const wave = this.bigBomb.waveRemaining || 0;
    if (wave > 0) {
      const t = 1 - U.clamp(wave / 0.55, 0, 1);
      ctx.save(); ctx.strokeStyle = 'rgba(255,232,95,' + (1 - t) * 0.85 + ')'; ctx.lineWidth = 10 * (1 - t) + 2;
      ctx.beginPath(); ctx.arc(C.playfield.width / 2, C.playfield.height / 2, 30 + t * 610, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    if (flash > 0 && !(this.settings && this.settings.reducedFlashing)) {
      ctx.save(); ctx.fillStyle = 'rgba(255,245,185,' + U.clamp(flash / 0.20, 0, 1) * 0.42 + ')'; ctx.fillRect(0, 0, C.playfield.width, C.playfield.height); ctx.restore();
    }
  };

  Game.prototype.drawStars = function (ctx) {
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#a9d6ff';
    for (let i = 0; i < 46; i += 1) {
      const x = (i * 173 + 31) % C.playfield.width;
      const y = (i * 97 + 57) % C.playfield.height;
      ctx.fillRect(x, y, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
    }
    ctx.restore();
  };

  Game.prototype.drawBricks = function (ctx) {
    const self = this;
    if (this.isFrenzyState() && this.frenzyMode === 'fps') {
      this.getFpsRenderBricks().forEach(function (brick) { self.drawBrick(ctx, brick, false); });
      return;
    }
    this.levelData.bricks.forEach(function (brick) {
      if (!brick.alive) return;
      self.drawBrick(ctx, brick, self.state === BJ.State.FRENZY_ACTIVE && self.frenzyMode === 'invaders');
    });
  };

  Game.prototype.drawBrick = function (ctx, brick, invader) {
    if (this.isFrenzyState() && this.frenzyMode === 'fps' && brick.frenzyMeta) { this.drawFpsBrick(ctx, brick); return; }
    if (this.isFrenzyState() && this.frenzyMode === 'asteroids' && brick.frenzyMeta && this.state === BJ.State.FRENZY_ACTIVE) { this.drawAsteroidBrick(ctx, brick); return; }
    if (this.isFrenzyState() && this.frenzyMode === 'tenpin' && brick.frenzyMeta) { if (brick.frenzyMeta.activePin) this.drawTenPinBrick(ctx, brick); return; }
    if (this.isFrenzyState() && this.frenzyMode === 'bomber' && brick.frenzyMeta) { this.drawBomberBrick(ctx, brick); return; }

    let alpha = 1;
    if (brick.type === 'invisible') alpha = 0.17 + (Math.sin(this.elapsed * 2.4 + brick.shimmerPhase) + 1) * 0.16;
    ctx.save();
    ctx.globalAlpha = alpha;
    const colour = BJ.Colour[brick.type] || '#ffffff';
    const damage = brick.maxHits >= 999 ? 1 : U.clamp(brick.hits / Math.max(1, brick.maxHits), 0.2, 1);
    const morphing = this.isFrenzyState() && this.frenzyMode === 'invaders' && brick.frenzyMeta;

    ctx.shadowBlur = 10;
    ctx.shadowColor = colour;
    ctx.fillStyle = colour;
    if (invader) {
      this.drawInvaderShape(ctx, brick);
    } else if (morphing) {
      const morph = U.clamp(brick.frenzyMeta.morph || 0, 0, 1);
      ctx.globalAlpha = 1 - morph * 0.65;
      ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
      ctx.globalAlpha = morph;
      this.drawInvaderShape(ctx, brick);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillRect(brick.x, brick.y, brick.w, brick.h);
      ctx.fillStyle = 'rgba(255,255,255,0.27)';
      ctx.fillRect(brick.x + 3, brick.y + 3, brick.w - 6, 4);
      ctx.fillStyle = 'rgba(0,0,0,' + (0.18 + (1 - damage) * 0.34) + ')';
      ctx.fillRect(brick.x + 2, brick.y + brick.h * damage, brick.w - 4, brick.h * (1 - damage));
    }

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.50)';
    ctx.lineWidth = 1;
    ctx.strokeRect(brick.x + 0.5, brick.y + 0.5, brick.w - 1, brick.h - 1);
    this.drawBrickMark(ctx, brick, brick.x, brick.y, brick.w, brick.h, invader);
    ctx.restore();
  };

  Game.prototype.drawBrickMark = function (ctx, brick, x, y, w, h, frenzyDestructible) {
    ctx.fillStyle = '#07101d';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let mark = '';
    if (brick.type === 'multi_hit') mark = String(Math.max(1, brick.hits));
    if (brick.type === 'indestructible') mark = frenzyDestructible ? String(Math.max(1, brick.hits)) : '◆';
    if (brick.type === 'explosive') mark = '✹';
    if (brick.type === 'moving') mark = '↔';
    if (brick.type === 'invisible') mark = '◌';
    if (brick.type === 'regenerating') mark = '↻';
    if (brick.type === 'powerup') mark = '?';
    if (mark) ctx.fillText(mark, x + w / 2, y + h / 2 + 1);
  };

  Game.prototype.drawFpsBrick = function (ctx, brick) {
    const meta = brick.frenzyMeta;
    const attack = meta.attack;
    const attacking = attack && (attack.phase === 'fall' || attack.phase === 'recover');
    const rect = attacking && attack.projected ? attack.projected : (meta.visual || meta.projected);
    if (!rect) return;
    const morph = U.clamp(meta.morph == null ? 1 : meta.morph, 0, 1);
    let alpha = 1;
    if (brick.type === 'invisible') alpha = attack ? 0.88 : 0.22 + (Math.sin(this.elapsed * 3.4 + brick.shimmerPhase) + 1) * 0.22;
    const colour = BJ.Colour[brick.type] || '#ffffff';
    const depthT = U.clamp((meta.depth - C.frenzy.fps.depthMin) / (C.frenzy.fps.depthMax - C.frenzy.fps.depthMin), 0, 1);
    const extrude = attacking ? 12 : U.lerp(20, 6, depthT) * morph;

    ctx.save();

    if (attack && attack.phase === 'telegraph') {
      const pulse = 0.45 + (Math.sin(this.elapsed * 18) + 1) * 0.25;
      const laneX = this.getFpsFallingScreenX(attack.worldX);
      ctx.globalAlpha = this.settings && this.settings.reducedFlashing ? 0.22 : pulse * 0.32;
      ctx.fillStyle = '#ffdf65';
      ctx.fillRect(laneX - 24, 62, 48, C.frenzy.fps.falling.impactY - 62);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#fff0a0';
      ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.moveTo(laneX, 62); ctx.lineTo(laneX, C.frenzy.fps.falling.impactY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha * (0.78 + pulse * 0.22);
    } else {
      ctx.globalAlpha = alpha;
    }

    ctx.shadowBlur = attacking ? 18 : 10 * morph;
    ctx.shadowColor = colour;
    ctx.fillStyle = colour;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    if (extrude > 0.2) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(rect.x, rect.y);
      ctx.lineTo(rect.x + extrude, rect.y - extrude * 0.55);
      ctx.lineTo(rect.x + rect.w + extrude, rect.y - extrude * 0.55);
      ctx.lineTo(rect.x + rect.w, rect.y);
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.moveTo(rect.x + rect.w, rect.y);
      ctx.lineTo(rect.x + rect.w + extrude, rect.y - extrude * 0.55);
      ctx.lineTo(rect.x + rect.w + extrude, rect.y + rect.h - extrude * 0.55);
      ctx.lineTo(rect.x + rect.w, rect.y + rect.h);
      ctx.closePath(); ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.strokeStyle = attack && attack.phase === 'telegraph' ? '#fff0a0' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = attack && attack.phase === 'telegraph' ? 3 : 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
    this.drawBrickMark(ctx, brick, rect.x, rect.y, rect.w, rect.h, true);
    ctx.restore();
  };

  Game.prototype.drawInvaderShape = function (ctx, b) {
    const x = b.x, y = b.y, w = b.w, h = b.h;
    ctx.fillRect(x + w * 0.18, y + h * 0.14, w * 0.64, h * 0.62);
    ctx.fillRect(x + w * 0.08, y + h * 0.34, w * 0.84, h * 0.28);
    ctx.fillRect(x + w * 0.22, y + h * 0.76, w * 0.16, h * 0.2);
    ctx.fillRect(x + w * 0.62, y + h * 0.76, w * 0.16, h * 0.2);
    ctx.clearRect(x + w * 0.32, y + h * 0.34, w * 0.08, h * 0.14);
    ctx.clearRect(x + w * 0.60, y + h * 0.34, w * 0.08, h * 0.14);
  };

  Game.prototype.shouldDrawPaddle = function () {
    return !!this.paddle && !this.paddle.hidden && !(this.isFrenzyState() && this.frenzyMode === 'fps');
  };

  Game.prototype.drawPaddle = function (ctx) {
    if (!this.shouldDrawPaddle()) return;
    const p = this.paddle;
    ctx.save();
    ctx.shadowBlur = 14;
    ctx.shadowColor = p.ship ? BJ.Colour.ship : BJ.Colour.paddle;
    ctx.fillStyle = p.ship ? BJ.Colour.ship : BJ.Colour.paddle;
    if (p.ship) {
      ctx.beginPath();
      ctx.moveTo(p.x + p.w / 2, p.y - 10);
      ctx.lineTo(p.x + p.w, p.y + p.h);
      ctx.lineTo(p.x + p.w * 0.68, p.y + p.h * 0.72);
      ctx.lineTo(p.x + p.w * 0.5, p.y + p.h);
      ctx.lineTo(p.x + p.w * 0.32, p.y + p.h * 0.72);
      ctx.lineTo(p.x, p.y + p.h);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#061114';
      ctx.fillRect(p.x + p.w / 2 - 7, p.y + 4, 14, 8);
    } else {
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = '#06131c';
      ctx.fillRect(p.x + 12, p.y + 5, p.w - 24, p.h - 10);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(p.x + 4, p.y + 2, 4, p.h - 4);
      ctx.fillRect(p.x + p.w - 8, p.y + 2, 4, p.h - 4);
    }
    ctx.restore();
  };

  Game.prototype.drawFpsWeapon = function (ctx) {
    let visibility = 1;
    if (this.state === BJ.State.FRENZY_TRANSITION_IN) visibility = U.easeInOut(U.clamp(this.stateElapsed / C.frenzy.transitionIn, 0, 1));
    else if (this.state === BJ.State.FRENZY_TRANSITION_OUT) visibility = 1 - U.easeInOut(U.clamp(this.stateElapsed / C.frenzy.transitionOut, 0, 1));
    if (visibility <= 0.01) return;

    const recoil = this.fpsWeapon.recoil * 12;
    const centreX = C.playfield.width / 2;
    const baseY = C.playfield.height + (1 - visibility) * 120 + recoil;
    ctx.save();
    ctx.globalAlpha = visibility;

    if (this.fpsWeapon.tracer) {
      const tr = this.fpsWeapon.tracer;
      ctx.globalAlpha = visibility * U.clamp(tr.life / tr.maxLife, 0, 1);
      ctx.strokeStyle = '#fff7b0';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tr.x1, tr.y1); ctx.lineTo(tr.x2, tr.y2); ctx.stroke();
      ctx.globalAlpha = visibility;
    }

    ctx.fillStyle = '#222936';
    ctx.beginPath();
    ctx.moveTo(centreX - 82, baseY);
    ctx.lineTo(centreX - 34, baseY - 130);
    ctx.lineTo(centreX + 34, baseY - 130);
    ctx.lineTo(centreX + 82, baseY);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#6e7b8d';
    ctx.fillRect(centreX - 18, baseY - 178, 36, 78);
    ctx.fillStyle = '#11151c';
    ctx.fillRect(centreX - 8, baseY - 202, 16, 36);
    ctx.strokeStyle = '#d9f6ff';
    ctx.lineWidth = 2;
    ctx.strokeRect(centreX - 12, baseY - 164, 24, 28);

    if (this.fpsWeapon.muzzle > 0) {
      const flash = U.clamp(this.fpsWeapon.muzzle / 0.075, 0, 1);
      ctx.globalAlpha = visibility * flash;
      ctx.fillStyle = '#fff4a8';
      ctx.beginPath();
      ctx.moveTo(centreX, baseY - 214);
      ctx.lineTo(centreX - 24, baseY - 180);
      ctx.lineTo(centreX, baseY - 188);
      ctx.lineTo(centreX + 24, baseY - 180);
      ctx.closePath(); ctx.fill();
    }

    ctx.globalAlpha = visibility;
    ctx.strokeStyle = this.fpsWeapon.hitFlash > 0 ? '#ffe85f' : '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(this.fpsAim.x, this.fpsAim.y, 12, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(this.fpsAim.x - 21, this.fpsAim.y); ctx.lineTo(this.fpsAim.x - 6, this.fpsAim.y);
    ctx.moveTo(this.fpsAim.x + 6, this.fpsAim.y); ctx.lineTo(this.fpsAim.x + 21, this.fpsAim.y);
    ctx.moveTo(this.fpsAim.x, this.fpsAim.y - 21); ctx.lineTo(this.fpsAim.x, this.fpsAim.y - 6);
    ctx.moveTo(this.fpsAim.x, this.fpsAim.y + 6); ctx.lineTo(this.fpsAim.x, this.fpsAim.y + 21);
    ctx.stroke();
    ctx.restore();
  };

  Game.prototype.drawBalls = function (ctx) {
    ctx.save();
    this.balls.forEach((function (ball) {
      if (this.finalAssault && this.finalAssault.active && ball.finalAssaultTrail && ball.finalAssaultTrail.length > 1) {
        const ramp = this.getFinalAssaultRamp(C.finalAssault.magneticRampSeconds);
        ctx.save();
        ctx.strokeStyle = 'rgba(114,255,159,' + (0.22 + ramp * 0.56) + ')';
        ctx.lineWidth = 2 + ramp * 3;
        ctx.shadowBlur = 7 + ramp * 12;
        ctx.shadowColor = '#72ff9f';
        ctx.beginPath();
        ball.finalAssaultTrail.forEach(function (pt, index) { if (index === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y); });
        ctx.stroke();
        ctx.restore();
      }
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#ffffff';
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#9bdcff';
      ctx.beginPath();
      ctx.arc(ball.x - 2.5, ball.y - 2.5, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }).bind(this));
    ctx.restore();
  };

  Game.prototype.drawPowerDrops = function (ctx) {
    ctx.save();
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.powerDrops.forEach(function (drop) {
      if (drop.special === 'big_bomb_power') {
        const pulse = 0.75 + Math.sin(Date.now() / 140) * 0.2;
        ctx.fillStyle = '#ffe85f'; ctx.globalAlpha = pulse; ctx.fillRect(drop.x, drop.y, drop.w, drop.h); ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.strokeRect(drop.x + 0.5, drop.y + 0.5, drop.w - 1, drop.h - 1);
        ctx.fillStyle = '#07101d'; ctx.fillText('BOMB +', drop.x + drop.w / 2, drop.y + drop.h / 2 + 1); return;
      }
      const cfg = C.powerups[drop.type];
      ctx.fillStyle = cfg && cfg.positive ? '#55f6a5' : '#ff6f7d';
      if (drop.type && /frenzy$/.test(drop.type)) ctx.fillStyle = '#ffe85f';
      ctx.fillRect(drop.x, drop.y, drop.w, drop.h);
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(drop.x + 0.5, drop.y + 0.5, drop.w - 1, drop.h - 1);
      ctx.fillStyle = '#07101d';
      ctx.fillText(cfg ? cfg.label : drop.type, drop.x + drop.w / 2, drop.y + drop.h / 2 + 1);
    });
    ctx.restore();
  };

  Game.prototype.drawShots = function (ctx) {
    ctx.save();
    ctx.fillStyle = '#78ffae';
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#78ffae';
    this.playerShots.forEach(function (shot) { ctx.fillRect(shot.x, shot.y, shot.w, shot.h); });
    ctx.fillStyle = '#ff6a73';
    ctx.shadowColor = '#ff6a73';
    this.enemyShots.forEach(function (shot) { ctx.fillRect(shot.x, shot.y, shot.w, shot.h); });
    ctx.restore();
  };

  Game.prototype.drawParticles = function (ctx) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    this.particles.forEach(function (p) {
      ctx.globalAlpha = U.clamp(p.life / p.maxLife, 0, 1);
      ctx.fillRect(p.x, p.y, p.size, p.size);
    });
    ctx.restore();
  };

  Game.prototype.drawBoss = function (ctx) {
    const b = this.levelData && this.levelData.boss;
    if (!b || !b.alive) return;
    const y = b.y + Math.sin(b.bobPhase) * 6;
    ctx.save();
    ctx.shadowBlur = 22;
    ctx.shadowColor = '#ff4f79';
    ctx.fillStyle = '#ff4f79';
    ctx.fillRect(b.x, y, b.w, b.h);
    ctx.fillStyle = '#351020';
    ctx.fillRect(b.x + 16, y + 14, b.w - 32, b.h - 28);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(b.x + 44, y + 29, 20, 12);
    ctx.fillRect(b.x + b.w - 64, y + 29, 20, 12);
    ctx.fillStyle = '#ffcf4a';
    ctx.fillRect(b.x + b.w / 2 - 26, y + 52, 52, 7);
    ctx.restore();

    const barW = 420;
    const barX = (C.playfield.width - barW) / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(barX, 32, barW, 18);
    ctx.fillStyle = '#ff4f79';
    ctx.fillRect(barX + 2, 34, (barW - 4) * (b.health / b.maxHealth), 14);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(barX + 0.5, 32.5, barW - 1, 17);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(C.boss.name + '  PHASE ' + b.phase, C.playfield.width / 2, 24);
  };

  Game.prototype.drawFrenzyTimer = function (ctx) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = this.frenzyMode === 'fps' || this.frenzyMode === 'missile' ? '#ffe85f' : '#7dff8a';
    const labels = { invaders: 'INVADERS', fps: 'FPS', pinball: 'PINBALL', asteroids: 'ASTEROIDS', missile: 'MISSILE COMMAND', revenge: 'ARKANOID REVENGE', tenpin: '10-PIN', bomber: 'BOMBER' };
    ctx.fillText((labels[this.frenzyMode] || 'FRENZY') + '  ' + Math.max(0, this.frenzyRemaining).toFixed(1), C.playfield.width / 2, 58);
    if (this.state === BJ.State.FRENZY_ACTIVE) {
      const help = {
        fps: '← → STRAFE    WASD / MOUSE AIM    SPACE / CLICK FIRE    DODGE FALLING BRICKS',
        pinball: '←/A LEFT FLIPPER    →/D RIGHT FLIPPER    SPACE BOTH    ↑ NUDGE',
        asteroids: '←/A →/D ROTATE    ↑/W THRUST    SPACE FIRE',
        missile: 'WASD / MOUSE AIM    SPACE / CLICK INTERCEPT',
        revenge: '←/A →/D MOVE TOP PADDLE    RETURN FIRE',
        tenpin: '←/A →/D OR MOUSE AIM    HOLD SPACE FOR POWER    RELEASE TO BOWL',
        bomber: 'ARROWS / WASD FLY    SPACE FIRE'
      };
      if (help[this.frenzyMode]) { ctx.font = 'bold 11px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.78)'; ctx.fillText(help[this.frenzyMode], C.playfield.width / 2, C.playfield.height - 20); }
    }
    ctx.restore();
  };

  Game.prototype.drawHUD = function (ctx) {
    if (!this.seed) return;
    ctx.save();
    ctx.fillStyle = 'rgba(1, 6, 13, 0.78)';
    ctx.fillRect(0, 0, C.playfield.width, 54);
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#d9f6ff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('SCORE ' + U.formatScore(this.score), 18, 18);
    ctx.fillText('LEVEL ' + this.level, 18, 39);
    ctx.fillText('SEED ' + this.seed, 160, 39);

    ctx.textAlign = 'right';
    ctx.fillText('LIVES ' + this.lives, C.playfield.width - 18, 18);
    ctx.fillText('COMBO x' + this.combo + '  RAPID x' + this.rapidCombo, C.playfield.width - 18, 39);

    const effects = Object.keys(this.activePowerups);
    if (this.finalAssault.active) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 13px monospace';
      ctx.fillStyle = '#ffe85f';
      const assist = this.finalAssault.stage === 2 ? 'HUNTER++' : this.finalAssault.stage === 1 ? 'HUNTER+' : 'MAGNETIC';
      const speedPct = Math.round((this.getFinalAssaultSpeedMultiplier() - 1) * 100);
      ctx.fillText('FINAL ASSAULT  +' + speedPct + '%  ' + assist, C.playfield.width / 2, 39);
    }
    if (this.bigBomb && C.bigBomb.enabled && this.state !== BJ.State.LEVEL_COMPLETE) {
      ctx.textAlign = 'center';
      const barX = 337, barY = 58, barW = 286, barH = 14;
      const charge = U.clamp(this.bigBomb.charge || 0, 0, 100);
      const bombCount = Math.min(C.bigBomb.pickupsRequired, this.bigBomb.collected || 0);
      ctx.fillStyle = 'rgba(0,0,0,0.78)'; ctx.fillRect(barX, barY, barW, barH);
      ctx.strokeStyle = charge >= 100 && !this.bigBomb.used ? '#ffffff' : '#ffe85f'; ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
      ctx.fillStyle = this.bigBomb.used ? '#58626b' : (charge >= 100 ? '#ffffff' : '#ffe85f');
      ctx.fillRect(barX + 2, barY + 2, (barW - 4) * charge / 100, barH - 4);
      ctx.font = 'bold 10px monospace'; ctx.fillStyle = charge >= 100 && !this.bigBomb.used ? '#ffe85f' : '#d9f6ff';
      ctx.fillText(this.bigBomb.used ? 'BIG BOMB USED' : (charge >= 100 ? 'BIG BOMB READY  ↓' : 'BIG BOMB  ' + bombCount + '/' + C.bigBomb.pickupsRequired), C.playfield.width / 2, barY + 28);
    }
    if (effects.length) {
      ctx.textAlign = 'center';
      ctx.font = 'bold 12px monospace';
      const text = effects.map((function (type) {
        return C.powerups[type].label + ' ' + Math.ceil(this.activePowerups[type].remaining);
      }).bind(this)).join('  ');
      ctx.fillStyle = '#7dffb0';
      ctx.fillText(text, C.playfield.width / 2, 18);
    }
    ctx.restore();
  };

  Game.prototype.drawMessage = function (ctx) {
    if (this.messageTime <= 0 || !this.message) return;
    ctx.save();
    const a = U.clamp(this.messageTime * 2, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(140, C.playfield.height / 2 - 34, C.playfield.width - 280, 68);
    ctx.strokeStyle = '#4de8ff';
    ctx.strokeRect(140.5, C.playfield.height / 2 - 33.5, C.playfield.width - 281, 67);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.message, C.playfield.width / 2, C.playfield.height / 2);
    ctx.restore();
  };

  Game.prototype.drawDebug = function (ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.76)';
    const overrideRows = (BJ.DebugConfigOverrides && BJ.DebugConfigOverrides.active ? BJ.DebugConfigOverrides.active : []).map(function (o) { return 'CFG ' + o.path + '=' + o.value; });
    const invalidRows = (BJ.DebugConfigOverrides && BJ.DebugConfigOverrides.invalid ? BJ.DebugConfigOverrides.invalid : []).map(function (o) { return 'CFG! ' + o.path + ' (' + o.reason + ')'; });
    const debugHeight = 145 + Math.min(5, overrideRows.length + invalidRows.length) * 16;
    ctx.fillRect(6, 566 - Math.max(0, debugHeight - 145), 420, debugHeight);
    ctx.fillStyle = '#7dff8a';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    const ball = this.balls[0];
    const rows = [
      'DEBUG  FPS ' + this.fps.toFixed(1),
      'STATE ' + this.state,
      'SEED ' + this.seed,
      'RNG ' + this.rng.state(),
      'BRICKS ' + this.countAliveBricks() + ' BALLS ' + this.balls.length,
      'DROPS ' + this.powerDrops.length + ' SHOTS ' + (this.playerShots.length + this.enemyShots.length),
      'FPS CAM ' + this.fpsCamera.x.toFixed(1) + ' AIM ' + this.fpsAim.x.toFixed(0) + ',' + this.fpsAim.y.toFixed(0),
      'BALL V ' + (ball ? ball.vx.toFixed(1) + ',' + ball.vy.toFixed(1) : '-'),
      'INVULN ' + (this.debugInvulnerable ? 'ON' : 'OFF')
    ].concat(overrideRows, invalidRows).slice(0, 14);
    const startY = 584 - Math.max(0, debugHeight - 145);
    rows.forEach(function (row, i) { ctx.fillText(row, 14, startY + i * 16); });

    if (this.levelData) {
      ctx.strokeStyle = 'rgba(125,255,138,0.45)';
      this.levelData.bricks.forEach(function (b) { if (b.alive) ctx.strokeRect(b.x, b.y, b.w, b.h); });
      if (this.paddle) ctx.strokeRect(this.paddle.x, this.paddle.y, this.paddle.w, this.paddle.h);
    }
    ctx.restore();
  };

  Game.prototype.debugSpawnPowerup = function (type) {
    if (!C.powerups[type]) return;
    this.highScoreEligible = false;
    this.powerDrops.push({ type, x: this.paddle.x + this.paddle.w / 2 - 24, y: this.paddle.y - 160, w: 48, h: 20, vy: 150 });
  };

  Game.prototype.debugSpawnBigBombPower = function () {
    this.highScoreEligible = false;
    if (!this.bigBomb || this.bigBomb.used || this.bigBomb.charge >= 100) return false;
    this.powerDrops = this.powerDrops.filter(function (drop) { return drop.special !== 'big_bomb_power'; });
    const w = 66, h = 28;
    this.powerDrops.push({ special: 'big_bomb_power', type: null, x: this.paddle.x + this.paddle.w / 2 - w / 2, y: this.paddle.y - 170, w: w, h: h, vy: C.bigBomb.pickupFallSpeed });
    return true;
  };

  Game.prototype.debugAdvanceLevel = function () {
    this.highScoreEligible = false;
    this.completeLevel(false);
    this.intermissionRemaining = 0;
  };

  Game.prototype.debugDestroyRequired = function () {
    if (!this.levelData || this.levelData.boss) return;
    this.highScoreEligible = false;
    this.levelData.bricks.forEach(function (b) { if (b.type !== 'indestructible') b.alive = false; });
    this.checkLevelComplete();
  };

  Game.prototype.debugTriggerFrenzy = function (mode) {
    this.highScoreEligible = false;
    this.startFrenzy(mode || 'invaders');
  };

  Game.prototype.debugAddLife = function () {
    this.highScoreEligible = false;
    this.lives = Math.min(C.lives.max, this.lives + 1);
  };

  Game.prototype.debugJumpToBoss = function () {
    this.highScoreEligible = false;
    this.level = C.bossLevel;
    this.loadLevel(this.level, true);
    this.setState(BJ.State.BOSS);
  };

  BJ.Game = Game;
}(window));
