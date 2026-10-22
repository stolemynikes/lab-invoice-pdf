# The invoice app as a container, for Synology Container Manager (or any other Docker host).
# Built and started by docker-compose.yml. See docs/synology-nl.md.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production
# Less RAM on the NAS: Node cleans up sooner instead of growing (192 MB is plenty for making PDFs and talking to Exact)
ENV NODE_OPTIONS="--max-old-space-size=192 --max-semi-space-size=2"

# Install the packages first, so a rebuild after a code change is fast
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Never run as root (docker-compose.yml sets the DSM user that owns the invoice folder)
USER node

EXPOSE 8080

# Container Manager shows the app as "unhealthy" when it stops answering.
# Plain bash instead of a second Node process: asking "are you there?" every minute then costs almost no RAM.
HEALTHCHECK --interval=1m --timeout=10s --start-period=30s \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/${PORT:-8080} && printf "GET / HTTP/1.0\r\n\r\n" >&3 && head -n 1 <&3 | grep -q " 200 "'

CMD ["node", "index.js"]
