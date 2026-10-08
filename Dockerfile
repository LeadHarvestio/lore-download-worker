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

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY server.js video-processor.js transcribe.py ./
COPY render ./render
COPY fonts ./fonts
COPY download ./download

# Refresh after source changes: the earlier "latest" installation layer can be cached.
RUN curl --fail --location --retry 2 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && yt-dlp --version

# make the bundled headline/caption fonts visible to fontconfig too
RUN mkdir -p /usr/local/share/fonts/clip && cp fonts/*.ttf /usr/local/share/fonts/clip/ && fc-cache -f

EXPOSE ${PORT:-3001}

CMD ["node", "server.js"]
