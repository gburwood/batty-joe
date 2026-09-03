
global.window = global;
window.BattyJoe = {
  Utils: { clamp: function(v,a,b){ return Math.max(a, Math.min(b,v)); } }
};
require("../batty-joe-config.js");
require("../batty-joe-physics.js");
const BJ=window.BattyJoe, P=BJ.Physics, C=BJ.Config;
function ok(v,m){ if(!v) throw new Error(m); }
function near(a,b,e,m){ if(Math.abs(a-b)>e) throw new Error(m+" "+a+" != "+b); }
const target=400;
let centre={x:150,y:100,r:8,vx:0,vy:target,spin:0};
let edge={x:198,y:100,r:8,vx:0,vy:target,spin:0};
let paddle={x:100,y:100,w:100,h:18,vx:C.paddle.maxSpeed};
let cr=P.bounceFromPaddle(centre,paddle,target), er=P.bounceFromPaddle(edge,paddle,target);
ok(er.boostPercent>cr.boostPercent,"edge contact boost");
ok(P.length(edge.vx,edge.vy)<=target*(1+C.physics.paddleVelocityTransfer.maxBoostPercent)+1e-6,"cap");
let stationary={x:198,y:100,r:8,vx:0,vy:target,spin:0};
let sr=P.bounceFromPaddle(stationary,{x:100,y:100,w:100,h:18,vx:0},target);
near(sr.boostPercent,0,1e-9,"stationary boost");
let decay={vx:0,vy:-500,spin:0,paddleSpeedBoost:.25};
P.decayPaddleSpeedBoost(decay,C.physics.paddleVelocityTransfer.decayHalfLifeSeconds,target,C.physics.paddleVelocityTransfer);
near(P.length(decay.vx,decay.vy),450,.01,"half-life");
let slow={x:198,y:100,r:8,vx:0,vy:target,spin:0}, fast={x:198,y:100,r:8,vx:0,vy:target,spin:0};
P.bounceFromPaddle(slow,{x:100,y:100,w:100,h:18,vx:C.paddle.maxSpeed*.25},target);
P.bounceFromPaddle(fast,paddle,target);
ok(P.length(fast.vx,fast.vy)>P.length(slow.vx,slow.vy),"paddle speed scaling");
let right={x:150,y:100,r:8,vx:0,vy:target,spin:0};
P.bounceFromPaddle(right,{x:100,y:100,w:100,h:18,vx:500},target);
ok(right.spin>0,"spin preserved");
let old=C.physics.paddleVelocityTransfer.enabled; C.physics.paddleVelocityTransfer.enabled=false;
let disabled={x:198,y:100,r:8,vx:0,vy:target,spin:0};
P.bounceFromPaddle(disabled,paddle,target); near(P.length(disabled.vx,disabled.vy),target,.001,"disabled");
C.physics.paddleVelocityTransfer.enabled=old;
console.log("Batty Joe v1.6.0 physics tests PASSED");
