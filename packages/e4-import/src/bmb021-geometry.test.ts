import './bmb021-browser-test-stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { BomcLoader } from './bomc-loader';

type Point = [number,number,number];
type Triangle = {points: Point[]; mesh: number};
const root=process.env.BMB021_BUILDER_DIR;
if(!root) throw new Error('BMB021_BUILDER_DIR required');
const directory=join(root,'tests/interop/goldens');
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
const near=(a:number,b:number)=>expect(Math.abs(a-b)).toBeLessThan(0.00001);

for(const name of ['two-room-door-seam','wall-window-cutout']) {
  test('BMB-021 real rendered '+name+' retains opening void and single wall ownership',async()=>{
    const f=manifest.fixtures.find((f:{name:string})=>f.name===name);
    const raw=new Uint8Array(readFileSync(join(directory,f.file)));
    const value=await new BomcLoader().load(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength) as ArrayBuffer,name,{prepareSolid:false});
    const triangles:Triangle[]=[];
    const allFaces=new Set<number>();
    let frontTriangles=0;
    for(const g of value.preparedRuntimeScene.groups) {
      for(const id of g.sourceFaceIndicesByTriangle||[]) allFaces.add(id);
      if(g.renderSide==='back') continue;
      frontTriangles+=g.indices.length/3;
      // Plaster is explicitly authored in both pinned source fixtures.
      if(!g.baseColorRgba || Math.abs(g.baseColorRgba[0]-245/255)>1e-8) continue;
      const mesh=value.preparedRuntimeScene.meshes[g.sourceMeshIndex]!;
      for(let at=0;at<g.matrices.length;at+=16) {
        const m=g.matrices;
        const point=(index:number):Point=>{
          const x=mesh.positions[index*3]!,y=mesh.positions[index*3+1]!,z=mesh.positions[index*3+2]!;
          const wx=m[at]!*x+m[at+4]!*y+m[at+8]!*z+m[at+12]!;
          const wy=m[at+1]!*x+m[at+5]!*y+m[at+9]!*z+m[at+13]!;
          const wz=m[at+2]!*x+m[at+6]!*y+m[at+10]!*z+m[at+14]!;
          return [wx,-wz,wy]; // source Z-up world coordinates
        };
        for(let i=0;i<g.indices.length;i+=3) triangles.push({mesh:g.sourceMeshIndex,
          points:[point(g.indices[i]!),point(g.indices[i+1]!),point(g.indices[i+2]!)]});
      }
    }
    expect([...allFaces].sort((a,b)=>a-b)).toEqual(Array.from({length:f.reader.counts.faces},(_,i)=>i));
    expect(frontTriangles).toBe(f.reader.triangles);
    const door=name==='two-room-door-seam';
    const normalAxis=door?0:1, horizontalAxis=door?1:0;
    const planes=door?[3.925,4.075]:[-0.1,0.1];
    const min=door?1:1.2,max=door?1.9:2.4,bottom=door?0:0.9,top=2.1;
    const owners=new Set<number>();
    for(const plane of planes) {
      const wall=triangles.filter(t=>t.points.every(p=>Math.abs(p[normalAxis]!-plane)<1e-5));
      expect(wall.length).toBeGreaterThan(0);
      let area=0;
      for(const t of wall) {
        owners.add(t.mesh);
        const [a,b,c]=t.points;
        area+=Math.abs((b![horizontalAxis]!-a![horizontalAxis]!)*(c![2]!-a![2]!)-
          (c![horizontalAxis]!-a![horizontalAxis]!)*(b![2]!-a![2]!))/2;
      }
      near(area,door?3*2.8-0.9*2.1:4*2.8-1.2*1.2);
      // Nine interior samples must remain uncovered by opaque wall triangles.
      for(const u of [0.2,0.5,0.8]) for(const v of [0.2,0.5,0.8]) {
        const x=min+(max-min)*u,y=bottom+(top-bottom)*v;
        const contains=(t:Triangle)=>{
          const [a,b,c]=t.points;
          const cross=(p:Point,q:Point)=>(q[horizontalAxis]!-p[horizontalAxis]!)*(y-p[2])-(q[2]-p[2])*(x-p[horizontalAxis]!);
          const signs=[cross(a!,b!),cross(b!,c!),cross(c!,a!)];
          return signs.every(s=>s>=-1e-7)||signs.every(s=>s<=1e-7);
        };
        expect(wall.some(contains),'opaque triangle closes opening').toBe(false);
      }
    }
    expect(owners.size,'seam/wall has exactly one source mesh owner').toBe(1);
    console.log(JSON.stringify({gate:'ORIGINAL_CONSUMER_OPENING',name,status:'PASS',
      sourceFaces:allFaces.size,frontTriangles,wallMeshOwners:[...owners]}));
  });
}
