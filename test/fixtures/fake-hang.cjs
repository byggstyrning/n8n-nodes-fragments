// Fake converter that never answers.
process.once('message', () => setInterval(() => {}, 1000));
