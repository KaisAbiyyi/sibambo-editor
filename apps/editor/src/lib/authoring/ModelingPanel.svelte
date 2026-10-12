<script lang="ts">
 import type { ModelingController, ModelingState, ModelingMode } from './model-tools.js';
 import { parseLength } from './dimensions.js';
 import { Matrix4, Vector3 } from 'three';
 import type { BomcGraph } from '@sibambo/bomc-document';
 import { organization, emptyOrganization, outlinerEntries, assetCost } from './organization.js';
 let {controller,view,graph,disabled,onMode,onError,onRectangle}:{controller:ModelingController;view:ModelingState;graph:BomcGraph|null;disabled:boolean;onMode:(mode:ModelingMode)=>void;onError:(message:string)=>void;onRectangle:(width:number,depth:number)=>void}=$props();
 let name=$state('Untitled'),dx=$state('1m'),dy=$state('0'),dz=$state('0'),copy=$state(false),count=$state(1),spacing=$state<'multiply'|'divide'>('multiply');
 let radial=$state(false),axis=$state<'x'|'y'|'z'>('y'),angle=$state(90),px=$state('0'),py=$state('0'),pz=$state('0'),offset=$state('100mm'),width=$state('1m'),depth=$state('1m'),guideDistance=$state('1m');
 let sx=$state(1),sy=$state(1),sz=$state(1),sizeX=$state('1m'),sizeY=$state('1m'),sizeZ=$state('1m');
 let segments=$state(24),sweep=$state(90),radius=$state('1m');
 let tagName=$state('Furniture'),tagId=$state(''),filter=$state(''),entityName=$state('Untitled'),entityShown=$state(true),assetName=$state('Asset'),insertX=$state('0'),insertY=$state('0'),insertZ=$state('0');
 let paintName=$state('Material'),paintColor=$state('#c6a678'),opacity=$state(100),paintSide=$state<'front'|'back'|'both'>('both');
 const org=$derived(graph?organization(graph):emptyOrganization());
 const entries=$derived(graph?outlinerEntries(graph):[]);
 const shownEntries=$derived(entries.filter(e=>e.name.toLowerCase().includes(filter.toLowerCase())));
 const info=$derived(graph?.instances.find(i=>view.selection.some(s=>s.type==='instance'&&s.id===i.id)));
 const pivot=():[number,number,number]=>[parseLength(px),parseLength(py),parseLength(pz)];
 const centered=(linear:Matrix4)=>{const p=pivot();return new Matrix4().makeTranslation(...p).multiply(linear).multiply(new Matrix4().makeTranslation(-p[0],-p[1],-p[2]));};
 const rotate=()=>{void controller.apply({type:'transform',selection:view.selection,delta:[0,0,0],copy,count:1,spacing:'multiply',radial:{axis,pivot:pivot(),angleDegrees:angle}});};
 const scale=(factors:[number,number,number])=>{void controller.apply({type:'scale',selection:view.selection,factors,pivot:pivot(),copy});};
 const guard=(action:()=>void)=>{try{action();}catch(error){onError(error instanceof Error?error.message:'Invalid dimension.');}};
 const container=()=>view.selection.find(s=>s.type==='instance');
 const face=()=>view.selection.find(s=>s.type==='face');
</script>
<details class="modeling-panel">
 <summary>Modeling <span>{view.selection.length} selected · {view.path.length?'Editing container':'Model root'}</span></summary>
 <div class="modeling-content">
  <div class="row" aria-label="Modeling tools">
   {#each ['select','erase','move','offset','inset','guide','guidepoint'] as mode}
    <button class:active={view.mode===mode} disabled={disabled} onclick={()=>onMode(mode as ModelingMode)}>{({select:'Select',erase:'Eraser',move:'Move / Copy',offset:'Offset',inset:'Inset / Offset',guide:'Guide Line',guidepoint:'Guide Point'} as Record<string,string>)[mode]}</button>
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
  <details><summary>Materials &amp; Sampling</summary>
   <div class="row"><label>Material name <input aria-label="Paint material name" bind:value={paintName}/></label><label>Color <input aria-label="Paint color" type="color" bind:value={paintColor}/></label><label>Opacity % <input aria-label="Paint opacity" type="number" min="0" max="100" bind:value={opacity}/></label><label>Face side <select aria-label="Paint face side" bind:value={paintSide}><option value="both">Both</option><option value="front">Front</option><option value="back">Back</option></select></label></div>
   <div class="row"><button disabled={disabled||!view.selection.some(s=>s.type==='face'||s.type==='instance')} onclick={()=>guard(()=>{if(!Number.isFinite(opacity)||opacity<0||opacity>100)throw new Error('Opacity must be 0–100%.');void controller.apply({type:'paint',selection:view.selection,name:paintName,rgba:[parseInt(paintColor.slice(1,3),16),parseInt(paintColor.slice(3,5),16),parseInt(paintColor.slice(5,7),16),255],opacityU16:Math.round(opacity/100*65535),side:paintSide});})}>Apply Material</button><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>{const selected=view.selection[0];let materialId:string|null=null;if(selected?.type==='face'){const face=graph?.meshes.flatMap(m=>m.faces).find(f=>f.id===selected.id);materialId=(paintSide==='back'?face?.backMaterialId:face?.frontMaterialId)??null;}else if(selected?.type==='instance')materialId=graph?.instances.find(i=>i.id===selected.id)?.materialId??null;const material=graph?.materials.find(m=>m.id===materialId);if(!material)throw new Error('The selection uses the default material or has no material on this side.');paintName=material.name;paintColor='#'+material.rgba.slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');opacity=material.opacityU16/65535*material.rgba[3]/255*100;})}>Sample Selected Material</button></div>
   <p>Paint faces inside their edit context, or paint a container to inherit on its unpainted faces. Solid colors and opacity save with the document.</p>
  </details>
  <details><summary>Tags, Outliner &amp; Entity Info</summary>
   <p>Tags control containers. Raw faces and edges stay Untagged.</p>
   <div class="row"><label>Tag name <input aria-label="New tag name" bind:value={tagName}/></label><button disabled={disabled} onclick={()=>controller.apply({type:'tag-create',name:tagName})}>Add Tag</button></div>
   <div class="row"><label>Assign tag <select aria-label="Assign tag" bind:value={tagId}><option value="">Untagged</option>{#each org.tags as tag}<option value={tag.id}>{tag.name}</option>{/each}</select></label><button disabled={disabled||!container()} onclick={()=>controller.apply({type:'tag-assign',instanceIds:view.selection.filter(s=>s.type==='instance').map(s=>s.id),tagId:tagId||null})}>Assign Tag</button></div>
   {#each org.tags as tag}<label class="row"><input type="checkbox" aria-label={'Show tag '+tag.name} checked={tag.visible} disabled={disabled} onchange={event=>controller.apply({type:'tag-visibility',tagId:tag.id,visible:event.currentTarget.checked})}/>{tag.name}</label>{/each}
   <label>Find object <input aria-label="Outliner search" bind:value={filter}/></label>
   <div class="outliner" role="tree" aria-label="Outliner">{#each shownEntries as entry}<button role="treeitem" aria-selected={view.selection.some(s=>s.type==='instance'&&s.id===entry.id)&&JSON.stringify(view.path)===JSON.stringify(entry.path.slice(0,-1))} style:padding-left={(entry.path.length-1)*12+4+'px'} disabled={disabled} onclick={()=>controller.selectOccurrence(entry.path)}>{entry.visible?'◉':'○'} {entry.name} · {entry.kind}</button>{/each}</div>
   {#if info}<p>{info.kind}: {info.name} · {graph?.instances.filter(i=>i.definitionId===info.definitionId).length} instances of this definition</p><div class="row"><button disabled={disabled} onclick={()=>{entityName=info.name;entityShown=info.visible;}}>Read Entity Info</button><label>Name <input aria-label="Entity name" bind:value={entityName}/></label><label><input aria-label="Entity visible" type="checkbox" bind:checked={entityShown}/>Visible</label><button disabled={disabled} onclick={()=>controller.apply({type:'entity-info',instanceId:info.id,name:entityName,visible:entityShown})}>Apply Entity Info</button></div>{/if}
  </details>
  <details><summary>Document Asset Library</summary>
   <p>Reusable Components in this BOMC. Component entries share definitions; adding a Group creates an independent library definition.</p>
   <div class="row"><label>Asset name <input aria-label="Asset name" bind:value={assetName}/></label><button disabled={disabled||!container()} onclick={()=>{const selected=container();if(selected)void controller.apply({type:'asset-create',instanceId:selected.id,name:assetName});}}>Add Selection to Library</button></div>
   <div class="row"><label>Insert X <input aria-label="Asset insert X" bind:value={insertX}/></label><label>Y <input aria-label="Asset insert Y" bind:value={insertY}/></label><label>Z <input aria-label="Asset insert Z" bind:value={insertZ}/></label></div>
   {#each org.assets as asset}{@const cost=graph?assetCost(graph,asset.definitionId):null}<div class="asset"><strong>{asset.name}</strong>{#if cost}<p>{cost.faces} faces · {cost.vertices} vertices · {cost.instances} occurrences · {(cost.bytes/1024).toFixed(1)} KiB geometry records</p>{/if}<div class="row"><button aria-label={'Insert asset '+asset.name} disabled={disabled} onclick={()=>guard(()=>{void controller.apply({type:'asset-insert',assetId:asset.id,point:[parseLength(insertX),parseLength(insertY),parseLength(insertZ)]});})}>Insert Component</button><button aria-label={'Remove asset '+asset.name} disabled={disabled} onclick={()=>controller.apply({type:'asset-delete',assetId:asset.id})}>Remove from Library</button></div></div>{/each}
  </details>
  <details><summary>Circle, Arc, Polygon &amp; Follow Me</summary>
   <div class="row">{#each ['circle','polygon','arc','follow-me'] as curve}<button class:active={view.mode===curve} disabled={disabled} onclick={()=>{controller.setCurveOptions(segments,sweep);onMode(curve as ModelingMode);}}>{({circle:'Circle',polygon:'Polygon',arc:'Arc', 'follow-me':'Follow Me'} as Record<string,string>)[curve]}</button>{/each}</div>
   <div class="row"><label>Segments <input aria-label="Curve segments" type="number" min="3" max="256" bind:value={segments} onchange={()=>controller.setCurveOptions(segments,sweep)}/></label><label>Arc sweep ° <input aria-label="Arc sweep" type="number" bind:value={sweep} onchange={()=>controller.setCurveOptions(segments,sweep)}/></label><label>Radius <input aria-label="Curve radius" bind:value={radius}/></label><button disabled={disabled||!view.anchor||!['circle','polygon','arc'].includes(view.mode)} onclick={()=>guard(()=>{controller.setCurveOptions(segments,sweep);controller.curveRadius(parseLength(radius));})}>Commit Radius</button><button disabled={disabled} onclick={()=>controller.cancel()}>Cancel Curve</button></div>
   <p>Circle / Polygon: center then radius. Arc: center, start, end; Alt chooses the longer sweep. Curves use straight segments. Follow Me: Shift-select a continuous planar edge path, activate the tool, click a perpendicular profile in the same context. Invalid profiles and sharp or branching paths reject without changing the document.</p>
  </details>
  <details><summary>Rotate, Scale &amp; Flip</summary>
   <p>World axes, metres and degrees. The pivot stays fixed. Copy preserves shared Components and makes independent Groups.</p>
   <div class="row"><label>Pivot X <input aria-label="Transform pivot X" bind:value={px}/></label><label>Y <input aria-label="Transform pivot Y" bind:value={py}/></label><label>Z <input aria-label="Transform pivot Z" bind:value={pz}/></label><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>{const bounds=controller.selectionBounds();[px,py,pz]=bounds.center.map(String);[sizeX,sizeY,sizeZ]=bounds.size.map(v=>String(v)+'m');})}>Use Selection Center</button></div>
   <div class="row"><label>Rotate axis <select aria-label="Rotate axis" bind:value={axis}><option>x</option><option>y</option><option>z</option></select></label><label>Angle ° <input aria-label="Rotate angle" type="number" bind:value={angle}/></label><label><input type="checkbox" bind:checked={copy}/>Copy transform</label><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>controller.previewTransform(centered(new Matrix4().makeRotationAxis(new Vector3(axis==='x'?1:0,axis==='y'?1:0,axis==='z'?1:0),angle*Math.PI/180))))}>Preview Rotate</button><button disabled={disabled||!view.selection.length} onclick={()=>guard(rotate)}>Apply Rotate</button></div>
   <div class="row"><label>Scale X <input aria-label="Scale X" type="number" step=".1" bind:value={sx}/></label><label>Y <input aria-label="Scale Y" type="number" step=".1" bind:value={sy}/></label><label>Z <input aria-label="Scale Z" type="number" step=".1" bind:value={sz}/></label><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>controller.previewTransform(centered(new Matrix4().makeScale(sx,sy,sz))))}>Preview Scale</button><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>scale([sx,sy,sz]))}>Apply Scale</button></div>
   <div class="row"><label>Size X <input aria-label="Target size X" bind:value={sizeX}/></label><label>Y <input aria-label="Target size Y" bind:value={sizeY}/></label><label>Z <input aria-label="Target size Z" bind:value={sizeZ}/></label><button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>{const sizes=[parseLength(sizeX),parseLength(sizeY),parseLength(sizeZ)],bounds=controller.selectionBounds();const factors=bounds.size.map((v,i)=>{if(v<1e-9){if(Math.abs(sizes[i]!)>1e-9)throw new Error('A flat selection cannot gain thickness through Scale; use Push/Pull.');return 1;}if(sizes[i]!<=0)throw new Error('Target sizes must be positive.');return sizes[i]!/v;});scale(factors as [number,number,number]);})}>Apply Size</button></div>
   <div class="row">{#each ['x','y','z'] as flip}<button disabled={disabled||!view.selection.length} onclick={()=>guard(()=>scale([flip==='x'?-1:1,flip==='y'?-1:1,flip==='z'?-1:1]))}>Flip {flip.toUpperCase()}</button>{/each}<button disabled={disabled} onclick={()=>controller.cancel()}>Clear Transform Preview</button></div>
  </details>
  <details><summary>Offset, Guides &amp; Dimensions</summary>
   <div class="row"><label>Offset distance <input aria-label="Offset distance" bind:value={offset}/></label><button disabled={disabled||!face()} onclick={()=>guard(()=>{const selected=face();if(selected)void controller.apply({type:'offset',faceId:selected.id,distance:parseLength(offset)});})}>Apply Offset</button><button disabled={disabled} onclick={()=>controller.apply({type:'clear-guides'})}>Delete Guides</button></div>
   <p>Positive offset goes inward, negative outward. Guides use two viewport clicks and snap as construction geometry.</p>
   <div class="row"><button disabled={disabled||!face()} onclick={()=>guard(()=>controller.commitInset(parseLength(offset)))}>Apply Inset / Offset</button><button disabled={disabled} onclick={()=>controller.cancel()}>Cancel Inset</button></div>
   <div class="row"><label>Guide distance <input aria-label="Guide distance" bind:value={guideDistance}/></label><button disabled={disabled||!view.anchor||!['guide','guidepoint'].includes(view.mode)} onclick={()=>guard(()=>controller.guideDistance(parseLength(guideDistance)))}>Place Guide Distance</button></div>
   <div class="row"><label>Width <input aria-label="Rectangle width" bind:value={width}/></label><label>Depth <input aria-label="Rectangle depth" bind:value={depth}/></label><button disabled={disabled} onclick={()=>guard(()=>onRectangle(parseLength(width),parseLength(depth)))}>Set Rectangle Dimensions</button></div>
   <p>Click the first Rectangle corner before setting dimensions. Lengths accept m, cm, mm, ft, in and feet/inches. Arrow keys lock Line directions or the Rectangle plane: right X, left Z, up Y.</p>
  </details>
  {#if view.message}<p role="status">{view.message}</p>{/if}
 </div>
</details>
<style>
 .modeling-panel{position:absolute;right:10px;top:10px;width:min(410px,calc(100% - 20px));max-height:65%;overflow:auto;z-index:8;background:var(--panel,#fff);color:var(--text,#263544);border:1px solid #ccd3dc;border-radius:6px;box-shadow:0 3px 12px #0002;font-size:12px;}
 .outliner{max-height:180px;overflow:auto;margin:6px 0}.outliner button{display:block;width:100%;text-align:left}.outliner button[aria-selected=true]{background:#dcecff}.asset{border-top:1px solid #e3e7ed;padding-top:5px}
 summary{cursor:pointer;padding:7px 9px;font-weight:600;}summary span{font-weight:400;font-size:11px;margin-left:8px}.modeling-content{padding:0 8px 7px}.row{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:6px 0}button,input,select{font:inherit;border:1px solid #c6ced9;border-radius:3px;padding:4px 6px;background:#fff;color:#263544}button{cursor:pointer}button.active{background:#dcecff;border-color:#4b8de3}button:disabled{opacity:.45;cursor:default}label{display:flex;align-items:center;gap:4px}input:not([type=checkbox]){width:67px}input[aria-label='Container name']{width:110px}p{margin:5px 0;color:#5c6b7a;font-size:11px;line-height:1.4}details details{border-top:1px solid #e3e7ed}details details summary{padding-left:0}
</style>
