const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'batty-joe.js'), 'utf8');
const match = source.match(/App\.prototype\.onStateChange = function \(next, old, detail\) \{([\s\S]*?)\n  \};/);
if (!match) throw new Error('App.onStateChange implementation not found');

const elements = {};
['pauseSeed', 'pauseLevel', 'pauseScore', 'pauseLives'].forEach(function (id) {
  elements[id] = { textContent: '-' };
});
global.document = { getElementById: function (id) { return elements[id]; } };

const formatCalls = [];
const formatScore = function (score) {
  formatCalls.push(score);
  return 'FORMATTED-' + score;
};
const BJ = { State: { PAUSED: 'PAUSED' } };
const onStateChange = new Function('BJ', 'U', 'next', 'old', 'detail', match[1]);
const app = {
  game: { attract: false, seed: 'ALPHA', level: 3, score: 12345, lives: 2 },
  shownPanel: null,
  showPanel: function (id) { this.shownPanel = id; }
};

onStateChange.call(app, BJ, { formatScore: formatScore }, BJ.State.PAUSED, 'PLAYING', null);
if (elements.pauseSeed.textContent !== 'ALPHA' || elements.pauseLevel.textContent !== 3 || elements.pauseScore.textContent !== 'FORMATTED-12345' || elements.pauseLives.textContent !== 2) {
  throw new Error('First PAUSED transition did not project live campaign status');
}

app.game.seed = 'BETA';
app.game.level = 8;
app.game.score = 987654;
app.game.lives = 5;
onStateChange.call(app, BJ, { formatScore: formatScore }, BJ.State.PAUSED, 'PLAYING', null);
if (elements.pauseSeed.textContent !== 'BETA' || elements.pauseLevel.textContent !== 8 || elements.pauseScore.textContent !== 'FORMATTED-987654' || elements.pauseLives.textContent !== 5) {
  throw new Error('Second PAUSED transition did not refresh campaign status');
}
if (JSON.stringify(formatCalls) !== JSON.stringify([12345, 987654]) || app.shownPanel !== 'pausePanel') {
  throw new Error('Pause status did not reuse score formatting or open the pause panel');
}

console.log('CHG-0009 focused regressions PASSED');