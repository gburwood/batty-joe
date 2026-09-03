/* Batty Joe Development Specification v1.7.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};
  const U = BJ.Utils;

  function length(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  function normalizeVelocity(ball, desiredSpeed) {
    const mag = length(ball.vx, ball.vy) || 1;
    const speed = desiredSpeed || mag;
    ball.vx = ball.vx / mag * speed;
    ball.vy = ball.vy / mag * speed;
    const minVertical = speed * 0.22;
    if (Math.abs(ball.vy) < minVertical) {
      const sign = ball.vy < 0 ? -1 : 1;
      ball.vy = minVertical * sign;
      const vxMag = Math.sqrt(Math.max(0, speed * speed - ball.vy * ball.vy));
      ball.vx = (ball.vx < 0 ? -1 : 1) * vxMag;
    }
  }

  function rotateVelocity(ball, radians) {
    if (!radians) return;
    const cos = Math.cos(radians), sin = Math.sin(radians);
    const vx = ball.vx, vy = ball.vy;
    ball.vx = vx * cos - vy * sin;
    ball.vy = vx * sin + vy * cos;
  }

  function hashString(text) {
    let h = 2166136261 >>> 0;
    const str = String(text || '');
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15;
    return h >>> 0;
  }

  function nextCollisionVariation(ball, signature, maxDegrees) {
    if (!maxDegrees) return 0;
    ball.collisionSequence = (ball.collisionSequence || 0) + 1;
    const h = hashString(String(signature || 'bounce') + '|' + ball.collisionSequence);
    const unit = (h / 4294967295) * 2 - 1;
    return unit * maxDegrees;
  }

  function applyReboundCharacter(ball, kind, normalX, normalY, signature) {
    const speed = Math.max(1, length(ball.vx, ball.vy));
    const idealVx = ball.vx, idealVy = ball.vy;
    const collisionCfg = BJ.Config && BJ.Config.collision && BJ.Config.collision.imperfectRebound;
    const spinCfg = BJ.Config && BJ.Config.spin;
    let imperfectDegrees = 0;
    let spinDegrees = 0;

    if (collisionCfg && collisionCfg.enabled) {
      const max = kind === 'edge' ? collisionCfg.edgeDegrees : collisionCfg.brickDegrees;
      imperfectDegrees = nextCollisionVariation(ball, signature || kind, max);
    }
    if (spinCfg && spinCfg.enabled) {
      const maxSpin = kind === 'edge' ? spinCfg.edgeBounceDeflectionDegrees : spinCfg.brickBounceDeflectionDegrees;
      spinDegrees = (ball.spin || 0) * (maxSpin || 0);
    }

    rotateVelocity(ball, (imperfectDegrees + spinDegrees) * Math.PI / 180);
    if (ball.vx * normalX + ball.vy * normalY <= 0) {
      ball.vx = idealVx;
      ball.vy = idealVy;
    }
    normalizeVelocity(ball, speed);
    return { imperfectDegrees: imperfectDegrees, spinDegrees: spinDegrees };
  }

  function circleRect(ball, rect) {
    const closestX = U.clamp(ball.x, rect.x, rect.x + rect.w);
    const closestY = U.clamp(ball.y, rect.y, rect.y + rect.h);
    const dx = ball.x - closestX;
    const dy = ball.y - closestY;
    return dx * dx + dy * dy <= ball.r * ball.r;
  }

  function rectRect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function closestPointOnSegment(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const denom = abx * abx + aby * aby || 1;
    const t = U.clamp(((px - ax) * abx + (py - ay) * aby) / denom, 0, 1);
    return { x: ax + abx * t, y: ay + aby * t, t };
  }

  function circleSegment(ball, segment, thickness) {
    const c = closestPointOnSegment(ball.x, ball.y, segment.ax, segment.ay, segment.bx, segment.by);
    const dx = ball.x - c.x, dy = ball.y - c.y;
    const radius = ball.r + (thickness || 0) * 0.5;
    return { hit: dx * dx + dy * dy <= radius * radius, point: c, dx, dy, radius };
  }

  function resolveBallSegment(ball, segment, thickness, restitution) {
    const hit = circleSegment(ball, segment, thickness);
    if (!hit.hit) return false;
    let nx = hit.dx, ny = hit.dy;
    let mag = Math.sqrt(nx * nx + ny * ny);
    if (mag < 0.0001) {
      const sx = segment.bx - segment.ax, sy = segment.by - segment.ay;
      mag = Math.sqrt(sx * sx + sy * sy) || 1;
      nx = -sy / mag; ny = sx / mag; mag = 1;
    }
    nx /= mag; ny /= mag;
    const penetration = Math.max(0, hit.radius - mag) + 0.25;
    ball.x += nx * penetration; ball.y += ny * penetration;
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      const e = restitution == null ? 0.9 : restitution;
      ball.vx -= (1 + e) * vn * nx;
      ball.vy -= (1 + e) * vn * ny;
    }
    return true;
  }

  function resolveBallRect(ball, rect, previous, options) {
    const prev = previous || { x: ball.x - ball.vx * 0.016, y: ball.y - ball.vy * 0.016 };
    const wasLeft = prev.x + ball.r <= rect.x;
    const wasRight = prev.x - ball.r >= rect.x + rect.w;
    const wasAbove = prev.y + ball.r <= rect.y;
    const wasBelow = prev.y - ball.r >= rect.y + rect.h;
    let side, nx = 0, ny = 0;

    if (wasLeft) {
      ball.x = rect.x - ball.r - 0.01;
      ball.vx = -Math.abs(ball.vx); side = 'left'; nx = -1;
    } else if (wasRight) {
      ball.x = rect.x + rect.w + ball.r + 0.01;
      ball.vx = Math.abs(ball.vx); side = 'right'; nx = 1;
    } else if (wasAbove) {
      ball.y = rect.y - ball.r - 0.01;
      ball.vy = -Math.abs(ball.vy); side = 'top'; ny = -1;
    } else if (wasBelow) {
      ball.y = rect.y + rect.h + ball.r + 0.01;
      ball.vy = Math.abs(ball.vy); side = 'bottom'; ny = 1;
    } else {
      const leftPen = Math.abs((ball.x + ball.r) - rect.x);
      const rightPen = Math.abs((rect.x + rect.w) - (ball.x - ball.r));
      const topPen = Math.abs((ball.y + ball.r) - rect.y);
      const bottomPen = Math.abs((rect.y + rect.h) - (ball.y - ball.r));
      const min = Math.min(leftPen, rightPen, topPen, bottomPen);
      if (min === leftPen || min === rightPen) {
        ball.vx *= -1; side = min === leftPen ? 'left' : 'right'; nx = side === 'left' ? -1 : 1;
      } else {
        ball.vy *= -1; side = min === topPen ? 'top' : 'bottom'; ny = side === 'top' ? -1 : 1;
      }
    }

    if (options && options.characterise) {
      applyReboundCharacter(ball, options.kind || 'brick', nx, ny, options.signature || ('rect-' + side));
    }
    return side;
  }

  function releaseFromPaddle(ball, paddle, speed, maxAngleDegrees) {
    const usableHalfWidth = Math.max(1, paddle.w / 2 - (ball.r || 0));
    const relative = U.clamp((ball.x - (paddle.x + paddle.w / 2)) / usableHalfWidth, -1, 1);
    const maxAngle = (Number.isFinite(maxAngleDegrees) ? maxAngleDegrees : 60) * Math.PI / 180;
    const angle = relative * maxAngle;
    const launchSpeed = Math.max(1, speed || length(ball.vx, ball.vy));
    ball.vx = Math.sin(angle) * launchSpeed;
    ball.vy = -Math.abs(Math.cos(angle) * launchSpeed);
    normalizeVelocity(ball, launchSpeed);
    return { relative: relative, angleDegrees: angle * 180 / Math.PI };
  }

  function bounceFromPaddle(ball, paddle, targetSpeed) {
    const relative = U.clamp((ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2), -1, 1);
    const currentSpeed = Math.max(1, length(ball.vx, ball.vy));
    const effectiveTargetSpeed = Math.max(1, Number(targetSpeed) || currentSpeed);
    const inheritedSpin = ball.spin || 0;
    const spinCfg = BJ.Config && BJ.Config.spin;
    const transferCfg = BJ.Config && BJ.Config.physics && BJ.Config.physics.paddleVelocityTransfer;
    const inheritedDeflection = spinCfg && spinCfg.enabled ? inheritedSpin * (spinCfg.paddleBounceDeflectionDegrees || 0) * Math.PI / 180 : 0;
    const maxAngle = Math.PI * 0.39;
    const angle = relative * maxAngle + inheritedDeflection;
    ball.vx = Math.sin(angle) * currentSpeed + paddle.vx * 0.10;
    ball.vy = -Math.abs(Math.cos(angle) * currentSpeed);

    let boostedSpeed = effectiveTargetSpeed;
    let boostPercent = 0;
    if (transferCfg && transferCfg.enabled) {
      const maxPaddleSpeed = Math.max(1, BJ.Config.paddle.maxSpeed);
      const motionFactor = U.clamp(Math.abs(paddle.vx || 0) / maxPaddleSpeed, 0, 1);
      const centreFactor = Number.isFinite(transferCfg.centreContactFactor) ? transferCfg.centreContactFactor : 0.55;
      const edgeFactor = Number.isFinite(transferCfg.edgeContactFactor) ? transferCfg.edgeContactFactor : 1;
      const contactFactor = centreFactor + (edgeFactor - centreFactor) * Math.abs(relative);
      const maxBoost = Math.max(0, Number(transferCfg.maxBoostPercent) || 0);
      boostPercent = maxBoost * motionFactor * contactFactor;
      boostedSpeed = effectiveTargetSpeed * (1 + Math.min(maxBoost, boostPercent));
    }
    ball.paddleSpeedBoost = boostPercent;
    normalizeVelocity(ball, boostedSpeed);

    if (spinCfg && spinCfg.enabled) {
      const velocityPart = U.clamp((paddle.vx || 0) / Math.max(1, BJ.Config.paddle.maxSpeed), -1, 1) * spinCfg.paddleVelocityContribution;
      const offsetPart = relative * spinCfg.contactOffsetContribution;
      const maxAbs = spinCfg.maxAbs || 1;
      ball.spin = U.clamp(velocityPart + offsetPart, -maxAbs, maxAbs);
    }
    return { relative: relative, boostPercent: boostPercent, speed: boostedSpeed };
  }

  function decayPaddleSpeedBoost(ball, dt, targetSpeed, config) {
    if (!ball) return 0;
    config = config || (BJ.Config && BJ.Config.physics && BJ.Config.physics.paddleVelocityTransfer);
    const target = Math.max(1, Number(targetSpeed) || length(ball.vx, ball.vy));
    if (!config || !config.enabled) {
      ball.paddleSpeedBoost = 0;
      normalizeVelocity(ball, target);
      return target;
    }
    const current = Math.max(1, length(ball.vx, ball.vy));
    if (current <= target + 0.001) {
      ball.paddleSpeedBoost = 0;
      normalizeVelocity(ball, target);
      return target;
    }
    const halfLife = Math.max(0.001, Number(config.decayHalfLifeSeconds) || 0.65);
    const decay = Math.pow(0.5, Math.max(0, dt) / halfLife);
    const next = target + (current - target) * decay;
    ball.paddleSpeedBoost = Math.max(0, next / target - 1);
    normalizeVelocity(ball, next);
    return next;
  }

  function integrateBall(ball, dt, width, height) {
    const previous = { x: ball.x, y: ball.y, hitWallX: false, hitWallY: false };
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    if (ball.x - ball.r < 0) {
      ball.x = ball.r;
      ball.vx = Math.abs(ball.vx);
      applyReboundCharacter(ball, 'edge', 1, 0, 'screen-left');
      previous.hitWallX = true;
    } else if (ball.x + ball.r > width) {
      ball.x = width - ball.r;
      ball.vx = -Math.abs(ball.vx);
      applyReboundCharacter(ball, 'edge', -1, 0, 'screen-right');
      previous.hitWallX = true;
    }
    if (ball.y - ball.r < 0) {
      ball.y = ball.r;
      ball.vy = Math.abs(ball.vy);
      applyReboundCharacter(ball, 'edge', 0, 1, 'screen-top');
      previous.hitWallY = true;
    }
    return previous;
  }

  function applySpin(ball, dt, config) {
    config = config || (BJ.Config && BJ.Config.spin);
    if (!config || !config.enabled || !ball || Math.abs(ball.spin || 0) < config.snapThreshold) {
      if (ball && Math.abs(ball.spin || 0) < (config ? config.snapThreshold : 0.02)) ball.spin = 0;
      return 0;
    }
    const speed = Math.max(1, length(ball.vx, ball.vy));
    const heading = Math.atan2(ball.vy, ball.vx);
    const delta = (config.maxHeadingDegreesPerSecond * Math.PI / 180) * ball.spin * dt;
    const next = heading + delta;
    ball.vx = Math.cos(next) * speed;
    ball.vy = Math.sin(next) * speed;
    const decay = Math.pow(0.5, dt / Math.max(0.001, config.halfLifeSeconds));
    ball.spin *= decay;
    if (Math.abs(ball.spin) < config.snapThreshold) ball.spin = 0;
    return delta;
  }

  function retainSpin(ball, factor) {
    if (!ball) return;
    ball.spin = (ball.spin || 0) * factor;
  }

  function steerVelocity(ball, targetAngle, maxDelta) {
    const speed = Math.max(1, length(ball.vx, ball.vy));
    let current = Math.atan2(ball.vy, ball.vx);
    let diff = targetAngle - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    diff = U.clamp(diff, -maxDelta, maxDelta);
    current += diff;
    ball.vx = Math.cos(current) * speed;
    ball.vy = Math.sin(current) * speed;
    return diff;
  }

  function scaleVelocity(ball, factor, minSpeed, maxSpeed) {
    const current = Math.max(0.0001, length(ball.vx, ball.vy));
    const target = U.clamp(current * factor, minSpeed == null ? 0 : minSpeed, maxSpeed == null ? Infinity : maxSpeed);
    ball.vx = ball.vx / current * target;
    ball.vy = ball.vy / current * target;
    return target;
  }

  BJ.Physics = {
    length,
    normalizeVelocity,
    rotateVelocity,
    applyReboundCharacter,
    circleRect,
    rectRect,
    closestPointOnSegment,
    circleSegment,
    resolveBallSegment,
    resolveBallRect,
    releaseFromPaddle,
    bounceFromPaddle,
    decayPaddleSpeedBoost,
    integrateBall,
    applySpin,
    retainSpin,
    steerVelocity,
    scaleVelocity,

    acceleratedSpeed(base, max, level, elapsed, accelerationFactor) {
      const levelBoost = 1 + Math.max(0, level - 1) * 0.018;
      const timeBoost = 1 + Math.min(0.28, elapsed * 0.0018 * accelerationFactor);
      return Math.min(max, base * levelBoost * timeBoost);
    }
  };
}(window));
