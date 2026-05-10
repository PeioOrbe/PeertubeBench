const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const vmId = process.env.VM_ID || 'unknown';
const viewersPerVM = config.viewersPerVM;
const p2pDisabledRatio = config.p2pDisabledRatio;

function launchViewer(i) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['viewer.js'], {
      env: {
        ...process.env,
        VM_ID: vmId,
        VIEWER_ID: String(i)
      },
      stdio: ['ignore', 'inherit', 'inherit']
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ viewerId: i, code });
      else reject(new Error(`Viewer ${i} exited with code ${code}`));
    });

    child.on('error', (err) => reject(new Error(`Viewer ${i} failed to spawn: ${err.message}`)));
  });
}

async function main() {
  console.log(`[VM ${vmId}] Launching ${viewersPerVM} viewers...`);

  const promises = [];
  const results = { completed: 0, failed: 0, errors: [] };
  const launchInterval = Math.round(1000 / config.launchRate);

  for (let i = 0; i < viewersPerVM; i++) {
    const viewerIndex = i;
    const viewerPromise = launchViewer(i)
      .then((res) => {
        results.completed++;
        console.log(`[VM ${vmId}] Viewer ${res.viewerId}: completed`);
        return res;
      })
      .catch((err) => {
        results.failed++;
        results.errors.push({ viewerId: viewerIndex, error: err.message });
        console.error(`[VM ${vmId}] Viewer ${viewerIndex}: ${err.message}`);
      });

    promises.push(viewerPromise);
    await new Promise(r => setTimeout(r, launchInterval));
  }

  await Promise.allSettled(promises);

  const summary = {
    vmId,
    totalViewers: viewersPerVM,
    completed: results.completed,
    failed: results.failed,
    errors: results.errors,
    p2pDisabledRatio,
    timestamp: Date.now()
  };

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(resultsDir, `coordinator-${vmId}.json`),
    JSON.stringify(summary, null, 2)
  );

  console.log(`[VM ${vmId}] Done: ${results.completed}/${viewersPerVM} completed, ${results.failed} failed`);
}

main().catch(console.error);
