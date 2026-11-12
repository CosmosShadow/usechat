import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../scripts/wechat.mjs',import.meta.url));
test('help works without native build or app interaction',()=>{
  const r=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
  assert.equal(r.status,0); assert.match(r.stdout,/disabled by default/);
});
test('shared desktop input fails closed without explicit flag', {skip:process.platform!=='darwin'},()=>{
  for(const command of ['focus','click','scroll','type','key']) {
    const r=spawnSync(process.execPath,[cli,command],{encoding:'utf8'});
    assert.equal(r.status,1); assert.match(r.stderr,/Shared desktop input disabled/);
  }
});
