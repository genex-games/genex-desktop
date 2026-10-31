/** Interactive specimens of shipping chat components. Never imported by the app. */
import { useRef, useState } from 'react';
import { UserMessage } from '../../src/renderer/chat/UserMessage.tsx';
import { VirtualTranscript } from '../../src/renderer/chat/VirtualTranscript.tsx';
import { ChatQuestion } from '../../src/renderer/chat/ChatQuestion.tsx';
import { ExportReview } from '../../src/renderer/chat/ExportReview.tsx';
import { PlanQuestion } from '../../src/renderer/chat/PlanQuestion.tsx';
import { LoadingState } from '../../src/renderer/ui/LoadingState.tsx';
import { WorkLogContent, WorkLog } from '../../src/renderer/chat/WorkLog.tsx';
import { Markdown } from '../../src/renderer/ui/Markdown.tsx';
import type { ActivityItem } from '../../src/renderer/chat/conversation-entries.ts';

const planText = ['### Changes', '- Widen the wooden bridge.', '- Keep the warm lanterns.', '- Use `<canvas>` inside `src/main.js`.', '### Build steps', ...Array.from({length:12}, (_,i)=>`${i+1}. Check the river bank and the bridge approach. Keep the existing game controls and lighting.`)].join('\n');
const items:ActivityItem[] = [
  {kind:'tool',id:'read',tool:{key:'read',icon:'read',label:'Read the scene',chip:'src/village.ts',state:'succeeded',detail:[{text:'// Keep the lanterns beside the river\nexport function lanternLight(count: number) {\n  const color = "warm white";\n  return { color, intensity: count * 0.8 };\n}'}]}},
  {kind:'tool',id:'edit',tool:{key:'edit',icon:'write',label:'Widened the bridge',state:'succeeded',detail:[{text:'The bridge now leaves room for two players to cross.'}]}},
  {kind:'tool',id:'command',tool:{key:'command',icon:'run',label:'Rebuilt and verified the river crossing with a very long command summary that should end in an ellipsis',chip:'npm run build && npm test',input:{command:'npm run build && npm test'},state:'succeeded',detail:[{text:'✓ built in 1.2s\n✓ 34 checks passed'}]}},
  {kind:'tool',id:'texture',tool:{key:'texture',icon:'see',label:'Read the optional texture',state:'failed',detail:[{text:'The texture was unavailable. Kept the existing material.'}]}},
];
export function ChatSpecimen() {
  const [answer,setAnswer] = useState('');
  const [plan,setPlan] = useState('');
  return <><section id="chat-specimen" className="max-w-[440px] space-y-5">
    <div id="export-review-specimen"><ChatQuestion keys={false} title="Review the files that will be uploaded." choices={[
      {id:'approve',label:'Approve',description:'Upload this staged copy.'},
      {id:'decline',label:'Decline',description:'Keep it local.'}
    ]} onConfirm={async()=>{}}><ExportReview review={{included:['index.html','assets/bridge.png'],excluded:['.env.local','references/private.png']}}/></ChatQuestion></div>
    <div data-chat-transcript><div className="ms-auto mb-4 w-fit rounded-[16px] bg-field px-3 py-2 text-chat">Make the bridge wider and keep the lanterns.</div>
      <Markdown text="The bridge has room for two players now. I kept the warm lanterns and the original wood material."/></div>
    <WorkLog items={items}/>
    <LoadingState label="Checking the river crossing" details={<WorkLogContent items={items.slice(0,2)}/>}/>
    <div id="question-specimen"><ChatQuestion title="Use the new moon texture in this game?" description="Image studio" choices={[
      {id:'approve',label:'Approve',description:'Allow this action once.'},
      {id:'decline',label:'Decline',description:'Continue without this action.'},
    ]} onConfirm={async id=>{await new Promise(resolve=>setTimeout(resolve,300));setAnswer(id);}}/>
    <output id="question-answer">{answer}</output></div>
    <div id="ask-specimen"><ChatQuestion keys={false} recap="The road, two cars and the lap timer are in." title="Which camera should the race use?" choices={[
      {id:'0',label:'Behind the car (Recommended)',description:'You see the car and the road ahead.'},
      {id:'1',label:'Hood view',description:'From the bonnet, a faster feel.'},
      {id:'2',label:'Top-down',description:'The whole track from above.'},
    ]} onConfirm={async()=>{}}/></div>
    <div id="plan-specimen"><PlanQuestion review={{id:'plan',state:'waiting',text:'A bridge and a village at dusk',plan:planText}} busy={false} onAnswer={async approved=>setPlan(approved?'approved':'cancelled')} onRevise={()=>setPlan('revise')}/><output id="plan-answer">{plan}</output></div>
  </section><ChatPolishSpecimen/></>;
}

const brief = ['Build a quiet village at night, with a wooden bridge over the river.', '', 'Keep the warm lanterns, a small campfire and a walking path.', '', ...Array.from({length:10},(_,i)=>`${i+1}. Keep the village readable from the bridge, with soft light on the water and room for two players to cross.`)].join('\n');
const readingItems = [{id:'long',text:brief},{id:'short',text:'Keep the lanterns warm.'},{id:'answer',text:'I’ll keep the lanterns and widen the bridge.'},{id:'work',text:''}];
function ChatPolishSpecimen() {
  const scroller=useRef<HTMLDivElement>(null), follow=useRef(false);
  return <section id="chat-polish-specimen" className="mt-10 max-w-[440px]">
    <div ref={scroller} data-polish-scroll className="h-[520px] overflow-y-auto px-4 py-5">
      <div className="chat-conversation-stack flex min-w-0 flex-col gap-4">
        <VirtualTranscript items={readingItems} scroller={scroller} follow={follow} renderItem={item=>item.id==='work' ? <WorkLog items={items}/> : item.id==='answer' ? <Markdown text={item.text}/> : <UserMessage text={item.text}/>}/>
        <LoadingState label="Thinking" since={Date.now()-289000}/>
      </div>
    </div>
  </section>;
}
