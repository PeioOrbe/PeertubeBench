const fs = require('fs');
const path = require('path');
const config = require('./config');

function loadViewerMetrics(resultsDir) {
  const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('metrics-') && f.endsWith('.json'));
  const viewers = [];

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
    viewers.push(data);
  }

  return viewers;
}

function loadCoordinatorSummaries(resultsDir) {
  const files = fs.readdirSync(resultsDir).filter(f => f.startsWith('coordinator-') && f.endsWith('.json'));
  const summaries = [];

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
    summaries.push(data);
  }

  return summaries;
}

function loadMetricsTimeseries(resultsDir) {
  const filePath = path.join(resultsDir, 'metrics-timeseries.json');
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return [];
}

function analyzeViewerHTTP(viewers) {
  let totalHttpBytes = 0;
  let totalRequests = 0;
  let minHttp = Infinity;
  let maxHttp = 0;
  const vms = new Set();

  for (const v of viewers) {
    const bytes = v.traffic?.httpBytes || v.httpBytes || 0;
    totalHttpBytes += bytes;
    totalRequests += v.traffic?.requestCount || 0;
    if (bytes < minHttp) minHttp = bytes;
    if (bytes > maxHttp) maxHttp = bytes;
    vms.add(v.vmId);
  }

  return {
    totalHttpBytes,
    totalHttpMB: (totalHttpBytes / 1024 / 1024).toFixed(2),
    totalHttpMbit: ((totalHttpBytes * 8) / 1024 / 1024).toFixed(2),
    avgHttpPerViewerMB: ((totalHttpBytes / viewers.length / 1024 / 1024)).toFixed(2),
    minHttpMB: (minHttp / 1024 / 1024).toFixed(2),
    maxHttpMB: (maxHttp / 1024 / 1024).toFixed(2),
    totalRequests,
    viewerCount: viewers.length,
    vmCount: vms.size
  };
}

function analyzeQoE(viewers) {
  if (viewers.length === 0) return null;

  let startupSuccess = 0;
  let startupFailures = 0;
  const startupDelays = [];
  const startupFailuresList = [];
  const stallDurations = [];

  let totalStalls = 0;
  let totalStallMs = 0;
  const bufferingRatios = [];

  let totalWebrtcPeers = 0;
  let maxWebrtcPeers = 0;
  const viewersWithP2P = [];
  const qoeScores = [];

  for (const v of viewers) {
    const qoe = v.qoe;
    const webrtc = v.webrtc;

    if (qoe) {
      if (qoe.startupFailure) startupFailures++;
      else {
        startupSuccess++;
        if (qoe.startupDelayMs != null) startupDelays.push(qoe.startupDelayMs);
      }

      totalStalls += qoe.stallCount || 0;
      totalStallMs += qoe.totalStallDurationMs || 0;
      if (qoe.totalStallDurationMs > 0) stallDurations.push(qoe.totalStallDurationMs);
      bufferingRatios.push(qoe.bufferingRatioPercent || 0);

      if (typeof qoe.score !== 'undefined') {
        qoeScores.push(qoe.score || 0);
      }
      if (typeof qoe.qoeScore !== 'undefined') {
        qoeScores.push(qoe.qoeScore || 0);
      }
    }

    if (webrtc) {
      totalWebrtcPeers += webrtc.peerConnectionsDetected || 0;
      if ((webrtc.peerConnectionsDetected || 0) > maxWebrtcPeers) {
        maxWebrtcPeers = webrtc.peerConnectionsDetected;
      }
      if ((webrtc.peerConnectionsDetected || 0) > 0) {
        viewersWithP2P.push(v.viewerId);
      }
    }
  }

  const avgStartup = startupDelays.length > 0
    ? startupDelays.reduce((a, b) => a + b, 0) / startupDelays.length
    : 0;

  const avgBuffering = bufferingRatios.length > 0
    ? (bufferingRatios.reduce((a, b) => a + b, 0) / bufferingRatios.length).toFixed(2)
    : 0;

  const avgQoeScore = qoeScores.length > 0
    ? Math.round(qoeScores.reduce((a, b) => a + b, 0) / qoeScores.length)
    : null;
  const minQoeScore = qoeScores.length > 0 ? Math.min(...qoeScores) : null;
  const maxQoeScore = qoeScores.length > 0 ? Math.max(...qoeScores) : null;

  return {
    startupSuccessCount: startupSuccess,
    startupFailureCount: startupFailures,
    avgStartupDelayMs: Math.round(avgStartup),
    totalStalls,
    avgStallsPerViewer: (totalStalls / viewers.length).toFixed(2),
    totalStallMs,
    avgBufferingRatioPercent: avgBuffering,
    avgWebrtcPeers: (totalWebrtcPeers / viewers.length).toFixed(2),
    maxWebrtcPeers,
    viewersWithP2PCount: viewersWithP2P.length,
    viewersWithP2PRatio: ((viewersWithP2P.length / viewers.length) * 100).toFixed(1) + '%',
    avgQoeScore,
    minQoeScore,
    maxQoeScore,
    qoeScoreP50: percentile(qoeScores, 50),
    qoeScoreP95: percentile(qoeScores, 95),
    startupP50: Math.round(percentile(startupDelays, 50)),
    startupP95: Math.round(percentile(startupDelays, 95)),
    stallP95: Math.round(percentile(stallDurations, 95))
  };
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function analyzePeerTubeMetrics(timeseries) {
  if (timeseries.length === 0) return null;

  // New format: { timestamp, metrics: { httpMbps, p2pDownloadMbps, ... }, errors }
  // Old format: { timestamp, peertube: { httpDownloadBytes, p2pDownloadBytes, ... } }
  const m = (s) => s.metrics || {};

  const first = timeseries[0];
  const last = timeseries[timeseries.length - 1];

  const durationMs = last.timestamp - first.timestamp;
  const durationSec = Math.max(durationMs / 1000, 1);

  const getMbps = (key) => {
    if (m(first)[key] != null) return m(last)[key];
    // Fallback: old format httpDownloadBytes/p2pDownloadBytes as cumulative counters
    const oldKey = key === 'httpMbps' ? 'httpDownloadBytes' : key === 'p2pDownloadMbps' ? 'p2pDownloadBytes' : key === 'p2pUploadMbps' ? 'p2pUploadBytes' : null;
    if (!oldKey) return 0;
    const s0 = first.peertube || first;
    const s1 = last.peertube || last;
    const delta = Math.max(0, (s1[oldKey] || 0) - (s0[oldKey] || 0));
    return (delta * 8) / 1024 / 1024 / durationSec;
  };

  const httpMbps = getMbps('httpMbps');
  const p2pDownMbps = getMbps('p2pDownloadMbps');
  const p2pUpMbps = getMbps('p2pUploadMbps');
  const totalMbps = httpMbps + p2pDownMbps;

  const offloadRatio = totalMbps > 0 ? (p2pDownMbps / totalMbps * 100) : 0;
  const bandwidthSaving = totalMbps > 0 ? (p2pDownMbps / totalMbps * 100) : 0;

  const peakViewers = Math.max(...timeseries.map(t => (m(t).viewers || t.peertube?.viewersTotal || 0)));
  const avgCpu = timeseries.reduce((a, t) => a + (m(t).cpuPercent || 0), 0) / timeseries.length;

  return {
    httpMbps: httpMbps.toFixed(2),
    p2pDownMbps: p2pDownMbps.toFixed(2),
    p2pUpMbps: p2pUpMbps.toFixed(2),
    totalMbps: totalMbps.toFixed(2),
    offloadRatio: `${offloadRatio.toFixed(1)}%`,
    bandwidthSaving: `${bandwidthSaving.toFixed(1)}%`,
    durationSec: durationSec.toFixed(0),
    peakViewers,
    avgCpu: avgCpu.toFixed(1),
    sampleCount: timeseries.length
  };
}

function main() {
  const resultsDir = path.join(__dirname, 'results');

  if (!fs.existsSync(resultsDir)) {
    console.error('No results directory found. Run benchmarks first.');
    process.exit(1);
  }

  const viewers = loadViewerMetrics(resultsDir);
  const coordinators = loadCoordinatorSummaries(resultsDir);
  const timeseries = loadMetricsTimeseries(resultsDir);

  console.log('='.repeat(60));
  console.log('  PeerTube P2P Benchmark Results');
  console.log('='.repeat(60));
  console.log('');

  console.log('--- Configuration ---');
  console.log(`  PeerTube URL:   ${config.peertubeUrl}`);
  console.log(`  Video slug:     ${config.videoSlug}`);
  console.log(`  Test duration:  ${config.testDuration}s`);
  console.log(`  Launch rate:    ${config.launchRate} viewers/s`);
  console.log(`  P2P disabled:   ${(config.p2pDisabledRatio * 100).toFixed(0)}%`);
  console.log('');

  const http = viewers.length > 0 ? analyzeViewerHTTP(viewers) : null;
  const qoe = viewers.length > 0 ? analyzeQoE(viewers) : null;
  const peerTubeAnalysis = analyzePeerTubeMetrics(timeseries);

  console.log('--- Viewer HTTP Metrics ---');
  if (http) {
    console.log(`  Viewers found:    ${http.viewerCount}`);
    console.log(`  VMs detected:     ${http.vmCount}`);
    console.log(`  Total requests:   ${http.totalRequests}`);
    console.log(`  Total HTTP:       ${http.totalHttpMB} MB (${http.totalHttpMbit} Mbit)`);
    console.log(`  Avg HTTP/viewer:  ${http.avgHttpPerViewerMB} MB`);
    console.log(`  Min/Max HTTP:     ${http.minHttpMB} MB / ${http.maxHttpMB} MB`);
  } else {
    console.log('  No viewer metrics found.');
  }
  console.log('');

  console.log('--- QoE (Quality of Experience) ---');
  if (qoe) {
    console.log(`  Startup success:  ${qoe.startupSuccessCount}/${qoe.startupSuccessCount + qoe.startupFailureCount}`);
    console.log(`  Avg startup:      ${qoe.avgStartupDelayMs}ms (p50 ${qoe.startupP50}ms / p95 ${qoe.startupP95}ms)`);
    console.log(`  Total stalls:     ${qoe.totalStalls} (${qoe.avgStallsPerViewer}/viewer, p95 ${qoe.stallP95}ms)`);
    console.log(`  Avg buffering:    ${qoe.avgBufferingRatioPercent}%`);
    console.log(`  QoE Score:        avg ${qoe.avgQoeScore} (p50 ${qoe.qoeScoreP50} / p95 ${qoe.qoeScoreP95})`);
    console.log(`  WebRTC peers:     avg ${qoe.avgWebrtcPeers}, max ${qoe.maxWebrtcPeers}`);
    console.log(`  P2P connectivity: ${qoe.viewersWithP2PCount}/${viewers.length} (${qoe.viewersWithP2PRatio})`);
  } else {
    console.log('  No QoE data available.');
  }
  console.log('');

  console.log('--- Coordination Summary ---');
  let totalCompleted = 0;
  let totalFailed = 0;
  for (const c of coordinators) {
    totalCompleted += c.completed;
    totalFailed += c.failed;
    console.log(`  VM ${c.vmId}: ${c.completed}/${c.totalViewers} completed, ${c.failed} failed`);
  }
  console.log(`  Total: ${totalCompleted} completed, ${totalFailed} failed`);
  console.log('');

  console.log('--- PeerTube Metrics ---');
  if (peerTubeAnalysis) {
    console.log(`  Peak viewers:     ${peerTubeAnalysis.peakViewers}`);
    console.log(`  Duration:         ${peerTubeAnalysis.durationSec}s`);
    console.log(`  HTTP download:    ${peerTubeAnalysis.httpMbps} Mbit/s`);
    console.log(`  P2P download:     ${peerTubeAnalysis.p2pDownMbps} Mbit/s`);
    console.log(`  P2P upload:       ${peerTubeAnalysis.p2pUpMbps} Mbit/s`);
    console.log(`  Total:            ${peerTubeAnalysis.totalMbps} Mbit/s`);
    console.log(`  Offload ratio:    ${peerTubeAnalysis.offloadRatio} (P2P/total traffic)`);
    console.log(`  Bandwidth saved:  ${peerTubeAnalysis.bandwidthSaving}`);
    console.log(`  Avg CPU:          ${peerTubeAnalysis.avgCpu}%`);
    console.log(`  Samples:          ${peerTubeAnalysis.sampleCount}`);
  } else {
    console.log('  No PeerTube metrics found.');
  }
  console.log('');

  console.log('='.repeat(60));

  // Guardar resumen
  const summary = {
    config: {
      peertubeUrl: config.peertubeUrl,
      videoSlug: config.videoSlug,
      testDuration: config.testDuration,
      p2pDisabledRatio: config.p2pDisabledRatio
    },
    http: http,
    qoe: qoe,
    coordination: {
      totalCompleted,
      totalFailed,
      vms: coordinators.length
    },
    peerTube: peerTubeAnalysis
  };

  fs.writeFileSync(
    path.join(resultsDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );

  console.log('\nSummary saved to results/summary.json');
}

main();
