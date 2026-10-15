import type {WebdavConfig} from './baseTypes';
const normalize=(path:string)=>path.trim().replace(/^\/+|\/+$/g,'');
export function resolveWebdavDirectory(config:WebdavConfig,vault:string):string {
 if(config.parentDir!==undefined)return [normalize(config.parentDir),vault].filter(Boolean).join('/');
 return normalize(config.remoteBaseDir||vault);
}
export function migrateWebdavDirectory(config:WebdavConfig,vault:string):void {
 if(config.parentDir===undefined) {
  const legacy=normalize(config.remoteBaseDir||vault);
  config.parentDir=legacy.split('/').slice(0,-1).join('/');
 }
 config.remoteBaseDir=resolveWebdavDirectory(config,vault);
}
