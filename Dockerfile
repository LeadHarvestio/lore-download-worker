FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv ffmpeg fontconfig fonts-dejavu-core curl ca-certificates && \
    python3 -m venv /opt/whisper-venv && \
    /opt/whisper-venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/whisper-venv/bin/pip install --no-cache-dir faster-whisper && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV PYTHON_BIN=/opt/whisper-venv/bin/python3 \
    WHISPER_MODEL=base

# Face analysis stays feature-gated until deployment benchmarking passes.
RUN /opt/whisper-venv/bin/pip install --no-cache-dir opencv-python-headless==4.11.0.86
ENV FACE_MODEL_PATH=/app/render/yunet.onnx

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY server.js video-processor.js transcribe.py ./
COPY render ./render
RUN curl --fail --location --retry 2 \
    https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx \
    -o /app/render/yunet.onnx && \
    echo "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  /app/render/yunet.onnx" | sha256sum -c - && \
    /opt/whisper-venv/bin/python3 /app/render/analyze-faces.py --check
COPY fonts ./fonts
COPY download ./download

# Refresh after source changes: the earlier "latest" installation layer can be cached.
RUN case "$(uname -m)" in \
      x86_64) YT_DLP_ASSET=yt-dlp_linux ;; \
      aarch64|arm64) YT_DLP_ASSET=yt-dlp_linux_aarch64 ;; \
      *) echo "Unsupported worker architecture"; exit 1 ;; \
    esac && \
    curl --fail --location --retry 2 "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT_DLP_ASSET" -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && yt-dlp --version && yt-dlp --list-impersonate-targets

# make the bundled headline/caption fonts visible to fontconfig too
RUN mkdir -p /usr/local/share/fonts/clip && cp fonts/*.ttf /usr/local/share/fonts/clip/ && fc-cache -f

EXPOSE ${PORT:-3001}

CMD ["node", "server.js"]
