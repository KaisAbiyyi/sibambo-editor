import type { BomcGraph } from '@sibambo/bomc-document';
import { AuthoringGeometryError } from './geometry.js';

export type ModelOrganization = {
	version: 1;
	tags: { id: string; name: string; visible: boolean }[];
	assignments: { instanceId: string; tagId: string }[];
	assets: { id: string; name: string; definitionId: string }[];
};
export const emptyOrganization=():ModelOrganization=>({version:1,tags:[],assignments:[],assets:[]});
function fail(message:string):never{throw new AuthoringGeometryError(message);}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:Record<string,unknown>,fields:string[])=>Object.keys(value).sort().join(',')===fields.sort().join(',');
const name=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=128;
export function organization(graph:BomcGraph):ModelOrganization {
	const label=graph.instances.find(i=>i.id===graph.rootInstanceId)?.label;
	if(!label)return emptyOrganization();
	const value=JSON.parse(label).organization;
	if(value===undefined)return emptyOrganization();
	validateOrganization(value,graph);return structuredClone(value);
}
export function validateOrganization(value:unknown,graph:BomcGraph):asserts value is ModelOrganization {
	if(!record(value)||!keys(value,['version','tags','assignments','assets'])||value.version!==1||!Array.isArray(value.tags)||!Array.isArray(value.assignments)||!Array.isArray(value.assets))fail('Invalid organization metadata.');
	if(value.tags.length>128||value.assets.length>256||value.assignments.length>10000)fail('Organization budget exceeded.');
	const ids=new Set<string>();
	for(const [list,kind] of [[value.tags,'tag'],[value.assets,'asset']] as const)for(const item of list){
		if(!record(item)||!keys(item,kind==='tag'?['id','name','visible']:['id','name','definitionId'])||typeof item.id!=='string'||!item.id.startsWith(graph.documentId+':'+kind+':op:')||ids.has(item.id)||!name(item.name))fail('Invalid tag/asset identity or name.');
		ids.add(item.id);
		if(kind==='tag'?typeof item.visible!=='boolean':!graph.definitions.some(d=>d.id===item.definitionId&&d.kind==='component'))fail('Invalid tag visibility or asset definition.');
	}
	const assigned=new Set<string>();for(const item of value.assignments){
		if(!record(item)||!keys(item,['instanceId','tagId'])||typeof item.instanceId!=='string'||assigned.has(item.instanceId)||!graph.instances.some(i=>i.id===item.instanceId&&i.kind!=='root')||!value.tags.some(t=>t.id===item.tagId))fail('Invalid instance tag assignment.');assigned.add(item.instanceId);
	}
}
export function instanceVisible(graph:BomcGraph,id:string,org=organization(graph)):boolean {
	const instance=graph.instances.find(i=>i.id===id),tagId=org.assignments.find(a=>a.instanceId===id)?.tagId;
	return !!instance?.visible&&(!tagId||org.tags.find(t=>t.id===tagId)?.visible!==false);
}
export function structuralDefinitions(graph:BomcGraph):Set<string> {
	const result=new Set<string>();
	const visit=(id:string,ancestors:Set<string>)=>{
		if(ancestors.has(id)||ancestors.size>32)fail('Cyclic or excessive authoring hierarchy.');
		if(result.has(id))return;result.add(id);
		if(result.size>10000||!graph.definitions.some(d=>d.id===id))fail('Invalid authoring definition ownership.');
		for(const child of graph.instances.filter(i=>i.ownerDefinitionId===id))visit(child.definitionId,new Set(ancestors).add(id));
	};
	for(const id of [graph.rootDefinitionId,...organization(graph).assets.map(a=>a.definitionId)])visit(id,new Set());return result;
}
export function outlinerEntries(graph:BomcGraph) {
	const org=organization(graph),entries:{id:string;name:string;kind:string;path:string[];visible:boolean;definitionId:string}[]=[];
	const walk=(owner:string,path:string[],visible:boolean)=>{
		if(path.length>32||entries.length>10000)fail('Outliner hierarchy budget exceeded.');
		for(const i of graph.instances.filter(i=>i.ownerDefinitionId===owner).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))){
			const next=[...path,i.id],shown=visible&&instanceVisible(graph,i.id,org);entries.push({id:i.id,name:i.name,kind:i.kind,path:next,visible:shown,definitionId:i.definitionId});walk(i.definitionId,next,shown);
		}
	};walk(graph.rootDefinitionId,[],true);return entries;
}
export function assetCost(graph:BomcGraph,definitionId:string) {
	const definitions=new Set<string>();let faces=0,vertices=0,instances=0;
	const visit=(id:string,depth:number)=>{
		if(depth>32||instances>10000)fail('Asset hierarchy budget exceeded.');instances++;
		const mesh=graph.meshes.find(m=>m.definitionId===id);faces+=mesh?.faces.length??0;vertices+=(mesh?.positions.length??0)/3;definitions.add(id);
		for(const child of graph.instances.filter(i=>i.ownerDefinitionId===id))visit(child.definitionId,depth+1);
	};visit(definitionId,0);
	const bytes=new TextEncoder().encode(JSON.stringify({definitions:graph.definitions.filter(d=>definitions.has(d.id)),meshes:graph.meshes.filter(m=>definitions.has(m.definitionId)),instances:graph.instances.filter(i=>i.ownerDefinitionId&&definitions.has(i.ownerDefinitionId))})).byteLength;
	return {faces,vertices,instances,bytes};
}
