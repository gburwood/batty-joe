'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const root=path.resolve(__dirname,'..');
const ctx={console,window:{},Date,Math,setTimeout,clearTimeout,URLSearchParams}; ctx.window.window=ctx.window; vm.createContext(ctx);
function load(f){vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx,{filename:f});}
load('batty-joe-config.js'); load('batty-joe-levels.js');
const BJ=ctx.window.BattyJoe, C=BJ.Config;
function ok(v,m){if(!v)throw new Error(m)}
ok(BJ.VERSION==='1.7.0','version');
ok(!C.powerups.ten_pin_frenzy && !C.powerups.bomber_frenzy,'retired powerups removed');
ok(C.powerups.grid_runner_frenzy,'grid runner powerup');
ok(C.levelTransitions.completeHoldSeconds===3 && C.levelTransitions.nextPromptSeconds===2,'level timing');
ok(C.frenzy.gridrunner && C.frenzy.gridrunner.duration===20,'grid config');
for(const name of ['easy','normal','hard']){
 const d=C.difficulty[name]; ok(d.gridRunnerFrenzyWeight>0,'grid weight '+name); ok(d.tenPinFrenzyWeight==null && d.bomberFrenzyWeight==null,'retired weights '+name);
}
const game=fs.readFileSync(path.join(root,'batty-joe-game.js'),'utf8');
ok(game.includes("this.intermissionPhase = 'hold'"),'hold phase implemented');
ok(game.includes("this.intermissionPhase === 'prompt'"),'prompt phase implemented');
ok(game.includes('updateGridRunnerFrenzy'),'grid update implemented');
ok(!game.includes('updateTenPinFrenzy') && !game.includes('updateBomberFrenzy'),'retired runtime removed');
console.log('Batty Joe v1.7.0 focused tests PASSED');
