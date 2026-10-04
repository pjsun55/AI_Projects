self.onmessage = event => { let total=0; for(let n=1;n<=event.data;n++) total+=n; self.postMessage(total); };
