// Fake converter: records when it ran, writes the input back as the .frag.
const fs = require('fs');
process.once('message', (job) => {
  const started = Date.now();
  const delay = Number(fs.readFileSync(job.inputPath, 'utf8').match(/delay=(\d+)/)?.[1] ?? 0);
  setTimeout(() => {
    const body = JSON.stringify({ started, ended: Date.now(), modelId: job.modelId ?? null, threshold: job.distanceThreshold, env: Object.keys(process.env) });
    fs.writeFileSync(job.outputPath, body);
    process.send({ type: 'done', ifcBytes: fs.statSync(job.inputPath).size, fragBytes: body.length, convertMs: Date.now() - started }, () => process.exit(0));
  }, delay);
});
