import {classifyGesture} from './player-state.js';
import {createRecordPlayer} from './record-player.js';
import {createLocalSource} from './local-source.js';
import {records} from './records.js';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const rack=document.querySelector('#sleeve-rack');
let night=document.body.classList.contains('is-night');
function setNight(value){night=value;document.body.classList.toggle('is-night',value);document.querySelector('#light-switch').setAttribute('aria-pressed',String(value));document.querySelector('#light-switch').setAttribute('aria-label',value?'Включить свет':'Приглушить свет');document.querySelector('meta[name="theme-color"]').content=value?'#0c0d13':'#dfe3fa';}
document.querySelector('#light-switch').addEventListener('click',()=>setNight(!night));
const canvas=document.querySelector('#sound-field'),shell=document.querySelector('#scene-shell'),playButton=document.querySelector('#play-toggle');
let field=null,lastIndex=0,direction=1;
const player=createRecordPlayer(createLocalSource(records),state=>{
  const record=records[state.index];
  document.documentElement.style.setProperty('--record-color',record.color);
  document.documentElement.style.setProperty('--record-ink',record.ink);
  document.documentElement.style.setProperty('--record-glow',record.glow);
  document.querySelector('#record-title').textContent=record.title;
  document.querySelector('#record-subtitle').textContent=`${record.artist} · ${record.year}`;
  document.querySelector('#record-counter').textContent=`ИЗ КОЛЛЕКЦИИ · ${record.number} / 05`;
  document.querySelector('#ticket-side').textContent=`SIDE ${String.fromCharCode(65+state.index)}`;
  document.querySelector('#invitation-track').textContent=record.title;
  rack.querySelectorAll('.sleeve').forEach((button,index)=>{button.setAttribute('aria-pressed',String(index===state.index));button.classList.toggle('is-selected',index===state.index);});
  const isPlaying=state.status==='playing';
  canvas.setAttribute('aria-pressed',String(isPlaying));playButton.setAttribute('aria-pressed',String(isPlaying));
  canvas.setAttribute('aria-label',`${state.playing?'Приостановить':'Включить'} пластинку «${record.title}»`);
  playButton.setAttribute('aria-label',state.playing?'Приостановить звук':'Включить звук');
  playButton.querySelector('path').setAttribute('d',state.playing?'M9 5v14M16 5v14':'M9 5l11 7-11 7z');
  const audioStatus=document.querySelector('#audio-status');
  audioStatus.textContent=state.status==='loading'?'Загружаем звук…':state.status==='error'||state.status==='ready'?state.error:isPlaying?'Сейчас играет':'Нажми на пластинку — включи свою волну.';
  audioStatus.classList.toggle('is-error',state.status==='error');
  canvas.dataset.playback=state.status;
  document.body.classList.toggle('is-playing',isPlaying);
  if(state.index!==lastIndex){field?.setRecord(state.index,direction);lastIndex=state.index;}
  field?.setPlaying(isPlaying);
},records.length);
canvas.dataset.playback='paused';
function step(delta){direction=Math.sign(delta);return player.step(delta);}
records.forEach((record,index)=>{
  const button=document.createElement('button');button.type='button';button.className=`sleeve sleeve-${record.design}${index===0?' is-selected':''}`;button.style.setProperty('--i',index);button.style.setProperty('--sleeve-color',record.color);button.style.setProperty('--sleeve-ink',record.ink);button.setAttribute('aria-label',`${record.artist} — ${record.title}`);button.setAttribute('aria-pressed',String(index===0));
  const number=document.createElement('span');number.className='sleeve-number';number.textContent=`${record.number} / ${record.year}`;
  const art=document.createElement('span');art.className='sleeve-art';art.setAttribute('aria-hidden','true');
  const title=document.createElement('strong');title.textContent=record.title;
  const artist=document.createElement('span');artist.className='sleeve-artist';artist.textContent=record.artist;
  button.append(number,art,title,artist);button.addEventListener('click',()=>{direction=Math.sign(index-player.state.index)||1;player.select(index);});rack.append(button);
});
let rackGesture=null;
rack.addEventListener('pointerdown',event=>{if(event.button!==0)return;rackGesture={x:event.clientX,y:event.clientY,id:event.pointerId};rack.classList.add('is-open');});
rack.addEventListener('pointermove',event=>{if(!rackGesture||event.pointerId!==rackGesture.id)return;const dx=event.clientX-rackGesture.x,dy=event.clientY-rackGesture.y;if(Math.abs(dx)>15&&Math.abs(dx)>Math.abs(dy)*1.3){rack.setPointerCapture(event.pointerId);rack.style.setProperty('--rack-drag',`${Math.max(-45,Math.min(45,dx*.3))}px`);}});
rack.addEventListener('pointerup',event=>{if(!rackGesture)return;const dx=event.clientX-rackGesture.x,dy=event.clientY-rackGesture.y;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.3){step(dx<0?1:-1);}rackGesture=null;rack.style.setProperty('--rack-drag','0px');rack.classList.remove('is-open');});
rack.addEventListener('pointercancel',()=>{rackGesture=null;rack.style.setProperty('--rack-drag','0px');rack.classList.remove('is-open');});
playButton.addEventListener('click',()=>player.toggle());
document.querySelector('#previous-record').addEventListener('click',()=>step(-1));
document.querySelector('#next-record').addEventListener('click',()=>step(1));
canvas.addEventListener('blur',()=>{delete canvas.dataset.pointerFocus;});
canvas.addEventListener('keydown',event=>{delete canvas.dataset.pointerFocus;if(event.repeat)return;if(['Enter',' ','ArrowLeft','ArrowRight'].includes(event.key))event.preventDefault();if(event.key==='Enter'||event.key===' ')player.toggle();if(event.key==='ArrowLeft')step(-1);if(event.key==='ArrowRight')step(1);});
let gesture=null;
canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;canvas.dataset.pointerFocus='true';canvas.setPointerCapture(event.pointerId);canvas.focus({preventScroll:true});gesture={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastTime:event.timeStamp,velocity:0};field?.setDrag(0,true);});
canvas.addEventListener('pointermove',event=>{
  const bounds=canvas.getBoundingClientRect();
  field?.setPointer((event.clientX-bounds.left)/bounds.width*2-1,-((event.clientY-bounds.top)/bounds.height*2-1));
  if(!gesture||gesture.id!==event.pointerId)return;
  const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
  gesture.velocity=(event.clientX-gesture.lastX)/Math.max(1,event.timeStamp-gesture.lastTime);gesture.lastX=event.clientX;gesture.lastTime=event.timeStamp;
  if(Math.abs(dx)>Math.abs(dy)*1.25)field?.setDrag(dx/Math.max(240,bounds.width),true);
});
function finishGesture(event,cancel=false){
  if(!gesture||gesture.id!==event.pointerId)return;
  const current=gesture;gesture=null;
  if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
  field?.setDrag(0,false);field?.setPointer(0,0);
  if(cancel)return;
  const dx=event.clientX-current.x,dy=event.clientY-current.y;
  const velocity=event.timeStamp-current.lastTime<100?current.velocity:0;
  const action=classifyGesture(dx,dy,velocity);
  if(action==='tap')player.toggle();else if(action==='next')step(1);else if(action==='previous')step(-1);
}
canvas.addEventListener('pointerup',event=>finishGesture(event));canvas.addEventListener('pointercancel',event=>finishGesture(event,true));
canvas.addEventListener('pointerleave',()=>{if(!gesture)field?.setPointer(0,0);});
// Accessible synthetic click (assistive technology), without duplicating pointerup or keyboard activation.
canvas.addEventListener('click',event=>{if(event.detail===0&&!gesture&&event.clientX===0&&event.clientY===0)player.toggle();});
import('./scene.js').then(({createSoundField})=>{field=createSoundField(canvas,shell);field.setRecord(player.state.index,1,true);field.setPlaying(player.state.status==='playing');}).catch(()=>{shell.classList.add('is-fallback');});
document.addEventListener('visibilitychange',()=>player.suspend(document.hidden||document.querySelector('#application-dialog').open));

const dialog=document.querySelector('#application-dialog'),ticket=document.querySelector('#invitation-ticket');
const form=document.querySelector('#application-form'),telegram=document.querySelector('#telegram'),device=document.querySelector('#device'),error=document.querySelector('#telegram-error'),status=document.querySelector('#form-status'),submit=document.querySelector('#submit-application');
let opener=null,closing=false,busy=false;
function openDialog(trigger){
  if(dialog.open)return;opener=trigger;player.suspend(true);dialog.showModal();document.body.classList.add('modal-open');
  const r=trigger.getBoundingClientRect(),d=dialog.getBoundingClientRect();
  dialog.style.transformOrigin=`${Math.max(0,Math.min(d.width,r.x+r.width/2-d.x))}px ${Math.max(0,Math.min(d.height,r.y+r.height/2-d.y))}px`;
  if(!reduced.matches)dialog.animate([{opacity:0,transform:'translateY(14px) scale(.94)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:340,easing:'cubic-bezier(.16,1,.3,1)'});
  const origin=rack.querySelector('.is-selected').getBoundingClientRect(),destination=ticket.getBoundingClientRect();
  if(!reduced.matches)ticket.animate([{transform:`translate(${origin.x-destination.x}px,${origin.y-destination.y}px) scale(${origin.width/destination.width}) rotateY(-45deg)`,opacity:.35},{transform:'translate(0,0) scale(1) rotateY(0)',opacity:1}],{duration:560,easing:'cubic-bezier(.16,1,.3,1)'});
  (form.hidden?document.querySelector('#application-success'):telegram).focus({preventScroll:true});
}
async function closeDialog(){
  if(closing||!dialog.open)return;closing=true;
  if(!reduced.matches)await dialog.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'translateY(9px) scale(.96)'}],{duration:160,easing:'ease-in'}).finished.catch(()=>{});
  dialog.close();document.body.classList.remove('modal-open');player.suspend(document.hidden);closing=false;opener?.focus({preventScroll:true});
}
document.querySelectorAll('[data-open-application]').forEach(button=>button.addEventListener('click',()=>openDialog(button)));
document.querySelector('#dialog-close').addEventListener('click',closeDialog);
document.querySelector('#success-close').addEventListener('click',closeDialog);
dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
let backdropDown=false;
dialog.addEventListener('pointerdown',event=>{const r=dialog.getBoundingClientRect();backdropDown=event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom);});
dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(backdropDown&&event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))closeDialog();backdropDown=false;});
function updateTicket(){
  const raw=telegram.value.trim(),handle=raw.replace(/^https:\/\/t\.me\//,'').replace(/^@/,'');
  document.querySelector('#ticket-contact').textContent=handle?`@${handle}`:'Твоё имя здесь';
  document.querySelector('#ticket-device').textContent=device.value?device.selectedOptions[0].textContent:'Твой первый шаг в Soundspan';
  let hash=0;for(const char of handle)hash=(hash*31+char.charCodeAt(0))>>>0;
  ticket.querySelectorAll('.ticket-wave i').forEach((bar,i)=>{const rhythm=(Math.sin(i*.9+(hash%20))*.5+.5);bar.style.setProperty('--bar',`${14+rhythm*65}px`);});
}
updateTicket();
ticket.addEventListener('pointermove',event=>{if(reduced.matches||event.pointerType==='touch')return;const r=ticket.getBoundingClientRect();ticket.style.transform=`perspective(850px) rotateX(${((event.clientY-r.top)/r.height-.5)*-6}deg) rotateY(${((event.clientX-r.left)/r.width-.5)*7}deg)`;});
ticket.addEventListener('pointerleave',()=>{ticket.style.transform='';});
reduced.addEventListener('change',()=>{if(reduced.matches)ticket.style.transform='';});
telegram.addEventListener('input',()=>{error.textContent='';telegram.removeAttribute('aria-invalid');status.textContent='';ticket.classList.remove('is-accepted');updateTicket();});
device.addEventListener('change',updateTicket);
function validateContact(raw){const value=raw.trim();return /^https:\/\/t\.me\/[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value)||/^@?[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value);}
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;status.textContent='';status.classList.remove('is-error');
  if(!validateContact(telegram.value)){error.textContent='Укажи имя Telegram, например @music_fan.';telegram.setAttribute('aria-invalid','true');telegram.focus();return;}
  busy=true;submit.disabled=true;telegram.disabled=true;device.disabled=true;submit.querySelector('span').textContent='Отправляем…';form.setAttribute('aria-busy','true');
  try{
    const response=await fetch('/api/auth/test-applications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telegram:telegram.value,device:device.value,website:form.elements.website.value}),signal:AbortSignal.timeout(12000)});
    const result=await response.json();if(!response.ok||result.ok!==true)throw new Error(result.error||'Не удалось отправить заявку. Попробуй ещё раз.');
    status.textContent='Заявка принята. Напишем тебе в Telegram о следующем шаге.';ticket.classList.add('is-accepted');telegram.removeAttribute('aria-invalid');
    rack.querySelector('.is-selected')?.classList.add('has-invitation');
    form.hidden=true;document.querySelector('#application-success').hidden=false;
    document.querySelector('#apply-title span').textContent='!';document.querySelector('#apply-description').textContent='Твоя заявка уже у нас.';
    if(dialog.open)document.querySelector('#application-success').focus();
  }catch(cause){status.textContent=cause.name==='TimeoutError'?'Подтверждение задерживается. Попробуй ещё раз — дубликат не создастся.':cause instanceof TypeError?'Нет связи с сервером. Проверь подключение и попробуй ещё раз.':cause.message;status.classList.add('is-error');}
  finally{busy=false;submit.disabled=false;telegram.disabled=false;device.disabled=false;submit.querySelector('span').textContent='Отправить заявку';form.removeAttribute('aria-busy');}
});
