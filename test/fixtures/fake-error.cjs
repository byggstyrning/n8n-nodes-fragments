// Fake converter that reports a conversion error.
process.once('message', () => process.send({ type: 'error', message: 'not an IFC' }, () => process.exit(0)));
