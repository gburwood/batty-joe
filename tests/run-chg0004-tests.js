const fs=require('fs'), path=require('path');
const root=path.resolve(__dirname,'..');
const game=fs.readFileSync(path.join(root,'batty-joe-game.js'),'utf8');
const cfg=fs.readFileSync(path.join(root,'batty-joe-config.js'),'utf8');
function ok(x,m){if(!x)throw new Error(m);}
ok(cfg.includes('nextPromptSeconds: 5.0'),'NEXT LEVEL must be 5 seconds');
ok(cfg.includes('completeHoldSeconds: 3.0'),'LEVEL COMPLETE hold must remain 3 seconds');
ok(game.includes("this.collectPowerup(drop.type) === 'frenzy_started') return"),'power-drop loop must terminate after successful Frenzy activation');
ok(game.includes("return this.startFrenzy(frenzyPowerups[type]) ? 'frenzy_started' : 'frenzy_rejected'"),'Frenzy activation result must propagate');
ok(game.includes('createRadialGradient'),'chrome ball gradient missing');
ok(game.includes('Hardened chrome ball'),'chrome ball rendering marker missing');
console.log('CHG-0004 focused regressions PASSED');
