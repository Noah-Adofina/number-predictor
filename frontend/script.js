const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const predictButton = document.querySelector("#predict");
const clearButton = document.querySelector("#clear");
const retryButton = document.querySelector("#retry");
const resultPanel = document.querySelector("#result-panel");
const digitDisplay = document.querySelector("#digit");
const statusDisplay = document.querySelector("#status");
const keyboardCursor = document.querySelector("#keyboard-cursor");

const BACKEND_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? "http://localhost:8000"
  : "https://noahs-number-predictor-mnist-nn.onrender.com";
const REQUEST_TIMEOUT_MS = 75000;
const WAKE_NOTICE_MS = 6000;
const BACKGROUND = "#151d30";
const INK = "#ffffff";
const BRUSH_WIDTH = 32;

let hasDrawing = false;
let activePointer = null;
let requestController = null;
let drawingVersion = 0;
let keyboardPosition = { x: 160, y: 160 };
let spaceDown = false;

function setResult(state, digit, message) {
  resultPanel.dataset.state = state;
  digitDisplay.textContent = digit;
  digitDisplay.setAttribute("aria-label", state === "success" ? `Predicted digit ${digit}` : "No prediction yet");
  statusDisplay.textContent = message;
  retryButton.hidden = state !== "error" || !hasDrawing;
}

function resetCanvas() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function updatePredictButton() {
  predictButton.disabled = !hasDrawing || requestController !== null;
  predictButton.textContent = requestController ? "Predicting…" : "Predict digit →";
}

function cancelPending() {
  drawingVersion += 1;
  if (requestController) {
    requestController.abort();
    requestController = null;
  }
  updatePredictButton();
}

function markEdited() {
  cancelPending();
  hasDrawing = true;
  setResult("idle", "—", "Drawing changed. Predict when you're ready.");
  updatePredictButton();
}

function drawDot(x, y) {
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(x, y, BRUSH_WIDTH / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawLine(from, to) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = BRUSH_WIDTH;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
  };
}

canvas.addEventListener("pointerdown", (event) => {
  if (activePointer !== null) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  activePointer = { id: event.pointerId, point: canvasPoint(event) };
  markEdited();
  drawDot(activePointer.point.x, activePointer.point.y);
});

canvas.addEventListener("pointermove", (event) => {
  if (!activePointer || activePointer.id !== event.pointerId) return;
  const next = canvasPoint(event);
  drawLine(activePointer.point, next);
  activePointer.point = next;
});

function endPointer(event) {
  if (activePointer?.id === event.pointerId) activePointer = null;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("lostpointercapture", endPointer);

function moveKeyboardCursor() {
  keyboardCursor.style.left = `${keyboardPosition.x / canvas.width * 100}%`;
  keyboardCursor.style.top = `${keyboardPosition.y / canvas.height * 100}%`;
}
moveKeyboardCursor();

canvas.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 24 : 12;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (event.code === "Space") {
    event.preventDefault();
    if (!spaceDown) {
      spaceDown = true;
      markEdited();
      drawDot(keyboardPosition.x, keyboardPosition.y);
    }
  } else if (moves[event.key]) {
    event.preventDefault();
    const previous = { ...keyboardPosition };
    keyboardPosition.x = Math.max(0, Math.min(canvas.width, keyboardPosition.x + moves[event.key][0]));
    keyboardPosition.y = Math.max(0, Math.min(canvas.height, keyboardPosition.y + moves[event.key][1]));
    moveKeyboardCursor();
    if (spaceDown) drawLine(previous, keyboardPosition);
  }
});
canvas.addEventListener("keyup", (event) => { if (event.code === "Space") spaceDown = false; });
canvas.addEventListener("blur", () => { spaceDown = false; });

clearButton.addEventListener("click", () => {
  cancelPending();
  activePointer = null;
  hasDrawing = false;
  resetCanvas();
  setResult("idle", "—", "Your result will appear here.");
  updatePredictButton();
});

function canvasBlob() {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not prepare the drawing.")), "image/png");
  });
}

async function predict() {
  if (!hasDrawing || requestController) return;
  const controller = new AbortController();
  requestController = controller;
  const version = drawingVersion;
  updatePredictButton();
  setResult("loading", "…", "Sending your drawing to the model…");

  const wakeTimer = setTimeout(() => {
    if (requestController === controller) {
      statusDisplay.textContent = "The free backend may be waking up. This can take a little longer.";
    }
  }, WAKE_NOTICE_MS);
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const blob = await canvasBlob();
    if (version !== drawingVersion) return;
    if (controller.signal.aborted) throw new Error("Request timed out.");
    const formData = new FormData();
    formData.append("file", blob, "digit.png");
    const response = await fetch(`${BACKEND_URL}/predict`, {
      method: "POST", body: formData, signal: controller.signal,
    });
    if (version !== drawingVersion) return;
    if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
    let data;
    try { data = await response.json(); }
    catch { throw new Error("The server returned an unreadable response."); }
    if (!Number.isInteger(data?.prediction) || data.prediction < 0 || data.prediction > 9) {
      throw new Error("The server returned an unexpected prediction.");
    }
    if (version === drawingVersion) setResult("success", String(data.prediction), "The model's best guess for your drawing.");
  } catch (error) {
    if (version !== drawingVersion) return;
    const message = controller.signal.aborted
      ? "The request timed out. The backend may still be waking up. Please try again."
      : error instanceof TypeError
        ? "Could not reach the backend. Check your connection and try again."
        : error.message || "Prediction failed. Please try again.";
    setResult("error", "!", message);
  } finally {
    clearTimeout(wakeTimer);
    clearTimeout(timeout);
    if (requestController === controller) {
      requestController = null;
      updatePredictButton();
    }
  }
}

predictButton.addEventListener("click", predict);
retryButton.addEventListener("click", predict);
resetCanvas();
updatePredictButton();
