(function (global) {
  'use strict';

  var Geometry = global.PlenumApp.Geometry;
  var GCode = global.PlenumApp.GCode;
  var Renderer = global.PlenumApp.Renderer;
  var Preview3D = global.PlenumApp.Preview3D;
  var DXF = global.PlenumApp.DXF;
  var STEP = global.PlenumApp.STEP;

  var STORAGE_KEY = 'vtpg_state_v2';

  function loadStoredState() {
    var fallback = {
      params: Object.assign({}, Geometry.DEFAULT_PARAMS),
      prefs: { theme: 'light', uiSize: 'regular', units: 'in' }
    };
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return {
        params: Object.assign({}, Geometry.DEFAULT_PARAMS, parsed.params || {}),
        prefs: Object.assign({}, fallback.prefs, parsed.prefs || {})
      };
    } catch (_) {
      return fallback;
    }
  }

  function saveStoredState(params, prefs) {
    try {
      global.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ params: params, prefs: prefs })
      );
    } catch (_) {}
  }

  function formatClean(val, decimals) {
    if (!Number.isFinite(val)) return '';
    var factor = Math.pow(10, decimals || 4);
    var v = Math.round(val * factor) / factor;
    return String(v === 0 ? 0 : v);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var stored = loadStoredState();
    var params = stored.params;
    var prefs = stored.prefs;

    var currentLayout = null;
    var currentPlan = null;
    var activeTab = '2d';
    var gcodeDirty = true;
    var playing = false;
    var rafId = null;
    var lastFrameTs = 0;
    var playbackProgress = 1;
    var editingDimKey = null;

    var els = {
      btnAppMenu: document.getElementById('btn-app-menu'),
      appMenuDropdown: document.getElementById('app-menu-dropdown'),
      btnSaveDesign: document.getElementById('btn-save-design'),
      btnLoadDesign: document.getElementById('btn-load-design'),
      inpLoadDesign: document.getElementById('inp-load-design'),
      btnReset: document.getElementById('btn-reset'),
      chkDarkMode: document.getElementById('chk-dark-mode'),
      btnSizeSmall: document.getElementById('btn-size-small'),
      btnSizeRegular: document.getElementById('btn-size-regular'),
      btnUnitsIn: document.getElementById('btn-units-in'),
      btnUnitsMm: document.getElementById('btn-units-mm'),

      btnPreviewGcode: document.getElementById('btn-preview-gcode'),
      btnDownloadGcode: document.getElementById('btn-download-gcode'),
      btnExportMenu: document.getElementById('btn-export-menu'),
      exportMenuDropdown: document.getElementById('export-menu-dropdown'),
      btnExportStep: document.getElementById('btn-export-step'),
      btnExportDxf: document.getElementById('btn-export-dxf'),
      btnExportJson: document.getElementById('btn-export-json'),

      sheetWidth: document.getElementById('inp-sheet-width'),
      sheetLength: document.getElementById('inp-sheet-length'),
      sheetThickness: document.getElementById('inp-sheet-thickness'),
      outerMargin: document.getElementById('inp-outer-margin'),
      centerDivider: document.getElementById('inp-center-divider'),
      linkDivider: document.getElementById('chk-link-divider'),
      readoutDividerOverride: document.getElementById('readout-divider-override'),

      btnTool025: document.getElementById('btn-tool-025'),
      btnTool0375: document.getElementById('btn-tool-0375'),
      channelDepth: document.getElementById('inp-channel-depth'),
      readoutDepthMm: document.getElementById('readout-depth-mm'),
      readoutGridSummary: document.getElementById('readout-grid-summary'),
      readoutPadSize: document.getElementById('readout-pad-size'),
      chkSquarePads: document.getElementById('chk-square-pads'),
      vertLines: document.getElementById('inp-vert-lines'),
      horizLines: document.getElementById('inp-horiz-lines'),
      btnVertDec: document.getElementById('btn-vert-dec'),
      btnVertInc: document.getElementById('btn-vert-inc'),
      btnHorizDec: document.getElementById('btn-horiz-dec'),
      btnHorizInc: document.getElementById('btn-horiz-inc'),

      btnCenterHoles: document.getElementById('btn-center-holes'),
      inletDiameter: document.getElementById('inp-inlet-diameter'),
      inletCutDepth: document.getElementById('inp-inlet-cut-depth'),
      flangeRadius: document.getElementById('inp-flange-radius'),
      flangePocketDepth: document.getElementById('inp-flange-pocket-depth'),
      pocketStepover: document.getElementById('inp-pocket-stepover'),
      readoutFlangePads: document.getElementById('readout-flange-pads'),
      chkInletTabs: document.getElementById('chk-inlet-tabs'),

      rpm: document.getElementById('inp-rpm'),
      feedRate: document.getElementById('inp-feed-rate'),
      stepdown: document.getElementById('inp-stepdown'),
      plungeRate: document.getElementById('inp-plunge-rate'),
      safeZ: document.getElementById('inp-safe-z'),
      rampAngle: document.getElementById('inp-ramp-angle'),

      tab2d: document.getElementById('tab-2d'),
      tabGcode: document.getElementById('tab-gcode'),
      toolbar2d: document.getElementById('toolbar-2d'),
      toolbarGcode: document.getElementById('toolbar-gcode'),
      panel2d: document.getElementById('panel-2d'),
      panelGcode: document.getElementById('panel-gcode'),

      chkShowDimensions: document.getElementById('chk-show-dimensions'),
      chkShowToolpath: document.getElementById('chk-show-toolpath'),
      btnZoomOut: document.getElementById('btn-zoom-out'),
      btnZoomFit: document.getElementById('btn-zoom-fit'),
      btnZoomIn: document.getElementById('btn-zoom-in'),
      btnCopyGcode: document.getElementById('btn-copy-gcode'),
      gcodeMetaBadge: document.getElementById('gcode-meta-badge'),
      gcodeSections: document.getElementById('gcode-sections'),
      gcodePreview: document.getElementById('gcode-preview'),

      validationBanner: document.getElementById('validation-banner'),
      canvasSvg: document.getElementById('canvas-svg'),
      canvas3d: document.getElementById('canvas-3d'),

      btn3dIso: document.getElementById('btn-3d-iso'),
      btn3dTop: document.getElementById('btn-3d-top'),
      btn3dInlet: document.getElementById('btn-3d-inlet'),

      dimEditorPopover: document.getElementById('dim-editor-popover'),
      dimPopoverTitle: document.getElementById('dim-popover-title'),
      inpDimPopover: document.getElementById('inp-dim-popover'),
      dimPopoverUnit: document.getElementById('dim-popover-unit'),
      btnDimApply: document.getElementById('btn-dim-apply'),
      btnDimCancel: document.getElementById('btn-dim-cancel'),
      dimPopoverSymWrap: document.getElementById('dim-popover-sym-wrap'),
      chkDimSymmetric: document.getElementById('chk-dim-symmetric'),

      btnPlayPause: document.getElementById('btn-play-pause'),
      inpPlayback: document.getElementById('inp-playback'),
      playbackStatus: document.getElementById('playback-status'),

      statSheet: document.getElementById('stat-sheet'),
      statQuad: document.getElementById('stat-quad'),
      statRuntime: document.getElementById('stat-runtime'),
      statLines: document.getElementById('stat-lines'),
      statHealth: document.getElementById('stat-health')
    };

    function toDisplayLinear(inches) {
      if (!Number.isFinite(inches)) return NaN;
      return prefs.units === 'mm' ? inches * 25.4 : inches;
    }

    function fromDisplayLinear(val) {
      if (!Number.isFinite(val)) return NaN;
      return prefs.units === 'mm' ? val / 25.4 : val;
    }

    function fmtLinear(inches, inDec, mmDec) {
      if (!Number.isFinite(inches)) return '—';
      if (prefs.units === 'mm') {
        return (inches * 25.4).toFixed(mmDec !== undefined ? mmDec : 1) + ' mm';
      }
      return inches.toFixed(inDec !== undefined ? inDec : 2) + '"';
    }

    var renderer = Renderer.createRenderer(els.canvasSvg, {
      onEditDimension: openDimPopover
    });
    var preview3d = Preview3D.createPreview3D(els.canvas3d);

    function applyPrefsToDOM() {
      document.documentElement.setAttribute('data-theme', prefs.theme);
      document.documentElement.setAttribute('data-ui-size', prefs.uiSize);

      els.chkDarkMode.checked = prefs.theme === 'dark';
      els.btnSizeSmall.classList.toggle('is-active', prefs.uiSize === 'small');
      els.btnSizeRegular.classList.toggle('is-active', prefs.uiSize === 'regular');
      els.btnUnitsIn.classList.toggle('is-active', prefs.units === 'in');
      els.btnUnitsMm.classList.toggle('is-active', prefs.units === 'mm');

      var unitSuffix = prefs.units === 'mm' ? '(mm)' : '(in)';
      var unitLabels = document.querySelectorAll('.unit-lbl');
      for (var i = 0; i < unitLabels.length; i++) {
        unitLabels[i].textContent = unitSuffix;
      }

      var stepMap =
        prefs.units === 'mm'
          ? {
              sheetWidth: '1',
              sheetLength: '1',
              sheetThickness: '0.5',
              outerMargin: '1',
              centerDivider: '1',
              channelDepth: '0.5',
              inletDiameter: '1',
              inletCutDepth: '0.5',
              flangeRadius: '1',
              flangePocketDepth: '0.5'
            }
          : {
              sheetWidth: '0.125',
              sheetLength: '0.125',
              sheetThickness: '0.0625',
              outerMargin: '0.125',
              centerDivider: '0.125',
              channelDepth: '0.025',
              inletDiameter: '0.125',
              inletCutDepth: '0.01',
              flangeRadius: '0.125',
              flangePocketDepth: '0.025'
            };

      els.sheetWidth.step = stepMap.sheetWidth;
      els.sheetLength.step = stepMap.sheetLength;
      els.sheetThickness.step = stepMap.sheetThickness;
      els.outerMargin.step = stepMap.outerMargin;
      els.centerDivider.step = stepMap.centerDivider;
      els.channelDepth.step = stepMap.channelDepth;
      els.inletDiameter.step = stepMap.inletDiameter;
      els.inletCutDepth.step = stepMap.inletCutDepth;
      els.flangeRadius.step = stepMap.flangeRadius;
      els.flangePocketDepth.step = stepMap.flangePocketDepth;

      renderer.setUnits(prefs.units);
      renderer.setTheme(prefs.theme);
      preview3d.setTheme(prefs.theme);
    }

    function setInputVal(el, val, activeEl, decimals) {
      if (el === activeEl) return;
      el.value = formatClean(val, decimals);
    }

    function syncUIFromParams(activeEl) {
      var p = Geometry.normalizeParams(params);
      var linDec = prefs.units === 'mm' ? 2 : 4;

      setInputVal(els.sheetWidth, toDisplayLinear(p.sheetWidth), activeEl, linDec);
      setInputVal(els.sheetLength, toDisplayLinear(p.sheetLength), activeEl, linDec);
      setInputVal(els.sheetThickness, toDisplayLinear(p.sheetThickness), activeEl, linDec);
      setInputVal(els.outerMargin, toDisplayLinear(p.outerMargin), activeEl, linDec);
      setInputVal(els.centerDivider, toDisplayLinear(p.divider), activeEl, linDec);
      els.linkDivider.checked = p.linkDividerToMargin;
      els.centerDivider.disabled = p.linkDividerToMargin || p.squarePads;
      els.linkDivider.disabled = p.squarePads;

      els.btnTool025.classList.toggle('is-active', Math.abs(p.toolDiameter - 0.25) < 0.001);
      els.btnTool0375.classList.toggle('is-active', Math.abs(p.toolDiameter - 0.375) < 0.001);

      setInputVal(els.channelDepth, toDisplayLinear(p.channelDepth), activeEl, linDec);
      els.readoutDepthMm.textContent = Number.isFinite(p.channelDepth)
        ? Geometry.inToMm(p.channelDepth).toFixed(2) + ' mm depth'
        : '—';

      if (els.vertLines !== activeEl) els.vertLines.value = p.verticalLines;
      if (els.horizLines !== activeEl) els.horizLines.value = p.horizontalLines;
      els.readoutGridSummary.textContent = p.verticalLines + 'V × ' + p.horizontalLines + 'H / quad';
      els.chkSquarePads.checked = p.squarePads;

      setInputVal(els.inletDiameter, toDisplayLinear(p.inletDiameter), activeEl, linDec);
      setInputVal(els.inletCutDepth, toDisplayLinear(p.inletCutDepth), activeEl, linDec);
      setInputVal(els.flangeRadius, toDisplayLinear(p.flangeClearanceRadius), activeEl, linDec);
      setInputVal(els.flangePocketDepth, toDisplayLinear(p.flangePocketDepth), activeEl, linDec);
      setInputVal(els.pocketStepover, p.pocketStepover, activeEl, 2);
      els.chkInletTabs.checked = p.inletTabs;

      setInputVal(els.rpm, p.rpm, activeEl, 0);
      setInputVal(els.feedRate, p.feedRate, activeEl, 0);
      setInputVal(els.stepdown, p.stepdown, activeEl, 2);
      setInputVal(els.plungeRate, p.plungeRate, activeEl, 0);
      setInputVal(els.safeZ, p.safeZ, activeEl, 1);
      setInputVal(els.rampAngle, p.rampAngle, activeEl, 1);
    }

    function updateGcodePanel() {
      if (!currentPlan || !gcodeDirty) return;
      els.gcodePreview.textContent = currentPlan.gcode;
      els.gcodeMetaBadge.textContent =
        'G21 Metric · ' +
        currentPlan.stats.lineCount +
        ' lines · ' +
        currentPlan.stats.estimatedTimeFormatted;

      els.gcodeSections.innerHTML = '';
      for (var i = 0; i < currentPlan.sections.length; i++) {
        (function (sec) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'sec-pill';
          btn.textContent = sec.label;
          btn.addEventListener('click', function () {
            var style = global.getComputedStyle(els.gcodePreview);
            var lh = parseFloat(style.lineHeight) || 18;
            els.gcodePreview.scrollTop = Math.max(0, (sec.lineNumber - 2) * lh);
          });
          els.gcodeSections.appendChild(btn);
        })(currentPlan.sections[i]);
      }

      gcodeDirty = false;
    }

    function updatePlaybackLabel(info) {
      if (playbackProgress >= 0.999) {
        els.playbackStatus.textContent =
          'Order: 1. Perimeters → 2. Inlets → 3. Q1–Q4 Vert → Horiz';
      } else if (info && info.label) {
        var zStr = Number.isFinite(info.z) ? ' · Z ' + info.z.toFixed(1) + 'mm' : '';
        els.playbackStatus.textContent = info.label + zStr;
      }
    }

    function regenerate(activeEl) {
      saveStoredState(params, prefs);
      syncUIFromParams(activeEl);

      currentLayout = Geometry.computeLayout(params);
      if (currentLayout.isValid) {
        currentPlan = GCode.generateGrblGcode(currentLayout);
      } else {
        currentPlan = null;
      }

      // Pad Size ONLY readout
      var q0 = currentLayout.quadrants[0];
      if (q0 && q0.centerWidth > 0 && q0.centerHeight > 0) {
        els.readoutPadSize.textContent =
          'Pad Size: ' + fmtLinear(q0.padX, 2, 1) + ' × ' + fmtLinear(q0.padY, 2, 1);
      } else {
        els.readoutPadSize.textContent = 'Pad Size: —';
      }

      // 1:1 divider override notice
      if (currentLayout.squarePadsActive && q0 && q0.centerWidth > 0) {
        els.readoutDividerOverride.textContent =
          '1:1 Square Pads · Dividers: V ' +
          fmtLinear(currentLayout.dividerX, 2, 1) +
          ' / H ' +
          fmtLinear(currentLayout.dividerY, 2, 1);
        els.readoutDividerOverride.classList.remove('is-hidden');
      } else {
        els.readoutDividerOverride.classList.add('is-hidden');
      }

      // Flange pad removal count readout
      if (currentLayout.totalRemovedPads > 0) {
        els.readoutFlangePads.textContent =
          currentLayout.totalRemovedPads +
          ' pads (' +
          (q0 ? q0.removedPadCount : 0) +
          ' / quad)';
      } else {
        els.readoutFlangePads.textContent = '0 pads';
      }

      // Validation banner
      if (currentLayout.errors.length > 0) {
        els.validationBanner.textContent = currentLayout.errors[0];
        els.validationBanner.className = 'validation-banner is-error';
      } else if (currentLayout.warnings.length > 0) {
        els.validationBanner.textContent = currentLayout.warnings[0];
        els.validationBanner.className = 'validation-banner is-warning';
      } else {
        els.validationBanner.textContent = '';
        els.validationBanner.className = 'validation-banner is-hidden';
      }

      els.btnDownloadGcode.disabled = !currentLayout.isValid;
      els.btnCopyGcode.disabled = !currentLayout.isValid;
      els.btnExportStep.disabled = !currentLayout.isValid;
      els.btnExportDxf.disabled = !currentLayout.isValid;

      // Render 2D SVG + 3D WebGL
      var info = renderer.update(currentLayout, currentPlan);
      preview3d.update(currentLayout, currentPlan);
      preview3d.setToolpathState(els.chkShowToolpath.checked, playbackProgress, info);
      updatePlaybackLabel(info);

      // Update Status Bar (bottom-right hidden when ready)
      els.statSheet.textContent =
        fmtLinear(currentLayout.sheetWidth, 2, 0) +
        ' × ' +
        fmtLinear(currentLayout.sheetLength, 2, 0) +
        ' × ' +
        fmtLinear(currentLayout.sheetThickness, 2, 1) +
        ' MDF';

      if (q0 && q0.cutWidth > 0 && q0.cutHeight > 0) {
        els.statQuad.textContent =
          'Quads: ' +
          fmtLinear(q0.cutWidth, 2, 1) +
          ' × ' +
          fmtLinear(q0.cutHeight, 2, 1) +
          ' (' +
          formatClean(currentLayout.toolDiameter, 3) +
          '" bit)';
      } else {
        els.statQuad.textContent = 'Quads: Invalid margins';
      }

      if (currentPlan) {
        els.statRuntime.textContent = 'Est. Time: ' + currentPlan.stats.estimatedTimeFormatted;
        els.statLines.textContent = 'Lines: ' + currentPlan.stats.lineCount;
      } else {
        els.statRuntime.textContent = 'Est. Time: —';
        els.statLines.textContent = 'Lines: —';
      }

      if (currentLayout.errors.length > 0) {
        els.statHealth.textContent = 'Fix Error';
        els.statHealth.className = 'status-right is-error';
      } else if (currentLayout.warnings.length > 0) {
        els.statHealth.textContent = currentLayout.warnings.length + ' Warning(s)';
        els.statHealth.className = 'status-right is-warning';
      } else {
        els.statHealth.textContent = '';
        els.statHealth.className = 'status-right is-hidden';
      }

      gcodeDirty = true;
      if (activeTab === 'gcode') {
        updateGcodePanel();
      }
    }

    function stopPlayback() {
      playing = false;
      els.btnPlayPause.textContent = 'Play';
      if (rafId !== null) {
        global.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function stepPlayback(ts) {
      if (!playing) return;
      if (!lastFrameTs) lastFrameTs = ts;
      var dt = (ts - lastFrameTs) / 1000;
      lastFrameTs = ts;

      playbackProgress = Math.min(1, playbackProgress + dt / 14);
      els.inpPlayback.value = String(Math.round(playbackProgress * 1000));
      var info = renderer.setProgress(playbackProgress);
      preview3d.setToolpathState(els.chkShowToolpath.checked, playbackProgress, info);
      updatePlaybackLabel(info);

      if (playbackProgress >= 1) {
        stopPlayback();
        return;
      }
      rafId = global.requestAnimationFrame(stepPlayback);
    }

    function startPlayback() {
      if (!currentPlan) return;
      if (playbackProgress >= 0.999) {
        playbackProgress = 0;
        els.inpPlayback.value = '0';
      }
      if (!els.chkShowToolpath.checked) {
        els.chkShowToolpath.checked = true;
        renderer.setShowToolpath(true);
      }
      playing = true;
      lastFrameTs = 0;
      els.btnPlayPause.textContent = 'Pause';
      rafId = global.requestAnimationFrame(stepPlayback);
    }

    function switchTab(tab) {
      activeTab = tab;
      var is2d = tab === '2d';
      els.tab2d.classList.toggle('is-active', is2d);
      els.tab2d.setAttribute('aria-selected', String(is2d));
      els.tabGcode.classList.toggle('is-active', !is2d);
      els.tabGcode.setAttribute('aria-selected', String(!is2d));

      els.toolbar2d.classList.toggle('is-hidden', !is2d);
      els.toolbarGcode.classList.toggle('is-hidden', is2d);
      els.panel2d.classList.toggle('is-hidden', !is2d);
      els.panelGcode.classList.toggle('is-hidden', is2d);

      if (!is2d) {
        updateGcodePanel();
      } else {
        preview3d.redraw();
      }
    }

    // Top-left and Export dropdown menus
    function closeAppMenu() {
      els.appMenuDropdown.classList.add('is-hidden');
      els.btnAppMenu.setAttribute('aria-expanded', 'false');
    }

    function closeExportMenu() {
      els.exportMenuDropdown.classList.add('is-hidden');
      els.btnExportMenu.setAttribute('aria-expanded', 'false');
    }

    els.btnAppMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      var isHidden = els.appMenuDropdown.classList.contains('is-hidden');
      closeExportMenu();
      if (isHidden) {
        closeDimPopover();
        els.appMenuDropdown.classList.remove('is-hidden');
        els.btnAppMenu.setAttribute('aria-expanded', 'true');
      } else {
        closeAppMenu();
      }
    });

    els.appMenuDropdown.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    els.btnExportMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      var isHidden = els.exportMenuDropdown.classList.contains('is-hidden');
      closeAppMenu();
      if (isHidden) {
        closeDimPopover();
        els.exportMenuDropdown.classList.remove('is-hidden');
        els.btnExportMenu.setAttribute('aria-expanded', 'true');
      } else {
        closeExportMenu();
      }
    });

    els.exportMenuDropdown.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // Click-to-Edit 2D Dimension Popover
    function openDimPopover(detail) {
      closeAppMenu();
      closeExportMenu();
      editingDimKey = detail.key;
      els.dimPopoverTitle.textContent = detail.title;
      els.dimPopoverUnit.textContent = prefs.units;
      els.inpDimPopover.value = formatClean(
        toDisplayLinear(detail.valueInches),
        prefs.units === 'mm' ? 1 : 3
      );
      var isY = detail.key === 'frontFromFront' || detail.key === 'betweenY';
      els.dimPopoverSymWrap.classList.toggle('is-hidden', !isY);

      var rect = detail.clientRect;
      var popW = 260;
      var popH = isY ? 112 : 84;
      var left = Math.min(global.innerWidth - popW - 12, Math.max(12, rect.left + rect.width / 2 - popW / 2));
      var top = Math.min(global.innerHeight - popH - 12, Math.max(60, rect.top - popH - 8));
      els.dimEditorPopover.style.left = left + 'px';
      els.dimEditorPopover.style.top = top + 'px';
      els.dimEditorPopover.classList.remove('is-hidden');

      global.setTimeout(function () {
        els.inpDimPopover.focus();
        els.inpDimPopover.select();
      }, 0);
    }

    function closeDimPopover() {
      editingDimKey = null;
      els.dimEditorPopover.classList.add('is-hidden');
    }

    function applyDimPopover() {
      if (!editingDimKey) return;
      var raw = parseFloat(els.inpDimPopover.value);
      if (!Number.isFinite(raw) || raw <= 0) return;
      var valIn = fromDisplayLinear(raw);
      var sym = els.chkDimSymmetric.checked;
      stopPlayback();

      if (editingDimKey === 'betweenX') {
        params.inletOffsetFromCenterX = Geometry.round4(valIn / 2);
      } else if (editingDimKey === 'frontFromFront') {
        params.inletFrontFromFront = Geometry.round4(valIn);
        if (sym) {
          params.inletSpacingY = Geometry.round4(params.sheetLength - 2 * valIn);
        }
      } else if (editingDimKey === 'betweenY') {
        params.inletSpacingY = Geometry.round4(valIn);
        if (sym) {
          params.inletFrontFromFront = Geometry.round4((params.sheetLength - valIn) / 2);
        }
      }

      closeDimPopover();
      regenerate(null);
    }

    els.dimEditorPopover.addEventListener('click', function (e) {
      e.stopPropagation();
    });
    els.btnDimApply.addEventListener('click', applyDimPopover);
    els.btnDimCancel.addEventListener('click', closeDimPopover);
    els.inpDimPopover.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyDimPopover();
      } else if (e.key === 'Escape') {
        closeDimPopover();
      }
    });

    document.addEventListener('click', function () {
      closeAppMenu();
      closeExportMenu();
      closeDimPopover();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeAppMenu();
        closeExportMenu();
        closeDimPopover();
      }
    });

    function downloadTextFile(filename, content, mimeType) {
      var blob = new Blob([content], { type: mimeType || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      global.setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    }

    function saveDesignJson() {
      closeAppMenu();
      closeExportMenu();
      var payload = {
        app: 'Vacuum Table Plenum Generator',
        version: 2,
        params: Geometry.normalizeParams(params),
        prefs: prefs
      };
      var wStr = formatClean(params.sheetWidth, 2);
      var lStr = formatClean(params.sheetLength, 2);
      downloadTextFile(
        'vacuum-plenum-design-' + wStr + 'x' + lStr + '.json',
        JSON.stringify(payload, null, 2),
        'application/json'
      );
    }

    // Save / Load Design JSON
    els.btnSaveDesign.addEventListener('click', saveDesignJson);
    els.btnExportJson.addEventListener('click', saveDesignJson);

    els.btnLoadDesign.addEventListener('click', function () {
      els.inpLoadDesign.value = '';
      els.inpLoadDesign.click();
    });

    els.inpLoadDesign.addEventListener('change', function () {
      var file = els.inpLoadDesign.files && els.inpLoadDesign.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(String(reader.result));
          var rawParams = parsed && parsed.params ? parsed.params : parsed;
          if (!rawParams || typeof rawParams !== 'object' || !Number.isFinite(Number(rawParams.sheetWidth))) {
            throw new Error('Invalid plenum design JSON file.');
          }
          stopPlayback();
          params = Geometry.normalizeParams(rawParams);
          if (parsed && parsed.prefs) {
            if (parsed.prefs.theme === 'dark' || parsed.prefs.theme === 'light') {
              prefs.theme = parsed.prefs.theme;
            }
            if (parsed.prefs.uiSize === 'small' || parsed.prefs.uiSize === 'regular') {
              prefs.uiSize = parsed.prefs.uiSize;
            }
            if (parsed.prefs.units === 'in' || parsed.prefs.units === 'mm') {
              prefs.units = parsed.prefs.units;
            }
          }
          closeAppMenu();
          applyPrefsToDOM();
          playbackProgress = 1;
          els.inpPlayback.value = '1000';
          renderer.setProgress(1);
          regenerate(null);
          renderer.fitToScreen();
          preview3d.setView('iso');
        } catch (err) {
          closeAppMenu();
          els.validationBanner.textContent = 'Could not load design JSON: ' + (err.message || 'Invalid file');
          els.validationBanner.className = 'validation-banner is-error';
        }
      };
      reader.readAsText(file);
    });

    // Preferences toggles
    els.chkDarkMode.addEventListener('change', function () {
      prefs.theme = els.chkDarkMode.checked ? 'dark' : 'light';
      saveStoredState(params, prefs);
      applyPrefsToDOM();
    });

    els.btnSizeSmall.addEventListener('click', function () {
      prefs.uiSize = 'small';
      saveStoredState(params, prefs);
      applyPrefsToDOM();
    });

    els.btnSizeRegular.addEventListener('click', function () {
      prefs.uiSize = 'regular';
      saveStoredState(params, prefs);
      applyPrefsToDOM();
    });

    els.btnUnitsIn.addEventListener('click', function () {
      prefs.units = 'in';
      applyPrefsToDOM();
      regenerate(null);
    });

    els.btnUnitsMm.addEventListener('click', function () {
      prefs.units = 'mm';
      applyPrefsToDOM();
      regenerate(null);
    });

    function bindNum(el, handler, isLinear) {
      el.addEventListener('input', function () {
        var val = parseFloat(el.value);
        if (!Number.isFinite(val)) return;
        stopPlayback();
        handler(isLinear ? fromDisplayLinear(val) : val);
        regenerate(el);
      });
      el.addEventListener('blur', function () {
        syncUIFromParams(null);
      });
    }

    // Sheet & Margin listeners
    bindNum(
      els.sheetWidth,
      function (val) {
        params.sheetWidth = val;
      },
      true
    );
    bindNum(
      els.sheetLength,
      function (val) {
        params.sheetLength = val;
      },
      true
    );
    bindNum(
      els.sheetThickness,
      function (val) {
        params.sheetThickness = val;
      },
      true
    );
    bindNum(
      els.outerMargin,
      function (val) {
        params.outerMargin = val;
        if (params.linkDividerToMargin) {
          params.centerDivider = val;
        }
      },
      true
    );
    bindNum(
      els.centerDivider,
      function (val) {
        params.centerDivider = val;
      },
      true
    );
    els.linkDivider.addEventListener('change', function () {
      stopPlayback();
      params.linkDividerToMargin = els.linkDivider.checked;
      if (params.linkDividerToMargin) {
        params.centerDivider = params.outerMargin;
      }
      regenerate(null);
    });

    // Tool & Grid listeners
    els.btnTool025.addEventListener('click', function () {
      stopPlayback();
      params.toolDiameter = 0.25;
      regenerate(null);
    });
    els.btnTool0375.addEventListener('click', function () {
      stopPlayback();
      params.toolDiameter = 0.375;
      regenerate(null);
    });

    bindNum(
      els.channelDepth,
      function (val) {
        params.channelDepth = val;
      },
      true
    );
    bindNum(els.vertLines, function (val) {
      params.verticalLines = Math.max(0, Math.min(60, Math.floor(val)));
    });
    bindNum(els.horizLines, function (val) {
      params.horizontalLines = Math.max(0, Math.min(120, Math.floor(val)));
    });

    els.btnVertDec.addEventListener('click', function () {
      stopPlayback();
      params.verticalLines = Math.max(0, params.verticalLines - 1);
      regenerate(null);
    });
    els.btnVertInc.addEventListener('click', function () {
      stopPlayback();
      params.verticalLines = Math.min(60, params.verticalLines + 1);
      regenerate(null);
    });
    els.btnHorizDec.addEventListener('click', function () {
      stopPlayback();
      params.horizontalLines = Math.max(0, params.horizontalLines - 1);
      regenerate(null);
    });
    els.btnHorizInc.addEventListener('click', function () {
      stopPlayback();
      params.horizontalLines = Math.min(120, params.horizontalLines + 1);
      regenerate(null);
    });

    els.chkSquarePads.addEventListener('change', function () {
      stopPlayback();
      params.squarePads = els.chkSquarePads.checked;
      regenerate(null);
    });

    // Inlet Holes listeners
    els.btnCenterHoles.addEventListener('click', function () {
      stopPlayback();
      var centered = Geometry.computeCenteredInlets(params);
      params.inletOffsetFromCenterX = centered.inletOffsetFromCenterX;
      params.inletFrontFromFront = centered.inletFrontFromFront;
      params.inletSpacingY = centered.inletSpacingY;
      regenerate(null);
    });

    bindNum(
      els.inletDiameter,
      function (val) {
        params.inletDiameter = val;
      },
      true
    );
    bindNum(
      els.inletCutDepth,
      function (val) {
        params.inletCutDepth = val;
      },
      true
    );
    bindNum(
      els.flangeRadius,
      function (val) {
        params.flangeClearanceRadius = val;
      },
      true
    );
    bindNum(
      els.flangePocketDepth,
      function (val) {
        params.flangePocketDepth = val;
      },
      true
    );
    bindNum(els.pocketStepover, function (val) {
      params.pocketStepover = val;
    });
    els.chkInletTabs.addEventListener('change', function () {
      stopPlayback();
      params.inletTabs = els.chkInletTabs.checked;
      regenerate(null);
    });

    // Cutting Parameters listeners
    bindNum(els.rpm, function (val) {
      params.rpm = val;
    });
    bindNum(els.feedRate, function (val) {
      params.feedRate = val;
    });
    bindNum(els.stepdown, function (val) {
      params.stepdown = val;
    });
    bindNum(els.plungeRate, function (val) {
      params.plungeRate = val;
    });
    bindNum(els.safeZ, function (val) {
      params.safeZ = val;
    });
    bindNum(els.rampAngle, function (val) {
      params.rampAngle = val;
    });

    // Workspace Controls
    els.tab2d.addEventListener('click', function () {
      switchTab('2d');
    });
    els.tabGcode.addEventListener('click', function () {
      switchTab('gcode');
    });
    els.btnPreviewGcode.addEventListener('click', function () {
      switchTab(activeTab === 'gcode' ? '2d' : 'gcode');
    });

    els.chkShowDimensions.addEventListener('change', function () {
      renderer.setShowDimensions(els.chkShowDimensions.checked);
    });
    els.chkShowToolpath.addEventListener('change', function () {
      var info = renderer.setShowToolpath(els.chkShowToolpath.checked);
      preview3d.setToolpathState(els.chkShowToolpath.checked, playbackProgress, info);
      updatePlaybackLabel(info);
    });

    els.btnZoomIn.addEventListener('click', function () {
      renderer.zoomIn();
    });
    els.btnZoomOut.addEventListener('click', function () {
      renderer.zoomOut();
    });
    els.btnZoomFit.addEventListener('click', function () {
      renderer.fitToScreen();
    });

    els.btn3dIso.addEventListener('click', function () {
      preview3d.setView('iso');
    });
    els.btn3dTop.addEventListener('click', function () {
      preview3d.setView('top');
    });
    els.btn3dInlet.addEventListener('click', function () {
      preview3d.setView('inlet');
    });

    els.btnPlayPause.addEventListener('click', function () {
      if (playing) {
        stopPlayback();
      } else {
        startPlayback();
      }
    });

    els.inpPlayback.addEventListener('input', function () {
      stopPlayback();
      playbackProgress = Number(els.inpPlayback.value) / 1000;
      if (playbackProgress < 1 && !els.chkShowToolpath.checked) {
        els.chkShowToolpath.checked = true;
        renderer.setShowToolpath(true);
      }
      var info = renderer.setProgress(playbackProgress);
      preview3d.setToolpathState(els.chkShowToolpath.checked, playbackProgress, info);
      updatePlaybackLabel(info);
    });

    // Copy & Download
    els.btnCopyGcode.addEventListener('click', function () {
      if (!currentPlan) return;
      var text = currentPlan.gcode;
      function flashCopied() {
        var old = els.btnCopyGcode.textContent;
        els.btnCopyGcode.textContent = 'Copied!';
        global.setTimeout(function () {
          els.btnCopyGcode.textContent = old;
        }, 1500);
      }
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(text).then(flashCopied).catch(function () {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand('copy');
            flashCopied();
          } catch (_) {}
          document.body.removeChild(ta);
        });
      } else {
        var ta2 = document.createElement('textarea');
        ta2.value = text;
        document.body.appendChild(ta2);
        ta2.select();
        try {
          document.execCommand('copy');
          flashCopied();
        } catch (_) {}
        document.body.removeChild(ta2);
      }
    });

    els.btnDownloadGcode.addEventListener('click', function () {
      if (!currentLayout || !currentLayout.isValid) return;
      var plan = currentPlan || GCode.generateGrblGcode(currentLayout);
      var wStr = formatClean(currentLayout.sheetWidth, 2);
      var lStr = formatClean(currentLayout.sheetLength, 2);
      var tStr = formatClean(currentLayout.toolDiameter, 3);
      downloadTextFile(
        'vacuum-plenum-' + wStr + 'x' + lStr + '-' + tStr + 'in.nc',
        plan.gcode,
        'text/plain;charset=utf-8'
      );
    });

    els.btnExportDxf.addEventListener('click', function () {
      closeExportMenu();
      if (!currentLayout || !currentLayout.isValid) return;
      var wStr = formatClean(currentLayout.sheetWidth, 2);
      var lStr = formatClean(currentLayout.sheetLength, 2);
      var dxfText = DXF.generateDxf(currentLayout, prefs.units);
      downloadTextFile(
        'vacuum-plenum-' + wStr + 'x' + lStr + '-' + prefs.units + '.dxf',
        dxfText,
        'application/dxf'
      );
    });

    els.btnExportStep.addEventListener('click', function () {
      closeExportMenu();
      if (!currentLayout || !currentLayout.isValid) return;
      var wStr = formatClean(currentLayout.sheetWidth, 2);
      var lStr = formatClean(currentLayout.sheetLength, 2);
      var stepText = STEP.generateStep(currentLayout);
      downloadTextFile(
        'vacuum-plenum-' + wStr + 'x' + lStr + '.step',
        stepText,
        'application/step'
      );
    });

    els.btnReset.addEventListener('click', function () {
      closeAppMenu();
      stopPlayback();
      params = Object.assign({}, Geometry.DEFAULT_PARAMS);
      playbackProgress = 1;
      els.inpPlayback.value = '1000';
      renderer.setProgress(1);
      regenerate(null);
      renderer.fitToScreen();
      preview3d.setView('iso');
    });

    // Initial render
    applyPrefsToDOM();
    regenerate(null);
  });
})(window);
