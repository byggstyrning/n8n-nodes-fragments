// Fake converter that keeps allocating memory outside the V8 heap, like WASM.
const hold = [];
process.once('message', () => setInterval(() => hold.push(Buffer.alloc(32 * 1024 * 1024, 1)), 20));
