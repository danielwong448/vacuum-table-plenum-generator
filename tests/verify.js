'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var Geometry = require('../js/geometry.js');
var GCode = require('../js/gcode.js');
var Preview3D = require('../js/preview3d.js');

function approxEq(a, b, tol, msg) {
  var d = Math.abs(a - b);
  if (d > (tol || 0.001)) {
    throw new assert.AssertionError({
      message: (msg || 'approxEq failed') + ': expected ' + b + ', got ' + a + ' (diff ' + d + ')'
    });
  }
}

function parseGcodeAndAudit(layout, result) {
  var p = layout.params;
  var lines = result.gcode.split('\n').filter(function (l) {
    return l.trim().length > 0;
  });

  // 1. Check forbidden GRBL tokens, no G4 dwell, and no nested parens
  var forbidden = [
    /\bM0?6\b/,
    /\bT\d+\b/,
    /\bG43\b/,
    /\bG4[012]\b/,
    /\bG28\b/,
    /\bG53\b/,
    /\bG8[13]\b/,
    /\bG0?4\b/,
    /%/
  ];
  var sawG90 = false;
  var sawG94 = false;
  var sawG17 = false;
  var sawG21 = false;
  var sawM3 = false;
  var sawM5 = false;
  var sawM30 = false;

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    if (line.startsWith('(')) {
      assert(line.endsWith(')'), 'Unclosed comment at line ' + (li + 1));
      var inner = line.slice(1, -1);
      assert(!/[()]/.test(inner), 'Nested parentheses in comment at line ' + (li + 1) + ': ' + line);
      continue;
    }
    for (var fi = 0; fi < forbidden.length; fi++) {
      assert(!forbidden[fi].test(line), 'Forbidden GRBL token on line ' + (li + 1) + ': ' + line);
    }
    if (/\bG90\b/.test(line)) sawG90 = true;
    if (/\bG94\b/.test(line)) sawG94 = true;
    if (/\bG17\b/.test(line)) sawG17 = true;
    if (/\bG21\b/.test(line)) sawG21 = true;
    if (new RegExp('\\bM3\\s+S' + Math.round(p.rpm) + '\\b').test(line)) sawM3 = true;
    if (/\bM5\b/.test(line)) sawM5 = true;
    if (/\bM30\b/.test(line)) sawM30 = true;
  }

  assert(sawG90 && sawG94 && sawG17 && sawG21 && sawM3, 'Missing required GRBL setup words');
  assert(sawM5 && sawM30, 'Missing required GRBL footer words (M5 / M30)');

  // 2. Simulate every motion command
  var x = 0;
  var y = 0;
  var z = p.safeZ;
  var modalMotion = null;
  var modalFeed = null;

  var quadBoundsMm = layout.quadrants.map(function (q) {
    var removedRuns = [];
    if (q.pads) {
      for (var pi = 0; pi < q.pads.length; pi++) {
        var pad = q.pads[pi];
        if (pad.removed) {
          removedRuns.push({
            x0: Geometry.round3(Geometry.inToMm(pad.slotX0)),
            x1: Geometry.round3(Geometry.inToMm(pad.slotX1)),
            y0: Geometry.round3(Geometry.inToMm(pad.py0)),
            y1: Geometry.round3(Geometry.inToMm(pad.py1))
          });
        }
      }
    }
    return {
      id: q.id,
      x0: Geometry.round3(Geometry.inToMm(q.x0)),
      x1: Geometry.round3(Geometry.inToMm(q.x1)),
      y0: Geometry.round3(Geometry.inToMm(q.y0)),
      y1: Geometry.round3(Geometry.inToMm(q.y1)),
      vXs: q.verticalLines.map(function (v) {
        return Geometry.round3(Geometry.inToMm(v.x));
      }),
      hYs: q.horizontalLines.map(function (h) {
        return Geometry.round3(Geometry.inToMm(h.y));
      }),
      removedRuns: removedRuns
    };
  });

  function findQuadrant(px, py) {
    for (var i = 0; i < quadBoundsMm.length; i++) {
      var qb = quadBoundsMm[i];
      if (px >= qb.x0 - 0.02 && px <= qb.x1 + 0.02 && py >= qb.y0 - 0.02 && py <= qb.y1 + 0.02) {
        return qb;
      }
    }
    return null;
  }

  function hasExactVal(arr, val) {
    for (var i = 0; i < arr.length; i++) {
      if (Math.abs(arr[i] - val) < 0.005) return true;
    }
    return false;
  }

  function isInsideRemovedPads(qb, x1, y1, x2, y2) {
    var yMid = (y1 + y2) * 0.5;
    var xMin = Math.min(x1, x2);
    var xMax = Math.max(x1, x2);
    var hits = 0;
    for (var i = 0; i < qb.removedRuns.length; i++) {
      var r = qb.removedRuns[i];
      if (yMid >= r.y0 - 0.05 && yMid <= r.y1 + 0.05 && xMax >= r.x0 - 0.05 && xMin <= r.x1 + 0.05) {
        hits++;
      }
    }
    return hits > 0;
  }

  var cutEvents = [];
  var perimeterDepths = [];
  var inletDepths = [];
  var slotDepths = [];
  var flangeDepths = [];
  var rampAnglesSeen = [];
  var inletTabLiftCount = 0;
  var sawGridMoves = []; // track zigzag state per slot

  var expectedSheetThickMm = Geometry.round3(Geometry.inToMm(p.sheetThickness));
  var expectedTabTopDepthMm = Math.max(0, Geometry.round3(expectedSheetThickMm - 2.0));
  var inInletHole = false;

  for (var idx = 0; idx < lines.length; idx++) {
    var raw = lines[idx].trim();
    if (!raw || raw.startsWith('(')) continue;

    var tokens = raw.split(/\s+/);
    var nextX = x;
    var nextY = y;
    var nextZ = z;
    var iVal = null;
    var jVal = null;
    var cmdMotion = null;

    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      var code = tok[0];
      var num = parseFloat(tok.slice(1));
      if (code === 'G') {
        if (num === 0 || num === 1 || num === 2 || num === 3) cmdMotion = num;
      } else if (code === 'X') {
        nextX = num;
      } else if (code === 'Y') {
        nextY = num;
      } else if (code === 'Z') {
        nextZ = num;
      } else if (code === 'I') {
        iVal = num;
      } else if (code === 'J') {
        jVal = num;
      } else if (code === 'F') {
        modalFeed = num;
      }
    }

    if (cmdMotion !== null) modalMotion = cmdMotion;

    var dxAbs = Math.abs(nextX - x);
    var dyAbs = Math.abs(nextY - y);
    var hasXY = dxAbs > 0.0001 || dyAbs > 0.0001;
    var hasZDown = nextZ < z - 0.0001;
    var hasZUp = nextZ > z + 0.0001;

    if (modalMotion === 0) {
      if (hasXY) {
        assert(
          z >= p.safeZ - 0.002,
          'Unsafe G0 XY rapid while Z=' + z + ' < safeZ=' + p.safeZ + ' on line ' + (idx + 1) + ': ' + raw
        );
      }
      if (nextZ >= p.safeZ - 0.002) {
        inInletHole = false;
      }
    } else if (modalMotion === 1) {
      if (hasZDown && !hasXY) {
        approxEq(modalFeed, p.plungeRate, 0.5, 'Plunge should use plungeRate on line ' + (idx + 1));
        var plungeStep = Math.min(z, 0) - nextZ;
        assert(
          plungeStep <= p.stepdown + 0.002,
          'Stepdown ' + plungeStep + 'mm exceeded limit ' + p.stepdown + 'mm on line ' + (idx + 1)
        );
      } else if (hasZUp && !hasXY && inInletHole) {
        approxEq(-nextZ, expectedTabTopDepthMm, 0.005, 'Inlet tab lift depth mismatch on line ' + (idx + 1));
        inletTabLiftCount++;
      } else if (hasXY && hasZDown) {
        // Zig-zag 3D ramp move
        var qbRamp = findQuadrant(x, y);
        var qbRamp2 = findQuadrant(nextX, nextY);
        assert(qbRamp && qbRamp2 && qbRamp.id === qbRamp2.id, 'Ramp crossed quadrant on line ' + (idx + 1));
        var dxyRamp = Math.hypot(nextX - x, nextY - y);
        var dzRamp = z - nextZ;
        assert(dzRamp <= p.stepdown + 0.002, 'Ramp dz exceeded stepdown on line ' + (idx + 1));
        var actualDeg = (Math.atan2(dzRamp, dxyRamp) * 180) / Math.PI;
        rampAnglesSeen.push(actualDeg);
        var isVert = dxAbs < 0.002 && hasExactVal(qbRamp.vXs, x);
        var isHoriz = dyAbs < 0.002 && hasExactVal(qbRamp.hYs, y);
        assert(isVert || isHoriz, 'Ramp move must align strictly with a grid slot on line ' + (idx + 1));
        var rType = isVert ? 'vertical' : 'horizontal';
        cutEvents.push({ type: rType, quad: qbRamp.id, z: nextZ, moveKind: 'ramp' });
        sawGridMoves.push({ type: rType, quad: qbRamp.id, moveKind: 'ramp', x1: x, y1: y, x2: nextX, y2: nextY, z: nextZ });
        slotDepths.push(-nextZ);
      } else if (hasXY) {
        assert(z < 0, 'G1 XY cut expected below Z=0, got Z=' + z + ' on line ' + (idx + 1));
        approxEq(modalFeed, p.feedRate, 0.5, 'XY cut should use feedRate on line ' + (idx + 1));
        var qb1 = findQuadrant(x, y);
        var qb2 = findQuadrant(nextX, nextY);
        assert(qb1 && qb2 && qb1.id === qb2.id, 'Cut crossed quadrant bounds at line ' + (idx + 1) + ': ' + raw);

        var onPerim =
          (Math.abs(x - qb1.x0) < 0.005 && Math.abs(nextX - qb1.x0) < 0.005) ||
          (Math.abs(x - qb1.x1) < 0.005 && Math.abs(nextX - qb1.x1) < 0.005) ||
          (Math.abs(y - qb1.y0) < 0.005 && Math.abs(nextY - qb1.y0) < 0.005) ||
          (Math.abs(y - qb1.y1) < 0.005 && Math.abs(nextY - qb1.y1) < 0.005);

        if (onPerim) {
          cutEvents.push({ type: 'perimeter', quad: qb1.id, z: z });
          perimeterDepths.push(-z);
        } else if (dxAbs < 0.002 && hasExactVal(qb1.vXs, x)) {
          cutEvents.push({ type: 'vertical', quad: qb1.id, z: z, moveKind: 'cut' });
          sawGridMoves.push({ type: 'vertical', quad: qb1.id, moveKind: 'cut', x1: x, y1: y, x2: nextX, y2: nextY, z: z });
          slotDepths.push(-z);
        } else if (dyAbs < 0.002 && hasExactVal(qb1.hYs, y)) {
          cutEvents.push({ type: 'horizontal', quad: qb1.id, z: z, moveKind: 'cut' });
          sawGridMoves.push({ type: 'horizontal', quad: qb1.id, moveKind: 'cut', x1: x, y1: y, x2: nextX, y2: nextY, z: z });
          slotDepths.push(-z);
        } else if (dyAbs < 0.002 && qb1.removedRuns.length > 0 && isInsideRemovedPads(qb1, x, y, nextX, nextY)) {
          cutEvents.push({ type: 'flange', quad: qb1.id, z: z });
          flangeDepths.push(-z);
        } else {
          throw new Error('Unexpected G1 XY cut on line ' + (idx + 1) + ': ' + raw);
        }
      }
    } else if (modalMotion === 3) {
      inInletHole = true;
      assert(z < 0, 'G3 arc expected below Z=0 at line ' + (idx + 1));
      approxEq(modalFeed, p.feedRate, 0.5, 'Arc cut should use feedRate on line ' + (idx + 1));
      assert(iVal !== null && jVal !== null, 'G3 missing I/J on line ' + (idx + 1));
      var cx = x + iVal;
      var cy = y + jVal;
      var rStart = Math.hypot(x - cx, y - cy);
      var rEnd = Math.hypot(nextX - cx, nextY - cy);
      approxEq(rStart, rEnd, 0.002, 'GRBL Error-33 arc radius mismatch on line ' + (idx + 1));
      var qbArc = findQuadrant(cx, cy);
      assert(qbArc, 'Inlet arc center outside quadrants on line ' + (idx + 1));
      cutEvents.push({ type: 'inlet', quad: qbArc.id, z: z });
      inletDepths.push(-z);
    }

    x = nextX;
    y = nextY;
    z = nextZ;
  }

  approxEq(x, 0, 0.001, 'Final X should return to 0');
  approxEq(y, 0, 0.001, 'Final Y should return to 0');
  approxEq(z, p.safeZ, 0.001, 'Final Z should be safeZ');

  // Verify exact phase ordering:
  // Perimeters -> Inlets -> Quad-by-Quad (FL, FR, BR, BL): Vertical -> Horizontal -> Flange
  var phase = 'perimeter';
  var quadOrder = ['FL', 'FR', 'BR', 'BL'];
  var lastQuadIdx = -1;
  var quadSubStage = 0; // 0 = vertical, 1 = horizontal, 2 = flange

  for (var ei = 0; ei < cutEvents.length; ei++) {
    var ev = cutEvents[ei];
    if (ev.type === 'perimeter') {
      assert.strictEqual(phase, 'perimeter', 'Perimeter cut appeared after phase ' + phase);
    } else if (ev.type === 'inlet') {
      assert(phase === 'perimeter' || phase === 'inlet', 'Inlet cut appeared after grid started');
      phase = 'inlet';
    } else {
      phase = 'grid';
      var qIdx = quadOrder.indexOf(ev.quad);
      assert(qIdx >= lastQuadIdx, 'Quadrants went backwards from ' + quadOrder[lastQuadIdx] + ' to ' + ev.quad);
      var sub = ev.type === 'vertical' ? 0 : ev.type === 'horizontal' ? 1 : 2;
      if (qIdx > lastQuadIdx) {
        lastQuadIdx = qIdx;
        quadSubStage = sub;
      } else {
        assert(
          sub >= quadSubStage,
          'In quadrant ' + ev.quad + ', stage ' + ev.type + ' appeared after stage ' + quadSubStage
        );
        quadSubStage = sub;
      }
    }
  }

  // Verify depths reached
  var expectedChannelMm = Geometry.round3(Geometry.inToMm(p.channelDepth));
  var expectedThroughMm = Geometry.round3(Geometry.inToMm(p.inletCutDepth));
  approxEq(Math.max.apply(null, perimeterDepths), expectedChannelMm, 0.002, 'Perimeter max depth');
  approxEq(Math.max.apply(null, inletDepths), expectedThroughMm, 0.002, 'Inlet max depth');
  if (slotDepths.length > 0) {
    approxEq(Math.max.apply(null, slotDepths), expectedChannelMm, 0.002, 'Grid slot max depth');
  }
  if (layout.totalRemovedPads > 0) {
    assert(flangeDepths.length > 0, 'Expected flange recess clearing passes when pads are removed');
    approxEq(Math.max.apply(null, flangeDepths), expectedChannelMm, 0.002, 'Flange recess max depth');
  }

  // Verify zig-zag ramp angles when rampAngle < 89
  if (p.rampAngle < 89 && (p.verticalLines > 0 || p.horizontalLines > 0)) {
    assert(rampAnglesSeen.length > 0, 'Expected zig-zag ramp moves');
    for (var ri = 0; ri < rampAnglesSeen.length; ri++) {
      approxEq(rampAnglesSeen[ri], p.rampAngle, 1.0, 'Ramp angle mismatch');
    }
    // Verify each ramp is followed by back-clean to start endpoint and full finish pass
    for (var mi = 0; mi < sawGridMoves.length; mi++) {
      var m = sawGridMoves[mi];
      if (m.moveKind === 'ramp') {
        var next1 = sawGridMoves[mi + 1];
        var next2 = sawGridMoves[mi + 2];
        var next3 = sawGridMoves[mi + 3];
        assert(next1 && next2, 'Ramp missing follow-up back-clean and finish moves');
        // Either [ramp, flat, reverseToStart, finishToEnd] or [ramp, reverseToStart, finishToEnd]
        var rev = Math.abs((next1.x2 - m.x1)) < 0.005 && Math.abs((next1.y2 - m.y1)) < 0.005 ? next1 : next2;
        var fin = rev === next1 ? next2 : next3;
        assert(rev && fin, 'Ramp missing reverse clean or finish cut');
        approxEq(rev.x2, m.x1, 0.005, 'Reverse clean must return to slot start X');
        approxEq(rev.y2, m.y1, 0.005, 'Reverse clean must return to slot start Y');
        approxEq(rev.z, m.z, 0.002, 'Reverse clean must cut at full pass depth');
        approxEq(fin.z, m.z, 0.002, 'Finish cut must run at full pass depth');
      }
    }
  } else if (p.rampAngle >= 89) {
    assert.strictEqual(rampAnglesSeen.length, 0, '90 deg ramp angle should use vertical plunge only');
  }

  if (p.inletTabs && expectedThroughMm > expectedTabTopDepthMm + 0.001) {
    assert(inletTabLiftCount >= 16, 'Expected at least 4 tab lifts per hole (16 total), got ' + inletTabLiftCount);
  }
}

console.log('Running Vacuum Table Plenum Generator v2 verification suite...');

// Test 1: Default 49x97 parameters, 30 deg zig-zag ramp, 1.5" flange pad removal
(function testDefaults() {
  var d = Geometry.DEFAULT_PARAMS;
  assert.strictEqual(d.sheetWidth, 49);
  assert.strictEqual(d.sheetLength, 97);
  assert.strictEqual(d.sheetThickness, 0.75);
  assert.strictEqual(d.outerMargin, 1.5);
  assert.strictEqual(d.toolDiameter, 0.25);
  assert.strictEqual(d.inletCutDepth, 0.77);
  assert.strictEqual(d.flangeClearanceRadius, 1.5);
  assert.strictEqual(d.rpm, 24000);
  assert.strictEqual(d.feedRate, 3000);
  assert.strictEqual(d.stepdown, 5);
  assert.strictEqual(d.rampAngle, 30);

  var layout = Geometry.computeLayout(d);
  assert.strictEqual(layout.isValid, true);
  assert.strictEqual(layout.errors.length, 0);
  assert.strictEqual(layout.warnings.length, 0);
  assert(layout.totalRemovedPads > 0, 'Default 1.5" flange clearance must remove nearby pads');

  var res = GCode.generateGrblGcode(layout);
  parseGcodeAndAudit(layout, res);

  var mesh = Preview3D.buildPlenumMesh(layout);
  assert(mesh.vertexCount > 1000, '3D mesh should have substantial geometry');
  for (var i = 0; i < mesh.positions.length; i++) {
    assert(Number.isFinite(mesh.positions[i]), '3D mesh coordinate NaN/Inf at index ' + i);
  }

  console.log(
    '✓ Test 1 passed: 49x97 default, 30° zig-zag ramp, ' +
      layout.totalRemovedPads +
      ' flange pads cleared, 3D mesh ' +
      mesh.vertexCount +
      ' verts (' +
      res.stats.lineCount +
      ' lines)'
  );
})();

// Test 2: 1:1 Square Pad Ratio overrides vertical/horizontal dividers accurately
(function testSquarePads() {
  var configs = [
    { verticalLines: 9, horizontalLines: 19 },
    { verticalLines: 9, horizontalLines: 21 },
    { verticalLines: 5, horizontalLines: 14, outerMargin: 1.75, toolDiameter: 0.375 }
  ];

  for (var i = 0; i < configs.length; i++) {
    var cfg = Object.assign({ squarePads: true }, configs[i]);
    var layout = Geometry.computeLayout(cfg);
    assert.strictEqual(layout.isValid, true);
    var q0 = layout.quadrants[0];
    approxEq(q0.padX, q0.padY, 0.0005, 'Square pads failed for config ' + i);
    assert(layout.dividerX >= layout.centerDivider - 0.0001, 'dividerX shrank below baseDivider');
    assert(layout.dividerY >= layout.centerDivider - 0.0001, 'dividerY shrank below baseDivider');

    var centered = Geometry.computeCenteredInlets(cfg);
    var layoutC = Geometry.computeLayout(Object.assign({}, cfg, centered));
    assert.strictEqual(layoutC.warnings.length, 0);
    var res = GCode.generateGrblGcode(layoutC);
    parseGcodeAndAudit(layoutC, res);
  }
  console.log('✓ Test 2 passed: 1:1 Square Pads across multiple grid counts & dividers');
})();

// Test 3: Holding tabs (4x 2mmx2mm), custom ramp angles (15 deg, 45 deg, 90 deg), and 0 flange clearance
(function testTabsAndRampAngles() {
  var layoutTabs = Geometry.computeLayout({
    inletTabs: true,
    flangeClearanceRadius: 0,
    rampAngle: 15,
    verticalLines: 4,
    horizontalLines: 6
  });
  assert.strictEqual(layoutTabs.isValid, true);
  assert.strictEqual(layoutTabs.totalRemovedPads, 0);
  var resTabs = GCode.generateGrblGcode(layoutTabs);
  parseGcodeAndAudit(layoutTabs, resTabs);

  var meshTabs = Preview3D.buildPlenumMesh(layoutTabs);
  assert(meshTabs.vertexCount > 1000, '3D mesh with tabs should build cleanly');

  var layout45 = Geometry.computeLayout({
    rampAngle: 45,
    inletTabs: true,
    stepdown: 2,
    toolDiameter: 0.375,
    verticalLines: 3,
    horizontalLines: 5
  });
  var res45 = GCode.generateGrblGcode(layout45);
  parseGcodeAndAudit(layout45, res45);

  var layout90 = Geometry.computeLayout({
    rampAngle: 90,
    verticalLines: 3,
    horizontalLines: 4
  });
  var res90 = GCode.generateGrblGcode(layout90);
  parseGcodeAndAudit(layout90, res90);

  console.log('✓ Test 3 passed: 4x 2x2mm holding tabs, 15°/45°/90° ramps, and 0mm flange radius');
})();

// Test 4: Validation & DOM ID integrity check
(function testValidationAndDom() {
  var badAngle = Geometry.computeLayout({ rampAngle: 2 });
  assert.strictEqual(badAngle.isValid, false);

  var shallowInlet = Geometry.computeLayout({ inletCutDepth: 0.5, sheetThickness: 0.75 });
  assert.strictEqual(shallowInlet.isValid, true);
  assert(shallowInlet.warnings.length > 0, 'Shallow inlet cut-through depth should warn');

  var base = path.resolve(__dirname, '..');
  var html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  var app = fs.readFileSync(path.join(base, 'js/app.js'), 'utf8');
  var htmlIds = {};
  html.replace(/id="([^"]+)"/g, function (_, id) {
    htmlIds[id] = true;
  });
  var missing = [];
  app.replace(/getElementById\(['"]([^'"]+)['"]\)/g, function (_, id) {
    if (!htmlIds[id]) missing.push(id);
  });
  assert.strictEqual(missing.length, 0, 'Missing HTML IDs referenced by app.js: ' + missing.join(', '));

  console.log('✓ Test 4 passed: Validation warnings/errors and all HTML DOM ID bindings verified');
})();

console.log('All v2 verification tests passed!');
