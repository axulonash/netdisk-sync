import {strict as assert} from 'assert';
import {skipUnsupportedEmptyUploads,syncFailureDiagnostic,tooLargeSkippedFiles} from '../src/syncProgress';

it('reports files skipped for exceeding the size limit',()=>{
 const plan:any={
  'big.md':{key:'big.md',decision:'local_is_created_too_large_then_do_nothing'},
  'far.md':{key:'far.md',decision:'remote_is_created_too_large_then_do_nothing'},
  'ok.md':{key:'ok.md',decision:'local_is_created_then_push'},
 };
 assert.deepEqual(tooLargeSkippedFiles(plan),['big.md','far.md']);
});

describe('network failure diagnostics',()=>{
 it('retains a safe timeout code without leaking the raw message',()=>{
  const result=syncFailureDiagnostic(Object.assign(new Error('secret URL and password'),{code:'ETIMEDOUT'}),'upload');
  assert.deepEqual(result,{action:'upload',reason:'network_error',networkCode:'ETIMEDOUT'});
 });
});

it('preserves only safe transfer fields from a wrapper error',()=>{
 const error=Object.assign(new Error('sensitive path'),{code:'ETIMEDOUT',transfer:{phase:'awaiting_response',bodyBytes:4194304,bodyFlushed:true,elapsedMs:33000,timeout:'idle',url:'secret',headers:{Authorization:'secret'}},cause:Object.assign(new Error('secret'),{code:'ETIMEDOUT'})});
 const result=syncFailureDiagnostic(error,'upload');
 assert.deepEqual(result,{action:'upload',reason:'network_error',networkCode:'ETIMEDOUT',transfer:{phase:'awaiting_response',bodyBytes:4194304,bodyFlushed:true,elapsedMs:33000,timeout:'idle'}});
});
it('classifies domestic transport timeouts and HTTP codes without exposing response text',()=>{
 assert.equal(syncFailureDiagnostic({code:'request_timeout',networkCode:'ETIMEDOUT'},'upload').reason,'network_error');
 assert.equal(syncFailureDiagnostic({code:'download_http_403',message:'private signed URL'},'download').httpStatus,403);
 assert.equal(syncFailureDiagnostic({code:'request_timeout',networkCode:'ETIMEDOUT'},'upload').networkCode,'ETIMEDOUT');
});
it('keeps a controlled Baidu failure code when the generic category is unknown',()=>{
 const diagnostic=syncFailureDiagnostic({name:'BaiduWebProbeError',code:'invalid_precreate',message:'secret'},'upload');
 assert.equal(diagnostic.providerCode,'invalid_precreate');
 assert.ok(!JSON.stringify(diagnostic).includes('secret'));
});
it('exports the controlled Baidu batch operation and item error',()=>{
 const result=syncFailureDiagnostic({name:'BaiduWebProbeError',code:'api_errno_12',apiName:'filemanager',apiOperation:'rename',itemErrno:-8},'upload');
 assert.equal(result.apiName,'filemanager');assert.equal(result.apiOperation,'rename');assert.equal(result.itemErrno,-8);
});
it('retains only the controlled Quark provider code and outcome for failed folder creation',()=>{
 const result=syncFailureDiagnostic(Object.assign(new Error('secret cookie and signed URL'),{name:'QuarkError',code:'api_rejected',outcomeUnknown:true}),'createFolder');
 assert.deepEqual(result,{action:'createFolder',reason:'provider_error',providerCode:'api_rejected',outcomeUnknown:true});
 assert.ok(!JSON.stringify(result).includes('secret'));
});
it('keeps a safe upload stage for Quark upload failures even when the code was previously unknown',()=>{
 const result=syncFailureDiagnostic({name:'QuarkError',code:'part_upload_failed',providerStage:'upload_part',outcomeUnknown:true,message:'signed URL'},'upload');
 assert.deepEqual(result,{action:'upload',reason:'provider_error',providerCode:'part_upload_failed',providerStage:'upload_part',outcomeUnknown:true});
 assert.ok(!JSON.stringify(result).includes('signed URL'));
});
it('identifies which Quark API upload request returned HTTP 500',()=>{
 const result=syncFailureDiagnostic({name:'QuarkError',code:'http_500',providerStage:'upload_authorize'},'upload');
 assert.deepEqual(result,{action:'upload',reason:'http_error',providerCode:'http_500',providerStage:'upload_authorize',httpStatus:500});
});
it('retains a controlled Aliyun upload stage with timeout telemetry',()=>{
 const result=syncFailureDiagnostic({name:'AliyunError',code:'request_timeout',providerStage:'upload_part',outcomeUnknown:true,networkCode:'ETIMEDOUT',transfer:{phase:'awaiting_response',bodyBytes:10485760,bodyFlushed:true,elapsedMs:104001,timeout:'total',url:'signed-url'}},'upload');
 assert.deepEqual(result,{action:'upload',reason:'network_error',providerCode:'request_timeout',providerStage:'upload_part',outcomeUnknown:true,networkCode:'ETIMEDOUT',transfer:{phase:'awaiting_response',bodyBytes:10485760,bodyFlushed:true,elapsedMs:104001,timeout:'total'}});
 assert.ok(!JSON.stringify(result).includes('signed-url'));
});
it('records the Aliyun download stage and received response bytes without exposing URLs',()=>{
 const result=syncFailureDiagnostic({name:'AliyunError',code:'request_timeout',providerStage:'download_transfer',networkCode:'ETIMEDOUT',transfer:{phase:'receiving_response',bodyBytes:0,responseBytes:2097152,bodyFlushed:true,elapsedMs:104001,timeout:'total',url:'signed-url'}},'download');
 assert.deepEqual(result,{action:'download',reason:'network_error',providerCode:'request_timeout',providerStage:'download_transfer',networkCode:'ETIMEDOUT',transfer:{phase:'receiving_response',bodyBytes:0,bodyFlushed:true,responseBytes:2097152,elapsedMs:104001,timeout:'total'}});
 assert.ok(!JSON.stringify(result).includes('signed-url'));
});
it('preflights empty Quark uploads but leaves encrypted files and downloads alone',()=>{
 const plan:any={
  empty:{key:'未命名.md',decision:'local_is_created_then_push',local:{size:0}},
  download:{key:'old-empty.md',decision:'remote_is_modified_then_pull',local:{size:0}},
 };
 assert.deepEqual(skipUnsupportedEmptyUploads(plan,false),['未命名.md']);
 assert.equal(plan.empty.decision,'unsupported_empty_then_skip');
 assert.deepEqual(skipUnsupportedEmptyUploads({empty:{key:'未命名.md',decision:'local_is_created_then_push',local:{size:0}}} as any,true),[]);
});
