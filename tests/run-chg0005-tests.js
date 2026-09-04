const fs=require('fs'), path=require('path');
const root=path.resolve(__dirname,'..');
const game=fs.readFileSync(path.join(root,'batty-joe-game.js'),'utf8');
const cfg=fs.readFileSync(path.join(root,'batty-joe-config.js'),'utf8');

function ok(value,message){if(!value)throw new Error(message);}

ok(game.includes('Game.prototype.onFrenzyPlayerHit = function ()'),'Grid Runner collision handler must exist');
ok(game.includes('if (this.debugInvulnerable) return false'),'collision handler must preserve debug invulnerability');
ok(game.includes("this.beginFrenzyExit('collision')"),'collision handler must use the shared collision exit');
ok(game.includes('return true;\n  };\n\n  Game.prototype.updateGridRunnerInput'),'collision handler must report successful exit');
ok((game.match(/this\.onFrenzyPlayerHit\(\); return;/g)||[]).length===2,'boundary/trail and blocker branches must invoke collision handler');
ok(game.includes("if (this.frenzyRemaining <= 0 && this.state === BJ.State.FRENZY_ACTIVE) this.beginFrenzyExit('timeout')"),'shared Frenzy timeout must remain active');
ok(cfg.includes('gridrunner: {\n        minBricks: 6, duration: 20'),'Grid Runner duration must remain 20 seconds');

const handler={
  debugInvulnerable:false,
  state:'active',
  beginFrenzyExit(reason){this.reason=reason;this.state='out';}
};
const onHit=new Function(game.match(/Game\.prototype\.onFrenzyPlayerHit = function \(\) \{([\s\S]*?)\n  \};/)[1]);
ok(onHit.call(handler)===true,'normal collision must report exit');
ok(handler.reason==='collision'&&handler.state==='out','normal collision must begin shared exit');
handler.debugInvulnerable=true;handler.state='active';handler.reason=null;
ok(onHit.call(handler)===false,'invulnerable collision must report no exit');
ok(handler.reason===null&&handler.state==='active','invulnerable collision must not begin exit');

console.log('CHG-0005 focused regressions PASSED');
