const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const ROI_EXTENSION_RATIO = 0.25;
const ROI_EDITOR_PADDING_RATIO = 0.30;

const ui = {
  start: $("#start-button"),
  stop: $("#stop-button"),
  image: $("#video-feed"),
  empty: $("#video-empty"),
  stage: $("#video-stage"),
  sourceMode: "camera",
  currentView: "docs",
  uploadId: null,
  uploadName: null,
  runId: null,
  filter: "all",
  uploading: false,
  speedLimitTouched: false,
  trafficTouched: false,
  status: null,
  health: null,
  config: null,
  configLoaded: false,
  savedTrafficConfig: null,
  flowAngle: 0,
  modelSelection: null,
  videoMetadata: null,
  previewFrameIndex: 0,
  previewTimer: null,
  previewSequence: 0,
  previewReady: false,
  previewSourceKey: null,
  starting: false,
  history: { vehicles: [], events: [], speed: [], engine: [] },
  toastTimer: null,
  refreshTimer: null,
  roiPoints: [],
  savedRoi: [],
  defaultRoi: [],
  frameSize: { width: 640, height: 360 },
  roiImage: null,
  draggedPoint: null,
  roiSaving: false,
  flowDragging: false,
};

const eventLabels = {
  overspeed: "Overspeeding",
  opposite_direction: "Wrong direction",
  stalling: "Stalled vehicle",
  accident: "Possible collision",
  heavy_vehicle: "Heavy vehicle",
};

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function activateWorkspaceView(viewName, updateHistory = true) {
  const views = {
    monitor: "Monitor",
    configure: "Configure",
    reports: "Events & reports",
    docs: "Home",
  };
  if (!views[viewName]) return;
  ui.currentView = viewName;
  $$(".workspace-view").forEach((view) => {
    const active = view.dataset.view === viewName;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  $$(".nav-link").forEach((link) => {
    const active = link.dataset.viewTarget === viewName;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $(".sidebar-tool[data-view-target='docs']")?.classList.toggle("active", viewName === "docs");
  $("#view-title").textContent = views[viewName];
  if (updateHistory && window.location.hash !== `#${viewName}`) {
    window.history.pushState({ view: viewName }, "", `#${viewName}`);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function viewFromHash() {
  const aliases = {
    "": "docs",
    overview: "monitor",
    monitor: "monitor",
    configure: "configure",
    configurator: "configure",
    events: "reports",
    reports: "reports",
    docs: "docs",
  };
  return aliases[window.location.hash.slice(1)] || "monitor";
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const detail = body?.detail || `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return body;
}

function setHealthItem(selector, label, good) {
  const element = $(selector);
  element.classList.toggle("ok", good === true);
  element.classList.toggle("bad", good === false);
  element.innerHTML = "";
  const dot = document.createElement("i");
  const text = document.createElement("span");
  text.textContent = label;
  element.append(dot, text);
}

function renderHealth(health, config) {
  const connected = Boolean(health);
  const modelReady = Boolean(health?.model_loaded);
  const modelExists = Boolean(health?.model_exists);
  const modelLoading = Boolean(health?.model_loading);
  const deps = health?.dependencies || {};
  const pipelineReady = connected && Object.values(deps).every(Boolean);
  const engineReady = connected && health.ok;
  const missing = Object.entries(deps).filter(([, ready]) => !ready).map(([name]) =>
    name === "pkg_resources" ? "setuptools<81 (pkg_resources)" : name
  );
  if (config && !ui.speedLimitTouched) $("#speed-limit").value = config.default_speed_limit;

  $("#health-api").classList.toggle("ok", connected);
  $("#health-api").classList.toggle("bad", !connected);
  setHealthItem("#health-api", connected ? "Online" : "Offline", connected);
  setHealthItem("#health-model", modelReady ? "Loaded" : modelLoading ? "Loading" : modelExists ? (health?.model_state === "error" ? "Load failed" : "Not loaded") : "Missing", modelReady ? true : modelLoading ? null : false);
  setHealthItem("#health-yolo", pipelineReady ? (health.tracking_mode || "Ready") : "Unavailable", pipelineReady);
  $("#health-title").textContent = !connected ? "API unavailable" : engineReady ? "All systems ready" : modelLoading ? "Loading detection model" : "Setup required";
  $("#health-subtitle").textContent = !connected
    ? "Start the VIDES backend to connect"
    : engineReady
      ? `Detection pipeline ready · ${health.tracking_mode || "DeepSORT"}`
      : modelLoading
        ? "Loading detection model into memory…"
        : health?.model_state === "error"
          ? `Model load failed: ${health.model_error || "check backend logs"}`
          : modelReady
            ? `Install missing runtime: ${missing.join(", ") || "check backend logs"}`
            : modelExists ? "Choose and load a detection model in Configure." : "Choose an available model in Configure.";
  $("#health-ring").classList.toggle("bad", connected && !engineReady);
  $("#health-ring").textContent = connected && engineReady ? "✓" : "!";

  $("#service-dot").className = connected ? (engineReady ? "ok" : "bad") : "";
  $("#service-label").textContent = !connected ? "Service unavailable" : engineReady ? "Engine ready" : "Setup required";
  $("#metric-engine").textContent = !connected ? "Offline" : engineReady ? "Ready" : "Setup needed";
  $("#engine-mini-dot").className = `engine-mini-dot${engineReady ? " ok" : connected ? " bad" : ""}`;
  $("#engine-foot").textContent = !connected ? "Waiting for API service" : engineReady ? "Model and runtime available" : modelLoading ? "Loading selected model" : modelReady ? "Runtime dependencies missing" : "Model must be loaded";
  $("#top-status-dot").className = `pill-dot${connected ? (engineReady ? " ok" : " bad") : ""}`;
  $("#top-status-label").textContent = !connected ? "API offline" : engineReady ? "System ready" : "Setup needed";

  const note = $("#api-note");
  if (!connected) {
    note.hidden = false;
    note.textContent = "Can't reach the VIDES API. From the VIDES folder, install requirements and run: uvicorn app.main:app --reload";
  } else if (!engineReady && !modelLoading) {
    note.hidden = false;
    note.textContent = !modelReady
      ? (health?.model_state === "error"
        ? `The selected model failed to load: ${health.model_error || "check the backend logs"}`
        : modelExists ? "The detection model is not loaded yet. Load it from the Configure page." : "No detection weights file is available. Place a .pt model in VIDES/models.")
      : `The API is online, but the inference runtime is not ready${missing.length ? ` (${missing.join(", ")})` : ""}. Install VIDES/requirements.txt in the backend environment.`;
  } else {
    note.hidden = true;
  }

  const configuredButton = $("#configured-feed-button");
  configuredButton.hidden = !config?.configured_feed;
}

function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function formatEventTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function setVideoState(status) {
  const state = status?.state || "idle";
  const hasFrame = Boolean(status?.frame_ready && status?.run_id);
  const hasSession = Boolean(status?.run_id);
  if (hasSession && ui.runId !== status.run_id) {
    ui.runId = status.run_id;
    ui.image.src = `/api/stream?run=${encodeURIComponent(status.run_id)}`;
    ui.image.classList.remove("visible");
  }

  const stateLabel = state === "running" ? "LIVE" : state === "starting" || state === "stopping" ? "CONNECTING" : state === "completed" ? "COMPLETE" : state === "error" ? "ERROR" : "STANDBY";
  $("#live-label").innerHTML = `<i></i> ${stateLabel}`;
  $("#live-label").classList.toggle("live", state === "running");
  $("#record-state").textContent = stateLabel;
  $(".record-chip").classList.toggle("live", state === "running");
  $("#overlay-source").textContent = (status?.source_label || "NO SOURCE SELECTED").toUpperCase();
  $("#overlay-vehicles").textContent = `${status?.total_vehicles || 0} TRACKS`;
  $("#overlay-fps").textContent = status?.fps ? `${status.fps} FPS` : "— FPS";
  $("#session-duration").textContent = formatDuration(status?.elapsed_seconds);
  $("#session-source").textContent = status?.source_label || "—";
  $("#source-summary-title").textContent = status?.running ? status.source_label || "Video feed" : state === "completed" ? "Video processed" : "No active feed";
  $("#source-summary-subtitle").textContent = status?.running ? state === "starting" ? "Opening video source…" : "Detection session active" : "Connect a video source";
  $("#source-pulse").classList.toggle("is-live", Boolean(status?.running));

  ui.stop.disabled = !status?.running;
  $("#download-report").disabled = !hasSession;
  ui.start.innerHTML = status?.state === "stopping" ? '<span class="start-icon">◌</span> Stopping…' : status?.running ? '<span class="start-icon">◌</span> Detection running' : ui.starting || status?.state === "starting" ? '<span class="start-icon">◌</span> Starting…' : '<span class="start-icon">▶</span> Start detection';
  if (status?.error) {
    $("#video-error").hidden = false;
    $("#video-error").textContent = status.error;
    $("#empty-title").textContent = "Could not start this feed";
    $("#empty-copy").textContent = "Check the video source and backend logs, then try again.";
  } else {
    $("#video-error").hidden = true;
    $("#empty-title").textContent = state === "starting" ? "Opening video source…" : state === "running" ? "Waiting for the first frame…" : state === "completed" ? "Video processing finished" : "Your live view starts here";
    $("#empty-copy").textContent = state === "completed" ? "Start another detection session to monitor a new feed." : "Connect a camera, network stream, or upload a video to begin.";
  }
  $("#video-empty").style.display = hasFrame && state !== "error" ? "none" : "flex";
  if (!hasFrame && state !== "running") ui.image.classList.remove("visible");
  $("#metric-vehicles").textContent = status?.run_id ? String(status.total_vehicles || 0) : "—";
  $("#vehicle-foot").textContent = status?.run_id ? `${Object.keys(status.vehicles_by_class || {}).length} vehicle classes observed` : "Waiting for a feed";
  $("#metric-speed").textContent = status?.run_id && status.total_vehicles ? Number(status.average_speed || 0).toFixed(1) : "—";
  $("#speed-limit-tag").textContent = `LIMIT ${Number(status?.speed_limit || ui.config?.default_speed_limit || 30)} KM/H`;
  updateSetupReadiness();
  const classEntries = Object.entries(status?.vehicles_by_class || {});
  $("#class-summary").textContent = classEntries.length ? classEntries.map(([name, count]) => `${name} ${count}`).join(" · ") : "—";
}

function pointsEqual(left, right) {
  return left.length === right.length && left.every((point, index) =>
    Math.abs(point[0] - right[index][0]) < 0.5 && Math.abs(point[1] - right[index][1]) < 0.5
  );
}

function roiEditorPadding() {
  return {
    x: Math.ceil(ui.frameSize.width * ROI_EDITOR_PADDING_RATIO),
    y: Math.ceil(ui.frameSize.height * ROI_EDITOR_PADDING_RATIO),
  };
}

function roiCanvasPoint([x, y]) {
  const padding = roiEditorPadding();
  return [x + padding.x, y + padding.y];
}

function drawRoiCanvas() {
  const canvas = $("#roi-canvas");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const padding = roiEditorPadding();
  const frameWidth = ui.frameSize.width;
  const frameHeight = ui.frameSize.height;
  context.clearRect(0, 0, width, height);
  if (ui.roiImage) {
    context.drawImage(ui.roiImage, padding.x, padding.y, frameWidth, frameHeight);
    context.fillStyle = "rgba(4, 13, 17, .42)";
    context.fillRect(padding.x, padding.y, frameWidth, frameHeight);
    context.save();
    context.beginPath();
    ui.roiPoints.forEach((point, index) => {
      const [x, y] = roiCanvasPoint(point);
      index ? context.lineTo(x, y) : context.moveTo(x, y);
    });
    context.closePath();
    context.clip();
    context.drawImage(ui.roiImage, padding.x, padding.y, frameWidth, frameHeight);
    context.restore();
    context.strokeStyle = "rgba(190, 218, 221, .75)";
    context.lineWidth = 1;
    context.strokeRect(padding.x + 0.5, padding.y + 0.5, frameWidth - 1, frameHeight - 1);
    $("#roi-canvas-empty").style.display = "none";
  } else {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#10212d");
    gradient.addColorStop(1, "#193547");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "rgba(126, 165, 176, .10)";
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += 32) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
    }
    for (let y = 0; y <= height; y += 32) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
    }
    $("#roi-canvas-empty").style.display = "flex";
  }

  if (ui.roiPoints.length !== 4) return;
  context.beginPath();
  ui.roiPoints.forEach((point, index) => {
    const [x, y] = roiCanvasPoint(point);
    index ? context.lineTo(x, y) : context.moveTo(x, y);
  });
  context.closePath();
  context.fillStyle = "rgba(69, 190, 112, .19)";
  context.fill();
  context.strokeStyle = "#5dd486";
  context.lineWidth = 2;
  context.setLineDash([]);
  context.shadowColor = "rgba(56, 204, 112, .45)";
  context.shadowBlur = 10;
  context.stroke();
  context.shadowBlur = 0;

  ui.roiPoints.forEach((point, index) => {
    const [pointX, pointY] = roiCanvasPoint(point);
    const drawX = Math.max(0, Math.min(width, pointX));
    const drawY = Math.max(0, Math.min(height, pointY));
    context.beginPath();
    context.arc(drawX, drawY, 7, 0, Math.PI * 2);
    context.fillStyle = "#f4fff6";
    context.fill();
    context.beginPath();
    context.arc(drawX, drawY, 4.5, 0, Math.PI * 2);
    context.fillStyle = "#36a660";
    context.fill();
    context.fillStyle = "#f5fff7";
    context.font = "600 8px 'DM Mono', monospace";
    const nearLeft = drawX < 18;
    const nearRight = drawX > width - 18;
    const nearTop = drawY < 16;
    context.textAlign = nearLeft ? "left" : nearRight ? "right" : "center";
    context.textBaseline = nearTop ? "top" : "bottom";
    context.fillText(String.fromCharCode(65 + index), nearLeft ? drawX + 9 : nearRight ? drawX - 9 : drawX,
      nearTop ? drawY + 7 : drawY - 7);
  });
}

function renderRoiControls() {
  const list = $("#roi-points-list");
  if (!list || ui.roiPoints.length !== 4) return;
  list.replaceChildren();
  ui.roiPoints.forEach(([x, y], index) => {
    const row = document.createElement("div");
    row.className = "roi-point-row";
    const name = document.createElement("b");
    name.className = "roi-point-name";
    name.textContent = String.fromCharCode(65 + index);
    row.append(name);
    for (const [axis, value] of [["x", x], ["y", y]]) {
      const label = document.createElement("label");
      label.className = "roi-coordinate-input";
      const axisName = document.createElement("span");
      axisName.textContent = axis.toUpperCase();
      const input = document.createElement("input");
      input.type = "number";
      const frameExtent = axis === "x" ? ui.frameSize.width : ui.frameSize.height;
      const extension = Math.ceil(frameExtent * ROI_EXTENSION_RATIO);
      input.min = String(-extension);
      input.max = String(frameExtent + extension);
      input.step = "1";
      input.value = String(Math.round(value));
      input.setAttribute("aria-label", `Point ${String.fromCharCode(65 + index)} ${axis.toUpperCase()} coordinate`);
      input.addEventListener("change", () => {
        const nextValue = Number(input.value);
        if (!Number.isFinite(nextValue)) return;
        ui.roiPoints[index][axis === "x" ? 0 : 1] = Math.max(Number(input.min), Math.min(Number(input.max), nextValue));
        updateRoiEditor();
      });
      label.append(axisName, input);
      row.append(label);
    }
    list.append(row);
  });
}

function updateRoiEditor() {
  const dirty = !pointsEqual(ui.roiPoints, ui.savedRoi);
  const badge = $("#roi-state");
  badge.classList.toggle("unsaved", dirty);
  badge.classList.toggle("saving", ui.roiSaving);
  badge.textContent = ui.roiSaving ? "SAVING" : dirty ? "UNSAVED CHANGES" : "SAVED REGION";
  $("#save-roi").disabled = ui.roiSaving || !dirty || !framePreviewIsReady();
  renderRoiControls();
  drawRoiCanvas();
  updateSetupReadiness();
}

function renderConfig(config) {
  ui.configLoaded = Boolean(config);
  if (!ui.roiPoints.length && config?.roi_points) {
    ui.frameSize = config.frame_size || ui.frameSize;
    ui.savedRoi = config.roi_points.map((point) => [...point]);
    ui.roiPoints = config.roi_points.map((point) => [...point]);
    ui.defaultRoi = (config.default_roi_points || config.roi_points).map((point) => [...point]);
    const padding = roiEditorPadding();
    $("#roi-canvas").width = ui.frameSize.width + padding.x * 2;
    $("#roi-canvas").height = ui.frameSize.height + padding.y * 2;
    $("#roi-frame-size").textContent = `${ui.frameSize.width} × ${ui.frameSize.height} FRAME`;
    $(".roi-coordinates-head span:last-child").textContent = `${ui.frameSize.width} × ${ui.frameSize.height} PX`;
    updateRoiEditor();
  }
  if (config?.traffic_configuration && !ui.savedTrafficConfig) {
    const traffic = config.traffic_configuration;
    const saved = {
      flow_angle_deg: Number(traffic.flow_angle_deg ?? 0),
      road_length_m: traffic.road_length_m || 50,
      speed_limit: traffic.speed_limit || config.default_speed_limit || 30,
      detection_confidence: traffic.detection_confidence || 0.6,
    };
    ui.savedTrafficConfig = { ...saved };
    if (!ui.trafficTouched) {
      ui.flowAngle = saved.flow_angle_deg;
      $("#road-length").value = saved.road_length_m;
      $("#speed-limit").value = saved.speed_limit;
      $("#detection-confidence").value = saved.detection_confidence;
    }
  }
  renderModelConfig(config);
  renderTrafficControls();
}

function currentTrafficConfig() {
  return {
    flow_angle_deg: ui.flowAngle,
    road_length_m: Number($("#road-length").value),
    speed_limit: Number($("#speed-limit").value),
    detection_confidence: Number($("#detection-confidence").value),
  };
}

function trafficConfigDirty() {
  if (!ui.savedTrafficConfig) return ui.configLoaded;
  const current = currentTrafficConfig();
  return Object.keys(current).some((key) => typeof current[key] === "string"
    ? current[key] !== ui.savedTrafficConfig[key]
    : Math.abs(current[key] - Number(ui.savedTrafficConfig[key])) > 0.0001);
}

function sourceSelectionKey() {
  try {
    return JSON.stringify(sourceRequest());
  } catch {
    return null;
  }
}

function invalidateFramePreview(clearImage = true) {
  ui.previewSequence += 1;
  ui.previewReady = false;
  ui.previewSourceKey = null;
  clearTimeout(ui.previewTimer);
  const button = $("#capture-frame");
  if (button) {
    button.disabled = false;
    button.innerHTML = "<span>▣</span> Capture frame";
  }
  if (clearImage) {
    ui.roiImage = null;
    $("#roi-source-label").textContent = "Capture a frame from the selected source";
    $("#roi-empty-title").textContent = "Frame preview";
    $("#roi-empty-copy").textContent = "Select a source, then capture a frame to configure the region on the real view.";
    drawRoiCanvas();
  }
  updateRoiEditor();
}

function sourceIsReady() {
  const key = sourceSelectionKey();
  if (!key) return false;
  if (ui.sourceMode === "rtsp") {
    const request = sourceRequest();
    return request.source === "configured" ? Boolean(ui.config?.configured_feed) : Boolean(request.rtsp_url);
  }
  return ui.sourceMode !== "upload" || Boolean(ui.uploadId);
}

function framePreviewIsReady() {
  const key = sourceSelectionKey();
  return Boolean(ui.previewReady && key && ui.previewSourceKey === key);
}

function trafficProfileIsValid() {
  const traffic = currentTrafficConfig();
  return Number.isInteger(traffic.flow_angle_deg) && traffic.flow_angle_deg >= 0 && traffic.flow_angle_deg <= 359
    && Number.isFinite(traffic.road_length_m) && traffic.road_length_m >= 1 && traffic.road_length_m <= 10000
    && Number.isFinite(traffic.speed_limit) && traffic.speed_limit >= 1 && traffic.speed_limit <= 300
    && Number.isFinite(traffic.detection_confidence) && traffic.detection_confidence >= 0.05 && traffic.detection_confidence <= 0.99;
}

function updateSetupReadiness() {
  const summary = $("#setup-readiness-summary");
  if (!summary) return { canStart: false, message: "Finish session setup before starting." };

  const sourceReady = sourceIsReady();
  const frameReady = sourceReady && framePreviewIsReady();
  const zoneReady = frameReady && ui.roiPoints.length === 4 && pointsEqual(ui.roiPoints, ui.savedRoi);
  const trafficValid = trafficProfileIsValid();
  const trafficReady = ui.configLoaded && Boolean(ui.savedTrafficConfig) && trafficValid && !trafficConfigDirty();
  const modelReady = Boolean(ui.health?.model_loaded);
  const steps = [
    { id: "source", ready: sourceReady },
    { id: "frame", ready: frameReady },
    { id: "zone", ready: zoneReady },
    { id: "model", ready: modelReady },
    { id: "traffic", ready: trafficReady },
  ];
  const activeIndex = steps.findIndex((step) => !step.ready);
  steps.forEach((step, index) => {
    const element = $(`#setup-${step.id}-step`);
    const state = $(`#setup-${step.id}-state`);
    if (!element || !state) return;
    element.classList.toggle("complete", step.ready);
    element.classList.toggle("current", !step.ready && index === activeIndex);
    state.textContent = step.ready ? "READY" : index === activeIndex ? "NEXT" : "WAITING";
    if (step.id === "traffic" && !trafficValid && index === activeIndex) state.textContent = "CHECK";
  });

  const running = Boolean(ui.status?.running || ["starting", "stopping"].includes(ui.status?.state));
  let message = "Ready to start monitoring.";
  if (ui.uploading) message = "Your video is uploading…";
  else if (!sourceReady) message = "Choose a camera, stream, or uploaded video to begin.";
  else if (!frameReady) message = "Capture a frame from the selected source to continue.";
  else if (!ui.configLoaded) message = "Loading VIDES configuration…";
  else if (!zoneReady) message = "Apply the detection region shown on the selected frame.";
  else if (!modelReady) message = ui.health?.model_loading ? "The selected detection model is loading…" : "Load the selected detection model before starting.";
  else if (!trafficValid) message = "Correct the traffic profile values before applying them.";
  else if (!trafficReady) message = "Apply your traffic settings to complete setup.";
  else if (running) message = "A detection session is active or starting.";
  else if (ui.starting) message = "Starting the detection session…";
  else if (!ui.health) message = "Connect to the VIDES API before starting detection.";
  else if (!ui.health.ok) message = "Resolve the system health items before starting detection.";

  summary.textContent = message;
  const canStart = steps.every((step) => step.ready) && Boolean(ui.health?.ok) && !running && !ui.uploading && !ui.starting;
  ui.start.disabled = !canStart;
  return { canStart, message };
}

function renderTrafficControls() {
  const angle = ((Math.round(Number(ui.flowAngle) || 0) % 360) + 360) % 360;
  ui.flowAngle = angle;
  $("#flow-arrow").setAttribute("transform", `rotate(${angle} 70 70)`);
  $("#flow-angle-value").textContent = `${angle}°`;
  $("#flow-angle").value = String(angle);
  $("#flow-dial").setAttribute("aria-valuenow", String(angle));
  $("#flow-dial").setAttribute("aria-valuetext", `${angle} degrees clockwise from up`);
  const confidence = Number($("#detection-confidence").value || 0.6);
  $("#confidence-value").textContent = `${Math.round(confidence * 100)}%`;
  const dirty = trafficConfigDirty();
  const badge = $("#traffic-state");
  badge.classList.toggle("unsaved", dirty);
  const valid = trafficProfileIsValid();
  badge.classList.toggle("invalid", !valid);
  badge.textContent = !ui.configLoaded ? "LOADING" : !valid ? "CHECK VALUES" : dirty ? "UNSAVED" : "SAVED";
  $("#save-traffic").disabled = !ui.configLoaded || !dirty || !valid;
  updateSetupReadiness();
}

function renderModelConfig(config) {
  const select = $("#detector-model");
  if (!select || !config) return;
  const modelNames = [...new Set([...(config.models || []), config.model_name].filter(Boolean))];
  const selected = ui.modelSelection || config.model_name || modelNames[0] || "";
  const currentOptions = [...select.options].map((option) => option.value);
  if (currentOptions.join("\n") !== modelNames.join("\n")) {
    select.replaceChildren(...modelNames.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      return option;
    }));
  }
  if (modelNames.includes(selected)) select.value = selected;

  const state = config.model_state || ui.health?.model_state || "unloaded";
  const loaded = Boolean(config.model_loaded || ui.health?.model_loaded);
  const loading = Boolean(config.model_loading || ui.health?.model_loading);
  const currentModel = config.model_name || ui.health?.model_name || "";
  const running = Boolean(ui.status?.running);
  select.disabled = running || loading;
  const label = $("#model-config-state");
  label.textContent = loading ? "Loading…" : loaded ? "Loaded" : state === "error" ? "Load failed" : "Not loaded";
  label.classList.toggle("loaded", loaded);
  label.classList.toggle("loading", loading);
  label.classList.toggle("failed", state === "error");
  $("#model-config-note").textContent = loading
    ? `Loading ${currentModel}. Detection will be available as soon as the model is ready.`
    : state === "error"
      ? (config.model_error || ui.health?.model_error || "The model could not be loaded. Choose another model and retry.")
      : loaded
        ? `${currentModel} is active and ready. Only one model is kept in memory at a time.`
        : "Choose a model and wait for it to load before starting detection.";
  const loadButton = $("#load-model");
  loadButton.disabled = running || loading || !select.value || (loaded && select.value === currentModel);
  loadButton.textContent = loading ? "Loading…" : loaded && select.value === currentModel ? "Loaded" : "Load model";
  if (ui.modelSelection && currentModel === ui.modelSelection && !loading) ui.modelSelection = null;
}

async function saveTrafficSettings(showFeedback = true) {
  const traffic = currentTrafficConfig();
  if (!Number.isFinite(traffic.road_length_m) || traffic.road_length_m < 1 || traffic.road_length_m > 10000) {
    if (showFeedback) showToast("Enter a known road length between 1 and 10,000 metres.", true);
    return false;
  }
  if (!Number.isFinite(traffic.speed_limit) || traffic.speed_limit < 1 || traffic.speed_limit > 300) {
    if (showFeedback) showToast("Enter a speed limit between 1 and 300 km/h.", true);
    return false;
  }
  const confidence = traffic.detection_confidence;
  if (!Number.isFinite(confidence) || confidence < 0.05 || confidence > 0.99) {
    if (showFeedback) showToast("Choose a detection confidence between 5% and 99%.", true);
    return false;
  }
  const button = $("#save-traffic");
  button.disabled = true;
  $("#traffic-state").textContent = "SAVING";
  try {
    const result = await api("/api/config/traffic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(traffic),
    });
    ui.savedTrafficConfig = { ...traffic };
    ui.config = { ...ui.config, default_speed_limit: traffic.speed_limit, traffic_configuration: result.traffic_configuration };
    if (showFeedback) showToast(result.applied_live ? "Traffic settings applied to the running detector." : "Traffic settings saved for detection.");
    return true;
  } catch (error) {
    if (showFeedback) showToast(error.message || "Could not save traffic settings.", true);
    return false;
  } finally {
    renderTrafficControls();
  }
}

async function loadSelectedModel() {
  const modelName = $("#detector-model").value;
  if (!modelName) {
    showToast("No detection model is available in VIDES/models.", true);
    return;
  }
  ui.modelSelection = modelName;
  $("#detector-model").disabled = true;
  $("#load-model").disabled = true;
  $("#load-model").textContent = "Loading…";
  $("#model-config-state").textContent = "Starting…";
  $("#model-config-state").classList.add("loading");
  $("#model-config-note").textContent = "Starting " + modelName + ". The previous model is released before this one loads.";
  try {
    await api("/api/config/model", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_name: modelName }),
    });
    showToast(`Loading ${modelName}. Start detection will unlock when it is ready.`);
    await refresh();
  } catch (error) {
    ui.modelSelection = null;
    $("#detector-model").disabled = false;
    showToast(error.message || "Could not load the selected model.", true);
    await refresh();
  }
}

async function restartApplication() {
  if (!window.confirm("Restart VIDES now? The current session and its in-memory event records will be cleared.")) return;
  const button = $("#restart-app");
  button.disabled = true;
  try {
    await api("/api/system/restart", { method: "POST" });
    showToast("VIDES is restarting. The page will reconnect shortly.");
    const reconnect = async () => {
      try {
        await api("/api/health");
        window.history.replaceState({}, "", "#configure");
        window.location.reload();
      } catch {
        setTimeout(reconnect, 900);
      }
    };
    setTimeout(reconnect, 1400);
  } catch (error) {
    button.disabled = false;
    showToast(error.message || "Could not restart VIDES.", true);
  }
}

function setFlowAngle(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return;
  ui.flowAngle = ((Math.round(numeric) % 360) + 360) % 360;
  ui.trafficTouched = true;
  renderTrafficControls();
}

function bindFlowDial() {
  const dial = $("#flow-dial");
  const updateFromPointer = (event) => {
    const rect = dial.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    setFlowAngle(Math.atan2(dx, -dy) * 180 / Math.PI);
  };
  dial.addEventListener("pointerdown", (event) => {
    ui.flowDragging = true;
    dial.setPointerCapture(event.pointerId);
    updateFromPointer(event);
    event.preventDefault();
  });
  dial.addEventListener("pointermove", (event) => {
    if (ui.flowDragging) updateFromPointer(event);
  });
  const release = () => { ui.flowDragging = false; };
  dial.addEventListener("pointerup", release);
  dial.addEventListener("pointercancel", release);
  dial.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 15 : 1;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") setFlowAngle(ui.flowAngle + step);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") setFlowAngle(ui.flowAngle - step);
    else if (event.key === "Home") setFlowAngle(0);
    else if (event.key === "End") setFlowAngle(359);
    else return;
    event.preventDefault();
  });
  $("#flow-angle").addEventListener("input", (event) => setFlowAngle(event.target.value));
}

function formatVideoTime(seconds, tenths = false) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${tenths ? remainder.toFixed(1).padStart(4, "0") : String(Math.floor(remainder)).padStart(2, "0")}`;
}

function updateFrameSelector() {
  const fps = Number(ui.videoMetadata?.fps || 0);
  const seconds = fps > 0 ? ui.previewFrameIndex / fps : 0;
  $("#video-frame-time").textContent = formatVideoTime(seconds, true);
  $("#video-frame-number").textContent = `FRAME ${ui.previewFrameIndex.toLocaleString()}`;
  $("#video-frame-slider").value = String(ui.previewFrameIndex);
}

function queueUploadedFramePreview() {
  ui.previewFrameIndex = Number($("#video-frame-slider").value || 0);
  invalidateFramePreview();
  updateFrameSelector();
  clearTimeout(ui.previewTimer);
  ui.previewTimer = setTimeout(() => captureFrame(), 180);
}

function sourceRequest() {
  const request = { source: ui.sourceMode };
  if (ui.sourceMode === "camera") request.camera_index = Number($("#camera-index").value || 0);
  if (ui.sourceMode === "rtsp") {
    request.source = $("#rtsp-url").dataset.configured === "true" ? "configured" : "rtsp";
    if (request.source === "rtsp") request.rtsp_url = $("#rtsp-url").value.trim();
  }
  if (ui.sourceMode === "upload") {
    if (!ui.uploadId) throw new Error("Upload a video before capturing its frame.");
    request.upload_id = ui.uploadId;
  }
  return request;
}

async function captureFrame() {
  const button = $("#capture-frame");
  const previewSequence = ++ui.previewSequence;
  ui.previewReady = false;
  ui.previewSourceKey = null;
  updateSetupReadiness();
  updateRoiEditor();
  button.disabled = true;
  button.innerHTML = "<span>◌</span> Capturing…";
  if (!ui.roiImage) {
    $("#roi-empty-title").textContent = "Loading frame…";
    $("#roi-empty-copy").textContent = "VIDES is decoding a preview from the selected video source.";
  }
  $("#roi-feedback").className = "roi-feedback";
  $("#roi-feedback").textContent = "Loading a preview frame from the selected source…";
  try {
    const request = sourceRequest();
    const requestedSourceKey = JSON.stringify(request);
    if (request.source === "upload") request.frame_index = ui.previewFrameIndex;
    const result = await api("/api/session/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("The selected frame could not be displayed."));
      image.src = `data:image/jpeg;base64,${result.image_base64}`;
    });
    if (previewSequence !== ui.previewSequence) return;
    ui.roiImage = image;
    if (requestedSourceKey === sourceSelectionKey()) {
      ui.previewReady = true;
      ui.previewSourceKey = requestedSourceKey;
    }
    if (request.source === "upload") {
      ui.previewFrameIndex = Number(result.frame_index ?? ui.previewFrameIndex);
      updateFrameSelector();
    }
    drawRoiCanvas();
    const frameDescription = request.source === "upload"
      ? ` · frame ${ui.previewFrameIndex.toLocaleString()} · ${formatVideoTime(result.time_seconds, true)}`
      : result.live_frame ? " · live frame" : " · captured frame";
    $("#roi-source-label").textContent = `${result.source_label}${frameDescription}`;
    $("#roi-feedback").className = "roi-feedback success";
    $("#roi-feedback").textContent = "Frame loaded. Drag the green handles or edit point coordinates.";
    updateRoiEditor();
  } catch (error) {
    if (previewSequence !== ui.previewSequence) return;
    ui.roiImage = null;
    drawRoiCanvas();
    $("#roi-empty-title").textContent = "Preview unavailable";
    $("#roi-empty-copy").textContent = error.message || "VIDES could not read a frame from this source.";
    $("#roi-feedback").className = "roi-feedback error";
    $("#roi-feedback").textContent = error.message || "Could not capture a frame from this source.";
    showToast(error.message || "Could not capture a frame from this source.", true);
    updateRoiEditor();
  } finally {
    if (previewSequence === ui.previewSequence) {
      button.disabled = false;
      button.innerHTML = "<span>▣</span> Capture frame";
    }
  }
}

async function saveRoi() {
  ui.roiSaving = true;
  updateRoiEditor();
  $("#roi-feedback").className = "roi-feedback";
  $("#roi-feedback").textContent = "Checking geometry and applying region…";
  try {
    const result = await api("/api/config/roi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: ui.roiPoints }),
    });
    ui.savedRoi = result.roi_points.map((point) => [...point]);
    ui.roiPoints = result.roi_points.map((point) => [...point]);
    $("#roi-feedback").className = "roi-feedback success";
    $("#roi-feedback").textContent = result.applied_live
      ? "Region saved and applied to the next processed frame."
      : "Region saved. It will be used for the next detection session.";
    showToast("Detection region saved.");
  } catch (error) {
    $("#roi-feedback").className = "roi-feedback error";
    $("#roi-feedback").textContent = error.message || "Could not apply this region.";
  } finally {
    ui.roiSaving = false;
    updateRoiEditor();
  }
}

function resetRoi() {
  ui.roiPoints = ui.defaultRoi.map((point) => [...point]);
  $("#roi-feedback").className = "roi-feedback";
  $("#roi-feedback").textContent = "Default corners loaded. Apply region to save them.";
  updateRoiEditor();
}

async function downloadReport() {
  const format = $("#report-format").value;
  const button = $("#download-report");
  button.disabled = true;
  try {
    const response = await fetch(`/api/reports/download?format=${encodeURIComponent(format)}`, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.detail || `Report download failed (${response.status})`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `vides-report.${format}`;
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`${format.toUpperCase()} session report downloaded.`);
  } catch (error) {
    showToast(error.message || "Could not download the report.", true);
  } finally {
    button.disabled = !ui.status?.run_id;
  }
}

function bindRoiCanvas() {
  const canvas = $("#roi-canvas");
  const pointAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const padding = roiEditorPadding();
    const extensionX = Math.ceil(ui.frameSize.width * ROI_EXTENSION_RATIO);
    const extensionY = Math.ceil(ui.frameSize.height * ROI_EXTENSION_RATIO);
    const canvasX = (event.clientX - rect.left) * canvas.width / rect.width;
    const canvasY = (event.clientY - rect.top) * canvas.height / rect.height;
    return {
      x: Math.max(-extensionX, Math.min(ui.frameSize.width + extensionX, canvasX - padding.x)),
      y: Math.max(-extensionY, Math.min(ui.frameSize.height + extensionY, canvasY - padding.y)),
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (ui.roiPoints.length !== 4) return;
    const position = pointAt(event);
    let nearest = -1;
    let distance = 22;
    ui.roiPoints.forEach(([x, y], index) => {
      const candidate = Math.hypot(position.x - x, position.y - y);
      if (candidate < distance) { nearest = index; distance = candidate; }
    });
    if (nearest >= 0) {
      ui.draggedPoint = nearest;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (ui.draggedPoint === null) return;
    const position = pointAt(event);
    ui.roiPoints[ui.draggedPoint] = [position.x, position.y];
    updateRoiEditor();
  });
  const release = () => { ui.draggedPoint = null; };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
}

function renderEvents(events = [], eventCounts = {}) {
  const total = Object.values(eventCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  const priority = events.filter((event) => ["high", "critical"].includes(event.severity)).length;
  $("#metric-events").textContent = String(total);
  $("#event-foot").textContent = total ? `${priority} priority event${priority === 1 ? "" : "s"} to review` : "No incidents reported";
  $("#nav-event-count").textContent = String(total);
  $("#incident-total").textContent = String(total);
  $("#event-total-chip").textContent = `${total} total`;
  $("#incident-foot-text").textContent = total ? `${priority} high priority · ${total - priority} other` : "Listening for traffic events";
  $(".incident-foot-dot").classList.toggle("has-events", total > 0);
  const byType = eventCounts || {};
  $("#count-overspeed").textContent = String(byType.overspeed || 0);
  $("#count-opposite").textContent = String(byType.opposite_direction || 0);
  $("#count-stalling").textContent = String(byType.stalling || 0);
  $("#count-accident").textContent = String(byType.accident || 0);
  $("#count-heavy").textContent = String(byType.heavy_vehicle || 0);

  let filtered = events;
  if (ui.filter === "priority") filtered = events.filter((event) => ["high", "critical"].includes(event.severity));
  if (ui.filter === "overspeed") filtered = events.filter((event) => event.type === "overspeed");
  $("#event-footer-copy").textContent = events.length ? `Showing ${filtered.length} of ${events.length} session records` : "No session records yet";
  const body = $("#event-table-body");
  body.replaceChildren();
  if (!filtered.length) {
    const row = document.createElement("tr");
    row.className = "empty-event-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    const empty = document.createElement("div");
    empty.className = "table-empty";
    const icon = document.createElement("span");
    icon.textContent = "≋";
    const title = document.createElement("strong");
    title.textContent = events.length ? "No matching events" : "No events yet";
    const note = document.createElement("small");
    note.textContent = events.length ? "Try a different event filter." : "When VIDES detects an event, it will appear here.";
    empty.append(icon, title, note);
    cell.append(empty);
    row.append(cell);
    body.append(row);
    return;
  }

  for (const event of filtered) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = `event-badge ${event.type || ""}`;
    name.textContent = eventLabels[event.type] || event.type || "Event";
    nameCell.append(name);
    const vehicleCell = document.createElement("td");
    const vehicle = document.createElement("span");
    vehicle.className = "vehicle-chip";
    vehicle.textContent = (event.track_ids || []).map((id) => `ID ${id}`).join(", ") || "—";
    vehicleCell.append(vehicle);
    const detailCell = document.createElement("td");
    detailCell.className = "event-detail";
    detailCell.title = event.detail || "";
    detailCell.textContent = event.detail || "—";
    const timeCell = document.createElement("td");
    timeCell.className = "event-time";
    timeCell.textContent = formatEventTime(event.occurred_at);
    const levelCell = document.createElement("td");
    const level = document.createElement("span");
    level.className = `severity-badge ${event.severity || "medium"}`;
    level.textContent = event.severity || "medium";
    levelCell.append(level);
    row.append(nameCell, vehicleCell, detailCell, timeCell, levelCell);
    body.append(row);
  }
}

function updateSparklines(status, eventCounts, health) {
  const samples = {
    vehicles: Number(status?.total_vehicles || 0),
    events: Object.values(eventCounts || {}).reduce((sum, count) => sum + Number(count || 0), 0),
    speed: Number(status?.average_speed || 0),
    engine: health?.ok ? 1 : 0,
  };
  for (const [name, value] of Object.entries(samples)) {
    const history = ui.history[name];
    history.push(value);
    if (history.length > 12) history.shift();
    const max = Math.max(...history, 1);
    const bars = $(`[data-series="${name}"]`).children;
    [...bars].forEach((bar, index) => {
      const sample = history[Math.max(0, history.length - bars.length + index)] ?? 0;
      const height = name === "engine" ? (sample ? 92 : 14) : 14 + Math.round((sample / max) * 78);
      bar.style.height = `${height}%`;
    });
  }
}

async function refresh() {
  try {
    const [health, config, status] = await Promise.all([
      api("/api/health"),
      api("/api/config"),
      api("/api/status"),
    ]);
    ui.health = health;
    ui.config = config;
    ui.status = status;
    renderHealth(health, config);
    renderConfig(config);
    setVideoState(status);
    renderEvents(status.events || [], status.event_counts || {});
    updateSparklines(status, status.event_counts || {}, health);
  } catch (error) {
    ui.health = null;
    ui.status = null;
    renderHealth(null, ui.config);
    setVideoState(null);
    $("#source-summary-title").textContent = "VIDES API offline";
    $("#source-summary-subtitle").textContent = "Start the backend service";
  }
}

function selectSource(mode) {
  ui.sourceMode = mode;
  invalidateFramePreview();
  $$(".source-tab").forEach((tab) => {
    const selected = tab.dataset.source === mode;
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  $("#camera-input-row").hidden = mode !== "camera";
  $("#rtsp-input-row").hidden = mode !== "rtsp";
  $("#upload-input-row").hidden = mode !== "upload";
  $("#upload-frame-selector").hidden = mode !== "upload" || !ui.videoMetadata || Number(ui.videoMetadata.frame_count) <= 1;
  if (mode === "upload" && ui.uploadId) captureFrame();
  updateSetupReadiness();
}

async function startDetection() {
  const readiness = updateSetupReadiness();
  if (!readiness.canStart) {
    showToast(readiness.message, true);
    return;
  }
  const speedLimit = Number($("#speed-limit").value);
  if (!Number.isFinite(speedLimit) || speedLimit < 1 || speedLimit > 300) {
    showToast("Enter a speed limit between 1 and 300 km/h.", true);
    return;
  }
  let body;
  try {
    body = sourceRequest();
  } catch (error) {
    showToast(error.message, true);
    return;
  }
  body.speed_limit = speedLimit;
  ui.starting = true;
  updateSetupReadiness();
  try {
    const response = await api("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    ui.runId = response.run_id;
    ui.image.src = `/api/stream?run=${encodeURIComponent(response.run_id)}`;
    ui.image.classList.remove("visible");
    $("#video-error").hidden = true;
    ui.starting = false;
    ui.status = { ...(ui.status || {}), running: true, state: "starting", run_id: response.run_id };
    updateSetupReadiness();
    activateWorkspaceView("monitor");
    showToast("Detection session started.");
    await refresh();
  } catch (error) {
    ui.starting = false;
    updateSetupReadiness();
    showToast(error.message || "Could not start the detection session.", true);
    await refresh();
  }
}

async function stopDetection() {
  ui.stop.disabled = true;
  try {
    await api("/api/session/stop", { method: "POST" });
    showToast("Stopping detection session…");
    await refresh();
  } catch (error) {
    showToast(error.message || "Could not stop the session.", true);
  }
}

async function uploadFile(file) {
  if (!file) return;
  if (file.size > 500 * 1024 * 1024) {
    showToast("Video upload limit is 500 MB.", true);
    return;
  }
  const validExtensions = /\.(mp4|avi|mov|mkv|webm|m4v)$/i;
  if (!validExtensions.test(file.name)) {
    showToast("Choose an MP4, AVI, MOV, MKV, WebM, or M4V video.", true);
    return;
  }
  ui.uploadId = null;
  ui.uploadName = file.name;
  invalidateFramePreview();
  ui.videoMetadata = null;
  ui.previewFrameIndex = 0;
  $("#upload-frame-selector").hidden = true;
  drawRoiCanvas();
  ui.uploading = true;
  $("#upload-title").textContent = file.name;
  $("#upload-subtitle").textContent = `${(file.size / (1024 * 1024)).toFixed(1)} MB · uploading…`;
  $("#upload-progress").hidden = false;
  updateSetupReadiness();
  const form = new FormData();
  form.append("file", file, file.name);
  try {
    const result = await api("/api/session/upload", { method: "POST", body: form });
    ui.uploadId = result.upload_id;
    ui.videoMetadata = { fps: result.fps, frame_count: result.frame_count, duration_seconds: result.duration_seconds };
    ui.previewFrameIndex = 0;
    const slider = $("#video-frame-slider");
    slider.max = String(Math.max(0, Number(result.frame_count || 1) - 1));
    $("#video-duration").textContent = formatVideoTime(result.duration_seconds);
    $("#upload-frame-selector").hidden = ui.sourceMode !== "upload" || Number(result.frame_count) <= 1;
    updateFrameSelector();
    $("#upload-title").textContent = result.filename;
    $("#upload-subtitle").textContent = `${(result.size_bytes / (1024 * 1024)).toFixed(1)} MB · ready to process`;
    showToast("Video uploaded. Preview a frame and complete the setup steps to continue.");
    if (ui.sourceMode === "upload") {
      if (ui.currentView === "configure") {
        $("#configurator").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      await captureFrame();
    }
  } catch (error) {
    $("#upload-title").textContent = "Upload failed — choose another file";
    $("#upload-subtitle").textContent = "Check the file format and backend status";
    showToast(error.message || "Could not upload this video.", true);
  } finally {
    $("#upload-progress").hidden = true;
    ui.uploading = false;
    updateSetupReadiness();
    $("#video-file").value = "";
  }
}

function bindDocsTabs() {
  const tabs = $("#docs-view") ? $$("#docs-view [data-doc-tab]") : [];
  const panels = $("#docs-view") ? $$("#docs-view [data-doc-panel]") : [];
  if (!tabs.length || !panels.length) return;

  const activate = (selectedTab, moveFocus = false) => {
    tabs.forEach((tab) => {
      const selected = tab === selectedTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.docPanel !== selectedTab.dataset.docTab;
    });
    if (moveFocus) selectedTab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      let nextIndex = index;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft") nextIndex = (index + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[nextIndex], true);
    });
  });
}

function bindEvents() {
  $$(".source-tab").forEach((tab) => tab.addEventListener("click", () => selectSource(tab.dataset.source)));
  ui.start.addEventListener("click", startDetection);
  ui.stop.addEventListener("click", stopDetection);
  $("#restart-app").addEventListener("click", restartApplication);
  $("#load-model").addEventListener("click", loadSelectedModel);
  $("#detector-model").addEventListener("change", (event) => {
    ui.modelSelection = event.target.value;
    loadSelectedModel();
  });
  $("#refresh-button").addEventListener("click", refresh);
  $("#capture-frame").addEventListener("click", captureFrame);
  $("#save-roi").addEventListener("click", saveRoi);
  $("#reset-roi").addEventListener("click", resetRoi);
  $("#save-traffic").addEventListener("click", () => saveTrafficSettings());
  $("#download-report").addEventListener("click", downloadReport);
  $("#speed-limit").addEventListener("input", () => { ui.speedLimitTouched = true; ui.trafficTouched = true; renderTrafficControls(); });
  $("#road-length").addEventListener("input", () => { ui.trafficTouched = true; renderTrafficControls(); });
  $("#detection-confidence").addEventListener("input", () => { ui.trafficTouched = true; renderTrafficControls(); });
  $("#video-frame-slider").addEventListener("input", queueUploadedFramePreview);
  $("#camera-index").addEventListener("change", () => invalidateFramePreview());
  $("#rtsp-url").addEventListener("input", () => {
    $("#rtsp-url").dataset.configured = "false";
    $("#configured-feed-button").textContent = "Use configured feed";
    $("#configured-feed-button").classList.remove("selected");
    invalidateFramePreview();
  });
  $("#upload-drop").addEventListener("click", () => $("#video-file").click());
  $("#video-file").addEventListener("change", (event) => uploadFile(event.target.files?.[0]));
  $("#configured-feed-button").addEventListener("click", () => {
    $("#rtsp-url").dataset.configured = "true";
    $("#rtsp-url").value = "Configured in VIDES/.env";
    $("#configured-feed-button").textContent = "Configured feed selected";
    $("#configured-feed-button").classList.add("selected");
    invalidateFramePreview();
  });
  const drop = $("#upload-drop");
  ["dragenter", "dragover"].forEach((eventName) => drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.add("drag-over");
  }));
  ["dragleave", "drop"].forEach((eventName) => drop.addEventListener(eventName, (event) => {
    event.preventDefault();
    drop.classList.remove("drag-over");
  }));
  drop.addEventListener("drop", (event) => uploadFile(event.dataTransfer?.files?.[0]));
  $$(".event-filter").forEach((button) => button.addEventListener("click", () => {
    ui.filter = button.dataset.filter;
    $$(".event-filter").forEach((filterButton) => filterButton.classList.toggle("active", filterButton === button));
    renderEvents(ui.status?.events || [], ui.status?.event_counts || {});
  }));
  bindDocsTabs();
  $$('[data-view-target]').forEach((target) => target.addEventListener("click", (event) => {
    event.preventDefault();
    activateWorkspaceView(target.dataset.viewTarget);
  }));
  ui.image.addEventListener("load", () => {
    ui.image.classList.add("visible");
    $("#video-empty").style.display = "none";
  });
  ui.image.addEventListener("error", () => {
    if (ui.status?.running && !ui.status?.frame_ready) return;
    ui.image.classList.remove("visible");
  });
}

function boot() {
  $("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date());
  if (ui.image.complete && ui.image.naturalWidth) ui.image.classList.add("visible");
  bindRoiCanvas();
  bindFlowDial();
  bindEvents();
  activateWorkspaceView(viewFromHash(), false);
  renderTrafficControls();
  window.addEventListener("popstate", () => activateWorkspaceView(viewFromHash(), false));
  refresh();
  ui.refreshTimer = setInterval(refresh, 1800);
}

document.addEventListener("DOMContentLoaded", boot);
