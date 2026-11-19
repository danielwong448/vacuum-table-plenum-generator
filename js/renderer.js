(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function createSvgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        el.setAttribute(keys[i], String(attrs[keys[i]]));
      }
    }
    return el;
  }

  function createRenderer(svgElement, options) {
    var svg = svgElement;
    var opts = options || {};

    var state = {
      layout: null,
      plan: null,
      showDimensions: true,
      showToolpath: false,
      progress: 1,
      units: 'in',
      theme: 'light',
      zoom: 1,
      panX: 0,
      panY: 0,
      baseBox: { x: -9.5, y: -8.5, w: 74.0, h: 115.5 },
      dragging: false,
      lastClientX: 0,
      lastClientY: 0
    };

    var defs = createSvgEl('defs');
    var sheetShadow = createSvgEl('filter', {
      id: 'sheet-shadow',
      x: '-8%',
      y: '-5%',
      width: '116%',
      height: '112%'
    });
    sheetShadow.appendChild(
      createSvgEl('feDropShadow', {
        dx: '0',
        dy: '0.6',
        stdDeviation: '1.1',
        'flood-color': '#0F172A',
        'flood-opacity': '0.10'
      })
    );
    defs.appendChild(sheetShadow);

    var layerSheet = createSvgEl('g', { id: 'layer-sheet' });
    var layerChannels = createSvgEl('g', { id: 'layer-channels' });
    var layerInlets = createSvgEl('g', { id: 'layer-inlets' });
    var layerToolpath = createSvgEl('g', { id: 'layer-toolpath' });
    var layerCursor = createSvgEl('g', { id: 'layer-cursor' });
    var layerDimensions = createSvgEl('g', { id: 'layer-dimensions' });

    svg.innerHTML = '';
    svg.appendChild(defs);
    svg.appendChild(layerSheet);
    svg.appendChild(layerChannels);
    svg.appendChild(layerInlets);
    svg.appendChild(layerToolpath);
    svg.appendChild(layerCursor);
    svg.appendChild(layerDimensions);

    function clearEl(el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    }

    function palette() {
      if (state.theme === 'dark') {
        return {
          sheetFill: '#1E293B',
          sheetStroke: '#334155',
          centerline: '#475569',
          edgeText: '#64748B',
          pillBg: '#0F172A',
          pillText: '#E2E8F0',
          pillStroke: '#334155',
          dimLine: '#94A3B8',
          extLine: '#475569',
          holeFill: '#0F172A',
          flangeShade: 'rgba(40, 150, 210, 0.30)',
          editBg: '#12334A',
          editStroke: '#38BDF8',
          editText: '#7DD3FC',
          slotColor: '#4BA9DA',
          perimColor: '#2896D2',
          quadPillBg: 'rgba(15, 23, 42, 0.90)',
          quadPillText: '#7DD3FC',
          quadPillStroke: '#1E4E6E'
        };
      }
      return {
        sheetFill: '#FFFFFF',
        sheetStroke: '#CBD5E1',
        centerline: '#CBD5E1',
        edgeText: '#94A3B8',
        pillBg: '#FFFFFF',
        pillText: '#334155',
        pillStroke: '#CBD5E1',
        dimLine: '#64748B',
        extLine: '#CBD5E1',
        holeFill: '#F1F5F9',
        flangeShade: 'rgba(40, 150, 210, 0.20)',
        editBg: '#EAF5FB',
        editStroke: '#2896D2',
        editText: '#1A6D9C',
        slotColor: '#5FB3E0',
        perimColor: '#2896D2',
        quadPillBg: 'rgba(255, 255, 255, 0.92)',
        quadPillText: '#1E6E9E',
        quadPillStroke: '#BAE0F5'
      };
    }

    function formatDim(inches) {
      var n = Number(inches);
      if (!Number.isFinite(n)) return '—';
      if (state.units === 'mm') {
        return (n * 25.4).toFixed(1) + ' mm';
      }
      return n.toFixed(2) + '"';
    }

    function sx(x) {
      return x;
    }

    function sy(y, sheetLength) {
      return sheetLength - y;
    }

    function updateBaseBox(layout) {
      var padLeft = 9.5;
      var padRight = 15.5;
      var padTop = 8.5;
      var padBottom = 10.0;
      state.baseBox = {
        x: -padLeft,
        y: -padTop,
        w: layout.sheetWidth + padLeft + padRight,
        h: layout.sheetLength + padTop + padBottom
      };
    }

    function applyViewBox() {
      var b = state.baseBox;
      var vw = b.w / state.zoom;
      var vh = b.h / state.zoom;
      var vx = b.x + state.panX;
      var vy = b.y + state.panY;
      svg.setAttribute('viewBox', vx + ' ' + vy + ' ' + vw + ' ' + vh);
      if (typeof opts.onZoomChange === 'function') {
        opts.onZoomChange(state.zoom);
      }
    }

    function fitToScreen() {
      state.zoom = 1;
      state.panX = 0;
      state.panY = 0;
      applyViewBox();
    }

    function clientToSvgDelta(dxPx, dyPx) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return { dx: 0, dy: 0 };
      var vbW = state.baseBox.w / state.zoom;
      var vbH = state.baseBox.h / state.zoom;
      var scale = Math.max(vbW / rect.width, vbH / rect.height);
      return {
        dx: dxPx * scale,
        dy: dyPx * scale
      };
    }

    function zoomBy(factor, clientX, clientY) {
      var oldZoom = state.zoom;
      var newZoom = Math.min(8, Math.max(0.5, oldZoom * factor));
      if (Math.abs(newZoom - oldZoom) < 0.0001) return;

      var rect = svg.getBoundingClientRect();
      var relX = 0.5;
      var relY = 0.5;
      if (clientX !== undefined && clientY !== undefined && rect.width && rect.height) {
        relX = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        relY = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
      }

      var oldW = state.baseBox.w / oldZoom;
      var oldH = state.baseBox.h / oldZoom;
      var newW = state.baseBox.w / newZoom;
      var newH = state.baseBox.h / newZoom;

      state.panX += (oldW - newW) * relX;
      state.panY += (oldH - newH) * relY;
      state.zoom = newZoom;
      applyViewBox();
    }

    function drawPillLabel(parent, x, y, text, optsLabel) {
      var o = optsLabel || {};
      var pal = palette();
      var fontSize = o.fontSize || 1.85;
      var fill = o.fill || pal.pillText;
      var bgFill = o.bgFill || pal.pillBg;
      var strokeColor = o.strokeColor || pal.pillStroke;
      var rotateDeg = o.rotate || 0;
      var padX = o.padX || 0.85;
      var padY = o.padY || 0.55;
      var extraEditSpace = o.dimKey ? fontSize * 1.15 : 0;
      var approxW = Math.max(4.0, text.length * fontSize * 0.56 + padX * 2 + extraEditSpace);
      var approxH = fontSize + padY * 2;

      var gAttrs = {
        transform: rotateDeg
          ? 'translate(' + x + ',' + y + ') rotate(' + rotateDeg + ')'
          : 'translate(' + x + ',' + y + ')'
      };
      if (o.dimKey) {
        gAttrs.class = 'cad-dim-editable';
        gAttrs['data-dim-key'] = o.dimKey;
        gAttrs.style = 'cursor: pointer';
      }

      var g = createSvgEl('g', gAttrs);

      g.appendChild(
        createSvgEl('rect', {
          x: -approxW / 2,
          y: -approxH / 2,
          width: approxW,
          height: approxH,
          rx: approxH / 2,
          fill: bgFill,
          stroke: strokeColor,
          'stroke-width': o.dimKey ? 0.22 : 0.14
        })
      );

      var txt = createSvgEl('text', {
        x: o.dimKey ? -extraEditSpace * 0.35 : 0,
        y: fontSize * 0.34,
        'text-anchor': 'middle',
        'font-family': "'Lato', sans-serif",
        'font-size': fontSize,
        'font-weight': '700',
        fill: fill
      });
      txt.textContent = text;
      g.appendChild(txt);

      if (o.dimKey) {
        // Tiny crisp pencil icon inside pill
        var iconX = approxW / 2 - padX - fontSize * 0.45;
        var s = fontSize * 0.055;
        var pencil = createSvgEl('path', {
          d: 'M-5 3 L3 -5 L6 -2 L-2 6 L-6 6 Z',
          fill: 'none',
          stroke: fill,
          'stroke-width': 1.7,
          'stroke-linejoin': 'round',
          transform: 'translate(' + iconX + ', 0) scale(' + s + ')'
        });
        g.appendChild(pencil);

        g.addEventListener('pointerdown', function (e) {
          e.stopPropagation();
        });
        g.addEventListener('click', function (e) {
          e.stopPropagation();
          if (typeof opts.onEditDimension === 'function') {
            opts.onEditDimension({
              key: o.dimKey,
              title: o.dimTitle || o.dimKey,
              valueInches: o.dimValue,
              clientRect: g.getBoundingClientRect()
            });
          }
        });
      }

      parent.appendChild(g);
    }

    function drawLinearDim(parent, x1, y1, x2, y2, extX1, extY1, extX2, extY2, label, optsDim) {
      var o = optsDim || {};
      var pal = palette();
      var color = o.color || pal.dimLine;
      var textColor = o.textColor || pal.pillText;
      var g = createSvgEl('g', { class: 'cad-dim' });

      if (extX1 !== null && extY1 !== null) {
        g.appendChild(
          createSvgEl('line', {
            x1: extX1,
            y1: extY1,
            x2: x1,
            y2: y1,
            stroke: pal.extLine,
            'stroke-width': 0.14
          })
        );
      }
      if (extX2 !== null && extY2 !== null) {
        g.appendChild(
          createSvgEl('line', {
            x1: extX2,
            y1: extY2,
            x2: x2,
            y2: y2,
            stroke: pal.extLine,
            'stroke-width': 0.14
          })
        );
      }

      g.appendChild(
        createSvgEl('line', {
          x1: x1,
          y1: y1,
          x2: x2,
          y2: y2,
          stroke: color,
          'stroke-width': 0.18
        })
      );

      var dx = x2 - x1;
      var dy = y2 - y1;
      var len = Math.hypot(dx, dy) || 1;
      var ux = dx / len;
      var uy = dy / len;
      var nx = -uy;
      var ny = ux;
      var tick = 0.55;

      g.appendChild(
        createSvgEl('line', {
          x1: x1 - nx * tick,
          y1: y1 - ny * tick,
          x2: x1 + nx * tick,
          y2: y1 + ny * tick,
          stroke: color,
          'stroke-width': 0.22
        })
      );
      g.appendChild(
        createSvgEl('line', {
          x1: x2 - nx * tick,
          y1: y2 - ny * tick,
          x2: x2 + nx * tick,
          y2: y2 + ny * tick,
          stroke: color,
          'stroke-width': 0.22
        })
      );

      if (label) {
        var mx = o.labelX !== undefined ? o.labelX : (x1 + x2) / 2;
        var my = o.labelY !== undefined ? o.labelY : (y1 + y2) / 2;
        drawPillLabel(g, mx, my, label, {
          rotate: o.rotate || 0,
          fill: textColor,
          strokeColor: o.pillStroke || pal.pillStroke,
          bgFill: o.pillBg || pal.pillBg,
          fontSize: o.fontSize || 1.75,
          dimKey: o.dimKey,
          dimTitle: o.dimTitle,
          dimValue: o.dimValue
        });
      }

      parent.appendChild(g);
    }

    function renderSheetAndDesign(layout) {
      clearEl(layerSheet);
      clearEl(layerChannels);
      clearEl(layerInlets);
      clearEl(layerDimensions);

      var pal = palette();
      var W = layout.sheetWidth;
      var L = layout.sheetLength;

      // 1. MDF Sheet
      layerSheet.appendChild(
        createSvgEl('rect', {
          x: 0,
          y: 0,
          width: W,
          height: L,
          rx: 0.25,
          fill: pal.sheetFill,
          stroke: pal.sheetStroke,
          'stroke-width': 0.28,
          filter: 'url(#sheet-shadow)'
        })
      );

      // Centerlines
      layerSheet.appendChild(
        createSvgEl('line', {
          x1: layout.midX,
          y1: 0,
          x2: layout.midX,
          y2: L,
          stroke: pal.centerline,
          'stroke-width': 0.16,
          'stroke-dasharray': '1.2 1.0'
        })
      );
      layerSheet.appendChild(
        createSvgEl('line', {
          x1: 0,
          y1: sy(layout.midY, L),
          x2: W,
          y2: sy(layout.midY, L),
          stroke: pal.centerline,
          'stroke-width': 0.16,
          'stroke-dasharray': '1.2 1.0'
        })
      );

      // Edge labels
      var frontLbl = createSvgEl('text', {
        x: W / 2,
        y: L + 1.5,
        'text-anchor': 'middle',
        'font-family': "'Lato', sans-serif",
        'font-size': 1.45,
        'font-weight': '700',
        fill: pal.edgeText,
        'letter-spacing': '0.12'
      });
      frontLbl.textContent = 'FRONT (Y = 0)';
      layerSheet.appendChild(frontLbl);

      var backLbl = createSvgEl('text', {
        x: W / 2,
        y: -0.75,
        'text-anchor': 'middle',
        'font-family': "'Lato', sans-serif",
        'font-size': 1.45,
        'font-weight': '700',
        fill: pal.edgeText,
        'letter-spacing': '0.12'
      });
      backLbl.textContent = 'BACK';
      layerSheet.appendChild(backLbl);

      // Front-Left Origin (0,0) Marker
      var origGroup = createSvgEl('g', { transform: 'translate(0,' + L + ')' });
      origGroup.appendChild(
        createSvgEl('circle', {
          cx: 0,
          cy: 0,
          r: 0.75,
          fill: '#2896D2',
          stroke: pal.sheetFill,
          'stroke-width': 0.2
        })
      );
      origGroup.appendChild(
        createSvgEl('line', {
          x1: 0,
          y1: 0,
          x2: 3.2,
          y2: 0,
          stroke: '#2896D2',
          'stroke-width': 0.24
        })
      );
      origGroup.appendChild(
        createSvgEl('line', {
          x1: 0,
          y1: 0,
          x2: 0,
          y2: -3.2,
          stroke: '#2896D2',
          'stroke-width': 0.24
        })
      );
      var origTxt = createSvgEl('text', {
        x: -0.8,
        y: 2.3,
        'text-anchor': 'end',
        'font-family': "'Lato', sans-serif",
        'font-size': 1.4,
        'font-weight': '700',
        fill: '#2896D2'
      });
      origTxt.textContent = 'X0, Y0';
      origGroup.appendChild(origTxt);
      layerSheet.appendChild(origGroup);

      // 2. Quadrants, Cleared Flange Pads & Channels
      var bitW = layout.toolDiameter;
      for (var qi = 0; qi < layout.quadrants.length; qi++) {
        var q = layout.quadrants[qi];
        if (q.centerWidth <= 0 || q.centerHeight <= 0) continue;

        // Shade cleared flange pads
        if (q.pads) {
          for (var pi = 0; pi < q.pads.length; pi++) {
            var pad = q.pads[pi];
            if (!pad.removed || pad.px1 <= pad.px0 || pad.py1 <= pad.py0) continue;
            layerChannels.appendChild(
              createSvgEl('rect', {
                x: sx(pad.px0),
                y: sy(pad.py1, L),
                width: pad.px1 - pad.px0,
                height: pad.py1 - pad.py0,
                fill: pal.flangeShade,
                stroke: 'none'
              })
            );
          }
        }

        // Interior vertical slots
        for (var vi = 0; vi < q.verticalLines.length; vi++) {
          var vl = q.verticalLines[vi];
          layerChannels.appendChild(
            createSvgEl('line', {
              x1: sx(vl.x),
              y1: sy(vl.y0, L),
              x2: sx(vl.x),
              y2: sy(vl.y1, L),
              stroke: pal.slotColor,
              'stroke-width': bitW,
              'stroke-linecap': 'butt'
            })
          );
        }

        // Interior horizontal slots
        for (var hi = 0; hi < q.horizontalLines.length; hi++) {
          var hl = q.horizontalLines[hi];
          layerChannels.appendChild(
            createSvgEl('line', {
              x1: sx(hl.x0),
              y1: sy(hl.y, L),
              x2: sx(hl.x1),
              y2: sy(hl.y, L),
              stroke: pal.slotColor,
              'stroke-width': bitW,
              'stroke-linecap': 'butt'
            })
          );
        }

        // Quadrant perimeter channel rectangle
        layerChannels.appendChild(
          createSvgEl('rect', {
            x: sx(q.x0),
            y: sy(q.y1, L),
            width: q.x1 - q.x0,
            height: q.y1 - q.y0,
            fill: 'none',
            stroke: pal.perimColor,
            'stroke-width': bitW,
            'stroke-linejoin': 'miter'
          })
        );

        // Quadrant Pill
        var badgeX = q.cutX0 + q.cutWidth / 2;
        var badgeY = q.id === 'FL' || q.id === 'FR' ? sy(q.cutY0 + 1.35, L) : sy(q.cutY1 - 1.35, L);
        drawPillLabel(layerChannels, badgeX, badgeY, q.shortLabel, {
          fontSize: 1.4,
          fill: pal.quadPillText,
          bgFill: pal.quadPillBg,
          strokeColor: pal.quadPillStroke,
          padX: 0.7,
          padY: 0.38
        });
      }

      // 3. Four Cut-Through Inlet Holes + Flange Clearance Rings + Optional Tabs
      var tabAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
      for (var ii = 0; ii < layout.inlets.length; ii++) {
        var hole = layout.inlets[ii];
        var hx = sx(hole.cx);
        var hy = sy(hole.cy, L);
        var strokeCol = hole.outOfBounds ? '#D97706' : '#2896D2';
        var fillCol = hole.outOfBounds ? '#FEF3C7' : pal.holeFill;

        // Flange removal radius guide ring
        if (layout.params.flangeClearanceRadius > 0) {
          layerInlets.appendChild(
            createSvgEl('circle', {
              cx: hx,
              cy: hy,
              r: hole.radius + layout.params.flangeClearanceRadius,
              fill: 'none',
              stroke: strokeCol,
              'stroke-width': 0.14,
              'stroke-dasharray': '0.6 0.45',
              opacity: '0.6'
            })
          );
        }

        layerInlets.appendChild(
          createSvgEl('circle', {
            cx: hx,
            cy: hy,
            r: hole.radius,
            fill: fillCol,
            'fill-opacity': '0.94',
            stroke: strokeCol,
            'stroke-width': 0.28
          })
        );

        var pathR = Math.max(0.05, hole.radius - layout.toolRadius);
        layerInlets.appendChild(
          createSvgEl('circle', {
            cx: hx,
            cy: hy,
            r: pathR,
            fill: 'none',
            stroke: strokeCol,
            'stroke-width': 0.12,
            'stroke-dasharray': '0.5 0.4',
            opacity: '0.75'
          })
        );

        // 4 Holding Tab Markers if enabled
        if (layout.params.inletTabs) {
          var tabR = Math.max(0.1, hole.radius - layout.toolRadius);
          for (var ti = 0; ti < tabAngles.length; ti++) {
            var ta = tabAngles[ti];
            var txTab = hx + tabR * Math.cos(ta);
            var tyTab = hy - tabR * Math.sin(ta);
            layerInlets.appendChild(
              createSvgEl('circle', {
                cx: txTab,
                cy: tyTab,
                r: 0.2,
                fill: '#F59E0B',
                stroke: pal.sheetFill,
                'stroke-width': 0.08
              })
            );
          }
        }

        // Center crosshairs
        var ch = Math.max(0.7, hole.radius * 0.45);
        layerInlets.appendChild(
          createSvgEl('line', {
            x1: hx - ch,
            y1: hy,
            x2: hx + ch,
            y2: hy,
            stroke: strokeCol,
            'stroke-width': 0.15
          })
        );
        layerInlets.appendChild(
          createSvgEl('line', {
            x1: hx,
            y1: hy - ch,
            x2: hx,
            y2: hy + ch,
            stroke: strokeCol,
            'stroke-width': 0.15
          })
        );
      }

      // 4. CAD Dimension Callouts
      renderDimensions(layout);
    }

    function renderDimensions(layout) {
      clearEl(layerDimensions);
      layerDimensions.style.display = state.showDimensions ? 'inline' : 'none';
      if (!state.showDimensions) return;

      var pal = palette();
      var W = layout.sheetWidth;
      var L = layout.sheetLength;
      var d = layout.inletDims;

      // Top: Overall Sheet Width
      drawLinearDim(
        layerDimensions,
        0,
        -4.8,
        W,
        -4.8,
        0,
        0,
        W,
        0,
        'Width: ' + formatDim(W)
      );

      // Top-Left: Outer Margin
      if (layout.outerMargin > 0) {
        drawLinearDim(
          layerDimensions,
          0,
          -1.9,
          layout.outerMargin,
          -1.9,
          0,
          0,
          layout.outerMargin,
          layout.outerMargin,
          'Margin: ' + formatDim(layout.outerMargin),
          {
            labelX: layout.outerMargin + 6.8,
            labelY: -1.9,
            color: pal.perimColor,
            textColor: pal.editText,
            pillStroke: pal.quadPillStroke,
            fontSize: 1.55
          }
        );
      }

      // Left: Overall Sheet Length
      drawLinearDim(
        layerDimensions,
        -5.0,
        0,
        -5.0,
        L,
        0,
        0,
        0,
        L,
        'Length: ' + formatDim(L),
        { rotate: -90 }
      );

      // Bottom (Editable): Between Left & Right Inlet Holes
      var yBot = L + 5.2;
      if (Math.abs(d.betweenX) > 0.2) {
        drawLinearDim(
          layerDimensions,
          d.xLeft,
          yBot,
          d.xRight,
          yBot,
          d.xLeft,
          sy(d.yFront, L),
          d.xRight,
          sy(d.yFront, L),
          'Between L/R: ' + formatDim(d.betweenX),
          {
            color: pal.editStroke,
            textColor: pal.editText,
            pillStroke: pal.editStroke,
            pillBg: pal.editBg,
            fontSize: 1.65,
            dimKey: 'betweenX',
            dimTitle: 'Between L/R Inlet Holes',
            dimValue: d.betweenX
          }
        );
      }

      // Right Inner Track (Editable): Front Edge -> Front Inlet Hole
      var xRight1 = W + 4.4;
      var yFrontSvg = sy(d.yFront, L);
      var yBackSvg = sy(d.yBack, L);

      if (d.frontFromFront > 0.5) {
        drawLinearDim(
          layerDimensions,
          xRight1,
          L,
          xRight1,
          yFrontSvg,
          W,
          L,
          d.xRight,
          yFrontSvg,
          'From Front: ' + formatDim(d.frontFromFront),
          {
            rotate: -90,
            color: pal.editStroke,
            textColor: pal.editText,
            pillStroke: pal.editStroke,
            pillBg: pal.editBg,
            fontSize: 1.6,
            dimKey: 'frontFromFront',
            dimTitle: 'Front Holes from Front Edge',
            dimValue: d.frontFromFront
          }
        );
      }

      // Right Outer Track (Editable): Between Front & Back Inlet Holes
      var xRight2 = W + 10.6;
      if (Math.abs(d.betweenY) > 0.5) {
        drawLinearDim(
          layerDimensions,
          xRight2,
          yFrontSvg,
          xRight2,
          yBackSvg,
          d.xRight,
          yFrontSvg,
          d.xRight,
          yBackSvg,
          'Between F/B: ' + formatDim(d.betweenY),
          {
            rotate: -90,
            color: pal.editStroke,
            textColor: pal.editText,
            pillStroke: pal.editStroke,
            pillBg: pal.editBg,
            fontSize: 1.65,
            dimKey: 'betweenY',
            dimTitle: 'Between Front/Back Inlet Holes',
            dimValue: d.betweenY
          }
        );
      }
    }

    function renderToolpathOverlay() {
      clearEl(layerToolpath);
      clearEl(layerCursor);

      var active = state.showToolpath || state.progress < 1;
      if (!active || !state.layout || !state.plan || !state.plan.segments.length) {
        return { label: 'Order: 1. Perimeters → 2. Inlets → 3. Q1–Q4 Vert → Horiz', opType: null, quadrantId: null, z: null };
      }

      var L = state.layout.sheetLength;
      var segs = state.plan.segments;
      var total = segs.length;
      var clampedProgress = Math.min(1, Math.max(0, state.progress));
      var exactIdx = clampedProgress * total;
      var fullCount = Math.floor(exactIdx);
      var frac = exactIdx - fullCount;
      if (fullCount >= total) {
        fullCount = total - 1;
        frac = 1;
      }

      var rapidD = [];
      var cutD = [];

      function appendSegmentPath(seg, tEnd) {
        var x1 = sx(seg.x1);
        var y1 = sy(seg.y1, L);

        if (seg.moveType === 'plunge') {
          return { curX: seg.x1, curY: seg.y1, curZ: seg.z1 + (seg.z2 - seg.z1) * tEnd };
        }

        if (seg.moveType === 'arc') {
          var a1 = Math.atan2(seg.y1 - seg.cy, seg.x1 - seg.cx);
          var sweepAngle = (seg.sweepAngle !== undefined ? seg.sweepAngle : Math.PI) * tEnd;
          var aEnd = a1 + sweepAngle;
          var tx = seg.cx + seg.r * Math.cos(aEnd);
          var ty = seg.cy + seg.r * Math.sin(aEnd);
          var x2 = sx(tx);
          var y2 = sy(ty, L);
          if (tEnd > 0.0005 && sweepAngle > 0.0005) {
            var largeArc = sweepAngle > Math.PI ? 1 : 0;
            cutD.push(
              'M' +
                x1.toFixed(3) +
                ' ' +
                y1.toFixed(3) +
                ' A' +
                seg.r.toFixed(3) +
                ' ' +
                seg.r.toFixed(3) +
                ' 0 ' +
                largeArc +
                ' 0 ' +
                x2.toFixed(3) +
                ' ' +
                y2.toFixed(3)
            );
          }
          return { curX: tx, curY: ty, curZ: seg.z2 };
        }

        var mx = seg.x1 + (seg.x2 - seg.x1) * tEnd;
        var my = seg.y1 + (seg.y2 - seg.y1) * tEnd;
        var mz = seg.z1 + (seg.z2 - seg.z1) * tEnd;
        var sx2 = sx(mx);
        var sy2 = sy(my, L);

        if (Math.hypot(mx - seg.x1, my - seg.y1) > 0.0005) {
          var cmd = 'M' + x1.toFixed(3) + ' ' + y1.toFixed(3) + ' L' + sx2.toFixed(3) + ' ' + sy2.toFixed(3);
          if (seg.moveType === 'rapid') {
            rapidD.push(cmd);
          } else {
            cutD.push(cmd);
          }
        }
        return { curX: mx, curY: my, curZ: mz };
      }

      for (var i = 0; i < fullCount; i++) {
        appendSegmentPath(segs[i], 1);
      }

      var curSeg = segs[fullCount];
      var pos = appendSegmentPath(curSeg, frac);

      if (rapidD.length) {
        layerToolpath.appendChild(
          createSvgEl('path', {
            d: rapidD.join(' '),
            fill: 'none',
            stroke: '#94A3B8',
            'stroke-width': 0.16,
            'stroke-dasharray': '0.6 0.5',
            opacity: '0.85'
          })
        );
      }

      if (cutD.length) {
        layerToolpath.appendChild(
          createSvgEl('path', {
            d: cutD.join(' '),
            fill: 'none',
            stroke: state.theme === 'dark' ? '#38BDF8' : '#125E8A',
            'stroke-width': 0.24,
            'stroke-linecap': 'round',
            opacity: '0.95'
          })
        );
      }

      if (clampedProgress >= 0.999) {
        for (var qi = 0; qi < state.layout.quadrants.length; qi++) {
          var q = state.layout.quadrants[qi];
          var cx = (q.x0 + q.x1) / 2;
          var cy = sy((q.y0 + q.y1) / 2, L);
          drawPillLabel(layerToolpath, cx, cy, 'Order #' + q.index + ': Vert → Horiz', {
            fontSize: 1.45,
            fill: '#FFFFFF',
            bgFill: '#2896D2',
            strokeColor: '#1B6FA0',
            padX: 0.8,
            padY: 0.45
          });
        }
      } else {
        var cxSvg = sx(pos.curX);
        var cySvg = sy(pos.curY, L);
        layerCursor.appendChild(
          createSvgEl('circle', {
            cx: cxSvg,
            cy: cySvg,
            r: Math.max(0.55, state.layout.toolRadius * 3.5),
            fill: '#2896D2',
            'fill-opacity': '0.24'
          })
        );
        layerCursor.appendChild(
          createSvgEl('circle', {
            cx: cxSvg,
            cy: cySvg,
            r: Math.max(0.25, state.layout.toolRadius),
            fill: pos.curZ < 0 ? '#2896D2' : '#F59E0B',
            stroke: '#FFFFFF',
            'stroke-width': 0.15
          })
        );
      }

      return {
        label: curSeg.label || 'Toolpath Complete',
        opType: curSeg.opType,
        quadrantId: curSeg.quadrantId,
        x: pos.curX,
        y: pos.curY,
        z: pos.curZ
      };
    }

    function update(layout, plan) {
      var prevSheetW = state.layout ? state.layout.sheetWidth : null;
      var prevSheetL = state.layout ? state.layout.sheetLength : null;

      state.layout = layout;
      state.plan = plan;

      if (prevSheetW !== layout.sheetWidth || prevSheetL !== layout.sheetLength) {
        updateBaseBox(layout);
        if (prevSheetW === null) {
          fitToScreen();
        } else {
          applyViewBox();
        }
      }

      renderSheetAndDesign(layout);
      return renderToolpathOverlay();
    }

    function setShowDimensions(flag) {
      state.showDimensions = Boolean(flag);
      if (state.layout) {
        renderDimensions(state.layout);
      }
    }

    function setShowToolpath(flag) {
      state.showToolpath = Boolean(flag);
      return renderToolpathOverlay();
    }

    function setProgress(val) {
      state.progress = Math.min(1, Math.max(0, Number(val) || 0));
      return renderToolpathOverlay();
    }

    function setUnits(units) {
      state.units = units === 'mm' ? 'mm' : 'in';
      if (state.layout) {
        renderDimensions(state.layout);
      }
    }

    function setTheme(theme) {
      state.theme = theme === 'dark' ? 'dark' : 'light';
      if (state.layout) {
        renderSheetAndDesign(state.layout);
        return renderToolpathOverlay();
      }
      return null;
    }

    // Pan & Zoom
    svg.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        zoomBy(factor, e.clientX, e.clientY);
      },
      { passive: false }
    );

    svg.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      state.dragging = true;
      state.lastClientX = e.clientX;
      state.lastClientY = e.clientY;
      svg.style.cursor = 'grabbing';
      if (svg.setPointerCapture) {
        try {
          svg.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
    });

    svg.addEventListener('pointermove', function (e) {
      if (!state.dragging) return;
      var dx = e.clientX - state.lastClientX;
      var dy = e.clientY - state.lastClientY;
      state.lastClientX = e.clientX;
      state.lastClientY = e.clientY;
      var delta = clientToSvgDelta(dx, dy);
      state.panX -= delta.dx;
      state.panY -= delta.dy;
      applyViewBox();
    });

    function endDrag(e) {
      if (!state.dragging) return;
      state.dragging = false;
      svg.style.cursor = 'grab';
      if (svg.releasePointerCapture) {
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    }

    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    return {
      update: update,
      setShowDimensions: setShowDimensions,
      setShowToolpath: setShowToolpath,
      setProgress: setProgress,
      setUnits: setUnits,
      setTheme: setTheme,
      zoomIn: function () {
        zoomBy(1.25);
      },
      zoomOut: function () {
        zoomBy(0.8);
      },
      fitToScreen: fitToScreen
    };
  }

  global.PlenumApp = global.PlenumApp || {};
  global.PlenumApp.Renderer = {
    createRenderer: createRenderer
  };
})(typeof window !== 'undefined' ? window : globalThis);
