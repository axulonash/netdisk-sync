import {FakeFs} from './fsAll';
import {BaiduWebSyncClient,baiduWebEntity} from './native/baiduWebSync';
import {BaiduWebProbeError} from './native/baiduWebProbe';
export class FakeFsBaiduWeb extends FakeFs {
 kind='baidu';private tail:Promise<unknown>=Promise.resolve();
 constructor(private readonly client:BaiduWebSyncClient){super();}
 private queue<T>(action:()=>Promise<T>):Promise<T>{const task=this.tail.then(async()=>{this.client.guard();const result=await action();this.client.guard();return result;});this.tail=task.catch(()=>{});return task;}
 walk(){return this.queue(async()=>(await this.client.scan((files,folders)=>this.onScanProgress?.(files,folders))).map(baiduWebEntity));}
 walkPartial(){return this.walk();}
 stat(key:string){return this.queue(async()=>baiduWebEntity(await this.client.stat(key)));}
 mkdir(key:string){return this.queue(async()=>baiduWebEntity(await this.client.mkdir(key)));}
 writeFile(key:string,data:ArrayBuffer,mtime:number,ctime:number){const bytes=data.slice(0);return this.queue(async()=>baiduWebEntity(await this.client.write(key,bytes,mtime,ctime)));}
 readFile(key:string){return this.queue(()=>this.client.read(key));}
 rm(key:string){return this.queue(()=>this.client.remove(key));}
 rename(_old:string,_new:string):Promise<void>{return Promise.reject(new BaiduWebProbeError('rename_not_supported'));}
 async checkConnect(callback?:(e:unknown)=>void){try{await this.walk();return true;}catch(e){callback?.(e);return false;}}
 getUserDisplayName(){return Promise.resolve('百度网盘');}
 revokeAuth():Promise<void>{return Promise.reject(new BaiduWebProbeError('logout_from_settings'));}
 allowEmptyFile(){return false;}
}
