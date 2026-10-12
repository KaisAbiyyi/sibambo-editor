<script lang="ts">
 import type { ModelingController, ModelingState, ModelingMode } from './model-tools.js';
 import { parseLength } from './dimensions.js';
 let {controller,view,disabled,onMode,onError,onRectangle}:{controller:ModelingController;view:ModelingState;disabled:boolean;onMode:(mode:ModelingMode)=>void;onError:(message:string)=>void;onRectangle:(width:number,depth:number)=>void}=$props();
 let name=$state('Untitled'),dx=$state('1m'),dy=$state('0'),dz=$state('0'),copy=$state(false),count=$state(1),spacing=$state<'multiply'|'divide'>('multiply');
 let radial=$state(false),axis=$state<'x'|'y'|'z'>('y'),angle=$state(90),px=$state('0'),py=$state('0'),pz=$state('0'),offset=$state('100mm'),width=$state('1m'),depth=$state('1m'),guideDistance=$state('1m');
 const guard=(action:()=>void)=>{try{action();}catch(error){onError(error instanceof Error?error.message:'Invalid dimension.');}};
 const container=()=>view.selection.find(s=>s.type==='instance');
 const face=()=>view.selection.find(s=>s.type==='face');
</script>
<details class="modeling-panel">
 <summary>Modeling <span>{view.selection.length} selected · {view.path.length?'Editing container':'Model root'}</span></summary>
 <div class="modeling-content">
  <div class="row" aria-label="Modeling tools">
   {#each ['select','erase','move','offset','guide','guidepoint'] as mode}
    <button class:active={view.mode===mode} disabled={disabled} onclick={()=>onMode(mode as ModelingMode)}>{({select:'Select',erase:'Eraser',move:'Move / Copy',offset:'Offset',guide:'Guide Line',guidepoint:'Guide Point'} as Record<string,string>)[mode]}</button>
   {/each}
  </div>
  <p>Shift-click toggles selection. Drag right for a window, left for crossing. Double-click a container to edit.</p>
  <div class="row">
   <button disabled={disabled} onclick={()=>controller.selectAll()}>Select All</button>
   <button disabled={disabled||!face()} onclick={()=>controller.selectConnected()}>Select Connected</button>
   <button disabled={disabled||!view.selection.length} onclick={()=>controller.erase()}>Delete Selection</button>
   <button disabled={disabled||!container()} onclick={()=>controller.enter()}>Edit Container</button>
   <button disabled={disabled||!view.path.length} onclick={()=>controller.exit()}>Close Context</button>
  </div>
  <details><summary>Groups &amp; Components</summary><div class="row">
   <label>Name <input aria-label="Container name" bind:value={name} maxlength="120"/></label>
   <button disabled={disabled||!view.selection.length} onclick={()=>controller.apply({type:'group',selection:view.selection,containerKind:'group',name})}>Make Group</button>
   <button disabled={disabled||!view.selection.length} onclick={()=>controller.apply({type:'group',selection:view.selection,containerKind:'component',name})}>Make Component</button>
   <button disabled={disabled||!container()} onclick={()=>{const selected=container();if(selected)void controller.apply({type:'unique',instanceId:selected.id});}}>Make Unique</button>
   <button disabled={disabled||!container()} onclick={()=>{const selected=container();if(selected)void controller.apply({type:'explode',instanceId:selected.id});}}>Explode</button>
  </div></details>
  <details><summary>Move, Copy &amp; Arrays</summary>
   <div class="row"><label>X <input aria-label="Move X" bind:value={dx}/></label><label>Y <input aria-label="Move Y" bind:value={dy}/></label><label>Z <input aria-label="Move Z" bind:value={dz}/></label></div>
   <div class="row"><label><input type="checkbox" bind:checked={copy}/>Copy</label><label>Copies <input aria-label="Array copies" type="number" min="1" max="100" bind:value={count}/></label><label>Spacing <select bind:value={spacing}><option value="multiply">Multiply (×)</option><option value="divide">Divide (/)</option></select></label><label><input type="checkbox" bind:checked={radial}/>Radial</label></div>
   {#if radial}<div class="row"><label>Axis <select bind:value={axis}><option>x</option><option>y</option><option>z</option></select></label><label>Angle ° <input aria-label="Array angle" type="number" bind:value={angle}/></label><label>Pivot X <input bind:value={px}/></label><label>Y <input bind:value={py}/></label><label>Z <input bind:value={pz}/></label></div>{/if}
   <div class="row"><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>{void controller.apply({type:'transform',selection:view.selection,delta:[parseLength(dx),parseLength(dy),parseLength(dz)],copy,count,spacing,radial:radial?{axis,pivot:[parseLength(px),parseLength(py),parseLength(pz)],angleDegrees:angle}:null});})}>Apply Transform</button>
    <button disabled={disabled} onclick={()=>controller.cancel()}>Cancel Move</button>
    {#each ['x','y','z'] as lock}<button class:active={view.axis===lock} disabled={disabled} onclick={()=>controller.setAxis(lock as 'x'|'y'|'z')}>Lock {lock.toUpperCase()}</button>{/each}
   </div>
   <p>Viewport Move: click origin and destination; Ctrl copies. X/Y/Z locks the axis. Array counts exclude the original.</p>
  </details>
  <details><summary>Offset, Guides &amp; Dimensions</summary>
   <div class="row"><label>Offset distance <input aria-label="Offset distance" bind:value={offset}/></label><button disabled={disabled||!face()} onclick={()=>guard(()=>{const selected=face();if(selected)void controller.apply({type:'offset',faceId:selected.id,distance:parseLength(offset)});})}>Apply Offset</button><button disabled={disabled} onclick={()=>controller.apply({type:'clear-guides'})}>Delete Guides</button></div>
   <p>Positive offset goes inward, negative outward. Guides use two viewport clicks and snap as construction geometry.</p>
   <div class="row"><label>Guide distance <input aria-label="Guide distance" bind:value={guideDistance}/></label><button disabled={disabled||!view.anchor||!['guide','guidepoint'].includes(view.mode)} onclick={()=>guard(()=>controller.guideDistance(parseLength(guideDistance)))}>Place Guide Distance</button></div>
   <div class="row"><label>Width <input aria-label="Rectangle width" bind:value={width}/></label><label>Depth <input aria-label="Rectangle depth" bind:value={depth}/></label><button disabled={disabled} onclick={()=>guard(()=>onRectangle(parseLength(width),parseLength(depth)))}>Set Rectangle Dimensions</button></div>
   <p>Click the first Rectangle corner before setting dimensions. Lengths accept m, cm, mm, ft, in and feet/inches. Arrow keys lock Line directions or the Rectangle plane: right X, left Z, up Y.</p>
  </details>
  {#if view.message}<p role="status">{view.message}</p>{/if}
 </div>
</details>
<style>
 .modeling-panel{position:absolute;right:10px;top:10px;width:min(410px,calc(100% - 20px));max-height:65%;overflow:auto;z-index:8;background:var(--panel,#fff);color:var(--text,#263544);border:1px solid #ccd3dc;border-radius:6px;box-shadow:0 3px 12px #0002;font-size:12px;}
 summary{cursor:pointer;padding:7px 9px;font-weight:600;}summary span{font-weight:400;font-size:11px;margin-left:8px}.modeling-content{padding:0 8px 7px}.row{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:6px 0}button,input,select{font:inherit;border:1px solid #c6ced9;border-radius:3px;padding:4px 6px;background:#fff;color:#263544}button{cursor:pointer}button.active{background:#dcecff;border-color:#4b8de3}button:disabled{opacity:.45;cursor:default}label{display:flex;align-items:center;gap:4px}input:not([type=checkbox]){width:67px}input[aria-label='Container name']{width:110px}p{margin:5px 0;color:#5c6b7a;font-size:11px;line-height:1.4}details details{border-top:1px solid #e3e7ed}details details summary{padding-left:0}
</style>
