import {strict as assert} from 'assert';
import {resolveWebdavDirectory,migrateWebdavDirectory} from '../src/webdavDirectory';
describe('WebDAV parent directory belongs to the current vault',()=>{
 it('migrates the old test target to the current vault under the same parent',()=>{
  const config:any={remoteBaseDir:'/home/Drive/test'};
  migrateWebdavDirectory(config,'我的笔记本');
  assert.equal(config.parentDir,'home/Drive');
  assert.equal(resolveWebdavDirectory(config,'我的笔记本'),'home/Drive/我的笔记本');
 });
 it('resolves a renamed vault without appending the previous name twice',()=>{
  const config:any={parentDir:'/home/Drive/',remoteBaseDir:'home/Drive/旧名称'};
  assert.equal(resolveWebdavDirectory(config,'新名称'),'home/Drive/新名称');
 });
 it('keeps a correctly named legacy target and the default vault location',()=>{
  const config:any={remoteBaseDir:'/home/Drive/我的笔记本'};migrateWebdavDirectory(config,'我的笔记本');
  assert.equal(resolveWebdavDirectory(config,'我的笔记本'),'home/Drive/我的笔记本');
  const defaults:any={};migrateWebdavDirectory(defaults,'我的笔记本');
  assert.equal(resolveWebdavDirectory(defaults,'我的笔记本'),'我的笔记本');
 });
});
