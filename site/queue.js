// One request at a time. Explicit retries, no secret persistence or hidden retry.
export class SerialQueue {
  constructor({onChange=()=>{}}={}) {this.pending=[];this.current=null;this.onChange=onChange;}
  get busy() {return Boolean(this.current);}
  get size() {return this.pending.length+(this.current?1:0);}
  has(key) {return this.current?.key===key||this.pending.some(job=>job.key===key);}
  enqueue(key,run) {
    if (this.has(key)) throw new Error('这张卡片已经在整理队列中');
    let resolve,reject;
    const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    this.pending.push({key,run,resolve,reject,controller:new AbortController()});
    this.onChange();void this.pump();return promise;
  }
  cancel(key) {
    const index=this.pending.findIndex(job=>job.key===key);
    if (index>=0) {const [job]=this.pending.splice(index,1);job.controller.abort();job.reject(new Error('请求已取消'));}
    if (this.current?.key===key) this.current.controller.abort();
    this.onChange();
  }
  cancelAll() {for (const job of [...this.pending]) this.cancel(job.key);if (this.current) this.cancel(this.current.key);}
  async pump() {
    if (this.current) return;
    while (this.pending.length) {
      const job=this.pending.shift();this.current=job;this.onChange();
      try {const result=await job.run(job.controller.signal);if (job.controller.signal.aborted) throw new Error('请求已取消');job.resolve(result);}
      catch (error) {job.reject(error);}
      finally {this.current=null;this.onChange();}
    }
  }
}
