import { expect, test, type Page } from '@playwright/test';

const project = 'demo-project-01', csrf = 'synthetic-csrf';
type Fixture = { pending: boolean; granted: boolean; paused: boolean; reject: boolean; requests: any[]; calls: any[] };
async function fixture(page: Page): Promise<Fixture> {
  const f: Fixture = { pending: true, granted: false, paused: false, reject: false, requests: [], calls: [] };
  await page.route('**/api/mcp/session**', async r => {
    const selected = new URL(r.request().url()).searchParams.get('project') === project;
    const agent = { id: 'pending-1', clientId: 'client-attacker-1', agentSubject: 'subject-attacker-1',
      displayName: 'Claude Code (untrusted label)', scopes: ['read','write'], expiresAt: new Date(Date.now()+120000).toISOString() };
    await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      contract:'se04-owner-mcp-v1',phase: !selected?'project-selected':f.paused?'paused':f.granted?'writer-active':'awaiting-owner-grant',
      configured:true,serviceReady:true,subject:'owner-01',csrf,
      projectId:selected?project:undefined,projectName:selected?'Synthetic Project':undefined,
      capabilities:['read','write'],pending:selected&&f.pending?[agent]:[],
      grants:selected&&f.granted?[{...agent,id:'grant-1',state:'active'}]:[],
      writer:selected&&f.granted?'subject-attacker-1':null,
      seenRevision:4,renderedRevision:4,paused:f.paused,requests:f.requests
    })});
  });
  for (const ep of ['grants','pause','requests','logout']) {
    await page.route('**/api/mcp/'+ep, async r => {
      if (r.request().method() === 'GET') {
        await r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({contract:'se04-owner-mcp-v1',requests:f.requests})}); return;
      }
      const body = r.request().postDataJSON();
      f.calls.push({ep,body,csrf:r.request().headers()['x-se04-csrf']});
      if (r.request().headers()['x-se04-csrf'] !== csrf || f.reject) {
        await r.fulfill({status:403,contentType:'application/json',body:'{}'});return;
      }
      if (ep==='grants') {
        if (body.action==='approve') {f.pending=false;f.granted=true;}
        if (body.action==='deny') f.pending=false;
        if (['revoke','remove'].includes(body.action)) f.granted=false;
      }
      if (ep==='pause') f.paused=body.paused;
      if (ep==='requests'&&body.action==='create') f.requests.push({id:'request-1',body:body.body,moduleIds:body.moduleIds,status:'open'});
      await r.fulfill({status:200,contentType:'application/json',body:'{"contract":"se04-owner-mcp-v1"}'});
    });
  }
  return f;
}
async function open(page: Page) {
  await page.locator('summary').filter({hasText:'Extensions'}).click();
  await page.getByRole('button',{name:'MCP Extension…'}).click();
  await expect(page.getByRole('dialog',{name:'MCP Extension'})).toBeVisible();
}
async function select(page: Page) {
  await page.getByLabel('ID proyek (hanya proyek yang diizinkan server)').fill(project);
  await page.getByRole('button',{name:'Buka proyek'}).click();
  await expect(page.getByText('Synthetic Project')).toBeVisible();
}

test('identity spoof, incorrect pairing code, consent denied and CSRF',async({page})=>{
  const f=await fixture(page);await page.goto('/');await open(page);await select(page);
  await expect(page.getByText('subject-attacker-1').first()).toBeVisible();
  await expect(page.getByText('client-attacker-1').first()).toBeVisible();
  await page.getByLabel('Kode 8 karakter yang tampil di agent').fill('BAD');
  await page.getByRole('button',{name:'Izinkan scope tepat ini'}).click();
  await expect(page.getByRole('alert')).toContainText('8 karakter');
  expect(f.calls.length).toBe(0);
  f.reject=true;
  await page.getByLabel('Kode 8 karakter yang tampil di agent').fill('ABCDEFGH');
  await page.getByRole('button',{name:'Izinkan scope tepat ini'}).click();
  await expect(page.getByRole('alert')).toContainText('CSRF');
  expect(f.granted).toBe(false);
  f.reject=false;
  await page.getByRole('button',{name:'Tolak'}).click();
  await expect(page.getByText('Belum ada agent menunggu persetujuan.')).toBeVisible();
  expect(f.granted).toBe(false);
  expect(f.calls.every(x=>x.csrf===csrf)).toBe(true);
});
test('grant, pause, owner request, and revoke are separate operations',async({page})=>{
  const f=await fixture(page);await page.goto('/');await open(page);await select(page);
  await page.getByLabel('Kode 8 karakter yang tampil di agent').fill('ABCDEFGH');
  await page.getByRole('button',{name:'Izinkan scope tepat ini'}).click();
  await expect(page.getByText('Status: writer-active')).toBeVisible();
  await page.getByRole('button',{name:'Jeda semua perubahan'}).click();
  await expect(page.getByRole('button',{name:'Lanjutkan proyek'})).toBeVisible();
  await page.getByRole('textbox',{name:'Pesan revisi'}).fill('Revisi jendela.');
  await page.getByRole('button',{name:'Kirim permintaan revisi'}).click();
  expect(f.requests.length).toBe(1);
  await page.getByRole('button',{name:'Cabut akses'}).click();
  expect(f.granted).toBe(false);expect(f.paused).toBe(true);
});
test('reopen preserves draft, Escape closes panel',async({page})=>{
  await fixture(page);await page.goto('/');await open(page);await select(page);
  await page.getByRole('textbox',{name:'Pesan revisi'}).fill('Draft belum terkirim.');
  await page.getByRole('button',{name:'Tutup MCP Extension'}).click();
  await open(page);
  await expect(page.getByRole('textbox',{name:'Pesan revisi'})).toHaveValue('Draft belum terkirim.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'MCP Extension'})).toBeHidden();
});
for(const width of [320,768,1440])test('responsive and keyboard controls at '+width+'px',async({page})=>{
  await page.setViewportSize({width,height:860});
  await fixture(page);await page.goto('/');await open(page);await select(page);
  const b=page.getByRole('button',{name:'Jeda semua perubahan'});await b.scrollIntoViewIfNeeded();
  const box=await b.boundingBox();expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
});
test('unauthenticated direct API cannot mutate session or grant',async({request})=>{
  for(const ep of ['grants','pause','requests','ticket','logout']){
    const r=await request.post('/api/mcp/'+ep,{data:{projectId:project,paused:false},headers:{origin:'http://localhost:5175','x-se04-csrf':'fake'}});
    expect([401,403,503]).toContain(r.status());
  }
});
