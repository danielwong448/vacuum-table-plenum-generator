(function (global) {
  'use strict';

  var Geometry =
    global.PlenumApp && global.PlenumApp.Geometry
      ? global.PlenumApp.Geometry
      : typeof require === 'function'
      ? require('./geometry.js')
      : null;

  if (!Geometry) {
    throw new Error('PlenumApp.Geometry must be loaded before step.js');
  }

  var inToMm = Geometry.inToMm;
  var round3 = Geometry.round3;

  function fmt(n) {
    var v = round3(n);
    var s = (v === 0 ? 0 : v).toFixed(3);
    // Keep clean STEP reals (trailing decimal required or digits)
    return s;
  }

  function uniqSorted(vals, tol) {
    var sorted = vals.slice().sort(function (a, b) {
      return a - b;
    });
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      if (out.length === 0 || sorted[i] - out[out.length - 1] > tol) {
        out.push(sorted[i]);
      }
    }
    return out;
  }

  function pointInRect(x, y, x0, y0, x1, y1, eps) {
    return x >= x0 - eps && x <= x1 + eps && y >= y0 - eps && y <= y1 + eps;
  }

  function pointInSlabs(x, y, slabs, eps) {
    for (var i = 0; i < slabs.length; i++) {
      var s = slabs[i];
      if (y >= s.y0 - eps && y <= s.y1 + eps && x >= s.x0 - eps && x <= s.x1 + eps) {
        return true;
      }
    }
    return false;
  }

  function generateStep(layout) {
    var p = layout.params;
    var W = round3(inToMm(layout.sheetWidth));
    var L = round3(inToMm(layout.sheetLength));
    var Z_bot = round3(-inToMm(layout.sheetThickness));
    var Z_chan = round3(-inToMm(Math.min(p.channelDepth, layout.sheetThickness - 0.005)));
    var Z_pocket = round3(-inToMm(Math.min(p.flangePocketDepth, layout.sheetThickness - 0.005)));

    // 1. Collect grid breakpoints in exact rounded mm
    var xCoords = [0, W];
    var yCoords = [0, L];
    var quadData = [];

    for (var qi = 0; qi < layout.quadrants.length; qi++) {
      var q = layout.quadrants[qi];
      var qCutX0 = round3(inToMm(q.cutX0));
      var qCutX1 = round3(inToMm(q.cutX1));
      var qCutY0 = round3(inToMm(q.cutY0));
      var qCutY1 = round3(inToMm(q.cutY1));
      xCoords.push(qCutX0, qCutX1);
      yCoords.push(qCutY0, qCutY1);

      var pocketSlabsMm = [];
      if (q.flangePocket && q.flangePocket.physSlabs) {
        for (var si = 0; si < q.flangePocket.physSlabs.length; si++) {
          var sl = q.flangePocket.physSlabs[si];
          var sx0 = round3(inToMm(sl.x0));
          var sx1 = round3(inToMm(sl.x1));
          var sy0 = round3(inToMm(sl.y0));
          var sy1 = round3(inToMm(sl.y1));
          xCoords.push(sx0, sx1);
          yCoords.push(sy0, sy1);
          pocketSlabsMm.push({ x0: sx0, x1: sx1, y0: sy0, y1: sy1 });
        }
      }

      var keptPadsMm = [];
      var shallowPadsMm = [];
      if (q.pads) {
        for (var pi = 0; pi < q.pads.length; pi++) {
          var pad = q.pads[pi];
          if (pad.overlapsHole) continue;
          var px0 = round3(inToMm(pad.px0));
          var px1 = round3(inToMm(pad.px1));
          var py0 = round3(inToMm(pad.py0));
          var py1 = round3(inToMm(pad.py1));
          if (px1 <= px0 + 0.02 || py1 <= py0 + 0.02) continue;

          if (!pad.removed) {
            xCoords.push(px0, px1);
            yCoords.push(py0, py1);
            keptPadsMm.push({ x0: px0, x1: px1, y0: py0, y1: py1 });
          } else if (Z_pocket > Z_chan + 0.005) {
            // Shallow flange pocket leaves removed pads at Z_pocket above channel floor Z_chan
            xCoords.push(px0, px1);
            yCoords.push(py0, py1);
            shallowPadsMm.push({ x0: px0, x1: px1, y0: py0, y1: py1 });
          }
        }
      }

      quadData.push({
        q: q,
        cutX0: qCutX0,
        cutX1: qCutX1,
        cutY0: qCutY0,
        cutY1: qCutY1,
        pocketSlabs: pocketSlabsMm,
        keptPads: keptPadsMm,
        shallowPads: shallowPadsMm,
        hole: {
          cx: round3(inToMm(q.inlet.cx)),
          cy: round3(inToMm(q.inlet.cy)),
          r: round3(inToMm(q.inlet.radius)),
          valid: !q.inlet.outOfBounds
        }
      });
    }

    var GX = uniqSorted(xCoords, 0.005);
    var GY = uniqSorted(yCoords, 0.005);
    var nx = GX.length - 1;
    var ny = GY.length - 1;

    // 2. Build cell height matrix H[iy][ix]
    var H = [];
    for (var iy = 0; iy < ny; iy++) {
      var rowH = [];
      var cy = (GY[iy] + GY[iy + 1]) * 0.5;
      for (var ix = 0; ix < nx; ix++) {
        var cx = (GX[ix] + GX[ix + 1]) * 0.5;
        var cellZ = 0; // Margin / dividers are full height 0

        for (var qdi = 0; qdi < quadData.length; qdi++) {
          var qd = quadData[qdi];
          if (pointInRect(cx, cy, qd.cutX0, qd.cutY0, qd.cutX1, qd.cutY1, -1e-4)) {
            var isKept = false;
            for (var kpi = 0; kpi < qd.keptPads.length; kpi++) {
              var kp = qd.keptPads[kpi];
              if (pointInRect(cx, cy, kp.x0, kp.y0, kp.x1, kp.y1, -1e-4)) {
                isKept = true;
                break;
              }
            }
            if (isKept) {
              cellZ = 0;
            } else if (qd.pocketSlabs.length > 0 && pointInSlabs(cx, cy, qd.pocketSlabs, -1e-4)) {
              if (Z_pocket <= Z_chan + 0.005) {
                cellZ = Z_pocket;
              } else {
                var isShallow = false;
                for (var spi = 0; spi < qd.shallowPads.length; spi++) {
                  var sp = qd.shallowPads[spi];
                  if (pointInRect(cx, cy, sp.x0, sp.y0, sp.x1, sp.y1, -1e-4)) {
                    isShallow = true;
                    break;
                  }
                }
                cellZ = isShallow ? Z_pocket : Z_chan;
              }
            } else {
              cellZ = Z_chan;
            }
            break;
          }
        }
        rowH.push(cellZ);
      }
      H.push(rowH);
    }

    function cellHeight(ix, iy) {
      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) return Z_bot;
      return H[iy][ix];
    }

    // Check which holes sit cleanly inside a single flat floor region
    var validHoles = [];
    for (var hi = 0; hi < quadData.length; hi++) {
      var h = quadData[hi].hole;
      if (!h.valid || h.r <= 0.05) continue;
      var zExpected = null;
      var uniform = true;
      for (var hyi = 0; hyi < ny; hyi++) {
        if (GY[hyi + 1] < h.cy - h.r - 0.05 || GY[hyi] > h.cy + h.r + 0.05) continue;
        for (var hxi = 0; hxi < nx; hxi++) {
          if (GX[hxi + 1] < h.cx - h.r - 0.05 || GX[hxi] > h.cx + h.r + 0.05) continue;
          var nearX = Math.max(GX[hxi], Math.min(h.cx, GX[hxi + 1]));
          var nearY = Math.max(GY[hyi], Math.min(h.cy, GY[hyi + 1]));
          if (Math.hypot(h.cx - nearX, h.cy - nearY) <= h.r + 0.001) {
            var hz = H[hyi][hxi];
            if (zExpected === null) zExpected = hz;
            else if (Math.abs(hz - zExpected) > 0.005) uniform = false;
          }
        }
      }
      if (uniform && zExpected !== null && zExpected > Z_bot + 0.01) {
        validHoles.push({
          cx: h.cx,
          cy: h.cy,
          r: h.r,
          zTop: zExpected
        });
      }
    }

    // 3. STEP Entity Registry
    var entities = [];
    var nextId = 1;
    function addEntity(str) {
      var id = nextId++;
      entities.push('#' + id + '=' + str + ';');
      return id;
    }

    // Canonical directions
    var dirs = {
      px: addEntity("DIRECTION('',(1.,0.,0.))"),
      nx: addEntity("DIRECTION('',(-1.,0.,0.))"),
      py: addEntity("DIRECTION('',(0.,1.,0.))"),
      ny: addEntity("DIRECTION('',(0.,-1.,0.))"),
      pz: addEntity("DIRECTION('',(0.,0.,1.))"),
      nz: addEntity("DIRECTION('',(0.,0.,-1.))")
    };

    var pointMap = {};
    var vertexMap = {};
    var vectorMap = {};
    var lineEdgeMap = {};

    function getPoint(x, y, z) {
      var key = fmt(x) + ',' + fmt(y) + ',' + fmt(z);
      if (pointMap[key] !== undefined) return pointMap[key];
      var id = addEntity("CARTESIAN_POINT('',(" + fmt(x) + ',' + fmt(y) + ',' + fmt(z) + '))');
      pointMap[key] = id;
      return id;
    }

    function getVertex(x, y, z) {
      var key = fmt(x) + ',' + fmt(y) + ',' + fmt(z);
      if (vertexMap[key] !== undefined) return vertexMap[key];
      var ptId = getPoint(x, y, z);
      var id = addEntity("VERTEX_POINT('',#" + ptId + ')');
      vertexMap[key] = id;
      return id;
    }

    function getDir(dx, dy, dz) {
      var len = Math.hypot(dx, dy, dz) || 1;
      var ux = dx / len;
      var uy = dy / len;
      var uz = dz / len;
      if (Math.abs(ux - 1) < 1e-6) return dirs.px;
      if (Math.abs(ux + 1) < 1e-6) return dirs.nx;
      if (Math.abs(uy - 1) < 1e-6) return dirs.py;
      if (Math.abs(uy + 1) < 1e-6) return dirs.ny;
      if (Math.abs(uz - 1) < 1e-6) return dirs.pz;
      if (Math.abs(uz + 1) < 1e-6) return dirs.nz;
      return addEntity("DIRECTION('',(" + ux.toFixed(6) + ',' + uy.toFixed(6) + ',' + uz.toFixed(6) + '))');
    }

    function getLineEdgeOriented(p1, p2) {
      var v1 = getVertex(p1[0], p1[1], p1[2]);
      var v2 = getVertex(p2[0], p2[1], p2[2]);
      var forward = v1 < v2;
      var va = forward ? v1 : v2;
      var vb = forward ? v2 : v1;
      var key = va + '_' + vb;
      var edgeId = lineEdgeMap[key];
      if (edgeId === undefined) {
        var pa = forward ? p1 : p2;
        var pb = forward ? p2 : p1;
        var dx = pb[0] - pa[0];
        var dy = pb[1] - pa[1];
        var dz = pb[2] - pa[2];
        var dirId = getDir(dx, dy, dz);
        var vecKey = dirId;
        var vecId = vectorMap[vecKey];
        if (vecId === undefined) {
          vecId = addEntity("VECTOR('',#" + dirId + ',1.)');
          vectorMap[vecKey] = vecId;
        }
        var ptA = getPoint(pa[0], pa[1], pa[2]);
        var lineId = addEntity("LINE('',#" + ptA + ',#' + vecId + ')');
        edgeId = addEntity("EDGE_CURVE('',#" + va + ',#' + vb + ',#' + lineId + ',.T.)');
        lineEdgeMap[key] = edgeId;
      }
      return addEntity("ORIENTED_EDGE('',*,*,#" + edgeId + ',' + (forward ? '.T.' : '.F.') + ')');
    }

    function makeLoop(orientedEdges) {
      return addEntity("EDGE_LOOP('',(" + orientedEdges.map(function (id) { return '#' + id; }).join(',') + '))');
    }

    function makePlaneFace(origin, normalDirKey, refDirKey, loopIds, sameSense) {
      var ptId = getPoint(origin[0], origin[1], origin[2]);
      var axId = addEntity("AXIS2_PLACEMENT_3D('',#" + ptId + ',#' + dirs[normalDirKey] + ',#' + dirs[refDirKey] + ')');
      var planeId = addEntity("PLANE('',#" + axId + ')');
      var bounds = loopIds.map(function (lid, idx) {
        return addEntity((idx === 0 ? "FACE_OUTER_BOUND('',#" : "FACE_BOUND('',#") + lid + ',.T.)');
      });
      return addEntity(
        "ADVANCED_FACE('',(" +
          bounds.map(function (b) { return '#' + b; }).join(',') +
          '),#' +
          planeId +
          ',' +
          (sameSense ? '.T.' : '.F.') +
          ')'
      );
    }

    // Precompute corner Z levels for vertical edge splitting
    var cornerZs = [];
    for (var cyi = 0; cyi <= ny; cyi++) {
      var cRow = [];
      for (var cxi = 0; cxi <= nx; cxi++) {
        var zs = uniqSorted(
          [
            cellHeight(cxi, cyi),
            cellHeight(cxi - 1, cyi),
            cellHeight(cxi - 1, cyi - 1),
            cellHeight(cxi, cyi - 1)
          ],
          1e-4
        );
        cRow.push(zs);
      }
      cornerZs.push(cRow);
    }

    function verticalChainEdges(x, y, zA, zB, cxi, cyi) {
      var zs = cornerZs[cyi][cxi];
      var goingUp = zB > zA;
      var lo = goingUp ? zA : zB;
      var hi = goingUp ? zB : zA;
      var sub = [];
      for (var i = 0; i < zs.length; i++) {
        if (zs[i] >= lo - 1e-4 && zs[i] <= hi + 1e-4) {
          sub.push(zs[i]);
        }
      }
      if (sub.length === 0 || Math.abs(sub[0] - lo) > 1e-4) sub.unshift(lo);
      if (Math.abs(sub[sub.length - 1] - hi) > 1e-4) sub.push(hi);

      var edges = [];
      if (goingUp) {
        for (var k = 0; k < sub.length - 1; k++) {
          edges.push(getLineEdgeOriented([x, y, sub[k]], [x, y, sub[k + 1]]));
        }
      } else {
        for (var m = sub.length - 1; m > 0; m--) {
          edges.push(getLineEdgeOriented([x, y, sub[m]], [x, y, sub[m - 1]]));
        }
      }
      return edges;
    }

    var faces = [];

    // 4. Vertical wall faces along Y lines (constant GY[iy])
    for (var wyi = 0; wyi <= ny; wyi++) {
      var yVal = GY[wyi];
      var xiStart = 0;
      while (xiStart < nx) {
        var hB = cellHeight(xiStart, wyi - 1);
        var hT = cellHeight(xiStart, wyi);
        if (Math.abs(hB - hT) <= 1e-4) {
          xiStart++;
          continue;
        }
        var zLo = Math.min(hB, hT);
        var zHi = Math.max(hB, hT);
        var normPlusY = hB > hT;

        // Extend segment where ALL 4 cells around shared vertex match (hB, hT)
        var xiEnd = xiStart + 1;
        while (xiEnd < nx) {
          var nhB = cellHeight(xiEnd, wyi - 1);
          var nhT = cellHeight(xiEnd, wyi);
          if (Math.abs(nhB - hB) <= 1e-4 && Math.abs(nhT - hT) <= 1e-4) {
            xiEnd++;
          } else {
            break;
          }
        }

        // Split horizontal top/bottom edges at any intermediate corner where perpendicular height differs
        var botXs = [xiStart];
        for (var bxi = xiStart + 1; bxi < xiEnd; bxi++) {
          // Since nhB==hB and nhT==hT on both sides, ALL 4 cells are [hB, hB, hT, hT] -> no vertical corner split!
        }
        botXs.push(xiEnd);

        var x0 = GX[xiStart];
        var x1 = GX[xiEnd];

        if (normPlusY) {
          // Normal +Y (facing back): bottom goes x1->x0, left goes up at x0, top goes x0->x1, right goes down at x1
          var e1 = getLineEdgeOriented([x1, yVal, zLo], [x0, yVal, zLo]);
          var leftUp = verticalChainEdges(x0, yVal, zLo, zHi, xiStart, wyi);
          var e3 = getLineEdgeOriented([x0, yVal, zHi], [x1, yVal, zHi]);
          var rightDown = verticalChainEdges(x1, yVal, zHi, zLo, xiEnd, wyi);
          var loopPlusY = makeLoop([e1].concat(leftUp, [e3], rightDown));
          faces.push(makePlaneFace([x0, yVal, zLo], 'py', 'nx', [loopPlusY], true));
        } else {
          // Normal -Y (facing front): bottom goes x0->x1, right goes up at x1, top goes x1->x0, left goes down at x0
          var f1 = getLineEdgeOriented([x0, yVal, zLo], [x1, yVal, zLo]);
          var fRightUp = verticalChainEdges(x1, yVal, zLo, zHi, xiEnd, wyi);
          var f3 = getLineEdgeOriented([x1, yVal, zHi], [x0, yVal, zHi]);
          var fLeftDown = verticalChainEdges(x0, yVal, zHi, zLo, xiStart, wyi);
          var loopMinusY = makeLoop([f1].concat(fRightUp, [f3], fLeftDown));
          faces.push(makePlaneFace([x0, yVal, zLo], 'ny', 'px', [loopMinusY], true));
        }

        xiStart = xiEnd;
      }
    }

    // 5. Vertical wall faces along X lines (constant GX[ix])
    for (var wxi = 0; wxi <= nx; wxi++) {
      var xVal = GX[wxi];
      var yiStart = 0;
      while (yiStart < ny) {
        var hL = cellHeight(wxi - 1, yiStart);
        var hR = cellHeight(wxi, yiStart);
        if (Math.abs(hL - hR) <= 1e-4) {
          yiStart++;
          continue;
        }
        var zLoX = Math.min(hL, hR);
        var zHiX = Math.max(hL, hR);
        var normPlusX = hL > hR;

        var yiEnd = yiStart + 1;
        while (yiEnd < ny) {
          var nhL = cellHeight(wxi - 1, yiEnd);
          var nhR = cellHeight(wxi, yiEnd);
          if (Math.abs(nhL - hL) <= 1e-4 && Math.abs(nhR - hR) <= 1e-4) {
            yiEnd++;
          } else {
            break;
          }
        }

        var y0 = GY[yiStart];
        var y1 = GY[yiEnd];

        if (normPlusX) {
          // Normal +X (facing right): bottom goes y0->y1, back goes up at y1, top goes y1->y0, front goes down at y0
          var g1 = getLineEdgeOriented([xVal, y0, zLoX], [xVal, y1, zLoX]);
          var backUp = verticalChainEdges(xVal, y1, zLoX, zHiX, wxi, yiEnd);
          var g3 = getLineEdgeOriented([xVal, y1, zHiX], [xVal, y0, zHiX]);
          var frontDown = verticalChainEdges(xVal, y0, zHiX, zLoX, wxi, yiStart);
          var loopPlusX = makeLoop([g1].concat(backUp, [g3], frontDown));
          faces.push(makePlaneFace([xVal, y0, zLoX], 'px', 'py', [loopPlusX], true));
        } else {
          // Normal -X (facing left): bottom goes y1->y0, front goes up at y0, top goes y0->y1, back goes down at y1
          var k1 = getLineEdgeOriented([xVal, y1, zLoX], [xVal, y0, zLoX]);
          var frontUp = verticalChainEdges(xVal, y0, zLoX, zHiX, wxi, yiStart);
          var k3 = getLineEdgeOriented([xVal, y0, zHiX], [xVal, y1, zHiX]);
          var backDown = verticalChainEdges(xVal, y1, zHiX, zLoX, wxi, yiEnd);
          var loopMinusX = makeLoop([k1].concat(frontUp, [k3], backDown));
          faces.push(makePlaneFace([xVal, y0, zLoX], 'nx', 'ny', [loopMinusX], true));
        }

        yiStart = yiEnd;
      }
    }

    // 6. Prepare circular hole curves & cylindrical faces
    var holeLoopsTop = []; // { hole, cwLoopId }
    var holeLoopsBot = []; // { hole, ccwLoopId }

    for (var vhi = 0; vhi < validHoles.length; vhi++) {
      var vh = validHoles[vhi];
      var rx = round3(vh.cx + vh.r);
      var lx = round3(vh.cx - vh.r);
      var cyH = vh.cy;

      var vTopR = getVertex(rx, cyH, vh.zTop);
      var vTopL = getVertex(lx, cyH, vh.zTop);
      var vBotR = getVertex(rx, cyH, Z_bot);
      var vBotL = getVertex(lx, cyH, Z_bot);

      var ptCenterTop = getPoint(vh.cx, cyH, vh.zTop);
      var ptCenterBot = getPoint(vh.cx, cyH, Z_bot);
      var axTopId = addEntity("AXIS2_PLACEMENT_3D('',#" + ptCenterTop + ',#' + dirs.pz + ',#' + dirs.px + ')');
      var axBotId = addEntity("AXIS2_PLACEMENT_3D('',#" + ptCenterBot + ',#' + dirs.pz + ',#' + dirs.px + ')');

      var circTopId = addEntity("CIRCLE('',#" + axTopId + ',' + fmt(vh.r) + ')');
      var circBotId = addEntity("CIRCLE('',#" + axBotId + ',' + fmt(vh.r) + ')');

      var eTopUpper = addEntity("EDGE_CURVE('',#" + vTopR + ',#' + vTopL + ',#' + circTopId + ',.T.)');
      var eTopLower = addEntity("EDGE_CURVE('',#" + vTopL + ',#' + vTopR + ',#' + circTopId + ',.T.)');
      var eBotUpper = addEntity("EDGE_CURVE('',#" + vBotR + ',#' + vBotL + ',#' + circBotId + ',.T.)');
      var eBotLower = addEntity("EDGE_CURVE('',#" + vBotL + ',#' + vBotR + ',#' + circBotId + ',.T.)');

      // CW loop for +Z top planar face
      var cwTop = makeLoop([
        addEntity("ORIENTED_EDGE('',*,*,#" + eTopLower + ',.F.)'),
        addEntity("ORIENTED_EDGE('',*,*,#" + eTopUpper + ',.F.)')
      ]);
      holeLoopsTop.push({ hole: vh, loopId: cwTop });

      // CCW loop for -Z bottom planar face (same_sense=.F.)
      var ccwBot = makeLoop([
        addEntity("ORIENTED_EDGE('',*,*,#" + eBotUpper + ',.T.)'),
        addEntity("ORIENTED_EDGE('',*,*,#" + eBotLower + ',.T.)')
      ]);
      holeLoopsBot.push(ccwBot);

      // Two 180-deg cylindrical wall faces (inward normal -> same_sense = .F.)
      var cylAx = addEntity("AXIS2_PLACEMENT_3D('',#" + ptCenterBot + ',#' + dirs.pz + ',#' + dirs.px + ')');
      var cylSurf = addEntity("CYLINDRICAL_SURFACE('',#" + cylAx + ',' + fmt(vh.r) + ')');

      var sRightUp = getLineEdgeOriented([rx, cyH, Z_bot], [rx, cyH, vh.zTop]);
      var sRightDown = getLineEdgeOriented([rx, cyH, vh.zTop], [rx, cyH, Z_bot]);
      var sLeftUp = getLineEdgeOriented([lx, cyH, Z_bot], [lx, cyH, vh.zTop]);
      var sLeftDown = getLineEdgeOriented([lx, cyH, vh.zTop], [lx, cyH, Z_bot]);

      var upperCylLoop = makeLoop([
        addEntity("ORIENTED_EDGE('',*,*,#" + eBotUpper + ',.F.)'),
        sRightUp,
        addEntity("ORIENTED_EDGE('',*,*,#" + eTopUpper + ',.T.)'),
        sLeftDown
      ]);
      var lowerCylLoop = makeLoop([
        addEntity("ORIENTED_EDGE('',*,*,#" + eBotLower + ',.F.)'),
        sLeftUp,
        addEntity("ORIENTED_EDGE('',*,*,#" + eTopLower + ',.T.)'),
        sRightDown
      ]);

      var upperCylBound = addEntity("FACE_OUTER_BOUND('',#" + upperCylLoop + ',.T.)');
      var lowerCylBound = addEntity("FACE_OUTER_BOUND('',#" + lowerCylLoop + ',.T.)');
      faces.push(addEntity("ADVANCED_FACE('',(#" + upperCylBound + '),#' + cylSurf + ',.F.)'));
      faces.push(addEntity("ADVANCED_FACE('',(#" + lowerCylBound + '),#' + cylSurf + ',.F.)'));
    }

    // 7. Extract connected horizontal components for top planar faces
    var visited = [];
    for (var vy = 0; vy < ny; vy++) {
      visited.push(new Uint8Array(nx));
    }

    function extractCyclesFromDirectedEdges(dirEdges) {
      // dirEdges: { x0, y0, x1, y1, dx, dy, hOther } in grid indices!
      var outMap = {};
      for (var i = 0; i < dirEdges.length; i++) {
        var de = dirEdges[i];
        var k = de.x0 + ',' + de.y0;
        if (!outMap[k]) outMap[k] = [];
        outMap[k].push(i);
      }
      var used = new Uint8Array(dirEdges.length);
      var cycles = [];

      for (var s = 0; s < dirEdges.length; s++) {
        if (used[s]) continue;
        var cycle = [];
        var curIdx = s;
        while (curIdx >= 0 && !used[curIdx]) {
          used[curIdx] = 1;
          var e = dirEdges[curIdx];
          cycle.push(e);
          var nk = e.x1 + ',' + e.y1;
          var cands = outMap[nk] || [];
          var chosen = -1;
          if (cands.length === 1) {
            chosen = cands[0];
          } else {
            // Turn left maximally (CCW around interior) for outer, or follow right-hand rule inside cell
            // Interior is to the LEFT of (dx, dy). Pick smallest left-turn angle from (-dx, -dy).
            var bestScore = Infinity;
            for (var ci = 0; ci < cands.length; ci++) {
              var cand = cands[ci];
              if (used[cand]) continue;
              var ce = dirEdges[cand];
              var ang = Math.atan2(e.dx * ce.dy - e.dy * ce.dx, e.dx * ce.dx + e.dy * ce.dy);
              // Prefer turning left (+PI/2 -> +90deg) over straight (0) over right (-PI/2)
              var rank = -ang;
              if (rank < bestScore) {
                bestScore = rank;
                chosen = cand;
              }
            }
          }
          curIdx = chosen;
        }
        if (cycle.length >= 4) {
          cycles.push(cycle);
        }
      }
      return cycles;
    }

    function mergeCycleToOrientedEdges(cycle, zHeight) {
      // Find first vertex where merging does NOT cross (dx,dy,hOther) equality
      var n = cycle.length;
      var splitStart = -1;
      for (var i = 0; i < n; i++) {
        var prev = cycle[(i - 1 + n) % n];
        var cur = cycle[i];
        if (
          prev.dx !== cur.dx ||
          prev.dy !== cur.dy ||
          Math.abs(prev.hOther - cur.hOther) > 1e-4
        ) {
          splitStart = i;
          break;
        }
      }
      if (splitStart < 0) splitStart = 0;

      var oriented = [];
      var idx = 0;
      while (idx < n) {
        var first = cycle[(splitStart + idx) % n];
        var last = first;
        var step = 1;
        while (idx + step < n) {
          var nxt = cycle[(splitStart + idx + step) % n];
          if (
            nxt.dx === first.dx &&
            nxt.dy === first.dy &&
            Math.abs(nxt.hOther - first.hOther) <= 1e-4
          ) {
            last = nxt;
            step++;
          } else {
            break;
          }
        }
        oriented.push(
          getLineEdgeOriented(
            [GX[first.x0], GY[first.y0], zHeight],
            [GX[last.x1], GY[last.y1], zHeight]
          )
        );
        idx += step;
      }
      return makeLoop(oriented);
    }

    function cycleSignedArea(cycle) {
      var area = 0;
      for (var i = 0; i < cycle.length; i++) {
        var e = cycle[i];
        var x0 = GX[e.x0];
        var y0 = GY[e.y0];
        var x1 = GX[e.x1];
        var y1 = GY[e.y1];
        area += x0 * y1 - x1 * y0;
      }
      return area * 0.5;
    }

    function pointInsideGridCells(px, py, cellsSet) {
      for (var ix = 0; ix < nx; ix++) {
        if (px >= GX[ix] && px <= GX[ix + 1]) {
          for (var iy = 0; iy < ny; iy++) {
            if (py >= GY[iy] && py <= GY[iy + 1]) {
              return Boolean(cellsSet[iy + ',' + ix]);
            }
          }
        }
      }
      return false;
    }

    for (var sy = 0; sy < ny; sy++) {
      for (var sx = 0; sx < nx; sx++) {
        if (visited[sy][sx]) continue;
        var zComp = H[sy][sx];
        var compCells = [];
        var compMap = {};
        var stack = [[sx, sy]];
        visited[sy][sx] = 1;

        while (stack.length > 0) {
          var cur = stack.pop();
          var cx = cur[0];
          var cy = cur[1];
          compCells.push(cur);
          compMap[cy + ',' + cx] = true;

          var nbrs = [
            [cx + 1, cy],
            [cx - 1, cy],
            [cx, cy + 1],
            [cx, cy - 1]
          ];
          for (var ni = 0; ni < nbrs.length; ni++) {
            var nbx = nbrs[ni][0];
            var nby = nbrs[ni][1];
            if (nbx < 0 || nbx >= nx || nby < 0 || nby >= ny) continue;
            if (visited[nby][nbx]) continue;
            if (Math.abs(H[nby][nbx] - zComp) <= 1e-4) {
              visited[nby][nbx] = 1;
              stack.push([nbx, nby]);
            }
          }
        }

        // Collect directed boundary edges (CCW around interior)
        var dirEdges = [];
        for (var ci = 0; ci < compCells.length; ci++) {
          var gx = compCells[ci][0];
          var gy = compCells[ci][1];
          if (!compMap[gy + ',' + (gx - 1)]) {
            dirEdges.push({ x0: gx, y0: gy + 1, x1: gx, y1: gy, dx: 0, dy: -1, hOther: cellHeight(gx - 1, gy) });
          }
          if (!compMap[gy + ',' + (gx + 1)]) {
            dirEdges.push({ x0: gx + 1, y0: gy, x1: gx + 1, y1: gy + 1, dx: 0, dy: 1, hOther: cellHeight(gx + 1, gy) });
          }
          if (!compMap[(gy - 1) + ',' + gx]) {
            dirEdges.push({ x0: gx, y0: gy, x1: gx + 1, y1: gy, dx: 1, dy: 0, hOther: cellHeight(gx, gy - 1) });
          }
          if (!compMap[(gy + 1) + ',' + gx]) {
            dirEdges.push({ x0: gx + 1, y0: gy + 1, x1: gx, y1: gy + 1, dx: -1, dy: 0, hOther: cellHeight(gx, gy + 1) });
          }
        }

        var cycles = extractCyclesFromDirectedEdges(dirEdges);
        cycles.sort(function (a, b) {
          return cycleSignedArea(b) - cycleSignedArea(a); // Largest positive CCW outer loop first
        });

        var loopIds = [];
        for (var cycIdx = 0; cycIdx < cycles.length; cycIdx++) {
          loopIds.push(mergeCycleToOrientedEdges(cycles[cycIdx], zComp));
        }

        // Attach any circular hole contained in this horizontal component
        for (var hli = 0; hli < holeLoopsTop.length; hli++) {
          var hl = holeLoopsTop[hli];
          if (Math.abs(hl.hole.zTop - zComp) <= 1e-4 && pointInsideGridCells(hl.hole.cx, hl.hole.cy, compMap)) {
            loopIds.push(hl.loopId);
          }
        }

        var firstPt = [GX[cycles[0][0].x0], GY[cycles[0][0].y0], zComp];
        faces.push(makePlaneFace(firstPt, 'pz', 'px', loopIds, true));
      }
    }

    // 8. Bottom Sheet Face (Z = Z_bot, normal -Z via same_sense = .F.)
    // Walk CW perimeter matching exact outer wall horizontal splits
    var botOuterEdges = [];
    // Left edge (x=0, going +Y)
    var bYi = 0;
    while (bYi < ny) {
      var lh0 = H[bYi][0];
      var bYiEnd = bYi + 1;
      while (bYiEnd < ny && Math.abs(H[bYiEnd][0] - lh0) <= 1e-4) bYiEnd++;
      botOuterEdges.push(getLineEdgeOriented([0, GY[bYi], Z_bot], [0, GY[bYiEnd], Z_bot]));
      bYi = bYiEnd;
    }
    // Back edge (y=L, going +X)
    var bXi = 0;
    while (bXi < nx) {
      var bh0 = H[ny - 1][bXi];
      var bXiEnd = bXi + 1;
      while (bXiEnd < nx && Math.abs(H[ny - 1][bXiEnd] - bh0) <= 1e-4) bXiEnd++;
      botOuterEdges.push(getLineEdgeOriented([GX[bXi], L, Z_bot], [GX[bXiEnd], L, Z_bot]));
      bXi = bXiEnd;
    }
    // Right edge (x=W, going -Y)
    var rYi = ny - 1;
    while (rYi >= 0) {
      var rh0 = H[rYi][nx - 1];
      var rYiEnd = rYi - 1;
      while (rYiEnd >= 0 && Math.abs(H[rYiEnd][nx - 1] - rh0) <= 1e-4) rYiEnd--;
      botOuterEdges.push(getLineEdgeOriented([W, GY[rYi + 1], Z_bot], [W, GY[rYiEnd + 1], Z_bot]));
      rYi = rYiEnd;
    }
    // Front edge (y=0, going -X)
    var fXi = nx - 1;
    while (fXi >= 0) {
      var fh0 = H[0][fXi];
      var fXiEnd = fXi - 1;
      while (fXiEnd >= 0 && Math.abs(H[0][fXiEnd] - fh0) <= 1e-4) fXiEnd--;
      botOuterEdges.push(getLineEdgeOriented([GX[fXi + 1], 0, Z_bot], [GX[fXiEnd + 1], 0, Z_bot]));
      fXi = fXiEnd;
    }

    var botOuterLoop = makeLoop(botOuterEdges);
    var botLoops = [botOuterLoop].concat(holeLoopsBot);
    faces.push(makePlaneFace([0, 0, Z_bot], 'pz', 'px', botLoops, false));

    // 9. Assemble STEP AP214 CLOSED_SHELL & Product Structure
    var appCtx = addEntity("APPLICATION_CONTEXT('automotive design')");
    addEntity("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#" + appCtx + ')');
    var prod = addEntity("PRODUCT('VacuumTablePlenum','Vacuum Table Plenum','',(#" + addEntity("PRODUCT_CONTEXT('',#" + appCtx + ",'mechanical')") + '))');
    var prodForm = addEntity("PRODUCT_DEFINITION_FORMATION('','',#" + prod + ')');
    var prodDefCtx = addEntity("PRODUCT_DEFINITION_CONTEXT('part definition',#" + appCtx + ",'design')");
    var prodDef = addEntity("PRODUCT_DEFINITION('design','',#" + prodForm + ',#' + prodDefCtx + ')');
    var prodShape = addEntity("PRODUCT_DEFINITION_SHAPE('','',#" + prodDef + ')');

    var uLen = addEntity("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
    var uAng = addEntity("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
    var uSol = addEntity("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
    var uncert = addEntity("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#" + uLen + ",'distance_accuracy_value','confusion accuracy')");
    var geomCtx = addEntity(
      "(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#" +
        uncert +
        "))GLOBAL_UNIT_ASSIGNED_CONTEXT((#" +
        uLen +
        ',#' +
        uAng +
        ',#' +
        uSol +
        "))REPRESENTATION_CONTEXT('Context3D','3D Context'))"
    );

    var worldAx = addEntity(
      "AXIS2_PLACEMENT_3D('',#" + getPoint(0, 0, 0) + ',#' + dirs.pz + ',#' + dirs.px + ')'
    );

    var closedShell = addEntity(
      "CLOSED_SHELL('',(" +
        faces
          .map(function (f) {
            return '#' + f;
          })
          .join(',') +
        '))'
    );
    var solidBrep = addEntity("MANIFOLD_SOLID_BREP('VacuumTablePlenum',#" + closedShell + ')');
    var shapeRep = addEntity("ADVANCED_BREP_SHAPE_REPRESENTATION('',(#" + worldAx + ',#' + solidBrep + '),#' + geomCtx + ')');
    addEntity("SHAPE_DEFINITION_REPRESENTATION(#" + prodShape + ',#' + shapeRep + ')');

    var timestamp = new Date().toISOString().split('.')[0];
    var header = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('Vacuum Table Plenum Generator AP214 B-Rep'),'2;1');",
      "FILE_NAME('vacuum-plenum.step','" + timestamp + "',(''),(''),'Vacuum Table Plenum Generator','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;'
    ];

    return header.concat(entities, ['ENDSEC;', 'END-ISO-10303-21;', '']).join('\n');
  }

  var STEP = {
    generateStep: generateStep
  };

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.STEP = STEP;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = STEP;
  }
})(typeof window !== 'undefined' ? window : globalThis);
