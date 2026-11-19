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
    computeLayout: computeLayout
  };

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.Geometry = Geometry;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Geometry;
  }
})(typeof window !== 'undefined' ? window : globalThis);
