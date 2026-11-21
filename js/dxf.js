(function (global) {
  'use strict';

  var Geometry =
    global.PlenumApp && global.PlenumApp.Geometry
      ? global.PlenumApp.Geometry
      : typeof require === 'function'
      ? require('./geometry.js')
      : null;

  if (!Geometry) {
    throw new Error('PlenumApp.Geometry must be loaded before dxf.js');
  }

  function fmt(n) {
    var v = Math.round(n * 10000) / 10000;
    return (v === 0 ? 0 : v).toFixed(4);
  }

  function rectPts(x0, y0, x1, y1) {
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 }
    ];
  }

  function generateDxf(layout, units) {
    var isMm = units === 'mm';
    var s = isMm ? Geometry.MM_PER_INCH : 1.0;
    var out = [];

    function pushPair(code, val) {
      out.push(String(code), String(val));
    }

    function addClosedPoly(layer, pts) {
      if (!pts || pts.length < 3) return;
      pushPair(0, 'POLYLINE');
      pushPair(8, layer);
      pushPair(66, 1);
      pushPair(70, 1);
      pushPair(10, '0.0000');
      pushPair(20, '0.0000');
      pushPair(30, '0.0000');
      for (var i = 0; i < pts.length; i++) {
        pushPair(0, 'VERTEX');
        pushPair(8, layer);
        pushPair(10, fmt(pts[i].x * s));
        pushPair(20, fmt(pts[i].y * s));
        pushPair(30, '0.0000');
      }
      pushPair(0, 'SEQEND');
    }

    function addLine(layer, x1, y1, x2, y2) {
      pushPair(0, 'LINE');
      pushPair(8, layer);
      pushPair(10, fmt(x1 * s));
      pushPair(20, fmt(y1 * s));
      pushPair(30, '0.0000');
      pushPair(11, fmt(x2 * s));
      pushPair(21, fmt(y2 * s));
      pushPair(31, '0.0000');
    }

    function addCircle(layer, cx, cy, r) {
      pushPair(0, 'CIRCLE');
      pushPair(8, layer);
      pushPair(10, fmt(cx * s));
      pushPair(20, fmt(cy * s));
      pushPair(30, '0.0000');
      pushPair(40, fmt(r * s));
    }

    // HEADER
    pushPair(0, 'SECTION');
    pushPair(2, 'HEADER');
    pushPair(9, '$ACADVER');
    pushPair(1, 'AC1009');
    pushPair(9, '$MEASUREMENT');
    pushPair(70, isMm ? 1 : 0);
    pushPair(9, '$LUNITS');
    pushPair(70, 2);
    pushPair(9, '$EXTMIN');
    pushPair(10, '0.0000');
    pushPair(20, '0.0000');
    pushPair(30, '0.0000');
    pushPair(9, '$EXTMAX');
    pushPair(10, fmt(layout.sheetWidth * s));
    pushPair(20, fmt(layout.sheetLength * s));
    pushPair(30, '0.0000');
    pushPair(0, 'ENDSEC');

    // TABLES
    pushPair(0, 'SECTION');
    pushPair(2, 'TABLES');

    pushPair(0, 'TABLE');
    pushPair(2, 'LTYPE');
    pushPair(70, 1);
    pushPair(0, 'LTYPE');
    pushPair(2, 'CONTINUOUS');
    pushPair(70, 0);
    pushPair(3, 'Solid line');
    pushPair(72, 65);
    pushPair(73, 0);
    pushPair(40, '0.0');
    pushPair(0, 'ENDTAB');

    var layers = [
      { name: 'SHEET_OUTLINE', color: 7 },
      { name: 'QUADRANT_BOUNDARIES', color: 5 },
      { name: 'PADS', color: 3 },
      { name: 'FLANGE_POCKETS', color: 4 },
      { name: 'INLET_HOLES', color: 1 },
      { name: 'CHANNEL_CENTERLINES', color: 8 }
    ];

    pushPair(0, 'TABLE');
    pushPair(2, 'LAYER');
    pushPair(70, layers.length);
    for (var li = 0; li < layers.length; li++) {
      pushPair(0, 'LAYER');
      pushPair(2, layers[li].name);
      pushPair(70, 0);
      pushPair(62, layers[li].color);
      pushPair(6, 'CONTINUOUS');
    }
    pushPair(0, 'ENDTAB');
    pushPair(0, 'ENDSEC');

    // ENTITIES
    pushPair(0, 'SECTION');
    pushPair(2, 'ENTITIES');

    addClosedPoly('SHEET_OUTLINE', rectPts(0, 0, layout.sheetWidth, layout.sheetLength));

    for (var qi = 0; qi < layout.quadrants.length; qi++) {
      var q = layout.quadrants[qi];
      addClosedPoly('QUADRANT_BOUNDARIES', rectPts(q.cutX0, q.cutY0, q.cutX1, q.cutY1));
      addClosedPoly('CHANNEL_CENTERLINES', rectPts(q.x0, q.y0, q.x1, q.y1));

      for (var vi = 0; vi < q.verticalLines.length; vi++) {
        var vl = q.verticalLines[vi];
        addLine('CHANNEL_CENTERLINES', vl.x, vl.y0, vl.x, vl.y1);
      }
      for (var hi = 0; hi < q.horizontalLines.length; hi++) {
        var hl = q.horizontalLines[hi];
        addLine('CHANNEL_CENTERLINES', hl.x0, hl.y, hl.x1, hl.y);
      }

      if (q.pads) {
        for (var pi = 0; pi < q.pads.length; pi++) {
          var pad = q.pads[pi];
          if (pad.removed || pad.overlapsHole) continue;
          if (pad.px1 <= pad.px0 + 1e-4 || pad.py1 <= pad.py0 + 1e-4) continue;
          addClosedPoly('PADS', rectPts(pad.px0, pad.py0, pad.px1, pad.py1));
        }
      }

      if (q.flangePocket && q.flangePocket.physPoly && q.flangePocket.physPoly.length >= 3) {
        addClosedPoly('FLANGE_POCKETS', q.flangePocket.physPoly);
      }

      addCircle('INLET_HOLES', q.inlet.cx, q.inlet.cy, q.inlet.radius);
    }

    pushPair(0, 'ENDSEC');
    pushPair(0, 'EOF');

    return out.join('\n') + '\n';
  }

  var DXF = {
    generateDxf: generateDxf
  };

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.DXF = DXF;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DXF;
  }
})(typeof window !== 'undefined' ? window : globalThis);
