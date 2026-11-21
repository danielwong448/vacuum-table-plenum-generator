'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var Geometry = require('../js/geometry.js');
var GCode = require('../js/gcode.js');
var Preview3D = require('../js/preview3d.js');
var DXF = require('../js/dxf.js');
var STEP = require('../js/step.js');

function approxEq(a, b, tol, msg) {
  var d = Math.abs(a - b);
  if (d > (tol || 0.001)) {
    throw new assert.AssertionError({
      message: (msg || 'approxEq failed') + ': expected ' + b + ', got ' + a + ' (diff ' + d + ')'
    });
  }
}

function pointInSlabsMm(x, y, slabsMm) {
  for (var i = 0; i < slabsMm.length; i++) {
    var s = slabsMm[i];
    if (y >= s.y0 - 0.02 && y <= s.y1 + 0.02 && x >= s.x0 - 0.02 && x <= s.x1 + 0.02) {
      return true;
    }
  }
  return false;
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
    var slabsMm =
      q.flangePocket && q.flangePocket.centerSlabs
        ? q.flangePocket.centerSlabs.map(function (s) {
            return {
              x0: Geometry.round3(Geometry.inToMm(s.x0)),
              x1: Geometry.round3(Geometry.inToMm(s.x1)),
              y0: Geometry.round3(Geometry.inToMm(s.y0)),
              y1: Geometry.round3(Geometry.inToMm(s.y1))
            };
          })
        : [];

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
      centerSlabsMm: slabsMm,
      vertSeen: {},
      horizSeen: {},
      inFlangeStage: false
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

  var cutEvents = [];
  var perimeterDepths = [];
  var inletDepths = [];
  var slotDepths = [];
  var flangeDepths = [];
  var rampAnglesSeen = [];
  var inletTabLiftCount = 0;
  var sawGridMoves = [];

  var expectedSheetThickMm = Geometry.round3(Geometry.inToMm(p.sheetThickness));
  var expectedTabTopDepthMm = Math.max(0, Geometry.round3(expectedSheetThickMm - 2.0));
  var inInletHole = false;

  for (var idx = 0; idx < lines.length; idx++) {
    var raw = lines[idx].trim();
    if (!raw) continue;
    if (raw.startsWith('(')) {
      for (var qci = 0; qci < quadBoundsMm.length; qci++) {
        if (raw.indexOf(quadBoundsMm[qci].id) !== -1 && raw.indexOf('Flange Pocket') !== -1) {
          quadBoundsMm[qci].inFlangeStage = true;
        }
      }
      continue;
    }

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

        if (qb1.inFlangeStage && qb1.centerSlabsMm.length > 0) {
          assert(
            pointInSlabsMm(x, y, qb1.centerSlabsMm) && pointInSlabsMm(nextX, nextY, qb1.centerSlabsMm),
            'Flange pocket spiral move escaped centerSlabs bounds at line ' + (idx + 1) + ': ' + raw
          );
          assert(dxAbs < 0.002 || dyAbs < 0.002, 'Flange spiral move must be orthogonal at line ' + (idx + 1));
          cutEvents.push({ type: 'flange', quad: qb1.id, z: z });
          flangeDepths.push(-z);
        } else if (onPerim) {
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

  // Verify exact phase ordering
  var phase = 'perimeter';
  var quadOrder = ['FL', 'FR', 'BR', 'BL'];
  var lastQuadIdx = -1;
  var quadSubStage = 0;

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

  var expectedChannelMm = Geometry.round3(Geometry.inToMm(p.channelDepth));
  var expectedPocketMm = Geometry.round3(Geometry.inToMm(p.flangePocketDepth));
  var expectedThroughMm = Geometry.round3(Geometry.inToMm(p.inletCutDepth));
  approxEq(Math.max.apply(null, perimeterDepths), expectedChannelMm, 0.002, 'Perimeter max depth');
  approxEq(Math.max.apply(null, inletDepths), expectedThroughMm, 0.002, 'Inlet max depth');
  if (slotDepths.length > 0) {
    approxEq(Math.max.apply(null, slotDepths), expectedChannelMm, 0.002, 'Grid slot max depth');
  }
  if (layout.totalRemovedPads > 0) {
    assert(flangeDepths.length > 0, 'Expected flange pocket spiral passes when pads are removed');
    approxEq(Math.max.apply(null, flangeDepths), expectedPocketMm, 0.002, 'Flange pocket max depth');
  } else {
    assert.strictEqual(flangeDepths.length, 0, 'Expected 0 flange moves when clearance radius is 0');
  }

  if (p.rampAngle < 89 && (p.verticalLines > 0 || p.horizontalLines > 0)) {
    assert(rampAnglesSeen.length > 0, 'Expected zig-zag ramp moves');
    for (var ri = 0; ri < rampAnglesSeen.length; ri++) {
      approxEq(rampAnglesSeen[ri], p.rampAngle, 1.0, 'Ramp angle mismatch');
    }
    for (var mi = 0; mi < sawGridMoves.length; mi++) {
      var m = sawGridMoves[mi];
      if (m.moveKind === 'ramp') {
        var next1 = sawGridMoves[mi + 1];
        var next2 = sawGridMoves[mi + 2];
        var next3 = sawGridMoves[mi + 3];
        assert(next1 && next2, 'Ramp missing follow-up back-clean and finish moves');
        var rev = Math.abs(next1.x2 - m.x1) < 0.005 && Math.abs(next1.y2 - m.y1) < 0.005 ? next1 : next2;
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

function auditDxf(layout, units) {
  var dxf = DXF.generateDxf(layout, units);
  var lines = dxf.trim().split('\n');
  assert.strictEqual(lines[lines.length - 1], 'EOF', 'DXF must end with EOF');
  assert(dxf.indexOf('$ACADVER\n1\nAC1009') !== -1, 'DXF missing AC1009 header');

  var s = units === 'mm' ? Geometry.MM_PER_INCH : 1.0;
  var layersSeen = {};
  var circles = [];
  var polyByLayer = {};

  for (var i = 0; i < lines.length - 1; i += 2) {
    var code = lines[i];
    var val = lines[i + 1];
    if (code === '0' && val === 'LAYER') {
      if (lines[i + 2] === '2') layersSeen[lines[i + 3]] = true;
    } else if (code === '0' && val === 'CIRCLE') {
      var c = { layer: '', x: 0, y: 0, r: 0 };
      for (var j = i + 2; j < lines.length - 1 && lines[j] !== '0'; j += 2) {
        if (lines[j] === '8') c.layer = lines[j + 1];
        if (lines[j] === '10') c.x = parseFloat(lines[j + 1]);
        if (lines[j] === '20') c.y = parseFloat(lines[j + 1]);
        if (lines[j] === '40') c.r = parseFloat(lines[j + 1]);
      }
      circles.push(c);
    } else if (code === '0' && val === 'POLYLINE') {
      var pLayer = '';
      for (var k = i + 2; k < lines.length - 1 && lines[k] !== '0'; k += 2) {
        if (lines[k] === '8') pLayer = lines[k + 1];
      }
      polyByLayer[pLayer] = (polyByLayer[pLayer] || 0) + 1;
    }
  }

  var requiredLayers = [
    'SHEET_OUTLINE',
    'QUADRANT_BOUNDARIES',
    'PADS',
    'FLANGE_POCKETS',
    'INLET_HOLES',
    'CHANNEL_CENTERLINES'
  ];
  for (var rl = 0; rl < requiredLayers.length; rl++) {
    assert(layersSeen[requiredLayers[rl]], 'Missing DXF layer ' + requiredLayers[rl]);
  }

  assert.strictEqual(circles.length, 4, 'DXF must contain exactly 4 CIRCLE inlet entities');
  for (var ci = 0; ci < 4; ci++) {
    approxEq(circles[ci].x, layout.inlets[ci].cx * s, 0.01, 'DXF circle X mismatch');
    approxEq(circles[ci].y, layout.inlets[ci].cy * s, 0.01, 'DXF circle Y mismatch');
    approxEq(circles[ci].r, layout.inlets[ci].radius * s, 0.01, 'DXF circle R mismatch');
  }

  var expectedKeptPads = 0;
  var expectedPockets = 0;
  for (var qi = 0; qi < layout.quadrants.length; qi++) {
    var q = layout.quadrants[qi];
    if (q.flangePocket) expectedPockets++;
    for (var pi = 0; pi < q.pads.length; pi++) {
      var pad = q.pads[pi];
      if (!pad.removed && !pad.overlapsHole && pad.px1 > pad.px0 + 1e-4 && pad.py1 > pad.py0 + 1e-4) {
        expectedKeptPads++;
      }
    }
  }
  assert.strictEqual(polyByLayer.SHEET_OUTLINE, 1, 'Expected 1 SHEET_OUTLINE polyline');
  assert.strictEqual(polyByLayer.QUADRANT_BOUNDARIES, 4, 'Expected 4 QUADRANT_BOUNDARIES polylines');
  assert.strictEqual(polyByLayer.PADS || 0, expectedKeptPads, 'DXF kept PADS count mismatch');
  assert.strictEqual(polyByLayer.FLANGE_POCKETS || 0, expectedPockets, 'DXF FLANGE_POCKETS count mismatch');
}

function auditStepBRep(layout, label) {
  var step = STEP.generateStep(layout);
  assert(step.indexOf('ISO-10303-21;') === 0, label + ': missing ISO-10303-21 header');
  assert(step.indexOf('END-ISO-10303-21;') !== -1, label + ': missing END-ISO-10303-21');
  assert(step.indexOf('CLOSED_SHELL(') !== -1, label + ': missing CLOSED_SHELL');

  var defs = {};
  var edges = {};
  var oes = {};
  var loops = {};
  var cylSurfs = {};
  var cylFaceRadii = [];
  var minX = Infinity;
  var maxX = -Infinity;
  var minY = Infinity;
  var maxY = -Infinity;
  var minZ = Infinity;
  var maxZ = -Infinity;

  var lines = step.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var hm = lines[i].match(/^#(\d+)=(.+);$/);
    if (!hm) continue;
    var id = hm[1];
    var body = hm[2];
    defs[id] = body;

    var pm = body.match(/^CARTESIAN_POINT\([^,]*,\(([^)]+)\)\)$/);
    if (pm) {
      var coords = pm[1].split(',').map(parseFloat);
      if (coords[0] < minX) minX = coords[0];
      if (coords[0] > maxX) maxX = coords[0];
      if (coords[1] < minY) minY = coords[1];
      if (coords[1] > maxY) maxY = coords[1];
      if (coords[2] < minZ) minZ = coords[2];
      if (coords[2] > maxZ) maxZ = coords[2];
    }
    var em = body.match(/^EDGE_CURVE\([^,]*,#(\d+),#(\d+),/);
    if (em) edges[id] = { v1: em[1], v2: em[2], T: 0, F: 0 };
    var om = body.match(/^ORIENTED_EDGE\([^,]*,[^,]*,[^,]*,#(\d+),\.(T|F)\.\)$/);
    if (om) oes[id] = { edge: om[1], sense: om[2] };
    var lm = body.match(/^EDGE_LOOP\([^,]*,\(([^)]+)\)\)$/);
    if (lm) {
      loops[id] = lm[1].split(',').map(function (s) {
        return s.trim().slice(1);
      });
    }
    var csm = body.match(/^CYLINDRICAL_SURFACE\([^,]*,#\d+,([^)]+)\)$/);
    if (csm) cylSurfs[id] = parseFloat(csm[1]);
  }

  // Verify zero dangling entity refs & count cylindrical faces
  var defIds = Object.keys(defs);
  for (var di = 0; di < defIds.length; di++) {
    var did = defIds[di];
    var b = defs[did];
    var refs = b.match(/#(\d+)/g) || [];
    for (var ri = 0; ri < refs.length; ri++) {
      assert(defs[refs[ri].slice(1)] !== undefined, label + ': dangling ref ' + refs[ri]);
    }
    var fm = b.match(/^ADVANCED_FACE\([^,]*,\([^)]*\),#(\d+),/);
    if (fm && cylSurfs[fm[1]] !== undefined) {
      cylFaceRadii.push(cylSurfs[fm[1]]);
    }
  }

  // Tally ORIENTED_EDGE senses per EDGE_CURVE
  var oeIds = Object.keys(oes);
  for (var oi = 0; oi < oeIds.length; oi++) {
    var o = oes[oeIds[oi]];
    var e = edges[o.edge];
    assert(e, label + ': ORIENTED_EDGE missing EDGE_CURVE #' + o.edge);
    e[o.sense]++;
  }

  var edgeIds = Object.keys(edges);
  for (var ei = 0; ei < edgeIds.length; ei++) {
    var ed = edges[edgeIds[ei]];
    assert(
      ed.T === 1 && ed.F === 1,
      label + ': non-manifold EDGE_CURVE #' + edgeIds[ei] + ' (T=' + ed.T + ', F=' + ed.F + ')'
    );
  }

  // Verify every EDGE_LOOP is strictly closed
  var loopIds = Object.keys(loops);
  for (var li = 0; li < loopIds.length; li++) {
    var lid = loopIds[li];
    var lEdges = loops[lid];
    assert(lEdges.length >= 2, label + ': degenerate EDGE_LOOP #' + lid);
    for (var k = 0; k < lEdges.length; k++) {
      var o1 = oes[lEdges[k]];
      var o2 = oes[lEdges[(k + 1) % lEdges.length]];
      var e1 = edges[o1.edge];
      var e2 = edges[o2.edge];
      var end1 = o1.sense === 'T' ? e1.v2 : e1.v1;
      var start2 = o2.sense === 'T' ? e2.v1 : e2.v2;
      assert.strictEqual(end1, start2, label + ': unclosed vertex chain in EDGE_LOOP #' + lid);
    }
  }

  // Bounding box & cylinder check
  approxEq(minX, 0, 0.01, label + ': STEP minX');
  approxEq(maxX, Geometry.inToMm(layout.sheetWidth), 0.01, label + ': STEP maxX');
  approxEq(minY, 0, 0.01, label + ': STEP minY');
  approxEq(maxY, Geometry.inToMm(layout.sheetLength), 0.01, label + ': STEP maxY');
  approxEq(minZ, -Geometry.inToMm(layout.sheetThickness), 0.01, label + ': STEP minZ');
  approxEq(maxZ, 0, 0.01, label + ': STEP maxZ');
  assert.strictEqual(cylFaceRadii.length, 8, label + ': expected 8 cylindrical hole half-faces');
  for (var ci = 0; ci < cylFaceRadii.length; ci++) {
    approxEq(cylFaceRadii[ci], Geometry.inToMm(layout.params.inletDiameter / 2), 0.01, label + ': hole radius');
  }
}

console.log('Running Vacuum Table Plenum Generator verification suite...');

// Test 1: Default 49x97, 0.5" recessed pocket, 3mm spiral stepover, 30 deg ramp
(function testDefaultsAndSpiral() {
  var d = Geometry.DEFAULT_PARAMS;
  assert.strictEqual(d.sheetWidth, 49);
  assert.strictEqual(d.sheetLength, 97);
  assert.strictEqual(d.flangePocketDepth, 0.5);
  assert.strictEqual(d.pocketStepover, 3);
  assert.strictEqual(d.rampAngle, 30);

  var layout = Geometry.computeLayout(d);
  assert.strictEqual(layout.isValid, true);
  assert.strictEqual(layout.errors.length, 0);
  assert.strictEqual(layout.warnings.length, 0);
  assert(layout.totalRemovedPads > 0);

  var res = GCode.generateGrblGcode(layout);
  parseGcodeAndAudit(layout, res);

  // Verify stepover affects pocket spiral length cleanly
  var resFine = GCode.generateGrblGcode(Geometry.computeLayout({ pocketStepover: 2 }));
  var resCoarse = GCode.generateGrblGcode(Geometry.computeLayout({ pocketStepover: 4 }));
  assert(resFine.stats.lineCount > res.stats.lineCount, '2mm stepover should emit more spiral moves than 3mm');
  assert(resCoarse.stats.lineCount < res.stats.lineCount, '4mm stepover should emit fewer spiral moves than 3mm');

  var mesh = Preview3D.buildPlenumMesh(layout);
  assert(mesh.vertexCount > 1000);
  for (var i = 0; i < mesh.positions.length; i++) {
    assert(Number.isFinite(mesh.positions[i]));
  }

  console.log(
    '✓ Test 1 passed: 49x97 default, 0.5" spiral pocket @ 3mm stepover, 30° ramp (' +
      res.stats.lineCount +
      ' lines)'
  );
})();

// Test 2: 1:1 Square Pads, shallow pocket (0.25" < 0.375"), deep pocket (0.6"), 0 clearance
(function testSquarePadsAndPocketDepths() {
  var squareCfg = { squarePads: true, verticalLines: 9, horizontalLines: 21 };
  var sqLayout = Geometry.computeLayout(squareCfg);
  assert.strictEqual(sqLayout.isValid, true);
  approxEq(sqLayout.quadrants[0].padX, sqLayout.quadrants[0].padY, 0.0005, '1:1 square pad equality');
  parseGcodeAndAudit(sqLayout, GCode.generateGrblGcode(sqLayout));

  var shallowLayout = Geometry.computeLayout({ flangePocketDepth: 0.25, verticalLines: 5, horizontalLines: 8 });
  parseGcodeAndAudit(shallowLayout, GCode.generateGrblGcode(shallowLayout));
  assert(Preview3D.buildPlenumMesh(shallowLayout).vertexCount > 500);

  var deepLayout = Geometry.computeLayout({ flangePocketDepth: 0.6, verticalLines: 5, horizontalLines: 8 });
  parseGcodeAndAudit(deepLayout, GCode.generateGrblGcode(deepLayout));

  var noClearLayout = Geometry.computeLayout({ flangeClearanceRadius: 0, verticalLines: 5, horizontalLines: 8 });
  parseGcodeAndAudit(noClearLayout, GCode.generateGrblGcode(noClearLayout));
  assert(Preview3D.buildPlenumMesh(noClearLayout).vertexCount > 500);

  console.log('✓ Test 2 passed: 1:1 Square Pads, 0.25" shallow / 0.6" deep pockets, and 0 clearance');
})();

// Test 3: Holding tabs (4x 2mmx2mm) and custom ramp angles (15°, 45°, 90°)
(function testTabsAndRamps() {
  var layoutTabs = Geometry.computeLayout({
    inletTabs: true,
    rampAngle: 15,
    verticalLines: 4,
    horizontalLines: 6
  });
  parseGcodeAndAudit(layoutTabs, GCode.generateGrblGcode(layoutTabs));
  assert(Preview3D.buildPlenumMesh(layoutTabs).vertexCount > 500);

  var layout90 = Geometry.computeLayout({ rampAngle: 90, verticalLines: 3, horizontalLines: 4 });
  parseGcodeAndAudit(layout90, GCode.generateGrblGcode(layout90));

  console.log('✓ Test 3 passed: 4x 2x2mm holding tabs and 15°/90° zig-zag ramps');
})();

// Test 4: Top-view DXF Export (in & mm) and Watertight AP214 STEP B-Rep Audit
(function testDxfAndStepExports() {
  var defaultLayout = Geometry.computeLayout(Geometry.DEFAULT_PARAMS);
  auditDxf(defaultLayout, 'in');
  auditDxf(defaultLayout, 'mm');

  auditStepBRep(defaultLayout, 'default');
  auditStepBRep(Geometry.computeLayout({ squarePads: true }), 'square');
  auditStepBRep(Geometry.computeLayout({ flangePocketDepth: 0.25 }), 'shallow');
  auditStepBRep(Geometry.computeLayout({ flangeClearanceRadius: 0 }), 'noClearance');
  auditStepBRep(
    Geometry.computeLayout({ flangeClearanceRadius: 12, verticalLines: 4, horizontalLines: 6 }),
    'touchWall'
  );
  auditStepBRep(
    Geometry.computeLayout({
      outerMargin: 0,
      centerDivider: 0.5,
      linkDividerToMargin: false,
      verticalLines: 3,
      horizontalLines: 4
    }),
    'zeroMargin'
  );

  console.log('✓ Test 4 passed: DXF (in/mm) and watertight AP214 STEP B-Rep (0 non-manifold edges across 6 layouts)');
})();

// Test 5: Validation rules & DOM ID integrity check
(function testValidationAndDom() {
  assert.strictEqual(Geometry.computeLayout({ flangePocketDepth: 0.75 }).isValid, false);
  assert.strictEqual(Geometry.computeLayout({ pocketStepover: 7 }).isValid, false);
  assert(Geometry.computeLayout({ pocketStepover: 5 }).warnings.length > 0);

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

  console.log('✓ Test 5 passed: Validation rules and all HTML DOM ID bindings verified');
})();

console.log('All verification tests passed!');
