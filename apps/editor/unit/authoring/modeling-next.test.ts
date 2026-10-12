import { expect, test } from 'bun:test';
import { Matrix4, Vector3, Mesh, MeshStandardMaterial } from 'three';
import { DEFAULT_DISPLAY_STATE } from '@sibambo/viewport';
import { projectAuthoringScene } from '../../src/lib/authoring/scene.js';
import { BomcDocument } from '@sibambo/bomc-document/document';
import { readWebBomc } from '@sibambo/bomc-document/reader';
import { BomcWriter } from '@sibambo/bomc-document/writer';
import { buildModelEdit, contextGraph, nextModelSequence, validateAuthoringDocument } from '../../src/lib/authoring/model.js';
import { AuthoringHistory } from '../../src/lib/authoring/history.js';
import { journalEntry, hasEntityId } from '../../src/lib/authoring/geometry.js';
import type { ModelAction } from '../../src/lib/authoring/protocol.js';
import { curvePoints, orderedPath, sweepProfile } from '../../src/lib/authoring/curves.js';
import { buildAuthoringTopology } from '../../src/lib/authoring/topology.js';
import { organization, outlinerEntries, assetCost } from '../../src/lib/authoring/organization.js';
import { modelOccurrences } from '../../src/lib/authoring/model.js';

const ID='6320c783-9aa5-4b1b-af99-72a16f789154';
function setup() {
	const doc=BomcDocument.create({documentId:ID,name:'Transforms'}),history=new AuthoringHistory(null);
	const run=(action:ModelAction,path:string[]=[])=>{const edit=buildModelEdit(doc.snapshot().graph,path,action,nextModelSequence(doc.snapshot().graph));history.execute(doc,journalEntry(edit));return edit.entityId;};
	run({type:'raw',command:{kind:'CREATE_RECTANGLE',points:[[0,0,0],[4,0,0],[4,0,3],[0,0,3]],normal:[0,1,0]}});
	return {doc,history,run,faceId:doc.snapshot().graph.meshes[0]!.faces[0]!.id};
}
test('affine instances preserve shared definitions and support world-distance Push/Pull, offset, Undo and independent reopen',async()=>{
	const s=setup();try{
		const id=s.run({type:'group',selection:[{type:'face',id:s.faceId}],containerKind:'component',name:'Panel'});
		const before=s.doc.snapshot().graph;
		s.run({type:'scale',selection:[{type:'instance',id}],factors:[2,3,-.5],pivot:[1,0,0],copy:true});
		const graph=s.doc.snapshot().graph,instances=graph.instances.filter(i=>i.kind==='component'),mirrored=instances.find(i=>i.id!==id)!;
		expect(instances).toHaveLength(2);expect(new Set(instances.map(i=>i.definitionId)).size).toBe(1);
		expect(graph.meshes).toEqual(before.meshes);expect(new Matrix4().fromArray(mirrored.matrix).determinant()).toBeCloseTo(-3);
		const world=contextGraph(graph,[mirrored.id],true),face=world.meshes[0]!.faces[0]!;
		expect(face.normal).toEqual([0,1,0]);expect(validateAuthoringDocument(graph).editable).toBe(true);
		const inner=s.run({type:'offset',faceId:face.id,distance:.2},[mirrored.id]);
		const inset=contextGraph(s.doc.snapshot().graph,[mirrored.id],true).meshes[0]!,center=inset.faces.find(f=>f.id===inner)!;
		const xs=center.outer.map(i=>inset.positions[i*3]!);expect(Math.max(...xs)-Math.min(...xs)).toBeCloseTo(7.6);
		s.run({type:'raw',command:{kind:'PUSH_PULL_FACE',faceId:inner,distance:.6}},[mirrored.id]);
		const final=s.doc.snapshot().graph,worldFinal=contextGraph(final,[mirrored.id],true).meshes[0]!;
		expect(Math.max(...worldFinal.positions.filter((_,i)=>i%3===1))).toBeCloseTo(.6);
		const writer=new BomcWriter(s.doc);try{const written=await writer.write(),reopened=await readWebBomc(written.bytes);try{expect(reopened.snapshot().graph).toEqual(final);expect(validateAuthoringDocument(reopened.snapshot().graph).editable).toBe(true);}finally{reopened.dispose();}}finally{writer.dispose();}
		s.history.undo(s.doc);s.history.redo(s.doc);expect(s.doc.snapshot().graph).toEqual(final);
	}finally{s.doc.dispose();}
});
test('raw mirror preserves winding and front/back semantics; singular scale is atomic',()=>{
	const s=setup();try{
		const original=s.doc.snapshot().graph;
		expect(()=>s.run({type:'scale',selection:[{type:'face',id:s.faceId}],factors:[0,1,1],pivot:[0,0,0],copy:false})).toThrow();expect(s.doc.snapshot().graph).toEqual(original);
		s.run({type:'scale',selection:[{type:'face',id:s.faceId}],factors:[-2,1,3],pivot:[0,0,0],copy:false});
		const mesh=s.doc.snapshot().graph.meshes[0]!,face=mesh.faces[0]!,[a,b,c]=face.triangles.slice(0,3).map(i=>new Vector3(...mesh.positions.slice(i*3,i*3+3) as [number,number,number]));
		expect(b!.sub(a!).cross(c!.sub(a!)).normalize().dot(new Vector3(...face.normal))).toBeCloseTo(1);
		expect(face.frontMaterialId).toBe(original.meshes[0]!.faces[0]!.frontMaterialId);
		s.history.undo(s.doc);expect(s.doc.snapshot().graph).toEqual(original);
	}finally{s.doc.dispose();}
});

test('segmented Circle/Polygon become editable faces and Arc persists as owned edges; invalid segments reject atomically',()=>{
	const s=setup();try{
		const circle=s.run({type:'curve',curveKind:'circle',center:[10,0,0],first:[12,0,0],normal:[0,1,0],segments:24,sweepDegrees:360});
		expect(s.doc.snapshot().graph.meshes[0]!.faces.find(f=>f.id===circle)!.outer).toHaveLength(24);
		s.run({type:'raw',command:{kind:'PUSH_PULL_FACE',faceId:circle,distance:2}});
		expect(validateAuthoringDocument(s.doc.snapshot().graph).editable).toBe(true);
		const before=s.doc.snapshot().graph;
		expect(()=>s.run({type:'curve',curveKind:'polygon',center:[20,0,0],first:[21,0,0],normal:[0,1,0],segments:2,sweepDegrees:360})).toThrow();expect(s.doc.snapshot().graph).toEqual(before);
		s.run({type:'curve',curveKind:'arc',center:[20,0,0],first:[21,0,0],normal:[0,1,0],segments:12,sweepDegrees:-90});
		expect(JSON.parse(s.doc.snapshot().graph.instances[0]!.label!).looseEdges).toHaveLength(12);
		expect(curvePoints([0,0,0],[1,0,0],[0,1,0],12,90).at(-1)![2]).toBeCloseTo(-1);
	}finally{s.doc.dispose();}
});

test('Follow Me sweeps a perpendicular profile around a planar corner and rejects a disconnected path',()=>{
	const doc=BomcDocument.create({documentId:ID,name:'Sweep'});try{
		doc.transact(buildModelEdit(doc.snapshot().graph,[],{type:'raw',command:{kind:'CREATE_FACE_LOOP',points:[[0,-.1,-.1],[0,.1,-.1],[0,.1,.1],[0,-.1,.1]],normal:[1,0,0]}},1).forward);
		const mesh=doc.snapshot().graph.meshes[0]!,face=mesh.faces[0]!;
		const result=sweepProfile(mesh,face,[[0,0,0],[2,0,0],[2,0,2]],ID+':face:2:sweep');
		expect(result.faces).toHaveLength(10);expect([...buildAuthoringTopology(result).edges.values()].every(e=>e.faceIds.length===2)).toBe(true);
		for(const f of result.faces)expect(f.frontMaterialId).toBe(face.frontMaterialId);
		expect(()=>orderedPath([{start:[0,0,0],end:[1,0,0]},{start:[5,0,0],end:[6,0,0]}],[0,0,0])).toThrow('continuous');
		expect(()=>sweepProfile(mesh,face,[[0,0,0],[2,0,0],[2,1,1],[3,2,3]],ID+':face:2:sweep')).toThrow('planar');
		const closed=sweepProfile(mesh,face,[[0,0,0],[2,0,0],[2,0,2],[0,0,2],[0,0,0]],ID+':face:3:sweep');
		expect(closed.faces).toHaveLength(16);expect([...buildAuthoringTopology(closed).edges.values()].every(e=>e.faceIds.length===2)).toBe(true);
		expect(()=>sweepProfile(mesh,face,[[0,0,0],[2,0,0],[2,0,.05],[0,0,.05]],ID+':face:4:sweep')).toThrow();
		expect(()=>sweepProfile(mesh,face,[[0,0,0],[2,0,0],[0,0,2],[2,0,2],[0,0,0]],ID+':face:4:sweep')).toThrow('intersects');
	}finally{doc.dispose();}
});

test('Follow Me returns an actual entity accepted by the client and preserves its journal through reopen',async()=>{
	const s=setup();try{
		const profile=s.run({type:'raw',command:{kind:'CREATE_FACE_LOOP',points:[[0,-.1,-.1],[0,.1,-.1],[0,.1,.1],[0,-.1,.1]],normal:[1,0,0]}});
		const before=s.doc.snapshot().graph,result=s.run({type:'follow-me',faceId:profile,edges:[{start:[0,0,0],end:[4,0,0]},{start:[4,0,0],end:[4,0,3]}]});
		expect(hasEntityId(s.doc.snapshot().graph,result)).toBe(true);const final=s.doc.snapshot().graph;
		expect(final.meshes[0]!.faces).toHaveLength(11);s.history.undo(s.doc);expect(s.doc.snapshot().graph).toEqual(before);s.history.redo(s.doc);expect(s.doc.snapshot().graph).toEqual(final);
		const writer=new BomcWriter(s.doc);try{const output=await writer.write(),reopened=await readWebBomc(output.bytes);try{expect(reopened.snapshot().graph).toEqual(final);}finally{reopened.dispose();}}finally{writer.dispose();}
	}finally{s.doc.dispose();}
});

test('paint preserves explicit backs, inherits container color only on unpainted fronts, and survives Push/Pull and reopen',async()=>{
	const s=setup();try{
		s.run({type:'paint',selection:[{type:'face',id:s.faceId}],name:'Red back',rgba:[255,0,0,255],opacityU16:32768,side:'back'});
		const back=s.doc.snapshot().graph.meshes[0]!.faces[0]!.backMaterialId;
		const group=s.run({type:'group',selection:[{type:'face',id:s.faceId}],containerKind:'component',name:'Painted'});
		s.run({type:'paint',selection:[{type:'instance',id:group}],name:'Blue front',rgba:[0,0,255,255],opacityU16:65535,side:'both'});
		const snapshot=s.doc.snapshot(),projection=projectAuthoringScene(snapshot,DEFAULT_DISPLAY_STATE),materials:MeshStandardMaterial[]=[];
		try{projection.group.traverse(o=>{if(o instanceof Mesh)materials.push(o.material as MeshStandardMaterial);});expect(materials).toHaveLength(1);expect(materials[0]!.color.getHexString()).toBe('0000ff');
			const shader={uniforms:{},fragmentShader:'#include <color_fragment>'} as any;materials[0]!.onBeforeCompile(shader,{} as any);expect(shader.uniforms.authoringBackFaceColor.value.getHexString()).toBe('ff0000');expect(shader.uniforms.authoringBackFaceAlpha.value).toBeCloseTo(32768/65535);expect(s.doc.snapshot().graph).toEqual(snapshot.graph);
		}finally{projection.group.traverse((o:any)=>{o.geometry?.dispose();for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[])m.dispose();});}
		s.run({type:'raw',command:{kind:'PUSH_PULL_FACE',faceId:s.faceId,distance:.5}},[group]);expect(s.doc.snapshot().graph.meshes[0]!.faces.some(f=>f.backMaterialId===back)).toBe(true);
		const writer=new BomcWriter(s.doc);try{const output=await writer.write(),reader=await readWebBomc(output.bytes);try{expect(reader.snapshot().graph).toEqual(s.doc.snapshot().graph);}finally{reader.dispose();}}finally{writer.dispose();}
	}finally{s.doc.dispose();}
});

test('Tags hide occurrences without losing definitions; library definitions survive source deletion and real reopen',async()=>{
	const s=setup();try{
		const id=s.run({type:'group',selection:[{type:'face',id:s.faceId}],containerKind:'group',name:'Chair'});
		s.run({type:'tag-create',name:'Furniture'});const tag=organization(s.doc.snapshot().graph).tags[0]!;
		s.run({type:'tag-assign',instanceIds:[id],tagId:tag.id});s.run({type:'tag-visibility',tagId:tag.id,visible:false});
		expect(modelOccurrences(s.doc.snapshot().graph)).toHaveLength(1);expect(outlinerEntries(s.doc.snapshot().graph)[0]!.visible).toBe(false);expect(validateAuthoringDocument(s.doc.snapshot().graph).editable).toBe(true);
		s.run({type:'asset-create',instanceId:id,name:'Saved Chair'});const asset=organization(s.doc.snapshot().graph).assets[0]!;
		expect(assetCost(s.doc.snapshot().graph,asset.definitionId).faces).toBe(1);
		s.run({type:'erase',selection:[{type:'instance',id}]});expect(s.doc.snapshot().graph.definitions.some(d=>d.id===asset.definitionId)).toBe(true);
		const inserted=s.run({type:'asset-insert',assetId:asset.id,point:[7,0,0]});expect(modelOccurrences(s.doc.snapshot().graph)).toHaveLength(2);
		expect(new Matrix4().fromArray(s.doc.snapshot().graph.instances.find(i=>i.id===inserted)!.matrix).elements[12]).toBe(7);
		const final=s.doc.snapshot().graph,writer=new BomcWriter(s.doc);try{const output=await writer.write(),reopened=await readWebBomc(output.bytes);try{expect(reopened.snapshot().graph).toEqual(final);expect(validateAuthoringDocument(reopened.snapshot().graph).editable).toBe(true);}finally{reopened.dispose();}}finally{writer.dispose();}
		s.history.undo(s.doc);s.history.redo(s.doc);expect(s.doc.snapshot().graph).toEqual(final);
		s.run({type:'asset-delete',assetId:asset.id});expect(s.doc.snapshot().graph.definitions.some(d=>d.id===asset.definitionId)).toBe(true);
	}finally{s.doc.dispose();}
});
