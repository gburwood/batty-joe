/* Batty Joe Development Specification v1.5.0 */
(function (global) {
  'use strict';

  const BJ = global.BattyJoe = global.BattyJoe || {};

  function AudioEngine(settings) {
    this.settings = settings || BJ.Storage.loadSettings();
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.musicTimer = null;
    this.musicStep = 0;
  }

  AudioEngine.prototype.ensure = function () {
    if (this.ctx) return this.ctx;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.musicGain = this.ctx.createGain();
    this.sfxGain.connect(this.master);
    this.musicGain.connect(this.master);
    this.master.connect(this.ctx.destination);
    this.applySettings(this.settings);
    return this.ctx;
  };

  AudioEngine.prototype.resume = function () {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () {});
  };

  AudioEngine.prototype.applySettings = function (settings) {
    this.settings = settings;
    if (!this.ctx) return;
    const muted = settings.globalMute ? 0 : 1;
    this.master.gain.value = muted;
    this.sfxGain.gain.value = settings.sfxEnabled ? Number(settings.sfxVolume) : 0;
    this.musicGain.gain.value = settings.musicEnabled ? Number(settings.musicVolume) : 0;
    if (settings.musicEnabled && !settings.globalMute) this.startMusic(); else this.stopMusic();
  };

  AudioEngine.prototype.tone = function (freq, duration, type, volume, destination, slideTo) {
    const ctx = this.ensure();
    if (!ctx || this.settings.globalMute) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + duration);
    gain.gain.setValueAtTime(Math.max(0.0001, volume || 0.08), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(destination || this.sfxGain);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  };

  AudioEngine.prototype.noise = function (duration, volume) {
    const ctx = this.ensure();
    if (!ctx || this.settings.globalMute || !this.settings.sfxEnabled) return;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = volume || 0.06;
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(this.sfxGain);
    src.start();
  };

  AudioEngine.prototype.play = function (name) {
    if (!this.settings.sfxEnabled || this.settings.globalMute) return;
    this.resume();
    switch (name) {
      case 'paddle_hit': this.tone(150, 0.05, 'square', 0.08, this.sfxGain, 220); break;
      case 'brick_hit': this.tone(310, 0.045, 'square', 0.055, this.sfxGain, 260); break;
      case 'brick_break': this.tone(480, 0.08, 'square', 0.07, this.sfxGain, 220); break;
      case 'powerup_collect': this.tone(420, 0.14, 'triangle', 0.09, this.sfxGain, 880); break;
      case 'laser': this.tone(720, 0.055, 'sawtooth', 0.05, this.sfxGain, 280); break;
      case 'explosion': this.noise(0.18, 0.11); this.tone(100, 0.18, 'sawtooth', 0.07, this.sfxGain, 45); break;
      case 'big_bomb_power': this.tone(330, 0.10, 'triangle', 0.08, this.sfxGain, 660); this.tone(660, 0.12, 'triangle', 0.05, this.sfxGain, 990); break;
      case 'bowling_roll': this.tone(95, 0.24, 'triangle', 0.035, this.sfxGain, 125); break;
      case 'big_bomb': this.noise(0.42, 0.18); this.tone(72, 0.48, 'sawtooth', 0.12, this.sfxGain, 30); this.sequence([220,165,110,82], 0.07); break;
      case 'life_lost': this.tone(260, 0.45, 'square', 0.08, this.sfxGain, 70); break;
      case 'level_complete': this.sequence([523, 659, 784, 1047], 0.10); break;
      case 'frenzy_transform': this.sequence([110, 165, 220, 330, 440, 660], 0.06); break;
      case 'invader_fire': this.tone(170, 0.07, 'square', 0.06, this.sfxGain, 120); break;
      case 'boss_event': this.tone(82, 0.38, 'sawtooth', 0.10, this.sfxGain, 48); break;
      default: break;
    }
  };

  AudioEngine.prototype.sequence = function (notes, gap) {
    const self = this;
    notes.forEach(function (note, index) {
      global.setTimeout(function () { self.tone(note, gap * 1.5, 'square', 0.055, self.sfxGain); }, index * gap * 1000);
    });
  };

  AudioEngine.prototype.startMusic = function () {
    if (this.musicTimer || !this.settings.musicEnabled || this.settings.globalMute) return;
    const self = this;
    const notes = [110, 165, 220, 165, 130.81, 196, 261.63, 196];
    this.musicTimer = global.setInterval(function () {
      if (!self.ctx || !self.settings.musicEnabled || self.settings.globalMute) return;
      const n = notes[self.musicStep++ % notes.length];
      self.tone(n, 0.18, 'square', 0.025, self.musicGain);
      if (self.musicStep % 4 === 1) self.tone(n * 2, 0.07, 'triangle', 0.014, self.musicGain);
    }, 250);
  };

  AudioEngine.prototype.stopMusic = function () {
    if (this.musicTimer) {
      global.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  };

  AudioEngine.prototype.destroy = function () {
    this.stopMusic();
    if (this.ctx) this.ctx.close().catch(function () {});
    this.ctx = null;
  };

  BJ.AudioEngine = AudioEngine;
}(window));
