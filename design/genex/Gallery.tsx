import { ComposerSpecimen, NoModelComposerSpecimen } from "./ComposerSpecimen.tsx";
import { ChatSpecimen } from "./ChatSpecimen.tsx";
/** Development-only component specimen; never imported by the shipping renderer. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '../../src/renderer/ui/Button.tsx';
import { DialogSurface } from '../../src/renderer/ui/dialog.tsx';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../src/renderer/ui/dropdown-menu.tsx';
import { Popover, PopoverTrigger, PopoverContent } from '../../src/renderer/ui/popover.tsx';
import { ViewSwitcher } from '../../src/renderer/ui/view-switcher.tsx';
import { Switch } from '../../src/renderer/ui/switch.tsx';
import { Input } from '../../src/renderer/ui/input.tsx';
import { Textarea } from '../../src/renderer/ui/textarea.tsx';
import { Pending } from '../../src/renderer/ui/Pending.tsx';
import { LoadingState } from '../../src/renderer/ui/LoadingState.tsx';
import { Icon } from '../../src/renderer/ui/icons.tsx';
import { Tooltip, TooltipTrigger, TooltipContent } from '../../src/renderer/ui/tooltip.tsx';
function Gallery(){
 const [dialog,setDialog]=useState(false),[checked,setChecked]=useState(true),[tab,setTab]=useState('build'),[action,setAction]=useState('No action'),[expanded,setExpanded]=useState(true);
 return <main className="mx-auto max-w-4xl space-y-8 p-8 font-sans">
  <header><h1 id="landing-heading" tabIndex={-1} className="text-title">Genex · Studio design system</h1><p className="text-dialog-body text-muted-foreground">Shared components, real states, local fixture data.</p></header>
  <section className="space-y-3"><h2 className="text-name">Typography</h2><p id="latin" className="text-chat">Build a world worth exploring. Il1 O0 — 1234567890</p><p id="cyrillic" className="text-chat">Создайте игру · Ελληνικά · Build вместе</p><p id="mono" className="font-mono text-sm">Geist Mono · 0123456789 · 12m 34s</p></section>
  <section className="space-y-3"><h2 className="text-name">Actions</h2><div className="flex flex-wrap gap-3">
   <Button id="primary" variant="default"><Icon name="new-game" />Create game</Button><Button id="secondary">Secondary</Button><Button id="tint" variant="accent-tint">Invite friend</Button><Button variant="ghost">Ghost</Button><Button id="disabled" disabled>Unavailable</Button><Button id="busy" variant="default" busy>Publishing…</Button>
   <Tooltip><TooltipTrigger asChild><Button size="icon" aria-label="Copy"><Icon name="copy" /></Button></TooltipTrigger><TooltipContent>Copy</TooltipContent></Tooltip>
  </div></section>
  <section className="space-y-3"><h2 className="text-name">Menus and dialogs</h2><div className="flex gap-3">
   <DropdownMenu><DropdownMenuTrigger asChild><Button id="menu-trigger">Actions <Icon name="chevron-down" /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={()=>setAction('Rename')}>Rename</DropdownMenuItem><DropdownMenuItem onSelect={()=>setAction('Archive')}>Archive</DropdownMenuItem><DropdownMenuItem disabled>Unavailable</DropdownMenuItem><DropdownMenuItem onSelect={()=>setAction('Share')}>Share</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
   <Popover><PopoverTrigger render={<Button />} id="picker-trigger">Search folders</PopoverTrigger><PopoverContent aria-label="Search folders" className="w-72 space-y-2 p-2"><Input aria-label="Find a folder" placeholder="Search folders…" /><Button className="w-full">A very long game title that can wrap</Button></PopoverContent></Popover>
   <Button id="dialog-trigger" onClick={()=>setDialog(true)}>Open dialog</Button>
  </div><output id="action" className="text-dialog-sub text-muted-foreground">{action}</output></section>
  <section className="flex flex-wrap items-center gap-6"><ViewSwitcher items={[{key:'build',label:'Build'},{key:'review',label:'Review'}]} label="Workspace" active={tab} onSelect={setTab}/><label className="flex items-center gap-2"><Switch id="switch" checked={checked} onCheckedChange={setChecked}/>Notifications</label></section>
  <section className="max-w-md"><div className="composer-panel space-y-3"><Textarea aria-label="Message" className="min-h-20 resize-none border-0 bg-transparent p-0 text-composer shadow-none focus-visible:ring-0" placeholder="Describe the world you want to build…"/><div className="flex justify-between"><Button variant="ghost" className="rounded-full">Model <Icon name="chevron-down" /></Button><Button aria-label="Send" size="icon" className="rounded-full"><Icon name="send" /></Button></div></div></section>
  <section><button id="disclosure" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)} className="flex items-center gap-2 text-sm"><Icon name="chevron-right" className={expanded?'rotate-90':''}/>Game conversations</button><div className="disclosure-body" data-open={expanded} inert={!expanded}><div><p className="p-3 text-chat">A quiet sidebar row with the same typography.</p></div></div></section>
  <Pending label="Loading conversation…" className="text-chat" />
  <LoadingState label="Building your game" />
  <ComposerSpecimen />
  <NoModelComposerSpecimen />
  <ChatSpecimen />
  {dialog && <DialogSurface title="Create a game" description="Choose a name for your new game." onDismiss={()=>setDialog(false)}><Input aria-label="Game name" placeholder="Untitled game"/><div className="flex justify-end gap-2"><Button onClick={()=>setDialog(false)}>Cancel</Button><Button variant="default" onClick={()=>setDialog(false)}>Create</Button></div></DialogSurface>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Gallery/>);
