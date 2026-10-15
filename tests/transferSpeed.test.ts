import {strict as assert} from 'assert';
import {TransferSpeed} from '../src/transferSpeed';
describe('transfer speed sampling',()=>{
 it('keeps upload and download separate and falls to zero when stalled',()=>{
  const s=new TransferSpeed(0);s.add('upload',2048);s.add('download',1024);
  assert.deepEqual(s.sample(1000),{upload:2048,download:1024});
  assert.deepEqual(s.sample(2000),{upload:0,download:0});
 });
 it('ignores invalid byte counts and samples elapsed time',()=>{
  const s=new TransferSpeed(1000);s.add('upload',-1);s.add('download',NaN);s.add('upload',1024);
  assert.deepEqual(s.sample(1500),{upload:2048,download:0});
 });
});
