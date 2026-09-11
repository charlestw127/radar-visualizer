const base = new URL('./src/', import.meta.url).href;
const { RF, RCS_CLASSES, snrDb, pd, jamJnDb, burnThroughKm, detectionRangeKm,
        apparentRangeUs, sigmaAzRad, sigmaRangeUs, twoWayDopplerHz } = await import(base + 'rf.js');
const { GAME_TIMELAPSE, Platform } = await import(base + 'world.js');
const { RadarModel, SCAN_RATE_RAD_S } = await import(base + 'radar.js');
const { BattleGame, HuntGame, INTERCEPT_WALL_S } = await import(base + 'games.js');
const { C_M_PER_US } = await import(base + 'params.js');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures++; console.log(`  FAIL ${name} ${detail}`); }
};

// ---- 1. Detection-range matrix (ground truth for tuning) ----
console.log('=== Detection range (km), tau=10us, N=64, clear sky ===');
const bands = [[150, 'VHF'], [3000, 'S'], [35000, 'Ka']];
for (const cls of RCS_CLASSES) {
  const row = bands.map(([f, name]) => `${name}:${detectionRangeKm({ rcsM2: cls.rcsM2, tauUs: 10, fMHz: f, nPulses: 64 }).toFixed(0)}`).join('  ');
  console.log(`  ${cls.label.padEnd(9)} ${row}`);
}
const dFighter = detectionRangeKm({ rcsM2: 3, tauUs: 10, fMHz: 3000, nPulses: 64 });
check('fighter S-band detect 60-160 km', dFighter > 60 && dFighter < 160, dFighter.toFixed(1));
check('sigma=1 calibration ~80 km', Math.abs(detectionRangeKm({ rcsM2: 1, tauUs: 10, fMHz: 3000, nPulses: 64 }) - 80) < 8);
check('longer pulse detects further', detectionRangeKm({ rcsM2: 3, tauUs: 100, fMHz: 3000, nPulses: 64 }) > dFighter);
check('lower band detects further', detectionRangeKm({ rcsM2: 3, tauUs: 10, fMHz: 150, nPulses: 64 }) > dFighter);
check('higher band detects shorter', detectionRangeKm({ rcsM2: 3, tauUs: 10, fMHz: 35000, nPulses: 64 }) < dFighter);
check('pd at threshold = 0.5', Math.abs(pd(RF.THRESH_DB) - 0.5) < 1e-9);
check('pd far below ~0', pd(RF.THRESH_DB - 10) < 0.01);

// ---- 2. Burn-through ----
const bt = burnThroughKm({ rcsM2: 3, tauUs: 10, fMHz: 3000, nPulses: 64, erpDb: 30 });
console.log(`burn-through fighter/30dB ERP: ${bt.toFixed(1)} km`);
check('burn-through 5-25 km', bt > 5 && bt < 25, bt.toFixed(1));
check('bigger RCS burns through further', burnThroughKm({ rcsM2: 30, tauUs: 10, fMHz: 3000, nPulses: 64, erpDb: 30 }) > bt);
check('stronger jammer shrinks burn-through', burnThroughKm({ rcsM2: 3, tauUs: 10, fMHz: 3000, nPulses: 64, erpDb: 45 }) < bt);
const snrJam = snrDb({ rKm: 60, rcsM2: 3, tauUs: 10, fMHz: 3000, beamwidthRad: 0.1, nPulses: 64,
  jnDb: jamJnDb({ erpDb: 30, rKm: 60, offBoresightRad: 0, beamwidthRad: 0.1 }) });
check('jammed fighter at 60 km undetectable', pd(snrJam) < 0.02, `snr=${snrJam.toFixed(1)}`);

// ---- 3. Ambiguity + accuracy formulas ----
check('unambiguous fold', apparentRangeUs(100, 300) === 100);
const rApp = apparentRangeUs(200.1, 300); // 2R=400.2 mod 300 = 100.2 -> 50.1
check('2nd-time-around folds', Math.abs(rApp - 50.1) < 0.2, rApp);
check('sigma_az shrinks with SNR', sigmaAzRad(0.1, 30) < sigmaAzRad(0.1, 15));
check('sigma_r shrinks with SNR', sigmaRangeUs(10, 30) < sigmaRangeUs(10, 15));
check('two-way doppler', Math.abs(twoWayDopplerHz(300, 3000) - 2 * 300 * 3000 / C_M_PER_US) < 1e-6);

// ---- 4. Scan -> paint -> track pipeline (fighter at 60 km crossing) ----
function fakeParams(over = {}) {
  const v = { pri: 2000, pulseWidth: 10, frequency: 3000, beamwidthDeg: 6, rangeKm: 100, timeScale: 60000, ...over };
  return { get: (k) => { if (!(k in v)) throw new Error('param ' + k); return v[k]; } };
}
function runScenario({ paramsOver = {}, targets, jammers = [], erpDb = 0, wallSeconds = 30 }) {
  const params = fakeParams(paramsOver);
  const radar = new RadarModel(params);
  const sim = { time: 0 };
  const FRAME = 1 / 60;
  let paints = 0, confirms = 0;
  for (let t = 0; t < wallSeconds; t += FRAME) {
    const dtGame = FRAME * GAME_TIMELAPSE;
    sim.time += FRAME * params.get('timeScale');
    for (const tg of targets) tg.update(dtGame);
    radar.update({ dtGameS: dtGame, dtWallS: FRAME, sim, targets, jammers, erpDb });
    paints += radar.newPaints.filter((p) => !p.falseAlarm).length;
    confirms += radar.newEvents.filter((e) => e.type === 'confirm').length;
  }
  return { radar, paints, confirms, targets };
}

const fighter = new Platform('fighter', 42.4, 42.4, Math.PI); // 60 km NE, flying west
const s1 = runScenario({ targets: [fighter], wallSeconds: 40 });
console.log(`scan scenario: ${s1.paints} paints, ${s1.radar.tracks.length} tracks, confirms=${s1.confirms}`);
check('paints happened', s1.paints > 10, s1.paints);
check('a track confirmed', s1.confirms >= 1);
const tr = s1.radar.bestTrack();
check('track exists', !!tr);
if (tr) {
  const err = Math.hypot(tr.xKm - fighter.xKm, tr.yKm - fighter.yKm);
  console.log(`  track err ${err.toFixed(1)} km, est speed ${s1.radar.trackSpeedMps(tr).toFixed(0)} m/s (true 300)`);
  check('track within 8 km of truth', err < 8, err.toFixed(1));
  const spd = s1.radar.trackSpeedMps(tr);
  check('speed estimate 100..600 m/s', spd > 100 && spd < 600, spd.toFixed(0));
  const rcs = s1.radar.rcsEstimate(tr);
  console.log(`  RCS est ${rcs.meanDb.toFixed(1)} dBsm +/-${rcs.ci95Db.toFixed(1)} (true ${(10 * Math.log10(3)).toFixed(1)}) n=${rcs.n}`);
  check('RCS estimate within 4 dB', Math.abs(rcs.meanDb - 10 * Math.log10(3)) < 4, rcs.meanDb.toFixed(1));
}

// ---- 5. Eclipsing: 2R ~= k*PRI -> no detections ----
const eclT = new Platform('airliner', 60.04, 0, 0); eclT.speedMps = 0;
const s2 = runScenario({ paramsOver: { pri: 400.28 }, targets: [eclT], wallSeconds: 25 });
check('eclipsed target produces ~no paints', s2.paints <= 2, s2.paints);

// ---- 6. Ambiguity: PRI 300us, R=60km -> apparent ~15 km ----
const ambT = new Platform('airliner', 42.4, 42.4, 0); ambT.speedMps = 0;
const s3 = runScenario({ paramsOver: { pri: 300 }, targets: [ambT], wallSeconds: 25 });
const ambPlots = s3.radar.plots.filter((p) => !p.falseAlarm);
if (ambPlots.length) {
  const meanR = ambPlots.reduce((a, p) => a + p.rangeKm, 0) / ambPlots.length;
  console.log(`ambiguous scenario: ${ambPlots.length} plots at mean ${meanR.toFixed(1)} km (true 60, apparent ~15)`);
  check('ambiguous plots land near 15 km', Math.abs(meanR - 15) < 5, meanR.toFixed(1));
  check('plots flagged ambiguous', ambPlots.every((p) => p.ambiguous));
} else check('ambiguous scenario produced plots', false);

// ---- 7. Jamming denies detection beyond burn-through ----
const jamT = new Platform('fighter', 0, 60, -Math.PI / 2); jamT.speedMps = 0; jamT.ea = true;
const s4 = runScenario({ targets: [jamT], jammers: [jamT], erpDb: 30, wallSeconds: 30 });
check('jammed: RWR still painted', jamT.paintCount > 0);
check('jammed: (almost) no real paints', s4.radar.plots.filter((p) => !p.falseAlarm).length <= 1,
  s4.radar.plots.filter((p) => !p.falseAlarm).length);
// az 10 deg: off the dwell-grid boundary (az 0 sits exactly at a beam edge
// every rev, a deterministic -6 dB worst case the scoring shouldn't assume).
const az10 = (10 * Math.PI) / 180;
const closeJam = new Platform('fighter', bt * 0.45 * Math.cos(az10), bt * 0.45 * Math.sin(az10), 0);
closeJam.speedMps = 0; closeJam.ea = true;
const s5 = runScenario({ targets: [closeJam], jammers: [closeJam], erpDb: 30, wallSeconds: 30 });
check('inside burn-through: detected anyway', s5.paints > 5, s5.paints);

// ---- 8. Battle game ladder + intercept + win ----
const bparams = fakeParams();
const game = new BattleGame(bparams);
check('4 platforms', game.platforms.length === 4);
check('goal ring 8 km at 100 km arena', Math.abs(game.goalKm - 8) < 0.01);
const fakeRadar = { revisitS: 10, gameT: 100, tracks: [], newEvents: [] };
const p0 = game.platforms[0];
for (let t = 0; t < INTERCEPT_WALL_S + 1; t += 0.1) {
  fakeRadar.tracks = [{ xKm: p0.xKm, yKm: p0.yKm, vxKmS: 0, vyKmS: 0, lastPaintGameT: fakeRadar.gameT, state: 'CONFIRMED' }];
  game.update(0, 0.1, fakeRadar); // dtGame=0: hold positions
}
check('tracked platform intercepted', !p0.alive && game.statuses.get(p0.id) === 'INTERCEPTED');
check('others still alive', game.platforms.slice(1).every((p) => p.alive));
game.platforms[1].xKm = 3; game.platforms[1].yKm = 0;
fakeRadar.tracks = [];
game.update(0, 0.1, fakeRadar);
check('reaching goal wins', game.state === 'won');

// ---- 9b. Hunt click-to-lock (single-target track) ----
{
  const { HuntModeCtx } = await import(base + 'modes.js');
  const { wrapAngle } = await import(base + 'rf.js');
  const hctx = new HuntModeCtx(fakeParams());
  hctx.enter();
  // Deterministic prey: the random spawn can be a bird at 60+ km, which is
  // honestly undetectable at S-band — no track would ever form.
  hctx.game.target = new Platform('airliner', 35.4, 35.4, 0);
  hctx.game.target.speedMps = 0;
  const hsim = { time: 0, pulses: [] };
  // Build a track by (test-only) steering at the truth for a while.
  for (let t = 0; t < 30; t += 1 / 60) {
    if (!hctx.locked) hctx.pointTo(hctx.game.target.azRad);
    hsim.time += (1 / 60) * 60000;
    hctx.update({ dtWallS: 1 / 60, running: true, sim: hsim });
  }
  const btr = hctx.radar.bestTrack();
  check('hunt built a track to lock', !!btr);
  if (btr) {
    const got = hctx.tryLock(btr.xKm + 1, btr.yKm - 1, 5);
    check('lock acquired near track', !!got && hctx.locked && hctx.lockedTrackId === btr.id);
    hctx.pointTo(btr.xKm > 0 ? Math.PI : 0); // stale manual command; lock must override
    hctx.update({ dtWallS: 1 / 60, running: true, sim: hsim });
    const err = Math.abs(wrapAngle(hctx.radar.commandAzRad - Math.atan2(btr.yKm, btr.xKm)));
    check('beam command follows locked track', err < 0.5, err.toFixed(2));
    check('no lock outside pick radius', hctx.tryLock(btr.xKm + 50, btr.yKm + 50, 5) === null);
    hctx.radar.tracks = [];
    hctx.update({ dtWallS: 1 / 60, running: true, sim: hsim });
    check('lock breaks when track dies', !hctx.locked && hctx.lockLostUntil > 0);
  }
}

// ---- 9. Hunt basics ----
const hunt = new HuntGame(fakeParams());
const truth = hunt.target.cls.id;
const wrong = RCS_CLASSES.find((c) => c.id !== truth).id;
check('wrong guess continues', hunt.guess(wrong).correct === false && hunt.state === 'hunting');
check('right guess wins', hunt.guess(truth).correct === true && hunt.state === 'won');

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
