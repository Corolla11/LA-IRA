export function Heap(cap) { this.idx = new Int32Array(cap); this.key = new Float64Array(cap); this.n = 0; }
Heap.prototype.push = function (i, k) {
  if (this.n >= this.idx.length) {
    var ni = new Int32Array(this.idx.length * 2); ni.set(this.idx); this.idx = ni;
    var nk = new Float64Array(this.key.length * 2); nk.set(this.key); this.key = nk;
  }
  var p = this.n++;
  while (p > 0) { var q = (p - 1) >> 1; if (this.key[q] <= k) break; this.idx[p] = this.idx[q]; this.key[p] = this.key[q]; p = q; }
  this.idx[p] = i; this.key[p] = k;
};
Heap.prototype.pop = function () {
  var top = this.idx[0], n = --this.n;
  if (n > 0) {
    var li = this.idx[n], lk = this.key[n], p = 0;
    for (;;) {
      var c = 2 * p + 1; if (c >= n) break;
      if (c + 1 < n && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c]; this.key[p] = this.key[c]; p = c;
    }
    this.idx[p] = li; this.key[p] = lk;
  }
  return top;
};

export function ensureWork(grid) {
  if (grid.BLOCK) return;
  var NN = grid.N * grid.N;
  grid.BLOCK = new Uint8Array(NN);
  grid.G = new Float64Array(NN); grid.PAR = new Int32Array(NN); grid.CLOSED = new Uint8Array(NN);
  grid.heap = new Heap(1 << 20);
}
