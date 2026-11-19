(function (global) {
  'use strict';

  var Geometry =
    global.PlenumApp && global.PlenumApp.Geometry
      ? global.PlenumApp.Geometry
      : typeof require === 'function'
      ? require('./geometry.js')
      : null;

  if (!Geometry) {
    throw new Error('PlenumApp.Geometry must be loaded before gcode.js');
  }

  var MM_PER_INCH = Geometry.MM_PER_INCH;
  var inToMm = Geometry.inToMm;
  var round3 = Geometry.round3;

  function fmt(n) {
    var v = round3(n);
    return (v === 0 ? 0 : v).toFixed(3);
  }

  function mmToIn(mm) {
    return mm / MM_PER_INCH;
  }

  function computePassDepthsFrom(startMm, totalDepthMm, stepdownMm) {
    var start = round3(startMm);
    var total = round3(totalDepthMm);
    if (!(total > start + 0.0005) || !(stepdownMm > 0)) {
      return [];
    }
    var depths = [];
    var cur = start;
    while (cur < total - 0.001) {
      var next = cur + stepdownMm;
      if (next >= total - 0.001) {
        depths.push(total);
        break;
      }
      var nextRounded = round3(next);
      if (nextRounded <= cur) {
        nextRounded = round3(cur + 0.001);
      }
      if (nextRounded >= total - 0.001) {
        depths.push(total);
        break;
      }
      depths.push(nextRounded);
      cur = nextRounded;
    }
    if (depths.length === 0) {
      depths.push(total);
    }
    return depths;
  }

  function computePassDepths(totalDepthMm, stepdownMm) {
    return computePassDepthsFrom(0, totalDepthMm, stepdownMm);
  }

  function formatDuration(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return '0s';
    var totalSeconds = Math.round(minutes * 60);
    var hrs = Math.floor(totalSeconds / 3600);
    var mins = Math.floor((totalSeconds % 3600) / 60);
    var secs = totalSeconds % 60;
    if (hrs > 0) {
      return hrs + 'h ' + mins + 'm';
    }
    if (mins > 0) {
      return mins + 'm ' + secs + 's';
    }
    return secs + 's';
  }

  function sanitizeComment(text) {
    return String(text).replace(/[()]/g, '');
  }

  // Search 3x3 0.001mm neighborhood around (cxMm - x1, cyMm - y1) to eliminate GRBL Error 33 radius mismatch
  function bestArcIJ(x1, y1, x2, y2, cxMm, cyMm) {
    var baseI = round3(cxMm - x1);
    var baseJ = round3(cyMm - y1);
    var bestI = baseI;
    var bestJ = baseJ;
    var bestErr = Infinity;

    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var candI = round3(baseI + di * 0.001);
        var candJ = round3(baseJ + dj * 0.001);
        var cxC = x1 + candI;
        var cyC = y1 + candJ;
        var rStart = Math.hypot(candI, candJ);
        var rEnd = Math.hypot(x2 - cxC, y2 - cyC);
        var err = Math.abs(rStart - rEnd);
        if (err < bestErr) {
          bestErr = err;
          bestI = candI;
          bestJ = candJ;
        }
      }
    }
    return { i: bestI, j: bestJ };
  }

  function buildToolpathPlan(layout, overrideParams) {
    var p = overrideParams ? Geometry.normalizeParams(overrideParams) : layout.params;
    var safeZ = round3(p.safeZ);
    var plungeClearanceZ = round3(Math.min(2.0, safeZ));
    var feedRate = Math.round(p.feedRate);
    var plungeRate = Math.round(p.plungeRate);
    var rpm = Math.round(p.rpm);

    var channelDepthMm = round3(inToMm(p.channelDepth));
    var throughDepthMm = round3(inToMm(p.inletCutDepth));
    var sheetThicknessMm = round3(inToMm(p.sheetThickness));
    var channelPasses = computePassDepths(channelDepthMm, p.stepdown);

    var rampAngleDeg = Math.min(90, Math.max(5, p.rampAngle));
    var rampAngleRad = (rampAngleDeg * Math.PI) / 180;
    var useRamp = rampAngleDeg < 89;
    var rampFeed = useRamp
      ? Math.min(feedRate, Math.max(plungeRate, Math.round(plungeRate / Math.sin(rampAngleRad))))
      : feedRate;

    var segments = [];
    var lines = [];
    var sections = [];

    var curX = 0;
    var curY = 0;
    var curZ = safeZ;

    var cutDistanceMm = 0;
    var plungeDistanceMm = 0;
    var rapidDistanceMm = 0;
    var assumedRapidMmPerMin = 6000;

    function pushSection(id, label) {
      sections.push({
        id: id,
        label: label,
        lineNumber: lines.length + 1
      });
    }

    function pushComment(text) {
      lines.push('(' + sanitizeComment(text) + ')');
    }

    function rapidZ(targetZ, meta) {
      var tz = round3(targetZ);
      if (Math.abs(tz - curZ) < 0.0005) return;
      rapidDistanceMm += Math.abs(tz - curZ);
      lines.push('G0 Z' + fmt(tz));
      segments.push({
        opType: meta.opType,
        quadrantId: meta.quadrantId,
        moveType: 'rapid',
        label: meta.label,
        x1: mmToIn(curX),
        y1: mmToIn(curY),
        z1: curZ,
        x2: mmToIn(curX),
        y2: mmToIn(curY),
        z2: tz
      });
      curZ = tz;
    }

    function rapidXY(targetX, targetY, meta) {
      var tx = round3(targetX);
      var ty = round3(targetY);
      var dx = tx - curX;
      var dy = ty - curY;
      var dist = Math.hypot(dx, dy);
      if (dist < 0.0005) return;
      rapidDistanceMm += dist;
      lines.push('G0 X' + fmt(tx) + ' Y' + fmt(ty));
      segments.push({
        opType: meta.opType,
        quadrantId: meta.quadrantId,
        moveType: 'rapid',
        label: meta.label,
        x1: mmToIn(curX),
        y1: mmToIn(curY),
        z1: curZ,
        x2: mmToIn(tx),
        y2: mmToIn(ty),
        z2: curZ
      });
      curX = tx;
      curY = ty;
    }

    function plungeZ(targetZ, meta) {
      var tz = round3(targetZ);
      var dz = Math.abs(tz - curZ);
      if (dz < 0.0005) return;
      plungeDistanceMm += dz;
      lines.push('G1 Z' + fmt(tz) + ' F' + plungeRate);
      segments.push({
        opType: meta.opType,
        quadrantId: meta.quadrantId,
        moveType: 'plunge',
        label: meta.label,
        x1: mmToIn(curX),
        y1: mmToIn(curY),
        z1: curZ,
        x2: mmToIn(curX),
        y2: mmToIn(curY),
        z2: tz
      });
      curZ = tz;
    }

    function rampMove(targetX, targetY, targetZ, feed, meta) {
      var tx = round3(targetX);
      var ty = round3(targetY);
      var tz = round3(targetZ);
      var dist = Math.hypot(tx - curX, ty - curY, tz - curZ);
      cutDistanceMm += dist;

      var parts = ['G1'];
      if (Math.abs(tx - curX) >= 0.0005) parts.push('X' + fmt(tx));
      if (Math.abs(ty - curY) >= 0.0005) parts.push('Y' + fmt(ty));
      parts.push('Z' + fmt(tz));
      parts.push('F' + Math.round(feed));
      lines.push(parts.join(' '));

      segments.push({
        opType: meta.opType,
        quadrantId: meta.quadrantId,
        moveType: 'ramp',
        label: meta.label,
        passIndex: meta.passIndex,
        totalPasses: meta.totalPasses,
        x1: mmToIn(curX),
        y1: mmToIn(curY),
        z1: curZ,
        x2: mmToIn(tx),
        y2: mmToIn(ty),
        z2: tz
      });
      curX = tx;
      curY = ty;
      curZ = tz;
    }

    function cutLine(targetX, targetY, includeFeed, meta) {
      var tx = round3(targetX);
      var ty = round3(targetY);
      var dx = tx - curX;
      var dy = ty - curY;
      var dist = Math.hypot(dx, dy);
      if (dist < 0.0005) return;
      cutDistanceMm += dist;

      var parts = ['G1'];
      if (Math.abs(dx) >= 0.0005) parts.push('X' + fmt(tx));
      if (Math.abs(dy) >= 0.0005) parts.push('Y' + fmt(ty));
      if (parts.length === 1) {
        parts.push('X' + fmt(tx), 'Y' + fmt(ty));
      }
      if (includeFeed) {
        parts.push('F' + feedRate);
      }
      lines.push(parts.join(' '));

      segments.push({
        opType: meta.opType,
        quadrantId: meta.quadrantId,
        moveType: 'cut',
        label: meta.label,
        passIndex: meta.passIndex,
        totalPasses: meta.totalPasses,
        x1: mmToIn(curX),
        y1: mmToIn(curY),
        z1: curZ,
        x2: mmToIn(tx),
        y2: mmToIn(ty),
        z2: curZ
      });
      curX = tx;
      curY = ty;
    }

    function cutArcCCW(targetX, targetY, cxMm, cyMm, rMm, sweepAngleRad, includeFeed, meta) {
      var tx = round3(targetX);
      var ty = round3(targetY);
      var ij = bestArcIJ(curX, curY, tx, ty, cxMm, cyMm);
      var arcLen = sweepAngleRad * rMm;
      cutDistanceMm += arcLen;

      var cmd = 'G3 X' + fmt(tx) + ' Y' + fmt(ty) + ' I' + fmt(ij.i) + ' J' + fmt(ij.j);
      if (includeFeed) {
        cmd += ' F' + feedRate;
      }
      lines.push(cmd);

      segments.push({
        opType: meta.opType,
        quadrantId: meta.quadrantId,
        moveType: 'arc',
        label: meta.label,
        passIndex: meta.passIndex,
        totalPasses: meta.totalPasses,
        x1: mmToIn(curX),
        y1: mmToIn(curY),
        z1: curZ,
        x2: mmToIn(tx),
        y2: mmToIn(ty),
        z2: curZ,
        cx: mmToIn(cxMm),
        cy: mmToIn(cyMm),
        r: mmToIn(rMm),
        sweepAngle: sweepAngleRad,
        ccw: true
      });
      curX = tx;
      curY = ty;
    }

    // Header
    pushSection('header', 'Header');
    pushComment('Vacuum Table Plenum Generator - GRBL v1.1 Post');
    pushComment(
      'Sheet: ' +
        p.sheetWidth +
        'in x ' +
        p.sheetLength +
        'in x ' +
        p.sheetThickness +
        'in | Units: Metric G21'
    );
    pushComment(
      'End Mill: ' +
        p.toolDiameter +
        'in | Channel Depth: ' +
        p.channelDepth +
        'in [' +
        fmt(channelDepthMm) +
        'mm] | Inlet Cut Depth: ' +
        fmt(throughDepthMm) +
        'mm'
    );
    pushComment(
      'Dividers X/Y: ' +
        Geometry.round3(layout.dividerX) +
        'in / ' +
        Geometry.round3(layout.dividerY) +
        'in | Grid/Quad: ' +
        p.verticalLines +
        'V x ' +
        p.horizontalLines +
        'H'
    );
    pushComment(
      'Cutting: ' +
        rpm +
        ' RPM | Feed ' +
        feedRate +
        ' mm/min | Plunge ' +
        plungeRate +
        ' mm/min | Stepdown ' +
        p.stepdown +
        ' mm | Ramp ' +
        rampAngleDeg +
        ' deg'
    );
    pushComment('Work Origin: Front-Left X0 Y0 | Z0 Top Surface of MDF');

    lines.push('G90 G94 G17');
    lines.push('G21');
    lines.push('G0 Z' + fmt(safeZ));
    lines.push('M3 S' + rpm);

    // =========================================================================
    // OP 1: Outside Perimeter of Each Quadrant
    // =========================================================================
    pushSection('perimeters', '1. Perimeters');
    pushComment('=== OPERATION 1: QUADRANT PERIMETER RECTANGLES ===');

    for (var qi = 0; qi < layout.quadrants.length; qi++) {
      var q = layout.quadrants[qi];
      var x0Mm = round3(inToMm(q.x0));
      var x1Mm = round3(inToMm(q.x1));
      var y0Mm = round3(inToMm(q.y0));
      var y1Mm = round3(inToMm(q.y1));

      var perimMeta = {
        opType: 'perimeter',
        quadrantId: q.id,
        label: 'Op 1/3 · Perimeter ' + q.shortLabel
      };

      pushComment('Perimeter ' + q.shortLabel + ' (' + q.label + ')');
      rapidZ(safeZ, perimMeta);
      rapidXY(x0Mm, y0Mm, perimMeta);
      rapidZ(plungeClearanceZ, perimMeta);

      for (var pi = 0; pi < channelPasses.length; pi++) {
        var passDepth = channelPasses[pi];
        var passMeta = {
          opType: 'perimeter',
          quadrantId: q.id,
          label: 'Op 1/3 · Perimeter ' + q.shortLabel + ' (Pass ' + (pi + 1) + '/' + channelPasses.length + ')',
          passIndex: pi + 1,
          totalPasses: channelPasses.length
        };
        plungeZ(-passDepth, passMeta);
        cutLine(x1Mm, y0Mm, true, passMeta);
        cutLine(x1Mm, y1Mm, false, passMeta);
        cutLine(x0Mm, y1Mm, false, passMeta);
        cutLine(x0Mm, y0Mm, false, passMeta);
      }

      rapidZ(safeZ, perimMeta);
    }

    // =========================================================================
    // OP 2: Center Cut-Through Holes for All Four Inlets (with optional 4 tabs)
    // =========================================================================
    pushSection('inlets', '2. Inlet Holes');
    pushComment('=== OPERATION 2: INLET CUT-THROUGH HOLES ===');

    var toolDiaMm = inToMm(p.toolDiameter);
    var toolpathRadiusMm = round3(inToMm((p.inletDiameter - p.toolDiameter) / 2));
    var tabHeightMm = 2.0;
    var tabWidthMm = 2.0;
    var tabTopDepthMm = Math.max(0, round3(sheetThicknessMm - tabHeightMm));
    var useTabs = Boolean(p.inletTabs) && throughDepthMm > tabTopDepthMm + 0.001;

    var inletPasses;
    if (useTabs && tabTopDepthMm > 0) {
      inletPasses = computePassDepths(tabTopDepthMm, p.stepdown).concat(
        computePassDepthsFrom(tabTopDepthMm, throughDepthMm, p.stepdown)
      );
    } else {
      inletPasses = computePassDepths(throughDepthMm, p.stepdown);
    }

    var halfTabAngle =
      toolpathRadiusMm > 0
        ? Math.min(Math.PI / 8, (tabWidthMm + toolDiaMm) / (2 * toolpathRadiusMm))
        : 0;
    var tabAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

    for (var hi = 0; hi < layout.quadrants.length; hi++) {
      var hq = layout.quadrants[hi];
      var cxMm = round3(inToMm(hq.inlet.cx));
      var cyMm = round3(inToMm(hq.inlet.cy));
      var xRight = round3(cxMm + toolpathRadiusMm);
      var xLeft = round3(cxMm - toolpathRadiusMm);

      var holeMeta = {
        opType: 'inlet',
        quadrantId: hq.id,
        label: 'Op 2/3 · Inlet Hole ' + hq.shortLabel
      };

      pushComment(
        'Inlet Hole ' +
          hq.shortLabel +
          ' Center X' +
          fmt(cxMm) +
          ' Y' +
          fmt(cyMm) +
          ' Dia ' +
          p.inletDiameter +
          'in' +
          (useTabs ? ' [4x 2x2mm Tabs]' : '')
      );
      rapidZ(safeZ, holeMeta);
      rapidXY(xRight, cyMm, holeMeta);
      rapidZ(plungeClearanceZ, holeMeta);

      var prevTabDepth = tabTopDepthMm;
      for (var ipi = 0; ipi < inletPasses.length; ipi++) {
        var holeDepth = inletPasses[ipi];
        var holePassMeta = {
          opType: 'inlet',
          quadrantId: hq.id,
          label: 'Op 2/3 · Inlet ' + hq.shortLabel + ' (Pass ' + (ipi + 1) + '/' + inletPasses.length + ')',
          passIndex: ipi + 1,
          totalPasses: inletPasses.length
        };

        if (useTabs && holeDepth > tabTopDepthMm + 0.001) {
          // Plunge safely in steps no larger than stepdown
          if (holeDepth - prevTabDepth > p.stepdown + 0.001) {
            plungeZ(-prevTabDepth, holePassMeta);
          }
          plungeZ(-holeDepth, holePassMeta);

          var curAng = 0;
          for (var ti = 0; ti < tabAngles.length; ti++) {
            var tabAng = tabAngles[ti];
            var angStartTab = tabAng - halfTabAngle;
            var angEndTab = tabAng + halfTabAngle;
            var pStartTabX = round3(cxMm + toolpathRadiusMm * Math.cos(angStartTab));
            var pStartTabY = round3(cyMm + toolpathRadiusMm * Math.sin(angStartTab));
            var pEndTabX = round3(cxMm + toolpathRadiusMm * Math.cos(angEndTab));
            var pEndTabY = round3(cyMm + toolpathRadiusMm * Math.sin(angEndTab));

            cutArcCCW(
              pStartTabX,
              pStartTabY,
              cxMm,
              cyMm,
              toolpathRadiusMm,
              angStartTab - curAng,
              true,
              holePassMeta
            );
            plungeZ(-tabTopDepthMm, holePassMeta);
            cutArcCCW(
              pEndTabX,
              pEndTabY,
              cxMm,
              cyMm,
              toolpathRadiusMm,
              angEndTab - angStartTab,
              true,
              holePassMeta
            );
            if (prevTabDepth > tabTopDepthMm + 0.001) {
              plungeZ(-prevTabDepth, holePassMeta);
            }
            plungeZ(-holeDepth, holePassMeta);
            curAng = angEndTab;
          }

          cutArcCCW(
            xRight,
            cyMm,
            cxMm,
            cyMm,
            toolpathRadiusMm,
            2 * Math.PI - curAng,
            true,
            holePassMeta
          );
          prevTabDepth = holeDepth;
        } else {
          plungeZ(-holeDepth, holePassMeta);
          cutArcCCW(xLeft, cyMm, cxMm, cyMm, toolpathRadiusMm, Math.PI, true, holePassMeta);
          cutArcCCW(xRight, cyMm, cxMm, cyMm, toolpathRadiusMm, Math.PI, false, holePassMeta);
        }
      }

      rapidZ(safeZ, holeMeta);
    }

    // =========================================================================
    // OP 3: Quadrant-by-Quadrant -> Vertical Slots -> Horizontal Slots -> Flange Recess Pads
    // =========================================================================
    pushComment('=== OPERATION 3: QUADRANT GRIDS & FLANGE RECESSES ===');

    for (var gqi = 0; gqi < layout.quadrants.length; gqi++) {
      var gq = layout.quadrants[gqi];
      pushSection('grid_' + gq.id, '3.' + (gqi + 1) + ' ' + gq.shortLabel);
      pushComment('--- Quadrant ' + gq.shortLabel + ' (' + gq.label + ') ---');

      var qx0Mm = round3(inToMm(gq.x0));
      var qx1Mm = round3(inToMm(gq.x1));
      var qy0Mm = round3(inToMm(gq.y0));
      var qy1Mm = round3(inToMm(gq.y1));

      // 3a. Vertical straight lines (constant X, zig-zag entry ramp)
      if (gq.verticalLines.length > 0) {
        pushComment(gq.shortLabel + ' Vertical Lines (' + gq.verticalLines.length + ')');
        var vLines = gq.verticalLines.slice();
        var firstVX = round3(inToMm(vLines[0].x));
        var lastVX = round3(inToMm(vLines[vLines.length - 1].x));
        if (Math.abs(curX - lastVX) < Math.abs(curX - firstVX)) {
          vLines.reverse();
        }

        for (var vi = 0; vi < vLines.length; vi++) {
          var vxMm = round3(inToMm(vLines[vi].x));
          var startY = Math.abs(curY - qy0Mm) <= Math.abs(curY - qy1Mm) ? qy0Mm : qy1Mm;
          var endY = startY === qy0Mm ? qy1Mm : qy0Mm;
          var slotLenY = Math.abs(endY - startY);

          var vMeta = {
            opType: 'vertical',
            quadrantId: gq.id,
            label: 'Op 3/3 · ' + gq.shortLabel + ' Vertical ' + (vi + 1) + '/' + vLines.length
          };

          rapidZ(safeZ, vMeta);
          rapidXY(vxMm, startY, vMeta);
          rapidZ(plungeClearanceZ, vMeta);

          if (useRamp) {
            plungeZ(0, vMeta);
          }

          var atY = startY;
          var otherY = endY;
          var prevDepthV = 0;

          for (var vpi = 0; vpi < channelPasses.length; vpi++) {
            var vDepth = channelPasses[vpi];
            var vPassMeta = {
              opType: 'vertical',
              quadrantId: gq.id,
              label:
                'Op 3/3 · ' +
                gq.shortLabel +
                ' Vertical ' +
                (vi + 1) +
                '/' +
                vLines.length +
                ' (Pass ' +
                (vpi + 1) +
                '/' +
                channelPasses.length +
                ')',
              passIndex: vpi + 1,
              totalPasses: channelPasses.length
            };

            if (!useRamp) {
              plungeZ(-vDepth, vPassMeta);
              cutLine(vxMm, otherY, true, vPassMeta);
            } else {
              var dzV = vDepth - prevDepthV;
              var dirY = otherY > atY ? 1 : -1;
              var rampDistY = Math.min(dzV / Math.tan(rampAngleRad), slotLenY * 0.45);
              var rampY = round3(atY + dirY * rampDistY);
              var flatExtraY = Math.min(2.0, Math.max(0, slotLenY * 0.48 - rampDistY));
              var flatY = round3(atY + dirY * (rampDistY + flatExtraY));

              // 1. Ramp down at rampAngleDeg
              rampMove(vxMm, rampY, -vDepth, rampFeed, vPassMeta);
              // 2. Cut slightly further at full depth
              if (Math.abs(flatY - rampY) >= 0.01) {
                cutLine(vxMm, flatY, true, vPassMeta);
              }
              // 3. Reverse once at full depth to clear the ramp wedge
              cutLine(vxMm, atY, true, vPassMeta);
              // 4. Reverse again and finish the full cut
              cutLine(vxMm, otherY, false, vPassMeta);
            }

            var tmpY = atY;
            atY = otherY;
            otherY = tmpY;
            prevDepthV = vDepth;
          }

          rapidZ(safeZ, vMeta);
        }
      }

      // 3b. Horizontal straight lines (constant Y, zig-zag entry ramp)
      if (gq.horizontalLines.length > 0) {
        pushComment(gq.shortLabel + ' Horizontal Lines (' + gq.horizontalLines.length + ')');
        var hLines = gq.horizontalLines.slice();
        var firstHY = round3(inToMm(hLines[0].y));
        var lastHY = round3(inToMm(hLines[hLines.length - 1].y));
        if (Math.abs(curY - lastHY) < Math.abs(curY - firstHY)) {
          hLines.reverse();
        }

        for (var hiLine = 0; hiLine < hLines.length; hiLine++) {
          var hyMm = round3(inToMm(hLines[hiLine].y));
          var startX = Math.abs(curX - qx0Mm) <= Math.abs(curX - qx1Mm) ? qx0Mm : qx1Mm;
          var endX = startX === qx0Mm ? qx1Mm : qx0Mm;
          var slotLenX = Math.abs(endX - startX);

          var hMeta = {
            opType: 'horizontal',
            quadrantId: gq.id,
            label:
              'Op 3/3 · ' + gq.shortLabel + ' Horizontal ' + (hiLine + 1) + '/' + hLines.length
          };

          rapidZ(safeZ, hMeta);
          rapidXY(startX, hyMm, hMeta);
          rapidZ(plungeClearanceZ, hMeta);

          if (useRamp) {
            plungeZ(0, hMeta);
          }

          var atX = startX;
          var otherX = endX;
          var prevDepthH = 0;

          for (var hpi = 0; hpi < channelPasses.length; hpi++) {
            var hDepth = channelPasses[hpi];
            var hPassMeta = {
              opType: 'horizontal',
              quadrantId: gq.id,
              label:
                'Op 3/3 · ' +
                gq.shortLabel +
                ' Horizontal ' +
                (hiLine + 1) +
                '/' +
                hLines.length +
                ' (Pass ' +
                (hpi + 1) +
                '/' +
                channelPasses.length +
                ')',
              passIndex: hpi + 1,
              totalPasses: channelPasses.length
            };

            if (!useRamp) {
              plungeZ(-hDepth, hPassMeta);
              cutLine(otherX, hyMm, true, hPassMeta);
            } else {
              var dzH = hDepth - prevDepthH;
              var dirX = otherX > atX ? 1 : -1;
              var rampDistX = Math.min(dzH / Math.tan(rampAngleRad), slotLenX * 0.45);
              var rampX = round3(atX + dirX * rampDistX);
              var flatExtraX = Math.min(2.0, Math.max(0, slotLenX * 0.48 - rampDistX));
              var flatX = round3(atX + dirX * (rampDistX + flatExtraX));

              // 1. Ramp down at rampAngleDeg
              rampMove(rampX, hyMm, -hDepth, rampFeed, hPassMeta);
              // 2. Cut slightly further at full depth
              if (Math.abs(flatX - rampX) >= 0.01) {
                cutLine(flatX, hyMm, true, hPassMeta);
              }
              // 3. Reverse once at full depth to clear the ramp wedge
              cutLine(atX, hyMm, true, hPassMeta);
              // 4. Reverse again and finish the full cut
              cutLine(otherX, hyMm, false, hPassMeta);
            }

            var tmpX = atX;
            atX = otherX;
            otherX = tmpX;
            prevDepthH = hDepth;
          }

          rapidZ(safeZ, hMeta);
        }
      }

      // 3c. Flange Recess Pad Clearing (clear removed pads within radius around inlet)
      if (gq.removedPadCount > 0 && gq.pads && gq.pads.length > 0) {
        pushComment(gq.shortLabel + ' Flange Pad Recess Clearing (' + gq.removedPadCount + ' pads)');
        var nCols = p.verticalLines + 1;
        var nRows = p.horizontalLines + 1;
        var clearRuns = [];

        for (var r = 0; r < nRows; r++) {
          var c = 0;
          while (c < nCols) {
            var pad = gq.pads[r * nCols + c];
            if (!pad || !pad.removed) {
              c++;
              continue;
            }
            var cStart = c;
            while (c + 1 < nCols && gq.pads[r * nCols + c + 1].removed) {
              c++;
            }
            var firstPad = gq.pads[r * nCols + cStart];
            var lastPad = gq.pads[r * nCols + c];
            if (lastPad.slotX1 > firstPad.slotX0 && firstPad.py1 > firstPad.py0) {
              clearRuns.push({
                xStartMm: round3(inToMm(firstPad.slotX0)),
                xEndMm: round3(inToMm(lastPad.slotX1)),
                py0: firstPad.py0,
                py1: firstPad.py1
              });
            }
            c++;
          }
        }

        // Order runs closer to current Y first
        if (clearRuns.length > 1) {
          var firstRunY = round3(inToMm((clearRuns[0].py0 + clearRuns[0].py1) / 2));
          var lastRunY = round3(
            inToMm((clearRuns[clearRuns.length - 1].py0 + clearRuns[clearRuns.length - 1].py1) / 2)
          );
          if (Math.abs(curY - lastRunY) < Math.abs(curY - firstRunY)) {
            clearRuns.reverse();
          }
        }

        var toolRadiusIn = p.toolDiameter / 2;
        var stepMaxIn = p.toolDiameter * 0.65;

        for (var ri = 0; ri < clearRuns.length; ri++) {
          var run = clearRuns[ri];
          var padH = run.py1 - run.py0;
          var yPositionsIn = [];
          if (padH <= p.toolDiameter) {
            yPositionsIn.push((run.py0 + run.py1) / 2);
          } else {
            var yA = run.py0 + toolRadiusIn * 0.85;
            var yB = run.py1 - toolRadiusIn * 0.85;
            var nSteps = Math.max(1, Math.ceil((yB - yA) / stepMaxIn));
            for (var si = 0; si <= nSteps; si++) {
              yPositionsIn.push(yA + (si / nSteps) * (yB - yA));
            }
          }

          if (yPositionsIn.length > 1) {
            var yFirstMm = round3(inToMm(yPositionsIn[0]));
            var yLastMm = round3(inToMm(yPositionsIn[yPositionsIn.length - 1]));
            if (Math.abs(curY - yLastMm) < Math.abs(curY - yFirstMm)) {
              yPositionsIn.reverse();
            }
          }

          for (var yi = 0; yi < yPositionsIn.length; yi++) {
            var cyPassMm = round3(inToMm(yPositionsIn[yi]));
            var cStartX =
              Math.abs(curX - run.xStartMm) <= Math.abs(curX - run.xEndMm)
                ? run.xStartMm
                : run.xEndMm;
            var cEndX = cStartX === run.xStartMm ? run.xEndMm : run.xStartMm;

            var fMeta = {
              opType: 'flange',
              quadrantId: gq.id,
              label: 'Op 3/3 · ' + gq.shortLabel + ' Flange Recess'
            };

            rapidZ(safeZ, fMeta);
            rapidXY(cStartX, cyPassMm, fMeta);
            rapidZ(plungeClearanceZ, fMeta);

            var fAtX = cStartX;
            var fOtherX = cEndX;
            for (var fpi = 0; fpi < channelPasses.length; fpi++) {
              var fDepth = channelPasses[fpi];
              var fPassMeta = {
                opType: 'flange',
                quadrantId: gq.id,
                label:
                  'Op 3/3 · ' +
                  gq.shortLabel +
                  ' Flange Recess (Pass ' +
                  (fpi + 1) +
                  '/' +
                  channelPasses.length +
                  ')',
                passIndex: fpi + 1,
                totalPasses: channelPasses.length
              };
              plungeZ(-fDepth, fPassMeta);
              cutLine(fOtherX, cyPassMm, true, fPassMeta);
              var tmpFX = fAtX;
              fAtX = fOtherX;
              fOtherX = tmpFX;
            }

            rapidZ(safeZ, fMeta);
          }
        }
      }
    }

    // Footer
    pushSection('footer', 'Footer');
    pushComment('=== PROGRAM END ===');
    rapidZ(safeZ, { opType: 'footer', quadrantId: null, label: 'Retract' });
    lines.push('M5');
    rapidXY(0, 0, { opType: 'footer', quadrantId: null, label: 'Return to Origin' });
    lines.push('M30');

    var cutMinutes = cutDistanceMm / feedRate;
    var plungeMinutes = plungeDistanceMm / plungeRate;
    var rapidMinutes = rapidDistanceMm / assumedRapidMmPerMin;
    var estimatedMinutes = cutMinutes + plungeMinutes + rapidMinutes;

    return {
      lines: lines,
      gcode: lines.join('\n') + '\n',
      segments: segments,
      sections: sections,
      stats: {
        lineCount: lines.length,
        segmentCount: segments.length,
        channelDepthMm: channelDepthMm,
        throughDepthMm: throughDepthMm,
        channelPasses: channelPasses.length,
        inletPasses: inletPasses.length,
        cutDistanceMm: round3(cutDistanceMm),
        plungeDistanceMm: round3(plungeDistanceMm),
        rapidDistanceMm: round3(rapidDistanceMm),
        estimatedMinutes: estimatedMinutes,
        estimatedTimeFormatted: formatDuration(estimatedMinutes)
      }
    };
  }

  function generateGrblGcode(layout, overrideParams) {
    return buildToolpathPlan(layout, overrideParams);
  }

  var GCode = {
    computePassDepths: computePassDepths,
    computePassDepthsFrom: computePassDepthsFrom,
    buildToolpathPlan: buildToolpathPlan,
    generateGrblGcode: generateGrblGcode,
    formatDuration: formatDuration
  };

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.GCode = GCode;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GCode;
  }
})(typeof window !== 'undefined' ? window : globalThis);
