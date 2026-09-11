/** Local audio only. Each source owns its playback nodes; stale sessions are destroyable before play. */
export function createLocalSource(records){
  let context;
  const buffers=new Map();
  return async(index,events)=>{
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio)throw new Error('Этот браузер не поддерживает воспроизведение.');
    context??=new Audio();
    const resumed=context.resume(),path=records[index].audio;
    if(!buffers.has(path)){
      const pending=fetch(path,{signal:AbortSignal.timeout(12000)}).then(async response=>{
        if(!response.ok)throw new Error('Эта запись пока недоступна.');
        const data=await response.arrayBuffer();if(data.byteLength>30*1024*1024)throw new Error('Запись слишком большая.');
        return context.decodeAudioData(data);
      }).catch(error=>{if(error.name==='TimeoutError')throw new Error('Загрузка записи задерживается. Попробуй ещё раз.');if(error instanceof TypeError)throw new Error('Нет связи с записью. Попробуй ещё раз.');if(error.name==='EncodingError')throw new Error('Не удалось прочитать аудиофайл.');throw error;});
      buffers.set(path,pending);pending.catch(()=>{if(buffers.get(path)===pending)buffers.delete(path);});
    }
    const [,buffer]=await Promise.all([resumed,buffers.get(path)]);
    let voice=null,offset=0,started=0,closed=false;
    function stop(){if(!voice)return;const old=voice;voice=null;old.source.onended=null;const now=context.currentTime;old.gain.gain.cancelScheduledValues(now);old.gain.gain.setValueAtTime(old.gain.gain.value,now);old.gain.gain.linearRampToValueAtTime(0,now+.07);old.source.stop(now+.08);old.source.onended=()=>{old.source.disconnect();old.gain.disconnect();};}
    return {
      play(){
        if(closed||voice)return;
        const source=context.createBufferSource(),gain=context.createGain();source.buffer=buffer;gain.gain.value=0;source.connect(gain).connect(context.destination);
        if(offset>=buffer.duration)offset=0;started=context.currentTime;voice={source,gain};gain.gain.linearRampToValueAtTime(.65,started+.14);source.start(0,offset);
        source.onended=()=>{if(voice?.source!==source)return;voice=null;offset=0;source.disconnect();gain.disconnect();events.state('ended');};events.state('playing');
      },
      pause(){if(voice)offset=Math.min(buffer.duration,offset+context.currentTime-started);stop();events.state('paused');},
      destroy(){closed=true;stop();}
    };
  };
}
