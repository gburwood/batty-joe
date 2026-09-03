/* Batty Joe Development Specification v1.7.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe;
  const tests = [];
  function test(name, fn) { tests.push({ name, fn }); }
  function assert(condition, message) { if (!condition) throw new Error(message || 'Assertion failed'); }
  function equal(actual, expected, message) { if (actual !== expected) throw new Error((message || 'Values differ') + ': expected ' + expected + ', got ' + actual); }
  function approx(actual, expected, epsilon, message) { if (Math.abs(actual - expected) > epsilon) throw new Error((message || 'Values differ') + ': expected ~' + expected + ', got ' + actual); }

  function makeInput(options) {
    options = options || {};
    const pressed = Object.assign({}, options.pressed || {});
    return {
      isDown(action) { return !!(options.actions && options.actions[action]); },
      isCodeDown(code) { return !!(options.codes && options.codes[code]); },
      wasPressed(action) { if (pressed[action]) { delete pressed[action]; return true; } return false; },
      wasMousePressed() { return false; },
      isMouseDown() { return !!options.mouseDown; },
      getPointer() { return options.pointer || { x: 480, y: 300, inside: false }; }
    };
  }

  function makeGame(options) {
    options = options || {};
    const canvas = document.getElementById('testCanvas');
    const audio = { play() {} };
    const game = new BJ.Game(canvas, { input: options.input || makeInput(), audio, settings: BJ.Utils.deepClone(BJ.DefaultSettings), debug: false });
    game.newCampaign({ seed: options.seed || 'TEST-SEED', difficulty: options.difficulty || 'normal', level: options.level || 1, debugModified: true });
    return game;
  }


  function advance(game, seconds) {
    let remaining = seconds;
    while (remaining > 0) {
      const step = Math.min(0.05, remaining);
      game.update(step);
      remaining -= step;
    }
  }

  function advanceUntil(game, predicate, timeoutSeconds) {
    let remaining = timeoutSeconds;
    while (!predicate() && remaining > 0) { game.update(0.05); remaining -= 0.05; }
    assert(predicate(), 'Timed out waiting for state transition');
  }

  function enterFrenzy(game, mode) {
    assert(game.startFrenzy(mode), mode + ' frenzy should start');
    equal(game.state, BJ.State.FRENZY_TRANSITION_IN, 'Frenzy should enter transition-in');
    assert(game.isPlayableState(), 'Transition-in must remain in the update loop');
    advanceUntil(game, function () { return game.state === BJ.State.FRENZY_ACTIVE; }, BJ.Config.frenzy.transitionIn + 0.5);
    assert(game.isPlayableState(), 'Active Frenzy must remain playable');
  }

  function exitFrenzy(game, reason) {
    game.beginFrenzyExit(reason || 'timeout');
    equal(game.state, BJ.State.FRENZY_TRANSITION_OUT, 'Frenzy should enter transition-out');
    assert(game.isPlayableState(), 'Transition-out must remain in the update loop');
    advanceUntil(game, function () { return !game.isFrenzyState(); }, BJ.Config.frenzy.transitionOut + 0.5);
  }

  function layoutSignature(level) {
    return JSON.stringify(level.bricks.map(function (b) { return [b.type, +b.x.toFixed(3), +b.y.toFixed(3), b.maxHits, b.regenMode, b.moveDirection, b.containedPowerup, b.seededDrop]; }));
  }

  test('seeded random generation is repeatable', function () {
    const a = BJ.Levels.generateLevel('ABC123', 'normal', 7);
    const b = BJ.Levels.generateLevel('ABC123', 'normal', 7);
    equal(layoutSignature(a), layoutSignature(b));
  });

  test('seeded gameplay RNG sequence is repeatable', function () {
    const a = BJ.Levels.campaignRng('SAME', 'hard', 12, 'gameplay');
    const b = BJ.Levels.campaignRng('SAME', 'hard', 12, 'gameplay');
    equal(JSON.stringify(Array.from({ length: 12 }, function () { return a(); })), JSON.stringify(Array.from({ length: 12 }, function () { return b(); })));
  });

  test('wide and narrow powerups replace each other', function () {
    const game = makeGame(); game.collectPowerup('wide'); game.collectPowerup('narrow'); assert(!game.activePowerups.wide); assert(game.activePowerups.narrow);
  });

  test('multiball splits existing balls without exceeding six', function () {
    const game = makeGame(); game.releaseHeldBalls(); game.collectPowerup('multiball'); game.collectPowerup('multiball'); game.collectPowerup('multiball'); equal(game.balls.length, 6);
  });

  test('final assault activates near end of round', function () {
    const game = makeGame();
    let survivorCount = 0;
    game.levelData.bricks.forEach(function (b) { if (b.type !== 'indestructible') { survivorCount += 1; if (survivorCount > game.finalAssault.threshold) b.alive = false; } });
    game.updateFinalAssault(0.016);
    assert(game.finalAssault.active, 'Final assault should start once threshold is reached');
  });

  test('final assault hunter assist stage escalates after no hits', function () {
    const game = makeGame();
    game.finalAssault.active = true;
    game.updateFinalAssault(BJ.Config.finalAssault.hunterAssistDelay1 + 0.1);
    equal(game.finalAssault.stage, 1);
    game.updateFinalAssault(BJ.Config.finalAssault.hunterAssistDelay2 - BJ.Config.finalAssault.hunterAssistDelay1 + 0.1);
    equal(game.finalAssault.stage, 2);
  });

  test('invaders frenzy transitions into active simulation and moves formation', function () {
    const game = makeGame({ level: 8 });
    game.collectPowerup('wide');
    const beforeTimer = game.activePowerups.wide.remaining;
    enterFrenzy(game, 'invaders');
    const target = game.levelData.bricks.find(function (b) { return b.alive; });
    const beforeX = target.x;
    advance(game, 0.25);
    assert(Math.abs(target.x - beforeX) > 0.01, 'Invader formation must move during active Frenzy');
    approx(game.activePowerups.wide.remaining, beforeTimer, 0.001, 'Power-up timer must remain paused during Frenzy');
    exitFrenzy(game, 'timeout');
    assert(game.activePowerups.wide, 'Wide should restore after Frenzy');
    approx(game.activePowerups.wide.remaining, beforeTimer, 0.001, 'Timer should resume from exact remaining duration');
  });

  test('frenzy restores exact held-ball and paddle snapshot', function () {
    const game = makeGame({ level: 8 });
    game.collectPowerup('sticky');
    game.paddle.x = 233; game.paddle.vx = 17;
    const ball = game.balls[0];
    ball.held = true; ball.launched = true; ball.holdRemaining = 2.5; ball.x = 260; ball.vx = 123; ball.vy = -345;
    const snapshot = BJ.Utils.deepClone({ ball: ball, paddle: game.paddle });
    enterFrenzy(game, 'invaders');
    game.paddle.x = 600;
    exitFrenzy(game, 'timeout');
    approx(game.paddle.x, snapshot.paddle.x, 0.001, 'Paddle x should restore exactly');
    approx(game.paddle.vx, snapshot.paddle.vx, 0.001, 'Paddle velocity should restore exactly');
    equal(game.balls[0].held, snapshot.ball.held, 'Held state should restore exactly');
    approx(game.balls[0].holdRemaining, snapshot.ball.holdRemaining, 0.001, 'Sticky hold timer should restore exactly');
    approx(game.balls[0].vx, snapshot.ball.vx, 0.001, 'Ball vx should restore exactly');
    approx(game.balls[0].vy, snapshot.ball.vy, 0.001, 'Ball vy should restore exactly');
  });

  test('fps frenzy is first-person and hides the normal paddle', function () {
    const game = makeGame({ level: 9 });
    const paddleSnapshot = BJ.Utils.deepClone(game.paddle);
    enterFrenzy(game, 'fps');
    assert(game.paddle.hidden, 'Normal paddle should be suspended and hidden in FPS Frenzy');
    assert(!game.shouldDrawPaddle(), 'FPS view must not render the paddle');
    approx(game.paddle.x, paddleSnapshot.x, 0.001, 'Entering FPS Frenzy must not repurpose paddle x as camera position');
    exitFrenzy(game, 'timeout');
    assert(!game.paddle.hidden, 'Paddle should be visible again after FPS Frenzy');
    approx(game.paddle.x, paddleSnapshot.x, 0.001, 'Paddle x should restore exactly');
  });

  test('fps brick depths are deterministic from campaign seed level and brick id', function () {
    const a = makeGame({ level: 9, seed: 'DEPTH-SEED' });
    const b = makeGame({ level: 9, seed: 'DEPTH-SEED' });
    const c = makeGame({ level: 9, seed: 'OTHER-SEED' });
    assert(a.startFrenzy('fps')); assert(b.startFrenzy('fps')); assert(c.startFrenzy('fps'));
    const da = a.levelData.bricks.filter(function (x) { return x.alive; }).map(function (x) { return [x.id, +x.frenzyMeta.depth.toFixed(6)]; });
    const db = b.levelData.bricks.filter(function (x) { return x.alive; }).map(function (x) { return [x.id, +x.frenzyMeta.depth.toFixed(6)]; });
    const dc = c.levelData.bricks.filter(function (x) { return x.alive; }).map(function (x) { return [x.id, +x.frenzyMeta.depth.toFixed(6)]; });
    equal(JSON.stringify(da), JSON.stringify(db), 'Same seed must reproduce identical FPS depth assignment');
    assert(JSON.stringify(da) !== JSON.stringify(dc), 'Different seed should alter FPS depth assignment');
    da.forEach(function (row) {
      assert(row[1] >= BJ.Config.frenzy.fps.depthMin && row[1] <= BJ.Config.frenzy.fps.depthMax, 'Depth must remain inside configured range');
    });
  });

  test('fps render order is far to near for occlusion', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    game.projectFpsBricks();
    const ordered = game.getFpsRenderBricks();
    for (let i = 1; i < ordered.length; i += 1) {
      assert(ordered[i - 1].frenzyMeta.depth >= ordered[i].frenzyMeta.depth, 'Farther bricks must render first');
    }
  });

  test('fps hitscan selects the nearest overlapping projected brick', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const bricks = game.levelData.bricks.filter(function (b) { return b.alive; }).slice(0, 2);
    assert(bricks.length === 2, 'Need two bricks');
    bricks[0].frenzyMeta.depth = 0.60;
    bricks[1].frenzyMeta.depth = 1.30;
    bricks[0].frenzyMeta.projected = { x: 400, y: 200, w: 100, h: 60 };
    bricks[1].frenzyMeta.projected = { x: 400, y: 200, w: 100, h: 60 };
    equal(game.getFpsHitscanTarget(450, 230).id, bricks[0].id, 'Closer overlapping brick should absorb hitscan');
  });

  test('fps arrow keys strafe camera without moving aim or suspended paddle', function () {
    const input = makeInput({ codes: { ArrowRight: true } });
    const game = makeGame({ level: 9, input: input });
    enterFrenzy(game, 'fps');
    const aimX = game.fpsAim.x;
    const paddleX = game.paddle.x;
    advance(game, 0.2);
    assert(game.fpsCamera.x > 0, 'ArrowRight should strafe camera right');
    approx(game.fpsAim.x, aimX, 0.001, 'Arrow strafe must not steer crosshair');
    approx(game.paddle.x, paddleX, 0.001, 'Arrow strafe must not move suspended paddle');
  });

  test('fps WASD controls crosshair without strafing camera', function () {
    const input = makeInput({ codes: { KeyD: true, KeyW: true } });
    const game = makeGame({ level: 9, input: input });
    enterFrenzy(game, 'fps');
    const aim = { x: game.fpsAim.x, y: game.fpsAim.y };
    advance(game, 0.2);
    assert(game.fpsAim.x > aim.x, 'D should move crosshair right');
    assert(game.fpsAim.y < aim.y, 'W should move crosshair up');
    approx(game.fpsCamera.x, 0, 0.001, 'WASD aiming must not strafe camera');
  });

  test('fps mouse controls full crosshair independently of camera', function () {
    const input = makeInput({ pointer: { x: 720, y: 180, inside: true } });
    const game = makeGame({ level: 9, input: input });
    enterFrenzy(game, 'fps');
    advance(game, 0.2);
    assert(game.fpsAim.x > 650 && game.fpsAim.y < 230, 'Mouse should drive crosshair toward pointer');
    approx(game.fpsCamera.x, 0, 0.001, 'Mouse aim must not move camera');
  });

  test('fps strafing changes target parallax without changing aim', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    game.projectFpsBricks();
    const brick = game.getFpsRenderBricks()[0];
    const xBefore = brick.frenzyMeta.projected.x;
    const aimBefore = { x: game.fpsAim.x, y: game.fpsAim.y };
    game.fpsCamera.x = 120;
    game.projectFpsBricks();
    assert(Math.abs(brick.frenzyMeta.projected.x - xBefore) > 1, 'Camera strafe must cause depth parallax');
    approx(game.fpsAim.x, aimBefore.x, 0.001, 'Parallax must not drag crosshair x');
    approx(game.fpsAim.y, aimBefore.y, 0.001, 'Parallax must not drag crosshair y');
  });


  test('fps frenzy creates no hostile perspective projectiles', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    advance(game, 3.0);
    assert(!game.enemyShots.some(function (shot) { return shot.mode === 'fps'; }), 'FPS Frenzy must not create perspective enemy projectiles');
  });

  test('fps falling brick keeps fixed world x after detaching', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const attack = game.spawnFpsFallingAttack();
    assert(attack, 'A falling attack should spawn');
    advance(game, BJ.Config.frenzy.fps.falling.telegraphSeconds + 0.1);
    equal(attack.phase, 'fall', 'Attack should enter fall after telegraph');
    const worldX = attack.worldX;
    game.fpsCamera.x = 160;
    game.updateFpsFallingAttacks(0.12);
    approx(attack.worldX, worldX, 0.0001, 'World x must remain locked throughout falling attack');
  });

  test('fps strafe changes falling brick screen position without curving world trajectory', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const attack = game.spawnFpsFallingAttack();
    attack.phase = 'fall'; attack.elapsed = 0; attack.screenY = 220; attack.vy = 360;
    game.updateFpsFallingAttacks(0.01);
    const x1 = attack.projected.x;
    const worldX = attack.worldX;
    game.fpsCamera.x = 120;
    game.updateFpsFallingAttacks(0.01);
    const x2 = attack.projected.x;
    approx(attack.worldX, worldX, 0.0001, 'Strafe must never modify attack world x');
    assert(Math.abs(x2 - x1) > 20, 'Camera strafe should move the attack on screen through viewpoint change');
  });

  test('fps falling brick telegraph precedes drop', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const attack = game.spawnFpsFallingAttack();
    equal(attack.phase, 'telegraph');
    game.updateFpsFallingAttacks(BJ.Config.frenzy.fps.falling.telegraphSeconds - 0.05);
    equal(attack.phase, 'telegraph', 'Attack must remain telegraphed for configured warning period');
    game.updateFpsFallingAttacks(0.06);
    equal(attack.phase, 'fall', 'Attack should only fall after warning period');
  });

  test('fps falling brick hit terminates frenzy without losing a normal life', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const lives = game.lives;
    const attack = game.spawnFpsFallingAttack();
    attack.phase = 'fall'; attack.worldX = game.getFpsPlayerWorldX();
    attack.screenY = BJ.Config.frenzy.fps.falling.impactY - 2;
    attack.vy = 400;
    game.updateFpsFallingAttacks(0.02);
    equal(game.state, BJ.State.FRENZY_TRANSITION_OUT, 'Falling brick collision should terminate FPS Frenzy');
    equal(game.lives, lives, 'FPS Frenzy collision must not cost a normal life');
  });

  test('fps falling brick can be destroyed by hitscan', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const attack = game.spawnFpsFallingAttack();
    const brick = attack.brick;
    brick.type = 'normal'; brick.maxHits = brick.hits = 1;
    attack.phase = 'fall'; attack.screenY = 260; attack.vy = 360;
    game.updateFpsFallingAttacks(0.01);
    const r = attack.projected;
    game.fpsAim.x = r.x + r.w / 2; game.fpsAim.y = r.y + r.h / 2;
    game.fireFpsHitscan();
    assert(!brick.alive, 'Hitscan should destroy a one-hit falling brick');
  });

  test('fps missed falling brick returns to formation with damage preserved', function () {
    const game = makeGame({ level: 9 });
    enterFrenzy(game, 'fps');
    const attack = game.spawnFpsFallingAttack();
    const brick = attack.brick;
    brick.type = 'multi_hit'; brick.maxHits = 3; brick.hits = 2;
    attack.phase = 'fall'; attack.worldX = game.getFpsPlayerWorldX() + 220;
    attack.screenY = BJ.Config.frenzy.fps.falling.impactY - 1; attack.vy = 420;
    game.updateFpsFallingAttacks(0.02);
    equal(attack.phase, 'recover', 'Missed attacker should begin recovery');
    advance(game, BJ.Config.frenzy.fps.falling.recoverySeconds + 0.1);
    assert(!brick.frenzyMeta.attack, 'Recovered brick should rejoin formation');
    equal(brick.hits, 2, 'Damage state must survive fall and recovery');
  });

  test('fps falling attacks obey simultaneous difficulty cap', function () {
    const game = makeGame({ level: 9, difficulty: 'easy' });
    enterFrenzy(game, 'fps');
    game.frenzyGame.attackCooldown = 0;
    game.updateFpsFrenzy(0.01);
    const first = game.frenzyGame.attacks.length;
    game.frenzyGame.attackCooldown = 0;
    game.updateFpsFrenzy(0.01);
    equal(first, 1, 'Easy should create one falling attack slot');
    equal(game.frenzyGame.attacks.length, 1, 'Easy must cap simultaneous attacks at one');
  });

  test('indestructible bricks can be damaged in fps frenzy', function () {
    const game = makeGame({ level: 15 });
    let brick = game.levelData.bricks.find(function (b) { return b.type === 'indestructible'; });
    if (!brick) { brick = game.levelData.bricks[0]; brick.type = 'indestructible'; brick.hits = brick.maxHits = 999; }
    assert(!game.damageBrick(brick, 1, { source: 'test', frenzy: false }));
    enterFrenzy(game, 'fps');
    const before = brick.hits; assert(game.damageBrick(brick, 1, { source: 'fps', frenzy: true })); assert(brick.hits < before);
  });

  test('both frenzy types activate safely with every normal power-up and key combinations', function () {
    const individual = ['wide', 'narrow', 'multiball', 'sticky', 'laser', 'slow_ball', 'fast_ball', 'extra_life', 'penetrating_ball', 'imprecise_paddle'];
    ['invaders', 'fps'].forEach(function (mode) {
      individual.forEach(function (power) {
        const game = makeGame({ level: 8 });
        game.collectPowerup(power);
        enterFrenzy(game, mode);
        advance(game, 0.1);
        assert(game.state === BJ.State.FRENZY_ACTIVE, mode + ' must remain active with ' + power);
      });
    });

    [
      ['multiball', 'laser', 'wide'],
      ['sticky', 'wide', 'laser'],
      ['penetrating_ball', 'slow_ball'],
      ['penetrating_ball', 'fast_ball'],
      ['imprecise_paddle', 'multiball', 'laser']
    ].forEach(function (powers) {
      const game = makeGame({ level: 8 });
      powers.forEach(function (p) { game.collectPowerup(p); });
      enterFrenzy(game, 'invaders');
      advance(game, 0.1);
      equal(game.state, BJ.State.FRENZY_ACTIVE);
    });
  });

  test('frenzy rejects re-entrant activation while transitioning or active', function () {
    const game = makeGame({ level: 8 });
    assert(game.startFrenzy('invaders'));
    assert(!game.startFrenzy('fps'), 'Second Frenzy must be rejected during transition');
    advanceUntil(game, function () { return game.state === BJ.State.FRENZY_ACTIVE; }, BJ.Config.frenzy.transitionIn + 0.5);
    assert(!game.startFrenzy('fps'), 'Second Frenzy must be rejected while active');
  });

  test('frenzy full clear completes level', function () {
    const game = makeGame({ level: 8 });
    enterFrenzy(game, 'invaders');
    game.levelData.bricks.forEach(function (b) { b.alive = false; });
    game.updateInvadersFrenzy(0.016);
    equal(game.state, BJ.State.LEVEL_COMPLETE);
  });

  test('continue restarts current level and resets score', function () {
    const game = makeGame({ level: 5 });
    const original = layoutSignature(game.levelInitial);
    game.score = 99999; game.lives = 0; game.continuesRemaining = 3; game.setState(BJ.State.CONTINUE); game.useContinue();
    equal(game.score, 0); equal(game.lives, BJ.Config.lives.start); equal(game.continuesRemaining, 2); equal(layoutSignature(game.levelData), original);
  });

  test('boss transitions phases by health threshold', function () {
    const game = makeGame({ level: 20 }); equal(game.levelData.boss.phase, 1); game.levelData.boss.health = 60; game.updateBoss(0.016); equal(game.levelData.boss.phase, 2); game.levelData.boss.health = 30; game.updateBoss(0.016); equal(game.levelData.boss.phase, 3);
  });

  test('moving paddle imparts signed ball spin', function () {
    const rightBall = { x: 150, y: 100, r: 8, vx: 0, vy: 400, spin: 0 };
    BJ.Physics.bounceFromPaddle(rightBall, { x: 100, y: 100, w: 100, h: 18, vx: 500 });
    assert(rightBall.spin > 0, 'Right-moving paddle should impart positive spin');
    const leftBall = { x: 150, y: 100, r: 8, vx: 0, vy: 400, spin: 0 };
    BJ.Physics.bounceFromPaddle(leftBall, { x: 100, y: 100, w: 100, h: 18, vx: -500 });
    assert(leftBall.spin < 0, 'Left-moving paddle should impart negative spin');
  });

  test('moving paddle temporarily boosts ball speed', function () {
    const target = 400;
    const ball = { x: 200, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
    const result = BJ.Physics.bounceFromPaddle(ball, { x: 100, y: 100, w: 100, h: 18, vx: BJ.Config.paddle.maxSpeed }, target);
    assert(result.boostPercent > 0, 'Moving paddle should create a temporary boost');
    assert(BJ.Physics.length(ball.vx, ball.vy) > target, 'Boosted ball must exceed target speed');
    assert(BJ.Physics.length(ball.vx, ball.vy) <= target * (1 + BJ.Config.physics.paddleVelocityTransfer.maxBoostPercent) + 0.001, 'Boost must respect configured cap');
  });

  test('faster paddle produces greater temporary speed boost', function () {
    const target = 400;
    const slow = { x: 200, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
    const fast = { x: 200, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
    BJ.Physics.bounceFromPaddle(slow, { x: 100, y: 100, w: 100, h: 18, vx: BJ.Config.paddle.maxSpeed * 0.25 }, target);
    BJ.Physics.bounceFromPaddle(fast, { x: 100, y: 100, w: 100, h: 18, vx: BJ.Config.paddle.maxSpeed }, target);
    assert(BJ.Physics.length(fast.vx, fast.vy) > BJ.Physics.length(slow.vx, slow.vy), 'Faster paddle should create more speed');
  });

  test('edge paddle contact boosts more than centre contact', function () {
    const target = 400, paddle = { x: 100, y: 100, w: 100, h: 18, vx: BJ.Config.paddle.maxSpeed };
    const centre = { x: 150, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
    const edge = { x: 198, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
    BJ.Physics.bounceFromPaddle(centre, paddle, target);
    BJ.Physics.bounceFromPaddle(edge, paddle, target);
    assert(BJ.Physics.length(edge.vx, edge.vy) > BJ.Physics.length(centre.vx, centre.vy), 'Edge contact should use larger configured contact factor');
  });

  test('stationary paddle creates no motion-derived speed boost', function () {
    const target = 400, ball = { x: 150, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
    const result = BJ.Physics.bounceFromPaddle(ball, { x: 100, y: 100, w: 100, h: 18, vx: 0 }, target);
    approx(result.boostPercent, 0, 0.000001);
    approx(BJ.Physics.length(ball.vx, ball.vy), target, 0.001);
  });

  test('temporary paddle speed boost decays toward current target speed', function () {
    const target = 400, ball = { vx: 0, vy: -500, spin: 0, paddleSpeedBoost: 0.25 };
    const before = BJ.Physics.length(ball.vx, ball.vy);
    BJ.Physics.decayPaddleSpeedBoost(ball, BJ.Config.physics.paddleVelocityTransfer.decayHalfLifeSeconds, target, BJ.Config.physics.paddleVelocityTransfer);
    const after = BJ.Physics.length(ball.vx, ball.vy);
    assert(after < before && after > target, 'Boost should decay without snapping immediately to target');
    approx(after, 450, 0.01, 'One half-life should halve excess speed');
  });

  test('disabled paddle velocity transfer restores no-boost behaviour', function () {
    const cfg = BJ.Config.physics.paddleVelocityTransfer, old = cfg.enabled;
    cfg.enabled = false;
    try {
      const target = 400, ball = { x: 198, y: 100, r: 8, vx: 0, vy: target, spin: 0 };
      BJ.Physics.bounceFromPaddle(ball, { x: 100, y: 100, w: 100, h: 18, vx: BJ.Config.paddle.maxSpeed }, target);
      approx(BJ.Physics.length(ball.vx, ball.vy), target, 0.001);
    } finally { cfg.enabled = old; }
  });

  test('spin curves flight, decays, and preserves speed', function () {
    const ball = { vx: 300, vy: -300, spin: 0.8 };
    const speed = BJ.Physics.length(ball.vx, ball.vy);
    const beforeAngle = Math.atan2(ball.vy, ball.vx);
    BJ.Physics.applySpin(ball, 0.5, BJ.Config.spin);
    const afterAngle = Math.atan2(ball.vy, ball.vx);
    assert(Math.abs(afterAngle - beforeAngle) > 0.001, 'Spin should change heading');
    approx(BJ.Physics.length(ball.vx, ball.vy), speed, 0.001, 'Spin must preserve speed');
    assert(ball.spin < 0.8, 'Spin should decay');
  });

  test('multiball stores independent spin values', function () {
    const game = makeGame();
    game.releaseHeldBalls();
    game.balls[0].spin = 0.42;
    game.collectPowerup('multiball');
    equal(game.balls.length, 2);
    assert(game.balls[0].spin !== game.balls[1].spin, 'Split ball should receive independent spin state');
  });

  test('final assault magnetic stage activates after ten seconds', function () {
    const game = makeGame();
    game.finalAssault.active = true;
    game.finalAssault.noHitTime = 0;
    game.updateFinalAssault(BJ.Config.finalAssault.magneticAssistDelay + 0.01);
    equal(game.finalAssault.stage, 3);
  });

  test('final assault magnetism preserves speed and vertical direction', function () {
    const game = makeGame();
    game.finalAssault.active = true; game.finalAssault.stage = 3;
    game.levelData.bricks.forEach(function (b, i) { if (b.type !== 'indestructible') b.alive = i === 0; });
    let target = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
    if (!target) { target = game.levelData.bricks[0]; target.alive = true; target.type = 'normal'; }
    target.x = 520; target.y = 180;
    const ball = { x: 320, y: 390, r: 8, vx: 180, vy: -320, spin: 0 };
    const speed = BJ.Physics.length(ball.vx, ball.vy), sign = Math.sign(ball.vy);
    game.applyFinalAssaultMagnetism(ball, 0.5);
    approx(BJ.Physics.length(ball.vx, ball.vy), speed, 0.001, 'Magnetism must preserve speed');
    equal(Math.sign(ball.vy), sign, 'Magnetism must not reverse vertical direction');
  });

  test('spin plus magnetism respects combined steering cap', function () {
    const game = makeGame(); game.finalAssault.active = true; game.finalAssault.stage = 3;
    game.levelData.bricks.forEach(function (b) { b.alive = false; });
    const target = game.levelData.bricks[0]; target.alive = true; target.type = 'normal'; target.x = 700; target.y = 130;
    const ball = { x: 250, y: 420, r: 8, vx: 250, vy: -250, spin: 1 };
    const dt = 0.5;
    const before = Math.atan2(ball.vy, ball.vx);
    const spinTurn = BJ.Physics.applySpin(ball, dt, BJ.Config.spin);
    game.applyFinalAssaultMagnetism(ball, dt, spinTurn);
    let diff = Math.atan2(ball.vy, ball.vx) - before;
    while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
    const cap = BJ.Config.finalAssault.magneticCombinedCapDegreesPerSecond * Math.PI / 180 * dt;
    assert(Math.abs(diff) <= cap + 0.0001, 'Combined steering must respect configured cap');
  });

  test('final assault default helper reset policy is destroyed only', function () {
    equal(BJ.Config.finalAssault.helperResetPolicy, 'destroyed_only');
  });

  test('non-destroying required brick hit does not reset helpers under destroyed_only', function () {
    const game = makeGame(); game.finalAssault.active = true; game.finalAssault.stage = 3; game.finalAssault.noHitTime = 12;
    const brick = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
    brick.hits = brick.maxHits = Math.max(2, brick.maxHits || 2);
    game.damageBrick(brick, 1, { source: 'test', frenzy: false });
    equal(game.finalAssault.stage, 3); approx(game.finalAssault.noHitTime, 12, 0.001);
  });

  test('destroying required brick resets helpers under destroyed_only', function () {
    const game = makeGame(); game.finalAssault.active = true; game.finalAssault.stage = 3; game.finalAssault.noHitTime = 12;
    const brick = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
    brick.hits = 1; brick.maxHits = Math.max(1, brick.maxHits);
    game.damageBrick(brick, 1, { source: 'test', frenzy: false });
    equal(game.finalAssault.stage, 0); approx(game.finalAssault.noHitTime, 0, 0.001);
  });

  test('never helper policy does not reset on hit or destruction', function () {
    const oldPolicy = BJ.Config.finalAssault.helperResetPolicy;
    BJ.Config.finalAssault.helperResetPolicy = 'never';
    try {
      const game = makeGame(); game.finalAssault.active = true; game.finalAssault.stage = 3; game.finalAssault.noHitTime = 12;
      const brick = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
      brick.hits = 1; game.damageBrick(brick, 1, { source: 'test', frenzy: false });
      equal(game.finalAssault.stage, 3); approx(game.finalAssault.noHitTime, 12, 0.001);
    } finally { BJ.Config.finalAssault.helperResetPolicy = oldPolicy; }
  });

  test('any_hit helper policy resets on non-destroying hit', function () {
    const oldPolicy = BJ.Config.finalAssault.helperResetPolicy;
    BJ.Config.finalAssault.helperResetPolicy = 'any_hit';
    try {
      const game = makeGame(); game.finalAssault.active = true; game.finalAssault.stage = 2; game.finalAssault.noHitTime = 8;
      const brick = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
      brick.hits = brick.maxHits = 3; game.damageBrick(brick, 1, { source: 'test', frenzy: false });
      equal(game.finalAssault.stage, 0); approx(game.finalAssault.noHitTime, 0, 0.001);
    } finally { BJ.Config.finalAssault.helperResetPolicy = oldPolicy; }
  });

  test('all six frenzy modes complete transition lifecycle safely', function () {
    ['invaders', 'fps', 'pinball', 'asteroids', 'missile', 'revenge', 'gridrunner'].forEach(function (mode) {
      const game = makeGame({ level: 8, seed: 'MODE-' + mode });
      game.collectPowerup('wide');
      const timer = game.activePowerups.wide.remaining;
      enterFrenzy(game, mode);
      advance(game, 0.05);
      equal(game.state, BJ.State.FRENZY_ACTIVE, mode + ' should remain active');
      exitFrenzy(game, 'timeout');
      assert(game.activePowerups.wide, mode + ' should restore normal powerups');
      approx(game.activePowerups.wide.remaining, timer, 0.001, mode + ' should pause powerup timers');
    });
  });

  test('frenzy per-type and total occurrence caps are enforced', function () {
    const game = makeGame({ level: 8 });
    enterFrenzy(game, 'pinball'); exitFrenzy(game, 'timeout');
    assert(!game.startFrenzy('pinball'), 'Same type must respect per-level cap');
    enterFrenzy(game, 'asteroids'); exitFrenzy(game, 'timeout');
    assert(!game.startFrenzy('missile'), 'Third Frenzy must respect total-per-level cap');
    equal(game.frenzyTotalThisLevel, 2);
  });

  test('pinball central drain exits without normal life loss', function () {
    const game = makeGame({ level: 8 }); const lives = game.lives;
    enterFrenzy(game, 'pinball');
    game.frenzyGame.ball.x = (BJ.Config.frenzy.pinball.centralDrain.minX + BJ.Config.frenzy.pinball.centralDrain.maxX) / 2;
    game.frenzyGame.ball.y = BJ.Config.frenzy.pinball.drainY + 50;
    game.updatePinballFrenzy(0.016);
    equal(game.state, BJ.State.FRENZY_TRANSITION_OUT);
    equal(game.lives, lives);
  });

  test('pinball outlane is a valid unreachable drain route', function () {
    const game = makeGame({ level: 8 });
    enterFrenzy(game, 'pinball');
    const out = BJ.Config.frenzy.pinball.outlanes.left;
    game.frenzyGame.ball.x = (out.minX + out.maxX) / 2;
    game.frenzyGame.ball.y = out.entryY + 60;
    game.frenzyGame.ball.vx = 0; game.frenzyGame.ball.vy = 240;
    game.updatePinballFrenzy(0.016);
    equal(game.frenzyGame.committedDrain, 'left_outlane');
    const leftSeg = game.getPinballFlipperSegment(game.frenzyGame.leftFlipper);
    assert(Math.min(leftSeg.ax, leftSeg.bx) > out.maxX, 'Left flipper must not reach committed outlane');
  });

  test('pinball bottom is solid outside defined drains', function () {
    const game = makeGame({ level: 8 });
    enterFrenzy(game, 'pinball');
    game.frenzyGame.ball.x = 250;
    game.frenzyGame.ball.y = BJ.Config.frenzy.pinball.drainY + 4;
    game.frenzyGame.ball.vx = 0; game.frenzyGame.ball.vy = 260;
    game.updatePinballFrenzy(0.016);
    equal(game.state, BJ.State.FRENZY_ACTIVE);
    assert(!game.frenzyGame.committedDrain, 'Safe floor must not become a drain');
    assert(game.frenzyGame.ball.vy < 0, 'Safe lower boundary should bounce the ball upward');
  });

  test('pinball funnel rail redirects a descending outer trajectory inward', function () {
    const game = makeGame({ level: 8 });
    enterFrenzy(game, 'pinball');
    const rail = BJ.Config.frenzy.pinball.funnelGuides.left;
    const ball = game.frenzyGame.ball;
    const t = 0.55;
    ball.x = rail.ax + (rail.bx - rail.ax) * t + 12;
    ball.y = rail.ay + (rail.by - rail.ay) * t - 7;
    ball.vx = -180; ball.vy = 260;
    game.resolvePinballLowerGeometry(ball);
    assert(ball.vx > -180 || ball.vy < 260, 'Funnel rail must alter the incoming trajectory');
    assert(ball.x > BJ.Config.frenzy.pinball.outlanes.left.maxX, 'Funnel collision must remain in the playable return area');
  });

  test('asteroid drift is deterministic from campaign seed and brick id', function () {
    const a = makeGame({ level: 8, seed: 'AST-SEED' }), b = makeGame({ level: 8, seed: 'AST-SEED' });
    assert(a.startFrenzy('asteroids')); assert(b.startFrenzy('asteroids'));
    const av = a.levelData.bricks.filter(function (x) { return x.alive; }).map(function (x) { return [x.id, +x.frenzyMeta.vx.toFixed(5), +x.frenzyMeta.vy.toFixed(5)]; });
    const bv = b.levelData.bricks.filter(function (x) { return x.alive; }).map(function (x) { return [x.id, +x.frenzyMeta.vx.toFixed(5), +x.frenzyMeta.vy.toFixed(5)]; });
    equal(JSON.stringify(av), JSON.stringify(bv));
  });

  test('missile interception blast damages a battery', function () {
    const game = makeGame({ level: 8 }); enterFrenzy(game, 'missile');
    const brick = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
    const before = brick.hits;
    game.frenzyGame.blasts.push({ x: brick.x + brick.w / 2, y: brick.y + brick.h / 2, life: 0.45, maxLife: 0.9, radius: 0, hitIds: Object.create(null) });
    game.updateMissileFrenzy(0.01);
    assert(!brick.alive || brick.hits < before, 'Blast should damage battery');
  });

  test('arkanoid revenge ball damages enemy segment and reflects', function () {
    const game = makeGame({ level: 8 }); enterFrenzy(game, 'revenge');
    const segment = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; }) || game.levelData.bricks.find(function (b) { return b.alive; });
    const before = segment.hits;
    game.frenzyGame.ball = { x: segment.x + segment.w / 2, y: segment.y - 5, r: 8, vx: 0, vy: 300, spin: 0 };
    game.updateRevengeFrenzy(0.02);
    assert(!segment.alive || segment.hits < before, 'Enemy segment should take damage');
    assert(game.frenzyGame.ball && game.frenzyGame.ball.vy < 0, 'Ball should reflect upward');
  });


  test('query config override requires debug true', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?cfg.finalAssault.helperResetPolicy=never');
    equal(r.active.length, 0); equal(r.config.finalAssault.helperResetPolicy, 'destroyed_only');
  });

  test('query config override coerces number boolean and string leaves', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.finalAssault.hunterAssistDelay1=3&cfg.finalAssault.enabled=false&cfg.finalAssault.helperResetPolicy=never');
    equal(r.config.finalAssault.hunterAssistDelay1, 3); equal(r.config.finalAssault.enabled, false); equal(r.config.finalAssault.helperResetPolicy, 'never');
  });

  test('query config override rejects unknown path and invalid enum', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.no.such.value=7&cfg.finalAssault.helperResetPolicy=banana');
    equal(r.active.length, 0); equal(r.invalid.length, 2); equal(r.config.finalAssault.helperResetPolicy, 'destroyed_only');
  });

  test('query config override rejects object replacement', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.finalAssault=%7B%7D');
    equal(r.active.length, 0); assert(r.invalid.length === 1 && r.invalid[0].reason === 'non_primitive_leaf');
  });

  test('query config duplicate values use last value', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.finalAssault.hunterAssistDelay1=2&cfg.finalAssault.hunterAssistDelay1=5');
    equal(r.config.finalAssault.hunterAssistDelay1, 5); equal(r.active.length, 1);
  });

  test('query config aliases from specification examples resolve', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.frenzy.totalMaxPerLevel=6&cfg.frenzy.fps.fallingBrick.warningSeconds=1&cfg.finalAssault.magneticAssist.maxHeadingDegreesPerSecond=12');
    equal(r.config.frenzy.maxTotalPerLevel, 6); equal(r.config.frenzy.fps.falling.telegraphSeconds, 1); equal(r.config.finalAssault.magnetismMaxDegreesPerSecond, 12);
  });

  test('query config override does not mutate static config', function () {
    const before = BJ.StaticConfig.finalAssault.hunterAssistDelay1;
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.finalAssault.hunterAssistDelay1=1');
    equal(r.config.finalAssault.hunterAssistDelay1, 1); equal(BJ.StaticConfig.finalAssault.hunterAssistDelay1, before);
  });


  test('Final Assault explosion-chain helper reset is coalesced per simulation step', function () {
    const game = makeGame();
    game.finalAssault.active = true; game.finalAssault.stage = 3; game.finalAssault.noHitTime = 12;
    game.simulationStep = 42;
    const bricks = game.levelData.bricks.filter(function (b) { return b.alive && b.type !== 'indestructible'; }).slice(0, 2);
    assert(bricks.length === 2, 'Test requires two required bricks');
    const a = bricks[0], b = bricks[1];
    a.type = 'explosive'; a.hits = a.maxHits = 1;
    b.type = 'explosive'; b.hits = b.maxHits = 1; b.x = a.x + a.w + 1; b.y = a.y;
    let resets = 0;
    const original = game.handleFinalAssaultProgress;
    game.handleFinalAssaultProgress = function (brick, destroyed, context) {
      const didReset = original.call(this, brick, destroyed, context);
      if (didReset) resets += 1;
      return didReset;
    };
    game.damageBrick(a, 1, { source: 'test', frenzy: false, chainDepth: 0 });
    equal(resets, 1, 'A chain event must reset helper progress at most once in one simulation step');
  });

  test('non-required indestructible contact never resets Final Assault helpers', function () {
    const game = makeGame(); game.finalAssault.active = true; game.finalAssault.stage = 3; game.finalAssault.noHitTime = 12;
    const brick = game.levelData.bricks[0]; brick.type = 'indestructible'; brick.alive = true; brick.hits = brick.maxHits = 999;
    game.damageBrick(brick, 1, { source: 'test', frenzy: false });
    equal(game.finalAssault.stage, 3); approx(game.finalAssault.noHitTime, 12, 0.001);
  });

  test('debug-modified campaign is high-score ineligible', function () {
    const canvas = document.getElementById('testCanvas');
    const game = new BJ.Game(canvas, { input: makeInput(), audio: { play() {} }, settings: BJ.Utils.deepClone(BJ.DefaultSettings), debug: true });
    game.newCampaign({ seed: 'DEBUG-RUN', difficulty: 'normal', debugModified: true });
    equal(game.highScoreEligible, false);
  });

  test('query config overrides are not persisted into saved user settings', function () {
    BJ.Storage.clearAllForTests();
    const runtime = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.finalAssault.helperResetPolicy=never');
    equal(runtime.config.finalAssault.helperResetPolicy, 'never');
    const settings = BJ.Utils.deepClone(BJ.DefaultSettings); settings.musicVolume = 0.17;
    BJ.Storage.saveSettings(settings);
    const loaded = BJ.Storage.loadSettings();
    equal(loaded.musicVolume, 0.17);
    assert(!Object.prototype.hasOwnProperty.call(loaded, 'finalAssault'), 'Runtime config must not leak into settings persistence');
  });

  test('v1.3 Final Assault speed ramps continuously to +35 percent over fifteen seconds', function () {
    const game = makeGame(); game.finalAssault.active = true; game.finalAssault.elapsed = 0;
    approx(game.getFinalAssaultSpeedMultiplier(), 1.0, 0.0001);
    game.finalAssault.elapsed = BJ.Config.finalAssault.speedRampSeconds / 2;
    approx(game.getFinalAssaultSpeedMultiplier(), 1.175, 0.0001);
    game.finalAssault.elapsed = BJ.Config.finalAssault.speedRampSeconds * 2;
    approx(game.getFinalAssaultSpeedMultiplier(), 1.35, 0.0001);
  });

  test('v1.3 Final Assault magnetism ramps from six to thirty degrees per second', function () {
    const game = makeGame(); game.finalAssault.active = true; game.finalAssault.elapsed = 0;
    approx(game.getFinalAssaultMagneticDegreesPerSecond(), 6, 0.0001);
    game.finalAssault.elapsed = BJ.Config.finalAssault.magneticRampSeconds;
    approx(game.getFinalAssaultMagneticDegreesPerSecond(), 30, 0.0001);
  });

  test('v1.5 Big Bomb does not charge from time hits destruction or paddle contacts', function () {
    const game = makeGame(); const brick=game.levelData.bricks.find(function(b){return b.alive&&b.type!=='indestructible';}); const before=game.bigBomb.charge;
    game.updateBigBomb(120); game.chargeBigBombFromBrick(brick,false,{}); game.chargeBigBombFromBrick(brick,true,{}); game.chargeBigBombFromPaddleContact(game.balls[0]);
    approx(game.bigBomb.charge,before,0.001);
  });

  test('v1.5 Big Bomb independent seeded spawner is repeatable and not a brick drop', function () {
    const a=makeGame({seed:'BOMB-SEED'}), b=makeGame({seed:'BOMB-SEED'});
    a.bigBomb.spawnTimer=0;b.bigBomb.spawnTimer=0;a.updateBigBomb(0.01);b.updateBigBomb(0.01);
    const da=a.powerDrops.find(function(d){return d.special==='big_bomb_power';});const db=b.powerDrops.find(function(d){return d.special==='big_bomb_power';});
    assert(da&&db,'Independent Big Bomb pickups should spawn'); approx(da.x,db.x,0.001); equal(da.type,null); assert(!BJ.Config.powerups.big_bomb_power,'Big Bomb power must not join normal powerup table');
  });

  test('v1.5 collecting configured Big Bomb Power pickups arms one bomb', function () {
    const game=makeGame(); for(let i=0;i<BJ.Config.bigBomb.pickupsRequired;i+=1) assert(game.collectBigBombPowerUp());
    equal(game.bigBomb.collected,BJ.Config.bigBomb.pickupsRequired);approx(game.bigBomb.charge,100,0.001);assert(game.bigBomb.readyAnnounced);
  });

  test('v1.5 Big Bomb Power does not spawn once ready or used', function () {
    const game=makeGame();game.bigBomb.charge=100;game.bigBomb.spawnTimer=0;game.updateBigBomb(.1);assert(!game.powerDrops.some(function(d){return d.special==='big_bomb_power';}));
    game.bigBomb.charge=0;game.bigBomb.used=true;game.bigBomb.spawnTimer=0;game.updateBigBomb(.1);assert(!game.powerDrops.some(function(d){return d.special==='big_bomb_power';}));
  });

  test('v1.5 Big Bomb pickup progress survives life loss', function () {
    const game=makeGame();game.collectBigBombPowerUp();const count=game.bigBomb.collected;game.loseLife();equal(game.bigBomb.collected,count);
  });

  test('v1.5 Frenzy restores Big Bomb pickup progress and independent spawner state', function () {
    const game=makeGame({level:8,seed:'BB-FRENZY'});game.collectBigBombPowerUp();game.bigBomb.spawnTimer=7.25;const rng=game.bigBombRng.state();enterFrenzy(game,'invaders');exitFrenzy(game,'timeout');equal(game.bigBomb.collected,1);approx(game.bigBomb.spawnTimer,7.25,.001);equal(game.bigBombRng.state(),rng);
  });

  test('v1.5 armed Big Bomb still deploys with Down action and damages destructible bricks', function () {
    const game=makeGame({input:makeInput({pressed:{bigBomb:true}})});game.bigBomb.collected=BJ.Config.bigBomb.pickupsRequired;game.bigBomb.charge=100;
    const target=game.levelData.bricks.find(function(b){return b.alive&&b.type!=='indestructible'&&b.maxHits>=2;})||game.levelData.bricks.find(function(b){return b.alive&&b.type!=='indestructible';});const before=target.hits;game.updateBigBomb(.01);assert(game.bigBomb.used);assert(!target.alive||target.hits===before-BJ.Config.bigBomb.damage);
  });

  test('v1.4 Pinball Frenzy defaults to ninety seconds and narrower thirty-pixel outlanes', function () {
    const game = makeGame({ level: 8 });
    equal(BJ.Config.frenzy.pinball.outlaneWidth, 30);
    assert(game.startFrenzy('pinball'));
    approx(game.frenzyRemaining, 90, 0.001);
    const left = game.getPinballOutlaneBounds('left');
    approx(left.maxX - left.minX, 30, 0.001);
  });

  test('v1.4 Pinball restitution loses collision energy', function () {
    const ball = { x: 100, y: 100, r: 8, vx: 300, vy: 200, spin: 0 };
    const before = BJ.Physics.length(ball.vx, ball.vy);
    BJ.Physics.scaleVelocity(ball, BJ.Config.frenzy.pinball.restitution.default, BJ.Config.frenzy.pinball.restitution.minSpeed, BJ.Config.frenzy.pinball.restitution.maxSpeed);
    assert(BJ.Physics.length(ball.vx, ball.vy) < before, 'Pinball restitution should reduce speed');
  });

  test('v1.4 moving paddle imparts dominant stronger spin', function () {
    const ball = { x: 500, y: 640, r: 8, vx: 0, vy: 400, spin: 0 };
    const paddle = { x: 420, y: 650, w: 160, h: 18, vx: BJ.Config.paddle.maxSpeed };
    BJ.Physics.bounceFromPaddle(ball, paddle);
    assert(ball.spin > 0.80, 'Maximum-speed moving paddle should impart strong spin');
  });

  test('v1.4 spin changes brick rebound angle', function () {
    const rect = { x: 100, y: 100, w: 80, h: 25 };
    const a = { x: 130, y: 90, r: 8, vx: 80, vy: 300, spin: 0, collisionSequence: 0 };
    const b = { x: 130, y: 90, r: 8, vx: 80, vy: 300, spin: 1, collisionSequence: 0 };
    const prev = { x: 130, y: 80 };
    BJ.Physics.resolveBallRect(a, rect, prev, { characterise: true, kind: 'brick', signature: 'same' });
    BJ.Physics.resolveBallRect(b, rect, prev, { characterise: true, kind: 'brick', signature: 'same' });
    assert(Math.abs(Math.atan2(a.vy, a.vx) - Math.atan2(b.vy, b.vx)) > 0.02, 'Spin should visibly alter rebound heading');
  });

  test('v1.4 imperfect brick rebound is deterministic but not a perfect mirror', function () {
    const rect = { x: 100, y: 100, w: 80, h: 25 };
    function run() {
      const ball = { x: 130, y: 90, r: 8, vx: 80, vy: 300, spin: 0, collisionSequence: 0 };
      BJ.Physics.resolveBallRect(ball, rect, { x: 130, y: 80 }, { characterise: true, kind: 'brick', signature: 'deterministic-brick' });
      return { vx: ball.vx, vy: ball.vy };
    }
    const a = run(), b = run();
    approx(a.vx, b.vx, 0.000001); approx(a.vy, b.vy, 0.000001);
    assert(Math.abs(a.vx - 80) > 0.01, 'Imperfect rebound should deviate from the exact mirror heading');
  });

  test('v1.4 screen-edge rebound uses deterministic imperfection and preserves speed', function () {
    function run() {
      const ball = { x: 3, y: 200, r: 8, vx: -250, vy: -210, spin: 0, collisionSequence: 0 };
      const before = BJ.Physics.length(ball.vx, ball.vy);
      BJ.Physics.integrateBall(ball, 0.016, 960, 720);
      return { ball: ball, speed: before };
    }
    const a = run(), b = run();
    approx(a.ball.vx, b.ball.vx, 0.000001); approx(a.ball.vy, b.ball.vy, 0.000001);
    approx(BJ.Physics.length(a.ball.vx, a.ball.vy), a.speed, 0.001);
    assert(a.ball.vx > 0, 'Left-edge rebound must still move away from the wall');
  });

  test('v1.4 physics and Big Bomb tuning can be overridden via cfg query parameters', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.physics.ball.spin.paddleVelocityContribution=1&cfg.physics.collision.brickImperfectionDegrees=5&cfg.frenzy.pinball.outlaneWidth=24&cfg.frenzy.pinball.ballRestitution=0.75&cfg.bigBomb.pickupsRequired=2&cfg.bigBomb.spawnMinSeconds=10');
    equal(r.config.spin.paddleVelocityContribution, 1);
    equal(r.config.collision.imperfectRebound.brickDegrees, 5);
    equal(r.config.frenzy.pinball.outlaneWidth, 24);
    equal(r.config.frenzy.pinball.restitution.default, 0.75);
    equal(r.config.bigBomb.pickupsRequired, 2);
    equal(r.config.bigBomb.spawnMinSeconds, 10);
  });

  test('v1.4 spin changes screen-edge rebound angle', function () {
    function run(spin) {
      const ball = { x: 3, y: 200, r: 8, vx: -250, vy: -210, spin: spin, collisionSequence: 0 };
      BJ.Physics.integrateBall(ball, 0.016, 960, 720);
      return Math.atan2(ball.vy, ball.vx);
    }
    assert(Math.abs(run(0) - run(1)) > 0.02, 'Spin should alter screen-edge bounce heading');
  });

  test('v1.4 opposite fast paddle motion can reverse imparted spin', function () {
    const ball = { x: 500, y: 640, r: 8, vx: 0, vy: 400, spin: 0.8 };
    const paddle = { x: 420, y: 650, w: 160, h: 18, vx: -BJ.Config.paddle.maxSpeed };
    BJ.Physics.bounceFromPaddle(ball, paddle);
    assert(ball.spin < -0.80, 'Fast opposite paddle motion should reverse spin sign');
  });

  test('v1.4 imperfect rebound still enforces minimum vertical component', function () {
    const rect = { x: 100, y: 100, w: 80, h: 25 };
    const ball = { x: 90, y: 112, r: 8, vx: 300, vy: 8, spin: 1, collisionSequence: 0 };
    const speedBefore = BJ.Physics.length(ball.vx, ball.vy);
    BJ.Physics.resolveBallRect(ball, rect, { x: 80, y: 112 }, { characterise: true, kind: 'brick', signature: 'shallow-side' });
    const speed = BJ.Physics.length(ball.vx, ball.vy);
    assert(Math.abs(ball.vy) >= speed * 0.219, 'Minimum vertical component must survive rebound characterisation');
    approx(speed, speedBefore, 0.001, 'Characterisation should preserve speed');
  });

  test('v1.4 Pinball funnel rails are less bouncy than ordinary targets', function () {
    const game = makeGame({ level: 8 });
    assert(game.getPinballRestitution('funnelRail') < game.getPinballRestitution('brickTarget'));
  });

  test('v1.4 Pinball master restitution query scales actual surface restitution', function () {
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.frenzy.pinball.ballRestitution=0.75');
    const original = BJ.Config;
    BJ.Config = r.config;
    const canvas = document.getElementById('testCanvas');
    const game = new BJ.Game(canvas, { input: makeInput(), audio: { play() {} }, settings: BJ.Utils.deepClone(BJ.DefaultSettings), debug: true });
    const scaled = game.getPinballRestitution('wall');
    BJ.Config = original;
    assert(scaled < BJ.StaticConfig.frenzy.pinball.restitution.wall, 'Master restitution should lower actual wall restitution');
  });

  test('v1.4 level restart resets Big Bomb state', function () {
    const game = makeGame(); game.bigBomb.charge = 87; game.bigBomb.collected = 2; game.bigBomb.used = true;
    game.restartLevel();
    approx(game.bigBomb.charge, 0, 0.001); equal(game.bigBomb.collected, 0); equal(game.bigBomb.used, false);
  });

  test('v1.4 Frenzy brick actions do not charge Big Bomb', function () {
    const game = makeGame({ level: 8 }); game.bigBomb.charge = 25;
    enterFrenzy(game, 'invaders');
    const brick = game.levelData.bricks.find(function (b) { return b.alive && b.type !== 'indestructible'; });
    brick.maxHits = brick.hits = Math.max(2, brick.hits || 2);
    game.damageBrick(brick, 1, { source: 'test-frenzy', frenzy: true });
    approx(game.bigBomb.charge, 25, 0.001);
    exitFrenzy(game, 'timeout');
  });

  test('v1.4.1 starting-ball centre release is vertical', function () {
    const game = makeGame();
    const ball = game.balls[0];
    ball.x = game.paddle.x + game.paddle.w / 2;
    game.releaseBall(ball);
    approx(ball.vx, 0, 0.001, 'Centre release should have no meaningful horizontal velocity');
    assert(ball.vy < 0, 'Release should travel upward');
  });

  test('v1.4.1 held-ball release angle follows position across bat', function () {
    const leftGame = makeGame();
    const leftBall = leftGame.balls[0];
    leftBall.x = leftGame.paddle.x + leftBall.r;
    leftGame.releaseBall(leftBall);
    assert(leftBall.vx < -100, 'Left-edge release should launch left');

    const rightGame = makeGame();
    const rightBall = rightGame.balls[0];
    rightBall.x = rightGame.paddle.x + rightGame.paddle.w - rightBall.r;
    rightGame.releaseBall(rightBall);
    assert(rightBall.vx > 100, 'Right-edge release should launch right');
  });

  test('v1.4.1 moving bat underneath held starting ball changes its eventual launch angle', function () {
    const game = makeGame({ input: makeInput({ actions: { right: true } }) });
    const ball = game.balls[0];
    const originalBallX = ball.x;
    game.updatePaddle(0.10);
    approx(ball.x, originalBallX, 0.001, 'Held ball should remain in world position while bat can slide underneath it');
    assert(ball.x < game.paddle.x + game.paddle.w / 2, 'Moving bat right should move held ball toward left side relative to bat');
    game.releaseBall(ball);
    assert(ball.vx < 0, 'Ball should launch left after bat slides right underneath it');
  });

  test('v1.4.1 sticky release uses caught position on bat', function () {
    const game = makeGame();
    game.collectPowerup('sticky');
    const ball = game.balls[0];
    ball.held = true; ball.launched = true; ball.holdRemaining = 2;
    ball.x = game.paddle.x + game.paddle.w - ball.r;
    game.releaseBall(ball);
    assert(ball.vx > 100, 'Sticky ball held near right edge should release right');
  });

  test('v1.4.1 Pinball apron geometry is continuous around only three drain routes', function () {
    const game = makeGame({ level: 8 });
    const cfg = BJ.Config.frenzy.pinball;
    const left = game.getPinballOutlaneBounds('left');
    const right = game.getPinballOutlaneBounds('right');
    const segments = game.getPinballApronSegments();
    const names = segments.map(function (x) { return x.name; });
    ['left-shoulder','left-funnel-join','left-funnel','left-apron-join','left-central-apron',
     'right-shoulder','right-funnel-join','right-funnel','right-apron-join','right-central-apron',
     'left-outlane-outer','left-outlane-inner','right-outlane-inner','right-outlane-outer'].forEach(function (name) {
      assert(names.indexOf(name) >= 0, 'Missing apron segment ' + name);
    });
    const leftJoin = segments.find(function (x) { return x.name === 'left-funnel-join'; });
    approx(leftJoin.ax, left.maxX, 0.001, 'Left funnel must meet inner outlane edge');
    approx(leftJoin.ay, left.entryY, 0.001, 'Left funnel must meet outlane entrance height');
    const rightJoin = segments.find(function (x) { return x.name === 'right-funnel-join'; });
    approx(rightJoin.ax, right.minX, 0.001, 'Right funnel must meet inner outlane edge');
    approx(rightJoin.ay, right.entryY, 0.001, 'Right funnel must meet outlane entrance height');
    equal(game.getPinballDrainRoute({ x: left.centreX, y: left.entryY + 2 }), 'left_outlane');
    equal(game.getPinballDrainRoute({ x: right.centreX, y: right.entryY + 2 }), 'right_outlane');
    equal(game.getPinballDrainRoute({ x: (cfg.centralDrain.minX + cfg.centralDrain.maxX) / 2, y: cfg.centralDrain.commitY + 2 }), 'central_gap');
  });

  test('v1.4.1 Pinball side-entry into an outlane is blocked by channel wall', function () {
    const game = makeGame({ level: 8 });
    const left = game.getPinballOutlaneBounds('left');
    game.frenzyGame = { committedDrain: null };
    const ball = { x: left.maxX + 4, y: left.entryY + 55, r: 9, vx: -220, vy: 80, spin: 0 };
    game.resolvePinballLowerGeometry(ball);
    assert(!game.frenzyGame.committedDrain, 'Ball approaching channel from the side must not become a drain');
    assert(ball.x >= left.maxX + ball.r - 0.5, 'Inner channel wall should push the ball back into the main playfield');
  });

  test('v1.4.1 Pinball bottom is solid outside declared drains', function () {
    const game = makeGame({ level: 8 });
    game.frenzyGame = { committedDrain: null };
    const cfg = BJ.Config.frenzy.pinball;
    const ball = { x: 300, y: cfg.drainY - 2, r: 9, vx: 20, vy: 220, spin: 0 };
    game.resolvePinballLowerGeometry(ball);
    assert(!game.frenzyGame.committedDrain, 'Safe lower position must not be classified as drain');
    assert(ball.y <= cfg.drainY - ball.r + 0.001, 'Solid bottom safety boundary must keep ball in play');
    assert(ball.vy < 0, 'Solid lower boundary should return ball upward');
  });

  test('v1.4.1 Pinball flipper power config is stronger and query-tunable', function () {
    const fp = BJ.Config.frenzy.pinball.flipperPower;
    assert(fp.baseImpulseMultiplier >= 1.35, 'Flipper base multiplier should compensate for gravity');
    assert(fp.tipVelocityBonusMultiplier >= 1.20, 'Outer-tip contacts should be stronger');
    const r = BJ.ConfigTools.buildRuntimeConfig(BJ.StaticConfig, '?debug=true&cfg.frenzy.pinball.flipperPower=1.6&cfg.frenzy.pinball.flipperTipBonus=1.3');
    approx(r.config.frenzy.pinball.flipperPower.baseImpulseMultiplier, 1.6, 0.001);
    approx(r.config.frenzy.pinball.flipperPower.tipVelocityBonusMultiplier, 1.3, 0.001);
  });

  test('v1.4.1 powered Pinball flipper imparts substantially more energy', function () {
    const game = makeGame({ level: 8 });
    enterFrenzy(game, 'pinball');
    const f = game.frenzyGame.leftFlipper;
    f.active = true; f.powerWindow = BJ.Config.frenzy.pinball.flipperPower.swingWindowSeconds; f.powerSpent = false;
    const seg = game.getPinballFlipperSegment(f);
    const ball = game.frenzyGame.ball;
    ball.x = (seg.ax + seg.bx) / 2;
    ball.y = (seg.ay + seg.by) / 2;
    ball.vx = 20; ball.vy = 220;
    const before = BJ.Physics.length(ball.vx, ball.vy);
    game.updatePinballFrenzy(0.001);
    const after = BJ.Physics.length(ball.vx, ball.vy);
    assert(f.powerSpent, 'Powered swing should be consumed on contact');
    assert(after > before * 2.2, 'Powered flipper should strongly accelerate the ball against gravity');
    assert(ball.vy < 0, 'Powered flipper should send the ball upward');
  });

  test('v1.4.1 held Pinball flipper cannot repeatedly re-arm power', function () {
    const game = makeGame({ level: 8, input: makeInput({ codes: { ArrowLeft: true } }) });
    game.frenzyGame = {
      type: 'pinball', nudgeCooldown: 0, ball: { x: 480, y: 400, vx: 0, vy: 0, r: 9 },
      leftFlipper: Object.assign({ side: 'left', active: false, powerWindow: 0, powerSpent: false }, BJ.Config.frenzy.pinball.flippers.left),
      rightFlipper: Object.assign({ side: 'right', active: false, powerWindow: 0, powerSpent: false }, BJ.Config.frenzy.pinball.flippers.right)
    };
    game.updatePinballInput(0.01);
    assert(game.frenzyGame.leftFlipper.powerWindow > 0, 'Initial key press should arm swing power');
    game.frenzyGame.leftFlipper.powerSpent = true;
    game.updatePinballInput(0.01);
    assert(game.frenzyGame.leftFlipper.powerSpent, 'Holding key must not re-arm spent swing');
    game.input = makeInput({ codes: {} });
    game.updatePinballInput(0.01);
    equal(game.frenzyGame.leftFlipper.powerSpent, false, 'Release should reset swing readiness for the next press');
  });

  test('high scores are combined and capped at ten', function () {
    BJ.Storage.clearAllForTests();
    for (let i = 0; i < 13; i += 1) BJ.Storage.addHighScore({ initials: 'TST', score: i * 100, difficulty: i % 2 ? 'hard' : 'easy', levelReached: i, campaignSeed: 'S' + i, date: new Date(2026, 0, i + 1).toISOString() });
    const rows = BJ.Storage.loadHighScores(); equal(rows.length, 10); equal(rows[0].score, 1200);
  });

  function renderResult(name, status, error) {
    const results = document.getElementById('results');
    const div = document.createElement('div'); div.className = 'test ' + (status ? 'pass' : 'fail'); div.textContent = (status ? 'PASS  ' : 'FAIL  ') + name;
    if (error) { const pre = document.createElement('pre'); pre.textContent = error.stack || String(error); div.appendChild(pre); }
    results.appendChild(div);
  }
  

  

  

  

  

  test('v1.5 all eight frenzy aliases normalise correctly', function () {
    const game=makeGame();['invaders','fps','pinball','asteroids','missile','revenge','gridrunner'].forEach(function(mode){equal(game.normalizeFrenzyMode(mode),mode);});equal(game.normalizeFrenzyMode('grid_runner_frenzy'),'gridrunner');
  });

  function run() {
    let passed = 0;
    tests.forEach(function (t) { try { t.fn(); passed += 1; renderResult(t.name, true); } catch (error) { renderResult(t.name, false, error); } });
    const summary = document.getElementById('summary'); summary.className = passed === tests.length ? 'pass' : 'fail'; summary.textContent = passed + ' / ' + tests.length + ' tests passed.'; BJ.Storage.clearAllForTests();
  }
  global.addEventListener('load', run);
}(window));
  test('v1.7 retired frenzy identifiers are unavailable', function () {
    const game = makeGame({ level: 8 });
    equal(game.normalizeFrenzyMode('tenpin'), null); equal(game.normalizeFrenzyMode('bomber'), null); assert(!game.startFrenzy('tenpin')); assert(!game.startFrenzy('bomber'));
    assert(!BJ.Config.powerups.ten_pin_frenzy); assert(!BJ.Config.powerups.bomber_frenzy);
  });

  test('v1.7 level complete protects celebration hold before next prompt', function () {
    const game = makeGame({ level: 8 }); game.completeLevel(false);
    equal(game.intermissionPhase, 'hold'); game.intermissionRemaining = 1; game.input = { wasPressed: function(){ return true; } }; game.update(0.1);
    equal(game.state, BJ.State.LEVEL_COMPLETE); equal(game.intermissionPhase, 'hold');
    game.intermissionRemaining = 0.01; game.update(0.02); equal(game.intermissionPhase, 'prompt');
  });

  test('v1.7 grid runner can start and maps deterministic nodes', function () {
    const a=makeGame({level:8}), b=makeGame({level:8}); a.startFrenzy('gridrunner'); b.startFrenzy('gridrunner');
    equal(a.frenzyMode,'gridrunner'); equal(b.frenzyMode,'gridrunner');
    equal(a.levelData.bricks.map(function(x){return x.frenzyMeta&&[x.frenzyMeta.gridX,x.frenzyMeta.gridY];}).join('|'), b.levelData.bricks.map(function(x){return x.frenzyMeta&&[x.frenzyMeta.gridX,x.frenzyMeta.gridY];}).join('|'));
  });

