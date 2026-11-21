(function (global) {
  'use strict';

  var MM_PER_INCH = 25.4;

  var DEFAULT_PARAMS = {
    sheetWidth: 49,
    sheetLength: 97,
    sheetThickness: 0.75,
    outerMargin: 1.5,
    centerDivider: 1.5,
    linkDividerToMargin: true,
    squarePads: false,
    toolDiameter: 0.25,
    channelDepth: 0.375,
    verticalLines: 9,
    horizontalLines: 19,
    inletDiameter: 2.5,
    inletCutDepth: 0.77,
    inletTabs: false,
    flangeClearanceRadius: 1.5,
    flangePocketDepth: 0.5,
    pocketStepover: 3,
    inletOffsetFromCenterX: 12.25,
    inletFrontFromFront: 24.25,
    inletSpacingY: 48.5,
    rpm: 24000,
    feedRate: 3000,
    stepdown: 5,
    plungeRate: 1000,
    safeZ: 10,
    rampAngle: 30
  };

  function inToMm(inches) {
    return inches * MM_PER_INCH;
  }

  function mmToIn(mm) {
    return mm / MM_PER_INCH;
  }

  function round3(n) {
    var v = Math.round(n * 1000) / 1000;
    return v === 0 ? 0 : v;
  }

  function round4(n) {
    var v = Math.round(n * 10000) / 10000;
    return v === 0 ? 0 : v;
  }

  function normalizeParams(rawParams) {
    var src = rawParams || {};
    var p = {};
    var keys = Object.keys(DEFAULT_PARAMS);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var defVal = DEFAULT_PARAMS[k];
      if (typeof defVal === 'boolean') {
        p[k] = src[k] === undefined ? defVal : Boolean(src[k]);
      } else {
        var val = src[k] === undefined || src[k] === '' || src[k] === null ? defVal : Number(src[k]);
        p[k] = val;
      }
    }
    p.verticalLines = Number.isFinite(p.verticalLines) ? Math.max(0, Math.floor(p.verticalLines)) : 0;
    p.horizontalLines = Number.isFinite(p.horizontalLines) ? Math.max(0, Math.floor(p.horizontalLines)) : 0;
    p.divider = p.linkDividerToMargin ? p.outerMargin : p.centerDivider;
    return p;
  }

  function resolveDividers(p) {
    var baseDivider = p.linkDividerToMargin ? p.outerMargin : p.centerDivider;
    var dividerX = baseDivider;
    var dividerY = baseDivider;

    var cols = p.verticalLines + 1;
    var rows = p.horizontalLines + 1;
    var T = p.toolDiameter;
    var M = p.outerMargin;

    if (
      p.squarePads &&
      Number.isFinite(p.sheetWidth) &&
      Number.isFinite(p.sheetLength) &&
      Number.isFinite(baseDivider) &&
      Number.isFinite(T) &&
      Number.isFinite(M) &&
      T > 0 &&
      cols > 0 &&
      rows > 0
    ) {
      var padXBase = (p.sheetWidth / 2 - M - baseDivider / 2 - T) / cols - T;
      var padYBase = (p.sheetLength / 2 - M - baseDivider / 2 - T) / rows - T;

      if (padXBase > 0 && padYBase > 0) {
        if (padXBase < padYBase) {
          var Sx = padXBase;
          dividerY = p.sheetLength - 2 * M - 2 * T - 2 * rows * (Sx + T);
        } else if (padYBase < padXBase) {
          var Sy = padYBase;
          dividerX = p.sheetWidth - 2 * M - 2 * T - 2 * cols * (Sy + T);
        }
      }
    }

    return {
      baseDivider: baseDivider,
      dividerX: dividerX,
      dividerY: dividerY
    };
  }

  function computeCenteredInlets(rawParams) {
    var p = normalizeParams(rawParams);
    var midX = p.sheetWidth / 2;
    var midY = p.sheetLength / 2;
    var divs = resolveDividers(p);

    var flCutX0 = p.outerMargin;
    var flCutX1 = midX - divs.dividerX / 2;
    var flCutY0 = p.outerMargin;
    var flCutY1 = midY - divs.dividerY / 2;

    var centerX = (flCutX0 + flCutX1) / 2;
    var centerY = (flCutY0 + flCutY1) / 2;

    var offsetFromCenterX = round4(midX - centerX);
    var frontFromFront = round4(centerY);
    var backFromFront = round4(p.sheetLength - centerY);
    var spacingY = round4(backFromFront - frontFromFront);

    return {
      inletOffsetFromCenterX: offsetFromCenterX,
      inletFrontFromFront: frontFromFront,
      inletSpacingY: spacingY
    };
  }

  function mergeSlabs(slabs) {
    if (!slabs || slabs.length === 0) return [];
    var eps = 1e-7;
    var out = [];
    for (var i = 0; i < slabs.length; i++) {
      var s = slabs[i];
      if (s.y1 <= s.y0 + eps || s.x1 <= s.x0 + eps) continue;
      if (out.length > 0) {
        var prev = out[out.length - 1];
        if (
          Math.abs(prev.y1 - s.y0) < eps &&
          Math.abs(prev.x0 - s.x0) < eps &&
          Math.abs(prev.x1 - s.x1) < eps
        ) {
          prev.y1 = s.y1;
          continue;
        }
      }
      out.push({ y0: s.y0, y1: s.y1, x0: s.x0, x1: s.x1 });
    }
    return out;
  }

  function slabsToPolygon(slabs) {
    if (!slabs || slabs.length === 0) return [];
    var eps = 1e-7;
    var pts = [];

    // Bottom edge left -> right, then walk up right boundary
    pts.push({ x: slabs[0].x0, y: slabs[0].y0 });
    pts.push({ x: slabs[0].x1, y: slabs[0].y0 });
    pts.push({ x: slabs[0].x1, y: slabs[0].y1 });

    for (var i = 1; i < slabs.length; i++) {
      if (Math.abs(slabs[i].x1 - slabs[i - 1].x1) > eps) {
        pts.push({ x: slabs[i].x1, y: slabs[i].y0 });
      }
      pts.push({ x: slabs[i].x1, y: slabs[i].y1 });
    }

    // Top edge right -> left, then walk down left boundary
    var last = slabs[slabs.length - 1];
    pts.push({ x: last.x0, y: last.y1 });
    pts.push({ x: last.x0, y: last.y0 });

    for (var j = slabs.length - 2; j >= 0; j--) {
      if (Math.abs(slabs[j].x0 - slabs[j + 1].x0) > eps) {
        pts.push({ x: slabs[j].x0, y: slabs[j + 1].y0 });
      }
      pts.push({ x: slabs[j].x0, y: slabs[j].y0 });
    }

    // Deduplicate consecutive identical points
    var dedup = [];
    for (var k = 0; k < pts.length; k++) {
      var p = pts[k];
      if (
        dedup.length === 0 ||
        Math.hypot(p.x - dedup[dedup.length - 1].x, p.y - dedup[dedup.length - 1].y) > eps
      ) {
        dedup.push(p);
      }
    }
    if (
      dedup.length > 1 &&
      Math.hypot(dedup[0].x - dedup[dedup.length - 1].x, dedup[0].y - dedup[dedup.length - 1].y) <= eps
    ) {
      dedup.pop();
    }

    // Remove strictly collinear intermediate vertices (cyclic)
    var changed = true;
    while (changed && dedup.length > 3) {
      changed = false;
      var next = [];
      for (var m = 0; m < dedup.length; m++) {
        var prev = dedup[(m - 1 + dedup.length) % dedup.length];
        var cur = dedup[m];
        var nxt = dedup[(m + 1) % dedup.length];
        var sameX = Math.abs(prev.x - cur.x) <= eps && Math.abs(cur.x - nxt.x) <= eps;
        var sameY = Math.abs(prev.y - cur.y) <= eps && Math.abs(cur.y - nxt.y) <= eps;
        if (sameX || sameY) {
          changed = true;
        } else {
          next.push(cur);
        }
      }
      dedup = next;
    }

    return dedup;
  }

  function unionBoxesToSlabs(boxes) {
    if (!boxes || boxes.length === 0) return [];
    var eps = 1e-7;
    var ys = [];
    for (var i = 0; i < boxes.length; i++) {
      ys.push(boxes[i].y0, boxes[i].y1);
    }
    ys.sort(function (a, b) {
      return a - b;
    });
    var uniqY = [];
    for (var yi = 0; yi < ys.length; yi++) {
      if (uniqY.length === 0 || ys[yi] - uniqY[uniqY.length - 1] > eps) {
        uniqY.push(ys[yi]);
      }
    }

    var raw = [];
    for (var s = 0; s < uniqY.length - 1; s++) {
      var ya = uniqY[s];
      var yb = uniqY[s + 1];
      var ym = (ya + yb) * 0.5;
      var minX = Infinity;
      var maxX = -Infinity;
      for (var bi = 0; bi < boxes.length; bi++) {
        var b = boxes[bi];
        if (b.y0 <= ym + eps && b.y1 >= ym - eps) {
          if (b.x0 < minX) minX = b.x0;
          if (b.x1 > maxX) maxX = b.x1;
        }
      }
      if (maxX > minX + eps) {
        raw.push({ y0: ya, y1: yb, x0: minX, x1: maxX });
      }
    }
    return mergeSlabs(raw);
  }

  function erodeSlabs(slabs, dist) {
    if (!slabs || slabs.length === 0) return [];
    var eps = 1e-7;
    if (dist <= eps) {
      return slabs.map(function (s) {
        return { y0: s.y0, y1: s.y1, x0: s.x0, x1: s.x1 };
      });
    }

    var yMin = slabs[0].y0;
    var yMax = slabs[slabs.length - 1].y1;
    var validY0 = yMin + dist;
    var validY1 = yMax - dist;
    if (validY1 <= validY0 + eps) return [];

    var yCands = [validY0, validY1];
    for (var i = 0; i < slabs.length; i++) {
      var candA = slabs[i].y0 - dist;
      var candB = slabs[i].y0 + dist;
      var candC = slabs[i].y1 - dist;
      var candD = slabs[i].y1 + dist;
      if (candA > validY0 + eps && candA < validY1 - eps) yCands.push(candA);
      if (candB > validY0 + eps && candB < validY1 - eps) yCands.push(candB);
      if (candC > validY0 + eps && candC < validY1 - eps) yCands.push(candC);
      if (candD > validY0 + eps && candD < validY1 - eps) yCands.push(candD);
    }

    yCands.sort(function (a, b) {
      return a - b;
    });
    var uniqY = [];
    for (var ui = 0; ui < yCands.length; ui++) {
      if (uniqY.length === 0 || yCands[ui] - uniqY[uniqY.length - 1] > eps) {
        uniqY.push(yCands[ui]);
      }
    }

    var eroded = [];
    for (var si = 0; si < uniqY.length - 1; si++) {
      var ya = uniqY[si];
      var yb = uniqY[si + 1];
      var ym = (ya + yb) * 0.5;
      var winLo = ym - dist;
      var winHi = ym + dist;

      var ix0 = -Infinity;
      var ix1 = Infinity;
      var covered = true;

      for (var k = 0; k < slabs.length; k++) {
        var sl = slabs[k];
        if (sl.y1 > winLo + eps && sl.y0 < winHi - eps) {
          var cx0 = sl.x0 + dist;
          var cx1 = sl.x1 - dist;
          if (cx0 > ix0) ix0 = cx0;
          if (cx1 < ix1) ix1 = cx1;
        }
      }
      if (!Number.isFinite(ix0) || !Number.isFinite(ix1) || ix1 <= ix0 + eps) {
        covered = false;
      }
      if (covered) {
        eroded.push({ y0: ya, y1: yb, x0: ix0, x1: ix1 });
      }
    }

    return mergeSlabs(eroded);
  }

  function computeFlangePocket(pads, nCols, nRows, qd, toolRadius, pocketDepth) {
    if (!pads || pads.length === 0) return null;
    var rowSlabs = [];
    for (var r = 0; r < nRows; r++) {
      var colMin = Infinity;
      var colMax = -Infinity;
      for (var c = 0; c < nCols; c++) {
        var pad = pads[r * nCols + c];
        if (pad && pad.removed) {
          if (c < colMin) colMin = c;
          if (c > colMax) colMax = c;
        }
      }
      if (colMax >= colMin) {
        var pFirst = pads[r * nCols + colMin];
        var pLast = pads[r * nCols + colMax];
        rowSlabs.push({
          y0: pFirst.slotY0,
          y1: pFirst.slotY1,
          x0: pFirst.slotX0,
          x1: pLast.slotX1
        });
      }
    }

    var centerSlabs = mergeSlabs(rowSlabs);
    if (centerSlabs.length === 0) return null;

    var physBoxes = centerSlabs.map(function (s) {
      return {
        x0: Math.max(qd.cutX0, s.x0 - toolRadius),
        x1: Math.min(qd.cutX1, s.x1 + toolRadius),
        y0: Math.max(qd.cutY0, s.y0 - toolRadius),
        y1: Math.min(qd.cutY1, s.y1 + toolRadius)
      };
    });
    var physSlabs = unionBoxesToSlabs(physBoxes);

    return {
      centerSlabs: centerSlabs,
      physSlabs: physSlabs,
      centerPoly: slabsToPolygon(centerSlabs),
      physPoly: slabsToPolygon(physSlabs),
      depth: pocketDepth
    };
  }

  function computeLayout(rawParams) {
    var p = normalizeParams(rawParams);
    var errors = [];
    var warnings = [];

    if (!Number.isFinite(p.sheetWidth) || p.sheetWidth <= 0) {
      errors.push('Sheet width must be greater than 0.');
    }
    if (!Number.isFinite(p.sheetLength) || p.sheetLength <= 0) {
      errors.push('Sheet length must be greater than 0.');
    }
    if (!Number.isFinite(p.sheetThickness) || p.sheetThickness <= 0) {
      errors.push('Sheet thickness must be greater than 0.');
    }
    if (!Number.isFinite(p.outerMargin) || p.outerMargin < 0) {
      errors.push('Outer margin must be 0 or greater.');
    }
    if (!Number.isFinite(p.divider) || p.divider < 0) {
      errors.push('Zone divider must be 0 or greater.');
    }
    if (!Number.isFinite(p.toolDiameter) || p.toolDiameter <= 0) {
      errors.push('End mill diameter must be greater than 0.');
    }
    if (!Number.isFinite(p.channelDepth) || p.channelDepth <= 0) {
      errors.push('Channel depth must be greater than 0.');
    } else if (Number.isFinite(p.sheetThickness) && p.channelDepth >= p.sheetThickness) {
      errors.push('Channel depth must be less than sheet thickness so channels do not cut through.');
    }
    if (!Number.isFinite(p.inletDiameter) || p.inletDiameter <= 0) {
      errors.push('Inlet hole diameter must be greater than 0.');
    } else if (Number.isFinite(p.toolDiameter) && p.inletDiameter <= p.toolDiameter) {
      errors.push('Inlet hole diameter must be larger than the end mill diameter.');
    }
    if (!Number.isFinite(p.inletCutDepth) || p.inletCutDepth <= 0) {
      errors.push('Inlet cut-through depth must be greater than 0.');
    }
    if (!Number.isFinite(p.flangeClearanceRadius) || p.flangeClearanceRadius < 0) {
      errors.push('Flange pad removal radius must be 0 or greater.');
    }
    if (!Number.isFinite(p.flangePocketDepth) || p.flangePocketDepth <= 0) {
      errors.push('Flange pocket depth must be greater than 0.');
    } else if (Number.isFinite(p.sheetThickness) && p.flangePocketDepth >= p.sheetThickness) {
      errors.push('Flange pocket depth must be less than sheet thickness.');
    }
    if (!Number.isFinite(p.pocketStepover) || p.pocketStepover <= 0) {
      errors.push('Pocket stepover must be greater than 0 mm.');
    } else if (Number.isFinite(p.toolDiameter) && p.pocketStepover >= inToMm(p.toolDiameter)) {
      errors.push('Pocket stepover must be smaller than the end mill diameter.');
    }

    if (!Number.isFinite(p.rpm) || p.rpm <= 0) {
      errors.push('Spindle RPM must be greater than 0.');
    }
    if (!Number.isFinite(p.feedRate) || p.feedRate <= 0) {
      errors.push('Feed rate must be greater than 0 mm/min.');
    }
    if (!Number.isFinite(p.stepdown) || p.stepdown <= 0) {
      errors.push('Stepdown per pass must be greater than 0 mm.');
    }
    if (!Number.isFinite(p.plungeRate) || p.plungeRate <= 0) {
      errors.push('Plunge rate must be greater than 0 mm/min.');
    }
    if (!Number.isFinite(p.safeZ) || p.safeZ <= 0) {
      errors.push('Safe Z retract height must be greater than 0 mm.');
    }
    if (!Number.isFinite(p.rampAngle) || p.rampAngle < 5 || p.rampAngle > 90) {
      errors.push('Grid ramp angle must be between 5° and 90°.');
    }

    if (
      Number.isFinite(p.channelDepth) &&
      Number.isFinite(p.sheetThickness) &&
      p.channelDepth < p.sheetThickness &&
      p.channelDepth > p.sheetThickness - 0.125
    ) {
      warnings.push(
        'Channel depth leaves less than 0.125" (' +
          round3(inToMm(p.sheetThickness - p.channelDepth)) +
          ' mm) of remaining MDF floor.'
      );
    }

    if (
      Number.isFinite(p.flangePocketDepth) &&
      Number.isFinite(p.sheetThickness) &&
      p.flangePocketDepth < p.sheetThickness &&
      p.flangePocketDepth > p.sheetThickness - 0.125
    ) {
      warnings.push(
        'Flange pocket depth leaves less than 0.125" (' +
          round3(inToMm(p.sheetThickness - p.flangePocketDepth)) +
          ' mm) of remaining MDF floor.'
      );
    }

    if (
      Number.isFinite(p.pocketStepover) &&
      Number.isFinite(p.toolDiameter) &&
      p.pocketStepover < inToMm(p.toolDiameter) &&
      p.pocketStepover > inToMm(p.toolDiameter) * 0.72
    ) {
      warnings.push(
        'Pocket stepover (' +
          round3(p.pocketStepover) +
          ' mm) exceeds 70% of bit width and may leave corner ridges.'
      );
    }

    if (
      Number.isFinite(p.inletCutDepth) &&
      Number.isFinite(p.sheetThickness) &&
      p.inletCutDepth > 0 &&
      p.inletCutDepth < p.sheetThickness
    ) {
      warnings.push(
        'Inlet cut-through depth (' +
          round3(p.inletCutDepth) +
          '") is less than sheet thickness (' +
          round3(p.sheetThickness) +
          '"); holes will not cut completely through.'
      );
    }

    var midX = p.sheetWidth / 2;
    var midY = p.sheetLength / 2;
    var toolRadius = p.toolDiameter / 2;
    var divs = resolveDividers(p);
    var dividerX = divs.dividerX;
    var dividerY = divs.dividerY;

    var quadrantDefs = [
      {
        id: 'FL',
        index: 1,
        label: 'Front-Left',
        shortLabel: 'Q1 · FL',
        cutX0: p.outerMargin,
        cutX1: midX - dividerX / 2,
        cutY0: p.outerMargin,
        cutY1: midY - dividerY / 2
      },
      {
        id: 'FR',
        index: 2,
        label: 'Front-Right',
        shortLabel: 'Q2 · FR',
        cutX0: midX + dividerX / 2,
        cutX1: p.sheetWidth - p.outerMargin,
        cutY0: p.outerMargin,
        cutY1: midY - dividerY / 2
      },
      {
        id: 'BR',
        index: 3,
        label: 'Back-Right',
        shortLabel: 'Q3 · BR',
        cutX0: midX + dividerX / 2,
        cutX1: p.sheetWidth - p.outerMargin,
        cutY0: midY + dividerY / 2,
        cutY1: p.sheetLength - p.outerMargin
      },
      {
        id: 'BL',
        index: 4,
        label: 'Back-Left',
        shortLabel: 'Q4 · BL',
        cutX0: p.outerMargin,
        cutX1: midX - dividerX / 2,
        cutY0: midY + dividerY / 2,
        cutY1: p.sheetLength - p.outerMargin
      }
    ];

    var xLeft = midX - p.inletOffsetFromCenterX;
    var xRight = midX + p.inletOffsetFromCenterX;
    var yFront = p.inletFrontFromFront;
    var yBack = p.inletFrontFromFront + p.inletSpacingY;
    var holeRadius = p.inletDiameter / 2;

    var holeCoordsByQuad = {
      FL: { cx: xLeft, cy: yFront },
      FR: { cx: xRight, cy: yFront },
      BR: { cx: xRight, cy: yBack },
      BL: { cx: xLeft, cy: yBack }
    };

    var nV = p.verticalLines;
    var nH = p.horizontalLines;
    var quadrants = [];
    var invalidQuadAdded = false;
    var sliverWarnAdded = false;
    var totalRemovedPads = 0;

    for (var qi = 0; qi < quadrantDefs.length; qi++) {
      var qd = quadrantDefs[qi];
      var x0 = qd.cutX0 + toolRadius;
      var x1 = qd.cutX1 - toolRadius;
      var y0 = qd.cutY0 + toolRadius;
      var y1 = qd.cutY1 - toolRadius;
      var centerWidth = x1 - x0;
      var centerHeight = y1 - y0;
      var cutWidth = qd.cutX1 - qd.cutX0;
      var cutHeight = qd.cutY1 - qd.cutY0;

      if ((centerWidth <= 0 || centerHeight <= 0) && !invalidQuadAdded) {
        errors.push('Margins and tool diameter leave no positive cut area inside quadrants.');
        invalidQuadAdded = true;
      }

      var xs = [x0];
      var verticalLines = [];
      for (var iv = 1; iv <= nV; iv++) {
        var vx = x0 + (iv / (nV + 1)) * centerWidth;
        xs.push(vx);
        verticalLines.push({
          index: iv,
          x: vx,
          y0: y0,
          y1: y1
        });
      }
      xs.push(x1);

      var ys = [y0];
      var horizontalLines = [];
      for (var ih = 1; ih <= nH; ih++) {
        var hy = y0 + (ih / (nH + 1)) * centerHeight;
        ys.push(hy);
        horizontalLines.push({
          index: ih,
          y: hy,
          x0: x0,
          x1: x1
        });
      }
      ys.push(y1);

      var pitchX = centerWidth / (nV + 1);
      var pitchY = centerHeight / (nH + 1);
      var padX = pitchX - p.toolDiameter;
      var padY = pitchY - p.toolDiameter;

      if (!sliverWarnAdded && centerWidth > 0 && centerHeight > 0 && (padX <= 0.1 || padY <= 0.1)) {
        warnings.push(
          'Dense grid lines leave narrow MDF support pads (' +
            round3(padX) +
            '" × ' +
            round3(padY) +
            '"). Consider fewer grid lines.'
        );
        sliverWarnAdded = true;
      }

      var hCoord = holeCoordsByQuad[qd.id];
      var outOfSheet =
        !Number.isFinite(hCoord.cx) ||
        !Number.isFinite(hCoord.cy) ||
        hCoord.cx - holeRadius < 0 ||
        hCoord.cx + holeRadius > p.sheetWidth ||
        hCoord.cy - holeRadius < 0 ||
        hCoord.cy + holeRadius > p.sheetLength;

      var outOfQuad =
        outOfSheet ||
        hCoord.cx - holeRadius < qd.cutX0 ||
        hCoord.cx + holeRadius > qd.cutX1 ||
        hCoord.cy - holeRadius < qd.cutY0 ||
        hCoord.cy + holeRadius > qd.cutY1;

      if (outOfQuad) {
        warnings.push(
          qd.shortLabel +
            ' inlet hole (' +
            round3(hCoord.cx) +
            '", ' +
            round3(hCoord.cy) +
            '") extends outside quadrant seal boundary.'
        );
      }

      // Build pad matrix and detect flange clearance removals
      var pads = [];
      var removedPadCount = 0;
      var clearLimit = holeRadius + p.flangeClearanceRadius;

      if (centerWidth > 0 && centerHeight > 0) {
        for (var row = 0; row <= nH; row++) {
          var sy0 = ys[row];
          var sy1 = ys[row + 1];
          var py0 = sy0 + toolRadius;
          var py1 = sy1 - toolRadius;
          for (var col = 0; col <= nV; col++) {
            var sx0 = xs[col];
            var sx1 = xs[col + 1];
            var px0 = sx0 + toolRadius;
            var px1 = sx1 - toolRadius;

            var nearX = px1 > px0 ? Math.max(px0, Math.min(hCoord.cx, px1)) : (sx0 + sx1) / 2;
            var nearY = py1 > py0 ? Math.max(py0, Math.min(hCoord.cy, py1)) : (sy0 + sy1) / 2;
            var dist = Math.hypot(hCoord.cx - nearX, hCoord.cy - nearY);

            var overlapsHole = dist < holeRadius;
            var removed = p.flangeClearanceRadius > 0 && dist <= clearLimit;
            if (removed) {
              removedPadCount++;
              totalRemovedPads++;
            }

            pads.push({
              row: row,
              col: col,
              px0: px0,
              px1: px1,
              py0: py0,
              py1: py1,
              slotX0: sx0,
              slotX1: sx1,
              slotY0: sy0,
              slotY1: sy1,
              overlapsHole: overlapsHole,
              removed: removed
            });
          }
        }
      }

      var flangePocket =
        removedPadCount > 0
          ? computeFlangePocket(pads, nV + 1, nH + 1, qd, toolRadius, p.flangePocketDepth)
          : null;

      quadrants.push({
        id: qd.id,
        index: qd.index,
        label: qd.label,
        shortLabel: qd.shortLabel,
        cutX0: qd.cutX0,
        cutX1: qd.cutX1,
        cutY0: qd.cutY0,
        cutY1: qd.cutY1,
        cutWidth: cutWidth,
        cutHeight: cutHeight,
        x0: x0,
        x1: x1,
        y0: y0,
        y1: y1,
        centerWidth: centerWidth,
        centerHeight: centerHeight,
        pitchX: pitchX,
        pitchY: pitchY,
        padX: padX,
        padY: padY,
        verticalLines: verticalLines,
        horizontalLines: horizontalLines,
        pads: pads,
        removedPadCount: removedPadCount,
        flangePocket: flangePocket,
        inlet: {
          quadrantId: qd.id,
          cx: hCoord.cx,
          cy: hCoord.cy,
          diameter: p.inletDiameter,
          radius: holeRadius,
          outOfSheet: outOfSheet,
          outOfBounds: outOfQuad
        }
      });
    }

    var inletDims = {
      xLeft: xLeft,
      xRight: xRight,
      yFront: yFront,
      yBack: yBack,
      betweenX: p.inletOffsetFromCenterX * 2,
      fromMiddleX: p.inletOffsetFromCenterX,
      betweenY: p.inletSpacingY,
      frontFromFront: yFront,
      backFromFront: yBack
    };

    return {
      params: p,
      sheetWidth: p.sheetWidth,
      sheetLength: p.sheetLength,
      sheetThickness: p.sheetThickness,
      outerMargin: p.outerMargin,
      centerDivider: divs.baseDivider,
      dividerX: dividerX,
      dividerY: dividerY,
      squarePadsActive: p.squarePads,
      midX: midX,
      midY: midY,
      toolDiameter: p.toolDiameter,
      toolRadius: toolRadius,
      quadrants: quadrants,
      inlets: quadrants.map(function (q) {
        return q.inlet;
      }),
      inletDims: inletDims,
      totalRemovedPads: totalRemovedPads,
      errors: errors,
      warnings: warnings,
      isValid: errors.length === 0
    };
  }

  var Geometry = {
    MM_PER_INCH: MM_PER_INCH,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    inToMm: inToMm,
    mmToIn: mmToIn,
    round3: round3,
    round4: round4,
    normalizeParams: normalizeParams,
    computeCenteredInlets: computeCenteredInlets,
    mergeSlabs: mergeSlabs,
    slabsToPolygon: slabsToPolygon,
    unionBoxesToSlabs: unionBoxesToSlabs,
    erodeSlabs: erodeSlabs,
    computeFlangePocket: computeFlangePocket,
    computeLayout: computeLayout
  };

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.Geometry = Geometry;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Geometry;
  }
})(typeof window !== 'undefined' ? window : globalThis);
