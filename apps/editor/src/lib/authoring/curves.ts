import { Vector3 } from 'three';
import type { Face, Mesh } from '@sibambo/bomc-document';
import type { AuthoringPoint } from './protocol.js';
import { AuthoringGeometryError, faceFromRing } from './geometry.js';
import { preparePolygon } from './polygon.js';

const fail=(message:string):never=>{throw new AuthoringGeometryError(message);};
const tuple=(v:Vector3):AuthoringPoint=>[v.x,v.y,v.z];
export function curvePoints(center:AuthoringPoint, first:AuthoringPoint, normal:AuthoringPoint, segments:number, sweepDegrees=360):AuthoringPoint[] {
	if(!Number.isInteger(segments)||segments<3||segments>256)fail('Segments must be an integer from 3 to 256.');
	if(![...center,...first,...normal,sweepDegrees].every(Number.isFinite)||Math.abs(sweepDegrees)<.001||Math.abs(sweepDegrees)>360)fail('Curve inputs must be finite; sweep must be 0.001–360 degrees.');
	const n=new Vector3(...normal),u=new Vector3(...first).sub(new Vector3(...center));
	if(Math.abs(n.length()-1)>1e-9||u.length()<1e-6||Math.abs(u.dot(n))>1e-9*Math.max(1,u.length()))fail('Radius must lie on the captured plane and be at least 0.000001 m.');
	const count=Math.abs(sweepDegrees)===360?segments:segments+1;
	return Array.from({length:count},(_,i)=>tuple(u.clone().applyAxisAngle(n,sweepDegrees*Math.PI/180*i/segments).add(new Vector3(...center))));
}

/** Order an actual selected edge chain. Branches, duplicates and disconnected paths reject. */
export function orderedPath(edges:readonly {start:AuthoringPoint;end:AuthoringPoint}[], near:AuthoringPoint):AuthoringPoint[] {
	if(edges.length<1||edges.length>256)fail('Follow Me needs 1–256 connected path edges.');
	const nodes:AuthoringPoint[]=[],links:number[][]=[];
	const index=(p:AuthoringPoint)=>{let i=nodes.findIndex(q=>new Vector3(...p).distanceTo(new Vector3(...q))<1e-8);if(i<0){i=nodes.length;nodes.push(p);links.push([]);}return i;};
	const unique=new Set<string>();
	for(const e of edges){const a=index(e.start),b=index(e.end),key=[a,b].sort((x,y)=>x-y).join(':');if(a===b||unique.has(key))fail('Follow Me path has zero-length or duplicate edges.');unique.add(key);links[a]!.push(b);links[b]!.push(a);}
	if(links.some(l=>l.length>2))fail('Follow Me path branches.');
	const ends=links.map((l,i)=>l.length===1?i:-1).filter(i=>i>=0),closed=ends.length===0;
	if(!closed&&ends.length!==2)fail('Follow Me needs one continuous open or closed path.');
	const candidates=closed?nodes.map((_,i)=>i):ends;
	candidates.sort((a,b)=>new Vector3(...nodes[a]!).distanceToSquared(new Vector3(...near))-new Vector3(...nodes[b]!).distanceToSquared(new Vector3(...near))||a-b);
	const start=candidates[0]!,result:AuthoringPoint[]=[],visited=new Set<number>();let at=start,previous=-1;
	while(!visited.has(at)){visited.add(at);result.push(nodes[at]!);const next=links[at]!.find(n=>n!==previous);if(next===undefined)break;previous=at;at=next;}
	if(visited.size!==nodes.length)fail('Follow Me path is disconnected.');
	if(closed)result.push(nodes[start]!);
	return result;
}

/** Miter a section along a simple planar path; preserve profile holes and materials. */
export function sweepProfile(mesh:Mesh, profile:Face, path:readonly AuthoringPoint[], prefix:string):Mesh {
	const pts=path.map(p=>new Vector3(...p)),closed=pts[0]!.distanceTo(pts.at(-1)!)<1e-8;
	if(closed)pts.pop();
	if(pts.length<2||closed&&pts.length<3)fail('Follow Me path is too short.');
	const directions=Array.from({length:closed?pts.length:pts.length-1},(_,i)=>pts[(i+1)%pts.length]!.clone().sub(pts[i]!).normalize());
	const first=directions[0]!,normal=new Vector3(...profile.normal);
	if(Math.abs(normal.dot(first))<1-1e-8)fail('Follow Me profile must be perpendicular to the first path segment.');
	let binormal:Vector3|undefined;
	for(let i=1;i<directions.length;i++){const cross=first.clone().cross(directions[i]!);if(cross.length()>1e-8){binormal=cross.normalize();break;}}
	if(!binormal){const edge=profile.outer.slice(1).map(i=>new Vector3(...mesh.positions.slice(i*3,i*3+3) as [number,number,number]).sub(new Vector3(...mesh.positions.slice(profile.outer[0]!*3,profile.outer[0]!*3+3) as [number,number,number]))).find(v=>v.length()>1e-6)!;binormal=edge.normalize();}
	if(pts.some(p=>Math.abs(p.clone().sub(pts[0]!).dot(binormal!))>1e-8*Math.max(1,p.distanceTo(pts[0]!))))fail('Follow Me currently requires a planar path.');
	const side=binormal.clone().cross(first).normalize(),vertices=[...new Set([profile.outer,...profile.holes].flat())];
	if(vertices.some(i=>Math.abs(new Vector3(...mesh.positions.slice(i*3,i*3+3) as [number,number,number]).sub(pts[0]!).dot(first))>1e-8))fail('Follow Me profile must lie on the starting path plane.');
	const coords=vertices.map(i=>{const p=new Vector3(...mesh.positions.slice(i*3,i*3+3) as [number,number,number]).sub(pts[0]!);return [p.dot(binormal!),p.dot(side)] as const;});
	const positions=[...mesh.positions],rings:number[][]=[],acrossSections:Vector3[]=[];
	for(let i=0;i<pts.length;i++){
		const incoming=directions[(i-1+directions.length)%directions.length]!,outgoing=directions[i%directions.length]!;
		const tangent=(!closed&&i===0?outgoing:!closed&&i===pts.length-1?incoming:incoming.clone().add(outgoing).normalize()).clone();
		const denominator=!closed&&(i===0||i===pts.length-1)?1:tangent.dot(outgoing);
		if(denominator<.05)fail('Follow Me path reverses or has a corner sharper than the miter limit.');
		const across=binormal.clone().cross(tangent).multiplyScalar(1/denominator);
		acrossSections.push(across);
		rings.push(coords.map(([u,v])=>{const id=positions.length/3;positions.push(...pts[i]!.clone().addScaledVector(binormal!,u).addScaledVector(across,v).toArray());return id;}));
	}
	// Conservatively validate the whole profile-width envelope before creating faces.
	// A swept strip that folds or crosses itself needs Boolean resolution, outside this tool.
	const limits=[Math.min(...coords.map(c=>c[1])),Math.max(...coords.map(c=>c[1]))];
	const boundaries=limits.map(v=>pts.map((p,i)=>p.clone().addScaledVector(acrossSections[i]!,v)));
	for(const boundary of boundaries)for(let i=0;i<directions.length;i++)if(boundary[(i+1)%pts.length]!.clone().sub(boundary[i]!).dot(directions[i]!)<1e-6)fail('Follow Me profile is too wide for a path segment.');
	try {
		if(closed)for(const boundary of boundaries)preparePolygon(boundary.map(tuple),tuple(binormal));
		else preparePolygon([...boundaries[0]!,...[...boundaries[1]!].reverse()].map(tuple),tuple(binormal));
	}catch{fail('Follow Me swept profile envelope intersects itself. Reduce the profile or simplify the path.');}
	if(closed){
		const xy=(p:Vector3)=>[p.dot(first),p.dot(side)] as const;
		const cross=(a:readonly number[],b:readonly number[],c:readonly number[])=>(b[0]!-a[0]!)*(c[1]!-a[1]!)-(b[1]!-a[1]!)*(c[0]!-a[0]!);
		for(let i=0;i<pts.length;i++)for(let j=0;j<pts.length;j++){
			const a=xy(boundaries[0]![i]!),b=xy(boundaries[0]![(i+1)%pts.length]!),c=xy(boundaries[1]![j]!),d=xy(boundaries[1]![(j+1)%pts.length]!);
			if(cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0&&Math.max(a[0],b[0])+1e-9>=Math.min(c[0],d[0])&&Math.max(c[0],d[0])+1e-9>=Math.min(a[0],b[0])&&Math.max(a[1],b[1])+1e-9>=Math.min(c[1],d[1])&&Math.max(c[1],d[1])+1e-9>=Math.min(a[1],b[1]))fail('Follow Me inner and outer envelopes intersect.');
		}
	}
	const faces=mesh.faces.filter(f=>f.id!==profile.id),expanded={...mesh,positions,faces};let count=0;
	const make=(ring:number[],holes:number[][]=[],preferred?:AuthoringPoint)=>faceFromRing(expanded,prefix+':'+ ++count,ring,profile.frontMaterialId!,profile.backMaterialId,JSON.stringify(['sibambo-editor-shape-v2','split',prefix+':'+count]),preferred,holes);
	const ringAt=(ring:readonly number[],i:number)=>ring.map(v=>rings[i]![vertices.indexOf(v)]!);
	if(!closed){faces.push(make([...ringAt(profile.outer,0)].reverse(),profile.holes.map(h=>[...ringAt(h,0)].reverse()),tuple(first.clone().negate())));faces.push(make(ringAt(profile.outer,pts.length-1),profile.holes.map(h=>ringAt(h,pts.length-1)),tuple(directions.at(-1)!)));}
	for(let segment=0;segment<directions.length;segment++)for(const source of [profile.outer,...profile.holes]){
		const a=ringAt(source,segment),b=ringAt(source,(segment+1)%pts.length);
		let orientation=new Vector3();for(let i=0;i<source.length;i++){const p=new Vector3(...mesh.positions.slice(source[i]!*3,source[i]!*3+3) as [number,number,number]),q=new Vector3(...mesh.positions.slice(source[(i+1)%source.length]!*3,source[(i+1)%source.length]!*3+3) as [number,number,number]);orientation.add(p.cross(q));}
		const reverse=(source===profile.outer?1:-1)*Math.sign(orientation.dot(first))<0;
		for(let i=0;i<a.length;i++){const j=(i+1)%a.length,ring=[a[i]!,a[j]!,b[j]!,b[i]!];const edge=new Vector3(...positions.slice(a[j]!*3,a[j]!*3+3) as [number,number,number]).sub(new Vector3(...positions.slice(a[i]!*3,a[i]!*3+3) as [number,number,number]));const preferred=edge.cross(directions[segment]!).normalize().multiplyScalar(reverse?-1:1);faces.push(make(ring,[],tuple(preferred)));}
	}
	return expanded;
}
