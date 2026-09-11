import * as THREE from './vendor/three.module.js';
import {RoomEnvironment} from './vendor/RoomEnvironment.js';
import {records} from './records.js';
import {recordClearance} from './record-motion.js';

export function createSoundField(canvas,shell){
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),mobile=matchMedia('(max-width:960px)');
  const noScene={setRecord(){},setPlaying(){},setDrag(){},setPointer(){}};
  let renderer;
  try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:'low-power'});}catch{shell.classList.add('is-fallback');return noScene;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,mobile.matches?1.5:1.75));renderer.setClearColor(0xdfe3fa,0);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(36,1,.1,60);camera.position.set(0,0,8.8);
  const room=new RoomEnvironment(),pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(room,.03);scene.environment=environment.texture;room.dispose();pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff,0x6072ba,1.8));
  const key=new THREE.DirectionalLight(0xffffff,3.3);key.position.set(-3,5,6);scene.add(key);
  const light=new THREE.DirectionalLight(0x9dacff,3);light.position.set(5,-1,3);scene.add(light);
  const rig=new THREE.Group(),record=new THREE.Group(),spinning=new THREE.Group();scene.add(rig);rig.add(record);record.add(spinning);record.position.x=-.23;
  const chrome=new THREE.MeshPhysicalMaterial({color:0xbec3ce,metalness:1,roughness:.24,clearcoat:.7,clearcoatRoughness:.16,envMapIntensity:1.1});
  const vinyl=new THREE.MeshPhysicalMaterial({color:0x101119,metalness:.32,roughness:.34,clearcoat:1,clearcoatRoughness:.2,iridescence:.08,envMapIntensity:.85});
  const cylinder=new THREE.CylinderGeometry(2.07,2.07,.07,144,1);
  const body=new THREE.Mesh(cylinder,vinyl);body.rotation.x=Math.PI/2;spinning.add(body);
  const rimGeometry=new THREE.TorusGeometry(2.07,.022,16,180),rim=new THREE.Mesh(rimGeometry,chrome);spinning.add(rim);
  const edge=new THREE.Mesh(new THREE.TorusGeometry(2.11,.018,10,180),chrome);edge.position.z=-.035;spinning.add(edge);
  const groovePositions=[];
  for(let ring=0;ring<78;ring++){const radius=.75+ring*.0164;for(let step=0;step<180;step++){const a=step/180*Math.PI*2,b=(step+1)/180*Math.PI*2;groovePositions.push(Math.cos(a)*radius,Math.sin(a)*radius,.041,Math.cos(b)*radius,Math.sin(b)*radius,.041);}}
  const grooveGeometry=new THREE.BufferGeometry();grooveGeometry.setAttribute('position',new THREE.Float32BufferAttribute(groovePositions,3));const grooveMaterial=new THREE.LineBasicMaterial({color:0x7b8195,transparent:true,opacity:.12});spinning.add(new THREE.LineSegments(grooveGeometry,grooveMaterial));const backGrooves=new THREE.LineSegments(grooveGeometry,grooveMaterial);backGrooves.rotation.y=Math.PI;spinning.add(backGrooves);
  const labelCanvas=document.createElement('canvas');labelCanvas.width=1024;labelCanvas.height=1024;const context=labelCanvas.getContext('2d');
  const texture=new THREE.CanvasTexture(labelCanvas);texture.colorSpace=THREE.SRGBColorSpace;
  const label=new THREE.Mesh(new THREE.CircleGeometry(.715,112),new THREE.MeshBasicMaterial({map:texture,toneMapped:false}));label.position.z=.053;spinning.add(label);
  const trim=new THREE.Mesh(new THREE.TorusGeometry(.723,.01,10,112),chrome);trim.position.z=.053;spinning.add(trim);
  const hole=new THREE.Mesh(new THREE.CircleGeometry(.063,32),new THREE.MeshBasicMaterial({color:0x090b16}));hole.position.z=.058;spinning.add(hole);
  const hub=new THREE.Mesh(new THREE.TorusGeometry(.067,.008,10,40),chrome);hub.position.z=.06;spinning.add(hub);
  for(const detail of [label,trim,hole,hub]){const back=detail.clone();back.position.z=-detail.position.z;back.rotation.y=Math.PI;spinning.add(back);}
  // Two physical records underneath make the change gesture discoverable without a segmented menu.
  const stack=[];
  for(let i=0;i<2;i++){
    const disc=new THREE.Group();disc.position.set(-.07+i*.17,.075+i*.075,-.18-i*.17);
    const backing=new THREE.Mesh(cylinder,vinyl);backing.rotation.x=Math.PI/2;disc.add(backing);
    const ring=new THREE.Mesh(rimGeometry,chrome);disc.add(ring);rig.add(disc);stack.push(disc);
  }
  // Parked tonearm sits outside the record. Playback places the stylus on the groove.
  const base=new THREE.Mesh(new THREE.CylinderGeometry(.19,.23,.12,48),chrome);base.rotation.x=Math.PI/2;base.position.set(2.15,1.33,.16);rig.add(base);
  const arm=new THREE.Group();arm.position.set(2.15,1.33,.22);rig.add(arm);
  const armPath=new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0),new THREE.Vector3(-.06,-.5,.12),new THREE.Vector3(-.6,-1.58,.12),new THREE.Vector3(-.82,-1.85,.10)]);
  arm.add(new THREE.Mesh(new THREE.TubeGeometry(armPath,44,.032,12,false),chrome));
  const weight=new THREE.Mesh(new THREE.CylinderGeometry(.10,.10,.24,28),chrome);weight.position.set(.025,.16,.02);weight.rotation.z=-.14;arm.add(weight);
  const cartridge=new THREE.Mesh(new THREE.BoxGeometry(.15,.30,.09),new THREE.MeshStandardMaterial({color:0x242838,metalness:.6,roughness:.28}));cartridge.position.set(-.82,-1.85,.11);cartridge.rotation.z=-.32;arm.add(cartridge);
  const needle=new THREE.Mesh(new THREE.CylinderGeometry(.008,.006,.23,8),chrome);needle.rotation.x=Math.PI/2;needle.position.set(-.84,-1.92,-.045);arm.add(needle);
  const pivot=new THREE.Mesh(new THREE.SphereGeometry(.073,24,16),chrome);pivot.position.set(0,0,.10);arm.add(pivot);
  const hinge=new THREE.Mesh(new THREE.TorusGeometry(.14,.018,12,40),chrome);hinge.rotation.x=.22;hinge.position.set(0,0,.04);arm.add(hinge);
  let displayed=0,pending=0,playing=false,visible=true,failed=false,frame=0,last=0;
  let targetX=0,targetY=0,px=0,py=0,drag=0,dragTarget=0,dragVelocity=0,held=false;
  let turn=0,turnTarget=0,turnVelocity=0,spin=-.3,spinSpeed=0,armAngle=.60,armLift=0,recordLift=0;
  const targetLight=new THREE.Color(records[0].glow),tau=Math.PI*2;
  function fitText(ctx,text,maxWidth,initial){let size=initial;ctx.font=`500 ${size}px Arial`;while(ctx.measureText(text).width>maxWidth&&size>20){size-=2;ctx.font=`500 ${size}px Arial`;}return size;}
  function drawLabel(index){
    const item=records[index];context.fillStyle=item.color;context.fillRect(0,0,1024,1024);context.strokeStyle=item.ink;context.lineWidth=2;context.beginPath();context.arc(512,512,454,0,tau);context.stroke();context.fillStyle=item.ink;context.textAlign='center';fitText(context,item.artist,740,72);context.fillText(item.artist,512,352);context.font='24px monospace';context.fillText(`SOUNDSPAN SELECTS     /     ${item.year}`,512,421);fitText(context,item.title,730,70);context.fillText(item.title,512,707);context.font='22px monospace';context.fillText(`SIDE ${String.fromCharCode(65+index)}     •     ${item.number} / 05`,512,780);texture.needsUpdate=true;
    displayed=index;targetLight.set(item.glow);canvas.dataset.record=String(index);
  }
  drawLabel(0);
  function request(){if(!failed&&!frame&&!document.hidden&&visible)frame=requestAnimationFrame(render);}
  function resize(){const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.position.z=mobile.matches?(r.width<500?8.35:8.7):9.1;camera.updateProjectionMatrix();request();}
  new ResizeObserver(resize).observe(shell);
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;if(visible)request();else{cancelAnimationFrame(frame);frame=0;last=0;}},{rootMargin:'60px'}).observe(shell);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;last=0;}else request();});
  reduced.addEventListener('change',()=>{if(reduced.matches){turn=turnTarget=0;turnVelocity=0;drawLabel(pending);}last=0;request();});
  function render(now){
    frame=0;if(document.hidden||!visible||failed)return;
    const dt=Math.min((now-(last||now-16))/1000,.032);last=now;
    const staticMode=reduced.matches,blend=staticMode?1:1-Math.exp(-dt*7);
    px+=(targetX-px)*blend;py+=(targetY-py)*blend;
    if(staticMode){drag=0;turn=turnTarget=0;turnVelocity=0;spinSpeed=0;if(displayed!==pending)drawLabel(pending);}
    else{
      const safeToTurn=armAngle>.47&&armLift>.11;
      // Half-speed response preserves the current pose and momentum when redirected.
      if(safeToTurn||Math.abs(turnTarget-turn)<.03){turnVelocity+=(18.75*(turnTarget-turn)-8.5*turnVelocity)*dt;turn+=turnVelocity*dt;}
      if(Math.abs(turnTarget-turn)<.0005&&Math.abs(turnVelocity)<.001){turn=turnTarget;turnVelocity=0;}
      if(held){drag=dragTarget;dragVelocity=0;}else{dragVelocity+=(-120*drag-20*dragVelocity)*dt;drag+=dragVelocity*dt;}
      if(displayed!==pending&&Math.abs(turnTarget-turn)<=Math.PI/2)drawLabel(pending);
      spinSpeed+=((playing&&!held?.85:0)-spinSpeed)*(1-Math.exp(-dt*5));spin+=spinSpeed*dt;
    }
    const swapping=Math.abs(turnTarget-turn)>.03||held;
    const armTarget=playing&&!swapping?0:.60;
    const liftTarget=Math.abs(armAngle-armTarget)>.015||swapping?.24:0;
    armLift+=(liftTarget-armLift)*blend;
    if(staticMode||armLift>.10||Math.abs(armAngle-armTarget)<.015)armAngle+=(armTarget-armAngle)*blend;
    arm.rotation.z=armAngle;arm.position.z=.22+armLift;arm.rotation.x=armLift*.18;
    recordLift+=((swapping?.16:0)-recordLift)*blend;
    rig.rotation.set(.23+(staticMode?0:py*.12),-.30+(staticMode?0:px*.18),-.11);
    const angle=staticMode?0:turn+drag*.5;
    record.position.x=-.23+(staticMode?0:drag*1.9+Math.sin(turn)*.15);record.position.z=staticMode?0:recordClearance(angle)+recordLift;
    // Compensate for the lift toward the camera so the rim stays inside the canvas.
    const flipScale=staticMode?1:1-.22*Math.abs(Math.sin(angle));
    record.rotation.y=angle;record.scale.setScalar(flipScale*(held&&!staticMode?.985:1));spinning.rotation.z=spin;
    stack.forEach((disc,i)=>{disc.position.x=-.07+i*.17+(staticMode?0:Math.min(.12,Math.abs(drag)*.2));});
    canvas.dataset.arm=armLift>.03?'lifted':armAngle<.03?'on-record':'parked';
    canvas.dataset.clearance=String(record.position.z.toFixed(3));
    light.color.lerp(targetLight,blend);renderer.render(scene,camera);canvas.dataset.ready='true';canvas.dataset.motion=staticMode?'reduced':playing?'playing':'paused';
    const moving=!staticMode&&(playing||held||Math.abs(drag)>.0005||Math.abs(dragVelocity)>.001||Math.abs(turnTarget-turn)>.0005||Math.abs(turnVelocity)>.001||Math.abs(px-targetX)>.001||Math.abs(py-targetY)>.001||Math.abs(armAngle-armTarget)>.001||Math.abs(armLift-liftTarget)>.001||Math.abs(recordLift-(swapping?.16:0))>.001||spinSpeed>.001);
    if(moving)request();
  }
  canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();failed=true;cancelAnimationFrame(frame);frame=0;canvas.dataset.motion='unavailable';shell.classList.add('is-fallback');});
  resize();request();
  return {
    setRecord(index,direction=1,instant=false){pending=index;if(instant||reduced.matches){turn=turnTarget=0;turnVelocity=0;drawLabel(index);}else{const sign=direction>0?-1:1;turnTarget=(sign>0?Math.floor(turn/Math.PI)+1:Math.ceil(turn/Math.PI)-1)*Math.PI;}request();},
    setPlaying(value){playing=value;request();},
    setDrag(value,active){held=active;dragTarget=Math.max(-.8,Math.min(.8,value));if(!active)dragTarget=0;request();},
    setPointer(x,y){targetX=Math.max(-1,Math.min(1,x));targetY=Math.max(-1,Math.min(1,y));request();}
  };
}
