(function (global) {
  'use strict';

  var VS_SOURCE = [
    'attribute vec3 aPos;',
    'attribute vec3 aNormal;',
    'attribute vec3 aColor;',
    'uniform mat4 uMvp;',
    'varying vec3 vNormal;',
    'varying vec3 vColor;',
    'varying float vDepth;',
    'void main() {',
    '  gl_Position = uMvp * vec4(aPos, 1.0);',
    '  vNormal = aNormal;',
    '  vColor = aColor;',
    '  vDepth = aPos.z;',
    '}'
  ].join('\n');

  var FS_SOURCE = [
    'precision mediump float;',
    'varying vec3 vNormal;',
    'varying vec3 vColor;',
    'varying float vDepth;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  vec3 l1 = normalize(vec3(0.45, 0.35, 0.82));',
    '  vec3 l2 = normalize(vec3(-0.55, -0.40, 0.55));',
    '  float diff1 = max(dot(n, l1), 0.0) * 0.58;',
    '  float diff2 = max(dot(n, l2), 0.0) * 0.24;',
    '  float hemi = 0.34 + 0.14 * n.z;',
    '  float cavity = clamp(1.0 + vDepth * 0.22, 0.78, 1.02);',
    '  vec3 lit = vColor * (hemi + diff1 + diff2) * cavity;',
    '  gl_FragColor = vec4(lit, 1.0);',
    '}'
  ].join('\n');

  var LINE_VS_SOURCE = [
    'attribute vec3 aPos;',
    'attribute vec3 aColor;',
    'uniform mat4 uMvp;',
    'varying vec3 vColor;',
    'void main() {',
    '  gl_Position = uMvp * vec4(aPos, 1.0);',
    '  vColor = aColor;',
    '}'
  ].join('\n');

  var LINE_FS_SOURCE = [
    'precision mediump float;',
    'varying vec3 vColor;',
    'void main() {',
    '  gl_FragColor = vec4(vColor, 1.0);',
    '}'
  ].join('\n');

  function mat4Multiply(a, b) {
    var out = new Float32Array(16);
    for (var col = 0; col < 4; col++) {
      var b0 = b[col * 4];
      var b1 = b[col * 4 + 1];
      var b2 = b[col * 4 + 2];
      var b3 = b[col * 4 + 3];
      out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  }

  function mat4Perspective(fovyRad, aspect, near, far) {
    var f = 1.0 / Math.tan(fovyRad / 2);
    var nf = 1 / (near - far);
    var out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  }

  function mat4LookAt(eye, target, up) {
    var zx = eye[0] - target[0];
    var zy = eye[1] - target[1];
    var zz = eye[2] - target[2];
    var zLen = Math.hypot(zx, zy, zz) || 1;
    zx /= zLen;
    zy /= zLen;
    zz /= zLen;

    var rx = up[1] * zz - up[2] * zy;
    var ry = up[2] * zx - up[0] * zz;
    var rz = up[0] * zy - up[1] * zx;
    var rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;

    var ux = zy * rz - zz * ry;
    var uy = zz * rx - zx * rz;
    var uz = zx * ry - zy * rx;

    var out = new Float32Array(16);
    out[0] = rx;
    out[1] = ux;
    out[2] = zx;
    out[3] = 0;
    out[4] = ry;
    out[5] = uy;
    out[6] = zy;
    out[7] = 0;
    out[8] = rz;
    out[9] = uz;
    out[10] = zz;
    out[11] = 0;
    out[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
    out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  function compileShader(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var err = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + err);
    }
    return sh;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  function buildPlenumMesh(layout) {
    var pos = [];
    var norm = [];
    var col = [];

    var midX = layout.midX;
    var midY = layout.midY;
    var W = layout.sheetWidth;
    var L = layout.sheetLength;
    var M = layout.outerMargin;
    var T_sheet = layout.sheetThickness;
    var D_chan = Math.min(layout.params.channelDepth, T_sheet - 0.01);

    function tx(x) {
      return x - midX;
    }
    function ty(y) {
      return y - midY;
    }

    function pushVert(x, y, z, nx, ny, nz, r, g, b) {
      pos.push(x, y, z);
      norm.push(nx, ny, nz);
      col.push(r, g, b);
    }

    function pushTri(a, b, c, nx, ny, nz, rgb) {
      pushVert(a[0], a[1], a[2], nx, ny, nz, rgb[0], rgb[1], rgb[2]);
      pushVert(b[0], b[1], b[2], nx, ny, nz, rgb[0], rgb[1], rgb[2]);
      pushVert(c[0], c[1], c[2], nx, ny, nz, rgb[0], rgb[1], rgb[2]);
    }

    function pushQuad(p0, p1, p2, p3, nx, ny, nz, rgb) {
      pushTri(p0, p1, p2, nx, ny, nz, rgb);
      pushTri(p0, p2, p3, nx, ny, nz, rgb);
    }

    var COL_TOP = [0.89, 0.77, 0.59]; // #E3C496 warm MDF surface
    var COL_SIDE = [0.79, 0.65, 0.46]; // #C9A675 routed side walls
    var COL_FLOOR = [0.71, 0.56, 0.37]; // #B58F5E routed channel floor
    var COL_HOLE_WALL = [0.60, 0.45, 0.28]; // #997347 cut-through bore
    var COL_BOTTOM = [0.68, 0.53, 0.35];
    var COL_TAB = [0.85, 0.71, 0.51];
    var COL_PLUG = [0.74, 0.59, 0.40];

    function pushBox(x0In, y0In, z0, x1In, y1In, z1, topCol, sideCol, includeBottom) {
      if (x1In <= x0In + 0.0001 || y1In <= y0In + 0.0001 || z1 <= z0 + 0.0001) return;
      var x0 = tx(x0In);
      var x1 = tx(x1In);
      var y0 = ty(y0In);
      var y1 = ty(y1In);

      // Top
      pushQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 0, 0, 1, topCol);
      if (includeBottom) {
        pushQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], 0, 0, -1, sideCol);
      }
      // Front (-Y)
      pushQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0, -1, 0, sideCol);
      // Back (+Y)
      pushQuad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], 0, 1, 0, sideCol);
      // Left (-X)
      pushQuad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], -1, 0, 0, sideCol);
      // Right (+X)
      pushQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], 1, 0, 0, sideCol);
    }

    function pushQuadrantFloorTile(bx0, by0, bx1, by1, hole) {
      var zTop = -D_chan;
      var zBot = -T_sheet;
      var R = hole.radius;
      var hx = hole.cx;
      var hy = hole.cy;

      var fitsTile =
        !hole.outOfSheet &&
        hx - R >= bx0 + 0.02 &&
        hx + R <= bx1 - 0.02 &&
        hy - R >= by0 + 0.02 &&
        hy + R <= by1 - 0.02;

      if (!fitsTile) {
        // Fallback solid tile if hole overlaps tile border
        var x0 = tx(bx0);
        var x1 = tx(bx1);
        var y0 = ty(by0);
        var y1 = ty(by1);
        pushQuad([x0, y0, zTop], [x1, y0, zTop], [x1, y1, zTop], [x0, y1, zTop], 0, 0, 1, COL_FLOOR);
        pushQuad([x0, y1, zBot], [x1, y1, zBot], [x1, y0, zBot], [x0, y0, zBot], 0, 0, -1, COL_BOTTOM);
        return;
      }

      // Build sorted angles with 48 uniform steps + 4 exact tile corners
      var rawAngles = [];
      var N = 48;
      for (var i = 0; i < N; i++) {
        rawAngles.push((i / N) * Math.PI * 2);
      }
      var corners = [
        [bx0, by0],
        [bx1, by0],
        [bx1, by1],
        [bx0, by1]
      ];
      for (var ci = 0; ci < corners.length; ci++) {
        var ang = Math.atan2(corners[ci][1] - hy, corners[ci][0] - hx);
        if (ang < 0) ang += Math.PI * 2;
        rawAngles.push(ang);
      }
      rawAngles.sort(function (a, b) {
        return a - b;
      });

      var angles = [];
      for (var ai = 0; ai < rawAngles.length; ai++) {
        if (angles.length === 0 || rawAngles[ai] - angles[angles.length - 1] > 1e-4) {
          angles.push(rawAngles[ai]);
        }
      }
      if (angles.length > 1 && Math.PI * 2 - angles[angles.length - 1] + angles[0] < 1e-4) {
        angles.pop();
      }

      function rayBoxPoint(theta) {
        var dx = Math.cos(theta);
        var dy = Math.sin(theta);
        var tX = dx > 1e-9 ? (bx1 - hx) / dx : dx < -1e-9 ? (bx0 - hx) / dx : Infinity;
        var tY = dy > 1e-9 ? (by1 - hy) / dy : dy < -1e-9 ? (by0 - hy) / dy : Infinity;
        var t = Math.min(tX, tY);
        return [tx(hx + t * dx), ty(hy + t * dy)];
      }

      function circlePoint(theta) {
        return [tx(hx + R * Math.cos(theta)), ty(hy + R * Math.sin(theta))];
      }

      var len = angles.length;
      for (var k = 0; k < len; k++) {
        var a0 = angles[k];
        var a1 = angles[(k + 1) % len];
        var c0 = circlePoint(a0);
        var c1 = circlePoint(a1);
        var b0 = rayBoxPoint(a0);
        var b1 = rayBoxPoint(a1);

        // Top floor face (+Z)
        pushQuad(
          [c0[0], c0[1], zTop],
          [b0[0], b0[1], zTop],
          [b1[0], b1[1], zTop],
          [c1[0], c1[1], zTop],
          0,
          0,
          1,
          COL_FLOOR
        );

        // Bottom sheet face (-Z)
        pushQuad(
          [c1[0], c1[1], zBot],
          [b1[0], b1[1], zBot],
          [b0[0], b0[1], zBot],
          [c0[0], c0[1], zBot],
          0,
          0,
          -1,
          COL_BOTTOM
        );

        // Inner cylindrical hole wall (inward radial normals)
        var midA = a0 + (((a1 - a0 + Math.PI * 2) % (Math.PI * 2)) * 0.5);
        var nx = -Math.cos(midA);
        var ny = -Math.sin(midA);
        pushQuad(
          [c1[0], c1[1], zBot],
          [c0[0], c0[1], zBot],
          [c0[0], c0[1], zTop],
          [c1[0], c1[1], zTop],
          nx,
          ny,
          0,
          COL_HOLE_WALL
        );
      }

      // Optional 4x 2mmx2mm holding tabs + inner MDF plug disk
      if (layout.params.inletTabs) {
        var tabHIn = Math.min(T_sheet - D_chan, 2.0 / 25.4);
        var tabWIn = 2.0 / 25.4;
        var plugR = Math.max(0.05, R - layout.toolDiameter);
        var zTabTop = zBot + tabHIn;

        if (plugR > 0.05) {
          var plugN = 36;
          for (var pi = 0; pi < plugN; pi++) {
            var pa0 = (pi / plugN) * Math.PI * 2;
            var pa1 = ((pi + 1) / plugN) * Math.PI * 2;
            var px0 = tx(hx + plugR * Math.cos(pa0));
            var py0 = ty(hy + plugR * Math.sin(pa0));
            var px1 = tx(hx + plugR * Math.cos(pa1));
            var py1 = ty(hy + plugR * Math.sin(pa1));
            var chx = tx(hx);
            var chy = ty(hy);
            var zPlugTop = Math.min(0, -D_chan);

            // Plug top
            pushTri([chx, chy, zPlugTop], [px0, py0, zPlugTop], [px1, py1, zPlugTop], 0, 0, 1, COL_PLUG);
            // Plug bottom
            pushTri([chx, chy, zBot], [px1, py1, zBot], [px0, py0, zBot], 0, 0, -1, COL_BOTTOM);
            // Plug outer side wall
            var pMid = (pa0 + pa1) * 0.5;
            pushQuad(
              [px0, py0, zBot],
              [px1, py1, zBot],
              [px1, py1, zPlugTop],
              [px0, py0, zPlugTop],
              Math.cos(pMid),
              Math.sin(pMid),
              0,
              COL_HOLE_WALL
            );
          }

          var tabAngs = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
          var rMid = (R + plugR) * 0.5;
          var rSpan = (R - plugR) * 0.5 + 0.02;
          var wHalf = tabWIn * 0.5;

          for (var ti = 0; ti < tabAngs.length; ti++) {
            var ta = tabAngs[ti];
            var cosA = Math.cos(ta);
            var sinA = Math.sin(ta);
            var perpX = -sinA;
            var perpY = cosA;

            function tabPt(rOff, wOff, zVal) {
              return [
                tx(hx + (rMid + rOff) * cosA + wOff * perpX),
                ty(hy + (rMid + rOff) * sinA + wOff * perpY),
                zVal
              ];
            }

            var p00 = tabPt(-rSpan, -wHalf, zBot);
            var p10 = tabPt(rSpan, -wHalf, zBot);
            var p11 = tabPt(rSpan, wHalf, zBot);
            var p01 = tabPt(-rSpan, wHalf, zBot);
            var q00 = tabPt(-rSpan, -wHalf, zTabTop);
            var q10 = tabPt(rSpan, -wHalf, zTabTop);
            var q11 = tabPt(rSpan, wHalf, zTabTop);
            var q01 = tabPt(-rSpan, wHalf, zTabTop);

            pushQuad(q00, q10, q11, q01, 0, 0, 1, COL_TAB);
            pushQuad(p00, p10, q10, q00, -perpX, -perpY, 0, COL_TAB);
            pushQuad(p11, p01, q01, q11, perpX, perpY, 0, COL_TAB);
          }
        }
      }
    }

    // 1. Floor tiles with 4 cut-through inlet holes
    var tileBounds = [
      [0, 0, midX, midY, layout.quadrants[0].inlet],
      [midX, 0, W, midY, layout.quadrants[1].inlet],
      [midX, midY, W, L, layout.quadrants[2].inlet],
      [0, midY, midX, L, layout.quadrants[3].inlet]
    ];
    for (var fi = 0; fi < tileBounds.length; fi++) {
      var tb = tileBounds[fi];
      pushQuadrantFloorTile(tb[0], tb[1], tb[2], tb[3], tb[4]);
    }

    // 2. Outer perimeter skirt of bottom MDF slab (Z = -T_sheet to -D_chan)
    var sx0 = tx(0);
    var sx1 = tx(W);
    var sy0 = ty(0);
    var sy1 = ty(L);
    pushQuad([sx0, sy0, -T_sheet], [sx1, sy0, -T_sheet], [sx1, sy0, -D_chan], [sx0, sy0, -D_chan], 0, -1, 0, COL_SIDE);
    pushQuad([sx1, sy1, -T_sheet], [sx0, sy1, -T_sheet], [sx0, sy1, -D_chan], [sx1, sy1, -D_chan], 0, 1, 0, COL_SIDE);
    pushQuad([sx0, sy1, -T_sheet], [sx0, sy0, -T_sheet], [sx0, sy0, -D_chan], [sx0, sy1, -D_chan], -1, 0, 0, COL_SIDE);
    pushQuad([sx1, sy0, -T_sheet], [sx1, sy1, -T_sheet], [sx1, sy1, -D_chan], [sx1, sy0, -D_chan], 1, 0, 0, COL_SIDE);

    // 3. Raised Outer Margin Walls (Z = -D_chan to 0)
    if (M > 0.001) {
      pushBox(0, 0, -D_chan, M, L, 0, COL_TOP, COL_SIDE, false);
      pushBox(W - M, 0, -D_chan, W, L, 0, COL_TOP, COL_SIDE, false);
      pushBox(M, 0, -D_chan, W - M, M, 0, COL_TOP, COL_SIDE, false);
      pushBox(M, L - M, -D_chan, W - M, L, 0, COL_TOP, COL_SIDE, false);
    }

    // 4. Center Divider Walls (X and Y dividers, cleanly split to avoid overlap)
    var divX = layout.dividerX;
    var divY = layout.dividerY;
    if (divX > 0.001) {
      pushBox(midX - divX / 2, M, -D_chan, midX + divX / 2, L - M, 0, COL_TOP, COL_SIDE, false);
    }
    if (divY > 0.001) {
      pushBox(M, midY - divY / 2, -D_chan, midX - divX / 2, midY + divY / 2, 0, COL_TOP, COL_SIDE, false);
      pushBox(midX + divX / 2, midY - divY / 2, -D_chan, W - M, midY + divY / 2, 0, COL_TOP, COL_SIDE, false);
    }

    // 5. Remaining Uncut Grid Pads
    for (var qi = 0; qi < layout.quadrants.length; qi++) {
      var q = layout.quadrants[qi];
      if (!q.pads) continue;
      for (var pi = 0; pi < q.pads.length; pi++) {
        var pad = q.pads[pi];
        if (pad.removed || pad.overlapsHole) continue;
        if (pad.px1 <= pad.px0 + 0.002 || pad.py1 <= pad.py0 + 0.002) continue;
        pushBox(pad.px0, pad.py0, -D_chan, pad.px1, pad.py1, 0, COL_TOP, COL_SIDE, false);
      }
    }

    return {
      positions: new Float32Array(pos),
      normals: new Float32Array(norm),
      colors: new Float32Array(col),
      vertexCount: pos.length / 3
    };
  }

  function buildToolpathLines(layout, plan, progress) {
    if (!plan || !plan.segments || !plan.segments.length) {
      return { positions: new Float32Array(0), colors: new Float32Array(0), vertexCount: 0 };
    }
    var midX = layout.midX;
    var midY = layout.midY;
    var segs = plan.segments;
    var total = segs.length;
    var clamped = Math.min(1, Math.max(0, progress));
    var exactIdx = clamped * total;
    var fullCount = Math.floor(exactIdx);
    var frac = exactIdx - fullCount;
    if (fullCount >= total) {
      fullCount = total - 1;
      frac = 1;
    }

    var pos = [];
    var col = [];
    var Z_SCALE = 1 / 25.4;

    function addLine(x1, y1, z1, x2, y2, z2, r, g, b) {
      pos.push(x1 - midX, y1 - midY, z1 * Z_SCALE, x2 - midX, y2 - midY, z2 * Z_SCALE);
      col.push(r, g, b, r, g, b);
    }

    function appendSeg(seg, tEnd) {
      if (tEnd <= 0.0005) return;
      if (seg.moveType === 'arc') {
        var a1 = Math.atan2(seg.y1 - seg.cy, seg.x1 - seg.cx);
        var sweep = (seg.sweepAngle || Math.PI) * tEnd;
        var steps = Math.max(3, Math.ceil((sweep / Math.PI) * 16));
        for (var s = 0; s < steps; s++) {
          var ang0 = a1 + (s / steps) * sweep;
          var ang1 = a1 + ((s + 1) / steps) * sweep;
          addLine(
            seg.cx + seg.r * Math.cos(ang0),
            seg.cy + seg.r * Math.sin(ang0),
            seg.z2,
            seg.cx + seg.r * Math.cos(ang1),
            seg.cy + seg.r * Math.sin(ang1),
            seg.z2,
            0.16,
            0.59,
            0.82
          );
        }
        return;
      }

      var mx = seg.x1 + (seg.x2 - seg.x1) * tEnd;
      var my = seg.y1 + (seg.y2 - seg.y1) * tEnd;
      var mz = seg.z1 + (seg.z2 - seg.z1) * tEnd;
      if (seg.moveType === 'rapid') {
        addLine(seg.x1, seg.y1, seg.z1, mx, my, mz, 0.58, 0.64, 0.72);
      } else {
        addLine(seg.x1, seg.y1, seg.z1, mx, my, mz, 0.16, 0.59, 0.82);
      }
    }

    for (var i = 0; i < fullCount; i++) {
      appendSeg(segs[i], 1);
    }
    appendSeg(segs[fullCount], frac);

    return {
      positions: new Float32Array(pos),
      colors: new Float32Array(col),
      vertexCount: pos.length / 3
    };
  }

  function buildToolBitMesh(layout, cursor) {
    if (!cursor || cursor.x === undefined || cursor.y === undefined || cursor.z === undefined) {
      return { positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), vertexCount: 0 };
    }
    var cx = cursor.x - layout.midX;
    var cy = cursor.y - layout.midY;
    var cz = cursor.z / 25.4;
    var r = Math.max(0.14, layout.toolRadius);
    var h = 2.0;

    var pos = [];
    var norm = [];
    var col = [];
    var N = 18;
    var BIT_COL = [0.16, 0.59, 0.82];
    var SHANK_COL = [0.22, 0.67, 0.90];

    for (var i = 0; i < N; i++) {
      var a0 = (i / N) * Math.PI * 2;
      var a1 = ((i + 1) / N) * Math.PI * 2;
      var x0 = cx + r * Math.cos(a0);
      var y0 = cy + r * Math.sin(a0);
      var x1 = cx + r * Math.cos(a1);
      var y1 = cy + r * Math.sin(a1);
      var nx = Math.cos((a0 + a1) * 0.5);
      var ny = Math.sin((a0 + a1) * 0.5);

      // Cylinder side
      pos.push(x0, y0, cz, x1, y1, cz, x1, y1, cz + h);
      pos.push(x0, y0, cz, x1, y1, cz + h, x0, y0, cz + h);
      for (var k = 0; k < 6; k++) {
        norm.push(nx, ny, 0);
        col.push(BIT_COL[0], BIT_COL[1], BIT_COL[2]);
      }

      // Top cap
      pos.push(cx, cy, cz + h, x0, y0, cz + h, x1, y1, cz + h);
      for (var m = 0; m < 3; m++) {
        norm.push(0, 0, 1);
        col.push(SHANK_COL[0], SHANK_COL[1], SHANK_COL[2]);
      }
    }

    return {
      positions: new Float32Array(pos),
      normals: new Float32Array(norm),
      colors: new Float32Array(col),
      vertexCount: pos.length / 3
    };
  }

  function createPreview3D(canvasEl) {
    var gl =
      canvasEl.getContext('webgl', { antialias: true, alpha: false }) ||
      canvasEl.getContext('experimental-webgl', { antialias: true, alpha: false });

    if (!gl) {
      return {
        update: function () {},
        setTheme: function () {},
        setView: function () {},
        setToolpathState: function () {},
        destroy: function () {}
      };
    }

    var meshProg = createProgram(gl, VS_SOURCE, FS_SOURCE);
    var lineProg = createProgram(gl, LINE_VS_SOURCE, LINE_FS_SOURCE);

    var meshLoc = {
      aPos: gl.getAttribLocation(meshProg, 'aPos'),
      aNormal: gl.getAttribLocation(meshProg, 'aNormal'),
      aColor: gl.getAttribLocation(meshProg, 'aColor'),
      uMvp: gl.getUniformLocation(meshProg, 'uMvp')
    };

    var lineLoc = {
      aPos: gl.getAttribLocation(lineProg, 'aPos'),
      aColor: gl.getAttribLocation(lineProg, 'aColor'),
      uMvp: gl.getUniformLocation(lineProg, 'uMvp')
    };

    var bufs = {
      pos: gl.createBuffer(),
      norm: gl.createBuffer(),
      col: gl.createBuffer(),
      linePos: gl.createBuffer(),
      lineCol: gl.createBuffer(),
      bitPos: gl.createBuffer(),
      bitNorm: gl.createBuffer(),
      bitCol: gl.createBuffer()
    };

    var state = {
      layout: null,
      plan: null,
      showToolpath: false,
      progress: 1,
      cursor: null,
      theme: 'light',
      meshCount: 0,
      lineCount: 0,
      bitCount: 0,
      azim: -0.58,
      elev: 0.78,
      dist: 118,
      target: [0, 0, -0.35],
      dragMode: null,
      lastX: 0,
      lastY: 0,
      initializedCamera: false
    };

    var clearColors = {
      light: [0.945, 0.961, 0.976, 1.0],
      dark: [0.059, 0.090, 0.165, 1.0]
    };

    function resizeCanvas() {
      var rect = canvasEl.getBoundingClientRect();
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      var w = Math.max(1, Math.round(rect.width * dpr));
      var h = Math.max(1, Math.round(rect.height * dpr));
      if (canvasEl.width !== w || canvasEl.height !== h) {
        canvasEl.width = w;
        canvasEl.height = h;
      }
      gl.viewport(0, 0, canvasEl.width, canvasEl.height);
    }

    function draw() {
      resizeCanvas();
      var cc = clearColors[state.theme] || clearColors.light;
      gl.clearColor(cc[0], cc[1], cc[2], cc[3]);
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (!state.layout || state.meshCount === 0) return;

      var aspect = canvasEl.width / Math.max(1, canvasEl.height);
      var proj = mat4Perspective((40 * Math.PI) / 180, aspect, 0.5, 1000);

      var cosE = Math.cos(state.elev);
      var eye = [
        state.target[0] + state.dist * cosE * Math.sin(state.azim),
        state.target[1] - state.dist * cosE * Math.cos(state.azim),
        state.target[2] + state.dist * Math.sin(state.elev)
      ];
      var view = mat4LookAt(eye, state.target, [0, 0, 1]);
      var mvp = mat4Multiply(proj, view);

      // Draw MDF Mesh
      gl.useProgram(meshProg);
      gl.uniformMatrix4fv(meshLoc.uMvp, false, mvp);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
      gl.enableVertexAttribArray(meshLoc.aPos);
      gl.vertexAttribPointer(meshLoc.aPos, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.norm);
      gl.enableVertexAttribArray(meshLoc.aNormal);
      gl.vertexAttribPointer(meshLoc.aNormal, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.col);
      gl.enableVertexAttribArray(meshLoc.aColor);
      gl.vertexAttribPointer(meshLoc.aColor, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, state.meshCount);

      // Draw Tool Bit Cursor when scrubbing
      if (state.bitCount > 0 && state.progress < 0.999) {
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.bitPos);
        gl.vertexAttribPointer(meshLoc.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.bitNorm);
        gl.vertexAttribPointer(meshLoc.aNormal, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.bitCol);
        gl.vertexAttribPointer(meshLoc.aColor, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, state.bitCount);
      }

      // Draw 3D Toolpath Lines
      if ((state.showToolpath || state.progress < 0.999) && state.lineCount > 0) {
        gl.useProgram(lineProg);
        gl.uniformMatrix4fv(lineLoc.uMvp, false, mvp);

        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.linePos);
        gl.enableVertexAttribArray(lineLoc.aPos);
        gl.vertexAttribPointer(lineLoc.aPos, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.lineCol);
        gl.enableVertexAttribArray(lineLoc.aColor);
        gl.vertexAttribPointer(lineLoc.aColor, 3, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.LINES, 0, state.lineCount);
      }
    }

    function uploadToolpath() {
      if (!state.layout) return;
      if (state.showToolpath || state.progress < 0.999) {
        var linesData = buildToolpathLines(state.layout, state.plan, state.progress);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.linePos);
        gl.bufferData(gl.ARRAY_BUFFER, linesData.positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.lineCol);
        gl.bufferData(gl.ARRAY_BUFFER, linesData.colors, gl.DYNAMIC_DRAW);
        state.lineCount = linesData.vertexCount;
      } else {
        state.lineCount = 0;
      }

      var bitData = buildToolBitMesh(state.layout, state.progress < 0.999 ? state.cursor : null);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.bitPos);
      gl.bufferData(gl.ARRAY_BUFFER, bitData.positions, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.bitNorm);
      gl.bufferData(gl.ARRAY_BUFFER, bitData.normals, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.bitCol);
      gl.bufferData(gl.ARRAY_BUFFER, bitData.colors, gl.DYNAMIC_DRAW);
      state.bitCount = bitData.vertexCount;
    }

    function setView(preset) {
      if (!state.layout) return;
      var maxSpan = Math.max(state.layout.sheetWidth, state.layout.sheetLength);
      if (preset === 'iso') {
        state.target = [0, 0, -state.layout.sheetThickness * 0.4];
        state.azim = -0.58;
        state.elev = 0.78;
        state.dist = maxSpan * 1.24;
      } else if (preset === 'top') {
        state.target = [0, 0, 0];
        state.azim = 0;
        state.elev = 1.535; // ~88 deg
        state.dist = maxSpan * 1.48;
      } else if (preset === 'inlet') {
        var hole = state.layout.quadrants[0].inlet;
        state.target = [
          hole.cx - state.layout.midX,
          hole.cy - state.layout.midY,
          -state.layout.sheetThickness * 0.45
        ];
        state.azim = -0.55;
        state.elev = 0.76;
        state.dist = Math.max(8, (hole.diameter + state.layout.params.flangeClearanceRadius * 2) * 2.15);
      }
      draw();
    }

    function update(layout, plan) {
      state.layout = layout;
      state.plan = plan;

      var mesh = buildPlenumMesh(layout);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.norm);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.col);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
      state.meshCount = mesh.vertexCount;

      if (!state.initializedCamera) {
        state.initializedCamera = true;
        setView('iso');
      }
      uploadToolpath();
      draw();
    }

    function setToolpathState(showToolpath, progress, cursor) {
      state.showToolpath = Boolean(showToolpath);
      state.progress = Math.min(1, Math.max(0, Number(progress)));
      state.cursor = cursor || null;
      uploadToolpath();
      draw();
    }

    function setTheme(theme) {
      state.theme = theme === 'dark' ? 'dark' : 'light';
      draw();
    }

    // Orbit / Pan / Zoom interactions
    canvasEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    canvasEl.addEventListener('pointerdown', function (e) {
      state.dragMode = e.shiftKey || e.button === 2 ? 'pan' : 'orbit';
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      canvasEl.style.cursor = 'grabbing';
      if (canvasEl.setPointerCapture) {
        try {
          canvasEl.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
    });

    canvasEl.addEventListener('pointermove', function (e) {
      if (!state.dragMode) return;
      var dx = e.clientX - state.lastX;
      var dy = e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;

      if (state.dragMode === 'orbit') {
        state.azim -= dx * 0.0075;
        state.elev = Math.min(1.54, Math.max(0.14, state.elev + dy * 0.0075));
      } else {
        var panScale = state.dist * 0.0014;
        var cosA = Math.cos(state.azim);
        var sinA = Math.sin(state.azim);
        state.target[0] -= (dx * cosA + dy * sinA) * panScale;
        state.target[1] -= (dx * sinA - dy * cosA) * panScale;
      }
      draw();
    });

    function endDrag(e) {
      if (!state.dragMode) return;
      state.dragMode = null;
      canvasEl.style.cursor = 'grab';
      if (canvasEl.releasePointerCapture) {
        try {
          canvasEl.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    }

    canvasEl.addEventListener('pointerup', endDrag);
    canvasEl.addEventListener('pointercancel', endDrag);

    canvasEl.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        state.dist = Math.min(350, Math.max(4, state.dist * factor));
        draw();
      },
      { passive: false }
    );

    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () {
        draw();
      });
      ro.observe(canvasEl);
    } else {
      global.addEventListener('resize', draw);
    }

    return {
      update: update,
      setTheme: setTheme,
      setView: setView,
      setToolpathState: setToolpathState,
      redraw: draw,
      destroy: function () {
        if (ro) ro.disconnect();
      }
    };
  }

  var Preview3D = {
    buildPlenumMesh: buildPlenumMesh,
    createPreview3D: createPreview3D
  };

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.Preview3D = Preview3D;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Preview3D;
  }
})(typeof window !== 'undefined' ? window : globalThis);
