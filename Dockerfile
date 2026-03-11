FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 ffmpeg curl && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY server.js ./

EXPOSE ${PORT:-3001}

CMD ["node", "server.js"]
```

4. Click **"Commit changes"** → **"Commit changes"**

**Step 3: Verify your repo**

Your repo page should now show exactly 4 files:
```
Dockerfile
README.md
package.json
server.js
