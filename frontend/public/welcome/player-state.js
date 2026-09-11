/** Resolve the complete gesture, never turn a vertical scroll into a tap. */
export function classifyGesture(dx,dy,velocity=0){
  if(Math.abs(dx)<9&&Math.abs(dy)<9)return 'tap';
  if(Math.abs(dy)>Math.abs(dx)*.8)return 'cancel';
  if(Math.abs(dx)>55||(Math.abs(dx)>20&&Math.abs(velocity)>.45))return dx<0?'next':'previous';
  return 'cancel';
}

/** Intent revisions prevent an old asynchronous load from starting after pause or selection. */
export function createPlayer(engine,onChange,count=3){
  let revision=0;
  const state={index:0,status:'paused',playing:false,error:''};
  const emit=()=>onChange({...state});
  async function play(){
    const current=++revision;
    state.playing=true;state.status='loading';state.error='';emit();
    try{
      const [,clip]=await Promise.all([engine.unlock(),engine.load(state.index)]);
      if(current!==revision||!state.playing)return;
      engine.start(clip);state.status='playing';emit();
    }catch(error){
      if(current!==revision)return;
      engine.stop();state.playing=false;state.status='error';state.error='Не удалось включить звук. Нажми ещё раз.';emit();
    }
  }
  function pause(){revision++;engine.stop();state.playing=false;state.status='paused';state.error='';emit();}
  function step(delta){state.index=((state.index+delta)%count+count)%count;engine.stop();if(state.playing)return play();revision++;emit();return Promise.resolve();}
  return {get state(){return {...state};},toggle(){return state.playing?(pause(),Promise.resolve()):play();},pause,step};
}
