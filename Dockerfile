FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-venv ffmpeg fonts-dejavu-core curl ca-certificates && \
    python3 -m venv /opt/whisper-venv && \
    /opt/whisper-venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/whisper-venv/bin/pip install --no-cache-dir faster-whisper && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV PYTHON_BIN=/opt/whisper-venv/bin/python3 \
    WHISPER_MODEL=base

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY server.js video-processor.js transcribe.py ./

EXPOSE ${PORT:-3001}

CMD ["node", "server.js"]
