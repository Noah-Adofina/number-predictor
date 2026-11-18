import io
import sys
import unittest
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from server import app  # noqa: E402


class PredictionApiTest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True})

    def test_missing_and_invalid_uploads(self):
        self.assertEqual(self.client.post("/predict").status_code, 400)
        response = self.client.post(
            "/predict", data={"file": (io.BytesIO(b"not an image"), "digit.png")}
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json, {"error": "invalid image"})

    def test_png_upload_returns_digit(self):
        buffer = io.BytesIO()
        Image.new("RGB", (320, 320), "#151d30").save(buffer, format="PNG")
        buffer.seek(0)
        response = self.client.post(
            "/predict", data={"file": (buffer, "digit.png")}
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json["prediction"], int)
        self.assertIn(response.json["prediction"], range(10))


if __name__ == "__main__":
    unittest.main()
