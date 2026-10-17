"""VIDES API and video-processing service.

Run from the VIDES directory with ``uvicorn app.main:app --reload``.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import gc
import importlib.util
import io
import json
import math
import multiprocessing
import tempfile
import threading
import time
import uuid
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.config import settings


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
UPLOAD_DIR = Path(tempfile.gettempdir()) / "vides-uploads"
ROI_CONFIG_PATH = PROJECT_ROOT / "config" / "roi.json"
TRAFFIC_CONFIG_PATH = PROJECT_ROOT / "config" / "traffic.json"
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
ROI_EXTENSION_RATIO = 0.25
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}
uploads: dict[str, Path] = {}
upload_names: dict[str, str] = {}
upload_metadata: dict[str, dict] = {}

FLOW_DIRECTIONS = {
    "toward_top": 0,
    "right_to_left": 270,
    "left_to_right": 90,
    "toward_bottom": 180,
}
DEFAULT_TRAFFIC_CONFIG = {
    "flow_angle_deg": 0,
    "road_length_m": 50.0,
    "speed_limit": float(settings.speed_limit),
    "detection_confidence": 0.6,
}


class StartRequest(BaseModel):
    source: Literal["camera", "rtsp", "configured", "upload"]
    camera_index: int = Field(default=0, ge=0, le=20)
    rtsp_url: str | None = None
    upload_id: str | None = None
    speed_limit: float | None = Field(default=None, ge=1, le=300)


class PreviewRequest(BaseModel):
    source: Literal["camera", "rtsp", "configured", "upload"]
    camera_index: int = Field(default=0, ge=0, le=20)
    rtsp_url: str | None = None
    upload_id: str | None = None
    frame_index: int = Field(default=0, ge=0)


class RoiRequest(BaseModel):
    points: list[tuple[float, float]] = Field(min_length=4, max_length=4)


class TrafficConfigRequest(BaseModel):
    flow_angle_deg: int | None = Field(default=None, ge=0, le=359)
    # Accept saved settings and requests from older VIDES frontends during migration.
    flow_direction: Literal["toward_top", "toward_bottom", "left_to_right", "right_to_left"] | None = None
    road_length_m: float = Field(ge=1, le=10000)
    speed_limit: float = Field(ge=1, le=300)
    detection_confidence: float = Field(ge=0.05, le=0.99)


class ModelSelectionRequest(BaseModel):
    model_name: str = Field(min_length=1, max_length=255)


def normalize_traffic_config(data: dict) -> dict:
    normalized = dict(data)
    if normalized.get("flow_angle_deg") is None:
        normalized["flow_angle_deg"] = FLOW_DIRECTIONS.get(normalized.get("flow_direction"), 0)
    normalized.pop("flow_direction", None)
    return normalized


def load_traffic_config() -> dict:
    try:
        saved = json.loads(TRAFFIC_CONFIG_PATH.read_text())
        if "flow_angle_deg" not in saved and saved.get("flow_direction") in FLOW_DIRECTIONS:
            saved["flow_angle_deg"] = FLOW_DIRECTIONS[saved["flow_direction"]]
        merged = normalize_traffic_config({**DEFAULT_TRAFFIC_CONFIG, **saved})
        request = TrafficConfigRequest(**merged)
        return normalize_traffic_config(request.dict())
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return dict(DEFAULT_TRAFFIC_CONFIG)


def apply_traffic_config(config: dict) -> dict:
    selected = normalize_traffic_config(TrafficConfigRequest(**config).dict())
    angle = math.radians(selected["flow_angle_deg"])
    direction = [math.sin(angle), -math.cos(angle)]
    longitudinal_pixels = abs(direction[0]) * settings.dst_width + abs(direction[1]) * settings.dst_height
    selected["expected_movement"] = direction
    selected["meters_per_pixel"] = selected["road_length_m"] / longitudinal_pixels
    settings.expected_movement = direction[:]
    settings.meters_per_pixel = selected["meters_per_pixel"]
    settings.speed_limit = selected["speed_limit"]
    settings.detection_confidence = selected["detection_confidence"]
    return selected


TRAFFIC_CONFIG = apply_traffic_config(load_traffic_config())


class ModelManager:
    """Loads exactly one inference model and exposes its readiness to the UI."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._model = None
        self._path = Path(settings.model_path)
        self._state = "unloaded"
        self._error: str | None = None
        self._generation = 0

    def snapshot(self) -> dict:
        with self._lock:
            model_path = self._path
            return {
                "model_name": model_path.name,
                "model_path": str(model_path),
                "model_exists": model_path.is_file(),
                "model_state": self._state,
                "model_loaded": self._state == "loaded" and self._model is not None,
                "model_loading": self._state == "loading",
                "model_error": self._error,
            }

    def available_models(self) -> list[str]:
        return sorted(path.name for path in (PROJECT_ROOT / "models").glob("*.pt") if path.is_file())

    def request_load(self, path: Path) -> dict:
        with self._lock:
            if self._state == "loading":
                if path.resolve() == self._path.resolve():
                    return self.snapshot()
                raise RuntimeError("A model is already loading. Wait for it to finish before choosing another.")
            if self._state == "loaded" and path.resolve() == self._path.resolve():
                return self.snapshot()
            self._model = None
            self._path = path
            settings.model_path = path
            self._state = "loading"
            self._error = None
            self._generation += 1
            generation = self._generation
        gc.collect()

        def load() -> None:
            try:
                import torch
                from ultralytics import YOLO

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                if not path.is_file():
                    raise RuntimeError(f"Model file was not found: {path}")
                loaded_model = YOLO(str(path))
                with self._lock:
                    if generation == self._generation:
                        self._model = loaded_model
                        self._state = "loaded"
                        self._error = None
            except Exception as exc:
                with self._lock:
                    if generation == self._generation:
                        self._model = None
                        self._state = "error"
                        self._error = str(exc)

        threading.Thread(target=load, daemon=True, name="vides-model-loader").start()
        return self.snapshot()

    def loaded_model(self):
        with self._lock:
            if self._state != "loaded" or self._model is None:
                raise RuntimeError("The selected detection model is still loading or failed to load.")
            return self._model


model_manager = ModelManager()


def validate_roi(points: list[tuple[float, float]]) -> list[list[float]]:
    clean = [[float(x), float(y)] for x, y in points]
    max_x_extension = math.ceil(settings.dst_width * ROI_EXTENSION_RATIO)
    max_y_extension = math.ceil(settings.dst_height * ROI_EXTENSION_RATIO)
    for x, y in clean:
        if not math.isfinite(x) or not math.isfinite(y):
            raise HTTPException(status_code=422, detail="ROI coordinates must be finite numbers.")
        if not -max_x_extension <= x <= settings.dst_width + max_x_extension or not -max_y_extension <= y <= settings.dst_height + max_y_extension:
            raise HTTPException(status_code=422, detail="ROI corners may extend up to 25% beyond each frame edge.")
    turns = []
    area_twice = 0.0
    for index, point in enumerate(clean):
        next_point = clean[(index + 1) % 4]
        after_next = clean[(index + 2) % 4]
        turns.append((next_point[0] - point[0]) * (after_next[1] - next_point[1]) -
                     (next_point[1] - point[1]) * (after_next[0] - next_point[0]))
        area_twice += point[0] * next_point[1] - next_point[0] * point[1]
    if abs(area_twice) < 1200 or not (all(value > 0 for value in turns) or all(value < 0 for value in turns)):
        raise HTTPException(status_code=422, detail="Arrange the four corners in order around a non-crossing detection area.")
    return clean


def load_saved_roi() -> list[list[float]]:
    try:
        stored = json.loads(ROI_CONFIG_PATH.read_text())
        return validate_roi([tuple(point) for point in stored])
    except (OSError, ValueError, TypeError, json.JSONDecodeError, HTTPException):
        return [[float(x), float(y)] for x, y in settings.src_pts.tolist()]


DEFAULT_ROI_POINTS = [[float(x), float(y)] for x, y in settings.src_pts.tolist()]
settings.src_pts = np.asarray(load_saved_roi(), dtype=np.float32)


class DetectionSession:
    """Owns one capture loop and exposes a thread-safe view for the UI."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None
        self._source: int | str | None = None
        self._roi_points = [[float(x), float(y)] for x, y in settings.src_pts.tolist()]
        self._traffic_config = dict(TRAFFIC_CONFIG)
        self._active_traffic_config = dict(TRAFFIC_CONFIG)
        self._frame: bytes | None = None
        self._frame_number = 0
        self._data: dict = {}
        self._reset_data()

    def _reset_data(self) -> None:
        self._data = {
            "state": "idle",
            "run_id": None,
            "source_label": None,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "speed_limit": 30,
            "traffic_configuration": {},
            "detection_region": [],
            "frame_size": {"width": settings.dst_width, "height": settings.dst_height},
            "fps": 0,
            "total_vehicles": 0,
            "vehicles_by_class": {},
            "average_speed": 0,
            "event_counts": {},
            "events": [],
        }
        self._frame = None
        self._frame_number = 0

    def start(self, source: int | str, source_label: str, speed_limit: float) -> str:
        with self._lock:
            if self._data["state"] in {"starting", "running", "stopping"}:
                raise RuntimeError("A detection session is already running.")
            self._stop = threading.Event()
            self._reset_data()
            self._source = source
            self._active_traffic_config = dict(self._traffic_config)
            self._active_traffic_config["speed_limit"] = speed_limit
            run_id = uuid.uuid4().hex[:10]
            self._data.update(
                state="starting",
                run_id=run_id,
                source_label=source_label,
                started_at=datetime.now(timezone.utc).isoformat(),
                speed_limit=speed_limit,
                traffic_configuration=dict(self._active_traffic_config),
                detection_region=self.roi_points(),
            )
            self._worker = threading.Thread(
                target=self._process, args=(source, speed_limit), daemon=True, name="vides-detection"
            )
            self._worker.start()
            return run_id

    def stop(self) -> None:
        with self._lock:
            if self._data["state"] in {"starting", "running"}:
                self._data["state"] = "stopping"
                self._stop.set()

    def is_running(self) -> bool:
        with self._lock:
            return self._data["state"] in {"starting", "running", "stopping"}

    def snapshot(self) -> dict:
        with self._lock:
            data = dict(self._data)
            data["events"] = list(self._data["events"])
            data["vehicles_by_class"] = dict(self._data["vehicles_by_class"])
            data["event_counts"] = dict(self._data["event_counts"])
            data["running"] = self._data["state"] in {"starting", "running", "stopping"}
            data["frame_ready"] = self._frame is not None
            data["elapsed_seconds"] = self._elapsed_seconds()
            data["active_events"] = sum(data["event_counts"].values())
            return data

    def _elapsed_seconds(self) -> float:
        started = self._data.get("started_at")
        if not started:
            return 0
        start_time = datetime.fromisoformat(started)
        end_time = datetime.now(timezone.utc) if self.is_running() else datetime.fromisoformat(
            self._data.get("finished_at") or datetime.now(timezone.utc).isoformat()
        )
        return max(0, round((end_time - start_time).total_seconds(), 1))

    def add_event(self, event_type: str, track_ids: list[int], detail: str, severity: str) -> None:
        event = {
            "id": uuid.uuid4().hex[:10],
            "type": event_type,
            "track_ids": track_ids,
            "detail": detail,
            "severity": severity,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            self._data["events"].insert(0, event)
            counts = self._data["event_counts"]
            counts[event_type] = counts.get(event_type, 0) + 1

    def publish(self, frame_jpeg: bytes, *, fps: float, vehicle_count: int,
                vehicles_by_class: dict[str, int], average_speed: float) -> None:
        with self._lock:
            self._frame = frame_jpeg
            self._frame_number += 1
            self._data.update(
                state="running",
                fps=round(fps, 1),
                total_vehicles=vehicle_count,
                vehicles_by_class=dict(vehicles_by_class),
                average_speed=round(average_speed, 1),
            )

    def current_frame(self) -> tuple[bytes | None, int]:
        with self._lock:
            return self._frame, self._frame_number

    def matches_source(self, source: int | str) -> bool:
        with self._lock:
            return type(self._source) is type(source) and self._source == source

    def roi_points(self) -> list[list[float]]:
        with self._lock:
            return [point[:] for point in self._roi_points]

    def traffic_config(self) -> dict:
        with self._lock:
            return dict(self._traffic_config)

    def active_traffic_config(self) -> dict:
        with self._lock:
            return dict(self._active_traffic_config)

    def update_traffic_config(self, config: dict) -> None:
        with self._lock:
            self._traffic_config = dict(config)
            self._active_traffic_config = dict(config)
            if self.is_running():
                self._data["speed_limit"] = config["speed_limit"]
                self._data["traffic_configuration"] = dict(config)

    def update_roi(self, points: list[list[float]]) -> None:
        with self._lock:
            self._roi_points = [point[:] for point in points]
            settings.src_pts = np.asarray(points, dtype=np.float32)
            if self.is_running():
                self._data["detection_region"] = [point[:] for point in points]

    def fail(self, message: str) -> None:
        with self._lock:
            self._data["error"] = message

    def finish(self) -> None:
        with self._lock:
            state = "error" if self._data["error"] else "completed"
            self._data.update(state=state, finished_at=datetime.now(timezone.utc).isoformat())

    def _process(self, source: int | str, speed_limit: float) -> None:
        cap = None
        try:
            import cv2
            import numpy as np
            import torch

            from app.detection.detector import appearance_embeddings, create_tracker, obj_Detection
            from app.detection.roi import apply_bev_transform, get_bev_homography, is_in_polygon_roi
            from app.detection.speed_calc import calculate_speed
            from app.events.accident import detect_accident
            from app.events.heavy import heavy_vehicle_detection
            from app.events.opposite import opposite_vehicle_check
            from app.events.overspeed import check_overspeed
            from app.events.stalling import is_stalled

            cap = cv2.VideoCapture(source)
            if not cap.isOpened():
                raise RuntimeError("VIDES could not open this video source. Check the camera or stream URL.")

            fps = cap.get(cv2.CAP_PROP_FPS)
            fps = fps if fps and np.isfinite(fps) and fps > 0 else 20.0
            model = model_manager.loaded_model()
            tracker, uses_fallback_embeddings = create_tracker()
            device = 0 if torch.cuda.is_available() else "cpu"
            roi_source_points = np.asarray(self.roi_points(), dtype=np.float32)
            homography, _ = get_bev_homography(roi_source_points)
            roi_polygon = roi_source_points.reshape((-1, 1, 2))

            car_coordinates: dict[int, list] = {}
            latest_boxes_coords: dict[int, list] = {}
            stalled_tracks: set[int] = set()
            opposite_tracks: set[int] = set()
            overspeed_tracks: dict[int, float] = {}
            heavy_tracks: set[int] = set()
            counted_tracks: set[int] = set()
            vehicle_count: Counter[str] = Counter()
            reported_accidents: set[tuple[int, int]] = set()
            reported_overspeed: set[int] = set()
            speed_samples: deque[float] = deque(maxlen=100)
            frame_interval = 1.0 / fps
            last_traffic_config = self.active_traffic_config()

            while not self._stop.is_set():
                frame_started = time.monotonic()
                ok, frame = cap.read()
                if not ok:
                    break
                frame = cv2.resize(frame, (settings.dst_width, settings.dst_height))
                latest_roi_points = np.asarray(self.roi_points(), dtype=np.float32)
                if not np.array_equal(latest_roi_points, roi_source_points):
                    roi_source_points = latest_roi_points
                    homography, _ = get_bev_homography(roi_source_points)
                    roi_polygon = roi_source_points.reshape((-1, 1, 2))
                    car_coordinates.clear()
                    stalled_tracks.clear()
                    opposite_tracks.clear()
                    overspeed_tracks.clear()
                    heavy_tracks.clear()
                    reported_overspeed.clear()
                    reported_accidents.clear()
                    speed_samples.clear()
                traffic_config = self.active_traffic_config()
                if traffic_config != last_traffic_config:
                    car_coordinates.clear()
                    stalled_tracks.clear()
                    opposite_tracks.clear()
                    overspeed_tracks.clear()
                    heavy_tracks.clear()
                    reported_overspeed.clear()
                    reported_accidents.clear()
                    speed_samples.clear()
                    last_traffic_config = traffic_config
                speed_limit = traffic_config["speed_limit"]
                meters_per_pixel = traffic_config["meters_per_pixel"]
                expected_movement = traffic_config["expected_movement"]
                result = model(frame, device=device, conf=traffic_config["detection_confidence"], verbose=False)[0]
                detections = []
                obj_Detection(result, detections)
                if uses_fallback_embeddings:
                    tracks = tracker.update_tracks(detections, embeds=appearance_embeddings(frame, detections))
                else:
                    tracks = tracker.update_tracks(detections, frame=frame)
                frame_speeds: list[float] = []
                cv2.polylines(frame, [roi_polygon.astype(np.int32)], True, (62, 166, 107), 1)

                for track in tracks:
                    if not track.is_confirmed():
                        continue
                    track_id = int(track.track_id)
                    x1, y1, x2, y2 = map(int, track.to_ltrb())
                    class_name = str(track.get_det_class())
                    latest_boxes_coords[track_id] = [x1, y1, x2, y2]
                    if track_id not in counted_tracks:
                        counted_tracks.add(track_id)
                        vehicle_count[class_name] += 1

                    if class_name == "truck" and track_id not in heavy_tracks:
                        if heavy_vehicle_detection(x1, y1, x2, y2, homography):
                            heavy_tracks.add(track_id)
                            self.add_event("heavy_vehicle", [track_id], "Heavy vehicle entered the monitored area.", "medium")

                    center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
                    if not is_in_polygon_roi(center_x, center_y, roi_polygon):
                        continue
                    bev_x, bev_y = apply_bev_transform((center_x, center_y), homography)
                    coords = car_coordinates.setdefault(track_id, [])
                    coords.append([bev_x, bev_y])
                    if len(coords) > max(120, int(fps * 6)):
                        del coords[0]

                    if len(coords) >= 5:
                        old_x, old_y = coords[-5]
                        new_x, new_y = coords[-1]
                        if opposite_vehicle_check(old_x, new_x, old_y, new_y, expected_movement, threshold=0.75):
                            if track_id not in opposite_tracks:
                                opposite_tracks.add(track_id)
                                self.add_event("opposite_direction", [track_id], "Vehicle moving against the expected traffic direction.", "high")

                    if is_stalled(car_coordinates, track_id, fps, meters_per_pixel):
                        if track_id not in stalled_tracks:
                            stalled_tracks.add(track_id)
                            self.add_event("stalling", [track_id], "Vehicle has remained stationary in the monitored area.", "high")

                    speed = calculate_speed(coords[-20:], fps, meters_per_pixel)
                    frame_speeds.append(speed)
                    check_overspeed(track_id, speed, speed_limit, overspeed_tracks)
                    if track_id in overspeed_tracks and track_id not in reported_overspeed:
                        reported_overspeed.add(track_id)
                        self.add_event("overspeed", [track_id], f"Vehicle recorded at {speed:.1f} km/h (limit {speed_limit:g} km/h).", "high")

                    is_alert = track_id in stalled_tracks or track_id in opposite_tracks or speed > speed_limit
                    color = (50, 92, 238) if is_alert else (62, 166, 107)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    cv2.putText(frame, f"ID {track_id}  {class_name}  {speed:.1f} km/h", (x1, max(18, y1 - 8)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)

                collisions = detect_accident(list(stalled_tracks), latest_boxes_coords)
                for track_id, others in collisions.items():
                    for other_id in others:
                        pair = tuple(sorted((int(track_id), int(other_id))))
                        if pair not in reported_accidents:
                            reported_accidents.add(pair)
                            self.add_event("accident", list(pair), "Possible collision detected between stopped vehicles.", "critical")

                speed_samples.extend(frame_speeds)
                cv2.putText(frame, f"VIDES  |  LIMIT {speed_limit:g} KM/H", (18, 28), cv2.FONT_HERSHEY_SIMPLEX,
                            0.62, (238, 244, 248), 2, cv2.LINE_AA)
                encoded, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
                if encoded:
                    avg_speed = sum(speed_samples) / len(speed_samples) if speed_samples else 0
                    self.publish(buffer.tobytes(), fps=fps, vehicle_count=len(counted_tracks),
                                 vehicles_by_class=dict(vehicle_count), average_speed=avg_speed)

                remaining = frame_interval - (time.monotonic() - frame_started)
                if remaining > 0:
                    self._stop.wait(remaining)
        except Exception as exc:
            self.fail(str(exc))
        finally:
            if cap is not None:
                cap.release()
            try:
                del model
            except UnboundLocalError:
                pass
            self.finish()


session = DetectionSession()
app = FastAPI(title="VIDES API", version="1.0.0", description="Vehicle detection and traffic event monitoring.")


@app.on_event("startup")
def load_default_model() -> None:
    try:
        model_manager.request_load(Path(settings.model_path))
    except RuntimeError:
        # A repeated startup hook should not interrupt the running API.
        pass


@app.get("/api/health")
def health() -> dict:
    required = ("cv2", "torch", "ultralytics", "deep_sort_realtime")
    dependencies = {name: importlib.util.find_spec(name) is not None for name in required}
    model = model_manager.snapshot()
    return {
        "ok": all(dependencies.values()) and model["model_loaded"],
        "dependencies": dependencies,
        "tracking_mode": "DeepSORT + MobileNet" if importlib.util.find_spec("pkg_resources") else "DeepSORT + HSV fallback",
        **model,
    }


@app.get("/api/config")
def config() -> dict:
    return {
        "default_speed_limit": settings.speed_limit,
        "traffic_configuration": session.traffic_config(),
        "configured_feed": bool(settings.feed_ip_url),
        "models": model_manager.available_models(),
        **model_manager.snapshot(),
        "frame_size": {"width": settings.dst_width, "height": settings.dst_height},
        "roi_points": session.roi_points(),
        "default_roi_points": DEFAULT_ROI_POINTS,
    }


@app.put("/api/config/roi")
def save_roi(request: RoiRequest) -> dict:
    points = validate_roi(request.points)
    ROI_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ROI_CONFIG_PATH.write_text(json.dumps(points, indent=2) + "\n")
    session.update_roi(points)
    return {"roi_points": points, "applied_live": session.is_running()}


@app.put("/api/config/traffic")
def save_traffic_config(request: TrafficConfigRequest) -> dict:
    selected = normalize_traffic_config(request.dict())
    TRAFFIC_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    TRAFFIC_CONFIG_PATH.write_text(json.dumps(selected, indent=2) + "\n")
    applied = apply_traffic_config(selected)
    session.update_traffic_config(applied)
    return {
        "traffic_configuration": applied,
        "applied_live": session.is_running(),
    }


@app.put("/api/config/model", status_code=202)
def select_model(request: ModelSelectionRequest) -> dict:
    with model_manager._lock:
        if session.is_running():
            raise HTTPException(status_code=409, detail="Stop the active detection session before changing models.")
        matching = [name for name in model_manager.available_models() if name == request.model_name]
        if matching:
            model_path = PROJECT_ROOT / "models" / matching[0]
        elif model_manager._path.name == request.model_name:
            model_path = model_manager._path
        else:
            raise HTTPException(status_code=404, detail="Choose a model file from VIDES/models.")
        try:
            return model_manager.request_load(model_path)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/status")
def status() -> dict:
    return session.snapshot()


@app.get("/api/events")
def events() -> dict:
    snapshot = session.snapshot()
    return {"events": snapshot["events"], "event_counts": snapshot["event_counts"]}


@app.get("/api/reports/download")
def download_report(format: Literal["csv", "json"] = "csv") -> Response:
    report = session.snapshot()
    filename_base = f"vides-report-{report['run_id'] or 'session'}"
    if format == "json":
        return Response(
            content=json.dumps(report, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename_base}.json"'},
        )

    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["VIDES session report"])
    writer.writerow(["Run ID", report["run_id"] or "—"])
    writer.writerow(["State", report["state"]])
    writer.writerow(["Source", report["source_label"] or "—"])
    writer.writerow(["Started at", report["started_at"] or "—"])
    writer.writerow(["Finished at", report["finished_at"] or "—"])
    writer.writerow(["Duration (seconds)", report["elapsed_seconds"]])
    writer.writerow(["Speed limit (km/h)", report["speed_limit"]])
    traffic = report.get("traffic_configuration", {})
    writer.writerow(["Expected flow angle (degrees clockwise from up)", traffic.get("flow_angle_deg", "—")])
    writer.writerow(["Calibrated road length (m)", traffic.get("road_length_m", "—")])
    writer.writerow(["Calibration scale (m per px)", traffic.get("meters_per_pixel", "—")])
    writer.writerow(["Detection confidence", traffic.get("detection_confidence", "—")])
    writer.writerow(["Detection zone points (px)", json.dumps(report.get("detection_region", []))])
    writer.writerow(["Average speed (km/h)", report["average_speed"]])
    writer.writerow(["Total vehicles", report["total_vehicles"]])
    writer.writerow(["Vehicles by class", json.dumps(report["vehicles_by_class"], sort_keys=True)])
    writer.writerow(["Event totals", json.dumps(report["event_counts"], sort_keys=True)])
    writer.writerow([])
    writer.writerow(["Event", "Track IDs", "Severity", "Occurred at", "Details"])
    for event in report["events"]:
        writer.writerow([event["type"], ", ".join(map(str, event["track_ids"])), event["severity"],
                         event["occurred_at"], event["detail"]])
    return Response(
        content="\ufeff" + output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename_base}.csv"'},
    )


@app.post("/api/session/upload")
async def upload_video(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "video").suffix.lower()
    if suffix not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Choose an MP4, AVI, MOV, MKV, WebM, or M4V video.")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    upload_id = uuid.uuid4().hex
    path = UPLOAD_DIR / f"{upload_id}{suffix}"
    size = 0
    try:
        with path.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Video upload limit is 500 MB.")
                destination.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="The selected video is empty.")
    except Exception:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    uploads[upload_id] = path
    upload_names[upload_id] = Path(file.filename or "video").name
    metadata = inspect_video(path)
    upload_metadata[upload_id] = metadata
    return {"upload_id": upload_id, "filename": upload_names[upload_id], "size_bytes": size, **metadata}


def inspect_video(path: Path) -> dict:
    """Read basic timing metadata used by the uploaded-video frame selector."""
    try:
        import cv2

        capture = cv2.VideoCapture(str(path))
        try:
            if not capture.isOpened():
                return {"frame_count": 0, "fps": 0, "duration_seconds": 0}
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
            if not math.isfinite(fps) or fps < 0:
                fps = 0
            raw_frame_count = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            frame_count = max(0, int(raw_frame_count)) if math.isfinite(raw_frame_count) else 0
            duration = frame_count / fps if fps > 0 and frame_count > 0 else 0
            return {"frame_count": frame_count, "fps": fps, "duration_seconds": duration}
        finally:
            capture.release()
    except (ImportError, OSError, ValueError):
        return {"frame_count": 0, "fps": 0, "duration_seconds": 0}


@app.post("/api/session/preview")
def preview_source(request: PreviewRequest) -> dict:
    if request.source == "camera":
        source: int | str = request.camera_index
        source_label = f"Local camera {request.camera_index}"
    elif request.source == "rtsp":
        if not request.rtsp_url or not request.rtsp_url.strip():
            raise HTTPException(status_code=422, detail="Enter a network stream URL first.")
        source = request.rtsp_url.strip()
        source_label = "Network video stream"
    elif request.source == "configured":
        if not settings.feed_ip_url:
            raise HTTPException(status_code=422, detail="No feed_ip_url is configured in VIDES/.env.")
        source = settings.feed_ip_url
        source_label = "Configured network feed"
    else:
        path = uploads.get(request.upload_id or "")
        if not path or not path.is_file():
            raise HTTPException(status_code=404, detail="Upload a video file before capturing a preview frame.")
        source = str(path)
        source_label = upload_names.get(request.upload_id or "", "Uploaded video")

    requested_frame = request.frame_index if request.source == "upload" else 0
    metadata = upload_metadata.get(request.upload_id or {}, {}) if request.source == "upload" else {}
    if request.source == "upload" and not metadata:
        metadata = inspect_video(Path(source))

    if session.is_running() and session.matches_source(source) and request.source != "upload":
        current_frame, _ = session.current_frame()
        if current_frame:
            return {"image_base64": base64.b64encode(current_frame).decode("ascii"),
                    "width": settings.dst_width, "height": settings.dst_height,
                    "source_label": source_label, "live_frame": True}

    try:
        import cv2
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="OpenCV is not installed in the VIDES environment.") from exc
    capture = cv2.VideoCapture(source)
    try:
        if not capture.isOpened():
            raise HTTPException(status_code=422, detail="VIDES could not open this source for a preview frame.")
        if requested_frame and capture.get(cv2.CAP_PROP_FRAME_COUNT) > 0:
            requested_frame = min(requested_frame, int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) - 1)
            capture.set(cv2.CAP_PROP_POS_FRAMES, requested_frame)
        ok, frame = capture.read()
        if not ok:
            raise HTTPException(status_code=422, detail="VIDES opened the source but could not read a frame.")
        frame = cv2.resize(frame, (settings.dst_width, settings.dst_height))
        actual_frame = max(0, int(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1) if request.source == "upload" else 0
        encoded, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if not encoded:
            raise HTTPException(status_code=500, detail="VIDES could not encode the preview frame.")
        return {"image_base64": base64.b64encode(buffer.tobytes()).decode("ascii"),
                "width": settings.dst_width, "height": settings.dst_height,
                "source_label": source_label, "live_frame": False,
                "frame_index": actual_frame,
                "time_seconds": actual_frame / metadata["fps"] if metadata.get("fps", 0) > 0 else 0,
                **metadata}
    finally:
        capture.release()


@app.post("/api/session/start")
def start_session(request: StartRequest) -> dict:
    if request.source == "camera":
        source: int | str = request.camera_index
        label = f"Local camera {request.camera_index}"
    elif request.source == "rtsp":
        if not request.rtsp_url or not request.rtsp_url.strip():
            raise HTTPException(status_code=422, detail="Enter a video stream URL first.")
        source = request.rtsp_url.strip()
        label = "Network video stream"
    elif request.source == "configured":
        if not settings.feed_ip_url:
            raise HTTPException(status_code=422, detail="No feed_ip_url is configured in VIDES/.env.")
        source = settings.feed_ip_url
        label = "Configured network feed"
    else:
        path = uploads.get(request.upload_id or "")
        if not path or not path.is_file():
            raise HTTPException(status_code=404, detail="Upload expired. Select the video again.")
        source = str(path)
        label = upload_names.get(request.upload_id or "", "Uploaded video")
    with model_manager._lock:
        if session.is_running():
            raise HTTPException(status_code=409, detail="A detection session is already running.")
        if model_manager._state != "loaded" or model_manager._model is None:
            raise HTTPException(status_code=409, detail="Wait for the selected detection model to finish loading before starting.")
        try:
            run_id = session.start(source, label, request.speed_limit or session.traffic_config()["speed_limit"])
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"run_id": run_id, "state": "starting", "source_label": label}


@app.post("/api/session/stop")
def stop_session() -> dict:
    session.stop()
    return {"state": session.snapshot()["state"]}


@app.post("/api/system/restart", status_code=202)
def restart_application() -> dict:
    if multiprocessing.parent_process() is None:
        raise HTTPException(
            status_code=409,
            detail="In-app restart needs the VIDES reload supervisor. Start it with the README command using --reload.",
        )
    session.stop()

    def request_supervisor_reload() -> None:
        # Touching the app module asks Uvicorn's --reload supervisor to replace
        # this worker. Its in-memory session and events are cleared on startup.
        time.sleep(0.8)
        Path(__file__).touch()

    threading.Thread(target=request_supervisor_reload, daemon=True, name="vides-app-restart").start()
    return {"state": "restarting", "message": "The VIDES service is restarting."}


async def mjpeg_frames():
    last_frame = -1
    while True:
        frame, number = session.current_frame()
        if frame is not None and number != last_frame:
            last_frame = number
            yield b"--frame\r\nContent-Type: image/jpeg\r\nCache-Control: no-cache\r\n\r\n" + frame + b"\r\n"
        elif not session.is_running():
            break
        await asyncio.sleep(0.03)


@app.get("/api/stream")
def video_stream() -> StreamingResponse:
    return StreamingResponse(mjpeg_frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
