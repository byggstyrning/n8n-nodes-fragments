// Fake converter that dies mid-conversion.
process.once('message', () => { console.error('boom: segfault-ish'); process.exit(3); });
