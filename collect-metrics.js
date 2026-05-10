const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function prometheusQuery(url, queryStr) {
  return new Promise((resolve, reject) => {
    const params = `/api/v1/query?query=${encodeURIComponent(queryStr)}`;
    const fullUrl = `${url}${params}`;

    http.get(fullUrl, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'success') {
            resolve(json.data);
          } else {
            reject(new Error(`Prometheus query failed: ${json.error || data}`));
          }
        } catch (e) {
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function extractScalar(data) {
  if (data.resultType === 'scalar') return data.result[1];
  if (data.resultType === 'vector' && data.result.length > 0) {
    return parseFloat(data.result[0].value[1]);
  }
  return 0;
}

async function collectSnapshot() {
  const base = config.prometheusUrl;
  const queries = {
    viewers: `sum(peertube_viewers) OR on() vector(0)`,
    httpMbps: `(sum(rate(peertube_http_download_bytes_total[1m])) * 8 / 1024 / 1024 OR on() vector(0))`,
    p2pDownloadMbps: `(sum(rate(peertube_p2p_download_bytes_total[1m])) * 8 / 1024 / 1024 OR on() vector(0))`,
    p2pUploadMbps: `(sum(rate(peertube_p2p_upload_bytes_total[1m])) * 8 / 1024 / 1024 OR on() vector(0))`,
    cpuPercent: `(100 * (1 - avg without(cpu,mode)(rate(node_cpu_seconds_total{mode="idle"}[2m]))) OR on() vector(0))`,
    memUsedBytes: `(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes OR on() vector(0))`,
    memTotalBytes: `(node_memory_MemTotal_bytes OR on() vector(0))`,
    networkRxMbps: `(sum(rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[1m])) / 1024 / 1024 OR on() vector(0))`,
    networkTxMbps: `(sum(rate(node_network_transmit_bytes_total{device!~"lo|veth.*|docker.*|br-.*"}[1m])) / 1024 / 1024 OR on() vector(0))`,
    activeJobs: `(peertube_jobs_active OR on() vector(0))`,
    waitingJobs: `(peertube_jobs_waiting OR on() vector(0))`,
    eventLoopLag: `(peertube_event_loop_lag_seconds OR on() vector(0))`
  };

  const snapshot = { timestamp: Date.now(), metrics: {}, errors: [] };

  const entries = Object.entries(queries);
  for (const [name, query] of entries) {
    try {
      const data = await prometheusQuery(base, query);
      snapshot.metrics[name] = extractScalar(data);
    } catch (err) {
      snapshot.metrics[name] = null;
      snapshot.errors.push(`${name}: ${err.message}`);
    }
  }

  return snapshot;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`[Metrics] Collecting every ${config.metricsInterval}s for ${config.testDuration}s via Prometheus API...`);

  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const outputPath = path.join(resultsDir, 'metrics-timeseries.json');
  const samples = [];
  const start = Date.now();
  const deadline = start + config.testDuration * 1000;
  let running = true;

  while (running) {
    const snapshot = await collectSnapshot();
    samples.push(snapshot);

    const m = snapshot.metrics;
    console.log(
      `[${new Date(snapshot.timestamp).toISOString()}] ` +
      `Viewers: ${m.viewers} | ` +
      `HTTP: ${(m.httpMbps || 0).toFixed(2)} Mbps | ` +
      `P2P: ${(m.p2pDownloadMbps || 0).toFixed(2)} Mbps | ` +
      `CPU: ${(m.cpuPercent || 0).toFixed(1)}% | ` +
      `Errors: ${snapshot.errors.length}`
    );

    const elapsed = Date.now() - start;
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      running = false;
    } else {
      const nextWait = Math.min(config.metricsInterval * 1000, remaining);
      await sleep(nextWait);
    }
  }

  if (samples.length > 0) {
    const last = samples[samples.length - 1];
    console.log(`\nCollection complete. ${samples.length} samples saved.`);
    console.log(`Final viewers: ${last.metrics.viewers}`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(samples, null, 2));
  console.log(`Saved to ${outputPath}`);
}

main().catch(console.error);
