export type TransferDirection = 'upload' | 'download';
export class TransferSpeed {
 private bytes={upload:0,download:0};
 constructor(private last=performance.now()){}
 add(direction:TransferDirection,bytes:number){if(Number.isFinite(bytes)&&bytes>0)this.bytes[direction]+=bytes;}
 sample(now=performance.now()){
  const seconds=(now-this.last)/1000;
  if(seconds<=0)return {upload:0,download:0};
  const result={upload:this.bytes.upload/seconds,download:this.bytes.download/seconds};
  this.bytes={upload:0,download:0};this.last=now;return result;
 }
}
const listeners=new Set<(direction:TransferDirection,bytes:number)=>void>();
export function observeTransferBytes(listener:(direction:TransferDirection,bytes:number)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};}
export function reportTransferBytes(direction:TransferDirection,bytes:number){for(const listener of listeners){try{listener(direction,bytes);}catch{/* Telemetry must never interrupt a transfer. */}}}
